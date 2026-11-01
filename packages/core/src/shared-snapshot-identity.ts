import type { ContentRecord, Snapshot } from "./model.ts"
import type { ResolvedFileState } from "./shared-file-state.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256 } from "./store.ts"

/** Shared observation and file-operation preflight use this exact immutable identity. */
export function sharedSnapshotVersion(input: {
  readonly record: ContentRecord
  readonly files: Snapshot["files"]
  readonly router_members?: Snapshot["router_members"]
  readonly source: { readonly source_id: string; readonly revision: string } | null
  readonly ownership: readonly {
    readonly file_id: string
    readonly path: string
    readonly state: ResolvedFileState | undefined
  }[]
}) {
  return sha256(
    canonicalSharedJson({
      version: 1,
      record: input.record,
      files: input.files,
      ...(input.router_members === undefined ? {} : { router_members: input.router_members }),
      source: input.source,
      ownership: [...input.ownership].sort((left, right) =>
        left.file_id < right.file_id ? -1 : left.file_id > right.file_id ? 1 : 0,
      ),
    }),
  )
}
