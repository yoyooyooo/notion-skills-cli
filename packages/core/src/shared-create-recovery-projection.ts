import { Effect } from "effect"
import { importDocument } from "./import.ts"
import { fail } from "./model.ts"
import { createChecked, type SharedCreatePlan } from "./shared-create-model.ts"
import { nativeFileMetadata } from "./shared-file-state.ts"
import {
  projectSharedNotionMarkdown,
  sharedNotionMarkdownWire,
} from "./shared-notion-projection.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256 } from "./store.ts"

export function sharedRecoveryEventId(original: string, fields: unknown, version: 9 | 10) {
  return sha256(
    canonicalSharedJson({
      version: version === 9 ? 2 : 3,
      original_operation_id: original,
      projection_version: version,
      event: fields,
    }),
  ).pipe(Effect.map((hash) => "recovery-file-" + hash))
}

/** Callers establish the exact original variant first. Rendering never changes its wire. */
export function projectSharedRecoveryFiles(plan: SharedCreatePlan, version: 9 | 10) {
  return Effect.forEach(plan.files, (file) =>
    Effect.gen(function* () {
      if (file.event.kind !== "projected")
        return yield* Effect.fail(
          fail("SHARED_CREATE_RECOVERY_REQUIRED", "Expected an original projected file."),
        )
      const projection = yield* createChecked(() => {
        const authored =
          file.path === plan.entrypoint
            ? importDocument(
                { path: file.input_path, bytes: new TextEncoder().encode(file.input.text) },
                { name: plan.name, description: plan.description },
              ).body
            : file.input.text
        const next = projectSharedNotionMarkdown(authored, {
          version,
          purpose: "data_source_create",
        })
        if (sharedNotionMarkdownWire(next) !== sharedNotionMarkdownWire(file.projection))
          throw fail(
            "SHARED_CREATE_RECOVERY_REQUIRED",
            "Recovery cannot change any original submitted wire byte.",
          )
        return next
      })
      const hash = yield* sha256(projection.markdown),
        metadata = nativeFileMetadata(file.content)
      const content = {
        object_id: "body-" + hash,
        sha256: hash,
        bytes: new TextEncoder().encode(projection.markdown).length,
        ...metadata,
      }
      const fields = {
        kind: "projected" as const,
        file_id: file.file_id,
        parents: [] as readonly string[],
        source_revision: file.event.source_revision,
        projection: { normalization_version: 1 as const, sha256: hash },
        ...metadata,
      }
      return {
        ...file,
        projection,
        content,
        event: {
          ...fields,
          event_id: yield* sharedRecoveryEventId(plan.operation_id, fields, version),
        },
      }
    }),
  )
}
