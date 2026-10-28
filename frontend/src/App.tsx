import {
  useCallback,
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
  InspectResponse,
  SolutionResponse,
  SourceResponse,
} from "./api/types";
import { Modal } from "./components/Modal";
import { ModelLibrary } from "./components/ModelLibrary";
import { ExplorePanel } from "./components/ExplorePanel";
import { TraceTable } from "./components/TraceTable";
import { type DetailSelection } from "./components/SelectionDetails";
import { ScopeDialog } from "./components/ScopeDialog";
import { SplitButton } from "./components/SplitButton";
import {
  StatechartGraph,
  type StatechartOverlayMode,
} from "./graph/StatechartGraph";
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

type ViewName = "hierarchy" | "trace" | "source";

interface LoadedSession {
  filePath: string;
  model: DashModel;
  scopeSigs: string[];
  commandCount: number;
}

const viewLabels: Record<ViewName, string> = {
  hierarchy: "Static Model Hierarchy",
  trace: "Trace View",
  source: "Model Source",
};

/** The demo always simulates in simplified mode: prefer successors that can step again. */
const MODE = "simplified" as const;

/** How many solver solutions to walk past before giving up on a new snapshot. */
const ALT_ENUMERATION_LIMIT = 40;

const PANEL_MIN = 300;
const PANEL_MAX = 640;

function shortName(id: string) {
  return id.split("/").pop() ?? id;
}

