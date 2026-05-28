package ca.uwaterloo.watform.sessionserver;

import ca.uwaterloo.watform.alloyast.paragraph.command.AlloyCmdPara;
import ca.uwaterloo.watform.alloyinterface.AlloyInterface;
import ca.uwaterloo.watform.alloymodel.AlloyModel;
import ca.uwaterloo.watform.dashmodel.DashModel;
import ca.uwaterloo.watform.dashtoalloy.BaseD2A;
import ca.uwaterloo.watform.dashtoalloy.DashToAlloy;
import ca.uwaterloo.watform.parser.Parser;
import ca.uwaterloo.watform.utils.Reporter;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import edu.mit.csail.sdg.alloy4.A4Reporter;
import edu.mit.csail.sdg.ast.Command;
import edu.mit.csail.sdg.ast.Sig;
import edu.mit.csail.sdg.parser.CompModule;
import edu.mit.csail.sdg.translator.A4Options;
import edu.mit.csail.sdg.translator.A4Solution;
import edu.mit.csail.sdg.translator.A4Tuple;
import edu.mit.csail.sdg.translator.TranslateAlloyToKodkod;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * CommandRouter handles all simulation commands using the ALDB approach: flat field maps for state
 * representation, concrete sig injection for named atoms, and uniform init predicate rebuilding.
 *
 * <p>The simulation flow is: 1. load — parse .dsh file to DashModel 2. translate — DashToAlloy
 * produces Alloy code 3. init — inject concrete sigs, extract __initial pred, run solver 4. step —
 * rebuild __initial from flat state map, run solver 5. next — ask solver for alternate solution
 */
public class CommandRouter {

    // Model state
    private DashModel currentModel;
    private AlloyModel currentAlloyModel;

    // ALDB-style simulation state
    private String storedModelString; // Alloy code WITHOUT __initial pred, WITH concrete sigs
    private String storedInitString; // Original __initial predicate (for re-init)
    private Map<String, Integer> currentSigScopes; // e.g., {PID: 2, Floor: 3}
    private Map<String, Integer> fieldArities; // field name → value arity (excl. snapshot)
    private A4Solution currentA4Solution;
    private CompModule currentCompiled;

    // ──────────────────────────────────────────────────────────────
    // Dispatch
    // ──────────────────────────────────────────────────────────────

    public JsonObject dispatch(String command, JsonObject params) {
        try {
            return switch (command) {
                case "ping" -> okResponse(new JsonObject());
                case "load" -> handleLoad(params);
                case "translate" -> handleTranslate(params);
                case "init" -> handleInit(params);
                case "step" -> handleStep(params);
                case "next" -> handleNext();
                default -> errorResponse("Unknown command: " + command);
            };
        } catch (Reporter.AbortSignal e) {
            StringBuilder msg = new StringBuilder("Model errors:");
            for (var err : Reporter.INSTANCE.getErrors()) {
                msg.append("\n  ").append(err.getMessage());
            }
            return errorResponse(msg.toString());
        } catch (Exception e) {
            return errorResponse(e.getClass().getSimpleName() + ": " + e.getMessage());
        }
    }

    // ──────────────────────────────────────────────────────────────
    // Load & Translate (unchanged)
    // ──────────────────────────────────────────────────────────────

    private JsonObject handleLoad(JsonObject params) {
        if (params == null || !params.has("filePath")) {
            return errorResponse("Missing filePath parameter");
        }
        String filePath = params.get("filePath").getAsString();
        Path path = Paths.get(filePath).toAbsolutePath();

        Reporter.INSTANCE.reset();
        Reporter.INSTANCE.pushPath(path);

        AlloyModel model = Parser.parseToModel(path);
        if (model == null) {
            return errorResponse("Failed to parse file: " + filePath);
        }
        if (!(model instanceof DashModel)) {
            return errorResponse("File is not a Dash model: " + filePath);
        }

        currentModel = (DashModel) model;
        currentAlloyModel = null;
        clearSimulationState();

        Reporter.INSTANCE.popPath();

        JsonObject data = DashModelSerializer.serialize(currentModel);
        return okResponse(data);
    }

