import { Crypto, Effect, Schema } from "effect"
import { authScope } from "./catalog.ts"
import { invalidateSnapshotCache, invalidateSubscriptionCatalog } from "./cache.ts"
import {
  aliasFor,
  decode,
  fail,
  listSchema,
  property,
  text,
  SkillsError,
  type SharedSkillRecord,
  type Source,
} from "./model.ts"
import { Notion } from "./notion.ts"
import { withReadOnlyNotion } from "./notion-readonly.ts"
import type { PortableSkill } from "./portable.ts"
import { pageId, parseTarget } from "./ref.ts"
import {
  sharedMetadataEntryFromPage,
  sharedRecordFromPage,
  sharedSkillId,
  sharedSkillProperty,
} from "./shared-content.ts"
import {
  FileEventSchema,
  normalizeObservedBody,
  resolveFileState,
  type FileEvent,
} from "./shared-file-state.ts"
import { loadSharedLibrary, type SharedLibrary } from "./shared-library.ts"
import { preservesSharedLibraryBindings } from "./shared-library-model.ts"
import { querySharedOperationIndex, type SharedOperationHeader } from "./shared-operation-index.ts"
import { appendSharedRecord, canonicalSharedJson, querySharedRecords } from "./shared-records.ts"
import { querySharedSkillIndex } from "./shared-skill-index.ts"
import {
  completeSharedSkillRelationIds,
  type SharedSkillRelationField,
} from "./shared-router-members.ts"
import { sha256, Store } from "./store.ts"
import { sharedNotionMarkdownWire } from "./shared-notion-projection.ts"
import { projectSharedNotionMarkdown } from "./shared-notion-projection.ts"
import { assertImportedMarkdownContent } from "./shared-import-markdown.ts"
import {
  retainSharedResourceContent,
  loadSharedResourceContent,
  prepareSharedResourceContent,
} from "./shared-resource-content.ts"
import { sharedCreateResourceDescription } from "./shared-create-resources.ts"
import { sharedCreateDispatch } from "./shared-create-dispatch.ts"
import { resolveSharedCreateSource } from "./shared-create-source.ts"
import {
  acceptsNativeImportReadback,
  observeNativeImportFile,
  restoreNativeImportReadbacks,
} from "./shared-create-import-readback.ts"
import {
  loadSharedCreateRetained,
  retainSharedCreateSource,
  verifySharedCreateRetained,
} from "./shared-create-retained.ts"
import {
  decodeSharedCreateOutcome as decodeOutcome,
  sharedCreateOutcomeId as outcomeId,
  sharedCreateManifestRecordHash as createManifestRecordHash,
  type SharedCreateOutcome as Outcome,
  type SharedCreateBinding as Binding,
} from "./shared-create-outcome.ts"
import { completedSharedCreateRecovery } from "./shared-create-recovery-completion.ts"
import { completedSharedCreatePrefixRecovery } from "./shared-create-recovery-prefix-completion.ts"
import { readSharedCreateNativeCompletion } from "./shared-create-recovery-native-completion.ts"
import { saveSharedCreateOwnership } from "./shared-create-ownership.ts"
import {
  validateRetainedMigrationConversion,
  validateSharedMigrationConversion,
  type SharedMigrationConversionCandidate,
} from "./shared-migration-conversion.ts"
import {
  restoreSharedMigrationCreateOrigin,
  sharedMigrationOriginObjects,
  type MigrationMemberBinding,
} from "./shared-migration-create-origin.ts"
import { registerSourceBinding, resolveSourceBinding } from "./shared-source-binding.ts"
import { readSourceDefinition, listSourceMembers } from "./shared-source-definitions.ts"
import { readSharedFileSourceContext } from "./shared-file-source-context.ts"
import {
  createChecked,
  makeSharedCreatePlan,
  makeSharedMigrationCreatePlan,
  SharedCreateJournalSchema,
  SharedCreateManifestSchema,
  sharedCreateBodyPayload,
  sharedCreateInputPayload,
  sharedCreateManifest,
  sharedCreateManifestEntity,
  sharedCreateOutcomesEntity,
  sharedCreateProtection,
  sharedCreateProjectionVersion,
  sharedCreateExpectations,
  sharedCreateFixedSource,
  sharedCreateFixedSources,
  sharedCreateEnabled,
  sharedCreateFiles,
  sharedCreateEvents,
  validateSharedCreatePlan,
  type SharedCreatePlan,
  type SharedCreateInput,
} from "./shared-create-model.ts"
export {
  SharedCreatePlanSchema,
  sharedCreateProtection,
  type SharedCreatePlan,
} from "./shared-create-model.ts"

const InventorySchema = listSchema(Schema.Unknown)
const MarkdownSchema = Schema.Struct({
  id: Schema.String,
  markdown: Schema.String,
  truncated: Schema.Boolean,
  unknown_block_ids: Schema.Array(Schema.String),
  warnings: Schema.optional(Schema.Array(Schema.Unknown)),
})
const InputObjectSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("utf8_input"),
  text: Schema.String,
})
type Inventory = readonly { readonly raw: unknown; readonly record: SharedSkillRecord }[]

