import type { ContentRecord, Snapshot } from "./model.ts"
import type { ResolvedFileState } from "./shared-file-state.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256 } from "./store.ts"

/** Shared observation and file-operation preflight use this exact immutable identity. */
export function sharedSnapshotVersion(input: {
  readonly record: ContentRecord
  readonly files: Snapshot["files"]
  readonly router_members?: Snapshot["router_members"]
  readonly members?: Snapshot["members"]
  readonly required?: Snapshot["required"]
  readonly file_bindings?: Snapshot["file_bindings"]
  readonly native_references?: Snapshot["native_references"]
  readonly shared_acquisition?: Snapshot["shared_acquisition"]
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
      ...(input.members === undefined ? {} : { members: input.members }),
      ...(input.required === undefined ? {} : { required: input.required }),
      ...(input.file_bindings === undefined ? {} : { file_bindings: input.file_bindings }),
      ...(input.native_references === undefined
        ? {}
        : { native_references: input.native_references }),
      ...(input.shared_acquisition === undefined
        ? {}
        : { shared_acquisition: input.shared_acquisition }),
      source: input.source,
      ownership: [...input.ownership].sort((left, right) =>
        left.file_id < right.file_id ? -1 : left.file_id > right.file_id ? 1 : 0,
      ),
    }),
  )
}
