import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { dashApi } from "./api/dashApi";
import type {
  DashModel,
  ExampleModel,
  GeneratedResponse,
  InspectResponse,
  SessionResponseMeta,
  SimulationMode,
  SolutionResponse,
  SourceResponse,
} from "./api/types";
import {
  AskBar,
  type AskControls,
  type AskResult,
  type ChatMessage,
} from "./components/AskBar";
import { Modal } from "./components/Modal";
import { ModelLibrary } from "./components/ModelLibrary";
import { ExplorePanel } from "./components/ExplorePanel";
import { ConfigurationPanel } from "./components/ConfigurationPanel";
import { EventsVariablesView } from "./components/EventsVariablesView";
import { type DetailSelection } from "./components/SelectionDetails";
import { ScopeDialog } from "./components/ScopeDialog";
import { SplitButton } from "./components/SplitButton";
import {
  StatechartGraph,
  type StatechartOverlayMode,
  type StatechartSelection,
} from "./graph/StatechartGraph";
import {
  generatedParagraphs,
  parseConstraintDraft,
  type AppliedConstraint,
} from "./state/constraints";
import { expandParameterizedModel } from "./state/modelExpansion";
import {
  createInitialStateTree,
  emptyStateTree,
  extendStateTree,
  reconstructStateTreePath,
  type StateTree,
} from "./state/stateTree";
import {
  normalizeTransitionExclusions,
  snapshotKey,
  solutionToTrace,
  takenTuplesFromRawState,
  type TraceSnapshot,
} from "./state/trace";

type ViewName = "simulation" | "tables" | "source";

interface LoadedSession {
  filePath: string;
  model: DashModel;
  scopeSigs: string[];
  commandCount: number;
}

const viewLabels: Record<ViewName, string> = {
  simulation: "Simulation",
  tables: "Events & Variables",
  source: "Model Source",
};

/** How many solver solutions to walk past before giving up on a new snapshot. */
const ALT_ENUMERATION_LIMIT = 40;

const simulationModes: Array<{ value: SimulationMode; description: string }> = [
  {
    value: "simplified",
    description:
      "Prefer successors that can step again; mark dead ends terminal.",
  },
  { value: "raw", description: "Return any successor the constraints permit." },
];

function selectionContext(
  selection: DetailSelection,
): Record<string, unknown> | null {
  if (!selection) return null;
  if (selection.kind === "snapshot") {
    return {
      type: "snapshot",
      id: selection.value.id,
      label: selection.value.label,
    };
  }
  return { type: selection.kind, id: selection.value.id };
}