    private JsonObject handleTranslate(JsonObject params) {
        if (currentModel == null) {
            return errorResponse("No model loaded. Call load first.");
        }

        BaseD2A.Options opt = BaseD2A.Options.traces;
        if (params != null && params.has("option")) {
            String optStr = params.get("option").getAsString();
            try {
                opt = BaseD2A.Options.valueOf(optStr);
            } catch (IllegalArgumentException e) {
                return errorResponse("Invalid option: " + optStr);
            }
        }

        currentAlloyModel = new DashToAlloy(currentModel, opt).translate();
        clearSimulationState();

        int cmdCount = currentAlloyModel.getParas(AlloyCmdPara.class).size();
        JsonObject data = new JsonObject();
        data.addProperty("commandCount", cmdCount);
        data.addProperty("alloyCode", currentAlloyModel.toString());

        JsonArray scopeSigs = detectScopeSigs(currentAlloyModel.toString());
        data.add("scopeSigs", scopeSigs);

        return okResponse(data);
    }

    // ──────────────────────────────────────────────────────────────
    // Init — ALDB approach
    // ──────────────────────────────────────────────────────────────

    /**
     * Initialize simulation: inject concrete sigs, extract and store the __initial predicate,
     * compile with exactly 1 __Snapshot, and return the initial state as a flat field map.
     *
     * <p>Params: {sigScopes: {PID: 2, Floor: 3}}
     */
    private JsonObject handleInit(JsonObject params) {
        if (currentAlloyModel == null) {
            return errorResponse("No translated model. Call translate first.");
        }

        currentSigScopes = extractSigScopes(params);

        // 1. Get Alloy code, inject missing parent sigs (e.g., sig PID {})
        String alloyCode = injectMissingParamSigs(currentAlloyModel.toString());

        // 2. Inject concrete subsigs (e.g., one sig PID_0, PID_1 extends PID {})
        String concreteSigs = getConcreteSigsDefinition(currentSigScopes);

        // 3. Extract the __initial predicate (ALDB-style brace counting)
        String[] split = extractInitPredicate(alloyCode);
        if (split == null) {
            return errorResponse("Could not find pred __initial in translated code");
        }

        // 4. Store the split: model without init + concrete sigs, and the init pred
        storedModelString = split[0] + concreteSigs;
        storedInitString = split[1];

        // 5. Compile and run with exactly 1 __Snapshot
        String runCmd = buildRunCommand(1);
        String fullCode = storedModelString + storedInitString + "\n" + runCmd + "\n";

        try {
            return compileAndRun(fullCode);
        } catch (Exception e) {
            return errorResponse("Init error: " + e.getMessage());
        }
    }

    // ──────────────────────────────────────────────────────────────
    // Step — ALDB approach
    // ──────────────────────────────────────────────────────────────

    /**
     * Step from a given state: rebuild the __initial predicate from the flat field map, then
     * compile and run with exactly 2 __Snapshots (current + next). Non-iterative — a single solver
     * call.
     *
     * <p>Params: {state: {field: [values]}, sigScopes: {PID: 2, Floor: 3}}
     */
    private JsonObject handleStep(JsonObject params) {
        if (storedModelString == null) {
            return errorResponse("No initialized model. Call init first.");
        }
        if (params == null || !params.has("state")) {
            return errorResponse("Missing state parameter");
        }

        JsonObject state = params.getAsJsonObject("state");

        // Update sig scopes if provided (may differ from init)
        if (params.has("sigScopes")) {
            currentSigScopes = extractSigScopes(params);
        }

        // Build new __initial predicate from the flat state map (ALDB-style)
        String newInit = buildInitFromFlatState(state);

        // Single fixed scope: exactly 2 __Snapshots (current + next).
        // No iteration — the step scope is fixed by the ALDB protocol.
        // No-stutter constraint forces a real transition between the two snapshots,
        // so the user sees actual progress rather than a self-loop the solver picked
        // because stutter is part of small_step's disjunction in traces mode.
        String runCmd = buildRunCommand(2, buildNoStutterConstraint());
        String fullCode = storedModelString + newInit + "\n" + runCmd + "\n";

        try {
            return compileAndRun(fullCode);
        } catch (Exception e) {
            return errorResponse(
                    "Step error: " + e.getClass().getSimpleName() + ": " + e.getMessage());
        }
    }

