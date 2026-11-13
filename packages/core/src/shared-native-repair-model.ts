import { Effect, Schema } from "effect"
import { fail, property, SkillsError, validateDescription, validateDisplayName } from "./model.ts"
import { pageId } from "./ref.ts"
import { nativeFileIdentity } from "./shared-native-adoption-model.ts"
import { NativeBodyCompletionSchema } from "./shared-native-body-completion.ts"
import { SharedLibrarySchema, type SharedLibrary } from "./shared-library-model.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256 } from "./store.ts"

const Identity = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u))
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const Page = Schema.String
const ActorSchema = Schema.Struct({
  object: Schema.Literals(["user", "bot"]),
  id: Page,
})
const PreimageSchema = Schema.Struct({
  url: Schema.String,
  created_time: Schema.String,
  last_edited_time: Schema.String,
  created_by: ActorSchema,
  last_edited_by: ActorSchema,
  body_sha256: Digest,
  body_bytes: Schema.Number,
  body_completion: Schema.NullOr(NativeBodyCompletionSchema),
  properties_sha256: Digest,
  untouched_properties_sha256: Schema.optional(Digest),
})
const SkillFactsSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  kind: Schema.Literals(["skill", "router", "prompt"]),
  enabled: Schema.Boolean,
  default_context: Schema.Boolean,
  skill_id: Identity,
  main_file_id: Schema.Literal(""),
  source: Schema.String,
  projection: Schema.String,
  references: Schema.String,
  members: Schema.NullOr(Schema.Array(Page)),
  requires: Schema.NullOr(Schema.Array(Page)),
})
export const historicalRepairScopes = [
  "skill_page",
  "skill_inventory",
  "files",
  "records",
  "operations",
  "body",
] as const
export const repairProtection = {
  original_page_preserved: true,
  original_url_preserved: true,
  body_writes: false,
  author_metadata_preserved: true,
  enabled_preserved: true,
  automatic_retry: false,
  metadata_compare_and_swap: false,
  notion_cas: false,
  blanket_repair: false,
} as const
export const nativeRepairEntity = "native-repair-v1"
export const historicalRepairOutcomeId = (operation: string) => `outcome-${operation}`

export const HistoricalMissingMainPlanSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("historical_missing_main"),
  entry: Schema.Literal("historical-missing-main"),
  operation_id: Schema.String.check(Schema.isPattern(/^skill-repair-main-[a-f0-9]{64}$/u)),
  library: SharedLibrarySchema,
  library_id: Identity,
  skill_page_id: Page,
  skill_id: Identity,
  file_id: Identity,
  entrypoint: Schema.Literals(["SKILL.md", "ROUTER.md", "PROMPT.md"]),
  source: Schema.Struct({
    database_id: Page,
    data_source_id: Page,
    parent_type: Schema.Literal("data_source_id"),
  }),
  owner: Schema.Struct({
    skill_page_id: Page,
    skill_id: Identity,
  }),
  facts: SkillFactsSchema,
  expected: Schema.Struct({
    file_id: Identity,
    enabled_unchanged: Schema.Literal(true),
    body_unchanged: Schema.Literal(true),
    page_recreated: Schema.Literal(false),
    notion_cas: Schema.Literal(false),
  }),
  preimage: PreimageSchema,
  scopes: Schema.Tuple([
    Schema.Literal("skill_page"),
    Schema.Literal("skill_inventory"),
    Schema.Literal("files"),
    Schema.Literal("records"),
    Schema.Literal("operations"),
    Schema.Literal("body"),
  ]),
})
export type HistoricalMissingMainPlan = typeof HistoricalMissingMainPlanSchema.Type

const controls = /[\u0000-\u001f\u007f-\u009f]/u

/** Notion can retain a 32-byte NUL buffer for a blank rich-text identity. It is not a legal ID. */
export function blankRepairBinding(value: string) {
  return value === "" || value === "\u0000".repeat(32)
}

