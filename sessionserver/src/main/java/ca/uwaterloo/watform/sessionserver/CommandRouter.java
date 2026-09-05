package ca.uwaterloo.watform.sessionserver;

import ca.uwaterloo.watform.alloyinterface.AlloyInterface;
import ca.uwaterloo.watform.alloyinterface.Instance;
import ca.uwaterloo.watform.alloyinterface.Solution;
import ca.uwaterloo.watform.alloyast.AlloyFile;
import ca.uwaterloo.watform.alloyast.paragraph.AlloyImportPara;
import ca.uwaterloo.watform.alloyast.paragraph.AlloyPara;
import ca.uwaterloo.watform.alloyast.paragraph.module.AlloyModulePara;
import ca.uwaterloo.watform.alloymodel.AlloyModel;
import ca.uwaterloo.watform.alloymodel.Qname;
import ca.uwaterloo.watform.dashast.DashParser;
import ca.uwaterloo.watform.dashmodel.DashModel;
import ca.uwaterloo.watform.dashtoalloy.BaseD2A;
import ca.uwaterloo.watform.dashtoalloy.DashToAlloy;
import ca.uwaterloo.watform.parser.AlloyParser;
import ca.uwaterloo.watform.utils.Reporter;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import edu.mit.csail.sdg.alloy4.A4Reporter;
import edu.mit.csail.sdg.ast.Command;
import edu.mit.csail.sdg.parser.CompModule;
import edu.mit.csail.sdg.translator.A4Options;
import edu.mit.csail.sdg.translator.A4Solution;
import edu.mit.csail.sdg.translator.TranslateAlloyToKodkod;
import java.io.PrintWriter;
import java.io.StringWriter;
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
 * CommandRouter handles simulation commands using a web-app-owned wrapper around Dash+'s
 * translated Alloy model: flat field maps for state representation, concrete sig injection for
 * named atoms, and explicit {@code curr_snapshot}/{@code next_snapshot} marker sigs.
 *
 * <p>The simulation flow is: 1. load — parse .dsh file to DashModel 2. translate — DashToAlloy
 * produces an AlloyModel 3. init — add concrete sigs and constrain {@code curr_snapshot} 4. step
 * — pin {@code curr_snapshot} from the web-app state map and solve for {@code next_snapshot} 5.
 * next — temporarily use Alloy's {@code A4Solution.next()} for alternate enumeration
 */
public class CommandRouter {
    private static final String CURR_SNAPSHOT = "curr_snapshot";
    private static final String NEXT_SNAPSHOT = "next_snapshot";
    private static final String WEBAPP_CONF = "__webapp_conf";
    private static final String WEBAPP_EVENTS = "__webapp_events";
    private static final String WEBAPP_TAKEN = "__webapp_taken";
    private static final Path ALLOY_SCRATCH_DIR =
            Paths.get(System.getProperty("java.io.tmpdir"), "dash-visualizer", "alloy")
                    .toAbsolutePath()
                    .normalize();

    // Model state
    private DashModel currentModel;
    private AlloyModel currentAlloyModel;

    // Domain info extracted from the FIRST solver response (init) via the dashplus Solution
    // class — no structural assumptions. The static bucket (everything not snapshot-keyed) is
    // FILTERED subtractively: instead of searching for known kinds (orderings), we remove what
    // is provably not domain info — library relations, wrapper/trace machinery, skolems, and
    // declaration-forced singletons — and pin ALL survivors into subsequent step solves. Today
    // the survivors are ordering valuations; a model with static domain fields or user subset
    // sigs would have those survive (and get pinned) with no code change.
    private String extractedDomainPins;
    private List<GeneratedAlloyFragment> extractedDomainPinFragments = Collections.emptyList();

    // Web-app simulation state
    private Map<String, Integer> currentSigScopes; // e.g., {PID: 2, Floor: 3}
    private Map<String, Integer> fieldArities; // field name → value arity (excl. snapshot)
    private Map<String, Integer> snapshotFieldDeclaredArities = Collections.emptyMap();
    private Set<String> environmentInputFields = Collections.emptySet();
    private A4Solution currentA4Solution;
    private A4Solution initA4Solution; // kept separate so Alt Init always enumerates from init
    private String currentA4SeedCode;
    private String initA4SeedCode;
    private Solution currentSolution;
    private CompModule currentCompiled;
    private SimulationAlloyModule lastSimulationModule;
    // Terminality of the current solution: true when the returned snapshot has NO enabled
    // transition (a dead end / trace end). Only set in "simplified" simulation mode (the one that
    // adds the trans_enabled predicate); threaded into every serialized response so the frontend
    // can draw terminal snapshots as rectangular nodes. Always false in "raw" mode.
    private boolean currentTerminal = false;

    /** How the final snapshot's trans_enabled status is constrained when building the system. */
    private enum TransMode {
        REQUIRE, // fact { __trans_enabled[last] }      — last snapshot can step further
        FORBID, // fact { not __trans_enabled[last] }   — last snapshot is a dead end
        ANY // no constraint (raw simulation)
    }

    /**
     * Generated simulation paragraph. The source is retained for debug dumps and as a temporary
     * seed for alternate enumeration; the parsed {@link AlloyPara} is used to assemble the
     * structured {@link AlloyModel} that Dash+ executes for init/step.
     */
    private static final class GeneratedAlloyFragment {
        final String source;
        final AlloyPara para;

        GeneratedAlloyFragment(String source, AlloyPara para) {
            this.source = source;
            this.para = para;
        }
    }

    /** Captures the structured pieces used to assemble one init/step solver input. */
    private static final class SimulationAlloyModule {
        final AlloyModel baseModel;
        final AlloyModel structuredModel;
        final String modelSource;
        final String initPredicateSource;
        final List<GeneratedAlloyFragment> insertedFragments;
        final List<GeneratedAlloyFragment> wrapperFragments;

        SimulationAlloyModule(
                AlloyModel baseModel,
                AlloyModel structuredModel,
                String modelSource,
                String initPredicateSource,
                List<GeneratedAlloyFragment> insertedFragments,
                List<GeneratedAlloyFragment> wrapperFragments) {
            this.baseModel = baseModel;
            this.structuredModel = structuredModel;
            this.modelSource = modelSource;
            this.initPredicateSource = initPredicateSource;
            this.insertedFragments = List.copyOf(insertedFragments);
            this.wrapperFragments = List.copyOf(wrapperFragments);
        }
    }

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
                case "alt-trans" -> handleStep(params); // step + "fire an untaken transition" fact
                case "next" -> handleNext();
                case "next-init" -> handleNextInit();
                case "tables" -> handleTables();
                case "generated" -> handleGenerated();
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

