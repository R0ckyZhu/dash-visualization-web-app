# dashplus-session-server

The Dash Visualizer session server. Contains only the sources this project adds
on top of the Dash+ engine:

- `SessionServer.java` — stdin/stdout JSON command loop
- `CommandRouter.java` — simulation / init / step / alt-trans logic
- `DashModelSerializer.java` — DashModel → JSON

The engine itself is the prebuilt `libs/dashplus.jar`; the dashplus source tree
is not part of this repository. See `libs/README.md` for that jar's provenance
and how to refresh it.

## Build

```bash
./gradlew sessionServerJar
# -> build/libs/dashplus-session-server.jar
```

A few seconds — three files compile and are merged with the engine jar into one
runnable jar. The backend (`backend/app/main.py`) launches that jar by default;
override the path with the `DASHPLUS_JAR` environment variable.

To run the server directly against stdin without building the jar:

```bash
./gradlew sessionServer
```
