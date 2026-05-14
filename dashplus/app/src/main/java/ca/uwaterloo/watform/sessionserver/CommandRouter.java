package ca.uwaterloo.watform.sessionserver;

import ca.uwaterloo.watform.alloyast.paragraph.command.AlloyCmdPara;
import ca.uwaterloo.watform.alloyinterface.AlloyInterface;
import ca.uwaterloo.watform.alloyinterface.Solution;
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
import edu.mit.csail.sdg.parser.CompModule;
import edu.mit.csail.sdg.translator.A4Options;
import edu.mit.csail.sdg.translator.A4Solution;
import edu.mit.csail.sdg.translator.TranslateAlloyToKodkod;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class CommandRouter {

    private DashModel currentModel;
    private AlloyModel currentAlloyModel;
    private Solution currentSolution;

    public JsonObject dispatch(String command, JsonObject params) {
        try {
            return switch (command) {
                case "ping" -> okResponse(new JsonObject());
                case "load" -> handleLoad(params);
                case "translate" -> handleTranslate(params);
                case "execute" -> handleExecute(params);
                case "next" -> handleNext();
                case "step" -> handleStep(params);
                case "init" -> handleInit();
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
        currentSolution = null;

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
        currentSolution = null;

        int cmdCount = currentAlloyModel.getParas(AlloyCmdPara.class).size();
        JsonObject data = new JsonObject();
        data.addProperty("commandCount", cmdCount);
        data.addProperty("alloyCode", currentAlloyModel.toString());
        return okResponse(data);
    }

    private JsonObject handleExecute(JsonObject params) {
        if (currentAlloyModel == null) {
            return errorResponse("No translated model. Call translate first.");
        }

        int cmdIdx = -1;
        if (params != null && params.has("cmdIdx")) {
            cmdIdx = params.get("cmdIdx").getAsInt();
        }

        currentSolution = AlloyInterface.executeCommand(currentAlloyModel, cmdIdx);

        return serializeSolution();
    }

    private JsonObject handleNext() {
        if (currentSolution == null) {
            return errorResponse("No current solution. Call execute first.");
        }
        if (!currentSolution.isSat()) {
            JsonObject data = new JsonObject();
            data.addProperty("satisfiable", false);
            return okResponse(data);
        }
        currentSolution.next();
        return serializeSolution();
    }

    private JsonObject handleInit() {
        if (currentAlloyModel == null) {
            return errorResponse("No translated model. Call translate first.");
        }

        // Run the model with exactly 1 __Snapshot to get just the initial state
        String alloyCode = currentAlloyModel.toString();
        String fullCode = alloyCode + "\nrun {} for exactly 1 __Snapshot\n";
        try {
            System.setProperty("org.slf4j.simpleLogger.log.kodkod.engine.config", "warn");
            CompModule compiled = AlloyInterface.parse(fullCode);
            List<Command> cmds = compiled.getAllCommands();
            if (cmds.isEmpty()) {
                return errorResponse("No commands generated");
            }
            Command cmd = cmds.get(cmds.size() - 1);
            A4Solution ans =
                    TranslateAlloyToKodkod.execute_command(
                            new A4Reporter(), compiled.getAllReachableSigs(), cmd, new A4Options());
            if (!ans.satisfiable()) {
                return errorResponse("Initial state is unsatisfiable");
            }
            currentSolution = new Solution(ans, compiled);
            return serializeSolution();
        } catch (Exception e) {
            return errorResponse("Init error: " + e.getMessage());
        }
    }

    private JsonObject handleStep(JsonObject params) {
        if (currentAlloyModel == null) {
            return errorResponse("No translated model. Call translate first.");
        }
        if (params == null || !params.has("initState")) {
            return errorResponse("Missing initState parameter");
        }

        JsonObject initState = params.getAsJsonObject("initState");
        int maxScope = params.has("maxScope") ? params.get("maxScope").getAsInt() : 10;

        // Get the translated Alloy code
        String alloyCode = currentAlloyModel.toString();

        // Build a custom init predicate from the given state
        String customInit = buildInitPredicate(initState);

        // Replace the existing __initial predicate in the code
        String modifiedCode = replaceInitPredicate(alloyCode, customInit);

        // Try with increasing scope until SAT or maxScope reached
        for (int scope = 2; scope <= maxScope; scope++) {
            String fullCode = modifiedCode + "\nrun {} for exactly " + scope + " __Snapshot\n";
            try {
                System.setProperty("org.slf4j.simpleLogger.log.kodkod.engine.config", "warn");
                CompModule compiled = AlloyInterface.parse(fullCode);
                List<Command> cmds = compiled.getAllCommands();
                if (cmds.isEmpty()) continue;
                Command cmd = cmds.get(cmds.size() - 1);
                A4Solution ans =
                        TranslateAlloyToKodkod.execute_command(
                                new A4Reporter(),
                                compiled.getAllReachableSigs(),
                                cmd,
                                new A4Options());
                if (ans.satisfiable()) {
                    currentSolution = new Solution(ans, compiled);
                    return serializeSolution();
                }
            } catch (Exception e) {
                // Try next scope
                continue;
            }
        }

        // No satisfiable solution found
        JsonObject data = new JsonObject();
        data.addProperty("satisfiable", false);
        return okResponse(data);
    }

    /**
     * Build a pred __initial[s: __Snapshot] from the given state configuration. initState should
     * contain: - conf: array of active state Dash IDs (e.g. ["Mutex/Process1/Wait", ...]) - vars:
     * object mapping Alloy field names to values (e.g. {"Mutex_semaphore_free": "False"}) - stable:
     * boolean
     */
    private String buildInitPredicate(JsonObject initState) {
        StringBuilder sb = new StringBuilder();
        sb.append("pred __initial[s: one __Snapshot] {\n");

        // Set active states (__conf0)
        if (initState.has("conf")) {
            JsonArray conf = initState.getAsJsonArray("conf");
            StringBuilder confSb = new StringBuilder();
            for (int i = 0; i < conf.size(); i++) {
                if (i > 0) confSb.append(" + ");
                // Convert Dash ID to Alloy atom: Mutex/Process1/Wait → Mutex_Process1_Wait
                confSb.append(conf.get(i).getAsString().replace("/", "_"));
            }
            if (confSb.length() > 0) {
                sb.append("  s.__conf0 = ").append(confSb).append("\n");
            } else {
                sb.append("  no s.__conf0\n");
            }
        }

        // Set stable flag
        if (initState.has("stable")) {
            boolean stable = initState.get("stable").getAsBoolean();
            sb.append("  s.__stable = ")
                    .append(stable ? "boolean/True" : "boolean/False")
                    .append("\n");
        }

        // Set taken transitions to none (clean start)
        sb.append("  no s.__taken0\n");
        sb.append("  no s.__sc_used0\n");

        // Set variable values
        if (initState.has("vars")) {
            JsonObject vars = initState.getAsJsonObject("vars");
            for (Map.Entry<String, JsonElement> entry : vars.entrySet()) {
                String fieldName = entry.getKey();
                String value = entry.getValue().getAsString();
                // Map boolean string values to Alloy boolean atoms
                if (value.equals("true")) value = "boolean/True";
                else if (value.equals("false")) value = "boolean/False";
                sb.append("  s.").append(fieldName).append(" = ").append(value).append("\n");
            }
        }

        sb.append("}\n");
        return sb.toString();
    }

    /** Replace the existing pred __initial[...] { ... } in the Alloy code with a new one. */
    private String replaceInitPredicate(String alloyCode, String newInit) {
        // Find pred __initial and its body using brace counting
        Pattern p = Pattern.compile("pred\\s+__initial\\s*\\[");
        Matcher m = p.matcher(alloyCode);
        if (!m.find()) {
            // If no __initial pred found, just append it
            return alloyCode + "\n" + newInit;
        }

        int predStart = m.start();
        // Find the matching closing brace
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

    private JsonObject serializeSolution() {
        JsonObject data = new JsonObject();
        data.addProperty("satisfiable", currentSolution.isSat());

        if (currentSolution.isSat()) {
            JsonObject relations = new JsonObject();
            Set<String> keys = currentSolution.getSolnMapKeys();
            for (String key : keys) {
                Set<List<String>> tuples = currentSolution.get(key);
                com.google.gson.JsonArray tuplesArr = new com.google.gson.JsonArray();
                for (List<String> tuple : tuples) {
                    com.google.gson.JsonArray tupleArr = new com.google.gson.JsonArray();
                    for (String atom : tuple) {
                        tupleArr.add(atom);
                    }
                    tuplesArr.add(tupleArr);
                }
                relations.add(key, tuplesArr);
            }
            data.add("relations", relations);
        }

        return okResponse(data);
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
