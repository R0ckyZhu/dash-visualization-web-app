import type { DashModel, SolutionResponse } from "../api/types";

export interface TraceSnapshot {
  id: string;
  label: string;
  raw: Record<string, unknown>;
  stable: boolean | null;
  terminal: boolean;
  activeStates: string[];
  takenTransitions: string[];
}

interface AtomMappings {
  atomToState: Record<string, string>;
  atomToTransition: Record<string, string>;
  paramAtomToState: Record<string, Record<string, string>>;
  paramAtomToTransition: Record<string, Record<string, string>>;
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stripAtomSuffix(atom: string) {
  return atom.replace(/\$\d+$/, "");
}

function normalizeAtom(atom: unknown) {
  return stripAtomSuffix(String(atom ?? "").replace(/^this\//, ""));
}

function splitTuple(value: unknown) {
  return String(value).split("->").map(normalizeAtom).filter(Boolean);
}

function buildAtomMappings(model: DashModel): AtomMappings {
  const atomToState: Record<string, string> = {};
  const atomToTransition: Record<string, string> = {};
  const paramAtomToState: Record<string, Record<string, string>> = {};
  const paramAtomToTransition: Record<string, Record<string, string>> = {};

  for (const state of model.states) {
    const atom = (state._originalId ?? state.id).replace(/\//g, "_");
    if (state._paramInstance) {
      paramAtomToState[state._paramInstance] ??= {};
      paramAtomToState[state._paramInstance][atom] = state.id;
    } else {
      atomToState[atom] = state.id;
    }
  }

  for (const transition of model.transitions) {
    const atom = (transition._originalId ?? transition.id).replace(/\//g, "_");
    if (transition._paramInstance) {
      paramAtomToTransition[transition._paramInstance] ??= {};
      paramAtomToTransition[transition._paramInstance][atom] = transition.id;
    } else {
      atomToTransition[atom] = transition.id;
    }
  }

  return { atomToState, atomToTransition, paramAtomToState, paramAtomToTransition };
}

function mapParameterizedAtom(atoms: string[], table: Record<string, Record<string, string>>) {
  if (atoms.length < 2) return null;
  return table[atoms[0]]?.[atoms[atoms.length - 1]] ?? null;
}

function readBooleanAtom(value: unknown): boolean | null {
  const atoms = asStringList(value);
  if (atoms.some((atom) => atom.endsWith("/True") || atom === "True")) return true;
  if (atoms.some((atom) => atom.endsWith("/False") || atom === "False")) return false;
  return null;
}

function isConfField(key: string) {
  return /(^|_|\.)_*conf\d*$/i.test(key);
}

function isTakenField(key: string) {
  return /taken\d*$/i.test(key);
}

function isStableField(key: string) {
  return /stable$/i.test(key);
}

export function solutionToTrace(solution: SolutionResponse | null, model: DashModel): TraceSnapshot[] {
  if (!solution?.satisfiable) return [];
  const mappings = buildAtomMappings(model);

  const snapshots = (solution.snapshots ?? []).map((snapshot, index) => {
    const activeStates = new Set<string>();
    const takenTransitions = new Set<string>();
    let stable: boolean | null = null;

    for (const [field, value] of Object.entries(snapshot)) {
      if (isConfField(field)) {
        for (const tuple of asStringList(value)) {
          const atoms = splitTuple(tuple);
          const state =
            mapParameterizedAtom(atoms, mappings.paramAtomToState) ??
            mappings.atomToState[atoms[atoms.length - 1]];
          if (state) activeStates.add(state);
        }
      } else if (isTakenField(field)) {
        for (const tuple of asStringList(value)) {
          const atoms = splitTuple(tuple);
          const transition =
            mapParameterizedAtom(atoms, mappings.paramAtomToTransition) ??
            mappings.atomToTransition[atoms[atoms.length - 1]];
          if (transition) takenTransitions.add(transition);
        }
      } else if (isStableField(field)) {
        stable = readBooleanAtom(value);
      }
    }

    return {
      id: `snapshot-${index + 1}`,
      label: `S${index + 1}`,
      raw: snapshot,
      stable,
      terminal: false,
      activeStates: [...activeStates],
      takenTransitions: [...takenTransitions]
    };
  });

  if (snapshots.length > 0) {
    snapshots[snapshots.length - 1].terminal = solution.terminal === true;
  }
  return snapshots;
}

export function relabelTrace(trace: TraceSnapshot[]): TraceSnapshot[] {
  return trace.map((snapshot, index) => ({
    ...snapshot,
    id: `snapshot-${index + 1}`,
    label: `S${index + 1}`
  }));
}

export function snapshotKey(raw: Record<string, unknown>) {
  const sorted = Object.keys(raw)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = raw[key];
      return acc;
    }, {});
  return JSON.stringify(sorted);
}

export function takenTuplesFromRawState(raw: Record<string, unknown>) {
  const takenValues: string[] = [];
  for (const [field, value] of Object.entries(raw)) {
    if (!isTakenField(field)) continue;
    takenValues.push(...asStringList(value));
  }
  return normalizeTransitionExclusions(takenValues);
}

export function normalizeTransitionExclusions(values: string[]) {
  const tuples = values
    .map((value) => splitTuple(value).join("->"))
    .filter(Boolean);
  return [...new Set(tuples)];
}
