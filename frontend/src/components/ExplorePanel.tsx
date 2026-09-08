import { useState } from "react";
import type { DashModel } from "../api/types";
import { StateTreeGraph } from "../graph/StateTreeGraph";
import type { StateTree } from "../state/stateTree";
import { SelectionDetails, type DetailSelection } from "./SelectionDetails";
export function ExplorePanel({
  model,
  tree,
  cursor,
  selection,
  onSelection,
  onSelectNode,
  treeOpen,
  onTreeOpen,
}: {
  model: DashModel;
  tree: StateTree;
  cursor: number | null;
  selection: DetailSelection;
  onSelection: (value: DetailSelection) => void;
  onSelectNode: (id: number) => void;
  treeOpen: boolean;
  onTreeOpen: (open: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  return (
    <div className="explore-panel">
      <div className="panel-section-heading">
        <h2>
          State tree <span>{tree.nodes.length} snapshots</span>
        </h2>
        <button aria-expanded={treeOpen} onClick={() => onTreeOpen(!treeOpen)}>
          {treeOpen ? "Hide tree" : "Show tree"}
        </button>
      </div>
      {treeOpen && (
        <div className="explore-tree">
          <StateTreeGraph
            tree={tree}
            currentNodeId={cursor}
            onSelectNode={(id) => {
              onSelectNode(id);
              const node = tree.nodes.find((n) => n.id === id);
              if (node) onSelection({ kind: "snapshot", value: node });
            }}
            onSelectTransition={(id) => {
              const value = model.transitions.find(
                (t) => t.id === id || t._originalId === id,
              );
              onSelection({ kind: "transition", value: value ?? { id } });
            }}
          />
        </div>
      )}
      <div className="tree-legend">
        <span>● Stable</span>
        <span>△ Unstable</span>
        <span>◎ Current</span>
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
