import type { ReactNode } from "react";
import type { DashModel } from "../api/types";
import type { StatechartSelection } from "../graph/StatechartGraph";
import {
  displaySnapshotField,
  formatSnapshotValues,
  presentEventLabels,
  readSnapshotFields,
} from "../state/snapshotData";
import type { StateTreeNode } from "../state/stateTree";

export type DetailSelection =
  | StatechartSelection
  | { kind: "snapshot"; value: StateTreeNode }
  | null;

function shortName(id: string) {
  return id.split("/").pop() ?? id;
}

function DetailRow({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <div className="detail-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** The static definition of a state or transition, shown beside the model hierarchy. */
export function ModelElementDetails({
  onClose,
  selection,
}: {
  onClose: () => void;
  selection: StatechartSelection | null;
}) {
  return (
    <section
      className={`selection-details${selection ? " has-selection" : ""}`}
    >
      <header>
        <h3>
          {selection?.kind === "state"
            ? "State"
            : selection?.kind === "transition"
              ? "Transition"
              : "Definition"}
        </h3>
        {selection ? (
          <button aria-label="Close definition" onClick={onClose} type="button">
            ×
          </button>
        ) : null}
      </header>
      {!selection ? (
        <p className="selection-placeholder">
          Click a state or transition to see its definition.
        </p>
      ) : selection.kind === "state" ? (
        <dl>
          <DetailRow label="Name">{selection.value.id}</DetailRow>
          <DetailRow label="Kind">{selection.value.kind}</DetailRow>
          <DetailRow label="Parent">
            {selection.value.parent ?? "none"}
          </DetailRow>
          <DetailRow label="Default">
            {selection.value.isDefault ? "Yes" : "No"}
          </DetailRow>
          <DetailRow label="Children">
            {selection.value.children.map(shortName).join(", ") || "none"}
          </DetailRow>
          <DetailRow label="Parameters">
            {selection.value.params
              .map((param) => `${shortName(param.stateName)}: ${param.paramSig}`)
              .join(", ") || "none"}
          </DetailRow>
        </dl>
      ) : (
        <dl>
          <DetailRow label="Name">{selection.value.id}</DetailRow>
          <DetailRow label="From">{selection.value.from ?? "none"}</DetailRow>
          <DetailRow label="To">{selection.value.to ?? "none"}</DetailRow>
          <DetailRow label="Event">{selection.value.on ?? "none"}</DetailRow>
          <DetailRow label="Guard">
            <pre>{selection.value.when ?? "none"}</pre>
          </DetailRow>
          <DetailRow label="Action">
            <pre>{selection.value.do ?? "none"}</pre>
          </DetailRow>
          <DetailRow label="Send">{selection.value.send ?? "none"}</DetailRow>
        </dl>
      )}
    </section>
  );
}

/** The dynamic content of one snapshot, shown under the Kripke structure. */
export function SnapshotInfo({
  model,
  node,
}: {
  model: DashModel;
  node: StateTreeNode | null;
}) {
  if (!node) {
    return (
      <section className="selection-details">
        <header>
          <h3>Snapshot</h3>
        </header>
        <p className="selection-placeholder">
          Start a simulation to see the current snapshot.
        </p>
      </section>
    );
  }
  const fields = readSnapshotFields(node.snapshot.raw);
  const events = presentEventLabels(model.events, node.snapshot.raw);
  return (
    <section className="selection-details has-selection">
      <header>
        <h3>Snapshot {node.label}</h3>
      </header>
      <div className="snapshot-details">
        <dl>
          <DetailRow label="Stable">
            {node.snapshot.stable === false ? "No" : "Yes"}
          </DetailRow>
          <DetailRow label="Taken">
            {node.snapshot.takenTransitions.map(shortName).join(", ") ||
              "none (initial)"}
          </DetailRow>
          <DetailRow label="Active">
            {node.snapshot.activeStates.map(shortName).join(", ") || "none"}
          </DetailRow>
          {model.events.length > 0 && (
            <DetailRow label="Events">{events.join(", ") || "none"}</DetailRow>
          )}
          {Object.entries(fields.variables).map(([key, values]) => (
            <DetailRow key={key} label={displaySnapshotField(key)}>
              {formatSnapshotValues(values)}
            </DetailRow>
          ))}
        </dl>
        <details>
          <summary>Raw solver response</summary>
          <pre>{JSON.stringify(node.snapshot.raw, null, 2)}</pre>
        </details>
      </div>
    </section>
  );
}