    // ──────────────────────────────────────────────────────────────
    // Next — alternate solution
    // ──────────────────────────────────────────────────────────────

    private JsonObject handleNext() {
        if (currentA4Solution == null) {
            return errorResponse("No current solution. Call init or step first.");
        }
        if (!currentA4Solution.satisfiable()) {
            JsonObject data = new JsonObject();
            data.addProperty("satisfiable", false);
            return okResponse(data);
        }

        currentA4Solution = currentA4Solution.next();
        return serializeSnapshots();
    }

    // ──────────────────────────────────────────────────────────────
    // ALDB-style helpers
    // ──────────────────────────────────────────────────────────────

    /**
     * Compile Alloy code and run the last command. Stores the solution and returns serialized
     * snapshots.
     */
    private JsonObject compileAndRun(String fullCode) {
        System.setProperty("org.slf4j.simpleLogger.log.kodkod.engine.config", "warn");
        currentCompiled = AlloyInterface.parse(fullCode);
        List<Command> cmds = currentCompiled.getAllCommands();
        if (cmds.isEmpty()) {
            throw new RuntimeException("No commands generated");
        }
        Command cmd = cmds.get(cmds.size() - 1);
        currentA4Solution =
                TranslateAlloyToKodkod.execute_command(
                        new A4Reporter(),
                        currentCompiled.getAllReachableSigs(),
                        cmd,
                        new A4Options());

        return serializeSnapshots();
    }

    /**
     * Extract the __initial predicate from Alloy code using brace counting (same approach as ALDB's
     * initializeWithModel).
     *
     * @return String[2] = {codeWithoutInit, initPredicate}, or null if not found
     */
    private String[] extractInitPredicate(String alloyCode) {
        int initStart = alloyCode.indexOf("pred __initial");
        if (initStart == -1) {
            return null;
        }

        // Count braces to find the end of the predicate
        int braces = 0;
        int initEnd = -1;
        for (int i = initStart; i < alloyCode.length(); i++) {
            char c = alloyCode.charAt(i);
            if (c == '{') {
                braces++;
            } else if (c == '}') {
                braces--;
                if (braces == 0) {
                    initEnd = i + 1; // include the closing brace
                    break;
                }
            }
        }

        if (initEnd == -1) {
            return null;
        }

        String initPred = alloyCode.substring(initStart, initEnd);
        String codeWithoutInit = alloyCode.substring(0, initStart) + alloyCode.substring(initEnd);

        return new String[] {codeWithoutInit, initPred};
    }

    /**
     * Build an __initial predicate from a flat field map (ALDB-style). Each field maps to an array
     * of value strings (with -> delimiters).
     *
     * <p>For non-empty fields: s.fieldName = val1 + val2 + ...
     *
     * <p>For empty fields: s.fieldName = none (or none->none for higher arity)
     *
     * <p>This is equivalent to ALDB's StateNode.getAlloyInitString().
     */
    private String buildInitFromFlatState(JsonObject state) {
        StringBuilder sb = new StringBuilder();
        sb.append("pred __initial[s: one __Snapshot] {\n");

        for (Map.Entry<String, JsonElement> entry : state.entrySet()) {
            String fieldName = entry.getKey();
            JsonArray values = entry.getValue().getAsJsonArray();

            if (values.size() == 0) {
                // Empty field — use none (or none->none based on arity)
                int arity =
                        (fieldArities != null && fieldArities.containsKey(fieldName))
                                ? fieldArities.get(fieldName)
                                : 1;
                sb.append("\ts.").append(fieldName).append(" = ");
                sb.append(getEmptyRelation(arity));
                sb.append("\n");
            } else {
                // Non-empty: join values with +
                sb.append("\ts.").append(fieldName).append(" = ");
                for (int i = 0; i < values.size(); i++) {
                    if (i > 0) sb.append(" + ");
                    sb.append(values.get(i).getAsString());
                }
                sb.append("\n");
            }
        }

        sb.append("}\n");
        return sb.toString();
    }

