# Dash Visualizer — Frontend Redesign

Status: **design proposal** · Date: 2026-06-04

Sterling supplied the *shell idea* (a fixed top toolbar + tabbed views), but this tool is
narrower: no styling, no evaluator, no scripting. So we drop Sterling's left icon rail
entirely and use **three top-level tabs**. Paired with `mockup.html` (static visual, no behavior).

---

## 1. Views (top menu)

| Tab | Content |
|---|---|
| **Simulation** | The **control-states graph** (hierarchical statechart) and the **state tree** placed **side by side**, as in the original `index.html`. Stepping controls + trace timeline. |
| **Events & Variables** | Per-snapshot **tables** of events and variable values across the trace. |
| **Model Source** | The raw **`.dsh`** source and the translated **`.als`** Alloy model. |

No left icon rail. No node/edge styling, projection, layout, or evaluator panels —
the tool doesn't support those, so the rail would be empty chrome.

---

## 2. Stack

Per earlier decision: **introduce a framework.**

- **React 18 + TypeScript + Vite.** Vite's static build slots into the existing FastAPI
  `StaticFiles` mount (build → `frontend/dist`, repoint the mount).
- **State:** Zustand — maps onto today's flat `appState` + module globals
  (`stateGraph`, `traceState`, `tracePath`, `currentSigScopes`, …) almost 1:1.
- **Graph:** keep **Cytoscape** (+ `elk`, `fcose`) for *both* graphs. Each lives in a thin
  React wrapper that owns its `cytoscape()` instance in a `ref`. The existing
  `renderGraph` / `deterministicLayout` / `renderTraceGraph` / `StateGraph` / `parseSolution`
  logic ports over as **pure functions**, not a rewrite.

### Project shape

```
frontend/
  design/            ← this doc + mockup (no build)
  src/
    main.tsx · App.tsx
    store/           ← Zustand slices: model, sim, ui
    api/             ← typed wrappers for the FastAPI endpoints
    components/
      shell/         ← TopToolbar, ViewTabs, RunPill, StepControls, OpenMenu
      simulation/    ← ControlStatesGraph, StateTreeGraph, Timeline, DetailPanel, SolverInfoPopup
      tables/        ← EventsTable, VariablesTable
      source/        ← ModelSource (.dsh / .als panes)
      modals/        ← ScopeDialog
    cy/              ← ported pure logic (modelToCytoscape, deterministicLayout,
                       expandParameterizedModel, parseSolution, StateGraph, …)
  index.html         ← legacy, kept until parity, then removed
  vite.config.ts · package.json
```

---

## 3. Top toolbar

Left → right:

1. **Wordmark** — "DashViz" (placeholder; see open questions).
2. **View tabs** — `Simulation` · `Events & Variables` · `Model Source`.
3. **Run pill** (center, once loaded) — model + active scopes, e.g.
   `Elevator · PID=2, Floor=4`; click reopens the Scope dialog.
4. **Step controls** — `Simulate` · `Alt Init` · `Step` · `Alt` (grouped, the green "sim"
   styling). Drives the Simulation view; enabled/disabled per sim state, as today.
5. **Open split-button** (green, caret) — `Open .dsh…` (paste/pick a path) + an
   **Examples** section listing **all case-study `.dsh` files**, grouped by collection
   (2019 dash-website, 2022 bandali-thesis, 2022 tamjid-thesis, 2023 bandali-day-paper —
   26 models in total). The list is scrollable. It's populated by a small backend
   `/api/examples` endpoint that scans the case-studies directory and returns
   `[{ group, name, path }]`; selecting one sends its path to `/api/inspect`.

Status text moves from the toolbar to a thin **status strip** at the bottom of the
Simulation view.

---

## 4. Simulation view (primary)

Layout faithful to the original `index.html` — the two graphs **side by side**:

```
┌──────────────────────────────┬───────────────────┐
│  CONTROL-STATES GRAPH        │   STATE TREE       │
│  (#cy — hierarchical chart)  │   (#trace-cy)      │
│                      flex:1  │   ~300px           │
├──────────────────────────────┴───────────────────┤
│  TRACE TIMELINE   S1 → S2 → S3 …   (info row)     │
└───────────────────────────────────────────────────┘
```

