import { useEffect, useMemo, useState } from "react";
import { dashApi } from "./api/dashApi";
import type {
  DashModel,
  ExampleModel,
  GeneratedResponse,
  InspectResponse,
  SessionResponseMeta,
  SimulationMode,
  SolutionResponse,
  SourceResponse
} from "./api/types";
import {
  AskBar,
  type AskControls,
  type AskResult,
  type ChatMessage
} from "./components/AskBar";
import { ConstraintDock } from "./components/ConstraintDock";
import { EventsVariablesView } from "./components/EventsVariablesView";
import { SelectionDetails, type DetailSelection } from "./components/SelectionDetails";
import { ScopeDialog } from "./components/ScopeDialog";
import { SplitButton } from "./components/SplitButton";
import {
  StatechartGraph,
  type StatechartOverlayMode,
  type StatechartSelection
} from "./graph/StatechartGraph";
import { StateTreeGraph } from "./graph/StateTreeGraph";
import {
  generatedParagraphs,
  parseConstraintDraft,
  type AppliedConstraint
} from "./state/constraints";
import { expandParameterizedModel } from "./state/modelExpansion";
import {
  createInitialStateTree,
  emptyStateTree,
  extendStateTree,
  reconstructStateTreePath,
  type StateTree
} from "./state/stateTree";
import {
  normalizeTransitionExclusions,
  snapshotKey,
  solutionToTrace,
  takenTuplesFromRawState,
  type TraceSnapshot
} from "./state/trace";

type ViewName = "simulation" | "tables" | "source";

interface LoadedSession {
  filePath: string;
  model: DashModel;
  scopeSigs: string[];
  commandCount: number;
}

function groupExamples(examples: ExampleModel[]) {
  return examples.reduce<Record<string, ExampleModel[]>>((groups, example) => {
    groups[example.group] = groups[example.group] ?? [];
    groups[example.group].push(example);
    return groups;
  }, {});
}

const viewLabels: Record<ViewName, string> = {
  simulation: "Simulation",
  tables: "Events & Variables",
  source: "Model Source"
};

/** How many solver solutions to walk past before giving up on a new snapshot. */
const ALT_ENUMERATION_LIMIT = 40;

const simulationModes: Array<{ value: SimulationMode; description: string }> = [
  { value: "simplified", description: "Prefer successors that can step again; mark dead ends terminal." },
  { value: "raw", description: "Return any successor the constraints permit." }
];

function selectionContext(selection: DetailSelection): Record<string, unknown> | null {
  if (!selection) return null;
  if (selection.kind === "snapshot") {
    return {
      type: "snapshot",
      id: selection.value.id,
      label: selection.value.label
    };
  }
  return { type: selection.kind, id: selection.value.id };
}