    /**
     * Serialize the current A4Solution into ordered snapshots with flat field maps. This is the
     * ALDB approach: iterate __Snapshot sig fields, group by snapshot index, strip $0 suffix from
     * atom names.
     *
     * <p>Returns: {satisfiable: true/false, snapshots: [{field: [values]}, ...]}
     */
    private JsonObject serializeSnapshots() {
        JsonObject data = new JsonObject();
        data.addProperty("satisfiable", currentA4Solution.satisfiable());

        if (!currentA4Solution.satisfiable()) {
            return okResponse(data);
        }

        // Find the __Snapshot sig
        Sig snapshotSig = null;
        for (Sig s : currentA4Solution.getAllReachableSigs()) {
            if (s.label.equals("this/__Snapshot")) {
                snapshotSig = s;
                break;
            }
        }
        if (snapshotSig == null) {
            data.addProperty("satisfiable", false);
            return okResponse(data);
        }

        // Count snapshot atoms and create empty field maps
        int numSnapshots = 0;
        for (A4Tuple t : currentA4Solution.eval(snapshotSig)) {
            numSnapshots++;
        }

        // Initialize per-snapshot field maps (ordered by atom index)
        List<Map<String, List<String>>> snapshots = new ArrayList<>();
        for (int i = 0; i < numSnapshots; i++) {
            snapshots.add(new TreeMap<>());
        }

        // Compute and store field arities, then populate field maps
        fieldArities = new LinkedHashMap<>();
        List<String> fieldNames = new ArrayList<>();

        for (Sig.Field field : snapshotSig.getFields()) {
            String fieldName = field.label;
            int valueArity = field.type().arity() - 1; // subtract owning sig
            fieldArities.put(fieldName, valueArity);
            fieldNames.add(fieldName);

            // Initialize empty lists for all snapshots
            for (Map<String, List<String>> snap : snapshots) {
                snap.put(fieldName, new ArrayList<>());
            }

            // Populate from solution tuples
            for (A4Tuple tuple : currentA4Solution.eval(field)) {
                // First atom is the snapshot: e.g., "__Snapshot$0"
                String snapshotAtom = tuple.atom(0);
                int snapIdx = parseAtomIndex(snapshotAtom);
                if (snapIdx < 0 || snapIdx >= numSnapshots) continue;

                // Remaining atoms are the value, joined with ->
                // Strip $0 suffix from each atom (ALDB approach)
                StringBuilder valSb = new StringBuilder();
                for (int i = 1; i < tuple.arity(); i++) {
                    if (i > 1) valSb.append("->");
                    valSb.append(tuple.atom(i).replace("$0", ""));
                }

                snapshots.get(snapIdx).get(fieldName).add(valSb.toString());
            }

            // Sort values within each snapshot for deterministic output
            for (Map<String, List<String>> snap : snapshots) {
                Collections.sort(snap.get(fieldName));
            }
        }

        // Convert to JSON
        JsonArray snapshotsArr = new JsonArray();
        for (Map<String, List<String>> snap : snapshots) {
            JsonObject snapObj = new JsonObject();
            for (Map.Entry<String, List<String>> entry : snap.entrySet()) {
                JsonArray valArr = new JsonArray();
                for (String val : entry.getValue()) {
                    valArr.add(val);
                }
                snapObj.add(entry.getKey(), valArr);
            }
            snapshotsArr.add(snapObj);
        }

        data.add("snapshots", snapshotsArr);
        return okResponse(data);
    }