function sourceFor(library: SharedLibrary): Source {
  return {
    alias: library.library_id,
    title: "",
    role: "content",
    database_id: library.skills.database_id,
    data_source_ids: [library.skills.data_source_id],
    shared_library: library,
  }
}
function recover(error: SkillsError, plan: SharedCreatePlan, stage: string, page?: string) {
  return fail(error.code, error.message, {
    ...property(error.details),
    native_create_operation_id: plan.operation_id,
    skill_id: plan.skill_id,
    ...(page === undefined ? {} : { skill_page_id: page }),
    stage,
    protection: sharedCreateProtection,
    recovery: { mode: "reconcile", plan },
    ...(stage === "create_skill" ? { first_page_visibility_boundary: true } : {}),
  })
}
export function sharedCreateJournalKey(scope: string, libraryId: string, operationId: string) {
  return Effect.gen(function* () {
    if (!/^[a-f0-9]{64}$/u.test(scope) || !/^skill-create-[a-f0-9]{64}$/u.test(operationId))
      return yield* Effect.fail(
        fail(
          "SHARED_CREATE_INVALID",
          "A native creation journal requires exact scope and original operation identities.",
        ),
      )
    return `operations/shared-native-create/${yield* sha256(canonicalSharedJson([scope, libraryId]))}/${operationId}.json`
  })
}
/** Derived replay barriers only. These never establish remote completion or ownership. */
export function pendingSharedCreatePlans(scope: string, libraryId: string, skillId?: string) {
  return Effect.gen(function* () {
    if (!/^[a-f0-9]{64}$/u.test(scope))
      return yield* Effect.fail(
        fail(
          "SHARED_CREATE_INVALID",
          "A native pending lookup requires an exact authentication scope.",
        ),
      )
    const store = yield* Store,
      namespace = yield* sha256(canonicalSharedJson([scope, libraryId]))
    const prefix = `operations/shared-native-create/${namespace}/`,
      result: SharedCreatePlan[] = []
    for (const key of yield* store.listKeys(prefix)) {
      if (
        !new RegExp(
          `^operations/shared-native-create/${namespace}/skill-create-[a-f0-9]{64}\\.json$`,
          "u",
        ).test(key)
      )
        return yield* Effect.fail(
          fail("STATE_CORRUPT", "A native create dispatch has an invalid address."),
        )
      const journal = yield* store.readJson(key, SharedCreateJournalSchema)
      if (journal === undefined) continue
      if (
        journal.scope !== scope ||
        journal.library_id !== libraryId ||
        journal.plan.library.library_id !== libraryId ||
        key !== (yield* sharedCreateJournalKey(scope, libraryId, journal.plan.operation_id))
      )
        return yield* Effect.fail(
          fail("STATE_CORRUPT", "A native create dispatch differs from its exact local scope."),
        )
      if (skillId !== undefined && journal.plan.skill_id !== skillId) continue
      result.push(yield* validateSharedCreatePlan(journal.plan))
    }
    return result.sort((left, right) =>
      left.operation_id < right.operation_id ? -1 : left.operation_id > right.operation_id ? 1 : 0,
    )
  })
}
export function hasPendingSharedCreate(scope: string, libraryId: string, skillId: string) {
  return pendingSharedCreatePlans(scope, libraryId, skillId).pipe(
    Effect.map((plans) => plans.length !== 0),
  )
}
function guardOriginalCreate(scope: string, plan: SharedCreatePlan) {
  return Effect.gen(function* () {
    for (const original of yield* pendingSharedCreatePlans(scope, plan.library.library_id)) {
      if (original.skill_id !== plan.skill_id && aliasFor(original.name) !== aliasFor(plan.name))
        continue
      if (canonicalSharedJson(original) !== canonicalSharedJson(plan))
        return yield* Effect.fail(
          recover(
            fail(
              "SHARED_CREATE_PENDING",
              "This library and local credential already retain an original creation for this stable identity, name or alias. Changed input cannot silently replace or replay that unresolved intent.",
              { requested_operation_id: plan.operation_id },
            ),
            original,
            "original_intent",
          ),
        )
    }
  })
}
function verifyLibrary(library: SharedLibrary, plan?: SharedCreatePlan) {
  return Effect.gen(function* () {
    const current = yield* loadSharedLibrary(library.skills.database_id)
    if (
      !preservesSharedLibraryBindings(library, current) ||
      (plan !== undefined && !preservesSharedLibraryBindings(plan.library, current))
    )
      return yield* Effect.fail(
        fail(
          "SHARED_CREATE_SCOPE",
          "The exact registered shared library differs from this original creation intent.",
        ),
      )
    return current
  })
}
/** One paginated metadata inventory: duplicate identity/name and members, no bodies. */
function inventory(library: SharedLibrary, creatingName: string) {
  return Effect.gen(function* () {
    const api = yield* Notion,
      output: Array<Inventory[number]> = [],
      cursors = new Set<string>(),
      pages = new Set<string>()
    const query = new URLSearchParams()
    for (const name of ["Name", "Description", "Kind", "Skill ID", "Enabled", "Default Context"])
      query.append("filter_properties", library.skills.property_ids[name]!)
    let cursor: string | undefined
    do {
      const raw = yield* api.request(
        `v1/data_sources/${library.skills.data_source_id}/query?${query}`,
        { page_size: 100, ...(cursor === undefined ? {} : { start_cursor: cursor }) },
      )
      const page = yield* createChecked(() => {
        if (property(raw).object !== "list")
          throw fail(
            "SHARED_CREATE_INCOMPLETE",
            "Creation requires a complete same-library metadata inventory.",
          )
        return decode(InventorySchema, raw)
      })
      for (const row of page.results) {
        const entry = yield* createChecked(() =>
          sharedMetadataEntryFromPage(row, sourceFor(library), library.skills.data_source_id),
        )
        const pageId = entry.state === "registered" ? entry.record.locator.page_id : entry.page_id
        if (pages.has(pageId))
          return yield* Effect.fail(
            fail("SHARED_CREATE_INCOMPLETE", "The metadata inventory repeated a native page."),
          )
        pages.add(pageId)
        if (entry.state === "unregistered") {
          if (entry.name === creatingName || entry.alias === aliasFor(creatingName))
            return yield* Effect.fail(
              fail(
                "NAME_CONFLICT",
                "An unregistered disabled page already uses this name or alias; inspect the existing page before creating another Skill.",
                { name: creatingName, page_id: entry.page_id, state: entry.state },
              ),
            )
          continue
        }
        output.push({ raw: row, record: entry.record })
      }
      if (!page.has_more) {
        if (page.next_cursor !== null)
          return yield* Effect.fail(
            fail(
              "SHARED_CREATE_INCOMPLETE",
              "Final creation metadata page retained an unexpected cursor.",
            ),
          )
        cursor = undefined
      } else {
        if (page.next_cursor === null || page.next_cursor === "" || cursors.has(page.next_cursor))
          return yield* Effect.fail(
            fail("SHARED_CREATE_INCOMPLETE", "Creation metadata pagination did not advance."),
          )
        cursors.add(page.next_cursor)
        cursor = page.next_cursor
      }
    } while (cursor !== undefined)
    return output
  })
}
function resolveMembers(
  library: SharedLibrary,
  portable: PortableSkill,
  selectors: readonly string[] | undefined,
  records: Inventory,
  field: SharedSkillRelationField = "Members",
) {
  if (selectors === undefined) return [] as readonly string[]
  if (portable.kind === "prompt")
    throw fail("INVALID_MEMBERS", "Only Skills and Routers may specify native relations.")
  if (library.skills.property_ids[field] === undefined)
    throw fail(
      "SHARED_ROUTER_MEMBERS_UNAVAILABLE",
      `The selected library has no registered native ${field} relation.`,
    )
  const result = new Set<string>()
  for (const selector of selectors) {
    const target = parseTarget(selector)
    if (target.snapshot)
      throw fail(
        "INVALID_MEMBERS",
        "Router creation requires current exact member identities; portable pins do not bind current membership.",
      )
    const selectedPage = pageId(target.selector)
    const matches = records.filter(({ record }) =>
      selectedPage ? record.locator.page_id === selectedPage : record.id === target.selector,
    )
    const match = matches[0]
    if (matches.length !== 1 || match === undefined)
      throw fail(
        "SHARED_ROUTER_MEMBER_UNAVAILABLE",
        "A selected member is unavailable or ambiguous in the exact shared library.",
        { selector },
      )
    const record = match.record
    if (
      record.kind !== "skill" ||
      !record.enabled ||
      (target.path !== undefined && target.path !== record.entrypoint)
    )
      throw fail(
        "INVALID_MEMBERS",
        "Members must be enabled same-library Skills at their entrypoint.",
        { selector },
      )
    if (records.filter((row) => row.record.id === record.id).length !== 1)
      throw fail(
        "SHARED_SKILL_ID_CONFLICT",
        "A selected member's stable identity has multiple native pages.",
      )
    if (result.has(record.locator.page_id))
      throw fail("INVALID_MEMBERS", `${field} repeats an exact shared Skill identity.`)
    result.add(record.locator.page_id)
  }
  return [...result].sort()
}
function checkInventory(plan: SharedCreatePlan, records: Inventory) {
  const exact = records.filter(({ record }) => record.locator.skill_id === plan.skill_id)
  if (exact.length > 1)
    throw fail(
      "SHARED_SKILL_ID_CONFLICT",
      "Multiple native pages claim the stable original create identity; preserve all candidates.",
    )
  if (
    records.some(
      ({ record }) =>
        (record.name === plan.name || record.alias === aliasFor(plan.name)) &&
        record.locator.skill_id !== plan.skill_id,
    )
  )
    throw fail(
      "NAME_CONFLICT",
      "The selected shared library already contains another Skill with this name or alias.",
      { name: plan.name },
    )
  for (const member of [...new Set([...plan.members, ...(plan.requires ?? [])])]) {
    const matches = records.filter(({ record }) => record.locator.page_id === member),
      selected = matches[0]?.record
    if (
      matches.length !== 1 ||
      selected?.kind !== "skill" ||
      !selected.enabled ||
      records.filter((row) => row.record.id === selected.id).length !== 1
    )
      throw fail(
        "SHARED_ROUTER_MEMBER_UNAVAILABLE",
        "A frozen member is no longer one enabled same-library Skill.",
        { page_id: member },
      )
    if (plan.version === 2 && plan.members.includes(member)) {
      const binding = plan.origin.member_bindings.find((item) => item.page_id === member)
      if (
        !binding ||
        selected.id !== binding.record_id ||
        selected.locator.skill_id !== binding.skill_id
      )
        throw fail(
          "SHARED_MIGRATION_MEMBERS_UNBOUND",
          "A frozen member page no longer binds its exact original migration identity.",
          { page_id: member },
        )
    }
    const original = plan.relation_bindings?.find((binding) => binding.page_id === member)
    if (
      plan.relation_bindings !== undefined &&
      (original === undefined || selected.locator.skill_id !== original.skill_id)
    )
      throw fail(
        "SHARED_CREATE_RELATION_SCOPE",
        "A frozen relation page no longer binds its exact original stable Skill.",
        { page_id: member },
      )
  }
  return exact[0]
}
export function prepareSharedCreate(library: SharedLibrary, input: SharedCreateInput) {
  return Effect.gen(function* () {
    const scope = yield* authScope
    yield* verifyLibrary(library)
    const records = yield* inventory(library, input.portable.name)
    const members = yield* createChecked(() =>
      resolveMembers(library, input.portable, input.members, records),
    )
    const required =
      input.requires === undefined
        ? undefined
        : yield* createChecked(() =>
            resolveMembers(library, input.portable, input.requires, records, "Requires"),
          )
    const plan = yield* makeSharedCreatePlan(
      library,
      {
        portable: input.portable,
        ...(input.defaultContext === undefined ? {} : { defaultContext: input.defaultContext }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(input.completeResources === undefined
          ? {}
          : { completeResources: input.completeResources }),
        ...(input.portable.kind === "router" || input.members !== undefined ? { members } : {}),
        ...(required === undefined ? {} : { requires: required }),
        ...((input.completeResources !== true && input.sourceProjection === undefined) ||
        (members.length === 0 && (required?.length ?? 0) === 0)
          ? {}
          : {
              relationBindings: [...new Set([...members, ...(required ?? [])])]
                .sort()
                .map((page) => ({
                  page_id: page,
                  skill_id: records.find(({ record }) => record.locator.page_id === page)!.record
                    .locator.skill_id,
                })),
            }),
        ...(input.sourceProjection === undefined
          ? {}
          : { sourceProjection: input.sourceProjection }),
      },
      input.markdownImport === true ? 14 : undefined,
    )
    yield* guardOriginalCreate(scope, plan)
    yield* createChecked(() => checkInventory(plan, records))
    yield* assertSourceProjectionDefinition(library, plan)
    return plan
  })
}
/** Resolve original logical member mappings only to actual same-library pages.
 * No old page UUID or generated placeholder can satisfy the new relation. */
function prepareMigrationPlan(
  library: SharedLibrary,
  candidate: SharedMigrationConversionCandidate,
) {
  return Effect.gen(function* () {
    if (!preservesSharedLibraryBindings(candidate.library, library))
      return yield* Effect.fail(
        fail(
          "SHARED_MIGRATION_CREATE_SCOPE",
          "The migration candidate belongs to another exact shared library.",
        ),
      )
    const scope = yield* authScope
    yield* verifyLibrary(library)
    const records = yield* inventory(library, candidate.metadata.name)
    const members = yield* createChecked(() =>
      candidate.member_bindings.map((original): MigrationMemberBinding => {
        const matches = records.filter(
          ({ record }) =>
            record.id === original.record_id || record.locator.skill_id === original.skill_id,
        )
        const record = matches[0]?.record
        if (
          matches.length !== 1 ||
          !record ||
          record.id !== original.record_id ||
          record.locator.skill_id !== original.skill_id ||
          record.kind !== "skill" ||
          !record.enabled
        )
          throw fail(
            "SHARED_MIGRATION_MEMBERS_UNBOUND",
            "Create and verify each exact migrated Skill before binding its original Router membership.",
            { legacy_id: original.legacy_id },
          )
        return { ...original, page_id: record.locator.page_id }
      }),
    )
    const plan = yield* makeSharedMigrationCreatePlan(candidate, members)
    yield* guardOriginalCreate(scope, plan)
    yield* createChecked(() => checkInventory(plan, records))
    return plan
  })
}
export function prepareSharedMigrationCreate(
  library: SharedLibrary,
  input: { readonly migrationInput: unknown; readonly candidate: unknown },
) {
  return validateSharedMigrationConversion(input.migrationInput, input.candidate).pipe(
    Effect.flatMap((candidate) => prepareMigrationPlan(library, candidate)),
  )
}
/** Read-only online scope/member checks for an unapproved, frozen proposal.
 * The resulting plan still cannot be dispatched without original approved input. */
export function prepareSharedMigrationReview(library: SharedLibrary, input: unknown) {
  return validateRetainedMigrationConversion(input).pipe(
    Effect.flatMap((candidate) => prepareMigrationPlan(library, candidate)),
  )
}
function createProjectionBaseline(file: {
  readonly event: SharedCreatePlan["files"][number]["event"]
}) {
  return file.event.kind === "projected"
    ? canonicalSharedJson({ ...file.event.projection, source_revision: file.event.source_revision })
    : ""
}
function assertSourceProjectionDefinition(
  library: SharedLibrary,
  plan: SharedCreatePlan,
  createdPage?: string,
) {
  return Effect.gen(function* () {
    const expected = plan.source_projection?.definition
    if (expected === undefined) return
    const current = yield* readSourceDefinition(library, expected.page_id)
    if (
      !current.enabled ||
      current.source_id !== expected.source_id ||
      current.fingerprint !== expected.fingerprint
    )
      return yield* Effect.fail(
        fail(
          "SHARED_CREATE_SOURCE_CHANGED",
          "The frozen live Source definition changed; preserve the original creation and do not create or enable a replacement.",
        ),
      )
    const members = yield* listSourceMembers(library, expected.page_id)
    const matching = members.items.filter((member) => member.member === expected.member)
    if (
      matching.some(
        (member) => member.page_id !== createdPage || member.skill_id !== plan.skill_id,
      ) ||
      (createdPage !== undefined && matching.length !== 1)
    )
      return yield* Effect.fail(
        fail(
          "SOURCE_MEMBER_ALREADY_BOUND",
          "This exact Source member already has an enabled or disabled Skill binding; use the original binding or an explicit rebind decision.",
        ),
      )
  })
}
function recordProperties(plan: SharedCreatePlan) {
  const ids = plan.library.skills.property_ids,
    main = plan.files.find((file) => file.path === plan.entrypoint)!
  const rich = (content: string) => ({ rich_text: spans(content) })
  return {
    [ids.Name!]: { title: spans(plan.name) },
    [ids.Description!]: rich(plan.description),
    [ids.Kind!]: { select: { name: plan.content_kind } },
    [ids.Enabled!]: { checkbox: false },
    [ids["Default Context"]!]: { checkbox: plan.default_context },
    [ids["Skill ID"]!]: rich(plan.skill_id),
    [ids["Main File ID"]!]: rich(main.file_id),
    [ids.Projection!]: rich(createProjectionBaseline(main)),
    [ids.Source!]: rich(sharedCreateFixedSource(plan)?.source_id ?? ""),
    ...(plan.source_projection === undefined
      ? {}
      : {
          [ids.Origin!]: { relation: [{ id: plan.source_projection.definition.page_id }] },
          [ids["Source Member"]!]: rich(plan.source_projection.definition.member),
        }),
    [ids.References!]: rich(""),
    ...(plan.content_kind === "router" || plan.members.length > 0
      ? { [ids.Members!]: { relation: plan.members.map((id) => ({ id })) } }
      : {}),
    ...(plan.requires === undefined
      ? {}
      : { [ids.Requires!]: { relation: plan.requires.map((id) => ({ id })) } }),
  }
}
function spans(value: string) {
  const characters = Array.from(value),
    output: Array<{ type: "text"; text: { content: string } }> = []
  for (let offset = 0; offset < characters.length; offset += 2000)
    output.push({
      type: "text",
      text: { content: characters.slice(offset, offset + 2000).join("") },
    })
  return output
}
function pageReceipt(raw: unknown): string {
  const row = property(raw)
  if (
    row.object !== "page" ||
    typeof row.id !== "string" ||
    pageId(row.id) !== row.id ||
    row.in_trash === true ||
    row.archived === true
  )
    throw fail(
      "SHARED_CREATE_RECEIPT_INVALID",
      "The original native create returned no exact readable page receipt; do not retry it.",
    )
  return row.id
}
function assertBody(page: string, expected: string, importPresentation = false) {
  return Effect.gen(function* () {
    const raw = yield* (yield* Notion).request(`v1/pages/${page}/markdown?markdown_version=v2`)
    const body = yield* createChecked(() => decode(MarkdownSchema, raw))
    if (
      body.id !== page ||
      body.truncated ||
      body.unknown_block_ids.length !== 0 ||
      (body.warnings?.length ?? 0) !== 0
    )
      return yield* Effect.fail(
        fail(
          "BODY_INCOMPLETE",
          "A native create body is incomplete; its page and original input remain retained.",
        ),
      )
    const actual = yield* createChecked(() => normalizeObservedBody(body.markdown))
    if (importPresentation)
      return yield* createChecked(() => assertImportedMarkdownContent(expected, actual))
    if (actual !== expected)
      return yield* Effect.fail(
        fail(
          "SHARED_CREATE_BODY_MISMATCH",
          "The complete native body differs from the candidate projected before dispatch. Other Notion formatting transformations are not accepted by a loose comparison.",
        ),
      )
  })
}
function manifestRecord(
  library: SharedLibrary,
  plan: SharedCreatePlan,
  page: string,
  mode: "create" | "reconcile",
) {
  return appendSharedRecord(library, {
    mode,
    recordId: plan.operation_id,
    operationId: plan.operation_id,
    skillPageId: page,
    kind: "operation",
    entityId: sharedCreateManifestEntity,
    payload: sharedCreateManifest(plan),
    ...(plan.input_projection === undefined ? {} : { payloadContainsBody: true as const }),
  })
}
function retainInputs(
  library: SharedLibrary,
  plan: SharedCreatePlan,
  page: string,
  mode: "create" | "reconcile",
) {
  return Effect.gen(function* () {
    for (const file of plan.files) {
      yield* appendSharedRecord(library, {
        mode,
        recordId: file.input.object_id,
        operationId: `retain-input-${file.input.sha256}`,
        skillPageId: page,
        kind: "object",
        entityId: file.input.object_id,
        payload: sharedCreateInputPayload(file.input.text),
      })
      if (!acceptsNativeImportReadback(plan)) yield* retainCreatedBody(library, file, page, mode)
      if (file.baseline_body !== undefined)
        yield* appendSharedRecord(library, {
          mode,
          recordId: file.baseline_body.content.object_id,
          operationId: `retain-${file.baseline_body.content.sha256}`,
          skillPageId: page,
          kind: "object",
          entityId: file.baseline_body.content.object_id,
          payload: sharedCreateBodyPayload(file.baseline_body.markdown),
        })
    }
    if (plan.version === 2) {
      const retained = yield* sharedMigrationOriginObjects(plan.origin.candidate)
      if (canonicalSharedJson(retained.archive) !== canonicalSharedJson(plan.origin.archive))
        return yield* Effect.fail(
          fail(
            "SHARED_MIGRATION_ORIGIN_INVALID",
            "The original migration evidence differs from its frozen archive.",
          ),
        )
      for (const object of retained.objects)
        yield* appendSharedRecord(library, {
          mode,
          recordId: object.object_id,
          operationId: `retain-input-${object.sha256}`,
          skillPageId: page,
          kind: "object",
          entityId: object.object_id,
          payload: sharedCreateInputPayload(object.text),
        })
    }
    for (const file of plan.resources ?? [])
      yield* retainSharedResourceContent(library, {
        skillPageId: page,
        prepared: file.prepared,
        mode,
      })
    for (const file of (plan.source_projection?.version === 1
      ? plan.source_projection.local?.baseline_inputs
      : undefined) ?? [])
      yield* retainSharedResourceContent(library, {
        skillPageId: page,
        prepared: file.prepared,
        mode,
      })
    if (plan.source_projection?.version === 2)
      yield* retainSharedCreateSource(library, page, plan.source_projection.retained, mode)
  })
}
function retainCreatedBody(
  library: SharedLibrary,
  file: SharedCreatePlan["files"][number],
  page: string,
  mode: "create" | "reconcile",
) {
  return appendSharedRecord(library, {
    mode,
    recordId: file.content.object_id,
    operationId: `retain-${file.content.sha256}`,
    skillPageId: page,
    kind: "object",
    entityId: file.content.object_id,
    payload: sharedCreateBodyPayload(file.projection.markdown),
  })
}
function saveOutcome(
  library: SharedLibrary,
  plan: SharedCreatePlan,
  page: string,
  status: Outcome["status"],
  reason: string,
  bindings: readonly Binding[],
) {
  return Effect.gen(function* () {
    const resolved = yield* resolveSharedCreateSource(plan, page)
    const fields = {
      kind: "skill_create_outcome" as const,
      operation_id: plan.operation_id,
      skill_id: plan.skill_id,
      skill_page_id: page,
      status,
      reason_code: reason,
      bindings,
    }
    const payload: Outcome =
      plan.version === 2
        ? {
            ...fields,
            version: 2,
            migration_candidate_id: plan.origin.candidate.candidate_id,
            manifest_record_hash: yield* createManifestRecordHash(plan),
          }
        : {
            ...fields,
            version: 1,
            ...(plan.source_projection === undefined
              ? {}
              : {
                  source_projection: {
                    source_id: resolved.selection!.source_id,
                    revision: resolved.selection!.revision,
                    manifest_record_hash: yield* createManifestRecordHash(plan),
                    ...(plan.source_projection.version !== 1 ||
                    plan.source_projection.local === undefined
                      ? {}
                      : { local_customization: 1 as const }),
                  },
                }),
          }
    return yield* appendSharedRecord(library, {
      mode: "create",
      recordId: outcomeId(plan.operation_id),
      operationId: plan.operation_id,
      skillPageId: page,
      kind: "operation",
      entityId: sharedCreateOutcomesEntity,
      payload,
    })
  })
}
function verifyIndex(
  library: SharedLibrary,
  plan: SharedCreatePlan,
  page: string,
  bindings: readonly Binding[],
  enabled: boolean,
  partial = false,
  sourceOverride?: string,
  originalReadbackPlan?: SharedCreatePlan,
) {
  return Effect.gen(function* () {
    const source = (yield* resolveSharedCreateSource(plan, page)).selection
    const index = yield* querySharedSkillIndex(library, page)
    if (
      index.skill_id !== plan.skill_id ||
      index.name !== plan.name ||
      index.description !== plan.description ||
      index.kind !== plan.content_kind ||
      index.default_context !== plan.default_context ||
      index.enabled !== enabled ||
      index.source_reference !== (sourceOverride ?? source?.source_id ?? "")
    )
      return yield* Effect.fail(
        fail(
          "SHARED_CREATE_REVIEW_REQUIRED",
          "The new native Skill metadata differs from the original intent; preserve the page without replacement.",
        ),
      )
    const actual = [index.main, ...index.files]
      .map((file) => ({ file_id: file.file_id, path: file.path, page_id: file.page_id }))
      .sort((left, right) =>
        left.file_id < right.file_id ? -1 : left.file_id > right.file_id ? 1 : 0,
      )
    const expected = bindings
      .map(({ event_id: _event, ...binding }) => binding)
      .sort((left, right) =>
        left.file_id < right.file_id ? -1 : left.file_id > right.file_id ? 1 : 0,
      )
    if (canonicalSharedJson(actual) !== canonicalSharedJson(expected))
      return yield* Effect.fail(
        fail(
          "SHARED_CREATE_REVIEW_REQUIRED",
          "The complete stable File/page/path bindings differ from the frozen creation intent.",
        ),
      )
    if (plan.version === 2 || plan.source_projection !== undefined) {
      for (const file of sharedCreateFiles(plan).filter(
        (file) => !partial || bindings.some((binding) => binding.file_id === file.file_id),
      )) {
        const binding = [index.main, ...index.files].find((item) => item.file_id === file.file_id)
        const baseline =
          file.event.kind === "projected"
            ? { ...file.event.projection, source_revision: file.event.source_revision }
            : null
        const supporting = index.files.find((item) => item.file_id === file.file_id)
        const originalFile = originalReadbackPlan?.files.find(
          (item) => item.file_id === file.file_id,
        )
        const originalBaseline =
          originalFile?.event.kind === "projected"
            ? {
                ...originalFile.event.projection,
                source_revision: originalFile.event.source_revision,
              }
            : null
        const pendingReadbackBaseline =
          partial &&
          originalReadbackPlan !== undefined &&
          canonicalSharedJson(binding?.baseline ?? null) === canonicalSharedJson(originalBaseline)
        if (
          !binding ||
          (!pendingReadbackBaseline &&
            canonicalSharedJson(binding.baseline ?? null) !== canonicalSharedJson(baseline)) ||
          (supporting !== undefined &&
            supporting.display_status !==
              (file.event.kind === "projected"
                ? "following"
                : file.event.kind === "deleted"
                  ? "tombstone"
                  : "custom"))
        )
          return yield* Effect.fail(
            fail(
              "SHARED_CREATE_REVIEW_REQUIRED",
              "The migrated projection baseline or ownership display differs from the frozen initial fact.",
            ),
          )
      }
    }
    if (
      plan.source_projection !== undefined &&
      canonicalSharedJson(yield* readSharedFileSourceContext(library, page)) !==
        canonicalSharedJson({
          selected_version: sourceOverride ?? source!.source_id,
          definition: plan.source_projection.definition,
        })
    )
      return yield* Effect.fail(
        fail(
          "SHARED_CREATE_SOURCE_CHANGED",
          "The created page's exact Source/member/configuration differs from its original projection plan.",
        ),
      )
    for (const [field, expected] of [
      [
        "Members",
        plan.content_kind === "router" || plan.members.length > 0 ? plan.members : undefined,
      ],
      ["Requires", plan.requires],
    ] as const) {
      if (expected === undefined) continue
      const members = yield* sharedCreateMemberIds(library, page, field)
      if (canonicalSharedJson(members) !== canonicalSharedJson(expected))
        return yield* Effect.fail(
          fail(
            "SHARED_CREATE_REVIEW_REQUIRED",
            `The complete native ${field} relation differs from the frozen current target identities.`,
          ),
        )
    }
    return index
  })
}
export function sharedCreateMemberIds(
  library: SharedLibrary,
  page: string,
  field: SharedSkillRelationField = "Members",
) {
  return Effect.gen(function* () {
    const raw = yield* (yield* Notion).request(`v1/pages/${page}`)
    const record = yield* createChecked(() =>
      sharedRecordFromPage(raw, sourceFor(library), library.skills.data_source_id),
    )
    if (record.locator.page_id !== page)
      return yield* Effect.fail(
        fail("SHARED_CREATE_INCOMPLETE", "Creation relation read returned another page identity."),
      )
    return (yield* completeSharedSkillRelationIds(library, record, raw, field, {
      allowDisabled: true,
    })).sort()
  })
}
function verifyFacts(library: SharedLibrary, plan: SharedCreatePlan, page: string) {
  return Effect.gen(function* () {
    if (plan.source_projection?.version === 2)
      yield* verifySharedCreateRetained(library, page, plan.source_projection.retained)
    for (const expected of sharedCreateFixedSources(plan)) {
      const actual = yield* resolveSourceBinding(library, {
        skillPageId: page,
        sourceId: expected.source_id,
      })
      if (canonicalSharedJson(actual) !== canonicalSharedJson(expected))
        return yield* Effect.fail(
          fail(
            "SHARED_CREATE_REVIEW_REQUIRED",
            "The migrated Source differs from the exact fixed selection in the original intent.",
          ),
        )
    }
    const rows = yield* querySharedRecords(library, { skillPageId: page, kind: "file_event" })
    const events = yield* createChecked(() =>
      rows.map((row) => {
        const event = decode(FileEventSchema, row.payload)
        if (
          row.record_id !== event.event_id ||
          row.operation_id !== event.event_id ||
          row.entity_id !== event.file_id
        )
          throw fail("SHARED_CREATE_SCOPE", "The new Skill has a foreign file-event identity.")
        return event
      }),
    )
    if (events.length !== sharedCreateEvents(plan).length)
      return yield* Effect.fail(
        fail(
          "SHARED_CREATE_REVIEW_REQUIRED",
          "The complete new Skill history differs from the initial frozen event set.",
        ),
      )
    for (const file of sharedCreateFiles(plan)) {
      const selected = events.filter((event) => event.file_id === file.file_id)
      const expected = [...(file.ancestors ?? []), file.event]
      if (
        canonicalSharedJson([...selected].sort((a, b) => a.event_id.localeCompare(b.event_id))) !==
        canonicalSharedJson(expected.sort((a, b) => a.event_id.localeCompare(b.event_id)))
      )
        return yield* Effect.fail(
          fail(
            "SHARED_CREATE_REVIEW_REQUIRED",
            "An initial ownership event is missing or differs from the frozen complete body.",
          ),
        )
      yield* createChecked(() => resolveFileState(file.file_id, selected))
    }
  })
}
function retire(plan: SharedCreatePlan, scope: string, bindings: readonly Binding[]) {
  return Effect.gen(function* () {
    const store = yield* Store
    const key = yield* sharedCreateJournalKey(scope, plan.library.library_id, plan.operation_id)
    const journal = yield* store.readJson(key, SharedCreateJournalSchema)
    if (journal?.ownership_receipt_version === 1) {
      if (
        journal.scope !== scope ||
        journal.library_id !== plan.library.library_id ||
        canonicalSharedJson(journal.plan) !== canonicalSharedJson(plan)
      )
        return yield* Effect.fail(
          fail(
            "STATE_CONFLICT",
            "Ownership evidence differs from the original local creation dispatch.",
          ),
        )
      yield* saveSharedCreateOwnership(scope, plan, bindings)
    }
    yield* invalidateSubscriptionCatalog(scope, plan.library.skills.database_id)
    yield* invalidateSnapshotCache(sharedSkillId(plan.library.library_id, plan.skill_id), scope)
    yield* store.retireKeys([key])
  })
}

function readRetainedCreateInput(
  library: SharedLibrary,
  page: string,
  expected: { readonly object_id: string; readonly sha256: string; readonly bytes: number },
) {
  return Effect.gen(function* () {
    const objects = yield* querySharedRecords(library, {
      skillPageId: page,
      kind: "object",
      entityId: expected.object_id,
      recordId: expected.object_id,
      payloadContainsBody: true,
    })
    const object = objects[0]
    if (
      objects.length !== 1 ||
      object === undefined ||
      object.operation_id !== `retain-input-${expected.sha256}`
    )
      return yield* Effect.fail(
        fail("SHARED_CREATE_UNRESOLVED", "An exact retained original input object is unavailable."),
      )
    const body = yield* createChecked(() =>
      Schema.decodeUnknownSync(InputObjectSchema)(object.payload, { onExcessProperty: "error" }),
    )
    const bytes = new TextEncoder().encode(body.text)
    if (bytes.length !== expected.bytes || (yield* sha256(bytes)) !== expected.sha256)
      return yield* Effect.fail(
        fail("SHARED_CREATE_INVALID", "An original input object failed its immutable checksum."),
      )
    return body.text
  })
}

/** Exact shared manifest and input objects can reconstruct a plan on another machine. */
export function loadSharedCreatePlan(
  library: SharedLibrary,
  input: { readonly skillPageId: string; readonly operationId: string },
) {
  return Effect.gen(function* () {
    if (!/^skill-create-[a-f0-9]{64}$/u.test(input.operationId))
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "Select an exact original native creation operation ID."),
      )
    yield* authScope
    yield* verifyLibrary(library)
    const raw = yield* (yield* Notion).request(`v1/pages/${input.skillPageId}`)
    const record = yield* createChecked(() =>
      sharedRecordFromPage(raw, sourceFor(library), library.skills.data_source_id),
    )
    if (record.locator.page_id !== input.skillPageId)
      return yield* Effect.fail(
        fail(
          "SHARED_CREATE_SCOPE",
          "The selected creation page differs from the authorized current page.",
        ),
      )
    const rows = yield* querySharedRecords(library, {
      skillPageId: input.skillPageId,
      kind: "operation",
      entityId: sharedCreateManifestEntity,
      recordId: input.operationId,
      payloadContainsBody: true,
    })
    const row = rows[0]
    if (rows.length !== 1 || row === undefined)
      return yield* Effect.fail(
        fail(
          "SHARED_CREATE_UNRESOLVED",
          "The original shared creation manifest is unavailable; no replacement intent may be inferred.",
        ),
      )
    const manifest = yield* createChecked(() =>
      Schema.decodeUnknownSync(SharedCreateManifestSchema)(row.payload, {
        onExcessProperty: "error",
      }),
    )
    if (
      manifest.operation_id !== input.operationId ||
      row.operation_id !== manifest.operation_id ||
      manifest.skill_id !== record.locator.skill_id ||
      !preservesSharedLibraryBindings(manifest.library, library)
    )
      return yield* Effect.fail(
        fail(
          "SHARED_CREATE_SCOPE",
          "The original creation manifest belongs to another library or stable Skill.",
        ),
      )
    if (manifest.version === 2) {
      const parts = []
      for (const chunk of manifest.origin.archive.chunks)
        parts.push({
          object_id: chunk.object_id,
          text: yield* readRetainedCreateInput(library, input.skillPageId, chunk),
        })
      const origin = yield* restoreSharedMigrationCreateOrigin(manifest.origin, parts)
      const plan = yield* makeSharedMigrationCreatePlan(origin.candidate, origin.member_bindings)
      if (canonicalSharedJson(sharedCreateManifest(plan)) !== canonicalSharedJson(manifest))
        return yield* Effect.fail(
          fail(
            "SHARED_CREATE_INVALID",
            "The retained migration origin does not reconstruct the exact original creation manifest.",
          ),
        )
      return plan
    }
    const files: PortableSkill["files"][number][] = []
    for (const file of manifest.files) {
      const text = yield* readRetainedCreateInput(library, input.skillPageId, file.input)
      files.push({
        path: file.input_path,
        bytes: new TextEncoder().encode(text),
        ...(file.input.mode === undefined ? {} : { mode: file.input.mode }),
      })
    }
    for (const file of manifest.resources ?? []) {
      const loaded = yield* loadSharedResourceContent(library, {
        skillPageId: input.skillPageId,
        content: file.content,
      })
      files.push({
        path: file.input_path,
        bytes: loaded.bytes,
        ...(file.content.mode === null ? {} : { mode: file.content.mode }),
      })
    }
    const frozenProjection = manifest.source_projection
    const sourceProjection =
      frozenProjection === undefined
        ? undefined
        : frozenProjection.version === 2
          ? {
              ...frozenProjection,
              retained: yield* loadSharedCreateRetained(
                library,
                input.skillPageId,
                frozenProjection.retained,
              ),
            }
          : yield* Effect.gen(function* () {
              const { local, ...projection } = frozenProjection
              return {
                ...projection,
                ...(local === undefined
                  ? {}
                  : {
                      local: {
                        ...local,
                        baseline_inputs: yield* Effect.forEach(local.baseline_inputs, (file) =>
                          Effect.gen(function* () {
                            const loaded = yield* loadSharedResourceContent(library, {
                              skillPageId: input.skillPageId,
                              content: file.content,
                            })
                            return {
                              path: file.path,
                              prepared: yield* prepareSharedResourceContent(
                                loaded.bytes,
                                file.content.mode,
                              ),
                            }
                          }),
                        ),
                      },
                    }),
              }
            })
    const projectionVersion = yield* createChecked(() =>
      sharedCreateProjectionVersion(manifest.files),
    )
    const plan = yield* makeSharedCreatePlan(
      manifest.library,
      {
        portable: {
          kind: manifest.content_kind,
          name: manifest.name,
          description: manifest.description,
          main: manifest.original_main_path,
          files,
          ...(manifest.input_projection === undefined
            ? {}
            : { projection: manifest.input_projection }),
        },
        defaultContext: manifest.default_context,
        ...(manifest.enabled === undefined ? {} : { enabled: manifest.enabled }),
        ...(manifest.complete_resources === undefined ? {} : { completeResources: true }),
        ...(manifest.content_kind === "router" || manifest.members.length > 0
          ? { members: manifest.members }
          : {}),
        ...(manifest.requires === undefined ? {} : { requires: manifest.requires }),
        ...(manifest.relation_bindings === undefined
          ? {}
          : { relationBindings: manifest.relation_bindings }),
        ...(sourceProjection === undefined ? {} : { sourceProjection }),
      },
      projectionVersion,
    )
    if (canonicalSharedJson(sharedCreateManifest(plan)) !== canonicalSharedJson(manifest))
      return yield* Effect.fail(
        fail(
          "SHARED_CREATE_INVALID",
          "The retained original files do not reconstruct the exact frozen creation manifest.",
        ),
      )
    return plan
  })
}

