import { Effect, Schema } from "effect"
import { fail, SkillsError } from "./model.ts"
import { pageId } from "./ref.ts"
import { canonicalManagementPath } from "./shared-file-management-model.ts"
import {
  FileEventSchema,
  ResourceContentSchema,
  ResourceFollowingEventSchema,
  type FileEvent,
} from "./shared-file-state.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256 } from "./store.ts"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const Identity = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u))
export const SharedResourceAuthoringPlanSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("resource_authoring"),
  action: Schema.Literals(["add", "replace", "delete", "move", "restore", "undelete"]),
  operation_id: Identity,
  library_id: Identity,
  skill_id: Identity,
  skill_page_id: Schema.String,
  file_id: Identity,
  page_id: Schema.NullOr(Schema.String),
  path: Schema.String,
  destination_path: Schema.NullOr(Schema.String),
  source_path: Schema.NullOr(Schema.String),
  entrypoint: Schema.String,
  source_id: Schema.String,
  source_revision: Schema.String,
  snapshot_id: Schema.String,
  snapshot_version_id: Hash,
  snapshot_scope: Hash,
  tree_sha256: Hash,
  metadata_sha256: Hash,
  events_sha256: Hash,
  prior_pin: Schema.String,
  before: Schema.NullOr(ResourceContentSchema),
  baseline: Schema.NullOr(ResourceFollowingEventSchema),
  content: ResourceContentSchema,
  reference_check: Schema.Struct({
    checked_files: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
    local_references: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  }),
  event: FileEventSchema,
})
export type SharedResourceAuthoringPlan = typeof SharedResourceAuthoringPlanSchema.Type
export const resourceAuthoringOutcomesEntity = "resource-authoring-outcomes-v1"
export const resourceAuthoringOutcomeId = (operationId: string) => `outcome-${operationId}`
export const SharedResourceAuthoringOutcomeSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("resource_authoring_outcome"),
  operation_id: Identity,
  file_id: Identity,
  status: Schema.Literals(["applied", "not_sent", "rejected", "needs_review"]),
  reason_code: Schema.String,
  page_id: Schema.NullOr(Schema.String),
  entry_block_id: Schema.NullOr(Schema.String),
  event_id: Schema.NullOr(Identity),
})
export type SharedResourceAuthoringOutcome = typeof SharedResourceAuthoringOutcomeSchema.Type
export const resourceAuthoringProtection = {
  storage: "notion_exact_byte_records",
  original_bytes_retained: true,
  previous_snapshot_retained: true,
  management_body_overwrite: false,
  executes_input: false,
  automatic_retry: false,
  original_operation_reconcile: "read_only",
} as const
export const resourceAuthoringChecked = <A>(action: () => A) =>
  Effect.try({
    try: action,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("SHARED_RESOURCE_AUTHORING_INVALID", "The original resource operation is invalid."),
  })