    /** Build a "run {} for exactly N __Snapshot, exactly K1 Sig1, ..." command. */
    private String buildRunCommand(int snapshotScope) {
        return buildRunCommand(snapshotScope, "");
    }

    /**
     * Build a "run {<constraintBody>} for exactly N __Snapshot, ..." command. Pass an empty string
     * for no extra constraint (equivalent to "run {}").
     */
    private String buildRunCommand(int snapshotScope, String constraintBody) {
        StringBuilder sb = new StringBuilder();
        sb.append("run { ").append(constraintBody == null ? "" : constraintBody).append(" }");
        sb.append(" for exactly ").append(snapshotScope).append(" __Snapshot");
        if (currentSigScopes != null) {
            for (Map.Entry<String, Integer> entry : currentSigScopes.entrySet()) {
                String sigName = entry.getKey();
                int count = entry.getValue();
                if ("Int".equals(sigName) || "seq".equals(sigName)) {
                    sb.append(", ").append(count).append(" ").append(sigName);
                } else {
                    sb.append(", exactly ").append(count).append(" ").append(sigName);
                }
            }
        }
        return sb.toString();
    }

    /**
     * Build the no-stutter constraint that forbids the solver from satisfying small_step by picking
     * the stutter branch. Forces every step in the trace to fire a real transition.
     *
     * <p>Note: __strong_no_stutter is only generated for TCMC mode, not traces — so we have to
     * reference __stutter directly. The constraint says: for every consecutive snapshot pair in the
     * trace, the stutter predicate must not hold.
     */
    private String buildNoStutterConstraint() {
        return "all s: __Snapshot - __Snapshot/last | not __stutter[s, s.(__Snapshot/next)]";
    }

    /**
     * Generate a "none" expression of the given arity. Arity 1: "none", Arity 2: "none->none", etc.
     */
    private String getEmptyRelation(int arity) {
        StringBuilder sb = new StringBuilder("none");
        for (int i = 1; i < arity; i++) {
            sb.append("->none");
        }
        return sb.toString();
    }