- **Control-states graph** (left, `flex:1`): ported `renderGraph` + deterministic/ELK
  layout + constrained dragging + trace highlighting classes.
- **State tree** (right, ~300px): ported `renderTraceGraph` / `StateGraph` / `StateNode`.
  Click node → highlight that configuration in the chart; click edge → highlight target
  via that transition; right-click → **solver-info popup**.
- **Timeline** (bottom): linear trace chips `S1 → S2 → …` with transition labels +
  the `Transition / Stable / Variables` info row.
- **Detail panel:** clicking a state/transition in the chart shows its fields. To keep
  the two graphs side by side, it **slides in from the left** as an overlay over the
  control-states graph, rather than a permanent column.
- **Cross-highlight:** selecting a state node (either graph) drives the highlight in the
  other — the store holds `currentStateNodeId`; both wrappers subscribe.

Stepping (`Simulate / Alt Init / Step / Alt`) and the Scope dialog work exactly as today,
moved into the `sim` store slice. **No backend changes needed** —
`/api/inspect|init|step|solution/next|solution/next-init` already cover it.

---

## 5. Events & Variables view

Tabular, per snapshot in the current trace:

- **Variables table** — rows = variables (incl. parameterized, e.g. `direction[PID_0]`),
  columns = trace steps `S1 … Sn`; cells = formatted values (reusing `formatVarValue`).
  The data already exists in parsed snapshots — no new endpoint.
- **Events table** — transitions taken per step (the `takenTransition` / `on` event),
  plus the model's declared events. The `/api/tables` endpoint (`tables` bridge command)
  is available if we want the solver's raw relational tables too.

Clicking a column header (a step) selects that step → cross-highlights the Simulation graphs.

---

## 6. Model Source view

Read-only text, two panes (or a toggle):

- **`.dsh`** — the loaded Dash source. Needs a tiny backend endpoint to return the file
  text (the server has `current_file`; the browser can't read local disk).
- **`.als`** — the translated Alloy model. `translate` already runs during `inspect`;
  exposing its `.als` text is a small bridge/endpoint addition.

Syntax highlighting via CodeMirror (read-only) is a nice-to-have, not required for v1.

> **Backend work for this view only:** one endpoint returning `{ dsh: "...", als: "..." }`.
> Simulation + Tables need no backend changes.

---

## 7. Visual language

Keep today's dark palette, tokenized for React:

```
--bg:#0f1923  --panel:#16213e  --panel-2:#0d1520
--border:#1e3a5f / #2a4a6b  --accent:#4fc3f7
--ok:#2e7d32 / #00e676  --warn:#f9a825  --danger:#c62828
--text:#e0e0e0  --muted:#78909c
```

---

## 8. Migration plan

1. **Scaffold** Vite + React + TS; lift `src/cy/*` over with types.
2. **Shell** — TopToolbar + ViewTabs + StepControls + OpenMenu (matches `mockup.html`).
3. **Simulation view** — ControlStatesGraph + StateTreeGraph side by side + Timeline +
   DetailPanel + SolverInfoPopup; `sim` store slice + Scope dialog.
4. **Events & Variables view** — tables from parsed snapshots.
5. **Model Source view** — add the `{dsh, als}` endpoint; render the two panes.
6. **Cutover** — repoint FastAPI static mount to `frontend/dist`; retire `index.html`.

---

## 9. Decisions & remaining

Resolved:
- **Name** — **DashViz**.
- **Examples** — Open menu lists **all 26 case-study `.dsh` files**, grouped by collection
  (via `/api/examples`).
- **Detail panel** — **slides in from the left** over the control-states graph.

Backend additions needed (small):
- `/api/examples` → grouped case-study list for the Open menu.
- `/api/source` (or extend an existing call) → `{ dsh, als }` for the Model Source view.

Simulation + Events/Variables views need **no** backend changes.