function eventDescription(event: FileEvent) {
  const { event_id: _event, ...fields } = event
  return { version: 1, ...fields }
}
export function plannedResourceEventId(operationId: string): string | undefined {
  const matched =
    /^resource-authoring-(?:add|replace|delete|move|restore|undelete)-([a-f0-9]{64})\.[a-f0-9]{64}$/u.exec(
      operationId,
    )
  return matched === null ? undefined : `resource-${matched[1]}`
}
export function validateSharedResourceAuthoringPlan(input: unknown) {
  return Effect.gen(function* () {
    const plan = yield* resourceAuthoringChecked(() =>
      Schema.decodeUnknownSync(SharedResourceAuthoringPlanSchema)(structuredClone(input), {
        onExcessProperty: "error",
      }),
    )
    yield* resourceAuthoringChecked(() => {
      if (
        pageId(plan.skill_page_id) !== plan.skill_page_id ||
        (plan.page_id !== null && pageId(plan.page_id) !== plan.page_id)
      )
        throw fail(
          "SHARED_RESOURCE_AUTHORING_INVALID",
          "Resource authoring requires exact Notion identities.",
        )
      canonicalManagementPath(plan.path)
      canonicalManagementPath(plan.entrypoint)
      if (plan.destination_path !== null) canonicalManagementPath(plan.destination_path)
      if (plan.source_path !== null) canonicalManagementPath(plan.source_path)
      if (
        plan.path === plan.entrypoint ||
        plan.destination_path === plan.entrypoint ||
        plan.page_id === plan.skill_page_id ||
        /\.(md|markdown)$/iu.test(plan.path) ||
        (plan.destination_path !== null && /\.(md|markdown)$/iu.test(plan.destination_path))
      )
        throw fail(
          "SHARED_MAIN_FILE_PROTECTED",
          "Markdown remains an editable body; select a supporting non-document resource.",
        )
      if (
        !/^s_[a-f0-9]{64}$/u.test(plan.snapshot_id) ||
        !/^snapshot-[a-f0-9]{64}$/u.test(plan.prior_pin) ||
        (plan.source_id === "") !== (plan.source_revision === "")
      )
        throw fail(
          "SHARED_RESOURCE_AUTHORING_INVALID",
          "The frozen original source or snapshot identity is invalid.",
        )
      if (
        (plan.action === "add" &&
          (plan.before !== null || plan.page_id !== null || plan.baseline !== null)) ||
        (plan.action !== "add" && plan.before === null)
      )
        throw fail(
          "SHARED_RESOURCE_AUTHORING_INVALID",
          "Adding and replacing require distinct complete prior-state evidence.",
        )
      if (
        (plan.action === "move") !== (plan.destination_path !== null) ||
        plan.destination_path === plan.path
      )
        throw fail(
          "SHARED_RESOURCE_AUTHORING_INVALID",
          "A move requires one distinct exact destination path.",
        )
      if (plan.baseline !== null) {
        if (
          plan.page_id !== null ||
          plan.before === null ||
          plan.baseline.file_id !== plan.file_id ||
          plan.baseline.parents.length !== 0 ||
          plan.baseline.retained !== null ||
          plan.baseline.path !== plan.path ||
          plan.baseline.source_path !== plan.source_path ||
          plan.baseline.source_id !== plan.source_id ||
          plan.baseline.source_revision !== plan.source_revision ||
          canonicalSharedJson(plan.baseline.content) !== canonicalSharedJson(plan.before) ||
          canonicalSharedJson(plan.event.parents) !== canonicalSharedJson([plan.baseline.event_id])
        )
          throw fail(
            "SHARED_RESOURCE_AUTHORING_INVALID",
            "The initial raw source baseline must bind the exact original source bytes and path.",
          )
      } else if (plan.page_id === null && plan.action !== "add")
        throw fail(
          "SHARED_RESOURCE_AUTHORING_INVALID",
          "A source-only resource mutation requires its original source baseline.",
        )
      if (
        plan.event.file_id !== plan.file_id ||
        new Set(plan.event.parents).size !== plan.event.parents.length ||
        canonicalSharedJson(plan.event.parents) !==
          canonicalSharedJson([...plan.event.parents].sort())
      )
        throw fail(
          "SHARED_RESOURCE_AUTHORING_INVALID",
          "Resource adoption requires the exact sorted prior event frontier.",
        )
      if (plan.page_id !== null && plan.event.parents.length === 0)
        throw fail(
          "SHARED_RESOURCE_AUTHORING_INVALID",
          "An existing resource requires its prior file frontier.",
        )
      if (plan.action === "add" && plan.event.parents.length !== 0)
        throw fail(
          "SHARED_RESOURCE_AUTHORING_INVALID",
          "A new absent resource cannot claim an earlier file frontier.",
        )
      switch (plan.action) {
        case "add":
        case "replace":
          if (
            plan.event.kind !== "adopted" ||
            canonicalSharedJson(plan.event.content) !== canonicalSharedJson(plan.content)
          )
            throw fail(
              "SHARED_RESOURCE_AUTHORING_INVALID",
              "The original adoption must select exactly the retained resource.",
            )
          break
        case "undelete":
          if (
            plan.page_id === null ||
            plan.event.kind !== "adopted" ||
            canonicalSharedJson(plan.event.content) !== canonicalSharedJson(plan.before) ||
            canonicalSharedJson(plan.content) !== canonicalSharedJson(plan.before)
          )
            throw fail(
              "SHARED_RESOURCE_AUTHORING_INVALID",
              "Undelete must restore the exact retained tombstone bytes as custom ownership.",
            )
          break
        case "delete":
          if (
            plan.event.kind !== "deleted" ||
            canonicalSharedJson(plan.event.retained) !== canonicalSharedJson(plan.before) ||
            canonicalSharedJson(plan.content) !== canonicalSharedJson(plan.before)
          )
            throw fail(
              "SHARED_RESOURCE_AUTHORING_INVALID",
              "Deletion must retain the exact prior resource.",
            )
          break
        case "move":
          if (
            plan.event.kind !== "moved" ||
            plan.event.from_path !== plan.path ||
            plan.event.to_path !== plan.destination_path ||
            plan.event.source_path !== plan.source_path ||
            canonicalSharedJson(plan.event.retained) !== canonicalSharedJson(plan.before) ||
            canonicalSharedJson(plan.content) !== canonicalSharedJson(plan.before)
          )
            throw fail(
              "SHARED_RESOURCE_AUTHORING_INVALID",
              "A move must preserve the exact bytes and original source path.",
            )
          break
        case "restore":
          if (
            plan.page_id === null ||
            plan.event.kind !== "resource_followed" ||
            plan.source_id === "" ||
            plan.source_path === null ||
            plan.event.source_id !== plan.source_id ||
            plan.event.source_revision !== plan.source_revision ||
            plan.event.path !== plan.path ||
            plan.event.source_path !== plan.source_path ||
            canonicalSharedJson(plan.event.retained) !== canonicalSharedJson(plan.before) ||
            canonicalSharedJson(plan.event.content) !== canonicalSharedJson(plan.content)
          )
            throw fail(
              "SHARED_RESOURCE_AUTHORING_INVALID",
              "Restore must select exact frozen source bytes while retaining prior ownership.",
            )
      }
    })
    if (
      plan.baseline !== null &&
      plan.baseline.event_id !==
        `resource-${yield* sha256(canonicalSharedJson(eventDescription(plan.baseline)))}`
    )
      return yield* Effect.fail(
        fail(
          "SHARED_RESOURCE_AUTHORING_INVALID",
          "The initial resource source event failed its identity.",
        ),
      )
    const eventHash = yield* sha256(canonicalSharedJson(eventDescription(plan.event)))
    const { operation_id: _operation, ...description } = plan
    if (
      plan.event.event_id !== `resource-${eventHash}` ||
      plan.operation_id !==
        `resource-authoring-${plan.action}-${eventHash}.${yield* sha256(canonicalSharedJson(description))}`
    )
      return yield* Effect.fail(
        fail(
          "SHARED_RESOURCE_AUTHORING_INVALID",
          "The original resource plan failed its content-derived identity.",
        ),
      )
    return plan
  })
}
type ResourceEvent = Extract<
  FileEvent,
  { kind: "adopted" | "deleted" | "moved" | "resource_followed" }
>
type WithoutEventId<T> = T extends FileEvent ? Omit<T, "event_id"> : never
export function identifyResourceEvent<T extends WithoutEventId<ResourceEvent>>(input: T) {
  return sha256(canonicalSharedJson({ version: 1, ...input })).pipe(
    Effect.map((hash) => ({ ...input, event_id: `resource-${hash}` })),
  )
}
export function makeSharedResourceAuthoringPlan(
  input: Omit<SharedResourceAuthoringPlan, "version" | "kind" | "operation_id" | "event"> & {
    readonly event: WithoutEventId<ResourceEvent>
  },
) {
  return Effect.gen(function* () {
    const eventHash = yield* sha256(canonicalSharedJson({ version: 1, ...input.event }))
    const description = {
      ...input,
      version: 1 as const,
      kind: "resource_authoring" as const,
      event: { ...input.event, event_id: `resource-${eventHash}` },
    }
    return yield* validateSharedResourceAuthoringPlan({
      ...description,
      operation_id: `resource-authoring-${input.action}-${eventHash}.${yield* sha256(canonicalSharedJson(description))}`,
    })
  })
}
