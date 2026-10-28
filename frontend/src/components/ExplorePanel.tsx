import { useState } from "react";
import type { DashModel } from "../api/types";
import { KripkeGraph } from "../graph/KripkeGraph";
import type { StateTree } from "../state/stateTree";
import { SelectionDetails, type DetailSelection } from "./SelectionDetails";

export function ExplorePanel({
  model,
  tree,
  cursor,
  pathNodeIds,
  selection,
  edgeLabel,
  onSelection,
  onSelectNode,
  onSelectTransition,
}: {
  model: DashModel;
  tree: StateTree;
  cursor: number | null;
  pathNodeIds: number[];
  selection: DetailSelection;
  edgeLabel: (transitionId: string) => string;
  onSelection: (value: DetailSelection) => void;
  onSelectNode: (id: number) => void;
  onSelectTransition: (transitionId: string, targetNodeId: number) => void;
}) {
  const [query, setQuery] = useState("");
  const selectedTransition =
    selection?.kind === "transition" ? selection.value : null;
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
      </div>
      <div className="tree-legend">
        <span>▭ Stable</span>
        <span>△ Unstable</span>
        <span className="legend-current">▭ Current</span>
        <span className="legend-path">— Current path</span>
      </div>
      <SelectionDetails
        selection={selection}
        onClose={() => onSelection(null)}
      />
      <details className="object-browser">
        <summary>Browse states and transitions</summary>
        <input
          type="search"
          aria-label="Search graph objects"
          placeholder="Find a state or transition…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="object-list">
          {model.states
            .filter((s) => s.id.toLowerCase().includes(query.toLowerCase()))
            .map((value) => (
              <button
                key={value.id}
                onClick={() => onSelection({ kind: "state", value })}
              >
                <small>State</small>
                {value.id}
              </button>
            ))}
          {model.transitions
            .filter((t) => t.id.toLowerCase().includes(query.toLowerCase()))
            .map((value) => (
              <button
                key={value.id}
                onClick={() => onSelection({ kind: "transition", value })}
              >
                <small>Transition</small>
                {value.id}
              </button>
            ))}
        </div>
      </details>
    </div>
  );
}