export function App() {
  const [examples, setExamples] = useState<ExampleModel[]>([]);
  const [filePath, setFilePath] = useState("");
  const [session, setSession] = useState<LoadedSession | null>(null);
  const [trace, setTrace] = useState<TraceSnapshot[]>([]);
  const [traceNodeIds, setTraceNodeIds] = useState<number[]>([]);
  const [stateTree, setStateTree] = useState<StateTree>(() => emptyStateTree());
  const [currentTraceIndex, setCurrentTraceIndex] = useState(0);
  const [triedTransitionsByStart, setTriedTransitionsByStart] = useState<Record<string, string[]>>({});
  // Successor snapshots already shown from a given origin, so repeated presses of
  // "alternative snapshot" walk forward instead of flipping between the first two.
  const [shownSnapshotsByStart, setShownSnapshotsByStart] = useState<Record<string, string[]>>({});
  const [sigScopes, setSigScopes] = useState<Record<string, number>>({});
  const [scopeDialogOpen, setScopeDialogOpen] = useState(false);
  const [constraintDockOpen, setConstraintDockOpen] = useState(false);
  // Saved predicates stay in force until disabled; the draft is what is being
  // typed, and the saved set shows as grey placeholder text when the box is empty.
  const [savedConstraints, setSavedConstraints] = useState<string[]>([]);
  const [constraintDraft, setConstraintDraft] = useState("");
  const [constraintsEnabled, setConstraintsEnabled] = useState(true);
  const [generated, setGenerated] = useState<GeneratedResponse | null>(null);
  const [source, setSource] = useState<SourceResponse | null>(null);
  const [view, setView] = useState<ViewName>("simulation");
  const [mode, setMode] = useState<SimulationMode>("simplified");
  const [status, setStatus] = useState("Open a Dash model to begin.");
  const [busy, setBusy] = useState(false);
  const [stateTreeOpen, setStateTreeOpen] = useState(true);
  const [detailSelection, setDetailSelection] = useState<DetailSelection>(null);
  const [statechartOverlay, setStatechartOverlay] = useState<StatechartOverlayMode>(null);
  const [backendSessionId, setBackendSessionId] = useState("default");
  const [sessionRevision, setSessionRevision] = useState(0);

  useEffect(() => {
    dashApi
      .examples()
      .then(setExamples)
      .catch((error) => setStatus(`Could not load examples: ${error.message}`));
    dashApi.session().then((metadata) => {
      setBackendSessionId(metadata.sessionId);
      setSessionRevision(metadata.sessionRevision);
    }).catch(() => undefined);
  }, []);

  const exampleGroups = useMemo(() => groupExamples(examples), [examples]);
  const visualModel = useMemo(
    () => (session ? expandParameterizedModel(session.model, sigScopes).model : null),
    [session, sigScopes]
  );
  const currentSnapshot = trace[currentTraceIndex] ?? null;
  const currentTreeNodeId = traceNodeIds[currentTraceIndex] ?? null;
  const activeConstraints = constraintsEnabled ? savedConstraints : [];
  const dockConstraints: AppliedConstraint[] = [
    ...savedConstraints.map((text): AppliedConstraint => ({ origin: "user", text })),
    ...generatedParagraphs(generated)
  ];

  useEffect(() => {
    if (!session || sessionRevision <= 0) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void dashApi.updateUiContext(
        backendSessionId,
        {
          revision: sessionRevision,
          stateTree: { nodes: stateTree.nodes, edges: stateTree.edges },
          traceNodeIds,
          cursorNodeId: currentTreeNodeId,
          selection: selectionContext(detailSelection),
          sigScopes,
          simulationMode: mode,
          constraints: constraintsEnabled ? savedConstraints : [],
          triedTransitionsByStart,
          shownSnapshotsByStart
        },
        controller.signal
      ).catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.warn("Could not synchronize assistant context", error);
      });
    }, 100);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    backendSessionId,
    constraintsEnabled,
    currentTreeNodeId,
    detailSelection,
    mode,
    savedConstraints,
    session,
    sessionRevision,
    shownSnapshotsByStart,
    sigScopes,
    stateTree,
    traceNodeIds,
    triedTransitionsByStart
  ]);

  useEffect(() => {
    setDetailSelection(null);
  }, [visualModel]);

  useEffect(() => {
    if (stateTree.nodes.length > 0) setStateTreeOpen(true);
  }, [stateTree.nodes.length]);

  function defaultScopes(scopeSigs: string[]) {
    return Object.fromEntries(scopeSigs.map((sig) => [sig, 1]));
  }

  function acceptSessionMetadata(response: SessionResponseMeta) {
    setBackendSessionId(response.sessionId);
    setSessionRevision(response.sessionRevision);
  }

  function updateScope(sig: string, value: number) {
    const normalized = Math.max(1, Math.floor(value || 1));
    if (sigScopes[sig] === normalized) return;
    setSigScopes((current) => ({ ...current, [sig]: normalized }));
    resetRunState();
    setStatus("Scopes changed. Run simulation to solve the expanded model.");
  }

  function resetRunState() {
    setTrace([]);
    setTraceNodeIds([]);
    setStateTree(emptyStateTree());
    setCurrentTraceIndex(0);
    setTriedTransitionsByStart({});
    setShownSnapshotsByStart({});
    setDetailSelection(null);
  }

  function installInitialSolution(solution: SolutionResponse, model: DashModel) {
    const initialTrace = solutionToTrace(solution, model).slice(0, 1);
    if (!solution.satisfiable || initialTrace.length === 0) return false;
    const initialTree = createInitialStateTree(initialTrace[0]);
    setStateTree(initialTree.tree);
    setTrace(initialTree.snapshots);
    setTraceNodeIds(initialTree.nodeIds);
    setCurrentTraceIndex(0);
    setTriedTransitionsByStart({});
    setShownSnapshotsByStart({});
    return true;
  }

  function clearConstraints() {
    setSavedConstraints([]);
    setConstraintDraft("");
    setConstraintsEnabled(true);
  }

  /** Move the editor's text into the saved set, where the next solve will pick it up. */
  function saveConstraints() {
    const parsed = parseConstraintDraft(constraintDraft);
    setSavedConstraints(parsed);
    setConstraintDraft("");
    setConstraintsEnabled(true);
    setConstraintDockOpen(true);
    setStatus(
      parsed.length > 0
        ? `${parsed.length === 1 ? "1 constraint" : `${parsed.length} constraints`} in force until disabled.`
        : "Constraints cleared."
    );
  }

  /** Put the set that is in force back in the editor, to amend it. */
  function reuseConstraints() {
    if (savedConstraints.length === 0) return;
    setConstraintDraft(savedConstraints.join("\n"));
  }

  function toggleConstraintsEnabled() {
    const next = !constraintsEnabled;
    setConstraintsEnabled(next);
    setStatus(next ? "Constraints re-enabled." : "Constraints disabled; they stay saved.");
  }

  async function askAssistant(
    question: string,
    _history: ChatMessage[],
    controls: AskControls
  ): Promise<AskResult> {
    if (!session) throw new Error("Load a model before asking the assistant.");

    await dashApi.updateUiContext(
      backendSessionId,
      {
        revision: sessionRevision,
        stateTree: { nodes: stateTree.nodes, edges: stateTree.edges },
        traceNodeIds,
        cursorNodeId: currentTreeNodeId,
        selection: selectionContext(detailSelection),
        sigScopes,
        simulationMode: mode,
        constraints: activeConstraints,
        triedTransitionsByStart,
        shownSnapshotsByStart
      },
      controls.signal
    );

    const completed = await dashApi.streamChat(
      backendSessionId,
      {
        message: question,
        conversationId: controls.conversationId,
        sessionRevision,
        cursorNodeId: currentTreeNodeId,
        selection: selectionContext(detailSelection)
      },
      (event) => {
        if (event.type === "message.delta") {
          controls.onDelta(event.delta);
        } else if (event.type === "tool.started") {
          controls.onToolStatus(`Reading ${event.tool.replaceAll("_", " ")}...`);
        } else if (event.type === "tool.completed") {
          controls.onToolStatus(event.succeeded ? "Thinking..." : `${event.tool} failed`);
        }
      },
      controls.signal
    );
    controls.onToolStatus(null);
    return { stale: completed.stale };
  }

  /** Pull back the Alloy the session server generated for the last solve. */
  async function refreshGenerated() {
    try {
      setGenerated(await dashApi.generated());
    } catch {
      setGenerated(null);
    }
  }

  /** Saved constraints stay in force across solves; only refresh the generated view. */
  function afterSolve() {
    void refreshGenerated();
  }

  function rememberTriedTransitions(startSnapshot: TraceSnapshot, successors: TraceSnapshot[]) {
    const tuples = successors.flatMap((snapshot) => takenTuplesFromRawState(snapshot.raw));
    if (tuples.length === 0) return;

    const key = snapshotKey(startSnapshot.raw);
    setTriedTransitionsByStart((previous) => ({
      ...previous,
      [key]: [...new Set([...(previous[key] ?? []), ...tuples])]
    }));
  }

  async function runBusy<T>(message: string, action: () => Promise<T>) {
    setBusy(true);
    setStatus(message);
    try {
      return await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(message);
      return undefined as T;
    } finally {
      setBusy(false);
    }
  }

  async function openModel(path = filePath.trim()) {
    if (!path) {
      setStatus("Enter a .dsh file path or choose a bundled example.");
      return;
    }

    setSession(null);
    setFilePath(path);
    setScopeDialogOpen(false);
    setConstraintDockOpen(false);
    setSource(null);
    resetRunState();

    await runBusy(`Loading ${path}...`, async () => {
      const inspected: InspectResponse = await dashApi.inspect(path);
      acceptSessionMetadata(inspected);
      const nextScopes = defaultScopes(inspected.scopeSigs);
      setSession({
        filePath: path,
        model: inspected.model,
        scopeSigs: inspected.scopeSigs,
        commandCount: inspected.commandCount
      });
      setSigScopes(nextScopes);
      clearConstraints();
      setScopeDialogOpen(inspected.scopeSigs.length > 0);
      if (inspected.scopeSigs.length > 0) {
        setStatus("Set scopes before simulation.");
        return;
      }

      setStatus("Finding initial state...");
      const initial = await dashApi.init({ constraints: [], mode, sigScopes: {} });
      acceptSessionMetadata(initial);
      setStatus(
        installInitialSolution(initial, inspected.model)
          ? "Initial state S1 found."
          : "No initial state found."
      );
    });
  }

  async function simulate() {
    if (!session || !visualModel) return;

    await runBusy("Finding an initial state...", async () => {
      resetRunState();
      const applied = activeConstraints;
      const initial = await dashApi.init({ constraints: applied, mode, sigScopes });
      acceptSessionMetadata(initial);
      afterSolve();
      setStatus(
        installInitialSolution(initial, visualModel)
          ? "Initial state S1 found."
          : "No initial state found."
      );
    });
  }

  async function step() {
    if (!session || !visualModel || !currentSnapshot || currentTreeNodeId == null) return;
    const startIndex = currentTraceIndex;
    const startNodeId = currentTreeNodeId;

    await runBusy(`Stepping from ${currentSnapshot.label}...`, async () => {
      const applied = activeConstraints;
      const stepped = await dashApi.step({
        constraints: applied,
        state: currentSnapshot.raw,
        mode,
        sigScopes
      });
      acceptSessionMetadata(stepped);
      afterSolve();
      const successors = solutionToTrace(stepped, visualModel).slice(1);
      if (!stepped.satisfiable || successors.length === 0) {
        setStatus(`No successor was found from ${currentSnapshot.label}.`);
        return;
      }

      const extension = extendStateTree(stateTree, startNodeId, successors);
      const nextTrace = [...trace.slice(0, startIndex + 1), ...extension.snapshots];
      const nextNodeIds = [...traceNodeIds.slice(0, startIndex + 1), ...extension.nodeIds];
      rememberTriedTransitions(currentSnapshot, successors);
      setStateTree(extension.tree);
      setTrace(nextTrace);
      setTraceNodeIds(nextNodeIds);
      setCurrentTraceIndex(nextTrace.length - 1);
      setStatus(`Stepped to ${nextTrace[nextTrace.length - 1].label}.`);
    });
  }

  /**
   * Any successor that differs from the ones already shown from this origin, in
   * any field at all: configuration, transition, events or variables. Snapshots
   * already seen are remembered so repeated presses keep advancing.
   */
  async function altSnapshot() {
    if (!session || !visualModel || currentTraceIndex <= 0) return;
    const startIndex = currentTraceIndex - 1;
    const startSnapshot = trace[startIndex];
    const startNodeId = traceNodeIds[startIndex];
    const currentSuccessors = trace.slice(startIndex + 1, currentTraceIndex + 1);
    if (!startSnapshot || startNodeId == null || currentSuccessors.length === 0) return;

    const originKey = snapshotKey(startSnapshot.raw);
    const alreadyShown = new Set([
      ...(shownSnapshotsByStart[originKey] ?? []),
      ...currentSuccessors.map((snapshot) => snapshotKey(snapshot.raw))
    ]);

    await runBusy(`Finding another snapshot from ${startSnapshot.label}...`, async () => {
      const applied = activeConstraints;
      let alternate = await dashApi.step({
        constraints: applied,
        state: startSnapshot.raw,
        mode,
        sigScopes
      });
      acceptSessionMetadata(alternate);
      afterSolve();
      let successors = solutionToTrace(alternate, visualModel).slice(1);

      // Skip anything already seen from this origin, not just the one on screen.
      let guard = 0;
      while (
        alternate.satisfiable &&
        successors.length > 0 &&
        successors.every((snapshot) => alreadyShown.has(snapshotKey(snapshot.raw))) &&
        guard < ALT_ENUMERATION_LIMIT
      ) {
        alternate = await dashApi.nextSolution();
        acceptSessionMetadata(alternate);
        successors = solutionToTrace(alternate, visualModel).slice(1);
        guard += 1;
      }

      if (!alternate.satisfiable || successors.length === 0) {
        setStatus(`No further snapshot was found from ${startSnapshot.label}.`);
        return;
      }
      if (successors.every((snapshot) => alreadyShown.has(snapshotKey(snapshot.raw)))) {
        setStatus(`No new snapshot found from ${startSnapshot.label} within the search limit.`);
        return;
      }

      setShownSnapshotsByStart((previous) => ({
        ...previous,
        [originKey]: [
          ...new Set([
            ...(previous[originKey] ?? []),
            ...successors.map((snapshot) => snapshotKey(snapshot.raw))
          ])
        ]
      }));

      const extension = extendStateTree(stateTree, startNodeId, successors);
      const nextTrace = [...trace.slice(0, startIndex + 1), ...extension.snapshots];
      const nextNodeIds = [...traceNodeIds.slice(0, startIndex + 1), ...extension.nodeIds];
      rememberTriedTransitions(startSnapshot, successors);
      setStateTree(extension.tree);
      setTrace(nextTrace);
      setTraceNodeIds(nextNodeIds);
      setCurrentTraceIndex(nextTrace.length - 1);
      setStatus(`Alternative snapshot: ${nextTrace[nextTrace.length - 1].label}.`);
    });
  }

  async function altTrans() {
    if (!session || !visualModel || currentTraceIndex <= 0) return;
    const startIndex = currentTraceIndex - 1;
    const startSnapshot = trace[startIndex];
    const startNodeId = traceNodeIds[startIndex];
    if (!startSnapshot || startNodeId == null) return;
    const excluded = normalizeTransitionExclusions(
      triedTransitionsByStart[snapshotKey(startSnapshot.raw)] ?? []
    );

    await runBusy(`Finding an untaken transition from ${startSnapshot.label}...`, async () => {
      const applied = activeConstraints;
      const alternate = await dashApi.altTrans({
        constraints: applied,
        state: startSnapshot.raw,
        mode,
        sigScopes,
        excludeTransitions: excluded
      });
      acceptSessionMetadata(alternate);
      afterSolve();
      const successors = solutionToTrace(alternate, visualModel).slice(1);
      if (!alternate.satisfiable || successors.length === 0) {
        setStatus(`No untaken transitions remain from ${startSnapshot.label}.`);
        return;
      }

      const extension = extendStateTree(stateTree, startNodeId, successors);
      const nextTrace = [...trace.slice(0, startIndex + 1), ...extension.snapshots];
      const nextNodeIds = [...traceNodeIds.slice(0, startIndex + 1), ...extension.nodeIds];
      rememberTriedTransitions(startSnapshot, successors);
      setStateTree(extension.tree);
      setTrace(nextTrace);
      setTraceNodeIds(nextNodeIds);
      setCurrentTraceIndex(nextTrace.length - 1);
      setStatus(`Alternative transition selected: ${nextTrace[nextTrace.length - 1].label}.`);
    });
  }

  async function altInit() {
    if (!session || !visualModel || trace.length === 0) return;

    await runBusy("Finding alternate initial state...", async () => {
      const alternate = await dashApi.nextInitSolution();
      acceptSessionMetadata(alternate);
      const initialTrace = solutionToTrace(alternate, visualModel).slice(0, 1);
      if (!alternate.satisfiable || initialTrace.length === 0) {
        setStatus("No more alternate initial states.");
        return;
      }

      const initialTree = createInitialStateTree(initialTrace[0]);
      setStateTree(initialTree.tree);
      setTrace(initialTree.snapshots);
      setTraceNodeIds(initialTree.nodeIds);
      setCurrentTraceIndex(0);
      setTriedTransitionsByStart({});
      setShownSnapshotsByStart({});
      setStatus("Alternate initial state selected.");
    });
  }

  function runFromScopeDialog() {
    setScopeDialogOpen(false);
    void simulate();
  }

  function selectStateTreeNode(nodeId: number) {
    const node = stateTree.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) return;
    const pathIndex = traceNodeIds.lastIndexOf(nodeId);
    if (pathIndex >= 0) {
      setCurrentTraceIndex(pathIndex);
      return;
    }

    const selectedPath = reconstructStateTreePath(stateTree, nodeId);
    if (!selectedPath) return;

    setTrace(selectedPath.snapshots);
    setTraceNodeIds(selectedPath.nodeIds);
    setCurrentTraceIndex(selectedPath.snapshots.length - 1);
  }

  async function loadSource() {
    if (!session || source) return;

    await runBusy("Loading model source...", async () => {
      setSource(await dashApi.source());
      setStatus("Source loaded.");
    });
  }

  async function chooseView(nextView: ViewName) {
    setView(nextView);
    if (nextView === "source") {
      await loadSource();
    }
  }

  /** Constraints are edited beneath the Alloy source, so the button goes there. */
  async function openConstraintEditor() {
    setView("source");
    setConstraintDockOpen(true);
    void refreshGenerated();
    await loadSource();
  }

  return (
    <main className="app-shell">
      <header className="toolbar">
        <div className="wordmark">
          Dash<span>.</span>
        </div>
        <nav className="tabs" aria-label="Primary views">
          {(["simulation", "tables", "source"] as ViewName[]).map((name) => (
            <button
              className={view === name ? "active" : ""}
              key={name}
              onClick={() => void chooseView(name)}
              type="button"
            >
              {viewLabels[name]}
            </button>
          ))}
        </nav>
        {session ? (
          <div className="run-summary" title={session.filePath}>
            <strong>{session.model.rootName}</strong>
            {Object.entries(sigScopes).length > 0 ? (
              <span>{Object.entries(sigScopes).map(([sig, scope]) => `${sig}=${scope}`).join(", ")}</span>
            ) : null}
          </div>
        ) : null}

        <div className="toolbar-spacer" />

        <div className="toolbar-group">
          <SplitButton
            actionDisabled={busy}
            className="open-action"
            label="Open"
            menuDisabled={busy}
            menuLabel="Open a model from a path or the bundled examples"
            onAction={() => void openModel()}
          >
            {(close) => (
              <>
                <div className="menu-field">
                  <label htmlFor="model-path">Model path</label>
                  <input
                    autoFocus
                    id="model-path"
                    onChange={(event) => setFilePath(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      close();
                      void openModel();
                    }}
                    placeholder="Path to .dsh model"
                    value={filePath}
                  />
                </div>
                <div className="menu-scroll">
                  {Object.entries(exampleGroups).map(([group, items]) => (
                    <section className="menu-section" key={group}>
                      <h4>{group}</h4>
                      {items.map((example) => (
                        <button
                          className="menu-item"
                          key={example.path}
                          onClick={() => {
                            close();
                            void openModel(example.path);
                          }}
                          role="menuitem"
                          type="button"
                        >
                          {example.name}
                        </button>
                      ))}
                    </section>
                  ))}
                </div>
              </>
            )}
          </SplitButton>

          <SplitButton
            actionDisabled={!session || busy}
            className="run-action"
            label="Simulate"
            menuDisabled={busy}
            menuLabel="Choose the simulation mode"
            onAction={() => void simulate()}
          >
            {(close) => (
              <section className="menu-section">
                <h4>Simulation mode</h4>
                {simulationModes.map((option) => (
                  <button
                    className={`menu-item menu-choice${mode === option.value ? " selected" : ""}`}
                    key={option.value}
                    onClick={() => {
                      setMode(option.value);
                      close();
                    }}
                    role="menuitemradio"
                    aria-checked={mode === option.value}
                    type="button"
                  >
                    <span className="menu-check" aria-hidden="true">{mode === option.value ? "✓" : ""}</span>
                    <span>
                      <strong>{option.value}</strong>
                      <small>{option.description}</small>
                    </span>
                  </button>
                ))}
              </section>
            )}
          </SplitButton>
        </div>

        <div className="toolbar-group">
          <button disabled={!session?.scopeSigs.length || busy} onClick={() => setScopeDialogOpen(true)} type="button">
            Scopes
          </button>
          <button disabled={!session || busy} onClick={() => void openConstraintEditor()} type="button">
            Constraints{savedConstraints.length > 0 ? ` (${savedConstraints.length})` : ""}
          </button>
          <button
            className={constraintsEnabled ? "" : "toggle-off"}
            disabled={savedConstraints.length === 0 || busy}
            onClick={toggleConstraintsEnabled}
            title={
              constraintsEnabled
                ? "Stop applying the saved constraints, without losing them"
                : "Apply the saved constraints again"
            }
            type="button"
          >
            {constraintsEnabled ? "Disable" : "Enable"}
          </button>
        </div>

        <div className="toolbar-group step-group">
          <button disabled={!currentSnapshot || busy} onClick={() => void step()} type="button">
            Step
          </button>
          <button disabled={trace.length === 0 || busy} onClick={() => void altInit()} type="button">
            Alt Init
          </button>
          <SplitButton
            actionDisabled={currentTraceIndex <= 0 || busy}
            label="Alt"
            menuDisabled={currentTraceIndex <= 0 || busy}
            menuLabel="Choose what to vary"
            onAction={() => void altTrans()}
          >
            {(close) => (
              <section className="menu-section">
                <h4>Alternative from the previous snapshot</h4>
                <button
                  className="menu-item menu-choice"
                  onClick={() => {
                    close();
                    void altTrans();
                  }}
                  role="menuitem"
                  type="button"
                >
                  <span className="menu-check" aria-hidden="true">·</span>
                  <span>
                    <strong>Transition</strong>
                    <small>Fire a transition not already taken from here. The default.</small>
                  </span>
                </button>
                <button
                  className="menu-item menu-choice"
                  onClick={() => {
                    close();
                    void altSnapshot();
                  }}
                  role="menuitem"
                  type="button"
                >
                  <span className="menu-check" aria-hidden="true">·</span>
                  <span>
                    <strong>Snapshot</strong>
                    <small>Any successor that differs in states, transitions, events or variables.</small>
                  </span>
                </button>
              </section>
            )}
          </SplitButton>
        </div>
      </header>

      <section className="status-bar">{busy ? "Working..." : status}</section>

      {!session ? (
        <OpenModelPanel exampleGroups={exampleGroups} onSelect={(path) => void openModel(path)} />
      ) : (
        <section className="workspace">
          {view === "simulation" && (
            <SimulationView
              currentTraceIndex={currentTraceIndex}
              currentTreeNodeId={currentTreeNodeId}
              detailSelection={detailSelection}
              model={visualModel ?? session.model}
              onDetailSelectionChange={setDetailSelection}
              onSelectStateTreeNode={selectStateTreeNode}
              onStateTreeOpenChange={setStateTreeOpen}
              onStatechartOverlayChange={setStatechartOverlay}
              stateTree={stateTree}
              stateTreeOpen={stateTreeOpen}
              statechartOverlay={statechartOverlay}
              trace={trace}
            />
          )}
          {view === "tables" && (
            <EventsVariablesView
              currentTraceIndex={currentTraceIndex}
              onSelectTrace={setCurrentTraceIndex}
              trace={trace}
            />
          )}
          {view === "source" && (
            <SourceView
              constraintCount={dockConstraints.length}
              draft={constraintDraft}
              onDraftChange={setConstraintDraft}
              onReuse={reuseConstraints}
              onSave={saveConstraints}
              onToggleDock={() => {
                setConstraintDockOpen((open) => !open);
                void refreshGenerated();
              }}
              savedConstraints={savedConstraints}
              source={source}
            />
          )}
        </section>
      )}
      {session?.scopeSigs.length ? (
        <ScopeDialog
          onChange={updateScope}
          onClose={() => setScopeDialogOpen(false)}
          onRun={runFromScopeDialog}
          open={scopeDialogOpen}
          scopeSigs={session.scopeSigs}
          scopes={sigScopes}
        />
      ) : null}
      <AskBar onAsk={askAssistant} />

      {session && constraintDockOpen ? (
        <ConstraintDock
          constraints={dockConstraints}
          enabled={constraintsEnabled}
          onClose={() => setConstraintDockOpen(false)}
        />
      ) : null}
    </main>
  );
}

