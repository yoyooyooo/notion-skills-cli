import type { ContentRecord } from "./model.ts"

type Selection = {
  readonly scope: string
  readonly record: ContentRecord
  readonly version_id: string
}

/** A local selection binds its full observed record separately from content version.
 * ContentRecord has scalar fields and one scalar locator; sort both field sets so
 * object insertion order cannot change an otherwise identical selection. */
export function selectionSnapshotIdentityInput(selection: Selection): string {
  const record = Object.entries(selection.record)
    .map(([key, value]) => [
      key,
      key === "locator"
        ? Object.entries(selection.record.locator).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        : value,
    ])
    .sort(([a], [b]) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0))
  return JSON.stringify([
    "record-selection-v1",
    selection.scope,
    selection.record.id,
    selection.version_id,
    record,
  ])
}

/** Retained local manifests predate record-bound selection IDs. Current producers
 * never use the second payload; recognizing it only preserves existing fixed refs. */
export function retainedSnapshotIdentityInputs(selection: Selection): readonly string[] {
  return [
    selectionSnapshotIdentityInput(selection),
    JSON.stringify([selection.scope, selection.record.id, selection.version_id]),
  ]
}
