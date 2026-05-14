package ca.uwaterloo.watform.sessionserver;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;

public class SessionServer {

    public static void main(String[] args) {
        PrintStream protocolOut = System.out;
        System.setOut(System.err);

        CommandRouter router = new CommandRouter();

        JsonObject ready = new JsonObject();
        ready.addProperty("status", "ready");
        protocolOut.println(ready);
        protocolOut.flush();

        try (BufferedReader reader = new BufferedReader(new InputStreamReader(System.in))) {
            String line;
            while ((line = reader.readLine()) != null) {
                line = line.trim();
                if (line.isEmpty()) continue;

                JsonObject request;
                try {
                    request = JsonParser.parseString(line).getAsJsonObject();
                } catch (Exception e) {
                    JsonObject err = new JsonObject();
                    err.addProperty("status", "error");
                    err.addProperty("error", "Invalid JSON: " + e.getMessage());
                    protocolOut.println(err);
                    protocolOut.flush();
                    continue;
                }

                String id = request.has("id") ? request.get("id").getAsString() : null;
                String command = request.has("command") ? request.get("command").getAsString() : "";
                JsonObject params =
                        request.has("params") ? request.getAsJsonObject("params") : null;

                if ("quit".equals(command)) {
                    JsonObject resp = new JsonObject();
                    if (id != null) resp.addProperty("id", id);
                    resp.addProperty("status", "ok");
                    protocolOut.println(resp);
                    protocolOut.flush();
                    break;
                }

                JsonObject response = router.dispatch(command, params);
                if (id != null) response.addProperty("id", id);
                protocolOut.println(response);
                protocolOut.flush();
            }
        } catch (Exception e) {
            System.err.println("SessionServer fatal error: " + e.getMessage());
            e.printStackTrace();
        }
    }
}