function OpenModelPanel({
  exampleGroups,
  onSelect
}: {
  exampleGroups: Record<string, ExampleModel[]>;
  onSelect: (path: string) => void;
}) {
  return (
    <section className="empty-state">
      <h1>Open a Dash model</h1>
      <div className="example-grid">
        {Object.entries(exampleGroups).map(([group, items]) => (
          <section className="example-group" key={group}>
            <h2>{group}</h2>
            {items.map((example) => (
              <button key={example.path} onClick={() => onSelect(example.path)} type="button">
                {example.name}
              </button>
            ))}
          </section>
        ))}
      </div>
    </section>
  );
}

function SimulationView({
  model,
  trace,
  currentTraceIndex,
  currentTreeNodeId,
  detailSelection,
  stateTree,
  stateTreeOpen,
  statechartOverlay,
  onDetailSelectionChange,
  onSelectStateTreeNode,
  onStateTreeOpenChange,
  onStatechartOverlayChange
}: {
  model: DashModel;
  trace: TraceSnapshot[];
  currentTraceIndex: number;
  currentTreeNodeId: number | null;
  detailSelection: DetailSelection;
  stateTree: StateTree;
  stateTreeOpen: boolean;
  statechartOverlay: StatechartOverlayMode;
  onDetailSelectionChange: (selection: DetailSelection) => void;
  onSelectStateTreeNode: (nodeId: number) => void;
  onStateTreeOpenChange: (open: boolean) => void;
  onStatechartOverlayChange: (mode: StatechartOverlayMode) => void;
}) {
  const currentSnapshot = trace[currentTraceIndex] ?? null;

  const statechartSelection: StatechartSelection | null =
    detailSelection?.kind === "state" || detailSelection?.kind === "transition"
      ? detailSelection
      : null;

  function selectSnapshot(nodeId: number) {
    onSelectStateTreeNode(nodeId);
    const node = stateTree.nodes.find((candidate) => candidate.id === nodeId);
    if (node) onDetailSelectionChange({ kind: "snapshot", value: node });
  }

  function selectTreeTransition(transitionId: string) {
    const transition = model.transitions.find(
      (candidate) => candidate.id === transitionId || candidate._originalId === transitionId
    );
    onDetailSelectionChange({ kind: "transition", value: transition ?? { id: transitionId } });
  }

  return (
    <section className={`view-panel simulation-layout${stateTreeOpen ? "" : " state-tree-closed"}`}>
      <div className="graph-panel">
        <div className="panel-header">
          <h2>Statechart</h2>
          <div className="panel-meta">
            <span>{model.states.length} states / {model.transitions.length} transitions</span>
            {!stateTreeOpen ? <button onClick={() => onStateTreeOpenChange(true)} type="button">State Tree</button> : null}
          </div>
        </div>
        <StatechartGraph
          activeStateIds={currentSnapshot?.activeStates ?? []}
          currentSnapshotRaw={currentSnapshot?.raw ?? null}
          hasSnapshot={currentSnapshot != null}
          model={model}
          onOverlayModeChange={onStatechartOverlayChange}
          onSelectionChange={onDetailSelectionChange}
          overlayMode={statechartOverlay}
          selection={statechartSelection}
          takenTransitionIds={currentSnapshot?.takenTransitions ?? []}
        />
      </div>
      {stateTreeOpen ? <div className="trace-panel">
        <div className="panel-header">
          <h2>State Tree</h2>
          <div className="panel-meta">
            <span>{stateTree.nodes.length > 0 ? `${stateTree.nodes.length} unique states` : "idle"}</span>
            <button aria-label="Close state tree" className="panel-close" onClick={() => onStateTreeOpenChange(false)} type="button">×</button>
          </div>
        </div>
        <StateTreeGraph
          currentNodeId={currentTreeNodeId}
          onSelectNode={selectSnapshot}
          onSelectTransition={selectTreeTransition}
          tree={stateTree}
        />
        <SelectionDetails onClose={() => onDetailSelectionChange(null)} selection={detailSelection} />
      </div> : null}
    </section>
  );
}