/** All reconciliation is read-only remotely; matching current body is not a receipt. */
export function reconcileSharedCreate(library: SharedLibrary, input: SharedCreatePlan) {
  return Effect.gen(function* () {
    const plan = yield* validateSharedCreatePlan(input),
      scope = yield* authScope
    yield* verifyLibrary(library, plan)
    const records = yield* inventory(library, plan.name)
    const candidates = records.filter((row) => row.record.locator.skill_id === plan.skill_id),
      current = candidates[0]
    if (candidates.length !== 1 || current === undefined)
      return yield* Effect.fail(
        recover(
          fail(
            "SHARED_CREATE_UNRESOLVED",
            "The original stable Skill page is unavailable or ambiguous. The first create is never replayed.",
          ),
          plan,
          "create_skill",
        ),
      )
    const page = current.record.locator.page_id
    const resolved = yield* resolveSharedCreateSource(plan, page)
    let facts: SharedCreatePlan = resolved.facts
    yield* manifestRecord(library, plan, page, "reconcile").pipe(
      Effect.mapError((error) => recover(error, plan, "manifest", page)),
    )
    const rows = yield* querySharedRecords(library, {
      skillPageId: page,
      kind: "operation",
      entityId: sharedCreateOutcomesEntity,
      recordId: outcomeId(plan.operation_id),
    })
    const row = rows[0]
    if (
      rows.length === 0 &&
      plan.version === 1 &&
      plan.complete_resources === 1 &&
      plan.source_projection === undefined &&
      plan.files.length === 1 &&
      plan.files[0]?.projection.version === 11
    ) {
      const headers = yield* querySharedOperationIndex(library, page)
      const manifest = headers.find(
        (header) =>
          header.record_id === plan.operation_id && header.entity_id === sharedCreateManifestEntity,
      )
      if (manifest !== undefined) {
        const eventRows = yield* querySharedRecords(library, {
          skillPageId: page,
          kind: "file_event",
        })
        const events = yield* createChecked(() =>
          eventRows.map((record) =>
            Schema.decodeUnknownSync(FileEventSchema)(record.payload, {
              onExcessProperty: "error",
            }),
          ),
        )
        const recovered = yield* readSharedCreateNativeCompletion(library, {
          skillPageId: page,
          originalManifestHeader: manifest,
          events,
          headers,
        })
        if (recovered !== undefined) {
          if (canonicalSharedJson(recovered.plan) !== canonicalSharedJson(plan))
            return yield* Effect.fail(
              fail(
                "SHARED_CREATE_INVALID",
                "The shared native recovery belongs to another original input.",
              ),
            )
          yield* retire(plan, scope, recovered.outcome.bindings)
          return {
            status: "created" as const,
            operation: "create" as const,
            action: "created" as const,
            skill_page_id: page,
            page_id: page,
            skill_id: plan.skill_id,
            entrypoint: plan.entrypoint,
            record: current.record,
            ref: current.record.ref,
            operation_id: plan.operation_id,
            verified: true as const,
            reused: true as const,
            requires_fresh_read: true as const,
            verification: "original_native_recovery_outcome" as const,
            original_outcome_recorded: false as const,
            recovery_operation_id: recovered.review.review_id,
            protection: sharedCreateProtection,
            ...(yield* createChecked(() =>
              sharedCreateExpectations(
                { ...plan, files: [recovered.file] },
                recovered.outcome.bindings,
              ),
            )),
          }
        }
      }
    }
    if (rows.length !== 1 || row === undefined)
      return yield* Effect.fail(
        recover(
          fail(
            "SHARED_CREATE_UNRESOLVED",
            "No exact original-operation completion is visible. Matching native pages, bodies or ownership events cannot authorize replay or substitute for the missing receipt.",
          ),
          plan,
          "outcome",
          page,
        ),
      )
    const outcome = yield* createChecked(() => decodeOutcome(row))
    if (
      outcome.skill_id !== plan.skill_id ||
      outcome.skill_page_id !== page ||
      outcome.version !== plan.version ||
      (plan.version === 1 &&
        outcome.version === 1 &&
        canonicalSharedJson(outcome.source_projection ?? null) !==
          canonicalSharedJson(
            plan.source_projection === undefined
              ? null
              : {
                  source_id: resolved.selection!.source_id,
                  revision: resolved.selection!.revision,
                  manifest_record_hash: yield* createManifestRecordHash(plan),
                  ...(plan.source_projection.version !== 1 ||
                  plan.source_projection.local === undefined
                    ? {}
                    : { local_customization: 1 as const }),
                },
          )) ||
      (plan.version === 2 &&
        (outcome.version !== 2 ||
          outcome.migration_candidate_id !== plan.origin.candidate.candidate_id ||
          outcome.manifest_record_hash !== (yield* createManifestRecordHash(plan))))
    )
      return yield* Effect.fail(
        fail("SHARED_CREATE_SCOPE", "The exact original outcome belongs to another Skill."),
      )
    if (outcome.status !== "applied")
      return yield* Effect.fail(
        recover(
          fail(
            "SHARED_CREATE_REVIEW_REQUIRED",
            "This original native creation requires review; keep its original files, created pages and exact plan.",
          ),
          plan,
          "outcome",
          page,
        ),
      )
    if (acceptsNativeImportReadback(plan))
      facts = yield* restoreNativeImportReadbacks(facts, page, outcome.bindings)
    const expected = sharedCreateFiles(facts)
      .map((file) => ({ file_id: file.file_id, path: file.path, event_id: file.event.event_id }))
      .sort((a, b) => (a.file_id < b.file_id ? -1 : a.file_id > b.file_id ? 1 : 0))
    const reported = outcome.bindings
      .map(({ page_id: _page, ...binding }) => binding)
      .sort((a, b) => (a.file_id < b.file_id ? -1 : a.file_id > b.file_id ? 1 : 0))
    if (
      canonicalSharedJson(expected) !== canonicalSharedJson(reported) ||
      outcome.bindings.find((file) => file.path === plan.entrypoint)?.page_id !== page
    )
      return yield* Effect.fail(
        fail(
          "SHARED_CREATE_INVALID",
          "The completion does not cover every original stable File and exact initial event.",
        ),
      )
    yield* retainInputs(library, facts, page, "reconcile").pipe(
      Effect.mapError((error) => recover(error, plan, "retained_inputs", page)),
    )
    if (acceptsNativeImportReadback(plan))
      for (const file of facts.files) yield* retainCreatedBody(library, file, page, "reconcile")
    for (const source of sharedCreateFixedSources(plan)) {
      yield* registerSourceBinding(library, {
        skillPageId: page,
        mode: "reconcile",
        fixedSource: {
          url: source.url,
          commit: source.commit,
          root: source.root,
          tree: source.tree,
          files: source.files,
        },
      }).pipe(Effect.mapError((error) => recover(error, plan, "source_registration", page)))
    }
    for (const event of sharedCreateEvents(facts))
      yield* appendSharedRecord(library, {
        mode: "reconcile",
        recordId: event.event_id,
        operationId: event.event_id,
        skillPageId: page,
        kind: "file_event",
        entityId: event.file_id,
        payload: event,
      })
    // The completed operation is historical. Later user edits/renames are not
    // replaced, rebound to its original bytes or published as a latest snapshot.
    yield* retire(plan, scope, outcome.bindings)
    return {
      status: "created" as const,
      operation: "create" as const,
      action: "created" as const,
      skill_page_id: page,
      page_id: page,
      skill_id: plan.skill_id,
      entrypoint: plan.entrypoint,
      record: current.record,
      ref: current.record.ref,
      operation_id: plan.operation_id,
      verified: true as const,
      reused: true as const,
      requires_fresh_read: true as const,
      protection: sharedCreateProtection,
      ...(yield* createChecked(() =>
        sharedCreateExpectations(facts, outcome.bindings, resolved.selection),
      )),
    }
  })
}