export function App() {
  const [examples, setExamples] = useState<ExampleModel[]>([]);
  const [allowLocalModelPaths, setAllowLocalModelPaths] = useState(true);
  const [openDialog, setOpenDialog] = useState(false);
  const [panelWidth, setPanelWidth] = useState(420);
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
  const [source, setSource] = useState<SourceResponse | null>(null);
  const [view, setView] = useState<ViewName>("hierarchy");
  const [status, setStatus] = useState("Open a Dash+ model to begin.");
  const [busy, setBusy] = useState(false);
  const [detailSelection, setDetailSelection] = useState<DetailSelection>(null);
  const [statechartOverlay, setStatechartOverlay] =
    useState<StatechartOverlayMode>(null);

  useEffect(() => {
    dashApi
      .examples()
      .then((catalog) => {
        setExamples(catalog.examples);
        setAllowLocalModelPaths(catalog.allowLocalModelPaths);
      })
      .catch((error) => {
        setHasError(true);
        setStatus(`Could not load examples: ${error.message}`);
      });
  }, []);

  const visualModel = useMemo(
    () =>
      session ? expandParameterizedModel(session.model, sigScopes).model : null,
    [session, sigScopes],
  );
  const currentSnapshot = trace[currentTraceIndex] ?? null;
  const currentTreeNodeId = traceNodeIds[currentTraceIndex] ?? null;

  useEffect(() => {
    setDetailSelection(null);
  }, [visualModel]);

  const edgeLabel = useCallback(
    (transitionId: string) => {
      const transition = visualModel?.transitions.find(
        (t) => t.id === transitionId || t._originalId === transitionId,
      );
      const base = shortName(transition?._originalId ?? transitionId);
      const name = transition?._paramInstance
        ? `${base}[${transition._paramInstance}]`
        : base;
      return transition?.on ? `${name}\non ${shortName(transition.on)}` : name;
    },
    [visualModel],
  );

  function resetRunState() {
    setTrace([]);
    setTraceNodeIds([]);
    setStateTree(emptyStateTree());
    setCurrentTraceIndex(0);
    setTriedTransitionsByStart({});
    setShownSnapshotsByStart({});
    setDetailSelection(null);
  }

  function applyScopes(nextScopes: Record<string, number>) {
    if (operationLock.current) return;
    setScopeDialogOpen(false);
    setSigScopes(nextScopes);
    void simulate(nextScopes);
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
    setView("hierarchy");
    setSource(null);
    resetRunState();

    await runBusy(`Loading ${path}...`, async () => {
      const inspected: InspectResponse = await dashApi.inspect(path);
      const nextScopes = Object.fromEntries(
        inspected.scopeSigs.map((sig) => [
          sig,
          inspected.defaultScopes?.[sig] ?? 1,
        ]),
      );
      setSession({
        filePath: path,
        model: inspected.model,
        scopeSigs: inspected.scopeSigs,
        commandCount: inspected.commandCount,
      });
      setSigScopes(nextScopes);
      setScopeDialogOpen(inspected.scopeSigs.length > 0);
      setStatus(
        inspected.scopeSigs.length > 0
          ? "Review model scopes, then start a simulation."
          : "Model ready. Start a simulation to find its initial snapshot.",
      );
    });
  }

  async function simulate(scopes = sigScopes) {
    if (!session) return;
    const solveModel = expandParameterizedModel(session.model, scopes).model;

    await runBusy("Finding an initial snapshot...", async () => {
      resetRunState();
      const initial = await dashApi.init({ mode: MODE, sigScopes: scopes });
      if (installInitialSolution(initial, solveModel)) {
        setStatus("Initial snapshot S1 found.");
      } else {
        setHasError(true);
        setStatus(
          session.scopeSigs.length > 0
            ? "No initial snapshot exists with these scopes. Try different scopes."
            : "No initial snapshot exists for this model.",
        );
      }
    });
  }

  /** Splice newly found successors of `startIndex` into the trace and the Kripke structure. */
  function installSuccessors(
    startIndex: number,
    startNodeId: number,
    startSnapshot: TraceSnapshot,
    successors: TraceSnapshot[],
  ) {
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
    return nextTrace[nextTrace.length - 1];
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
    const startSnapshot = currentSnapshot;

    await runBusy(`Stepping from ${startSnapshot.label}...`, async () => {
      const stepped = await dashApi.step({
        state: startSnapshot.raw,
        mode: MODE,
        sigScopes,
      });
      const successors = solutionToTrace(stepped, visualModel).slice(1);
      if (!stepped.satisfiable || successors.length === 0) {
        setStatus(`No successor was found from ${startSnapshot.label}.`);
        return;
      }
      const reached = installSuccessors(
        startIndex,
        startNodeId,
        startSnapshot,
        successors,
      );
      setStatus(`Stepped to ${reached.label}.`);
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
        let alternate = await dashApi.step({
          state: startSnapshot.raw,
          mode: MODE,
          sigScopes,
        });
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
        const reached = installSuccessors(
          startIndex,
          startNodeId,
          startSnapshot,
          successors,
        );
        setStatus(`Alternative snapshot: ${reached.label}.`);
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
        const alternate = await dashApi.altTrans({
          state: startSnapshot.raw,
          mode: MODE,
          sigScopes,
          excludeTransitions: excluded,
        });
        const successors = solutionToTrace(alternate, visualModel).slice(1);
        if (!alternate.satisfiable || successors.length === 0) {
          setStatus(
            `No untaken transitions remain from ${startSnapshot.label}.`,
          );
          return;
        }
        const reached = installSuccessors(
          startIndex,
          startNodeId,
          startSnapshot,
          successors,
        );
        setStatus(`Alternative transition selected: ${reached.label}.`);
      },
    );
  }

  async function altInit() {
    if (!session || !visualModel || trace.length === 0) return;

    await runBusy("Finding an alternative initial snapshot...", async () => {
      const alternate = await dashApi.nextInitSolution();
      if (installInitialSolution(alternate, visualModel)) {
        setDetailSelection(null);
        setStatus("Alternative initial snapshot selected.");
      } else {
        setStatus("No more alternative initial snapshots.");
      }
    });
  }

  /** Move the cursor to a Kripke node, rebuilding the trace path through it if needed. */
  function moveToNode(nodeId: number) {
    const node = stateTree.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) return null;
    const pathIndex = traceNodeIds.lastIndexOf(nodeId);
    if (pathIndex >= 0) {
      setCurrentTraceIndex(pathIndex);
      return node;
    }

    const selectedPath = reconstructStateTreePath(stateTree, nodeId);
    if (!selectedPath) return null;
    setTrace(selectedPath.snapshots);
    setTraceNodeIds(selectedPath.nodeIds);
    setCurrentTraceIndex(selectedPath.snapshots.length - 1);
    return node;
  }

  function selectNode(nodeId: number) {
    if (operationLock.current) return;
    const node = moveToNode(nodeId);
    if (node) setDetailSelection({ kind: "snapshot", value: node });
  }

  function selectTraceIndex(index: number) {
    if (operationLock.current) return;
    const nodeId = traceNodeIds[index];
    if (nodeId == null) return;
    setCurrentTraceIndex(index);
    const node = stateTree.nodes.find((candidate) => candidate.id === nodeId);
    if (node) setDetailSelection({ kind: "snapshot", value: node });
  }

  function selectTransition(transitionId: string) {
    const value = visualModel?.transitions.find(
      (t) => t.id === transitionId || t._originalId === transitionId,
    );
    setDetailSelection({ kind: "transition", value: value ?? { id: transitionId } });
  }

  function selectState(stateId: string) {
    const value = visualModel?.states.find((s) => s.id === stateId);
    if (value) setDetailSelection({ kind: "state", value });
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

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand">
          <span className="brand-symbol" aria-hidden="true">
            ◇
          </span>
          <div className="wordmark">
            Dash+<span> Visualizer</span>
          </div>
        </div>
        {session && (
          <div className="model-identity" title={session.filePath}>
            <small>MODEL</small>
            <strong>{session.model.rootName}</strong>
          </div>
        )}
        <nav className="tabs" aria-label="Primary views">
          {(Object.keys(viewLabels) as ViewName[]).map((name) => (
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
            Open Dash+ model
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
              disabled={!currentSnapshot || busy}
              title="Advance from the current snapshot"
              onClick={() => void step()}
            >
              Step →
            </button>
            <SplitButton
              menuOnly
              label="Alternatives"
              actionDisabled={busy || !currentSnapshot}
              menuDisabled={busy || !currentSnapshot}
              menuLabel="Explore alternative snapshots"
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
                    Alternative initial snapshot
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
            {session.scopeSigs.length > 0 && (
              <button disabled={busy} onClick={() => setScopeDialogOpen(true)}>
                Scopes ·{" "}
                {session.scopeSigs
                  .map((sig) => `${sig} ${sigScopes[sig] ?? 1}`)
                  .join(", ")}
              </button>
            )}
          </div>
          <span className="snapshot-badge">
            {currentSnapshot
              ? `${currentSnapshot.label} · ${currentSnapshot.stable === false ? "Unstable" : "Stable"}`
              : "No simulation yet"}
          </span>
        </div>
      )}
      {!session ? (
        <section className="welcome">
          <div className="welcome-intro">
            <p className="eyebrow">DASH+ MODEL WORKSPACE</p>
            <h1>Explore Dash+ models.</h1>
            <p>
              Open a Dash+ model, follow its transitions, and see
              <br className="desktop-break" /> what changes at every step.
            </p>
            <div className="workflow-hint">
              <span>
                01 <b>Open a Dash+ model</b>
              </span>
              <span>
                02 <b>Start a simulation</b>
              </span>
              <span>
                03 <b>Explore snapshots</b>
              </span>
            </div>
          </div>
          <ModelLibrary
            examples={examples}
            allowLocalModelPaths={allowLocalModelPaths}
            busy={busy}
            onOpen={(path) => void openModel(path)}
          />
        </section>
      ) : (
        <section
          className="workspace"
          style={{ "--support-width": `${panelWidth}px` } as CSSProperties}
        >
          <div className="main-content">
            {view === "hierarchy" && (
              <section className="graph-panel">
                <div className="panel-header">
                  <div>
                    <p className="eyebrow">MODEL</p>
                    <h2>Static Model Hierarchy</h2>
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
            {view === "trace" && (
              <TraceTable
                currentTraceIndex={currentTraceIndex}
                model={visualModel ?? session.model}
                onSelectSnapshot={selectTraceIndex}
                onSelectState={selectState}
                onSelectTransition={(transitionId, index) => {
                  if (operationLock.current) return;
                  setCurrentTraceIndex(index);
                  selectTransition(transitionId);
                }}
                selection={detailSelection}
                trace={trace}
              />
            )}
            {view === "source" && <SourceView source={source} />}
          </div>
          <div
            className="panel-resizer"
            role="separator"
            aria-label="Resize Kripke structure panel"
            aria-orientation="vertical"
            aria-valuemin={PANEL_MIN}
            aria-valuemax={PANEL_MAX}
            aria-valuenow={panelWidth}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                e.preventDefault();
                setPanelWidth((w) =>
                  Math.max(
                    PANEL_MIN,
                    Math.min(PANEL_MAX, w + (e.key === "ArrowLeft" ? 20 : -20)),
                  ),
                );
              }
            }}
            onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
            onPointerMove={(e) => {
              if (e.currentTarget.hasPointerCapture(e.pointerId))
                setPanelWidth(
                  Math.max(
                    PANEL_MIN,
                    Math.min(
                      PANEL_MAX,
                      e.currentTarget.parentElement!.getBoundingClientRect()
                        .right - e.clientX,
                    ),
                  ),
                );
            }}
            onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
          />
          <aside className="support-panel" aria-label="Explored Kripke structure">
            <ExplorePanel
              model={visualModel ?? session.model}
              tree={stateTree}
              cursor={currentTreeNodeId}
              pathNodeIds={traceNodeIds}
              selection={detailSelection}
              edgeLabel={edgeLabel}
              onSelection={setDetailSelection}
              onSelectNode={selectNode}
              onSelectTransition={(transitionId, targetNodeId) => {
                if (operationLock.current) return;
                moveToNode(targetNodeId);
                selectTransition(transitionId);
              }}
            />
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
        <Modal title="Open a Dash+ model" onClose={() => setOpenDialog(false)}>
          <ModelLibrary
            examples={examples}
            allowLocalModelPaths={allowLocalModelPaths}
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

function SourceView({ source }: { source: SourceResponse | null }) {
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
            Dash+
          </button>
          <button aria-pressed={tab === "als"} onClick={() => setTab("als")}>
            Alloy
          </button>
        </div>
      </div>
      <section className={`source-view source-${tab}`}>
        <article className="dash-source">
          <header>
            <strong>Dash+ · .dsh</strong>
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
