# Dash Visualizer

A web-based tool for visualizing and interactively simulating [Dash](https://github.com/WatForm/dash-models) statechart models. Load a `.dsh` model, and step through its state space using the Alloy constraint solver — inspecting states, transitions, and variable values at each snapshot.

## Architecture

```
frontend/        Vanilla HTML/JS UI using Cytoscape.js for graph rendering
backend/         Python FastAPI server exposing a REST API
dashplus/        Java engine that parses .dsh files, translates to Alloy, and runs the solver
```

The backend spawns the `dashplus` JAR as a long-lived subprocess and communicates via JSON over stdio. The frontend talks to the backend's REST API and renders two side-by-side graphs: a hierarchical statechart and a trace tree.

## Prerequisites

- Java >= 25
- Python >= 3.11

## Build

### 1. Build the Java engine

```sh
cd dashplus
./gradlew sessionServerJar
```

This produces `dashplus/app/build/libs/dashplus-session-server.jar`. Gradle 9.1.0 is downloaded automatically by the wrapper.

On Windows cmd, use `gradlew sessionServerJar` (no `./`).

### 2. Install the Python backend

```sh
cd backend
pip install .
```

## Run

```sh
cd backend
dash-viz
```

The server starts at `http://127.0.0.1:8000` and serves both the API and the frontend.

To point at a custom JAR location, set the `DASHPLUS_JAR` environment variable:

```sh
DASHPLUS_JAR=/path/to/dashplus-session-server.jar dash-viz
```

## Usage

1. Open `http://127.0.0.1:8000` in a browser.
2. Enter a path to a `.dsh` file or pick one from the bundled examples (elevator, traffic light, mutex, leader election, etc.).
3. Click **Simulate** to find a valid initial state.
4. Click **Step** to advance the simulation, or **Alt** to explore alternative solutions.

## Bundled Examples

The `backend/examples/` directory contains 26+ case-study models from academic papers and theses, including elevators, bit counters, distributed spanning trees, landing gear systems, and digital watches.