export function App() {
  const [examples, setExamples] = useState<ExampleModel[]>([]);
  const [openDialog, setOpenDialog] = useState(false);
  const [support, setSupport] = useState<
    "explore" | "configure" | "assistant" | null
  >(null);
  const [panelWidth, setPanelWidth] = useState(360);
  const [assistantAvailable, setAssistantAvailable] = useState(false);
  const [hasError, setHasError] = useState(false);
  const operationLock = useRef(false);
  const [session, setSession] = useState<LoadedSession | null>(null);
  const [trace, setTrace] = useState<TraceSnapshot[]>([]);
  const [traceNodeIds, setTraceNodeIds] = useState<number[]>([]);
  const [stateTree, setStateTree] = useState<StateTree>(() => emptyStateTree());
  const [currentTraceIndex, setCurrentTraceIndex] = useState(0);
  const [triedTransitionsByStart, setTriedTransitionsByStart] = useState<
    Record<string, string[]>
  >({});
  // Successor snapshots already shown from a given origin, so repeated presses of
  // "alternative snapshot" walk forward instead of flipping between the first two.
  const [shownSnapshotsByStart, setShownSnapshotsByStart] = useState<
    Record<string, string[]>
  >({});
  const [sigScopes, setSigScopes] = useState<Record<string, number>>({});
  const [scopeDialogOpen, setScopeDialogOpen] = useState(false);
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
  const [statechartOverlay, setStatechartOverlay] =
    useState<StatechartOverlayMode>(null);
  const [backendSessionId, setBackendSessionId] = useState("default");
  const [sessionRevision, setSessionRevision] = useState(0);

  useEffect(() => {
    dashApi
      .examples()
      .then(setExamples)
      .catch((error) => {
        setHasError(true);
        setStatus(`Could not load examples: ${error.message}`);
      });
    dashApi
      .llmCapabilities()
      .then((c) => setAssistantAvailable(c.enabled))
      .catch(() => undefined);
    dashApi
      .session()
      .then((metadata) => {
        setBackendSessionId(metadata.sessionId);
        setSessionRevision(metadata.sessionRevision);
      })
      .catch(() => undefined);
  }, []);

  const visualModel = useMemo(
    () =>
      session ? expandParameterizedModel(session.model, sigScopes).model : null,
    [session, sigScopes],
  );
  const currentSnapshot = trace[currentTraceIndex] ?? null;
  const currentTreeNodeId = traceNodeIds[currentTraceIndex] ?? null;
  const activeConstraints = constraintsEnabled ? savedConstraints : [];
  const dockConstraints: AppliedConstraint[] = [
    ...savedConstraints.map((text): AppliedConstraint => ({
      origin: "user",
      text,
    })),
    ...generatedParagraphs(generated),
  ];

  useEffect(() => {
    if (!session || sessionRevision <= 0) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void dashApi
        .updateUiContext(
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
            shownSnapshotsByStart,
          },
          controller.signal,
        )
        .catch((error) => {
          if (error instanceof DOMException && error.name === "AbortError")
            return;
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
    triedTransitionsByStart,
  ]);

  useEffect(() => {
    setDetailSelection(null);
  }, [visualModel]);

  function defaultScopes(scopeSigs: string[]) {
    return Object.fromEntries(scopeSigs.map((sig) => [sig, 1]));
  }

  function acceptSessionMetadata(response: SessionResponseMeta) {
    setBackendSessionId(response.sessionId);
    setSessionRevision(response.sessionRevision);
  }

  function applyScopes(nextScopes: Record<string, number>, start: boolean) {
    if (operationLock.current) return;
    const changed = Object.keys(nextScopes).some(
      (sig) => nextScopes[sig] !== sigScopes[sig],
    );
    setScopeDialogOpen(false);
    if (changed) {
      setSigScopes(nextScopes);
      if (!start) resetRunState();
      setStatus("Scopes changed. Start a new simulation.");
    }
    if (start) void simulate(nextScopes);
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

  function installInitialSolution(
    solution: SolutionResponse,
    model: DashModel,
  ) {
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
    setConstraintsEnabled(true);
    setSupport("configure");
    setStatus(
      parsed.length > 0
        ? `${parsed.length === 1 ? "1 constraint" : `${parsed.length} constraints`} saved for the next solve. Existing snapshots are unchanged.`
        : "Constraints cleared.",
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
    setStatus(
      next
        ? "Constraints enabled for the next solve."
        : "Constraints disabled for the next solve; they stay saved.",
    );
  }

  async function askAssistant(
    question: string,
    _history: ChatMessage[],
    controls: AskControls,
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
        shownSnapshotsByStart,
      },
      controls.signal,
    );

    const completed = await dashApi.streamChat(
      backendSessionId,
      {
        message: question,
        conversationId: controls.conversationId,
        sessionRevision,
        cursorNodeId: currentTreeNodeId,
        selection: selectionContext(detailSelection),
      },
      (event) => {
        if (event.type === "message.delta") {
          controls.onDelta(event.delta);
        } else if (event.type === "tool.started") {
          controls.onToolStatus(
            `Reading ${event.tool.replaceAll("_", " ")}...`,
          );
        } else if (event.type === "tool.completed") {
          controls.onToolStatus(
            event.succeeded ? "Thinking..." : `${event.tool} failed`,
          );
        }
      },
      controls.signal,
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

  function rememberTriedTransitions(
    startSnapshot: TraceSnapshot,
    successors: TraceSnapshot[],
  ) {
    const tuples = successors.flatMap((snapshot) =>
      takenTuplesFromRawState(snapshot.raw),
    );
    if (tuples.length === 0) return;

    const key = snapshotKey(startSnapshot.raw);
    setTriedTransitionsByStart((previous) => ({
      ...previous,
      [key]: [...new Set([...(previous[key] ?? []), ...tuples])],
    }));
  }

  async function runBusy<T>(message: string, action: () => Promise<T>) {
    if (operationLock.current) return undefined as T;
    operationLock.current = true;
    setBusy(true);
    setHasError(false);
    setStatus(message);
    try {
      return await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(message);
      setHasError(true);
      return undefined as T;
    } finally {
      operationLock.current = false;
      setBusy(false);
    }
  }

  async function openModel(path: string) {
    if (operationLock.current) return;
    if (!path) {
      setStatus("Enter a .dsh file path or choose a bundled example.");
      return;
    }

    setSession(null);
    setOpenDialog(false);
    setScopeDialogOpen(false);
    setSupport(window.innerWidth >= 1200 ? "explore" : null);
    setView("simulation");
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
        commandCount: inspected.commandCount,
      });
      setSigScopes(nextScopes);
      clearConstraints();
      setScopeDialogOpen(inspected.scopeSigs.length > 0);
      setStatus(
        inspected.scopeSigs.length > 0
          ? "Review model scopes, then start a simulation."
          : "Model ready. Start a simulation to find its initial state.",
      );
    });
  }

  async function simulate(scopes = sigScopes) {
    if (!session) return;
    const solveModel = expandParameterizedModel(session.model, scopes).model;

    await runBusy("Finding an initial state...", async () => {
      resetRunState();
      const applied = activeConstraints;
      const initial = await dashApi.init({
        constraints: applied,
        mode,
        sigScopes: scopes,
      });
      acceptSessionMetadata(initial);
      afterSolve();
      setStatus(
        installInitialSolution(initial, solveModel)
          ? "Initial state S1 found."
          : "No initial state found.",
      );
    });
  }

  async function step() {
    if (
      !session ||
      !visualModel ||
      !currentSnapshot ||
      currentTreeNodeId == null
    )
      return;
    const startIndex = currentTraceIndex;
    const startNodeId = currentTreeNodeId;

    await runBusy(`Stepping from ${currentSnapshot.label}...`, async () => {
      const applied = activeConstraints;
      const stepped = await dashApi.step({
        constraints: applied,
        state: currentSnapshot.raw,
        mode,
        sigScopes,
      });
      acceptSessionMetadata(stepped);
      afterSolve();
      const successors = solutionToTrace(stepped, visualModel).slice(1);
      if (!stepped.satisfiable || successors.length === 0) {
        setStatus(`No successor was found from ${currentSnapshot.label}.`);
        return;
      }

      const extension = extendStateTree(stateTree, startNodeId, successors);
      const nextTrace = [
        ...trace.slice(0, startIndex + 1),
        ...extension.snapshots,
      ];
      const nextNodeIds = [
        ...traceNodeIds.slice(0, startIndex + 1),
        ...extension.nodeIds,
      ];
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
    const currentSuccessors = trace.slice(
      startIndex + 1,
      currentTraceIndex + 1,
    );
    if (!startSnapshot || startNodeId == null || currentSuccessors.length === 0)
      return;

    const originKey = snapshotKey(startSnapshot.raw);
    const alreadyShown = new Set([
      ...(shownSnapshotsByStart[originKey] ?? []),
      ...currentSuccessors.map((snapshot) => snapshotKey(snapshot.raw)),
    ]);

    await runBusy(
      `Finding another snapshot from ${startSnapshot.label}...`,
      async () => {
        const applied = activeConstraints;
        let alternate = await dashApi.step({
          constraints: applied,
          state: startSnapshot.raw,
          mode,
          sigScopes,
        });
        acceptSessionMetadata(alternate);
        afterSolve();
        let successors = solutionToTrace(alternate, visualModel).slice(1);

        // Skip anything already seen from this origin, not just the one on screen.
        let guard = 0;
        while (
          alternate.satisfiable &&
          successors.length > 0 &&
          successors.every((snapshot) =>
            alreadyShown.has(snapshotKey(snapshot.raw)),
          ) &&
          guard < ALT_ENUMERATION_LIMIT
        ) {
          alternate = await dashApi.nextSolution();
          acceptSessionMetadata(alternate);
          successors = solutionToTrace(alternate, visualModel).slice(1);
          guard += 1;
        }

        if (!alternate.satisfiable || successors.length === 0) {
          setStatus(
            `No further snapshot was found from ${startSnapshot.label}.`,
          );
          return;
        }
        if (
          successors.every((snapshot) =>
            alreadyShown.has(snapshotKey(snapshot.raw)),
          )
        ) {
          setStatus(
            `No new snapshot found from ${startSnapshot.label} within the search limit.`,
          );
          return;
        }

        setShownSnapshotsByStart((previous) => ({
          ...previous,
          [originKey]: [
            ...new Set([
              ...(previous[originKey] ?? []),
              ...successors.map((snapshot) => snapshotKey(snapshot.raw)),
            ]),
          ],
        }));

        const extension = extendStateTree(stateTree, startNodeId, successors);
        const nextTrace = [
          ...trace.slice(0, startIndex + 1),
          ...extension.snapshots,
        ];
        const nextNodeIds = [
          ...traceNodeIds.slice(0, startIndex + 1),
          ...extension.nodeIds,
        ];
        rememberTriedTransitions(startSnapshot, successors);
        setStateTree(extension.tree);
        setTrace(nextTrace);
        setTraceNodeIds(nextNodeIds);
        setCurrentTraceIndex(nextTrace.length - 1);
        setStatus(
          `Alternative snapshot: ${nextTrace[nextTrace.length - 1].label}.`,
        );
      },
    );
  }

  async function altTrans() {
    if (!session || !visualModel || currentTraceIndex <= 0) return;
    const startIndex = currentTraceIndex - 1;
    const startSnapshot = trace[startIndex];
    const startNodeId = traceNodeIds[startIndex];
    if (!startSnapshot || startNodeId == null) return;
    const excluded = normalizeTransitionExclusions(
      triedTransitionsByStart[snapshotKey(startSnapshot.raw)] ?? [],
    );

    await runBusy(
      `Finding an untaken transition from ${startSnapshot.label}...`,
      async () => {
        const applied = activeConstraints;
        const alternate = await dashApi.altTrans({
          constraints: applied,
          state: startSnapshot.raw,
          mode,
          sigScopes,
          excludeTransitions: excluded,
        });
        acceptSessionMetadata(alternate);
        afterSolve();
        const successors = solutionToTrace(alternate, visualModel).slice(1);
        if (!alternate.satisfiable || successors.length === 0) {
          setStatus(
            `No untaken transitions remain from ${startSnapshot.label}.`,
          );
          return;
        }

        const extension = extendStateTree(stateTree, startNodeId, successors);
        const nextTrace = [
          ...trace.slice(0, startIndex + 1),
          ...extension.snapshots,
        ];
        const nextNodeIds = [
          ...traceNodeIds.slice(0, startIndex + 1),
          ...extension.nodeIds,
        ];
        rememberTriedTransitions(startSnapshot, successors);
        setStateTree(extension.tree);
        setTrace(nextTrace);
        setTraceNodeIds(nextNodeIds);
        setCurrentTraceIndex(nextTrace.length - 1);
        setStatus(
          `Alternative transition selected: ${nextTrace[nextTrace.length - 1].label}.`,
        );
      },
    );
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

  function selectStateTreeNode(nodeId: number) {
    if (operationLock.current) return;
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
    if (window.innerWidth < 1000) setSupport(null);
    if (nextView === "source") {
      await loadSource();
    }
  }

  function openConfiguration() {
    setSupport("configure");
    void refreshGenerated();
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand">
          <span className="brand-symbol" aria-hidden="true">
            ◇
          </span>
          <div className="wordmark">
            Dash<span> Visualizer</span>
          </div>
        </div>
        {session && (
          <div className="model-identity" title={session.filePath}>
            <small>MODEL</small>
            <strong>{session.model.rootName}</strong>
          </div>
        )}
        <nav className="tabs" aria-label="Primary views">
          {(["simulation", "tables", "source"] as ViewName[]).map((name) => (
            <button
              key={name}
              disabled={!session || busy}
              aria-current={view === name ? "page" : undefined}
              className={view === name ? "active" : ""}
              onClick={() => void chooseView(name)}
            >
              {viewLabels[name]}
            </button>
          ))}
        </nav>
        <div className="header-actions">
          <button disabled={busy} onClick={() => setOpenDialog(true)}>
            Open model
          </button>
          <button
            disabled={!session}
            aria-expanded={support === "assistant"}
            onClick={() =>
              setSupport(support === "assistant" ? null : "assistant")
            }
          >
            ✳ Assistant
          </button>
        </div>
      </header>
      {session && (
        <div className="command-bar" aria-label="Simulation commands">
          <div className="command-group">
            <button
              className={currentSnapshot ? "secondary" : "primary"}
              disabled={busy}
              onClick={() => void simulate()}
            >
              {currentSnapshot ? "Restart simulation" : "Start simulation"}
            </button>
            <button
              className={currentSnapshot ? "primary" : "secondary"}
              disabled={!currentSnapshot || busy || !!currentSnapshot.terminal}
              title={
                currentSnapshot?.terminal
                  ? "This snapshot is terminal"
                  : "Advance from the selected snapshot"
              }
              onClick={() => void step()}
            >
              Step →
            </button>
            <SplitButton
              menuOnly
              label="Alternatives"
              actionDisabled={busy || !currentSnapshot}
              menuDisabled={busy || !currentSnapshot}
              menuLabel="Explore alternative states"
              onAction={() => void altInit()}
            >
              {(close) => (
                <>
                  <p className="help">
                    {currentTraceIndex > 0
                      ? `Explore another successor of ${trace[currentTraceIndex - 1]?.label}`
                      : "At the initial snapshot"}
                  </p>
                  <button
                    className="menu-item"
                    role="menuitem"
                    onClick={() => {
                      close();
                      void altInit();
                    }}
                  >
                    Alternative initial state
                  </button>
                  <button
                    className="menu-item"
                    role="menuitem"
                    disabled={currentTraceIndex <= 0}
                    onClick={() => {
                      close();
                      void altTrans();
                    }}
                  >
                    Alternative transition
                  </button>
                  <button
                    className="menu-item"
                    role="menuitem"
                    disabled={currentTraceIndex <= 0}
                    onClick={() => {
                      close();
                      void altSnapshot();
                    }}
                  >
                    Alternative snapshot
                  </button>
                </>
              )}
            </SplitButton>
          </div>
          <label className="mode-control">
            Mode{" "}
            <select
              disabled={busy}
              value={mode}
              onChange={(e) => setMode(e.target.value as SimulationMode)}
            >
              {simulationModes.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.value === "raw" ? "Raw" : "Simplified"}
                </option>
              ))}
            </select>
          </label>
          <span className="snapshot-badge">
            {currentSnapshot
              ? `${currentSnapshot.label}${currentSnapshot.terminal ? " · Terminal" : currentSnapshot.stable === false ? " · Unstable" : currentSnapshot.stable === true ? " · Stable" : " · Stability unknown"}`
              : "No simulation yet"}
          </span>
          <div className="command-end">
            <button
              aria-expanded={support === "configure"}
              onClick={openConfiguration}
            >
              Configure
              {savedConstraints.length ? ` · ${savedConstraints.length}` : ""}
            </button>
            <button
              aria-expanded={support === "explore"}
              onClick={() =>
                setSupport(support === "explore" ? null : "explore")
              }
            >
              Inspect
            </button>
          </div>
        </div>
      )}
      {!session ? (
        <section className="welcome">
          <div className="welcome-intro">
            <p className="eyebrow">DASH MODEL WORKSPACE</p>
            <h1>
              Explore how your
              <br />
              system behaves.
            </h1>
            <p>
              Open a statechart, follow its transitions, and understand
              <br className="desktop-break" /> what changes at every step.
            </p>
            <div className="workflow-hint">
              <span>
                01 <b>Open a model</b>
              </span>
              <span>
                02 <b>Start a simulation</b>
              </span>
              <span>
                03 <b>Explore states</b>
              </span>
            </div>
          </div>
          <ModelLibrary
            examples={examples}
            busy={busy}
            onOpen={(path) => void openModel(path)}
          />
        </section>
      ) : (
        <section
          className={`workspace ${support ? "support-open" : ""}`}
          style={{ "--support-width": `${panelWidth}px` } as CSSProperties}
        >
          <div className="main-content">
            {view === "simulation" && (
              <section className="graph-panel">
                <div className="panel-header">
                  <div>
                    <p className="eyebrow">SIMULATION</p>
                    <h2>Statechart</h2>
                  </div>
                  <span>
                    {(visualModel ?? session.model).states.length} states ·{" "}
                    {(visualModel ?? session.model).transitions.length}{" "}
                    transitions
                  </span>
                </div>
                <StatechartGraph
                  model={visualModel ?? session.model}
                  activeStateIds={currentSnapshot?.activeStates ?? []}
                  currentSnapshotRaw={currentSnapshot?.raw ?? null}
                  hasSnapshot={!!currentSnapshot}
                  onOverlayModeChange={setStatechartOverlay}
                  overlayMode={statechartOverlay}
                  onSelectionChange={setDetailSelection}
                  selection={
                    detailSelection?.kind === "state" ||
                    detailSelection?.kind === "transition"
                      ? detailSelection
                      : null
                  }
                  takenTransitionIds={currentSnapshot?.takenTransitions ?? []}
                />
                <div className="graph-legend">
                  <span>
                    <i className="legend-active" /> Active
                  </span>
                  <span>
                    <i className="legend-selected" /> Selected
                  </span>
                  <span>
                    <i className="legend-default" /> Default
                  </span>
                  <span>Drag to pan · Scroll to zoom</span>
                </div>
              </section>
            )}
            {view === "tables" && (
              <EventsVariablesView
                currentTraceIndex={currentTraceIndex}
                onSelectTrace={(index) => {
                  const id = traceNodeIds[index];
                  if (id == null) return;
                  selectStateTreeNode(id);
                  const node = stateTree.nodes.find((n) => n.id === id);
                  if (node)
                    setDetailSelection({ kind: "snapshot", value: node });
                }}
                trace={trace}
              />
            )}
            {view === "source" && (
              <SourceView source={source} onConfigure={openConfiguration} />
            )}
          </div>
          {support && (
            <div
              className="panel-resizer"
              role="separator"
              aria-label="Resize support panel"
              aria-orientation="vertical"
              aria-valuemin={300}
              aria-valuemax={440}
              aria-valuenow={panelWidth}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                  e.preventDefault();
                  setPanelWidth((w) =>
                    Math.max(
                      300,
                      Math.min(440, w + (e.key === "ArrowLeft" ? 20 : -20)),
                    ),
                  );
                }
              }}
              onPointerDown={(e) =>
                e.currentTarget.setPointerCapture(e.pointerId)
              }
              onPointerMove={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId))
                  setPanelWidth(
                    Math.max(
                      300,
                      Math.min(
                        440,
                        e.currentTarget.parentElement!.getBoundingClientRect()
                          .right - e.clientX,
                      ),
                    ),
                  );
              }}
              onPointerUp={(e) =>
                e.currentTarget.releasePointerCapture(e.pointerId)
              }
            />
          )}
          <aside
            className="support-panel"
            hidden={!support}
            aria-label="Model tools"
          >
            <div className="support-tabs">
              <nav aria-label="Model tools">
                {(["explore", "configure", "assistant"] as const).map(
                  (name) => (
                    <button
                      key={name}
                      aria-pressed={support === name}
                      className={support === name ? "active" : ""}
                      onClick={() => setSupport(name)}
                    >
                      {name === "explore"
                        ? "Explore"
                        : name === "configure"
                          ? "Configure"
                          : "Assistant"}
                    </button>
                  ),
                )}
              </nav>
              <button
                aria-label="Close support panel"
                className="quiet"
                onClick={() => setSupport(null)}
              >
                ×
              </button>
            </div>
            <div hidden={support !== "explore"}>
              <ExplorePanel
                model={visualModel ?? session.model}
                tree={stateTree}
                cursor={currentTreeNodeId}
                selection={detailSelection}
                onSelection={setDetailSelection}
                onSelectNode={selectStateTreeNode}
                treeOpen={stateTreeOpen}
                onTreeOpen={setStateTreeOpen}
              />
            </div>
            <div hidden={support !== "configure"}>
              <ConfigurationPanel
                draft={constraintDraft}
                onDraft={setConstraintDraft}
                onSave={saveConstraints}
                saved={savedConstraints}
                enabled={constraintsEnabled}
                onToggle={toggleConstraintsEnabled}
                generated={dockConstraints.filter((c) => c.origin === "app")}
                scopes={sigScopes}
                onScopes={() => setScopeDialogOpen(true)}
                busy={busy}
              />
            </div>
            <div
              hidden={support !== "assistant"}
              className="assistant-container"
            >
              <AskBar
                onAsk={askAssistant}
                enabled={assistantAvailable}
                context={
                  currentSnapshot
                    ? `${session.model.rootName} · ${currentSnapshot.label}`
                    : session.model.rootName
                }
              />
            </div>
          </aside>
        </section>
      )}
      <footer
        className={`status-bar ${hasError ? "status-error" : ""}`}
        role="status"
        aria-live="polite"
      >
        <span className={`status-dot ${busy ? "pending" : ""}`} />
        {status}
        {busy && <span className="status-operation">In progress</span>}
      </footer>
      {openDialog && (
        <Modal title="Open a model" onClose={() => setOpenDialog(false)}>
          <ModelLibrary
            examples={examples}
            busy={busy}
            onOpen={(path) => void openModel(path)}
          />
        </Modal>
      )}
      {session && scopeDialogOpen && (
        <ScopeDialog
          scopes={sigScopes}
          scopeSigs={session.scopeSigs}
          hasRun={trace.length > 0}
          onClose={() => setScopeDialogOpen(false)}
          onApply={applyScopes}
        />
      )}
    </main>
  );
}

function SourceView({
  source,
  onConfigure,
}: {
  source: SourceResponse | null;
  onConfigure: () => void;
}) {
  const [tab, setTab] = useState<"dsh" | "als">("dsh");
  if (!source)
    return (
      <p className="muted">No source loaded. Return to this view to retry.</p>
    );
  return (
    <div className="source-shell">
      <div className="source-tools">
        <span>Read-only model source</span>
        <div className="source-switch">
          <button aria-pressed={tab === "dsh"} onClick={() => setTab("dsh")}>
            Dash
          </button>
          <button aria-pressed={tab === "als"} onClick={() => setTab("als")}>
            Alloy
          </button>
        </div>
        <button onClick={onConfigure}>Edit constraints</button>
      </div>
      <section className={`source-view source-${tab}`}>
        <article className="dash-source">
          <header>
            <strong>Dash · .dsh</strong>
            <span>{source.file.split(/[\\/]/).pop()}</span>
          </header>
          <pre>{source.dsh}</pre>
        </article>
        <article className="alloy-source">
          <header>
            <strong>Alloy · .als</strong>
            <span>Translated source</span>
          </header>
          <pre>{source.als}</pre>
        </article>
      </section>
    </div>
  );
}
