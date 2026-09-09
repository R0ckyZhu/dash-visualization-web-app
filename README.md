# Dash Visualizer

Dash Visualizer is a local web application for loading, inspecting, and
interactively simulating Dash statechart models. The active UI is written in
React and TypeScript, FastAPI owns the browser API and session context, and a
Java session server runs the Dash+/Alloy parser, translator, and solver.

## Features

- Load a built-in case study or a local `.dsh` model.
- Configure scopes for parameterized models.
- Start a simulation and explore it with Step and the Alternatives menu.
- Apply state, event, variable, transition, and custom Alloy constraints.
- Inspect hierarchical statecharts, active-state overlays, and parallel edges.
- Navigate a persistent state tree with stability coloring and selection details.
- Compare events and variables across the current trace.
- Inspect Dash source, translated Alloy, and generated solver fragments.
- Ask a LLM assistant about the active model and simulation session.

## Architecture

```text
Browser
  React + TypeScript + Vite
  Cytoscape.js + ELK graph layout
        |
        | JSON REST + streamed SSE chat
        v
FastAPI backend
  SessionManager       model and solver operations
  SessionContextStore  revisioned model, trace, tree, and UI context
  LLMService           read-only tools and provider-neutral orchestration
        |
        | JSON over stdin/stdout
        v
Java session server
        |
        v
Dash+ parser/translator + Alloy solver
```

## Repository Layout

```text
backend/          FastAPI application, LLM layer, tests, and example models
frontend/         React application and its committed production bundle
sessionserver/    Java JSON session server and Gradle wrapper
```

`sessionserver/libs/dashplus.jar` is the prebuilt Dash+ engine.

## Prerequisites

- Java **JDK 25**, available on `PATH` (needed to build the session server).
- Python **3.11 or newer**, available on `PATH`.
- A web browser.

The compiled frontend is included in this repository. Node.js and a frontend
build are not required to install and run the app.

## Setup

Open a terminal and change to the repository root (the directory containing
`backend`, `frontend`, and `sessionserver`). Use the commands for your operating
system below; the macOS/Linux examples use bash or zsh, while the Windows
examples use PowerShell.

### 1. Build the Java session server

**macOS / Linux:**

```bash
cd sessionserver
./gradlew sessionServerJar
cd ..
```

If an older checkout reports `Permission denied`, run `chmod +x gradlew` inside
`sessionserver` and retry. The wrapper is executable in current checkouts.

**Windows (PowerShell):**

```powershell
cd sessionserver
.\gradlew.bat sessionServerJar
cd ..
```

The runnable JAR is written to
`sessionserver/build/libs/dashplus-session-server.jar`.

### 2. Create a Python virtual environment and install the backend

Use a virtual environment, including when using Homebrew Python, to keep the
app's packages separate from the Python installation managed by your system.
See the [Python virtual environment documentation](https://docs.python.org/3/library/venv.html)
for details.

Run these commands from the repository root.

**macOS / Linux:**

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e backend
```

**Windows (PowerShell):**

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e backend
```

If PowerShell blocks activation, you can use the environment's Python directly,
without changing the execution policy:

```powershell
.\.venv\Scripts\python.exe -m pip install -e backend
.\.venv\Scripts\python.exe -m app.main
```

The `.venv` directory is local to your machine and is excluded from Git.

### 3. Start the server and open the app

With the virtual environment activated, run this command from the repository
root on either platform:

```text
python -m app.main
```

Keep this terminal running. **Open [http://127.0.0.1:8000](http://127.0.0.1:8000)
in a web browser** to use Dash Visualizer. The server does not open a browser
automatically. Press `Ctrl+C` in the terminal to stop it.

If you open a new terminal later, activate the existing environment again before
starting the server; you do not need to recreate it or reinstall the backend.
Use `source .venv/bin/activate` on macOS/Linux or
`.\.venv\Scripts\Activate.ps1` in Windows PowerShell.

### Optional: use a different port

**macOS / Linux:**

```bash
DASH_PORT=8010 python -m app.main
```

**Windows (PowerShell):**

```powershell
$env:DASH_PORT = "8010"
python -m app.main
```

Then open [http://127.0.0.1:8010](http://127.0.0.1:8010) in your web browser.

## Simulation Notes

Open a model, review its scopes if prompted, and choose **Start simulation**.
Use **Step** to advance from the selected snapshot, and **Alternatives** to
explore another initial state, transition, or successor snapshot.

The **Mode** selector supports two modes:

- `simplified` forces a transition to take place between each step.
- `raw` returns any snapshot allowed by the active model and constraints.

Unexpected Counter behavior has been reported and is awaiting a reproducible
walkthrough. The existing smoke tests do not establish that every model,
translation, or displayed trace is semantically correct.