export function pendingRepairHeaders(
  skillPageId: string,
  headers: readonly {
    readonly record_id: string
    readonly entity_id: string
    readonly page_id?: string
  }[],
) {
  const ids = new Set(headers.map((header) => header.record_id))
  const pending: {
    readonly operation_id: string
    readonly entry: "historical-missing-main" | "managed-file"
    readonly record_id: string
    readonly skill_page_id: string
  }[] = []
  for (const header of headers) {
    if (header.entity_id !== nativeRepairEntity || header.record_id.startsWith("outcome-")) continue
    const operationId = header.record_id
    const entry = operationId.startsWith("skill-repair-main-")
      ? ("historical-missing-main" as const)
      : operationId.startsWith("skill-repair-file-")
        ? ("managed-file" as const)
        : undefined
    if (
      entry === undefined ||
      !/^skill-repair-(?:main|file)-[a-f0-9]{64}$/u.test(operationId) ||
      ids.has(`outcome-${operationId}`)
    )
      continue
    pending.push({
      operation_id: operationId,
      entry,
      record_id: operationId,
      skill_page_id: skillPageId,
    })
  }
  return pending
}
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u

export function repairChecked<A>(action: () => A) {
  return Effect.try({
    try: action,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("REPAIR_PARTIAL", "Invalid historical repair input or retained facts."),
  })
}

export function repairFactsDigest(facts: unknown) {
  return sha256(canonicalSharedJson(facts))
}

/** The nominated identity is the only editable property excluded. Server-derived
 * timestamps/formulas are observations, not author-controlled content. */
export function repairUntouchedPropertiesDigest(raw: unknown, identityProperty: string) {
  return Effect.gen(function* () {
    const fields = yield* repairChecked(() =>
      Object.entries(property(property(raw).properties))
        .flatMap(([name, value]) => {
          const field = property(value),
            id = typeof field.id === "string" ? field.id : name
          if (id === identityProperty) return []
          if (typeof field.type !== "string" || field.type === "")
            throw fail("REPAIR_PARTIAL", "An existing property has no observable type.", {
              property: name,
            })
          if (
            [
              "created_time",
              "created_by",
              "last_edited_time",
              "last_edited_by",
              "formula",
              "rollup",
              "button",
              "unique_id",
            ].includes(field.type)
          )
            return []
          if (field.has_more === true)
            throw fail("REPAIR_PARTIAL", "An untouched property is incompletely observed.", {
              property: name,
              property_id: id,
            })
          return [{ id, type: field.type, value: field[field.type] ?? null }]
        })
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
    )
    return yield* sha256(canonicalSharedJson(fields))
  })
}

function canonicalPage(value: string, label: string) {
  const id = pageId(value)
  if (id === undefined || id !== value)
    throw fail("REPAIR_SCOPE", `${label} is not a canonical Notion page ID.`, { value })
  return id
}

function actor(value: { readonly object: "user" | "bot"; readonly id: string }, label: string) {
  return { object: value.object, id: canonicalPage(value.id, label) }
}

