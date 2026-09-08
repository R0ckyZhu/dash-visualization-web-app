import { valuesChanged } from "../state/valueComparison";
import { useMemo, useState } from "react";
import {
  displaySnapshotField,
  formatSnapshotValues,
  readSnapshotFields,
  type SnapshotValue,
} from "../state/snapshotData";
import type { TraceSnapshot } from "../state/trace";

function shortName(id: string) {
  return id.split("/").pop() ?? id;
}

function unionKeys(records: Array<Record<string, SnapshotValue[]>>) {
  return [...new Set(records.flatMap((record) => Object.keys(record)))].sort(
    (left, right) => left.localeCompare(right, undefined, { numeric: true }),
  );
}

function SnapshotMatrix({
  currentTraceIndex,
  changedOnly,
  emptyText,
  fields,
  onSelectTrace,
  title,
  trace,
}: {
  currentTraceIndex: number;
  changedOnly: boolean;
  emptyText: string;
  fields: Array<Record<string, SnapshotValue[]>>;
  onSelectTrace: (index: number) => void;
  title: string;
  trace: TraceSnapshot[];
}) {
  const keys = unionKeys(fields).filter(
    (key) =>
      !changedOnly ||
      fields.some(
        (record, index) =>
          index > 0 && valuesChanged(fields[index - 1][key], record[key]),
      ),
  );
  return (
    <div className="table-scroll" role="region" aria-label={title} tabIndex={0}>
      <table className="data-table">
        <caption>{title}</caption>
        {keys.length === 0 ? (
          <tbody>
            <tr>
              <td className="table-empty">
                {changedOnly ? "No changed rows in this trace." : emptyText}
              </td>
            </tr>
          </tbody>
        ) : (
          <>
            <thead>
              <tr>
                <th>{title === "Events" ? "Event set" : "Variable"}</th>
                {trace.map((snapshot, index) => (
                  <th
                    className={index === currentTraceIndex ? "active-step" : ""}
                    key={`${snapshot.label}-${index}`}
                  >
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
                    <td
                      key={`${key}-${index}`}
                      className={
                        index > 0 &&
                        valuesChanged(fields[index - 1][key], record[key])
                          ? "changed"
                          : undefined
                      }
                    >
                      {formatSnapshotValues(record[key])}
                      {index > 0 &&
                        valuesChanged(fields[index - 1][key], record[key]) && (
                          <span className="change-marker">Changed</span>
                        )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </>
        )}
      </table>
    </div>
  );
}

export function EventsVariablesView({
  currentTraceIndex,
  onSelectTrace,
  trace,
}: {
  currentTraceIndex: number;
  onSelectTrace: (index: number) => void;
  trace: TraceSnapshot[];
}) {
  const [changedOnly, setChangedOnly] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  const snapshotFields = useMemo(
    () => trace.map((snapshot) => readSnapshotFields(snapshot.raw)),
    [trace],
  );

  if (trace.length === 0) {
    return (
      <section className="events-variables-view table-empty">
        No trace yet. Start a simulation to explore events and variables.
      </section>
    );
  }

  return (
    <section className="events-variables-view">
      <div className="table-controls">
        <h1>Events &amp; variables</h1>
        <label>
          <input
            type="checkbox"
            checked={changedOnly}
            onChange={(e) => setChangedOnly(e.target.checked)}
          />
          Changed rows only
        </label>
      </div>
      <p className="help">
        Changes compare each snapshot with its predecessor on this trace.
      </p>
      <SnapshotMatrix
        changedOnly={changedOnly}
        currentTraceIndex={currentTraceIndex}
        emptyText="No event fields in the current trace."
        fields={snapshotFields.map((fields) => fields.events)}
        onSelectTrace={onSelectTrace}
        title="Events"
        trace={trace}
      />
      <SnapshotMatrix
        changedOnly={changedOnly}
        currentTraceIndex={currentTraceIndex}
        emptyText="No variables in this model."
        fields={snapshotFields.map((fields) => fields.variables)}
        onSelectTrace={onSelectTrace}
        title="Variables"
        trace={trace}
      />
      <div
        className="table-scroll"
        role="region"
        aria-label="Transitions and configuration"
        tabIndex={0}
      >
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
              <tr
                className={index === currentTraceIndex ? "active-row" : ""}
                key={`${snapshot.label}-${index}`}
              >
                <th>
                  <button onClick={() => onSelectTrace(index)} type="button">
                    {snapshot.label}
                  </button>
                </th>
                <td className="taken">
                  {snapshot.takenTransitions.map(shortName).join(", ") || "—"}
                </td>
                <td className={snapshot.stable === false ? "unstable" : ""}>
                  {snapshot.stable === false ? "No" : "Yes"}
                </td>
                <td>
                  {snapshot.activeStates.map(shortName).join(", ") || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details
        className="raw-details"
        onToggle={(e) => setRawOpen(e.currentTarget.open)}
      >
        <summary>Raw solver responses</summary>
        {rawOpen && (
          <div className="table-scroll">
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
                  <tr
                    className={index === currentTraceIndex ? "active-row" : ""}
                    key={`${snapshot.label}-${index}`}
                  >
                    <th>
                      <button
                        onClick={() => onSelectTrace(index)}
                        type="button"
                      >
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
          </div>
        )}
      </details>
    </section>
  );
}
