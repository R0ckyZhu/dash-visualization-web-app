import { useState } from "react";
import type { DashModel } from "../api/types";
import { KripkeGraph } from "../graph/KripkeGraph";
import {
  displaySnapshotField,
  formatSnapshotValues,
  presentEventLabels,
  readSnapshotFields,
} from "../state/snapshotData";
import type { StateTree, StateTreeNode } from "../state/stateTree";
import { SnapshotInfo, type DetailSelection } from "./SelectionDetails";

function shortName(id: string) {
  return id.split("/").pop() ?? id;
}

/** The current snapshot's events and variables, floating over the Kripke graph. */
function SnapshotOverlay({
  model,
  node,
  showEvents,
  showVariables,
}: {
  model: DashModel;
  node: StateTreeNode;
  showEvents: boolean;
  showVariables: boolean;
}) {
  const present = presentEventLabels(model.events, node.snapshot.raw);
  const { variables } = readSnapshotFields(node.snapshot.raw);
  return (
    <div className="kripke-overlay" aria-label={`${node.label} overlay`}>
      <header>{node.label}</header>
      {showEvents && (
        <div className="kripke-overlay-group">
          <small>Events</small>
          {model.events.map((event) => {
            const name = shortName(event.id);
            const instances = present.filter(
              (label) => label === name || label.startsWith(`${name}[`),
            );
            const active = instances.length > 0;
            return (
              <div
                className={`event-chip ${active ? "active" : "inactive"}`}
                key={event.id}
                title={event.id}
              >
                <span className="event-dot" />
                <span>
                  {(event.params?.length ?? 0) > 0 && active
                    ? instances.join(", ")
                    : name}
                </span>
                <small>{event.kind}</small>
              </div>
            );
          })}
        </div>
      )}
      {showVariables && (
        <div className="kripke-overlay-group">
          <small>Variables</small>
          {Object.entries(variables).map(([key, values]) => (
            <div className="variable-chip" key={key} title={key}>
              <span className="variable-name">{displaySnapshotField(key)}</span>
              <span className="variable-value">
                {formatSnapshotValues(values)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ExplorePanel({
  model,
  tree,
  cursor,
  pathNodeIds,
  selection,
  edgeLabel,
  onSelectNode,
  onSelectTransition,
}: {
  model: DashModel;
  tree: StateTree;
  cursor: number | null;
  pathNodeIds: number[];
  selection: DetailSelection;
  edgeLabel: (transitionId: string) => string;
  onSelectNode: (id: number) => void;
  onSelectTransition: (transitionId: string, targetNodeId: number) => void;
}) {
  const [showEvents, setShowEvents] = useState(false);
  const [showVariables, setShowVariables] = useState(false);
  const selectedTransition =
    selection?.kind === "transition" ? selection.value : null;
  const currentNode = tree.nodes.find((node) => node.id === cursor) ?? null;

  return (
    <div className="explore-panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">EXPLORE</p>
          <h2>Explored Kripke Structure</h2>
        </div>
        <span>
          {tree.nodes.length} snapshots · {tree.edges.length} steps
        </span>
      </div>
      <div className="graph-controls" aria-label="Kripke structure overlays">
        <button
          type="button"
          aria-pressed={showEvents}
          className={showEvents ? "toggle-on" : ""}
          disabled={model.events.length === 0}
          title={
            model.events.length === 0
              ? "This model has no events"
              : "Overlay the current snapshot's events"
          }
          onClick={() => setShowEvents(!showEvents)}
        >
          {showEvents ? "Hide events" : "Show events"}
        </button>
        <button
          type="button"
          aria-pressed={showVariables}
          className={showVariables ? "toggle-on" : ""}
          disabled={model.vars.length === 0}
          title={
            model.vars.length === 0
              ? "This model has no variables"
              : "Overlay the current snapshot's variable values"
          }
          onClick={() => setShowVariables(!showVariables)}
        >
          {showVariables ? "Hide variables" : "Show variables"}
        </button>
      </div>
      <div className="explore-tree">
        <KripkeGraph
          tree={tree}
          currentNodeId={cursor}
          pathNodeIds={pathNodeIds}
          selectedNodeId={
            selection?.kind === "snapshot" ? selection.value.id : null
          }
          edgeLabel={edgeLabel}
          isSelectedTransition={(id) =>
            selectedTransition != null &&
            (id === selectedTransition.id ||
              id === selectedTransition._originalId)
          }
          onSelectNode={onSelectNode}
          onSelectTransition={onSelectTransition}
        />
        {currentNode && (showEvents || showVariables) && (
          <SnapshotOverlay
            model={model}
            node={currentNode}
            showEvents={showEvents}
            showVariables={showVariables}
          />
        )}
      </div>
      <div className="tree-legend">
        <span>▭ Stable</span>
        <span>△ Unstable</span>
        <span className="legend-current">▭ Current</span>
        <span className="legend-path">— Current path</span>
      </div>
      <SnapshotInfo model={model} node={currentNode} />
    </div>
  );
}
