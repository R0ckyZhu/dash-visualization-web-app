package ca.uwaterloo.watform.sessionserver;

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
    private A4Solution initA4Solution; // kept separate so Alt Init always enumerates from init
    private CompModule currentCompiled;
    // ALDB uses the model's ORIGINAL __initial on the very first step (stateGraph.size() <= 1)
    // and only rebuilds from the concrete snapshot on later steps. We mirror that: false right
    // after init / alt-init, set true once a step has been taken.
    private boolean steppedSinceInit = false;

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
                case "next-init" -> handleNextInit();
                case "tables" -> handleTables();
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

        // The upstream DashToAlloy translator (WatForm/dashplus@f796d71) no longer
        // synthesises implicit parameter sigs from `conc state X [PARAM]`. Legacy
        // models that omit `sig PARAM {}` crash at AMFieldTable arity computation.
        // Read the source, inject any missing param sigs, and hand the patched
        // text to the parser via a temp file in the same directory (so any
        // relative `open util/...` imports still resolve identically).
        Path effectivePath = path;
        Path tempPath = null;
        try {
            String source = java.nio.file.Files.readString(path);
            String patched = injectMissingDashParamSigs(source);
            if (!patched.equals(source)) {
                // Keep the .dsh extension (the parser rejects unknown extensions).
                String orig = path.getFileName().toString();
                String base = orig.endsWith(".dsh") ? orig.substring(0, orig.length() - 4) : orig;
                tempPath = path.resolveSibling("." + base + ".autosig.dsh");
                java.nio.file.Files.writeString(tempPath, patched);
                effectivePath = tempPath;
            }
        } catch (java.io.IOException e) {
            return errorResponse("Could not read source file: " + e.getMessage());
        }

        Reporter.INSTANCE.reset();
        Reporter.INSTANCE.pushPath(path); // report errors against the user-facing path

        try {
            AlloyModel model = Parser.parseToModel(effectivePath);
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
        } finally {
            if (tempPath != null) {
                try {
                    java.nio.file.Files.deleteIfExists(tempPath);
                } catch (java.io.IOException ignored) {
                    // best-effort cleanup
                }
            }
        }
    }

    /**
     * Dump the loaded DashModel's internal tables (states, transitions, vars, events, buffers) by
     * walking the public accessors on each *DM class. Returns one pre-formatted string per table so
     * the client can print them verbatim. Parameterised entries surface their {@code
     * List<DashParam>} as a "params" column.
     */
    private JsonObject handleTables() {
        if (currentModel == null) {
            return errorResponse("No model loaded. Call load first.");
        }
        DashModel dm = currentModel;

        JsonObject data = new JsonObject();
        data.addProperty("states", dumpStatesTable(dm));
        data.addProperty("transitions", dumpTransitionsTable(dm));
        data.addProperty("vars", dumpVarsTable(dm));
        data.addProperty("events", dumpEventsTable(dm));
        data.addProperty("buffers", dumpBuffersTable(dm));
        return okResponse(data);
    }

    private String paramsCol(java.util.List<ca.uwaterloo.watform.dashmodel.DashParam> params) {
        if (params == null || params.isEmpty()) return "";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < params.size(); i++) {
            if (i > 0) sb.append(",");
            sb.append(params.get(i).paramSig);
        }
        return sb.toString();
    }

    private String dumpStatesTable(DashModel dm) {
        java.util.List<String> names = new java.util.ArrayList<>(dm.allStateNames());
        java.util.Collections.sort(names);
        java.util.List<String[]> rows = new java.util.ArrayList<>();
        for (String fqn : names) {
            String kind = dm.isLeaf(fqn) ? "BASIC" : dm.stateKind(fqn).name();
            String parent = dm.parent(fqn) == null ? "-" : dm.parent(fqn);
            String def = dm.isDefault(fqn) ? "yes" : "";
            String children = String.join(",", dm.immChildren(fqn));
            if (children.isEmpty()) children = "-";
            String params = paramsCol(dm.stateParams(fqn));
            if (params.isEmpty()) params = "-";
            rows.add(new String[] {fqn, kind, parent, def, params, children});
        }
        return renderTable(
                new String[] {"id", "kind", "parent", "default", "params", "children"}, rows);
    }

    private String dumpTransitionsTable(DashModel dm) {
        java.util.List<String> names = new java.util.ArrayList<>(dm.allTransNames());
        java.util.Collections.sort(names);
        java.util.List<String[]> rows = new java.util.ArrayList<>();
        for (String fqn : names) {
            String params = paramsCol(dm.transParams(fqn));
            if (params.isEmpty()) params = "-";
            String from = dm.fromR(fqn) == null ? "-" : dm.fromR(fqn).name;
            String to = dm.gotoR(fqn) == null ? "-" : dm.gotoR(fqn).name;
            String on = dm.onR(fqn) == null ? "-" : dm.onR(fqn).name;
            String send = dm.sendR(fqn) == null ? "-" : dm.sendR(fqn).name;
            String whenS = dm.whenR(fqn) == null ? "-" : squish(dm.whenR(fqn).toString(), 60);
            String doS = dm.doR(fqn) == null ? "-" : squish(dm.doR(fqn).toString(), 60);
            rows.add(new String[] {fqn, params, from, to, on, whenS, doS, send});
        }
        return renderTable(
                new String[] {"id", "params", "from", "to", "on", "when", "do", "send"}, rows);
    }

    private String dumpVarsTable(DashModel dm) {
        java.util.List<String> names = new java.util.ArrayList<>(dm.allVarNames());
        java.util.Collections.sort(names);
        java.util.List<String[]> rows = new java.util.ArrayList<>();
        for (String fqn : names) {
            String params = paramsCol(dm.varParams(fqn));
            if (params.isEmpty()) params = "-";
            String kind = dm.varKind(fqn) == null ? "-" : dm.varKind(fqn).name();
            String mul = dm.mul(fqn) == null ? "-" : dm.mul(fqn).label;
            String typ = dm.varTyp(fqn) == null ? "-" : squish(dm.varTyp(fqn).toString(), 40);
            rows.add(new String[] {fqn, params, kind, mul, typ});
        }
        return renderTable(new String[] {"id", "params", "kind", "mul", "type"}, rows);
    }

    private String dumpEventsTable(DashModel dm) {
        java.util.List<String> names = new java.util.ArrayList<>(dm.allEventNames());
        java.util.Collections.sort(names);
        if (names.isEmpty()) return "(no events)";
        java.util.List<String[]> rows = new java.util.ArrayList<>();
        for (String fqn : names) {
            String params = paramsCol(dm.eventParams(fqn));
            if (params.isEmpty()) params = "-";
            String kind = dm.eventKind(fqn) == null ? "-" : dm.eventKind(fqn).name();
            rows.add(new String[] {fqn, params, kind});
        }
        return renderTable(new String[] {"id", "params", "kind"}, rows);
    }

    private String dumpBuffersTable(DashModel dm) {
        java.util.List<String> names = new java.util.ArrayList<>(dm.allBufferNames());
        java.util.Collections.sort(names);
        if (names.isEmpty()) return "(no buffers)";
        java.util.List<String[]> rows = new java.util.ArrayList<>();
        for (String fqn : names) {
            String params = paramsCol(dm.bufferParams(fqn));
            if (params.isEmpty()) params = "-";
            String kind = dm.bufferKind(fqn) == null ? "-" : dm.bufferKind(fqn).name();
            String elem = dm.bufferElement(fqn) == null ? "-" : dm.bufferElement(fqn);
            rows.add(new String[] {fqn, params, kind, elem});
        }
        return renderTable(new String[] {"id", "params", "kind", "element"}, rows);
    }

    private String squish(String s, int max) {
        if (s == null) return "-";
        String collapsed = s.replaceAll("\\s+", " ").trim();
        if (collapsed.length() <= max) return collapsed;
        return collapsed.substring(0, max - 1) + "…";
    }

    /** Render a simple fixed-width table. Columns padded to the widest cell. */
    private String renderTable(String[] headers, java.util.List<String[]> rows) {
        int[] widths = new int[headers.length];
        for (int i = 0; i < headers.length; i++) widths[i] = headers[i].length();
        for (String[] row : rows) {
            for (int i = 0; i < row.length; i++) {
                int len = row[i] == null ? 1 : row[i].length();
                if (len > widths[i]) widths[i] = len;
            }
        }
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < headers.length; i++) {
            if (i > 0) sb.append("  ");
            sb.append(pad(headers[i], widths[i]));
        }
        sb.append('\n');
        for (int i = 0; i < headers.length; i++) {
            if (i > 0) sb.append("  ");
            sb.append("-".repeat(widths[i]));
        }
        sb.append('\n');
        for (String[] row : rows) {
            for (int i = 0; i < row.length; i++) {
                if (i > 0) sb.append("  ");
                sb.append(pad(row[i] == null ? "-" : row[i], widths[i]));
            }
            sb.append('\n');
        }
        return sb.toString();
    }

    private String pad(String s, int w) {
        if (s.length() >= w) return s;
        return s + " ".repeat(w - s.length());
    }

    /**
     * Find {@code conc [state] Name [Param]} declarations in Dash+ source and prepend {@code sig
     * Param {}} for any param sig not already declared. Returns the patched source if anything was
     * added, or the original string otherwise.
     */
    private String injectMissingDashParamSigs(String source) {
        // Param-introducing positions: `conc Name [P]` or `conc state Name [P]`
        // followed by `{` (the state body). This avoids matching `Elevator[PID_1]`
        // instance references and `min[Floor]` function calls.
        Pattern paramIntro =
                Pattern.compile("\\bconc\\b\\s+(?:state\\s+)?\\w+\\s*\\[\\s*(\\w+)\\s*\\]\\s*\\{");
        java.util.LinkedHashSet<String> paramSigs = new java.util.LinkedHashSet<>();
        Matcher m = paramIntro.matcher(source);
        while (m.find()) {
            paramSigs.add(m.group(1));
        }
        if (paramSigs.isEmpty()) {
            return source;
        }

        // Already-declared sigs (any modifier, any parent clause)
        Pattern sigDecl =
                Pattern.compile(
                        "^\\s*(?:abstract\\s+|one\\s+|lone\\s+|some\\s+|private\\s+)*sig\\s+(\\w+)\\b",
                        Pattern.MULTILINE);
        java.util.HashSet<String> declared = new java.util.HashSet<>();
        Matcher d = sigDecl.matcher(source);
        while (d.find()) {
            declared.add(d.group(1));
        }

        java.util.List<String> missing = new java.util.ArrayList<>();
        for (String p : paramSigs) {
            if (!declared.contains(p)) missing.add(p);
        }
        if (missing.isEmpty()) {
            return source;
        }

        // Insert the new declarations after the last top-level `open ...` import (or
        // at the start of the file if there are none) so they precede every state and
        // sig declaration.
        Pattern openLine = Pattern.compile("^\\s*open\\s+.+$", Pattern.MULTILINE);
        Matcher o = openLine.matcher(source);
        int insertPos = 0;
        while (o.find()) {
            insertPos = o.end();
        }
        // Step past the trailing newline(s) so the inserted block starts on a fresh line.
        while (insertPos < source.length()
                && (source.charAt(insertPos) == '\n' || source.charAt(insertPos) == '\r')) {
            insertPos++;
        }

        StringBuilder injection = new StringBuilder();
        injection.append("// auto-injected by SessionServer: missing param sigs\n");
        for (String p : missing) {
            injection.append("sig ").append(p).append(" {}\n");
        }
        injection.append('\n');

        System.err.println("[SessionServer] auto-injected sig declarations for params: " + missing);

        return source.substring(0, insertPos) + injection + source.substring(insertPos);
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

        int cmdCount = currentAlloyModel.getNumCmds();
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
     * Initialize simulation — origin/master logic restored, with sig-scope plumbing kept.
     *
     * <p>Differences from origin: we still ask the user for scopes via /api/inspect and inject the
     * concrete subsigs ({@code one sig PID_0, PID_1 extends PID {}}) plus the per-sig {@code
     * exactly N} clauses in the run command. Otherwise behaviour is identical to origin: take the
     * translated model unchanged, append the run command, compile, run with exactly 1 __Snapshot.
     */
    private JsonObject handleInit(JsonObject params) {
        if (currentAlloyModel == null) {
            return errorResponse("No translated model. Call translate first.");
        }

        currentSigScopes = extractSigScopes(params);

        String alloyCode = injectMissingParamSigs(currentAlloyModel.toString());
        String concreteSigs = getConcreteSigsDefinition(currentSigScopes);
        // ALDB layout: model with __initial REMOVED and concrete sigs in its place, then the
        // __initial pred re-appended at the end. Replicate so paragraph order matches
        // byte-for-byte.
        String[] split = extractInitPredicate(alloyCode);
        String modelNoInit = replaceInitPredicate(alloyCode, concreteSigs);
        String initPred = (split != null) ? split[1] : "";
        // Wrap exactly like ALDB: layer a dedicated util/ordering (aldb_order) on top,
        // assert __initial on aldb_order/first, chain __small_step along aldb_order/next.
        String fullCode = buildAldbAnnotatedSystem(modelNoInit, initPred, 1, false);

        dumpForDebug("init", fullCode);

        try {
            JsonObject result = compileAndRun(fullCode);
            initA4Solution = currentA4Solution; // save for Alt Init enumeration
            steppedSinceInit = false; // next step is the "first step" (uses original __initial)
            return result;
        } catch (Exception e) {
            return errorResponse("Init error: " + e.getMessage());
        }
    }

    // ──────────────────────────────────────────────────────────────
    // Step — origin/master logic restored
    // ──────────────────────────────────────────────────────────────

    /**
     * Step from a given state — origin/master logic restored, with sig-scope plumbing kept.
     *
     * <p>Builds a custom {@code __initial} pred that pins only {@code __conf0}, {@code __stable},
     * and user variables, and explicitly resets {@code __taken0}/{@code __sc_used0} to none. Leaves
     * everything else free for the solver (events, per-level conf/taken/sc_used at depth ≥ 1).
     * Iterates the snapshot scope from 2 upward until a satisfying assignment is found, then
     * returns it.
     *
     * <p>Params: {state: {field: [values]}, sigScopes: {PID: 2, Floor: 3}, maxScope: 10}
     */
    private JsonObject handleStep(JsonObject params) {
        if (currentAlloyModel == null) {
            return errorResponse("No translated model. Call translate first.");
        }
        if (params == null || !params.has("state")) {
            return errorResponse("Missing state parameter");
        }

        JsonObject state = params.getAsJsonObject("state");
        int maxScope = params.has("maxScope") ? params.get("maxScope").getAsInt() : 10;

        if (params.has("sigScopes")) {
            currentSigScopes = extractSigScopes(params);
        }

        String alloyCode = injectMissingParamSigs(currentAlloyModel.toString());
        String concreteSigs = getConcreteSigsDefinition(currentSigScopes);

        // ALDB layout: model with __initial REMOVED, concrete sigs in its place; the init pred
        // re-appended at the end. modelNoInit is shared; only the init pred differs by step phase.
        String[] split = extractInitPredicate(alloyCode);
        String modelNoInit = replaceInitPredicate(alloyCode, concreteSigs);

        // ALDB's performStep: on the FIRST step after init (stateGraph.size() <= 1) it uses the
        // model's ORIGINAL __initial (abstract — env events free). Only on later steps does it
        // rebuild __initial from the current node's concrete snapshot. Mirror that exactly.
        String initPred;
        if (!steppedSinceInit) {
            initPred = (split != null) ? split[1] : ""; // original abstract __initial
        } else {
            initPred = buildInitFromFlatState(state); // concrete pinned __initial
        }

        // ALDB steps with exactly 2 snapshots (current + next). Try 2 first to match ALDB
        // exactly; fall back to larger scopes only if 2 is UNSAT.
        for (int scope = 2; scope <= maxScope; scope++) {
            String fullCode = buildAldbAnnotatedSystem(modelNoInit, initPred, scope, true);
            if (scope == 2) dumpForDebug("step", fullCode);
            try {
                JsonObject result = compileAndRun(fullCode);
                JsonObject data = result.getAsJsonObject("data");
                if (data != null
                        && data.has("satisfiable")
                        && data.get("satisfiable").getAsBoolean()) {
                    steppedSinceInit = true; // subsequent steps rebuild from the concrete snapshot
                    return result;
                }
            } catch (Exception e) {
                // try next scope
            }
        }

        JsonObject data = new JsonObject();
        data.addProperty("satisfiable", false);
        return okResponse(data);
    }

    /**
     * Wrap the translated model the way ALDB's {@code AlloyUtils.annotatedTransitionSystem} does:
     * prepend a dedicated {@code util/ordering} alias ({@code aldb_order}), assert {@code
     * __initial} on its first snapshot, chain {@code __small_step} along its {@code next}, and
     * append the run command. The model text already contains {@code util/traces + __traces_fact}
     * (self-driving); ALDB layers its own ordering on top exactly like this, so replicating it
     * makes the compiled Alloy structurally identical to what ALDB feeds the solver — which is what
     * drives Kodkod to the same symmetry-broken solution (e.g. env events landing in {@code
     * __events0}).
     */
    /**
     * Assemble the full Alloy code in ALDB's exact paragraph order (mirrors {@code
     * AlloyUtils.annotatedTransitionSystem}):
     *
     * <pre>
     *   open util/ordering[__Snapshot] as aldb_order
     *   &lt;modelNoInit&gt;            // model with __initial removed, concrete sigs in its place
     *   &lt;initPred&gt;               // the __initial predicate, re-appended here
     *   [pred path {} ]           // step only: empty no-op path predicate
     *   fact { __initial[aldb_order/first] }
     *   [fact { path[aldb_order/first] } ]   // step only
     *   fact { all s, sprime: s.(aldb_order/next) { __small_step[s, sprime] } }
     *   run { } for exactly N __Snapshot, exactly K Sig …
     * </pre>
     */
    private String buildAldbAnnotatedSystem(
            String modelNoInit, String initPred, int snapshotScope, boolean isStep) {
        StringBuilder sb = new StringBuilder();
        sb.append("open util/ordering[__Snapshot] as aldb_order\n\n");
        sb.append(modelNoInit).append("\n");
        sb.append(initPred).append("\n");
        if (isStep) {
            sb.append("pred path[s: one __Snapshot] {\n\t\n}\n");
        }
        sb.append("\nfact { __initial[aldb_order/first] }\n\n");
        if (isStep) {
            sb.append("fact { path[aldb_order/first] }\n\n");
        }
        sb.append(
                "fact { all s: __Snapshot, sprime: s.(aldb_order/next) {"
                        + " __small_step[s, sprime] } }\n\n");
        sb.append(buildRunCommand(snapshotScope)).append("\n");
        return sb.toString();
    }

    /**
     * Replace the existing {@code pred __initial[…] { … }} block in the Alloy code with a new
     * predicate. Uses brace counting to find the block end. If no {@code __initial} pred is found,
     * the new one is appended at the end of the code.
     */
    private String replaceInitPredicate(String alloyCode, String newInit) {
        Pattern p = Pattern.compile("pred\\s+__initial\\s*\\[");
        Matcher m = p.matcher(alloyCode);
        if (!m.find()) {
            return alloyCode + "\n" + newInit;
        }
        int predStart = m.start();
        int braceCount = 0;
        int predEnd = -1;
        for (int i = predStart; i < alloyCode.length(); i++) {
            char c = alloyCode.charAt(i);
            if (c == '{') braceCount++;
            else if (c == '}') {
                braceCount--;
                if (braceCount == 0) {
                    predEnd = i + 1;
                    break;
                }
            }
        }
        if (predEnd == -1) {
            return alloyCode + "\n" + newInit;
        }
        return alloyCode.substring(0, predStart) + newInit + alloyCode.substring(predEnd);
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

    /**
     * Enumerate the next alternate initial state. Uses the init-specific A4Solution so Alt Init
     * always walks init alternatives even after a step has been taken.
     */
    private JsonObject handleNextInit() {
        if (initA4Solution == null) {
            return errorResponse("No init solution. Call init first.");
        }
        if (!initA4Solution.satisfiable()) {
            JsonObject data = new JsonObject();
            data.addProperty("satisfiable", false);
            return okResponse(data);
        }

        initA4Solution = initA4Solution.next();
        // Point currentA4Solution at the new init solution too, so that
        // a subsequent step compileAndRun replaces it cleanly.
        currentA4Solution = initA4Solution;
        steppedSinceInit = false; // next step is again a "first step" from this new init state
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
     * Build a {@code pred __initial} from a flat field map for stepping — pins EVERY field
     * verbatim, exactly like ALDB's {@code StateNode.getAlloyInitString}.
     *
     * <p>Every snapshot field (conf*, taken*, sc_used*, events*, stable, and all user variables) is
     * written as {@code s.field = v1 + v2 + …}, or {@code s.field = none[->none…]} when empty.
     * Nothing is reset or left free. This fully determines the seed snapshot, so:
     *
     * <ul>
     *   <li><b>step</b> from a state reproduces that exact state as snapshot[0] and computes its
     *       successor as snapshot[1] — matching the state the user is stepping from.
     *   <li><b>alt</b> ({@code A4Solution.next()}) can only vary snapshot[1] (the successor), never
     *       the pinned seed — matching ALDB's alt, which enumerates alternate successors of a fixed
     *       source node.
     * </ul>
     *
     * <p>Pinning events (rather than leaving them free) is essential: with the ALDB-style {@code
     * aldb_order} wrapper, init already places env events in {@code __events0} correctly, so the
     * stepped-from state carries the right events and the successor consumes them.
     */
    private String buildInitFromFlatState(JsonObject state) {
        StringBuilder sb = new StringBuilder();
        sb.append("pred __initial[s: one __Snapshot] {\n");

        for (Map.Entry<String, JsonElement> entry : state.entrySet()) {
            String fieldName = entry.getKey();
            JsonArray values = entry.getValue().getAsJsonArray();
            int arity =
                    (fieldArities != null && fieldArities.containsKey(fieldName))
                            ? fieldArities.get(fieldName)
                            : 1;

            if (values.size() == 0) {
                sb.append("\ts.").append(fieldName).append(" = ").append(getEmptyRelation(arity));
            } else {
                sb.append("\ts.").append(fieldName).append(" = ");
                for (int i = 0; i < values.size(); i++) {
                    if (i > 0) sb.append(" + ");
                    sb.append(values.get(i).getAsString());
                }
            }
            sb.append("\n");
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

    // ── Debug: dump every .als sent to the solver, numbered + named by phase ──
    private int dumpCounter = 0;
    private static final String DUMP_DIR =
            System.getProperty("dash.dumpDir", "C:/Users/13916/Desktop/als-compare");

    /**
     * Write a copy of the Alloy code sent to the solver into the compare dir, named
     * webapp-NN-phase.als (NN = global call order on this CommandRouter). Mirrors ALDB's
     * AlloyUtils.dumpAls so the two tools' .als files can be diffed side by side.
     */
    private void dumpForDebug(String phase, String fullCode) {
        try {
            java.nio.file.Path dir = java.nio.file.Paths.get(DUMP_DIR);
            java.nio.file.Files.createDirectories(dir);
            String name = String.format("webapp-%02d-%s.als", dumpCounter++, phase);
            java.nio.file.Files.writeString(dir.resolve(name), fullCode);
            System.err.println("[SessionServer] dumped " + name);
        } catch (java.io.IOException e) {
            System.err.println("[SessionServer] dumpForDebug failed: " + e.getMessage());
        }
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
