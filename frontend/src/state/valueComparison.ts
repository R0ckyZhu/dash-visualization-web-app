import type { SnapshotValue } from "./snapshotData";
// Alloy relation rows form a set. Preserve order WITHIN each tuple.
export function valuesChanged(
  previous: SnapshotValue[] | undefined,
  current: SnapshotValue[] | undefined,
): boolean {
  if (previous === undefined || current === undefined)
    return previous !== current;
  const canonical = (values: SnapshotValue[]) =>
    JSON.stringify(
      [...new Set(values.map((value) => JSON.stringify(value)))].sort(),
    );
  return canonical(previous) !== canonical(current);
}
