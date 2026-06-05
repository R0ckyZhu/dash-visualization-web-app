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

## Getting Started

### 1. Build the JAR

```sh
cd dashplus
./gradlew sessionServerJar
```

On Windows cmd, use `gradlew sessionServerJar` (no `./`).

### 2. Install the backend

```sh
cd backend
pip install .
```

### 3. Run the backend

```sh
cd backend
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

### 4. Open the app

Go to [http://localhost:8000](http://localhost:8000) in your browser.

## Bundled Examples

The `backend/examples/` directory contains 26+ case-study models from academic papers and theses, including elevators, bit counters, distributed spanning trees, landing gear systems, and digital watches.
