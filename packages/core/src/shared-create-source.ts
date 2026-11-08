import { Effect, Schema } from "effect"
import { fail, SkillsError } from "./model.ts"
import { FileEventSchema, nativeFileMetadata } from "./shared-file-state.ts"
import type { SharedCreatePlan } from "./shared-create-model.ts"
import {
  sharedCreateRetainedBinding,
  sharedCreateRetainedManifest,
} from "./shared-create-retained.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256 } from "./store.ts"

const checked = <A>(action: () => A) =>
  Effect.try({
    try: action,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail(
            "SHARED_CREATE_INVALID",
            "The original creation has an unresolved source projection draft.",
          ),
  })

/** Derive runtime facts from the immutable original input and its actual allocated
 * page. This never changes the frozen plan, operation hash, journal or manifest. */
export function resolveSharedCreateSource(plan: SharedCreatePlan, page: string) {
  return Effect.gen(function* () {
    const projection = plan.source_projection
    const fixed =
      projection?.version === 1
        ? projection.binding
        : plan.version === 2
          ? plan.origin.candidate.source
          : null
    const retained =
      projection?.version === 2
        ? yield* sharedCreateRetainedBinding(
            plan.library,
            sharedCreateRetainedManifest(projection.retained),
            page,
          )
        : undefined
    const selection =
      retained !== undefined
        ? {
            source_id: retained.source_id,
            revision: retained.source_id,
            paths: retained.bundle.files.map((file) => file.path),
          }
        : fixed === null
          ? undefined
          : {
              source_id: fixed.source_id,
              revision: fixed.commit,
              paths: fixed.files.map((file) => file.path),
            }
    const files = yield* Effect.forEach(plan.files, (file) =>
      Effect.gen(function* () {
        if (file.event.kind !== "source_projection_pending")
          return {
            ...file,
            event: yield* checked(() =>
              Schema.decodeUnknownSync(FileEventSchema)(file.event, { onExcessProperty: "error" }),
            ),
          }
        if (
          retained === undefined ||
          file.ancestors !== undefined ||
          file.event.parents.length !== 0
        )
          return yield* Effect.fail(
            fail(
              "SHARED_CREATE_INVALID",
              "Only an original retained-source creation may resolve a pending initial projection.",
            ),
          )
        const fields = {
          kind: "projected" as const,
          file_id: file.file_id,
          parents: [] as readonly string[],
          source_revision: retained.source_id,
          projection: file.event.projection,
          ...nativeFileMetadata(file.content),
        }
        const event = {
          ...fields,
          event_id: `create-file-${yield* sha256(canonicalSharedJson({ version: 1, ...fields }))}`,
        }
        return { ...file, event }
      }),
    )
    return { facts: { ...plan, files }, selection, retained }
  })
}