function inspectSharedCreateDispatch(library: SharedLibrary, plan: SharedCreatePlan) {
  return Effect.gen(function* () {
    const scope = yield* authScope,
      store = yield* Store
    yield* verifyLibrary(library, plan)
    const key = yield* sharedCreateJournalKey(scope, library.library_id, plan.operation_id)
    // A credential rotation cannot turn the same Store's unresolved original
    // operation into a fresh first POST. Inspect only its opaque address; never
    // read another credential's journal or expose that credential's scope.
    const originalAddress = new RegExp(
      `^operations/shared-native-create/[a-f0-9]{64}/${plan.operation_id}\\.json$`,
      "u",
    )
    if (
      (yield* store.listKeys("operations/shared-native-create/")).some(
        (candidate) => candidate !== key && originalAddress.test(candidate),
      )
    )
      return { scope, key, original: true as const, resumable: false }
    const saved = yield* store.readJson(key, SharedCreateJournalSchema)
    if (saved !== undefined) {
      if (
        saved.scope !== scope ||
        saved.library_id !== library.library_id ||
        canonicalSharedJson(saved.plan) !== canonicalSharedJson(plan)
      )
        return yield* Effect.fail(
          fail("STATE_CONFLICT", "The original native create journal differs from this request."),
        )
      return {
        scope,
        key,
        original: true as const,
        resumable: saved.dispatch_receipt_version === 1,
      }
    }
    yield* guardOriginalCreate(scope, plan)
    const records = yield* inventory(library, plan.name)
    if (yield* createChecked(() => checkInventory(plan, records)))
      return { scope, key, original: true as const, resumable: false }
    yield* assertSourceProjectionDefinition(library, plan)
    return { scope, key, original: false as const, resumable: false }
  })
}