        try {
            AlloyModel model = DashParser.dashParseToModel(effectivePath.toString());
            if (model == null) {
                return errorResponse("Failed to parse file: " + filePath);
            }
            if (!(model instanceof DashModel)) {
                return errorResponse("File is not a Dash model: " + filePath);
            }

            currentModel = (DashModel) model;
            currentAlloyModel = null;
            clearSimulationState();

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
    /**
     * The Alloy actually solved for the most recent init/step, so the web app can show the
     * generated facts alongside the user's own constraints instead of describing them.
     *
     * <p>{@code wrapperFragments} are the per-solve additions — concrete scope sigs, the
     * snapshot markers, the user's constraint predicate, the Alt Trans exclusion, the
     * terminality facts and the run command. {@code insertedFragments} are the paragraphs
     * spliced into the translated model itself, such as domain pins carried forward from an
     * earlier solution.
     */
    private JsonObject handleGenerated() {
        JsonObject data = new JsonObject();
        SimulationAlloyModule module = lastSimulationModule;
        if (module == null) {
            data.addProperty("available", false);
            return okResponse(data);
        }

        data.addProperty("available", true);
        data.addProperty(
                "alloyCode",
                module.structuredModel == null ? "" : module.structuredModel.toString());
        data.addProperty("initPredicate", module.initPredicateSource == null ? "" : module.initPredicateSource);
        data.add("insertedFragments", fragmentSources(module.insertedFragments));
        data.add("wrapperFragments", fragmentSources(module.wrapperFragments));
        return okResponse(data);
    }

    private JsonArray fragmentSources(List<GeneratedAlloyFragment> fragments) {
        JsonArray sources = new JsonArray();
        if (fragments == null) {
            return sources;
        }
        for (GeneratedAlloyFragment fragment : fragments) {
            if (fragment != null && fragment.source != null && !fragment.source.isBlank()) {
                sources.add(fragment.source.trim());
            }
        }
        return sources;
    }

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
        deleteStaleGeneratedAlloyFile(currentAlloyModel.fullFileName);
        snapshotFieldDeclaredArities = extractSnapshotFieldArities(currentAlloyModel.toString());
        environmentInputFields = detectEnvironmentInputFields(currentModel);
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
    // Init
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
        List<String> constraints = extractConstraints(params);

        String alloyCode = prepareTranslatedAlloyForSimulation(currentAlloyModel.toString());
        // Init runs WITHOUT ordering pins: we make no assumptions about domain structure and
        // let the solver choose freely. The choice is then extracted from the response (static
        // bucket) and pinned into every subsequent step solve.
        List<GeneratedAlloyFragment> concreteSigFragments =
                getConcreteSigFragments(currentSigScopes);
        String concreteSigs = renderFragments(concreteSigFragments);
        // Keep the translated __initial intact. The simulation wrapper constrains curr_snapshot
        // directly instead of rewriting translator output.
        String modelNoInit = alloyCode + "\n" + concreteSigs;
        String initPred = buildCurrentSnapshotFromOriginal();
        // The wrapper marks the one init snapshot as curr_snapshot. In simplified mode, prefer an
        // init snapshot that can step further (a dead-end one is marked terminal); in raw mode, no
        // trans_enabled predicate is added.
        boolean simplified = parseSimplifiedMode(params);

        try {
            JsonObject result =
                    solveSim(
                            modelNoInit,
                            initPred,
                            1,
                            false,
                            constraints,
                            simplified,
                            null,
                            concreteSigFragments,
                            "init");
            initA4Solution = null;
            initA4SeedCode = currentA4SeedCode; // save for Alt Init enumeration
            // First response is in: extract the static bucket and derive the ordering pins that
            // every later solve of this trace will carry.
            extractDomainInfoFromSolution();
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
     * <p>Builds a custom {@code __initial} pred that pins the supplied snapshot fields while leaving
     * environment-owned inputs free for the solver. Numbered conf/taken/event fields are preserved
     * at the depth emitted by the translator.
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
        List<String> constraints = extractConstraints(params);
        List<String> excludeTransitions = extractExcludeTransitions(params);

        if (params.has("sigScopes")) {
            currentSigScopes = extractSigScopes(params);
        }

        String alloyCode = prepareTranslatedAlloyForSimulation(currentAlloyModel.toString());
        // Steps carry the domain pins extracted from the init response, so the whole trace
        // agrees with the static choices the first solve made.
        List<GeneratedAlloyFragment> insertedFragments = new ArrayList<>();
        insertedFragments.addAll(getConcreteSigFragments(currentSigScopes));
        insertedFragments.addAll(extractedDomainPinFragments);
        String concreteSigs = renderFragments(insertedFragments);

        String modelNoInit = alloyCode + "\n" + concreteSigs;

        // Every step is local: pin the web-app's stored current snapshot directly, then ask Alloy
        // for one successor.
        String initPred = buildCurrentSnapshotFromFlatState(state);

        // Fixed scope of 2: exactly 1 small step (current + next). In "simplified" mode, prefer a
        // successor that can itself step further (a dead end is marked terminal); in "raw" mode,
        // no trans_enabled predicate is added.
        boolean simplified = parseSimplifiedMode(params);

        try {
            JsonObject result =
                    solveSim(
                            modelNoInit,
                            initPred,
                            2,
                            true,
                            constraints,
                            simplified,
                            excludeTransitions,
                            insertedFragments,
                            "step");
            return result;
        } catch (Exception e) {
            return errorResponse("Step error: " + e.getMessage());
        }
    }

    /**
     * Assemble the Alloy code rendered for debug dumps and temporary alternate enumeration. The
     * same paragraphs are also parsed and assembled into an {@link AlloyModel} for normal Dash+
     * execution.
     *
     * <pre>
     *   &lt;modelNoInit&gt;            // translated model plus concrete/domain fragments
     *   one sig curr_snapshot[, next_snapshot] in __Snapshot {}
     *   &lt;initPred&gt;               // __initial[curr_snapshot] or concrete snapshot pins
     *   [pred __cst[s: one __Snapshot] { ... }]
     *   [fact { path }]
     *   [fact { __small_step[curr_snapshot, next_snapshot] }]
     *   run { } for exactly N __Snapshot, exactly K Sig …
     * </pre>
     */
    private String buildSimulationAlloySystem(
            String modelNoInit,
            String initPred,
            int snapshotScope,
            boolean isStep,
            List<String> constraints,
            TransMode transMode,
            List<String> excludeTransitions) {
        StringBuilder sb = new StringBuilder();
        sb.append(modelNoInit).append("\n");
        sb.append(buildSnapshotMarkerSigs(isStep)).append("\n");
        if (isStep) {
            sb.append(buildDistinctSnapshotMarkersFact()).append("\n");
        }
        for (String helper : buildSnapshotProjectionHelpers()) {
            sb.append(helper).append("\n");
        }
        sb.append(initPred).append("\n");

        if (isStep) {
            // Build path predicate that constrains the successor snapshot.
            // Constraints use 's.' references, so path applies them to next_snapshot.
            if (constraints != null && !constraints.isEmpty()) {
                // Auxiliary pred: constraints applied to a single snapshot parameter 's'
                sb.append("pred __cst[s: one __Snapshot] {\n");
                for (String c : constraints) {
                    sb.append("\t").append(c).append("\n");
                }
                sb.append("}\n");
                // path calls __cst on the successor snapshot
                sb.append("pred path {\n");
                sb.append("\t__cst[").append(NEXT_SNAPSHOT).append("]\n");
                sb.append("}\n");
            } else {
                sb.append("pred path {\n\t\n}\n");
            }
        }

        if (!isStep && constraints != null && !constraints.isEmpty()) {
            // For init: constraints apply directly to curr_snapshot.
            sb.append("fact {\n");
            sb.append("\tlet s = ").append(CURR_SNAPSHOT).append(" {\n");
            for (String c : constraints) {
                sb.append("\t\t").append(c).append("\n");
            }
            sb.append("\t}\n");
            sb.append("}\n\n");
        }

        if (isStep) {
            sb.append("fact { path }\n\n");
            sb.append("fact { __small_step[")
                    .append(CURR_SNAPSHOT)
                    .append(", ")
                    .append(NEXT_SNAPSHOT)
                    .append("] }\n\n");
        }
        String terminalSnapshot = isStep ? NEXT_SNAPSHOT : CURR_SNAPSHOT;
        if (transMode == TransMode.REQUIRE) {
            // Require the final snapshot (the one we'd step to next) to have at least one
            // enabled transition, i.e. it is not a dead end. If this makes the system unsat,
            // the caller retries with FORBID; a solution there means the trace has ended.
            sb.append("fact { __trans_enabled[").append(terminalSnapshot).append("] }\n\n");
        } else if (transMode == TransMode.FORBID) {
            // Restrict to dead-end final snapshots: exactly the terminal alternates, disjoint
            // from the REQUIRE solution space.
            sb.append("fact { not __trans_enabled[")
                    .append(terminalSnapshot)
                    .append("] }\n\n");
        }
        if (isStep && excludeTransitions != null && !excludeTransitions.isEmpty()) {
            sb.append(buildTransitionExclusionFact(NEXT_SNAPSHOT, excludeTransitions))
                    .append("\n\n");
        }
        sb.append(buildRunCommand(snapshotScope)).append("\n");
        return sb.toString();
    }

    private List<GeneratedAlloyFragment> buildSimulationWrapperFragments(
            int snapshotScope,
            boolean isStep,
            List<String> constraints,
            TransMode transMode,
            List<String> excludeTransitions) {
        List<GeneratedAlloyFragment> fragments = new ArrayList<>();
        fragments.add(parseGeneratedParagraph(buildSnapshotMarkerSigs(isStep)));
        if (isStep) {
            fragments.add(parseGeneratedParagraph(buildDistinctSnapshotMarkersFact()));
        }
        for (String helper : buildSnapshotProjectionHelpers()) {
            fragments.add(parseGeneratedParagraph(helper));
        }

        if (isStep) {
            if (constraints != null && !constraints.isEmpty()) {
                StringBuilder cst = new StringBuilder();
                cst.append("pred __cst[s: one __Snapshot] {\n");
                for (String c : constraints) {
                    cst.append("\t").append(c).append("\n");
                }
                cst.append("}");
                fragments.add(parseGeneratedParagraph(cst.toString()));
                fragments.add(
                        parseGeneratedParagraph(
                                "pred path {\n"
                                        + "\t__cst[" + NEXT_SNAPSHOT + "]\n"
                                        + "}"));
            } else {
                fragments.add(parseGeneratedParagraph("pred path {}"));
            }
        }

        if (!isStep && constraints != null && !constraints.isEmpty()) {
            StringBuilder initConstraints = new StringBuilder();
            initConstraints.append("fact {\n");
            initConstraints.append("\tlet s = ").append(CURR_SNAPSHOT).append(" {\n");
            for (String c : constraints) {
                initConstraints.append("\t\t").append(c).append("\n");
            }
            initConstraints.append("\t}\n");
            initConstraints.append("}");
            fragments.add(parseGeneratedParagraph(initConstraints.toString()));
        }

        if (isStep) {
            fragments.add(parseGeneratedParagraph("fact { path }"));
            fragments.add(
                    parseGeneratedParagraph(
                            "fact { __small_step["
                                    + CURR_SNAPSHOT
                                    + ", "
                                    + NEXT_SNAPSHOT
                                    + "] }"));
        }
        String terminalSnapshot = isStep ? NEXT_SNAPSHOT : CURR_SNAPSHOT;
        if (transMode == TransMode.REQUIRE) {
            fragments.add(
                    parseGeneratedParagraph(
                            "fact { __trans_enabled[" + terminalSnapshot + "] }"));
        } else if (transMode == TransMode.FORBID) {
            fragments.add(
                    parseGeneratedParagraph(
                            "fact { not __trans_enabled[" + terminalSnapshot + "] }"));
        }
        if (isStep && excludeTransitions != null && !excludeTransitions.isEmpty()) {
            fragments.add(
                    parseGeneratedParagraph(
                            buildTransitionExclusionFact(
                                    NEXT_SNAPSHOT, excludeTransitions)));
        }
        fragments.add(parseGeneratedParagraph(buildRunCommand(snapshotScope)));
        return Collections.unmodifiableList(fragments);
    }

    private String buildSnapshotMarkerSigs(boolean isStep) {
        if (isStep) {
            return "one sig "
                    + CURR_SNAPSHOT
                    + ", "
                    + NEXT_SNAPSHOT
                    + " in __Snapshot {}";
        }
        return "one sig " + CURR_SNAPSHOT + " in __Snapshot {}";
    }

    private String buildDistinctSnapshotMarkersFact() {
        return "fact { " + CURR_SNAPSHOT + " != " + NEXT_SNAPSHOT + " }";
    }

    private List<String> buildSnapshotProjectionHelpers() {
        return List.of(
                buildSnapshotProjectionHelper(WEBAPP_CONF, "__conf"),
                buildSnapshotProjectionHelper(WEBAPP_EVENTS, "__events"),
                buildSnapshotProjectionHelper(WEBAPP_TAKEN, "__taken"));
    }

    private String buildSnapshotProjectionHelper(String name, String fieldPrefix) {
        return "fun "
                + name
                + "[s: one __Snapshot]: set univ"
                + " { "
                + projectSnapshotFieldsToLastColumn("s", fieldPrefix)
                + " }";
    }

    private String projectSnapshotFieldsToLastColumn(String snapshot, String fieldPrefix) {
        List<String> fields = numberedSnapshotFields(fieldPrefix);
        List<String> projections = new ArrayList<>();
        for (String field : fields) {
            String projection = snapshot + "." + field;
            int valueArity = Math.max(1, snapshotFieldDeclaredArities.getOrDefault(field, 1));
            for (int arity = 1; arity < valueArity; arity++) {
                projection = "univ.(" + projection + ")";
            }
            projections.add(projection);
        }
        return projections.isEmpty() ? "none" : String.join(" + ", projections);
    }

    private List<String> numberedSnapshotFields(String fieldPrefix) {
        List<String> fields = new ArrayList<>();
        Pattern numberedField = Pattern.compile(Pattern.quote(fieldPrefix) + "(\\d+)");
        for (String field : snapshotFieldDeclaredArities.keySet()) {
            if (numberedField.matcher(field).matches()) {
                fields.add(field);
            }
        }
        fields.sort(
                java.util.Comparator.comparingInt(
                        field -> {
                            Matcher matcher = numberedField.matcher(field);
                            return matcher.matches() ? Integer.parseInt(matcher.group(1)) : 0;
                        }));
        return fields;
    }

    private String buildTransitionExclusionFact(
            String snapshot, List<String> excludeTransitions) {
        List<String> alternatives = new ArrayList<>();
        for (String field : numberedSnapshotFields("__taken")) {
            int fieldArity = Math.max(1, snapshotFieldDeclaredArities.getOrDefault(field, 1));
            List<String> exclusions = new ArrayList<>();
            for (String transition : excludeTransitions) {
                int transitionArity = transition.split("\\s*->\\s*").length;
                if (transitionArity == fieldArity) {
                    exclusions.add(transition);
                } else if (transitionArity == 1) {
                    exclusions.add(expandBareTransitionExclusion(transition, fieldArity));
                }
            }

            String relation = snapshot + "." + field;
            if (exclusions.isEmpty()) {
                alternatives.add("some " + relation);
            } else {
                alternatives.add(
                        "some ("
                                + relation
                                + " - ("
                                + String.join(" + ", exclusions)
                                + "))");
            }
        }

        String body =
                alternatives.isEmpty()
                        ? "some " + WEBAPP_TAKEN + "[" + snapshot + "]"
                        : String.join(" or\n\t", alternatives);
        return "fact {\n\t" + body + "\n}";
    }

    private String expandBareTransitionExclusion(String transition, int fieldArity) {
        List<String> columns = new ArrayList<>();
        for (int i = 1; i < fieldArity; i++) {
            columns.add("univ");
        }
        columns.add(transition);
        return String.join(" -> ", columns);
    }

    private void rememberSimulationModule(
            String modelNoInit,
            String initPred,
            List<GeneratedAlloyFragment> insertedFragments,
            List<GeneratedAlloyFragment> wrapperFragments) {
        AlloyModel structuredModel =
                buildStructuredSimulationModel(initPred, insertedFragments, wrapperFragments);
        lastSimulationModule =
                new SimulationAlloyModule(
                        currentAlloyModel,
                        structuredModel,
                        modelNoInit,
                        initPred,
                        insertedFragments,
                        wrapperFragments);
    }

    private AlloyModel buildStructuredSimulationModel(
            String initPred,
            List<GeneratedAlloyFragment> insertedFragments,
            List<GeneratedAlloyFragment> wrapperFragments) {
        List<AlloyPara> moduleAndImports = new ArrayList<>();
        List<AlloyPara> body = new ArrayList<>();
        for (AlloyPara para : currentAlloyModel.getAllParas(false)) {
            if (para instanceof AlloyModulePara || para instanceof AlloyImportPara) {
                moduleAndImports.add(para);
            } else {
                body.add(para);
            }
        }

        List<AlloyPara> paras = new ArrayList<>();
        paras.addAll(moduleAndImports);
        addParsedParas(paras, wrapperFragments, AlloyImportPara.class);
        paras.addAll(body);
        addParsedParas(paras, insertedFragments, (Class<? extends AlloyPara>) null);
        if (!wrapperFragments.isEmpty()) {
            paras.add(wrapperFragments.get(0).para);
        }
        if (initPred != null && !initPred.isBlank()) {
            paras.add(parseGeneratedParagraph(initPred).para);
        }
        addParsedParas(
                paras,
                wrapperFragments,
                (index, para) -> index > 0 && !(para instanceof AlloyImportPara));
        String fullFileName = createSimulationAlloyFileName();
        return new AlloyModel(new AlloyFile(paras, fullFileName));
    }

    private String createSimulationAlloyFileName() {
        try {
            java.nio.file.Files.createDirectories(ALLOY_SCRATCH_DIR);
        } catch (java.io.IOException e) {
            throw new RuntimeException("Could not create Alloy scratch directory: " + ALLOY_SCRATCH_DIR, e);
        }

        String sourceName = "webapp-generated";
        if (currentAlloyModel.fullFileName != null && !currentAlloyModel.fullFileName.isBlank()) {
            String fileName = Paths.get(currentAlloyModel.fullFileName).getFileName().toString();
            sourceName = fileName.endsWith(".als")
                    ? fileName.substring(0, fileName.length() - 4)
                    : fileName;
        }
        String safeName = sourceName.replaceAll("[^A-Za-z0-9._-]", "_");
        return ALLOY_SCRATCH_DIR
                .resolve(safeName + "-" + java.util.UUID.randomUUID() + ".als")
                .toString();
    }

    private void addParsedParas(
            List<AlloyPara> paras,
            List<GeneratedAlloyFragment> fragments,
            Class<? extends AlloyPara> onlyClass) {
        for (GeneratedAlloyFragment fragment : fragments) {
            if (onlyClass == null || onlyClass.isInstance(fragment.para)) {
                paras.add(fragment.para);
            }
        }
    }

    private void addParsedParas(
            List<AlloyPara> paras,
            List<GeneratedAlloyFragment> fragments,
            java.util.function.Predicate<AlloyPara> predicate) {
        for (GeneratedAlloyFragment fragment : fragments) {
            if (predicate.test(fragment.para)) {
                paras.add(fragment.para);
            }
        }
    }

    private void addParsedParas(
            List<AlloyPara> paras,
            List<GeneratedAlloyFragment> fragments,
            java.util.function.BiPredicate<Integer, AlloyPara> predicate) {
        for (int i = 0; i < fragments.size(); i++) {
            GeneratedAlloyFragment fragment = fragments.get(i);
            if (predicate.test(i, fragment.para)) {
                paras.add(fragment.para);
            }
        }
    }

    // ──────────────────────────────────────────────────────────────
    // Next — alternate solution
    // ──────────────────────────────────────────────────────────────

    private JsonObject handleNext() {
        if (currentA4Solution == null && currentA4SeedCode != null) {
            currentA4Solution = executeA4Code(currentA4SeedCode);
        }
        if (currentA4Solution == null) {
            return errorResponse("No current solution. Call init or step first.");
        }
        if (!currentA4Solution.satisfiable()) {
            JsonObject data = new JsonObject();
            data.addProperty("satisfiable", false);
            data.addProperty("terminal", currentTerminal);
            return okResponse(data);
        }

        currentA4Solution = currentA4Solution.next();
        currentSolution = toDashSolution(currentA4Solution);
        return serializeSnapshots();
    }

    /**
     * Enumerate the next alternate initial state. Uses the init-specific A4Solution so Alt Init
     * always walks init alternatives even after a step has been taken.
     */
    private JsonObject handleNextInit() {
        if (initA4Solution == null && initA4SeedCode != null) {
            initA4Solution = executeA4Code(initA4SeedCode);
        }
        if (initA4Solution == null) {
            return errorResponse("No init solution. Call init first.");
        }
        if (!initA4Solution.satisfiable()) {
            JsonObject data = new JsonObject();
            data.addProperty("satisfiable", false);
            data.addProperty("terminal", currentTerminal);
            return okResponse(data);
        }

        initA4Solution = initA4Solution.next();
        // Point currentA4Solution at the new init solution too, so a subsequent step can replace
        // the alternate seed cleanly.
        currentA4Solution = initA4Solution;
        currentA4SeedCode = initA4SeedCode;
        currentSolution = toDashSolution(currentA4Solution);
        // A different init solution may carry a different ordering choice — re-extract so
        // steps taken from this alternative agree with it.
        extractDomainInfoFromSolution();
        return serializeSnapshots();
    }

    /**
     * Build and run one init/step solve. In simplified mode, first require the final snapshot to
     * have an enabled transition ({@link TransMode#REQUIRE}); if that is unsat, retry forbidding it
     * ({@link TransMode#FORBID}) and mark the result terminal (a trace end the frontend draws as a
     * rectangle). In raw mode, add no trans_enabled predicate and never mark terminal.
     */
    private JsonObject solveSim(
            String modelNoInit,
            String initPred,
            int scope,
            boolean isStep,
            List<String> constraints,
            boolean simplified,
            List<String> excludeTransitions,
            List<GeneratedAlloyFragment> insertedFragments,
            String dumpPhase) {
        if (!simplified) {
            String code =
                    buildSimulationAlloySystem(
                            modelNoInit,
                            initPred,
                            scope,
                            isStep,
                            constraints,
                            TransMode.ANY,
                            excludeTransitions);
            rememberSimulationModule(
                    modelNoInit,
                    initPred,
                    insertedFragments,
                    buildSimulationWrapperFragments(
                            scope, isStep, constraints, TransMode.ANY, excludeTransitions));
            dumpForDebug(dumpPhase, code);
            JsonObject result = executeStructuredSimulation(code);
            currentTerminal = false;
            setTerminalFlag(result, false);
            return result;
        }

        String code =
                buildSimulationAlloySystem(
                        modelNoInit,
                        initPred,
                        scope,
                        isStep,
                        constraints,
                        TransMode.REQUIRE,
                        excludeTransitions);
        rememberSimulationModule(
                modelNoInit,
                initPred,
                insertedFragments,
                buildSimulationWrapperFragments(
                        scope, isStep, constraints, TransMode.REQUIRE, excludeTransitions));
        dumpForDebug(dumpPhase, code);
        JsonObject result = executeStructuredSimulation(code);
        if (isSatisfiable(result)) {
            currentTerminal = false;
        } else {
            code =
                    buildSimulationAlloySystem(
                            modelNoInit,
                            initPred,
                            scope,
                            isStep,
                            constraints,
                            TransMode.FORBID,
                            excludeTransitions);
            rememberSimulationModule(
                    modelNoInit,
                    initPred,
                    insertedFragments,
                    buildSimulationWrapperFragments(
                            scope, isStep, constraints, TransMode.FORBID, excludeTransitions));
            dumpForDebug(dumpPhase + "-terminal", code);
            result = executeStructuredSimulation(code);
            currentTerminal = isSatisfiable(result);
        }
        setTerminalFlag(result, currentTerminal);
        return result;
    }

    /**
     * Read the simulation mode from params: {@code "simplified"} adds the trans_enabled predicate.
     */
    private boolean parseSimplifiedMode(JsonObject params) {
        return params != null
                && params.has("mode")
                && "simplified".equalsIgnoreCase(params.get("mode").getAsString());
    }

    // ──────────────────────────────────────────────────────────────
    // Simulation helpers
    // ──────────────────────────────────────────────────────────────

    /** True when the (ok) result reports a satisfiable solution. */
    private boolean isSatisfiable(JsonObject result) {
        JsonObject data = result.getAsJsonObject("data");
        return data != null && data.has("satisfiable") && data.get("satisfiable").getAsBoolean();
    }

    /** Overwrite the terminal flag on an already-serialized result. */
    private void setTerminalFlag(JsonObject result, boolean terminal) {
        JsonObject data = result.getAsJsonObject("data");
        if (data != null) {
            data.addProperty("terminal", terminal);
        }
    }

    /**
     * Run the structured simulation model through Dash+. The rendered Alloy text is retained only
     * as the seed for alternate enumeration while Dash+ does not yet expose {@code Solution.next()}.
     */
    private JsonObject executeStructuredSimulation(String fullCode) {
        if (lastSimulationModule == null || lastSimulationModule.structuredModel == null) {
            throw new RuntimeException("No structured simulation model generated");
        }
        AlloyModel model = lastSimulationModule.structuredModel;
        int cmdIndex = model.getNumCmds() - 1;
        if (cmdIndex < 0) {
            throw new RuntimeException("No commands generated");
        }
        try {
            deleteStaleGeneratedAlloyFile(model.fullFileName);
            currentSolution = AlloyInterface.executeCommand(model, cmdIndex);
            currentA4Solution = null;
            currentCompiled = null;
            currentA4SeedCode = fullCode;
            return serializeSnapshots();
        } finally {
            cleanupSimulationScratchFiles(model.fullFileName);
        }
    }

    private void deleteStaleGeneratedAlloyFile(String fileName) {
        if (fileName == null || fileName.isBlank()) return;
        Path modelPath = Paths.get(fileName).toAbsolutePath().normalize();
        String modelName = modelPath.getFileName().toString();
        String generatedName;
        if (modelName.endsWith("-tmp.als")) {
            generatedName = modelName;
        } else if (modelName.endsWith(".als")) {
            generatedName = modelName.substring(0, modelName.length() - 4) + "-tmp.als";
        } else {
            return;
        }
        Path generated = modelPath.resolveSibling(generatedName);
        try {
            if (java.nio.file.Files.deleteIfExists(generated)) {
                System.err.println("[SessionServer] removed stale generated file: " + generated);
            }
        } catch (java.io.IOException e) {
            throw new RuntimeException("Could not remove stale generated file: " + generated, e);
        }
    }

    private void cleanupSimulationScratchFiles(String fileName) {
        if (fileName == null || fileName.isBlank()) return;
        Path modelPath = Paths.get(fileName).toAbsolutePath().normalize();
        if (!modelPath.startsWith(ALLOY_SCRATCH_DIR)) return;

        String modelName = modelPath.getFileName().toString();
        Path generatedPath = modelName.endsWith(".als")
                ? modelPath.resolveSibling(
                        modelName.substring(0, modelName.length() - 4) + "-tmp.als")
                : null;
        deleteScratchFile(generatedPath);
        deleteScratchFile(modelPath);
    }

    private void deleteScratchFile(Path path) {
        if (path == null) return;
        try {
            java.nio.file.Files.deleteIfExists(path);
        } catch (java.io.IOException e) {
            System.err.println("[SessionServer] could not remove scratch file " + path + ": " + e.getMessage());
        }
    }

    /**
     * Compile Alloy code and run the last command. Used only as a temporary bridge for alternate
     * enumeration, because Dash+ Solution does not yet expose next().
     */
    private A4Solution executeA4Code(String fullCode) {
        System.setProperty("org.slf4j.simpleLogger.log.kodkod.engine.config", "warn");
        try {
            currentCompiled = AlloyInterface.parse(fullCode);
            List<Command> cmds = currentCompiled.getAllCommands();
            if (cmds.isEmpty()) {
                throw new RuntimeException("No commands generated");
            }
            Command cmd = cmds.get(cmds.size() - 1);
            return
                TranslateAlloyToKodkod.execute_command(
                        new A4Reporter(),
                        currentCompiled.getAllReachableSigs(),
                        cmd,
                        new A4Options());
        } catch (Exception e) {
            throw new RuntimeException("Could not execute Alloy alternate seed", e);
        }
    }

    private Solution toDashSolution(A4Solution solution) {
        if (solution == null || !solution.satisfiable()) {
            return Solution.UnsatSolution();
        }
        try {
            StringWriter sw = new StringWriter();
            PrintWriter pw = new PrintWriter(sw);
            solution.writeXML(pw, currentCompiled.getAllFunc(), Collections.emptyMap());
            pw.flush();
            java.io.PrintStream stdout = System.out;
            try {
                System.setOut(
                        new java.io.PrintStream(new java.io.ByteArrayOutputStream()));
                return Solution.SatSolution(new Instance(sw.toString()));
            } finally {
                System.setOut(stdout);
            }
        } catch (Exception e) {
            throw new RuntimeException("Could not convert Alloy solution to Dash+ instance", e);
        }
    }

    /** Build direct facts that constrain the web-app-owned current snapshot. */
    private String buildCurrentSnapshotFromOriginal() {
        return "fact {\n\t__initial[" + CURR_SNAPSHOT + "]\n}\n";
    }

    private String buildCurrentSnapshotFromFlatState(JsonObject state) {
        StringBuilder sb = new StringBuilder();
        sb.append("fact {\n");

        for (Map.Entry<String, JsonElement> entry : state.entrySet()) {
            String fieldName = entry.getKey();
            if (environmentInputFields.contains(fieldName)) {
                continue;
            }
            JsonArray values = entry.getValue().getAsJsonArray();
            int arity =
                    snapshotFieldDeclaredArities.getOrDefault(
                            fieldName,
                            fieldArities != null
                                            && fieldArities.containsKey(fieldName)
                                    ? fieldArities.get(fieldName)
                                    : 1);

            if (values.size() == 0) {
                sb.append("\t")
                        .append(CURR_SNAPSHOT)
                        .append(".")
                        .append(fieldName)
                        .append(" = ")
                        .append(getEmptyRelation(arity));
            } else {
                sb.append("\t").append(CURR_SNAPSHOT).append(".").append(fieldName).append(" = ");
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

    private Map<String, Integer> extractSnapshotFieldArities(String alloyCode) {
        Map<String, Integer> arities = new LinkedHashMap<>();
        if (alloyCode == null) {
            return arities;
        }
        Matcher sigMatcher =
                Pattern.compile("(?s)\\bsig\\s+__Snapshot\\s*\\{(.*?)\\}").matcher(alloyCode);
        if (!sigMatcher.find()) {
            return arities;
        }
        String body = sigMatcher.group(1);
        for (String rawLine : body.split("\\R")) {
            String line = rawLine.trim();
            if (line.isEmpty()) {
                continue;
            }
            if (line.endsWith(",")) {
                line = line.substring(0, line.length() - 1).trim();
            }
            int colon = line.indexOf(':');
            if (colon <= 0 || colon == line.length() - 1) {
                continue;
            }
            String fieldName = line.substring(0, colon).trim();
            String typeExpr = line.substring(colon + 1).trim();
            int arity = 1;
            Matcher arrowMatcher = Pattern.compile("->").matcher(typeExpr);
            while (arrowMatcher.find()) {
                arity++;
            }
            Matcher seqMatcher = Pattern.compile("\\bseq\\b").matcher(typeExpr);
            while (seqMatcher.find()) {
                arity++;
            }
            arities.put(fieldName, arity);
        }
        return Collections.unmodifiableMap(arities);
    }

    private Set<String> detectEnvironmentInputFields(DashModel model) {
        if (model == null) {
            return Collections.emptySet();
        }
        Set<String> fields = new java.util.LinkedHashSet<>();
        for (String varName : model.allVarNames()) {
            if (model.varKind(varName) != null && "ENV".equals(model.varKind(varName).name())) {
                fields.add(varName.replace('/', '_'));
            }
        }
        return Collections.unmodifiableSet(fields);
    }

    /**
     * Serialize the current Dash+ Solution instance into ordered snapshots with flat field maps.
     * This keeps instance reading behind Solution.instance instead of evaluating Alloy relations.
     *
     * <p>Returns: {satisfiable: true/false, snapshots: [{field: [values]}, ...]}
     */
    private JsonObject serializeSnapshots() {
        JsonObject data = new JsonObject();
        boolean satisfiable = currentSolution != null && currentSolution.isSat;
        data.addProperty("satisfiable", satisfiable);
        // Terminality of the snapshot the user would step to next. Carried into every response
        // (init, step, next, next-init) so the frontend can render trace ends as rectangles.
        data.addProperty("terminal", currentTerminal);

        if (!satisfiable) {
            return okResponse(data);
        }

        Instance instance = currentSolution.instance.get();
        Qname snapshotSig = null;
        for (Qname sig : instance.allSigQnames()) {
            if (!sig.isFieldQname()
                    && "this".equals(sig.nameSpace)
                    && "__Snapshot".equals(sig.name)) {
                snapshotSig = sig;
                break;
            }
        }
        if (snapshotSig == null) {
            data.addProperty("satisfiable", false);
            return okResponse(data);
        }

        List<String> snapshotAtoms = new ArrayList<>(instance.getAllSigValues(snapshotSig));
        snapshotAtoms.replaceAll(CommandRouter::normalizeInstanceAtom);
        snapshotAtoms.sort(java.util.Comparator.comparingInt(this::parseAtomIndex));
        snapshotAtoms = orderSnapshotAtomsByMarkers(instance, snapshotAtoms);
        int numSnapshots = snapshotAtoms.size();
        Map<String, Integer> snapshotIndexes = new LinkedHashMap<>();
        for (int i = 0; i < snapshotAtoms.size(); i++) {
            snapshotIndexes.put(snapshotAtoms.get(i), i);
        }

        // Initialize per-snapshot field maps (ordered by atom index)
        List<Map<String, List<String>>> snapshots = new ArrayList<>();
        for (int i = 0; i < numSnapshots; i++) {
            snapshots.add(new TreeMap<>());
        }

        // Compute and store field arities, then populate field maps
        fieldArities = new LinkedHashMap<>();
        List<String> fieldNames = new ArrayList<>();

        for (Qname field : instance.allFieldQnames()) {
            if (!"this".equals(field.nameSpace) || !"__Snapshot".equals(field.sigParent)) {
                continue;
            }
            String fieldName = field.name;
            Set<List<String>> tuples = normalizeTuples(instance.getAllFieldValues(field));
            int valueArity =
                    snapshotFieldDeclaredArities.getOrDefault(
                            fieldName,
                            tuples.stream()
                                    .findFirst()
                                    .map(t -> Math.max(1, t.size() - 1))
                                    .orElse(1));
            fieldArities.put(fieldName, valueArity);
            fieldNames.add(fieldName);

            // Initialize empty lists for all snapshots
            for (Map<String, List<String>> snap : snapshots) {
                snap.put(fieldName, new ArrayList<>());
            }

            // Populate from solution tuples
            for (List<String> tuple : tuples) {
                if (tuple.isEmpty()) continue;
                // First atom is the snapshot: e.g., "__Snapshot$0"
                String snapshotAtom = tuple.get(0);
                Integer snapIdx = snapshotIndexes.get(snapshotAtom);
                if (snapIdx == null) continue;
                if (snapIdx < 0 || snapIdx >= numSnapshots) continue;

                // Remaining atoms are the value, joined with ->
                // Strip $0 suffix from each Kodkod atom.
                StringBuilder valSb = new StringBuilder();
                for (int i = 1; i < tuple.size(); i++) {
                    if (i > 1) valSb.append("->");
                    valSb.append(stripAtomSuffix(tuple.get(i)));
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

    private List<String> orderSnapshotAtomsByMarkers(Instance instance, List<String> snapshotAtoms) {
        List<String> ordered = new ArrayList<>();
        addMarkerSnapshotAtom(instance, CURR_SNAPSHOT, snapshotAtoms, ordered);
        addMarkerSnapshotAtom(instance, NEXT_SNAPSHOT, snapshotAtoms, ordered);
        for (String atom : snapshotAtoms) {
            if (!ordered.contains(atom)) {
                ordered.add(atom);
            }
        }
        return ordered;
    }

    private void addMarkerSnapshotAtom(
            Instance instance, String markerName, List<String> snapshotAtoms, List<String> ordered) {
        Qname marker = Qname.nameSpaceQname("this", markerName);
        if (!instance.allSigQnames().contains(marker)) {
            return;
        }
        for (String atom : instance.getAllSigValues(marker)) {
            String normalized = normalizeInstanceAtom(atom);
            if (snapshotAtoms.contains(normalized) && !ordered.contains(normalized)) {
                ordered.add(normalized);
            }
        }
    }

    /**
     * Extract domain info from the current solver response through Kodkod's raw relation map
     * — the assumption-free path. The relation map (populated from the kodkod
     * Instance) is split by the snapshot rule: <b>dynamic</b> info is any relation living on the
     * {@code __Snapshot} sig or whose tuples lead with a {@code __Snapshot} atom; the
     * <b>static bucket</b> is everything else — domain atoms, ordering valuations, vocabulary
     * constants. Ordering pin facts for subsequent solves are derived from the bucket's {@code
     * <qualifier>/Ord.First} / {@code .Next} relations (skipping the trace orderings the wrapper
     * itself layers on).
     */
    private void extractDomainInfoFromSolution() {
        extractedDomainPins = null;
        extractedDomainPinFragments = Collections.emptyList();
        try {
            if (currentSolution == null || !currentSolution.isSat) return;
            Instance instance = currentSolution.instance.get();
            extractedDomainPinFragments = buildDomainPinFragments(instance);
            extractedDomainPins = renderFragments(extractedDomainPinFragments);
            if (!extractedDomainPins.isEmpty()) {
                System.err.println(
                        "[SessionServer] domain pins for subsequent solves:\n"
                                + extractedDomainPins);
            }
        } catch (Exception e) {
            System.err.println("[SessionServer] domain extraction failed: " + e.getMessage());
        }
    }

    private Set<List<String>> normalizeTuples(Set<List<String>> tuples) {
        Set<List<String>> set = new java.util.LinkedHashSet<>();
        for (List<String> tuple : tuples) {
            List<String> row = new ArrayList<>();
            for (String atom : tuple) {
                row.add(normalizeInstanceAtom(atom));
            }
            set.add(Collections.unmodifiableList(row));
        }
        return Collections.unmodifiableSet(set);
    }

    // Library modules and wrapper machinery whose relations are never domain info. boolean/Int/
    // seq are Alloy libraries; the model's __Snapshot alias is wrapper/trace machinery;
    // S/Time/loop are util/traces internals.
    private static final Set<String> NON_DOMAIN_QUALIFIERS =
            Set.of("boolean", "Int", "seq", "S", "__Snapshot");

    private static final Set<String> NON_DOMAIN_NAMES = Set.of("Time", "loop", "String", "univ");

    /**
     * Subtractive filter over the static bucket: rather than searching for known kinds of domain
     * info, remove everything that is provably NOT domain info and keep the rest. Dropped:
     *
     * <ul>
     *   <li>skolems ({@code $...}) — per-query solver witnesses, not model content;
     *   <li>bare kodkod atom duplicates ({@code PID_0$0}) — shadows of the {@code this/...} sig
     *       relations;
     *   <li>library / wrapper relations by qualifier or name (boolean, Int, seq, util/traces
     *       internals, the wrapper's trace orderings);
     *   <li>translator infrastructure ({@code this/__...}, e.g. __Ids — its value is forced by a
     *       generated fact);
     *   <li>{@code *_remainder} partitions — empty by construction when concrete atoms cover the
     *       scope;
     *   <li>self-denoting singletons — a unary relation whose only tuple is its own atom
     *       ({@code this/PID_0 = {PID_0}}, states, transitions, events): their values are forced
     *       by their declarations, so there is nothing the solver chose that needs pinning.
     * </ul>
     *
     * What survives is exactly the static info the solver was free to choose: ordering
     * valuations ({@code Q/Ord.First/.Next}) today; static domain-sig fields and user subset
     * sigs in future models.
     */
    private boolean isStaticDomainField(Qname field, Set<List<String>> tuples) {
        if (!field.isFieldQname()) return false;
        if ("this".equals(field.nameSpace) && "__Snapshot".equals(field.sigParent)) return false;
        if (!tuples.isEmpty() && tuples.iterator().next().get(0).startsWith("__Snapshot$")) {
            return false;
        }
        if (field.nameSpace.startsWith("$") || field.nameSpace.contains("$")) return false;
        if (field.sigParent.startsWith("$") || field.sigParent.contains("$")) return false;
        if (field.name.startsWith("$") || field.name.contains("$")) return false;
        if (NON_DOMAIN_QUALIFIERS.contains(field.nameSpace)) return false;
        if (NON_DOMAIN_QUALIFIERS.contains(field.sigParent)) return false;
        if (NON_DOMAIN_NAMES.contains(field.nameSpace)) return false;
        if (NON_DOMAIN_NAMES.contains(field.sigParent)) return false;
        if (NON_DOMAIN_NAMES.contains(field.name)) return false;
        if ("this".equals(field.nameSpace) && field.sigParent.startsWith("__")) return false;
        return !field.name.endsWith("_remainder");
    }

    /**
     * Render kept instance fields as pin facts. Ordering module fields are referenced through
     * derived functions ({@code Q/first}, {@code Q/next}); model static fields are referenced with
     * domain restriction ({@code Sig <: field}).
     */
    private List<GeneratedAlloyFragment> buildDomainPinFragments(Instance instance) {
        List<Qname> fields = new ArrayList<>(instance.allFieldQnames());
        fields.sort(java.util.Comparator.comparing(this::fieldSortKey));
        List<String> kept = new ArrayList<>();
        List<GeneratedAlloyFragment> fragments = new ArrayList<>();

        for (Qname field : fields) {
            Set<List<String>> tuples = normalizeTuples(instance.getAllFieldValues(field));
            if (!isStaticDomainField(field, tuples)) continue;
            String ref;
            int keepCols; // how many trailing columns of each tuple carry the value
            if ("Ord".equals(field.sigParent) && "First".equals(field.name)) {
                ref = field.nameSpace + "/first";
                keepCols = 1;
            } else if ("Ord".equals(field.sigParent) && "Next".equals(field.name)) {
                ref = field.nameSpace + "/next";
                keepCols = 2;
            } else if ("this".equals(field.nameSpace)) {
                ref = field.sigParent + " <: " + field.name;
                keepCols = Integer.MAX_VALUE; // full tuples: owner + value columns
            } else {
                System.err.println("[SessionServer] unrecognized domain field, not pinned: " + field);
                continue;
            }

            if (tuples.isEmpty()) {
                // Arity is unknown for an empty field at this level; skip rather than guess.
                System.err.println("[SessionServer] empty domain field, not pinned: " + field);
                continue;
            }

            List<String> rendered = new ArrayList<>();
            for (List<String> t : tuples) {
                int from = Math.max(0, t.size() - Math.min(keepCols, t.size()));
                StringBuilder tup = new StringBuilder();
                for (int i = from; i < t.size(); i++) {
                    if (i > from) tup.append("->");
                    tup.append(stripAtomSuffix(t.get(i)));
                }
                rendered.add(tup.toString());
            }
            Collections.sort(rendered); // deterministic fact text

            StringBuilder fact = new StringBuilder();
            fact.append("fact { ").append(ref).append(" = ");
            for (int i = 0; i < rendered.size(); i++) {
                if (i > 0) fact.append(" + ");
                fact.append(rendered.get(i));
            }
            fact.append(" }");
            fragments.add(parseGeneratedParagraph(fact.toString()));
            kept.add(fieldSortKey(field));
        }
        System.err.println("[SessionServer] domain info kept from init response: " + kept);
        return Collections.unmodifiableList(fragments);
    }

    private String fieldSortKey(Qname field) {
        return field.nameSpace + "/" + field.sigParent + "." + field.name;
    }

    /** "PID_0$0" → "PID_0" (kodkod atom names carry a $N suffix). */
    private static String stripAtomSuffix(String atom) {
        atom = normalizeInstanceAtom(atom);
        int i = atom.lastIndexOf('$');
        return i < 0 ? atom : atom.substring(0, i);
    }

    private static String normalizeInstanceAtom(String atom) {
        return atom == null ? "" : atom.replace('\u0283', '$');
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

    // ── Debug: dump every .als sent to the solver, numbered + named by phase ──
    private int dumpCounter = 0;
    private static final String DUMP_DIR =
            System.getProperty(
                    "dash.dumpDir", System.getProperty("java.io.tmpdir") + "/als-compare");

    /**
     * Write a copy of the Alloy code sent to the solver into the compare dir, named
     * webapp-NN-phase.als (NN = global call order on this CommandRouter), so generated simulation
     * paragraphs can be inspected or compared across runs.
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
        currentSigScopes = null;
        fieldArities = null;
        currentA4Solution = null;
        currentA4SeedCode = null;
        initA4SeedCode = null;
        currentCompiled = null;
        initA4Solution = null;
        currentSolution = null;
        currentTerminal = false;
        extractedDomainPins = null;
        extractedDomainPinFragments = Collections.emptyList();
        lastSimulationModule = null;
    }

    // ──────────────────────────────────────────────────────────────
    // Utility methods (kept from original)
    // ──────────────────────────────────────────────────────────────

    /**
     * Generate concrete subsig declarations for scoped sigs. For each scoped sig with N atoms,
     * generates named subsigs: one sig Floor_0, Floor_1, Floor_2 extends Floor {}
     */
    private List<GeneratedAlloyFragment> getConcreteSigFragments(Map<String, Integer> sigScopes) {
        if (sigScopes == null) {
            return Collections.emptyList();
        }
        List<GeneratedAlloyFragment> fragments = new ArrayList<>();
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
            fragments.add(
                    parseGeneratedParagraph(
                            "one sig " + names + " extends " + sigName + " {}"));
        }
        return Collections.unmodifiableList(fragments);
    }

    private String renderFragments(List<GeneratedAlloyFragment> fragments) {
        StringBuilder sb = new StringBuilder();
        for (GeneratedAlloyFragment fragment : fragments) {
            sb.append(fragment.source).append("\n");
        }
        return sb.toString();
    }

    private GeneratedAlloyFragment parseGeneratedParagraph(String source) {
        try {
            AlloyPara para = AlloyParser.parsePara(source);
            return new GeneratedAlloyFragment(source, para);
        } catch (Exception e) {
            throw new RuntimeException("Generated Alloy paragraph did not parse: " + source, e);
        }
    }

    /** Extract sig scopes from params as a Java Map. */
    /**
     * Extract constraint predicates from the request params. The frontend sends them as a JSON
     * array of Alloy expression strings, e.g. ["SnapshotUI_login in __webapp_events[s]",
     * "SnapshotUI_t1 in __webapp_taken[s]"]. Each expression is ready to place in a predicate
     * whose snapshot parameter is named {@code s}.
     */
    private List<String> extractConstraints(JsonObject params) {
        List<String> result = new ArrayList<>();
        if (params != null && params.has("constraints")) {
            JsonArray arr = params.getAsJsonArray("constraints");
            for (JsonElement el : arr) {
                String c = el.getAsString().trim();
                if (!c.isEmpty()) {
                    result.add(c);
                }
            }
        }
        return result;
    }

    /** Extract the full transition tuples already taken from the current start node (Alt Trans). */
    private List<String> extractExcludeTransitions(JsonObject params) {
        List<String> result = new ArrayList<>();
        if (params != null && params.has("excludeTransitions")) {
            JsonArray arr = params.getAsJsonArray("excludeTransitions");
            for (JsonElement el : arr) {
                List<String> atoms = new ArrayList<>();
                for (String rawAtom : el.getAsString().trim().split("\\s*->\\s*")) {
                    String atom = stripAtomSuffix(rawAtom.trim());
                    if (atom.startsWith("this/")) {
                        atom = atom.substring("this/".length());
                    }
                    if (!atom.isEmpty()) {
                        atoms.add(atom);
                    }
                }
                String transition = String.join("->", atoms);
                if (!transition.isEmpty() && !result.contains(transition)) {
                    result.add(transition);
                }
            }
        }
        return result;
    }

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
                        "(?m)^\\s*(?:(abstract|one|lone|some|private)\\s+)*sig\\s+"
                                + "([A-Za-z_][A-Za-z0-9_]*(?:\\s*,\\s*[A-Za-z_][A-Za-z0-9_]*)*)"
                                + "(?:\\s+(?:extends|in)\\s+([A-Za-z_][A-Za-z0-9_]*))?"
                                + "\\s*\\{");
        Matcher m = sigPat.matcher(alloyCode);
        while (m.find()) {
            String modifier = m.group(1);
            String names = m.group(2);
            String parentOrIn = m.group(3);
            for (String sigName : names.split("\\s*,\\s*")) {
                declared.add(sigName);
                if (modifier == null && parentOrIn == null && !sigName.startsWith("__")) {
                    needScope.add(sigName);
                }
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
                Pattern.compile(
                        "(?m)^\\s*(?:(?:abstract|one|lone|some|private)\\s+)*sig\\s+"
                                + "([A-Za-z_][A-Za-z0-9_]*(?:\\s*,\\s*[A-Za-z_][A-Za-z0-9_]*)*)"
                                + "(?:\\s+(?:extends|in)\\s+[A-Za-z_][A-Za-z0-9_]*)?"
                                + "\\s*\\{");
        Matcher declMatcher = sigDecl.matcher(alloyCode);
        while (declMatcher.find()) {
            for (String sigName : declMatcher.group(1).split("\\s*,\\s*")) {
                declaredSigs.add(sigName);
            }
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

    /**
     * Prepare Dash+'s translated Alloy for the web app's interactive simulation wrapper. Current
     * Dash+ emits {@code __traces_fact} as a predicate plus a separate command, so the predicate can
     * stay in the model; interactive solves execute the web-app-added command instead.
     */
    private String prepareTranslatedAlloyForSimulation(String alloyCode) {
        return injectMissingParamSigs(alloyCode);
    }

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
