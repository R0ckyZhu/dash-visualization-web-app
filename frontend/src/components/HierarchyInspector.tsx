import { useState } from "react";
import type { DashModel, StaticInfoResponse } from "../api/types";
import type { StatechartSelection } from "../graph/StatechartGraph";
import { ModelElementDetails } from "./SelectionDetails";

function sigKind(modifiers: string, atoms: string[]) {
  if (modifiers.includes("abstract") && atoms.length > 0) return "enumeration";
  if (modifiers.includes("one")) return "one sig";
  return modifiers || "sig";
}

function StaticModelInfo({
  info,
  scopes,
}: {
  info: StaticInfoResponse | null;
  scopes: Record<string, number>;
}) {
  const scopeText = Object.entries(scopes)
    .map(([sig, n]) => `${sig} ${n}`)
    .join(", ");
  if (!info?.available) {
    return (
      <section className="static-info" aria-label="Static model info">
        <header>
          <h3>Static model</h3>
        </header>
        <p className="selection-placeholder">
          The solver fixes atoms, orderings and constants when it finds the
          initial snapshot. Start a simulation to see them.
          {scopeText && <> Scopes: {scopeText}.</>}
        </p>
      </section>
    );
  }
  const { integers, modules = [], sigs = [], orderings = [] } = info;
  const bitwidth = integers
    ? Math.round(Math.log2(integers.max - integers.min + 1))
    : null;
  return (
    <section className="static-info" aria-label="Static model info">
      <header>
        <h3>Static model</h3>
        <small>fixed for this whole trace</small>
      </header>
      {sigs.length > 0 && (
        <div className="static-group">
          <h4>Signatures</h4>
          {sigs.map((sig) => (
            <div className="static-sig" key={sig.name}>
              <div className="static-sig-head">
                <strong>{sig.name}</strong>
                <small>
                  {sigKind(sig.modifiers, sig.atoms)}
                  {sig.scope != null && ` · scope ${sig.scope}`}
                </small>
              </div>
              {sig.atoms.length > 0 &&
                !(sig.atoms.length === 1 && sig.atoms[0] === sig.name) && (
                  <code>{sig.atoms.join(", ")}</code>
                )}
              {sig.fields.map((field) => (
                <code key={field.name}>
                  {sig.atoms.length === 1 ? `${sig.name}.` : ""}
                  {field.name} = {field.values.join(", ") || "∅"}
                </code>
              ))}
            </div>
          ))}
        </div>
      )}
      {orderings.length > 0 && (
        <div className="static-group">
          <h4>Orderings</h4>
          {orderings.map((ordering) => (
            <div className="static-sig" key={ordering.module}>
              <div className="static-sig-head">
                <strong>{ordering.sig ?? ordering.module}</strong>
                <small>util/ordering</small>
              </div>
              <code>{ordering.order.join(" < ")}</code>
            </div>
          ))}
        </div>
      )}
      {integers && (
        <div className="static-group">
          <h4>Integers</h4>
          <code>
            Int {integers.min} … {integers.max}
            {bitwidth != null && ` (${bitwidth}-bit)`}
          </code>
          <code>seq up to {integers.seqLength} elements</code>
        </div>
      )}
      {modules.length > 0 && (
        <div className="static-group">
          <h4>Library modules</h4>
          {modules.map((module) => (
            <code key={module}>open {module}</code>
          ))}
        </div>
      )}
    </section>
  );
}

export function HierarchyInspector({
  model,
  onSelection,
  scopes,
  selection,
  showStatic,
  staticInfo,
}: {
  model: DashModel;
  onSelection: (selection: StatechartSelection | null) => void;
  scopes: Record<string, number>;
  selection: StatechartSelection | null;
  showStatic: boolean;
  staticInfo: StaticInfoResponse | null;
}) {
  const [query, setQuery] = useState("");
  const needle = query.toLowerCase();
  return (
    <aside className="hierarchy-inspector" aria-label="Model details">
      {showStatic && <StaticModelInfo info={staticInfo} scopes={scopes} />}
      <ModelElementDetails
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
            .filter((s) => s.id.toLowerCase().includes(needle))
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
            .filter((t) => t.id.toLowerCase().includes(needle))
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
    </aside>
  );
}
