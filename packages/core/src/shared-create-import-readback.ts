import { Effect, Schema } from "effect"
import { decode, fail, SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import type { SharedCreatePlan } from "./shared-create-model.ts"
import type { SharedCreateBinding } from "./shared-create-outcome.ts"
import { FileEventSchema, normalizeObservedBody } from "./shared-file-state.ts"
import { loadRetainedBody } from "./shared-file-observer.ts"
import { assertImportedMarkdownContent } from "./shared-import-markdown.ts"
import { canonicalSharedJson, querySharedRecords } from "./shared-records.ts"
import { sha256, Store } from "./store.ts"

const ObservationSchema = Schema.Struct({
  version: Schema.Literal(1),
  operation_id: Schema.String,
  skill_page_id: Schema.String,
  file_id: Schema.String,
  page_id: Schema.String,
  input_sha256: Schema.String,
  markdown: Schema.String,
})
const BodySchema = Schema.Struct({
  id: Schema.String,
  markdown: Schema.String,
  truncated: Schema.Boolean,
  unknown_block_ids: Schema.Array(Schema.String),
  warnings: Schema.optional(Schema.Array(Schema.Unknown)),
})
type NativeFile = SharedCreatePlan["files"][number]
const checked = <A>(fn: () => A) =>
  Effect.try({
    try: fn,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("SHARED_CREATE_INVALID", "Invalid imported body evidence."),
  })

export function acceptsNativeImportReadback(plan: SharedCreatePlan): boolean {
  return (
    plan.version === 1 &&
    (plan.source_projection === undefined ||
      (plan.source_projection.version === 1 && plan.source_projection.local === undefined)) &&
    plan.files.length > 0 &&
    plan.files.every((file) => file.projection.version === 14)
  )
}

function withObservedBody(file: NativeFile, markdown: string) {
  return Effect.gen(function* () {
    if (
      (file.event.kind !== "adopted" && file.event.kind !== "projected") ||
      file.ancestors !== undefined
    )
      return yield* Effect.fail(
        fail(
          "SHARED_CREATE_SCOPE",
          "Import readback must retain native or fixed-source ownership without changing ancestry.",
        ),
      )
    yield* checked(() => assertImportedMarkdownContent(file.projection.markdown, markdown))
    const hash = yield* sha256(markdown)
    const content = {
      ...file.content,
      object_id: `body-${hash}`,
      sha256: hash,
      bytes: new TextEncoder().encode(markdown).length,
    }
    const { event_id: _oldId, ...original } = file.event
    const fields =
      original.kind === "adopted"
        ? { ...original, content }
        : { ...original, projection: { normalization_version: 1 as const, sha256: hash } }
    const event = {
      ...fields,
      event_id: `create-file-${yield* sha256(canonicalSharedJson({ version: 1, ...fields }))}`,
    }
    return { ...file, content, event, projection: { ...file.projection, markdown } }
  })
}

/** Freeze the first complete readback before publishing initial content facts.
 * Later attempts must match that observation, including formatting-only edits. */
export function observeNativeImportFile(
  plan: SharedCreatePlan,
  file: NativeFile,
  scope: string,
  skillPage: string,
  page: string,
) {
  return Effect.gen(function* () {
    const store = yield* Store
    const key = `operations/shared-native-readbacks/${scope}/${plan.operation_id}/${yield* sha256(file.file_id)}.json`
    const saved = yield* store.readJson(key, ObservationSchema)
    const raw = yield* (yield* Notion).request(`v1/pages/${page}/markdown?markdown_version=v2`)
    const body = yield* checked(() => decode(BodySchema, raw))
    if (
      body.id !== page ||
      body.truncated ||
      body.unknown_block_ids.length > 0 ||
      (body.warnings?.length ?? 0) > 0
    )
      return yield* Effect.fail(
        fail(
          "BODY_INCOMPLETE",
          "The imported page must have a complete, supported readback for its exact identity.",
        ),
      )
    const markdown = yield* checked(() => normalizeObservedBody(body.markdown))
    const observation = {
      version: 1 as const,
      operation_id: plan.operation_id,
      skill_page_id: skillPage,
      file_id: file.file_id,
      page_id: page,
      input_sha256: file.input.sha256,
      markdown,
    }
    if (saved !== undefined && canonicalSharedJson(saved) !== canonicalSharedJson(observation))
      return yield* Effect.fail(
        fail(
          "SHARED_CREATE_REVIEW_REQUIRED",
          "The original import readback changed; preserve the page instead of accepting a new baseline.",
        ),
      )
    const resolved = yield* withObservedBody(file, markdown)
    if (saved === undefined) yield* store.writeJson(key, observation)
    return resolved
  })
}

/** A completed import resolves from shared body/event facts, never today's page
 * or a copied importer cache. Original input and operation identities stay fixed. */
export function restoreNativeImportReadbacks(
  plan: SharedCreatePlan,
  skillPage: string,
  bindings: readonly SharedCreateBinding[],
) {
  return Effect.gen(function* () {
    const files = yield* Effect.forEach(plan.files, (file) =>
      Effect.gen(function* () {
        const binding = bindings.find(
          (item) => item.file_id === file.file_id && item.path === file.path,
        )
        if (binding === undefined)
          return yield* Effect.fail(
            fail("SHARED_CREATE_INVALID", "The original outcome lacks an imported file binding."),
          )
        const rows = yield* querySharedRecords(plan.library, {
          skillPageId: skillPage,
          kind: "file_event",
          entityId: file.file_id,
          recordId: binding.event_id,
        })
        const row = rows[0]
        if (rows.length !== 1 || row === undefined || row.operation_id !== binding.event_id)
          return yield* Effect.fail(
            fail("SHARED_CREATE_UNRESOLVED", "The original imported content event is unavailable."),
          )
        const event = yield* checked(() => decode(FileEventSchema, row.payload))
        if (
          (event.kind !== "adopted" && event.kind !== "projected") ||
          event.file_id !== file.file_id ||
          event.event_id !== binding.event_id
        )
          return yield* Effect.fail(
            fail(
              "SHARED_CREATE_SCOPE",
              "The original readback belongs to another file or ownership state.",
            ),
          )
        const markdown =
          event.kind === "adopted"
            ? (yield* loadRetainedBody(plan.library, skillPage, event.content)).markdown
            : yield* Effect.gen(function* () {
                const objectId = `body-${event.projection.sha256}`
                const bodies = yield* querySharedRecords(plan.library, {
                  skillPageId: skillPage,
                  kind: "object",
                  entityId: objectId,
                  recordId: objectId,
                  payloadContainsBody: true,
                })
                const body = bodies[0]
                if (
                  bodies.length !== 1 ||
                  body === undefined ||
                  body.operation_id !== `retain-${event.projection.sha256}`
                )
                  return yield* Effect.fail(
                    fail(
                      "RETAINED_BODY_UNAVAILABLE",
                      "The original reading-page baseline is unavailable.",
                    ),
                  )
                const payload = yield* checked(() =>
                  decode(
                    Schema.Struct({
                      version: Schema.Literal(1),
                      kind: Schema.Literal("normalized_markdown"),
                      normalization_version: Schema.Literal(1),
                      markdown: Schema.String,
                    }),
                    body.payload,
                  ),
                )
                if ((yield* sha256(payload.markdown)) !== event.projection.sha256)
                  return yield* Effect.fail(
                    fail(
                      "RETAINED_BODY_INVALID",
                      "The retained reading-page baseline differs from its initial fingerprint.",
                    ),
                  )
                return payload.markdown
              })
        const resolved = yield* withObservedBody(file, markdown)
        if (canonicalSharedJson(resolved.event) !== canonicalSharedJson(event))
          return yield* Effect.fail(
            fail(
              "SHARED_CREATE_INVALID",
              "The initial event differs from its original input and retained readback.",
            ),
          )
        return resolved
      }),
    )
    return { ...plan, files }
  })
}