    /**
     * Parse the integer index from an Alloy atom name. "__Snapshot$0" → 0, "PID_1$0" → 0 (index
     * from $N suffix)
     */
    private int parseAtomIndex(String atom) {
        int dollarIdx = atom.lastIndexOf('$');
        if (dollarIdx < 0) return -1;
        try {
            return Integer.parseInt(atom.substring(dollarIdx + 1));
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    private void clearSimulationState() {
        storedModelString = null;
        storedInitString = null;
        currentSigScopes = null;
        fieldArities = null;
        currentA4Solution = null;
        currentCompiled = null;
    }

    // ──────────────────────────────────────────────────────────────
    // Utility methods (kept from original)
    // ──────────────────────────────────────────────────────────────

    /**
     * Generate concrete subsig declarations for scoped sigs (ALDB approach). For each scoped sig
     * with N atoms, generates named subsigs: one sig Floor_0, Floor_1, Floor_2 extends Floor {}
     */
    private String getConcreteSigsDefinition(Map<String, Integer> sigScopes) {
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, Integer> entry : sigScopes.entrySet()) {
            String sigName = entry.getKey();
            int count = entry.getValue();
            if (count <= 0) continue;
            if ("Int".equals(sigName) || "seq".equals(sigName)) continue;

            StringBuilder names = new StringBuilder();
            for (int i = 0; i < count; i++) {
                if (i > 0) names.append(", ");
                names.append(sigName).append("_").append(i);
            }
            sb.append("one sig ").append(names).append(" extends ").append(sigName).append(" {}\n");
        }
        return sb.toString();
    }

    /** Extract sig scopes from params as a Java Map. */
    private Map<String, Integer> extractSigScopes(JsonObject params) {
        Map<String, Integer> result = new LinkedHashMap<>();
        if (params != null && params.has("sigScopes")) {
            JsonObject scopes = params.getAsJsonObject("sigScopes");
            for (Map.Entry<String, JsonElement> entry : scopes.entrySet()) {
                result.put(entry.getKey(), entry.getValue().getAsInt());
            }
        }
        return result;
    }

    /** Detect sigs that need user-specified scopes for simulation. */
    private JsonArray detectScopeSigs(String alloyCode) {
        Set<String> declared = new java.util.LinkedHashSet<>();
        Set<String> needScope = new java.util.LinkedHashSet<>();

        Pattern sigPat =
                Pattern.compile(
                        "(?:(abstract|one|lone)\\s+)?sig\\s+(\\w+)(?:\\s+(?:extends|in)\\s+(\\w+))?");
        Matcher m = sigPat.matcher(alloyCode);
        while (m.find()) {
            String modifier = m.group(1);
            String sigName = m.group(2);
            String parentOrIn = m.group(3);
            declared.add(sigName);
            if (modifier == null && parentOrIn == null && !sigName.startsWith("__")) {
                needScope.add(sigName);
            }
        }

        Pattern inPat = Pattern.compile("sig\\s+\\w+\\s+in\\s+(\\w+)");
        Matcher inM = inPat.matcher(alloyCode);
        while (inM.find()) {
            String parent = inM.group(1);
            if (!declared.contains(parent) && !parent.startsWith("__")) {
                needScope.add(parent);
            }
        }

        JsonArray result = new JsonArray();
        for (String sig : needScope) {
            result.add(sig);
        }
        return result;
    }

    /** Inject missing parameter sig declarations into the Alloy code. */
    private String injectMissingParamSigs(String alloyCode) {
        Set<String> declaredSigs = new java.util.HashSet<>();
        Pattern sigDecl =
                Pattern.compile("(?:abstract\\s+)?(?:one\\s+)?(?:lone\\s+)?sig\\s+(\\w+)");
        Matcher declMatcher = sigDecl.matcher(alloyCode);
        while (declMatcher.find()) {
            declaredSigs.add(declMatcher.group(1));
        }

        Set<String> missing = new java.util.LinkedHashSet<>();
        Pattern subsetDecl = Pattern.compile("sig\\s+\\w+\\s+in\\s+(\\w+)");
        Matcher subsetMatcher = subsetDecl.matcher(alloyCode);
        while (subsetMatcher.find()) {
            String parent = subsetMatcher.group(1);
            if (!declaredSigs.contains(parent)) {
                missing.add(parent);
            }
        }

        if (missing.isEmpty()) {
            return alloyCode;
        }

        StringBuilder sigDecls = new StringBuilder();
        for (String sig : missing) {
            sigDecls.append("sig ").append(sig).append(" {}\n");
        }

        Pattern openPattern = Pattern.compile("^open\\s+.+$", Pattern.MULTILINE);
        Matcher openMatcher = openPattern.matcher(alloyCode);
        int insertPos = 0;
        while (openMatcher.find()) {
            insertPos = openMatcher.end();
        }
        while (insertPos < alloyCode.length() && alloyCode.charAt(insertPos) == '\n') {
            insertPos++;
        }

        return alloyCode.substring(0, insertPos)
                + "\n"
                + sigDecls
                + "\n"
                + alloyCode.substring(insertPos);
    }

    // ──────────────────────────────────────────────────────────────
    // JSON helpers
    // ──────────────────────────────────────────────────────────────

    private JsonObject okResponse(JsonObject data) {
        JsonObject resp = new JsonObject();
        resp.addProperty("status", "ok");
        resp.add("data", data);
        return resp;
    }

    private JsonObject errorResponse(String message) {
        JsonObject resp = new JsonObject();
        resp.addProperty("status", "error");
        resp.addProperty("error", message);
        return resp;
    }
}