/** The same first-dispatch gates, with no body read, journal write, create or original reconciliation. */
export function previewSharedCreate(library: SharedLibrary, frozenPlan: unknown) {
  return Effect.gen(function* () {
    const plan = yield* validateSharedCreatePlan(frozenPlan)
    const checked = yield* inspectSharedCreateDispatch(library, plan)
    return {
      status: checked.original ? ("original_operation_exists" as const) : ("planned" as const),
      operation_id: plan.operation_id,
      skill_id: plan.skill_id,
      original_reconciliation_required: checked.original,
      initial_enabled: false as const,
      requested_enabled: sharedCreateEnabled(plan),
      migration_input_required: plan.version === 2,
      remote_writes: 0 as const,
      protection: sharedCreateProtection,
      plan,
    }
  }).pipe(withReadOnlyNotion)
}

export function executeSharedCreate(
  library: SharedLibrary,
  input: {
    readonly plan: SharedCreatePlan
    readonly mode: "create" | "reconcile"
    readonly migrationInput?: unknown
  },
) {
  return Effect.gen(function* () {
    const plan = yield* validateSharedCreatePlan(input.plan)
    if (input.mode === "reconcile") return yield* reconcileSharedCreate(library, plan)
    if (input.mode !== "create")
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "Native create mode must be create or reconcile."),
      )
    if (plan.version === 2) {
      if (input.migrationInput === undefined)
        return yield* Effect.fail(
          fail(
            "SHARED_MIGRATION_INPUT_REQUIRED",
            "A retained origin grants read-only reconciliation only. New creation requires its original frozen migration input.",
          ),
        )
      yield* validateSharedMigrationConversion(input.migrationInput, plan.origin.candidate)
    }
    const { scope, key, original, resumable } = yield* inspectSharedCreateDispatch(library, plan)
    let stage = "create_skill",
      skillPage: string | undefined,
      lastCheckedStage: string | undefined
    const bindings: Binding[] = []
    let allocatedCheck: Effect.Effect<void, SkillsError, Notion | Store | Crypto.Crypto> =
      Effect.void
    const beforeDispatch = Effect.gen(function* () {
      // Legacy native/migration plans retain their original review and recovery
      // protocol. The complete-resource/source contract opts into fresh stages.
      if (plan.complete_resources !== 1 && plan.source_projection === undefined) return
      if (lastCheckedStage === stage) return
      yield* verifyLibrary(library, plan)
      // Immutable chunks within one stage share its checked intent. Every new
      // page/metadata stage and the first new write of a resumed invocation gets
      // fresh scope, definition, relation and acknowledged-allocation checks.
      if (stage !== "review_outcome") {
        const fresh = yield* inventory(library, plan.name)
        yield* createChecked(() => checkInventory(plan, fresh))
        yield* assertSourceProjectionDefinition(library, plan, skillPage)
        yield* allocatedCheck
      }
      lastCheckedStage = stage
    }).pipe(withReadOnlyNotion)
    // The original ACK namespace includes the optional Sources table. Additive
    // descriptor registration must never move an existing operation to a fresh
    // namespace where an unknown original POST would appear unattempted.
    const readingProjections: Array<{
      page_id: string
      file_id: string
      path: string
      skill_page_id: string
      projection: string
    }> = []
    const dispatch = yield* sharedCreateDispatch(
      plan.library,
      acceptsNativeImportReadback(plan)
        ? { ...plan, recovery_file_projections: readingProjections }
        : plan,
      beforeDispatch,
    )
    if (original) {
      const reconciled = yield* reconcileSharedCreate(library, plan).pipe(Effect.result)
      if (reconciled._tag === "Success") return reconciled.success
      if (
        !resumable ||
        !["SHARED_CREATE_UNRESOLVED", "SHARED_RECORD_UNRESOLVED"].includes(
          reconciled.failure.code,
        ) ||
        !(yield* dispatch.canResume)
      )
        return yield* Effect.fail(reconciled.failure)
    }
    const store = yield* Store
    if (!original)
      yield* store.writeJson(key, {
        version: 1,
        scope,
        library_id: library.library_id,
        plan,
        ownership_receipt_version: 1,
        dispatch_receipt_version: 1,
      })
    yield* invalidateSubscriptionCatalog(scope, library.skills.database_id)
    const api = dispatch.api,
      main = plan.files.find((file) => file.path === plan.entrypoint)!
    return yield* Effect.gen(function* () {
      const raw = yield* api.request("v1/pages", sharedCreateMainRequest(library, plan), {
        method: "POST",
      })
      skillPage = yield* createChecked(() => pageReceipt(raw))
      const resolved = yield* resolveSharedCreateSource(plan, skillPage)
      let facts: SharedCreatePlan = resolved.facts
      const acceptReadback = acceptsNativeImportReadback(plan)
      if (acceptReadback) stage = "manifest"
      const observe = (file: SharedCreatePlan["files"][number], page: string) =>
        Effect.gen(function* () {
          if (!acceptReadback || facts.version !== 1) return file
          const current = facts
          const observed = yield* observeNativeImportFile(plan, file, scope, skillPage!, page)
          facts = {
            ...current,
            files: current.files.map((item) => (item.file_id === file.file_id ? observed : item)),
          }
          return observed
        })
      const resolvedMain = yield* observe(
        facts.files.find((file) => file.path === facts.entrypoint)!,
        skillPage,
      )
      const allocatedPage = skillPage
      const sourceSelection =
        plan.source_projection?.version !== 2
          ? undefined
          : {
              properties: {
                [library.skills.property_ids.Source!]: {
                  rich_text: spans(resolved.selection!.source_id),
                },
                [library.skills.property_ids.Projection!]: {
                  rich_text: spans(createProjectionBaseline(resolvedMain)),
                },
              },
            }
      const enableBody = {
        properties: { [library.skills.property_ids.Enabled!]: { checkbox: true } },
      }
      allocatedCheck = Effect.gen(function* () {
        const sourceSelected =
          sourceSelection === undefined ||
          (yield* dispatch.acknowledged(`v1/pages/${allocatedPage}`, sourceSelection, "PATCH"))
        const enabled =
          sharedCreateEnabled(plan) &&
          (yield* dispatch.acknowledged(`v1/pages/${allocatedPage}`, enableBody, "PATCH"))
        yield* verifyIndex(
          library,
          sourceSelected ? facts : plan,
          allocatedPage,
          bindings,
          enabled,
          true,
          sourceSelected ? undefined : "",
          acceptReadback ? resolved.facts : undefined,
        )
        for (const binding of bindings) {
          const native = facts.files.find((file) => file.file_id === binding.file_id)
          if (native !== undefined) yield* assertBody(binding.page_id, native.projection.markdown)
          else {
            const resource = plan.resources?.find((file) => file.file_id === binding.file_id)
            if (resource === undefined)
              return yield* Effect.fail(
                fail(
                  "SHARED_CREATE_SCOPE",
                  "An allocated page is outside the original complete file set.",
                ),
              )
            const description = yield* createChecked(() =>
              projectSharedNotionMarkdown(sharedCreateResourceDescription(resource), {
                version: sharedCreateProjectionVersion(plan.files),
                purpose: "data_source_create",
              }),
            )
            yield* assertBody(binding.page_id, description.markdown, acceptReadback)
          }
        }
      })
      bindings.push({
        file_id: main.file_id,
        path: main.path,
        page_id: skillPage,
        event_id: resolvedMain.event.event_id,
      })
      const publishReadingBaseline = (file: SharedCreatePlan["files"][number], page: string) =>
        Effect.gen(function* () {
          if (!acceptReadback || file.event.kind !== "projected") return
          const original = resolved.facts.files.find((item) => item.file_id === file.file_id)!
          const projection = createProjectionBaseline(file)
          if (projection === createProjectionBaseline(original)) return
          if (page !== skillPage)
            readingProjections.push({
              page_id: page,
              file_id: file.file_id,
              path: file.path,
              skill_page_id: skillPage!,
              projection,
            })
          const propertyId =
            page === skillPage
              ? library.skills.property_ids.Projection!
              : library.files.property_ids.Projection!
          stage = `reading_baseline:${file.file_id}`
          yield* api.request(
            `v1/pages/${page}`,
            {
              properties: { [propertyId]: { rich_text: spans(projection) } },
            },
            { method: "PATCH" },
          )
        })
      stage = "manifest"
      yield* manifestRecord(library, plan, skillPage, "create")
      stage = "retained_inputs"
      yield* retainInputs(library, plan, skillPage, "create")
      yield* publishReadingBaseline(resolvedMain, skillPage)
      for (const source of sharedCreateFixedSources(plan)) {
        stage = "source_registration"
        yield* registerSourceBinding(library, {
          skillPageId: skillPage,
          mode: "create",
          fixedSource: {
            url: source.url,
            commit: source.commit,
            root: source.root,
            tree: source.tree,
            files: source.files,
          },
        })
      }
      stage = "main_body"
      yield* assertBody(skillPage, resolvedMain.projection.markdown)
      if (plan.source_projection?.version === 2) {
        stage = "retained_source_selection"
        yield* verifySharedCreateRetained(library, skillPage, plan.source_projection.retained)
        const selection = sourceSelection!
        if (!(yield* dispatch.acknowledged(`v1/pages/${skillPage}`, selection, "PATCH"))) {
          const current = yield* api.request(`v1/pages/${skillPage}`)
          if (
            text(sharedSkillProperty(current, library, "Source").rich_text) !== "" ||
            text(sharedSkillProperty(current, library, "Projection").rich_text) !== ""
          )
            return yield* Effect.fail(
              fail(
                "SHARED_CREATE_REVIEW_REQUIRED",
                "The new retained-source page no longer has its original unselected source and empty projection.",
              ),
            )
        }
        const selected = yield* api.request(`v1/pages/${skillPage}`, selection, { method: "PATCH" })
        if ((yield* createChecked(() => pageReceipt(selected))) !== skillPage)
          return yield* Effect.fail(
            fail(
              "SHARED_CREATE_RECEIPT_INVALID",
              "The initial source selection acknowledgement belongs to another page.",
            ),
          )
      }
      for (const file of facts.files.filter((file) => file.path !== facts.entrypoint)) {
        stage = `create_file:${file.file_id}`
        const rawFile = yield* api.request(
          "v1/pages",
          sharedCreateFileRequest(library, skillPage, file),
          { method: "POST" },
        )
        const page = yield* createChecked(() => pageReceipt(rawFile))
        const binding = {
          file_id: file.file_id,
          path: file.path,
          page_id: page,
          event_id: file.event.event_id,
        }
        bindings.push(binding)
        stage = `body:${file.file_id}`
        const observedFile = yield* observe(file, page)
        binding.event_id = observedFile.event.event_id
        yield* assertBody(page, observedFile.projection.markdown)
        yield* publishReadingBaseline(observedFile, page)
      }
      for (const file of facts.resources ?? []) {
        stage = `create_resource:${file.file_id}`
        const ids = library.files.property_ids,
          rich = (value: string) => ({ rich_text: spans(value) })
        const description = projectSharedNotionMarkdown(sharedCreateResourceDescription(file), {
          version: sharedCreateProjectionVersion(plan.files),
          purpose: "data_source_create",
        })
        const rawFile = yield* api.request(
          "v1/pages",
          {
            parent: { type: "data_source_id", data_source_id: library.files.data_source_id },
            properties: {
              [ids.Name!]: { title: spans(file.path.split("/").at(-1) ?? file.path) },
              [ids["File ID"]!]: rich(file.file_id),
              [ids.Path!]: rich(file.path),
              [ids.Projection!]: rich(""),
              [ids.Status!]: {
                select: { name: file.event.kind === "deleted" ? "tombstone" : "custom" },
              },
              [ids.Skill!]: { relation: [{ id: skillPage }] },
            },
            markdown: sharedNotionMarkdownWire(description),
            markdown_version: "v2",
          },
          { method: "POST" },
        )
        const page = yield* createChecked(() => pageReceipt(rawFile))
        bindings.push({
          file_id: file.file_id,
          path: file.path,
          page_id: page,
          event_id: file.event.event_id,
        })
        yield* assertBody(page, description.markdown, acceptReadback)
      }
      if (acceptReadback) {
        stage = "retained_inputs"
        for (const file of facts.files) yield* retainCreatedBody(library, file, skillPage, "create")
      }
      stage = "file_events"
      for (const event of sharedCreateEvents(facts))
        yield* appendSharedRecord(library, {
          mode: "create",
          recordId: event.event_id,
          operationId: event.event_id,
          skillPageId: skillPage,
          kind: "file_event",
          entityId: event.file_id,
          payload: event,
        })
      stage = "complete_pre_enable"
      const shouldEnable = sharedCreateEnabled(plan)
      const enabledBefore =
        shouldEnable && (yield* dispatch.acknowledged(`v1/pages/${skillPage}`, enableBody, "PATCH"))
      yield* verifyIndex(library, facts, skillPage, bindings, enabledBefore)
      const currentMembers = yield* inventory(library, plan.name)
      yield* createChecked(() => checkInventory(plan, currentMembers))
      yield* verifyFacts(library, facts, skillPage)
      for (const file of facts.files)
        yield* assertBody(
          bindings.find((binding) => binding.file_id === file.file_id)!.page_id,
          file.projection.markdown,
        )
      for (const file of plan.resources ?? [])
        yield* loadSharedResourceContent(library, {
          skillPageId: skillPage,
          content: file.prepared.content,
        })
      stage = "enable"
      yield* assertSourceProjectionDefinition(library, plan, skillPage)
      if (shouldEnable) {
        const enabled = yield* api.request(`v1/pages/${skillPage}`, enableBody, { method: "PATCH" })
        if ((yield* createChecked(() => pageReceipt(enabled))) !== skillPage)
          return yield* Effect.fail(
            fail("SHARED_CREATE_RECEIPT_INVALID", "The enable receipt belongs to another page."),
          )
      }
      stage = "complete_post_enable"
      yield* verifyIndex(library, facts, skillPage, bindings, shouldEnable)
      yield* verifyFacts(library, facts, skillPage)
      stage = "outcome"
      yield* saveOutcome(
        library,
        plan,
        skillPage,
        "applied",
        acceptReadback
          ? "IMPORTED_READBACK_AND_RESOURCES_VERIFIED"
          : "EXACT_NATIVE_TREE_AND_EVENTS_VERIFIED",
        bindings,
      )
      yield* retire(plan, scope, bindings)
      const current = yield* api.request(`v1/pages/${skillPage}`)
      const record = yield* createChecked(() =>
        sharedRecordFromPage(current, sourceFor(library), library.skills.data_source_id),
      )
      if (record.locator.skill_id !== plan.skill_id || record.locator.page_id !== skillPage)
        return yield* Effect.fail(
          fail(
            "SHARED_CREATE_SCOPE",
            "The completed native page changed its stable binding before the final read.",
          ),
        )
      return {
        status: "created" as const,
        operation: "create" as const,
        action: "created" as const,
        skill_page_id: skillPage,
        page_id: skillPage,
        skill_id: plan.skill_id,
        entrypoint: plan.entrypoint,
        record,
        ref: record.ref,
        operation_id: plan.operation_id,
        verified: true as const,
        reused: false as const,
        requires_fresh_read: true as const,
        ...(acceptReadback
          ? {
              markdown_acceptance: {
                policy: "notion_import_readback_v1",
                roundtrip_required: false,
                representation_changed: facts.files
                  .filter(
                    (file) =>
                      file.projection.markdown !==
                      plan.files.find((original) => original.file_id === file.file_id)!.projection
                        .markdown,
                  )
                  .map((file) => file.path),
              },
            }
          : {}),
        protection: sharedCreateProtection,
        ...(yield* createChecked(() =>
          sharedCreateExpectations(facts, bindings, resolved.selection),
        )),
      }
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          // A known semantic mismatch gets a small review fact. An uncertain
          // transport result never triggers another POST, PATCH, rollback or retry.
          if (
            skillPage !== undefined &&
            [
              "BODY_INCOMPLETE",
              "SHARED_CREATE_BODY_MISMATCH",
              "SHARED_CREATE_REVIEW_REQUIRED",
              "SHARED_CREATE_RECEIPT_INVALID",
            ].includes(error.code) &&
            stage !== "manifest" &&
            stage !== "retained_inputs" &&
            stage !== "outcome"
          ) {
            const failedStage = stage
            stage = "review_outcome"
            yield* saveOutcome(library, plan, skillPage, "needs_review", error.code, bindings).pipe(
              Effect.mapError((failure) => recover(failure, plan, "review_outcome", skillPage)),
            )
            stage = failedStage
          }
          return yield* Effect.fail(recover(error, plan, stage, skillPage))
        }),
      ),
      Effect.provideService(Notion, api),
    )
  })
}

