import { useMemo } from "react";
import {
  displaySnapshotField,
  formatSnapshotValues,
  readSnapshotFields,
  type SnapshotValue
} from "../state/snapshotData";
import type { TraceSnapshot } from "../state/trace";

function shortName(id: string) {
  return id.split("/").pop() ?? id;
}

function unionKeys(records: Array<Record<string, SnapshotValue[]>>) {
  return [...new Set(records.flatMap((record) => Object.keys(record)))].sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true })
  );
}

function SnapshotMatrix({
  currentTraceIndex,
  emptyText,
  fields,
  onSelectTrace,
  title,
  trace
}: {
  currentTraceIndex: number;
  emptyText: string;
  fields: Array<Record<string, SnapshotValue[]>>;
  onSelectTrace: (index: number) => void;
  title: string;
  trace: TraceSnapshot[];
}) {
  const keys = unionKeys(fields);
  return (
    <table className="data-table">
      <caption>{title}</caption>
      {keys.length === 0 ? (
        <tbody>
          <tr>
            <td className="table-empty">{emptyText}</td>
          </tr>
        </tbody>
      ) : (
        <>
          <thead>
            <tr>
              <th>{title === "Events" ? "Event set" : "Variable"}</th>
              {trace.map((snapshot, index) => (
                <th className={index === currentTraceIndex ? "active-step" : ""} key={`${snapshot.label}-${index}`}>
                  <button onClick={() => onSelectTrace(index)} type="button">
                    {snapshot.label}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => (
              <tr key={key}>
                <th>{displaySnapshotField(key)}</th>
                {fields.map((record, index) => (
                  <td key={`${key}-${index}`}>{formatSnapshotValues(record[key])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </>
      )}
    </table>
  );
}

export function EventsVariablesView({
  currentTraceIndex,
  onSelectTrace,
  trace
}: {
  currentTraceIndex: number;
  onSelectTrace: (index: number) => void;
  trace: TraceSnapshot[];
}) {
  const snapshotFields = useMemo(() => trace.map((snapshot) => readSnapshotFields(snapshot.raw)), [trace]);

  if (trace.length === 0) {
    return <section className="events-variables-view table-empty">No trace yet. Run Simulate or Step.</section>;
  }

  return (
    <section className="events-variables-view">
      <SnapshotMatrix
        currentTraceIndex={currentTraceIndex}
        emptyText="No event fields in the current trace."
        fields={snapshotFields.map((fields) => fields.events)}
        onSelectTrace={onSelectTrace}
        title="Events"
        trace={trace}
      />
      <SnapshotMatrix
        currentTraceIndex={currentTraceIndex}
        emptyText="No variables in this model."
        fields={snapshotFields.map((fields) => fields.variables)}
        onSelectTrace={onSelectTrace}
        title="Variables"
        trace={trace}
      />
      <table className="data-table">
        <caption>Transitions &amp; Configuration</caption>
        <thead>
          <tr>
            <th>Step</th>
            <th>Transition taken</th>
            <th>Stable</th>
            <th>Active states</th>
          </tr>
        </thead>
        <tbody>
          {trace.map((snapshot, index) => (
            <tr className={index === currentTraceIndex ? "active-row" : ""} key={`${snapshot.label}-${index}`}>
              <th>
                <button onClick={() => onSelectTrace(index)} type="button">
                  {snapshot.label}
                </button>
              </th>
              <td className="taken">{snapshot.takenTransitions.map(shortName).join(", ") || "—"}</td>
              <td className={snapshot.stable === false ? "unstable" : ""}>
                {snapshot.stable === false ? "No" : "Yes"}
              </td>
              <td>{snapshot.activeStates.map(shortName).join(", ") || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className="data-table solver-table">
        <caption>Solver Response - raw per snapshot</caption>
        <thead>
          <tr>
            <th>Step</th>
            <th>Raw solver response</th>
          </tr>
        </thead>
        <tbody>
          {trace.map((snapshot, index) => (
            <tr className={index === currentTraceIndex ? "active-row" : ""} key={`${snapshot.label}-${index}`}>
              <th>
                <button onClick={() => onSelectTrace(index)} type="button">
                  {snapshot.label}
                </button>
              </th>
              <td>
                <pre>{JSON.stringify(snapshot.raw, null, 2)}</pre>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