function SourceView({
  constraintCount,
  draft,
  onDraftChange,
  onReuse,
  onSave,
  onToggleDock,
  savedConstraints,
  source
}: {
  constraintCount: number;
  draft: string;
  onDraftChange: (value: string) => void;
  onReuse: () => void;
  onSave: () => void;
  onToggleDock: () => void;
  savedConstraints: string[];
  source: SourceResponse | null;
}) {
  if (!source) {
    return <section className="view-panel muted">No source loaded.</section>;
  }

  const canReuse = draft.trim().length === 0 && savedConstraints.length > 0;

  return (
    <section className="source-view">
      <article>
        <header><strong>.dsh</strong><span>{source.file.split(/[\\/]/).pop()}</span></header>
        <pre>{source.dsh}</pre>
      </article>
      <article className="als-article">
        <header>
          <strong>.als</strong>
          <span>translated Alloy</span>
          <button className="header-action" onClick={onToggleDock} type="button">
            Constraints{constraintCount > 0 ? ` (${constraintCount})` : ""}
          </button>
        </header>
        <pre>{source.als}</pre>
        <div className="constraint-editor">
          <label htmlFor="constraint-draft">
            Additional constraints
            <small>one Alloy predicate per line, applied to the next solve</small>
          </label>
          <textarea
            id="constraint-draft"
            onChange={(event) => onDraftChange(event.target.value)}
            placeholder={
              savedConstraints.length > 0
                ? savedConstraints.join("\n")
                : "e.g. TrafficLight_EastWest_Green in __webapp_conf[s]"
            }
            rows={4}
            spellCheck={false}
            value={draft}
          />
          <div className="constraint-editor-actions">
            {canReuse ? (
              <button onClick={onReuse} type="button">
                Reuse last
              </button>
            ) : null}
            <button className="run-action" onClick={onSave} type="button">
              Save
            </button>
          </div>
        </div>
      </article>
    </section>
  );
}