export function validateHistoricalMissingMainPlan(input: unknown) {
  return Effect.gen(function* () {
    const plan = yield* repairChecked(() =>
      Schema.decodeUnknownSync(HistoricalMissingMainPlanSchema)(input, {
        onExcessProperty: "error",
      }),
    )
    const fileId = yield* nativeFileIdentity(plan.skill_id, plan.entrypoint)
    const factsDigest = yield* repairFactsDigest(plan.facts)
    yield* repairChecked(() => {
      const entrypoint = { skill: "SKILL.md", router: "ROUTER.md", prompt: "PROMPT.md" }[
        plan.facts.kind
      ]
      if (
        canonicalPage(plan.skill_page_id, "Skill page") !== plan.skill_page_id ||
        canonicalPage(plan.source.database_id, "Database") !== plan.library.skills.database_id ||
        canonicalPage(plan.source.data_source_id, "Data source") !==
          plan.library.skills.data_source_id ||
        plan.library_id !== plan.library.library_id ||
        plan.skill_id !== plan.facts.skill_id ||
        plan.skill_id !== plan.owner.skill_id ||
        plan.skill_page_id !== plan.owner.skill_page_id ||
        plan.file_id !== fileId ||
        plan.expected.file_id !== fileId ||
        plan.entrypoint !== entrypoint ||
        plan.facts.main_file_id !== "" ||
        plan.preimage.properties_sha256 !== factsDigest ||
        plan.preimage.body_bytes < 0 ||
        !Number.isSafeInteger(plan.preimage.body_bytes) ||
        !timestamp.test(plan.preimage.created_time) ||
        !timestamp.test(plan.preimage.last_edited_time) ||
        !Number.isFinite(Date.parse(plan.preimage.created_time)) ||
        !Number.isFinite(Date.parse(plan.preimage.last_edited_time)) ||
        controls.test(plan.preimage.url) ||
        !plan.preimage.url.startsWith("https://") ||
        plan.preimage.url.length > 500 ||
        !plan.preimage.url.toLowerCase().includes(plan.skill_page_id.replaceAll("-", "")) ||
        actor(plan.preimage.created_by, "created_by").id !== plan.preimage.created_by.id ||
        actor(plan.preimage.last_edited_by, "last_edited_by").id !==
          plan.preimage.last_edited_by.id ||
        validateDisplayName(plan.facts.name) !== plan.facts.name ||
        validateDescription(plan.facts.description) !== plan.facts.description ||
        plan.facts.members?.some((id) => canonicalPage(id, "Members") !== id) ||
        plan.facts.requires?.some((id) => canonicalPage(id, "Requires") !== id)
      )
        throw fail(
          "REPAIR_PARTIAL",
          "The frozen historical repair does not describe one original page and its blank main binding.",
          { page_id: plan.skill_page_id },
        )
    })
    const { operation_id, ...description } = plan
    if (operation_id !== `skill-repair-main-${yield* sha256(canonicalSharedJson(description))}`)
      return yield* Effect.fail(
        fail("REPAIR_PARTIAL", "The repair operation differs from its frozen input.", {
          page_id: plan.skill_page_id,
        }),
      )
    return plan
  })
}

export function makeHistoricalMissingMainPlan(input: {
  readonly library: SharedLibrary
  readonly skillPageId: string
  readonly entrypoint: HistoricalMissingMainPlan["entrypoint"]
  readonly facts: HistoricalMissingMainPlan["facts"]
  readonly preimage: Omit<HistoricalMissingMainPlan["preimage"], "properties_sha256">
}) {
  return Effect.gen(function* () {
    const file_id = yield* nativeFileIdentity(input.facts.skill_id, input.entrypoint)
    const description = {
      version: 1 as const,
      kind: "historical_missing_main" as const,
      entry: "historical-missing-main" as const,
      library: input.library,
      library_id: input.library.library_id,
      skill_page_id: input.skillPageId,
      skill_id: input.facts.skill_id,
      file_id,
      entrypoint: input.entrypoint,
      source: {
        database_id: input.library.skills.database_id,
        data_source_id: input.library.skills.data_source_id,
        parent_type: "data_source_id" as const,
      },
      owner: { skill_page_id: input.skillPageId, skill_id: input.facts.skill_id },
      facts: input.facts,
      expected: {
        file_id,
        enabled_unchanged: true as const,
        body_unchanged: true as const,
        page_recreated: false as const,
        notion_cas: false as const,
      },
      preimage: {
        ...input.preimage,
        properties_sha256: yield* repairFactsDigest(input.facts),
      },
      scopes: historicalRepairScopes,
    }
    return yield* validateHistoricalMissingMainPlan({
      ...description,
      operation_id: `skill-repair-main-${yield* sha256(canonicalSharedJson(description))}`,
    })
  })
}
