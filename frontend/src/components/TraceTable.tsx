import { useEffect, useMemo, useRef, useState } from "react";
import type { DashModel, DashTransition } from "../api/types";
import {
  activeEventSets,
  displaySnapshotField,
  formatSnapshotValues,
  normalizeSnapshotAtom,
  readSnapshotFields,
} from "../state/snapshotData";
import type { TraceSnapshot } from "../state/trace";
import { valuesChanged } from "../state/valueComparison";
import type { DetailSelection } from "./SelectionDetails";

type RowKind = "step" | "state" | "event" | "variable";

interface TraceRow {
  key: string;
  kind: RowKind;
  label: string;
  title: string;
  cells: string[];
  /** Per snapshot: whether this state or event is present (state and event rows). */
  present: boolean[];
  changed: boolean[];
  stateId?: string;
  eventId?: string;
  /** Per snapshot: the transitions taken into it (the "Transition taken" row). */
  transitionIds?: string[][];
}

const kindLabels: Record<RowKind, string> = {
  step: "Steps",
  state: "States",
  event: "Events",
  variable: "Variables",
};

function shortName(id: string) {
  return id.split("/").pop() ?? id;
}

function transitionLabel(id: string, model: DashModel) {
  const transition = model.transitions.find((t) => t.id === id);
  const name = shortName(transition?._originalId ?? id);
  return transition?._paramInstance
    ? `${name}[${transition._paramInstance}]`
    : name;
}

function stringChanges(cells: string[]) {
  return cells.map((cell, index) => index > 0 && cell !== cells[index - 1]);
}

function leafStates(model: DashModel) {
  const parents = new Set(
    model.states.map((state) => state.parent).filter(Boolean),
  );
  return model.states.filter((state) => !parents.has(state.id));
}

function buildRows(model: DashModel, trace: TraceSnapshot[]): TraceRow[] {
  const rows: TraceRow[] = [];

  const transitionIds = trace.map((snapshot) => snapshot.takenTransitions);
  const transitionCells = transitionIds.map(
    (ids) => ids.map((id) => transitionLabel(id, model)).join(", ") || "—",
  );
  rows.push({
    key: "step:transition",
    kind: "step",
    label: "Transition taken",
    title: "Transitions taken into each snapshot",
    cells: transitionCells,
    present: transitionIds.map((ids) => ids.length > 0),
    changed: transitionCells.map(() => false),
    transitionIds,
  });
  const stableCells = trace.map((snapshot) =>
    snapshot.stable === false ? "No" : "Yes",
  );
  rows.push({
    key: "step:stable",
    kind: "step",
    label: "Stable",
    title: "Whether the snapshot ends a big step",
    cells: stableCells,
    present: stableCells.map((cell) => cell === "No"),
    changed: stringChanges(stableCells),
  });

  for (const state of leafStates(model)) {
    const present = trace.map((snapshot) =>
      snapshot.activeStates.includes(state.id),
    );
    // Path below the root, so equally named states in different regions stay apart.
    const path = (state._originalId ?? state.id).split("/").slice(1).join("/");
    const label = state._paramInstance
      ? `${path}[${state._paramInstance}]`
      : path || state.id;
    rows.push({
      key: `state:${state.id}`,
      kind: "state",
      label,
      title: state.id,
      cells: present.map((active) => (active ? "●" : "")),
      present,
      changed: present.map(
        (active, index) => index > 0 && active !== present[index - 1],
      ),
      stateId: state.id,
    });
  }

  const eventSets = trace.map((snapshot) => activeEventSets(snapshot.raw));
  for (const event of model.events) {
    const atom = normalizeSnapshotAtom(event.id.replace(/\//g, "_"));
    const parameterized = (event.params?.length ?? 0) > 0;
    const cells = eventSets.map(({ bare, tuples }) => {
      if (!parameterized) return bare.has(atom) ? "●" : "";
      return [...tuples]
        .filter((tuple) => tuple.endsWith(`->${atom}`))
        .map((tuple) => tuple.slice(0, -atom.length - 2))
        .sort()
        .join(", ");
    });
    rows.push({
      key: `event:${event.id}`,
      kind: "event",
      label: shortName(event.id),
      title: `${event.id} (${event.kind === "ENV" ? "environment" : "internal"} event)`,
      cells,
      present: cells.map(Boolean),
      changed: stringChanges(cells),
      eventId: event.id,
    });
  }

  const variableFields = trace.map(
    (snapshot) => readSnapshotFields(snapshot.raw).variables,
  );
  const variableKeys = [
    ...new Set(variableFields.flatMap((fields) => Object.keys(fields))),
  ].sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true }),
  );
  for (const key of variableKeys) {
    const values = variableFields.map((fields) => fields[key]);
    rows.push({
      key: `variable:${key}`,
      kind: "variable",
      label: displaySnapshotField(key),
      title: key,
      cells: values.map((value) => formatSnapshotValues(value)),
      present: values.map(() => true),
      changed: values.map(
        (value, index) => index > 0 && valuesChanged(values[index - 1], value),
      ),
    });
  }

  return rows;
}

