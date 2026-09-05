import type { ReactNode } from "react";
import type { StatechartSelection } from "../graph/StatechartGraph";
import { displaySnapshotField, formatSnapshotValues, readSnapshotFields } from "../state/snapshotData";
import type { StateTreeNode } from "../state/stateTree";

export type DetailSelection =
  | StatechartSelection
  | { kind: "snapshot"; value: StateTreeNode }
  | null;

function shortName(id: string) {
  return id.split("/").pop() ?? id;
}

function DetailRow({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="detail-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function SelectionDetails({
  onClose,
  selection
}: {
  onClose: () => void;
  selection: DetailSelection;
}) {
  const title = selection?.kind === "state"
    ? "State"
    : selection?.kind === "transition"
      ? "Transition"
      : selection?.kind === "snapshot"
        ? "Snapshot"
        : "Info";

  return (
    <section className={`selection-details${selection ? " has-selection" : ""}`}>
      <header>
        <h3>{title}</h3>
        {selection ? (
          <button aria-label="Close info" onClick={onClose} type="button">×</button>
        ) : null}
      </header>
      {!selection ? (
        <p className="selection-placeholder">Select a state, transition, or snapshot.</p>
      ) : selection.kind === "state" ? (
        <dl>
          <DetailRow label="Name">{selection.value.id}</DetailRow>
          <DetailRow label="Kind">{selection.value.kind}</DetailRow>
          <DetailRow label="Parent">{selection.value.parent ?? "none"}</DetailRow>
          <DetailRow label="Default">{selection.value.isDefault ? "Yes" : "No"}</DetailRow>
          <DetailRow label="Children">{selection.value.children.map(shortName).join(", ") || "none"}</DetailRow>
          <DetailRow label="Parameters">
            {selection.value.params
              .map((param) => `${shortName(param.stateName)}: ${param.paramSig}`)
              .join(", ") || "none"}
          </DetailRow>
        </dl>
      ) : selection.kind === "transition" ? (
        <dl>
          <DetailRow label="Name">{selection.value.id}</DetailRow>
          <DetailRow label="From">{selection.value.from ?? "none"}</DetailRow>
          <DetailRow label="To">{selection.value.to ?? "none"}</DetailRow>
          <DetailRow label="Event">{selection.value.on ?? "none"}</DetailRow>
          <DetailRow label="Guard">{selection.value.when ?? "none"}</DetailRow>
          <DetailRow label="Action">{selection.value.do ?? "none"}</DetailRow>
          <DetailRow label="Send">{selection.value.send ?? "none"}</DetailRow>
        </dl>
      ) : (
        <SnapshotDetails node={selection.value} />
      )}
    </section>
  );
}

function SnapshotDetails({ node }: { node: StateTreeNode }) {
  const fields = readSnapshotFields(node.snapshot.raw);
  return (
    <div className="snapshot-details">
      <dl>
        <DetailRow label="Name">{node.label}</DetailRow>
        <DetailRow label="Stable">{node.snapshot.stable === false ? "No" : "Yes"}</DetailRow>
        <DetailRow label="Terminal">{node.snapshot.terminal ? "Yes" : "No"}</DetailRow>
        <DetailRow label="Transition">
          {node.snapshot.takenTransitions.map(shortName).join(", ") || "none"}
        </DetailRow>
        <DetailRow label="Configuration">
          {node.snapshot.activeStates.map(shortName).join(", ") || "none"}
        </DetailRow>
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
  );
}
