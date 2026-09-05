# Dash Visualizer

Dash Visualizer is a local web application for loading, inspecting, and
interactively simulating Dash statechart models. The active UI is written in
React and TypeScript, FastAPI owns the browser API and session context, and a
Java session server runs the Dash+/Alloy parser, translator, and solver.

## Features

- Load a built-in case study or a local `.dsh` model.
- Configure scopes for parameterized models.
- Initialize a simulation and explore it with Step, Alt, Alt Init, and Alt Trans.
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

`sessionserver/libs/dashplus.jar` is the prebuilt Dash+ engine. Its provenance
and refresh process are documented in `sessionserver/libs/README.md`.

## Prerequisites

- Java 25
- Python 3.11 or newer, already on `PATH`

## Setup

Run from the repository root:

### 1. Build the Java session server

```powershell
cd sessionserver
.\gradlew.bat sessionServerJar
cd ..
```

On macOS or Linux, use `./gradlew sessionServerJar`. The runnable JAR is written
to `sessionserver/build/libs/dashplus-session-server.jar`.

### 2. Install the Python backend

```powershell
python -m pip install -e backend
```

### 3. Run the server

```powershell
python -m app.main
```

Open `http://127.0.0.1:8000`. 

To use a different port, set `DASH_PORT` before starting:

```powershell
$env:DASH_PORT = "8010"
python -m app.main
```

## Simulation Notes

The Simulate menu supports two modes:

- `simplified` forces a transition to take place between each step.
- `raw` returns any snapshot allowed by the active model and constraints.




