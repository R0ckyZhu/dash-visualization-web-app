export type SnapshotValue = string | string[];

export interface SnapshotFields {
  events: Record<string, SnapshotValue[]>;
  variables: Record<string, SnapshotValue[]>;
}

function fieldLeaf(field: string) {
  return field.split(/[/.]/).pop()?.replace(/^_+/, "") ?? field;
}

function snapshotFieldAtom(field: string) {
  return field
    .replace(/^this\//, "")
    .replace(/^__Snapshot\./, "")
    .split(".")
    .pop() ?? field;
}

function isEventField(field: string) {
  return /^events\d*$/i.test(fieldLeaf(field));
}

function isHiddenField(field: string) {
  const leaf = fieldLeaf(field);
  return /^(conf|taken)\d*$/i.test(leaf) || /^(stable|sc_used\d*)$/i.test(leaf);
}

export function normalizeSnapshotAtom(atom: unknown) {
  const normalized = String(atom ?? "").replace(/^this\//, "").replace(/\$\d+$/, "");
  if (normalized === "boolean/True") return "true";
  if (normalized === "boolean/False") return "false";
  return normalized;
}

function parseValues(value: unknown): SnapshotValue[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const atoms = String(entry)
      .split("->")
      .map(normalizeSnapshotAtom)
      .filter(Boolean);
    return atoms.length <= 1 ? (atoms[0] ?? "") : atoms;
  });
}

export function displaySnapshotField(field: string) {
  const normalized = field.replace(/^this\/__Snapshot\./, "").replace(/_/g, "/");
  return normalized.split("/").filter(Boolean).pop() ?? field;
}

export function readSnapshotFields(raw: Record<string, unknown>): SnapshotFields {
  const events: Record<string, SnapshotValue[]> = {};
  const variables: Record<string, SnapshotValue[]> = {};

  for (const [field, value] of Object.entries(raw)) {
    if (isHiddenField(field)) continue;
    const target = isEventField(field) ? events : variables;
    target[field] = parseValues(value);
  }

  return { events, variables };
}

export function formatSnapshotValues(values: SnapshotValue[] | undefined) {
  if (values === undefined) return "·";
  if (values.length === 0) return "∅";
  const formatted = values.map((value) =>
    Array.isArray(value) ? value.map(String).join("→") : String(value)
  );
  return formatted.length === 1 ? formatted[0] : `{${formatted.join(", ")}}`;
}

export function snapshotVariableValues(
  raw: Record<string, unknown> | null,
  variableId: string,
  instance?: string
): SnapshotValue[] | undefined {
  if (!raw) return undefined;
  const variableAtom = variableId.replace(/\//g, "_");
  const entry = Object.entries(raw).find(([field]) => snapshotFieldAtom(field) === variableAtom);
  if (!entry) return undefined;

  const values = parseValues(entry[1]);
  if (instance == null) return values;
  const normalizedInstance = normalizeSnapshotAtom(instance);

  return values.flatMap((value): SnapshotValue[] => {
    if (!Array.isArray(value) || normalizeSnapshotAtom(value[0]) !== normalizedInstance) return [];
    const instanceValue = value.slice(1);
    if (instanceValue.length === 0) return [];
    return [instanceValue.length === 1 ? instanceValue[0] : instanceValue];
  });
}

export function activeEventSets(raw: Record<string, unknown> | null) {
  const bare = new Set<string>();
  const tuples = new Set<string>();
  if (!raw) return { bare, tuples };

  for (const [field, value] of Object.entries(raw)) {
    if (!isEventField(field) || !Array.isArray(value)) continue;
    for (const entry of value) {
      const atoms = String(entry)
        .split("->")
        .map(normalizeSnapshotAtom)
        .filter(Boolean);
      if (atoms.length === 1) bare.add(atoms[0]);
      if (atoms.length > 1) tuples.add(atoms.join("->"));
    }
  }
  return { bare, tuples };
}