/** Compact-index gate: completed native creates cost only small outcome metadata. */
export function loadPendingSharedCreates(
  library: SharedLibrary,
  input: {
    readonly skillPageId: string
    readonly events: readonly FileEvent[]
    readonly headers?: readonly SharedOperationHeader[]
  },
) {
  return Effect.gen(function* () {
    const headers = input.headers ?? (yield* querySharedOperationIndex(library, input.skillPageId))
    const candidates = headers.filter(
      (header) =>
        /^skill-create-[a-f0-9]{64}$/u.test(header.record_id) &&
        header.entity_id === sharedCreateManifestEntity,
    )
    if (candidates.length === 0) return [] as readonly SharedCreatePlan[]
    const outcomes = new Map<string, Outcome>()
    const outcomeHashes = new Map<string, string>()
    if (headers.some((header) => header.entity_id === sharedCreateOutcomesEntity)) {
      for (const row of yield* querySharedRecords(library, {
        skillPageId: input.skillPageId,
        kind: "operation",
        entityId: sharedCreateOutcomesEntity,
      })) {
        const outcome = yield* createChecked(() => decodeOutcome(row))
        if (headers.find((header) => header.record_id === row.record_id)?.hash !== row.hash)
          return yield* Effect.fail(
            fail(
              "SHARED_CREATE_INVALID",
              "A creation outcome differs from its exact compact header.",
            ),
          )
        outcomes.set(outcome.operation_id, outcome)
        outcomeHashes.set(outcome.operation_id, row.hash)
      }
    }
    const pending: SharedCreatePlan[] = []
    for (const header of candidates) {
      const terminal = outcomes.get(header.record_id)
      if (terminal?.status === "applied") {
        if (terminal.version === 2 && terminal.manifest_record_hash !== header.hash)
          return yield* Effect.fail(
            fail(
              "SHARED_CREATE_INVALID",
              "The migration completion belongs to another exact original manifest.",
            ),
          )
        const projected = terminal.version === 1 ? terminal.source_projection : undefined
        if (projected !== undefined && projected.manifest_record_hash !== header.hash)
          return yield* Effect.fail(
            fail(
              "SHARED_CREATE_INVALID",
              "The source projection completion belongs to another original manifest.",
            ),
          )
        if (
          terminal.bindings.length === 0 ||
          !terminal.bindings.some((binding) => binding.page_id === input.skillPageId)
        )
          return yield* Effect.fail(
            fail("SHARED_CREATE_INVALID", "A native creation completion has no main page binding."),
          )
        for (const binding of terminal.bindings) {
          const event = input.events.find((event) => event.event_id === binding.event_id)
          const local = projected?.local_customization === 1
          if (
            event === undefined ||
            event.file_id !== binding.file_id ||
            (!local &&
              event.kind !== "adopted" &&
              ((terminal.version !== 2 && projected === undefined) ||
                event.kind !== "projected")) ||
            (local && !["adopted", "projected", "deleted"].includes(event.kind)) ||
            (projected !== undefined &&
              ((!local && event.kind !== "projected") ||
                (event.kind === "projected" && event.source_revision !== projected.revision)))
          )
            return yield* Effect.fail(
              fail(
                "SHARED_CREATE_UNRESOLVED",
                "The exact native create outcome lacks a visible original ownership event.",
              ),
            )
          const { event_id: _event, ...fields } = event
          if (
            event.event_id !==
            `${terminal.version === 2 ? "migration-event" : "create-file"}-${yield* sha256(canonicalSharedJson({ version: 1, ...fields }))}`
          )
            return yield* Effect.fail(
              fail(
                "SHARED_CREATE_INVALID",
                "The native create event differs from its complete content identity.",
              ),
            )
          if (local)
            yield* createChecked(() => {
              const byId = new Map(input.events.map((item) => [item.event_id, item]))
              const ancestors = new Map<string, FileEvent>()
              const collect = (id: string): void => {
                if (ancestors.has(id)) return
                const current = byId.get(id)
                if (current === undefined || current.file_id !== binding.file_id)
                  throw fail(
                    "SHARED_CREATE_UNRESOLVED",
                    "The local create completion is missing its exact original C1 ancestry.",
                  )
                ancestors.set(id, current)
                for (const parent of current.parents) collect(parent)
              }
              collect(event.event_id)
              resolveFileState(binding.file_id, [...ancestors.values()])
            })
        }
        continue
      }
      if (
        terminal?.status === "needs_review" &&
        (yield* completedSharedCreateRecovery(library, {
          skillPageId: input.skillPageId,
          originalManifestHeader: header,
          originalOutcome: terminal,
          originalOutcomeHash: outcomeHashes.get(header.record_id)!,
          events: input.events,
          headers,
        }))
      )
        continue
      if (
        terminal === undefined &&
        (yield* completedSharedCreatePrefixRecovery(library, {
          skillPageId: input.skillPageId,
          originalManifestHeader: header,
          events: input.events,
          headers,
        }))
      )
        continue
      pending.push(
        yield* loadSharedCreatePlan(library, {
          skillPageId: input.skillPageId,
          operationId: header.record_id,
        }),
      )
    }
    return pending
  })
}

