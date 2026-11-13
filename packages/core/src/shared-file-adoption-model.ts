import { Effect, Schema } from "effect"
import { fail, validateDisplayName } from "./model.ts"
import { pageId } from "./ref.ts"
import { nativeFileIdentity } from "./shared-native-adoption-model.ts"
import { NativeBodyCompletionSchema } from "./shared-native-body-completion.ts"
import { SharedLibrarySchema, type SharedLibrary } from "./shared-library-model.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { repairChecked, repairFactsDigest } from "./shared-native-repair-model.ts"
import { sha256 } from "./store.ts"

const Identity = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u))
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const Page = Schema.String
const ActorSchema = Schema.Struct({
  object: Schema.Literals(["user", "bot"]),
  id: Page,
})
const entrypoints = new Set(["SKILL.md", "ROUTER.md", "PROMPT.md"])
export const managedFileScopes = [
  "file_page",
  "owner_skill",
  "files",
  "records",
  "operations",
  "body",
] as const
export const managedFileOutcomeId = (operation: string) => `outcome-${operation}`

const FileFactsSchema = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  file_id: Schema.Literal(""),
  status: Schema.Literals(["following", "custom", "tombstone"]),
  projection: Schema.String,
  skill_page_id: Page,
  skill_id: Identity,
  owner_main_file_id: Schema.Union([Schema.Literal(""), Identity]),
  owner_enabled: Schema.Boolean,
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

export const ManagedFileAdoptionPlanSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("managed_file_adoption"),
  entry: Schema.Literal("managed-file"),
  operation_id: Schema.String.check(Schema.isPattern(/^skill-repair-file-[a-f0-9]{64}$/u)),
  library: SharedLibrarySchema,
  library_id: Identity,
  file_page_id: Page,
  skill_page_id: Page,
  skill_id: Identity,
  file_id: Identity,
  path: Schema.String,
  source: Schema.Struct({
    database_id: Page,
    data_source_id: Page,
    parent_type: Schema.Literal("data_source_id"),
  }),
  owner: Schema.Struct({
    skill_page_id: Page,
    skill_id: Identity,
  }),
  facts: FileFactsSchema,
  expected: Schema.Struct({
    file_id: Identity,
    enabled_unchanged: Schema.Literal(true),
    body_unchanged: Schema.Literal(true),
    page_recreated: Schema.Literal(false),
    notion_cas: Schema.Literal(false),
  }),
  preimage: PreimageSchema,
  scopes: Schema.Tuple([
    Schema.Literal("file_page"),
    Schema.Literal("owner_skill"),
    Schema.Literal("files"),
    Schema.Literal("records"),
    Schema.Literal("operations"),
    Schema.Literal("body"),
  ]),
})
export type ManagedFileAdoptionPlan = typeof ManagedFileAdoptionPlanSchema.Type

const controls = /[\u0000-\u001f\u007f-\u009f]/u
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u

function canonicalPage(value: string, label: string) {
  const id = pageId(value)
  if (id === undefined || id !== value)
    throw fail("REPAIR_SCOPE", `${label} is not a canonical Notion page ID.`, { value })
  return id
}

export function validateManagedFileAdoptionPlan(input: unknown) {
  return Effect.gen(function* () {
    const plan = yield* repairChecked(() =>
      Schema.decodeUnknownSync(ManagedFileAdoptionPlanSchema)(input, { onExcessProperty: "error" }),
    )
    const fileId = yield* nativeFileIdentity(plan.skill_id, plan.path)
    const factsDigest = yield* repairFactsDigest(plan.facts)
    yield* repairChecked(() => {
      if (
        entrypoints.has(plan.path) ||
        plan.path !== plan.facts.path ||
        controls.test(plan.path) ||
        plan.path.length === 0 ||
        plan.path.startsWith("/") ||
        plan.path.split("/").some((part) => part === "" || part === "." || part === "..") ||
        canonicalPage(plan.file_page_id, "File page") !== plan.file_page_id ||
        canonicalPage(plan.skill_page_id, "Owner") !== plan.owner.skill_page_id ||
        plan.skill_id !== plan.owner.skill_id ||
        plan.skill_id !== plan.facts.skill_id ||
        plan.skill_page_id !== plan.facts.skill_page_id ||
        plan.library_id !== plan.library.library_id ||
        plan.source.database_id !== plan.library.files.database_id ||
        plan.source.data_source_id !== plan.library.files.data_source_id ||
        plan.file_id !== fileId ||
        plan.expected.file_id !== fileId ||
        (plan.facts.owner_main_file_id !== "" &&
          !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u.test(plan.facts.owner_main_file_id)) ||
        plan.facts.file_id !== "" ||
        plan.preimage.properties_sha256 !== factsDigest ||
        !Number.isSafeInteger(plan.preimage.body_bytes) ||
        plan.preimage.body_bytes < 0 ||
        !timestamp.test(plan.preimage.created_time) ||
        !timestamp.test(plan.preimage.last_edited_time) ||
        controls.test(plan.preimage.url) ||
        !plan.preimage.url.startsWith("https://") ||
        plan.preimage.url.length > 500 ||
        !plan.preimage.url.toLowerCase().includes(plan.file_page_id.replaceAll("-", "")) ||
        canonicalPage(plan.preimage.created_by.id, "created_by") !== plan.preimage.created_by.id ||
        canonicalPage(plan.preimage.last_edited_by.id, "last_edited_by") !==
          plan.preimage.last_edited_by.id ||
        validateDisplayName(plan.facts.name) !== plan.facts.name
      )
        throw fail(
          "REPAIR_PARTIAL",
          "The frozen file adoption does not describe one unregistered Files row and its owner.",
          { page_id: plan.file_page_id, owner: plan.skill_page_id },
        )
    })
    const { operation_id, ...description } = plan
    if (operation_id !== `skill-repair-file-${yield* sha256(canonicalSharedJson(description))}`)
      return yield* Effect.fail(
        fail("REPAIR_PARTIAL", "The file adoption operation differs from its frozen input.", {
          page_id: plan.file_page_id,
        }),
      )
    return plan
  })
}

export function makeManagedFileAdoptionPlan(input: {
  readonly library: SharedLibrary
  readonly filePageId: string
  readonly facts: ManagedFileAdoptionPlan["facts"]
  readonly preimage: Omit<ManagedFileAdoptionPlan["preimage"], "properties_sha256">
}) {
  return Effect.gen(function* () {
    const file_id = yield* nativeFileIdentity(input.facts.skill_id, input.facts.path)
    const description = {
      version: 1 as const,
      kind: "managed_file_adoption" as const,
      entry: "managed-file" as const,
      library: input.library,
      library_id: input.library.library_id,
      file_page_id: input.filePageId,
      skill_page_id: input.facts.skill_page_id,
      skill_id: input.facts.skill_id,
      file_id,
      path: input.facts.path,
      source: {
        database_id: input.library.files.database_id,
        data_source_id: input.library.files.data_source_id,
        parent_type: "data_source_id" as const,
      },
      owner: { skill_page_id: input.facts.skill_page_id, skill_id: input.facts.skill_id },
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
      scopes: managedFileScopes,
    }
    return yield* validateManagedFileAdoptionPlan({
      ...description,
      operation_id: `skill-repair-file-${yield* sha256(canonicalSharedJson(description))}`,
    })
  })
}