function matchesTransition(id: string, selected: DashTransition) {
  return id === selected.id || id === selected._originalId;
}

/** A transition's trigger may be serialized by full path or by short name. */
function isTriggerOf(eventId: string | undefined, trigger: string | null) {
  if (!eventId || !trigger) return false;
  return eventId === trigger || shortName(eventId) === shortName(trigger);
}

export function TraceTable({
  currentTraceIndex,
  model,
  onSelectSnapshot,
  onSelectState,
  onSelectTransition,
  selection,
  trace,
}: {
  currentTraceIndex: number;
  model: DashModel;
  onSelectSnapshot: (index: number) => void;
  onSelectState: (stateId: string) => void;
  onSelectTransition: (transitionId: string, index: number) => void;
  selection: DetailSelection;
  trace: TraceSnapshot[];
}) {
  const [query, setQuery] = useState("");
  const [kinds, setKinds] = useState<Record<RowKind, boolean>>({
    step: true,
    state: true,
    event: true,
    variable: true,
  });
  const [changedOnly, setChangedOnly] = useState(false);
  const [highlightChanges, setHighlightChanges] = useState(false);
  const [hideAbsent, setHideAbsent] = useState(true);
  const [rawOpen, setRawOpen] = useState(false);
  const tableRef = useRef<HTMLDivElement | null>(null);

  const rows = useMemo(() => buildRows(model, trace), [model, trace]);

  const selectedTransition =
    selection?.kind === "transition" ? selection.value : null;
  const selectedStateId =
    selection?.kind === "state" ? selection.value.id : null;
  const relatedEventId = selectedTransition?.on ?? null;

  function isSelectedRow(row: TraceRow) {
    if (selectedStateId) return row.stateId === selectedStateId;
    if (selectedTransition)
      return (
        row.key === "step:transition" ||
        isTriggerOf(row.eventId, relatedEventId)
      );
    return false;
  }

  function isHit(row: TraceRow, index: number) {
    if (selectedStateId && row.stateId === selectedStateId)
      return row.present[index];
    if (selectedTransition && row.transitionIds)
      return row.transitionIds[index].some((id) =>
        matchesTransition(id, selectedTransition),
      );
    if (isTriggerOf(row.eventId, relatedEventId)) return row.present[index];
    return false;
  }

  const needle = query.trim().toLowerCase();
  const visibleRows = rows.filter((row) => {
    // The row behind the current selection always stays visible.
    if (isSelectedRow(row)) return true;
    if (!kinds[row.kind]) return false;
    if (
      needle &&
      !row.label.toLowerCase().includes(needle) &&
      !row.title.toLowerCase().includes(needle)
    )
      return false;
    if (changedOnly && !row.changed.some(Boolean)) return false;
    if (
      hideAbsent &&
      (row.kind === "state" || row.kind === "event") &&
      !row.present.some(Boolean)
    )
      return false;
    return true;
  });

  // Keep the highlighted row and the current snapshot's column on screen, clear
  // of the sticky header row and row-name column (which scrollIntoView ignores).
  useEffect(() => {
    const container = tableRef.current;
    if (!container) return;
    const view = container.getBoundingClientRect();
    const corner = container.querySelector("thead th")?.getBoundingClientRect();
    const visibleLeft = view.left + (corner?.width ?? 0);
    const visibleTop = view.top + (corner?.height ?? 0);
    const visibleRight = view.left + container.clientWidth;
    const visibleBottom = view.top + container.clientHeight;
    const column = container
      .querySelector("thead .current-col")
      ?.getBoundingClientRect();
    if (column) {
      if (column.left < visibleLeft)
        container.scrollLeft -= visibleLeft - column.left;
      else if (column.right > visibleRight)
        container.scrollLeft += column.right - visibleRight;
    }
    const row = container.querySelector(".row-selected")?.getBoundingClientRect();
    if (row) {
      if (row.top < visibleTop) container.scrollTop -= visibleTop - row.top;
      else if (row.bottom > visibleBottom)
        container.scrollTop += row.bottom - visibleBottom;
    }
  }, [selection, currentTraceIndex]);

  if (trace.length === 0) {
    return (
      <section className="trace-view table-empty">
        No trace yet. Start a simulation to fill the trace view.
      </section>
    );
  }

  let previousKind: RowKind | null = null;

  return (
    <section className="trace-view">
      <div className="trace-filters" role="group" aria-label="Trace filters">
        <input
          type="search"
          aria-label="Filter rows"
          placeholder="Filter rows by name…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="trace-kind-toggles">
          {(Object.keys(kindLabels) as RowKind[]).map((kind) => (
            <button
              key={kind}
              type="button"
              aria-pressed={kinds[kind]}
              className={kinds[kind] ? "toggle-on" : ""}
              onClick={() =>
                setKinds((current) => ({ ...current, [kind]: !current[kind] }))
              }
            >
              {kindLabels[kind]}
            </button>
          ))}
        </div>
        <label>
          <input
            type="checkbox"
            checked={highlightChanges}
            onChange={(e) => setHighlightChanges(e.target.checked)}
          />
          Highlight changes
        </label>
        <label>
          <input
            type="checkbox"
            checked={changedOnly}
            onChange={(e) => setChangedOnly(e.target.checked)}
          />
          Changed rows only
        </label>
        <label>
          <input
            type="checkbox"
            checked={hideAbsent}
            onChange={(e) => setHideAbsent(e.target.checked)}
          />
          Hide states and events never present
        </label>
        <span className="trace-count">
          {visibleRows.length} of {rows.length} rows
        </span>
      </div>
      <div
        className="table-scroll trace-scroll"
        role="region"
        aria-label="Trace table"
        tabIndex={0}
        ref={tableRef}
      >
        <table className="data-table trace-table">
          <thead>
            <tr>
              <th scope="col">Snapshot</th>
              {trace.map((snapshot, index) => (
                <th
                  scope="col"
                  className={index === currentTraceIndex ? "current-col" : ""}
                  key={`${snapshot.label}-${index}`}
                >
                  <button onClick={() => onSelectSnapshot(index)} type="button">
                    {snapshot.label}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.length === 0 && (
              <tr>
                <td className="table-empty" colSpan={trace.length + 1}>
                  No rows match these filters.
                </td>
              </tr>
            )}
            {visibleRows.map((row) => {
              const groupStart = row.kind !== previousKind;
              previousKind = row.kind;
              const selected = isSelectedRow(row);
              return (
                <tr
                  key={row.key}
                  className={[
                    `row-${row.kind}`,
                    groupStart ? "group-start" : "",
                    selected ? "row-selected" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  <th scope="row" title={row.title}>
                    {groupStart && (
                      <small className="row-group">{kindLabels[row.kind]}</small>
                    )}
                    {row.stateId ? (
                      <button
                        type="button"
                        onClick={() => onSelectState(row.stateId!)}
                      >
                        {row.label}
                      </button>
                    ) : (
                      <span>{row.label}</span>
                    )}
                  </th>
                  {row.cells.map((cell, index) => {
                    const classes = [
                      index === currentTraceIndex ? "current-col" : "",
                      highlightChanges && row.changed[index] ? "changed" : "",
                      isHit(row, index) ? "cell-hit" : "",
                      row.kind === "state" && row.present[index]
                        ? "present"
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" ");
                    const transitions = row.transitionIds?.[index] ?? [];
                    return (
                      <td
                        key={index}
                        className={classes || undefined}
                        onClick={() =>
                          transitions.length > 0
                            ? onSelectTransition(transitions[0], index)
                            : onSelectSnapshot(index)
                        }
                      >
                        {cell}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="help trace-help">
        Columns follow the current path through the Kripke structure. With
        Highlight changes on, cells that differ from the previous snapshot are
        marked. Selecting a state, transition or snapshot in any view
        highlights it here.
      </p>
      <details
        className="raw-details"
        onToggle={(e) => setRawOpen(e.currentTarget.open)}
      >
        <summary>Raw solver responses</summary>
        {rawOpen && (
          <div className="table-scroll">
            <table className="data-table solver-table">
              <tbody>
                {trace.map((snapshot, index) => (
                  <tr
                    className={index === currentTraceIndex ? "active-row" : ""}
                    key={`${snapshot.label}-${index}`}
                  >
                    <th>{snapshot.label}</th>
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