/** Recovery reuses the original schema, identity, membership and Source guards. */
export function verifySharedCreateRecoveryScope(
  library: SharedLibrary,
  plan: SharedCreatePlan,
  page: string,
) {
  return Effect.gen(function* () {
    yield* verifyLibrary(library, plan)
    const records = yield* inventory(library, plan.name)
    const found = yield* createChecked(() => checkInventory(plan, records))
    if (found?.record.locator.page_id !== page)
      return yield* Effect.fail(
        fail(
          "SHARED_CREATE_RECOVERY_REQUIRED",
          "The original stable Skill has another current allocation.",
        ),
      )
    yield* assertSourceProjectionDefinition(library, plan, page)
  })
}
/** Exact native reference request shared with original-ACK recovery validation. */
export function sharedCreateFileRequest(
  library: SharedLibrary,
  skillPage: string,
  file: SharedCreatePlan["files"][number],
) {
  const ids = library.files.property_ids,
    rich = (value: string) => ({ rich_text: spans(value) })
  return {
    parent: { type: "data_source_id", data_source_id: library.files.data_source_id },
    properties: {
      [ids.Name!]: { title: spans(file.path.split("/").at(-1) ?? file.path) },
      [ids["File ID"]!]: rich(file.file_id),
      [ids.Path!]: rich(file.path),
      [ids.Projection!]: rich(createProjectionBaseline(file)),
      [ids.Status!]: {
        select: {
          name:
            file.event.kind === "projected"
              ? "following"
              : file.event.kind === "deleted"
                ? "tombstone"
                : "custom",
        },
      },
      [ids.Skill!]: { relation: [{ id: skillPage }] },
    },
    markdown: sharedNotionMarkdownWire(file.projection),
    markdown_version: "v2",
  }
}
export function sharedCreateMainRequest(library: SharedLibrary, plan: SharedCreatePlan) {
  const main = plan.files.find((file) => file.path === plan.entrypoint)!
  return {
    parent: { type: "data_source_id", data_source_id: library.skills.data_source_id },
    properties: recordProperties(plan),
    markdown: sharedNotionMarkdownWire(main.projection),
    markdown_version: "v2",
  }
}
export {
  manifestRecord as retainSharedCreateManifest,
  retainInputs as retainSharedCreateInputs,
  verifyIndex as verifySharedCreateRecoveryIndex,
}

