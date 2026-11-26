import { Crypto, Effect, FileSystem, Path, Schema } from "effect"
import type { HttpClient } from "effect/http"
import { fail, listSchema, property, SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import { pageId } from "./ref.ts"
import {
  CurrentSourceIdSchema,
  CurrentResourceContentSchema,
  parseCurrentSkillState,
} from "./shared-current-file.ts"
import {
  CURRENT_RESOURCE_MAX_BYTES,
  prepareCurrentSharedResource,
  readCurrentSharedResourceBytes,
  type PreparedCurrentSharedResource,
} from "./shared-current-resource.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { loadSharedSourceOptions } from "./shared-source-config.ts"
import {
  admitSharedSourcePlan,
  inspectSharedSourcePlan,
  materializeSharedSourcePlan,
  type SharedSourcePlanOptions,
} from "./shared-source-plan.ts"
import { sha256, Store } from "./store.ts"
import { SharedSourcePlanSchema } from "./shared-source-plan-model.ts"

/** One current Sources property. A large manifest needs an explicit current
 * resource representation; this reader never truncates or falls back to history. */
export const CURRENT_SOURCE_MAX_INLINE_BYTES = 180_000
export const CurrentSharedSourcePlanContentSchema = Schema.Struct({
  version: Schema.Literal(1),
  plan: SharedSourcePlanSchema,
})
export type CurrentSharedSourcePlanContent = typeof CurrentSharedSourcePlanContentSchema.Type
export const CurrentSharedSourceContentSchema = Schema.Union([
  CurrentSharedSourcePlanContentSchema,
  Schema.Struct({ version: Schema.Literal(1), resource: CurrentResourceContentSchema }),
])
export type CurrentSharedSourceContent = typeof CurrentSharedSourceContentSchema.Type
export type CurrentSharedSourceSelection = {
  readonly source_id: string
  readonly revision: string
}
export type CurrentSharedSourceFile = {
  readonly path: string
  readonly sha256: string
  readonly bytes: number
  readonly mode: "100644" | "100755"
  readonly git_oid?: string
}
export type CurrentSharedSource = CurrentSharedSourceSelection & {
  readonly page_id: string
  readonly manifest: readonly CurrentSharedSourceFile[]
  readonly local_paths: readonly string[]
  readonly git_origin?: { readonly url: string; readonly commit: string }
  readonly materialize: (paths: readonly string[]) => Effect.Effect<
    {
      readonly files: readonly {
        readonly path: string
        readonly bytes: Uint8Array
        readonly mode: "100644" | "100755"
      }[]
      readonly local_paths: readonly string[]
    },
    SkillsError,
    Store | Crypto.Crypto | FileSystem.FileSystem | Path.Path | HttpClient.HttpClient
  >
}

function checked<A>(run: () => A): Effect.Effect<A, SkillsError> {
  return Effect.try({
    try: run,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("CURRENT_SOURCE_INVALID", "The current Source content is invalid."),
  })
}

export function validateCurrentSourceId(id: string): string {
  if (/^(?:snapshot-|bundle-|source-plan-)/u.test(id) || /^source-[a-f0-9]{64}$/u.test(id))
    throw fail(
      "CURRENT_SOURCE_REQUIRED",
      "A historical carrier cannot identify a current Sources row. Migrate the current content.",
      { next: "migrate_current_content" },
    )
  try {
    return Schema.decodeUnknownSync(CurrentSourceIdSchema)(id)
  } catch {
    throw fail("CURRENT_SOURCE_INVALID", "Use one bounded stable Source ID.")
  }
}

function boundedContent(value: string): void {
  if (new TextEncoder().encode(value).byteLength > CURRENT_SOURCE_MAX_INLINE_BYTES)
    throw fail(
      "CURRENT_SOURCE_MANIFEST_TOO_LARGE",
      "The current Source manifest exceeds the inline limit; a current resource manifest is required.",
      { max_bytes: CURRENT_SOURCE_MAX_INLINE_BYTES, next: "use_current_resource_manifest" },
    )
}

function validatedPlan(input: unknown) {
  const inspection = inspectSharedSourcePlan(input)
  if (
    inspection.manifest.some(
      (file) => file.identity.sha256 === undefined || !/^[a-f0-9]{64}$/u.test(file.identity.sha256),
    )
  )
    throw fail(
      "CURRENT_SOURCE_MANIFEST_INCOMPLETE",
      "Every current Source file requires its exact SHA-256 before it can be selected.",
    )
  return inspection.plan
}

export function validateCurrentSharedSourceContent(input: unknown): CurrentSharedSourceContent {
  const decoded = Schema.decodeUnknownSync(CurrentSharedSourceContentSchema)(input, {
    onExcessProperty: "error",
  })
  const content =
    "plan" in decoded ? { version: 1 as const, plan: validatedPlan(decoded.plan) } : decoded
  if (
    "resource" in content &&
    (content.resource.mode !== "100644" ||
      !Number.isSafeInteger(content.resource.bytes) ||
      content.resource.bytes <= 0 ||
      content.resource.bytes > CURRENT_RESOURCE_MAX_BYTES)
  )
    throw fail(
      "CURRENT_SOURCE_INVALID",
      "A Source manifest resource requires one complete regular JSON file within its byte limit.",
    )
  boundedContent(canonicalSharedJson(content))
  return content
}

/** Storage does not change the fingerprint of the complete normalized current plan. */
export function prepareCurrentSharedSourceContent(planInput: unknown) {
  return Effect.gen(function* () {
    const plan = yield* checked(() => validatedPlan(planInput))
    const content = { version: 1 as const, plan }
    const original = canonicalSharedJson(plan)
    const revision = yield* sha256(original)
    if (
      new TextEncoder().encode(canonicalSharedJson(content)).byteLength <=
      CURRENT_SOURCE_MAX_INLINE_BYTES
    )
      return { content, revision } satisfies {
        content: CurrentSharedSourceContent
        revision: string
        resource?: PreparedCurrentSharedResource
      }
    const resource = yield* prepareCurrentSharedResource(
      new TextEncoder().encode(original),
      "100644",
      { storage: "attachment" },
    )
    return { content: { version: 1 as const, resource: resource.content }, revision, resource }
  })
}

/** Concrete commits remain in the plan; this fingerprint is never a history pointer or CAS. */
export function currentSharedSourceRevision(input: unknown) {
  return Effect.gen(function* () {
    const content = yield* checked(() => validateCurrentSharedSourceContent(input))
    return "plan" in content
      ? yield* sha256(canonicalSharedJson(content.plan))
      : content.resource.sha256
  })
}

type CurrentSourceContentSelection = {
  readonly source_id: string
  readonly page_id: string
  readonly revision: string
  readonly content: CurrentSharedSourceContent
}

function currentSourcePlan(library: SharedLibrary, current: CurrentSourceContentSelection) {
  return Effect.gen(function* () {
    yield* checked(() => {
      validateCurrentSourceId(current.source_id)
      if (pageId(current.page_id) !== current.page_id || !/^[a-f0-9]{64}$/u.test(current.revision))
        throw fail("CURRENT_SOURCE_INVALID", "Use an exact current Source page and revision.")
    })
    const content = yield* checked(() => validateCurrentSharedSourceContent(current.content))
    const plan =
      "plan" in content
        ? content.plan
        : yield* readCurrentSharedResourceBytes(library, {
            owner: { kind: "source", page_id: current.page_id },
            content: content.resource,
          }).pipe(
            Effect.flatMap((bytes) =>
              checked(() =>
                validatedPlan(
                  JSON.parse(
                    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
                  ),
                ),
              ),
            ),
          )
    if ((yield* sha256(canonicalSharedJson(plan))) !== current.revision)
      return yield* Effect.fail(
        fail("SHARED_SOURCE_CONFLICT", "The current Source differs from its selected manifest.", {
          source_id: current.source_id,
          next: "reselect_current",
        }),
      )
    return plan
  })
}

/** Read the selected Git identity from the complete current plan without acquiring
 * repository files. Resource-backed plans use the same owner and hash checks as
 * consumption; Last Revision is a plan fingerprint, never a commit identity. */
export function readCurrentSourceGitOrigin(
  library: SharedLibrary,
  input: CurrentSourceContentSelection,
) {
  return currentSourcePlan(library, input).pipe(
    Effect.map((plan) =>
      plan.base?.kind === "git" && plan.mounts.length === 0
        ? { url: plan.base.source.url, commit: plan.base.source.commit }
        : undefined,
    ),
  )
}

/** Management has already checked the exact Source owner and finite intent. This
 * admits only its current immutable content, never a moving Ref or old carrier. */
export function prepareCurrentSourceManagementSelection(
  library: SharedLibrary,
  input: CurrentSourceContentSelection,
) {
  return Effect.gen(function* () {
    const plan = yield* currentSourcePlan(library, input)
    const localRequired =
      plan.base?.kind === "local" || plan.mounts.some((mount) => mount.resource.kind === "local")
    const options = yield* loadSharedSourceOptions({ localRequired })
    const selectedOptions = { ...options, metrics: (yield* Notion).metrics ?? options.metrics }
    const inspection = yield* admitSharedSourcePlan(plan, selectedOptions)
    const manifest = inspection.manifest.map(
      (file): CurrentSharedSourceFile => ({
        path: file.path,
        sha256: file.identity.sha256!,
        bytes: file.bytes,
        mode: file.mode ?? "100644",
        ...(file.identity.kind === "git" ? { git_oid: file.identity.git_oid } : {}),
      }),
    )
    return {
      source_id: input.source_id,
      page_id: input.page_id,
      revision: input.revision,
      manifest,
      local_paths: inspection.local_paths,
      ...(inspection.plan.base?.kind === "git" && inspection.plan.mounts.length === 0
        ? {
            git_origin: {
              url: inspection.plan.base.source.url,
              commit: inspection.plan.base.source.commit,
            },
          }
        : {}),
      materialize: (paths: readonly string[]) =>
        materializeSharedSourcePlan(inspection.plan, selectedOptions, paths).pipe(
          Effect.map((materialized) => ({
            files: materialized.files.map((file) => ({ ...file, mode: file.mode ?? "100644" })),
            local_paths: materialized.local_paths,
          })),
        ),
    } satisfies CurrentSharedSource
  })
}

function field(row: unknown, id: string, type: string) {
  const matches = Object.values(property(property(row).properties))
    .map(property)
    .filter((item) => item.id === id)
  if (matches.length !== 1 || matches[0]?.type !== type)
    throw fail("CURRENT_SOURCE_INVALID", "A current Source property is missing or ambiguous.", {
      property_id: id,
    })
  return matches[0]
}

function rich(row: unknown, id: string): string {
  const value = field(row, id, "rich_text")
  if (!Array.isArray(value.rich_text) || value.has_more === true || value.rich_text.length > 100)
    throw fail("CURRENT_SOURCE_INCOMPLETE", "A current Source text property is incomplete.")
  return value.rich_text
    .map((item) => {
      const part = property(item)
      const text =
        typeof part.plain_text === "string" ? part.plain_text : property(part.text).content
      if (typeof text !== "string" || text.length > 2000)
        throw fail("CURRENT_SOURCE_INCOMPLETE", "A current Source text fragment is incomplete.")
      return text
    })
    .join("")
}

function sourceProperties(library: SharedLibrary) {
  const table = library.sources
  if (table === undefined)
    throw fail("CURRENT_SOURCE_REQUIRED", "Attach the current Sources table before consumption.", {
      next: "migrate_current_content",
    })
  const required = [
    "Source ID",
    "Content",
    "Enabled",
    "Status",
    "Operation",
    "Last Revision",
  ] as const
  for (const name of required)
    if (!table.property_ids[name])
      throw fail("CURRENT_SOURCE_REQUIRED", "The current Source property binding is missing.", {
        property: name,
        next: "migrate_current_content",
      })
  return { table, ids: required.map((name) => table.property_ids[name]!) }
}

/** Query only selected stable Sources, then admit their complete current plans.
 * Selection/exclusion management belongs to the Source writer. This reader does
 * not advance a provider, infer a contribution, or repair current rows. */
export function resolveCurrentSharedSources(
  library: SharedLibrary,
  input: {
    readonly selections: readonly CurrentSharedSourceSelection[]
    readonly sourceOptions?: SharedSourcePlanOptions
  },
) {
  return Effect.gen(function* () {
    const selections = yield* checked(() => {
      const unique = new Map<string, string>()
      for (const selection of input.selections) {
        validateCurrentSourceId(selection.source_id)
        if (!/^[a-f0-9]{64}$/u.test(selection.revision))
          throw fail("CURRENT_SOURCE_INVALID", "Select an exact current Source fingerprint.")
        const previous = unique.get(selection.source_id)
        if (previous !== undefined && previous !== selection.revision)
          throw fail(
            "SHARED_SOURCE_CONFLICT",
            "One current Source cannot have two selected revisions.",
          )
        unique.set(selection.source_id, selection.revision)
      }
      return unique
    })
    if (selections.size === 0) return new Map<string, CurrentSharedSource>()
    const { table, ids } = yield* checked(() => sourceProperties(library))
    const sourceIdProperty = table.property_ids["Source ID"]!
    const sourceIds = [...selections.keys()].sort()
    const api = yield* Notion
    const pages = new Map<string, unknown>()
    const physical = new Set<string>()
    const query = new URLSearchParams()
    for (const id of new Set(ids)) query.append("filter_properties", id)
    // Keep each Notion compound filter below its child limit. The invocation's
    // existing request budget includes every batch and pagination request.
    for (let offset = 0; offset < sourceIds.length; offset += 80) {
      const batch = sourceIds.slice(offset, offset + 80)
      const filters = batch.map((id) => ({ property: sourceIdProperty, rich_text: { equals: id } }))
      const cursors = new Set<string>()
      let cursor: string | undefined
      for (;;) {
        const raw = yield* api.request(
          `v1/data_sources/${table.data_source_id}/query?${query}`,
          {
            page_size: 100,
            filter: filters.length === 1 ? filters[0] : { or: filters },
            ...(cursor === undefined ? {} : { start_cursor: cursor }),
          },
          { method: "POST" },
        )
        const list = yield* checked(() => {
          const envelope = property(raw)
          if (
            envelope.object !== "list" ||
            (envelope.request_status !== undefined &&
              property(envelope.request_status).type !== "complete")
          )
            throw fail("CURRENT_SOURCE_INCOMPLETE", "Current Sources enumeration is incomplete.")
          const result = Schema.decodeUnknownSync(listSchema(Schema.Unknown))(raw)
          if (
            (!result.has_more && result.next_cursor !== null) ||
            (result.has_more && (!result.next_cursor || cursors.has(result.next_cursor)))
          )
            throw fail("CURRENT_SOURCE_INCOMPLETE", "Current Sources pagination did not advance.")
          for (const value of result.results) {
            const row = property(value)
            const parent = property(row.parent)
            const id = typeof row.id === "string" ? pageId(row.id) : undefined
            if (
              row.object !== "page" ||
              id === undefined ||
              row.in_trash === true ||
              row.archived === true ||
              physical.has(id) ||
              parent.type !== "data_source_id" ||
              parent.data_source_id !== table.data_source_id ||
              (parent.database_id !== undefined && parent.database_id !== table.database_id)
            )
              throw fail("CURRENT_SOURCE_INVALID", "A selected Source page is foreign or repeated.")
            const sourceId = validateCurrentSourceId(rich(value, sourceIdProperty))
            if (!batch.includes(sourceId))
              throw fail(
                "CURRENT_SOURCE_INVALID",
                "The query returned an unselected current Source.",
              )
            if (pages.has(sourceId))
              throw fail(
                "CURRENT_SOURCE_DUPLICATE",
                "Several current rows claim one stable Source ID.",
                {
                  source_id: sourceId,
                },
              )
            physical.add(id)
            pages.set(sourceId, value)
          }
          return result
        })
        if (!list.has_more) break
        cursor = list.next_cursor!
        cursors.add(cursor)
      }
    }
    // No provider or machine materialization is admitted until every selected
    // Source has one complete, current, enabled row and a matching fingerprint.
    const currents = []
    for (const [sourceId, expectedRevision] of selections) {
      const raw = pages.get(sourceId)
      if (raw === undefined)
        return yield* Effect.fail(
          fail("SHARED_SOURCE_MISSING", "The selected current Source is unavailable.", {
            source_id: sourceId,
            next: "reselect_current",
          }),
        )
      const current = yield* checked(() => {
        const enabled = field(raw, table.property_ids.Enabled!, "checkbox").checkbox
        if (typeof enabled !== "boolean")
          throw fail("CURRENT_SOURCE_INVALID", "The current Source enablement is invalid.")
        if (!enabled)
          throw fail("SOURCE_DISABLED", "The selected current Source is disabled.", {
            source_id: sourceId,
          })
        const status = property(field(raw, table.property_ids.Status!, "select").select).name
        if (typeof status !== "string")
          throw fail("CURRENT_SOURCE_INVALID", "The current Source has no state.")
        const state = parseCurrentSkillState(status, rich(raw, table.property_ids.Operation!))
        if (state.state !== "ready")
          throw fail(
            "CURRENT_SOURCE_NOT_READY",
            "The selected Source requires management attention.",
            {
              source_id: sourceId,
              status,
            },
          )
        const serialized = rich(raw, table.property_ids.Content!)
        boundedContent(serialized)
        const content = validateCurrentSharedSourceContent(JSON.parse(serialized))
        const revision = rich(raw, table.property_ids["Last Revision"]!)
        return { source_id: sourceId, page_id: String(property(raw).id), content, revision }
      })
      const revision = yield* currentSharedSourceRevision(current.content)
      if (current.revision !== revision || expectedRevision !== revision)
        return yield* Effect.fail(
          fail("SHARED_SOURCE_CONFLICT", "The current Source differs from the selected revision.", {
            source_id: sourceId,
            next: "reselect_current",
          }),
        )
      currents.push({ ...current, revision })
    }
    const plans = []
    for (const current of currents) {
      const plan = yield* currentSourcePlan(library, current)
      plans.push({ ...current, plan })
    }
    const localRequired = plans.some(
      ({ plan }) =>
        plan.base?.kind === "local" || plan.mounts.some((mount) => mount.resource.kind === "local"),
    )
    const options = input.sourceOptions ?? (yield* loadSharedSourceOptions({ localRequired }))
    const selectedOptions = { ...options, metrics: api.metrics ?? options.metrics }
    const result = new Map<string, CurrentSharedSource>()
    for (const current of plans) {
      const inspection = yield* admitSharedSourcePlan(current.plan, selectedOptions)
      const manifest = inspection.manifest.map(
        (file): CurrentSharedSourceFile => ({
          path: file.path,
          sha256: file.identity.sha256!,
          bytes: file.bytes,
          mode: file.mode ?? "100644",
          ...(file.identity.kind === "git" ? { git_oid: file.identity.git_oid } : {}),
        }),
      )
      result.set(current.source_id, {
        source_id: current.source_id,
        revision: current.revision,
        page_id: current.page_id,
        manifest,
        local_paths: inspection.local_paths,
        ...(inspection.plan.base?.kind === "git" && inspection.plan.mounts.length === 0
          ? {
              git_origin: {
                url: inspection.plan.base.source.url,
                commit: inspection.plan.base.source.commit,
              },
            }
          : {}),
        materialize: (paths) =>
          materializeSharedSourcePlan(inspection.plan, selectedOptions, paths).pipe(
            Effect.map((materialized) => ({
              files: materialized.files.map((file) => ({ ...file, mode: file.mode ?? "100644" })),
              local_paths: materialized.local_paths,
            })),
          ),
      })
    }
    return result
  })
}