/** Public native creation entry. Existing shared pages always use other operations. */
export function createSharedNative(
  library: SharedLibrary,
  input: {
    readonly portable: PortableSkill
    readonly defaultContext?: boolean
    readonly enabled?: boolean
    readonly completeResources?: boolean
    readonly members?: readonly string[]
    readonly requires?: readonly string[]
    readonly dryRun?: boolean
  },
) {
  return Effect.gen(function* () {
    const plan = yield* prepareSharedCreate(library, input)
    if (input.dryRun)
      return {
        status: "planned" as const,
        operation: "create" as const,
        action: "planned" as const,
        dry_run: true as const,
        operation_id: plan.operation_id,
        skill_id: plan.skill_id,
        entrypoint: plan.entrypoint,
        plan,
        protection: sharedCreateProtection,
      }
    return yield* executeSharedCreate(library, { plan, mode: "create" })
  })
}

/** Migration origin uses the existing native dispatcher and recovery boundary. */
export function createSharedMigrationNative(
  library: SharedLibrary,
  input: {
    readonly migrationInput: unknown
    readonly candidate: unknown
    readonly dryRun?: boolean
  },
) {
  return Effect.gen(function* () {
    const plan = yield* prepareSharedMigrationCreate(library, input)
    if (input.dryRun)
      return {
        status: "planned" as const,
        operation: "create" as const,
        action: "planned" as const,
        dry_run: true as const,
        operation_id: plan.operation_id,
        skill_id: plan.skill_id,
        entrypoint: plan.entrypoint,
        plan,
        protection: sharedCreateProtection,
      }
    return yield* executeSharedCreate(library, {
      plan,
      mode: "create",
      migrationInput: input.migrationInput,
    })
  })
}
