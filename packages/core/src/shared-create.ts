import { Effect, Schema } from "effect"
import { authScope } from "./catalog.ts"
import { invalidateSnapshotCache, invalidateSubscriptionCatalog } from "./cache.ts"
import {
  aliasFor,
  decode,
  fail,
  listSchema,
  property,
  SkillsError,
  type SharedSkillRecord,
  type Source,
} from "./model.ts"
import { Notion } from "./notion.ts"
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
import { querySharedOperationIndex, type SharedOperationHeader } from "./shared-operation-index.ts"
import { appendSharedRecord, canonicalSharedJson, querySharedRecords } from "./shared-records.ts"
import { querySharedSkillIndex } from "./shared-skill-index.ts"
import {
  completeSharedSkillRelationIds,
  type SharedSkillRelationField,
} from "./shared-router-members.ts"
import { sha256, Store } from "./store.ts"
import { sharedNotionMarkdownWire } from "./shared-notion-projection.ts"
import {
  decodeSharedCreateOutcome as decodeOutcome,
  sharedCreateOutcomeId as outcomeId,
  sharedCreateManifestRecordHash as createManifestRecordHash,
  type SharedCreateOutcome as Outcome,
  type SharedCreateBinding as Binding,
} from "./shared-create-outcome.ts"
import { completedSharedCreateRecovery } from "./shared-create-recovery-completion.ts"
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
  validateSharedCreatePlan,
  type SharedCreatePlan,
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
      canonicalSharedJson(current) !== canonicalSharedJson(library) ||
      (plan !== undefined && canonicalSharedJson(plan.library) !== canonicalSharedJson(library))
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
  }
  return exact[0]
}
export function prepareSharedCreate(
  library: SharedLibrary,
  input: {
    readonly portable: PortableSkill
    readonly defaultContext?: boolean
    readonly members?: readonly string[]
    readonly requires?: readonly string[]
  },
) {
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
    const plan = yield* makeSharedCreatePlan(library, {
      portable: input.portable,
      ...(input.defaultContext === undefined ? {} : { defaultContext: input.defaultContext }),
      ...(input.portable.kind === "router" || input.members !== undefined ? { members } : {}),
      ...(required === undefined ? {} : { requires: required }),
    })
    yield* guardOriginalCreate(scope, plan)
    yield* createChecked(() => checkInventory(plan, records))
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
    if (canonicalSharedJson(candidate.library) !== canonicalSharedJson(library))
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
function createProjectionBaseline(file: SharedCreatePlan["files"][number]) {
  return file.event.kind === "projected"
    ? canonicalSharedJson({ ...file.event.projection, source_revision: file.event.source_revision })
    : ""
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
    [ids.Source!]: rich(plan.version === 2 ? (plan.origin.candidate.source?.source_id ?? "") : ""),
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
function assertBody(page: string, expected: string) {
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
      yield* appendSharedRecord(library, {
        mode,
        recordId: file.content.object_id,
        operationId: `retain-${file.content.sha256}`,
        skillPageId: page,
        kind: "object",
        entityId: file.content.object_id,
        payload: sharedCreateBodyPayload(file.projection.markdown),
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
        : { ...fields, version: 1 }
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
) {
  return Effect.gen(function* () {
    const index = yield* querySharedSkillIndex(library, page)
    if (
      index.skill_id !== plan.skill_id ||
      index.name !== plan.name ||
      index.description !== plan.description ||
      index.kind !== plan.content_kind ||
      index.default_context !== plan.default_context ||
      index.enabled !== enabled ||
      index.source_reference !==
        (plan.version === 2 ? (plan.origin.candidate.source?.source_id ?? "") : "")
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
    if (plan.version === 2) {
      for (const file of plan.files) {
        const binding = [index.main, ...index.files].find((item) => item.file_id === file.file_id)
        const baseline =
          file.event.kind === "projected"
            ? { ...file.event.projection, source_revision: file.event.source_revision }
            : null
        const supporting = index.files.find((item) => item.file_id === file.file_id)
        if (
          !binding ||
          canonicalSharedJson(binding.baseline ?? null) !== canonicalSharedJson(baseline) ||
          (supporting !== undefined &&
            supporting.display_status !==
              (file.event.kind === "projected" ? "following" : "custom"))
        )
          return yield* Effect.fail(
            fail(
              "SHARED_CREATE_REVIEW_REQUIRED",
              "The migrated projection baseline or ownership display differs from the frozen initial fact.",
            ),
          )
      }
    }
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
    if (plan.version === 2 && plan.origin.candidate.source !== null) {
      const expected = plan.origin.candidate.source
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
    if (events.length !== plan.files.length)
      return yield* Effect.fail(
        fail(
          "SHARED_CREATE_REVIEW_REQUIRED",
          "The complete new Skill history differs from the initial frozen event set.",
        ),
      )
    for (const file of plan.files) {
      const selected = events.filter((event) => event.file_id === file.file_id)
      if (
        selected.length !== 1 ||
        canonicalSharedJson(selected[0]) !== canonicalSharedJson(file.event)
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
      canonicalSharedJson(manifest.library) !== canonicalSharedJson(library)
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
    const files = []
    for (const file of manifest.files) {
      const text = yield* readRetainedCreateInput(library, input.skillPageId, file.input)
      files.push({ path: file.input_path, bytes: new TextEncoder().encode(text) })
    }
    const projectionVersion = yield* createChecked(() =>
      sharedCreateProjectionVersion(manifest.files),
    )
    const plan = yield* makeSharedCreatePlan(
      library,
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
        ...(manifest.content_kind === "router" || manifest.members.length > 0
          ? { members: manifest.members }
          : {}),
        ...(manifest.requires === undefined ? {} : { requires: manifest.requires }),
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
    const expected = plan.files
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
    yield* retainInputs(library, plan, page, "reconcile").pipe(
      Effect.mapError((error) => recover(error, plan, "retained_inputs", page)),
    )
    if (plan.version === 2 && plan.origin.candidate.source !== null) {
      const source = plan.origin.candidate.source
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
    for (const file of plan.files)
      yield* appendSharedRecord(library, {
        mode: "reconcile",
        recordId: file.event.event_id,
        operationId: file.event.event_id,
        skillPageId: page,
        kind: "file_event",
        entityId: file.file_id,
        payload: file.event,
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
      ...(yield* createChecked(() => sharedCreateExpectations(plan, outcome.bindings))),
    }
  })
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
    const scope = yield* authScope,
      store = yield* Store
    yield* verifyLibrary(library, plan)
    const key = yield* sharedCreateJournalKey(scope, library.library_id, plan.operation_id)
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
      return yield* reconcileSharedCreate(library, saved.plan)
    }
    yield* guardOriginalCreate(scope, plan)
    const records = yield* inventory(library, plan.name)
    if (yield* createChecked(() => checkInventory(plan, records)))
      return yield* reconcileSharedCreate(library, plan)
    yield* store.writeJson(key, {
      version: 1,
      scope,
      library_id: library.library_id,
      plan,
      ownership_receipt_version: 1,
    })
    yield* invalidateSubscriptionCatalog(scope, library.skills.database_id)
    const api = yield* Notion,
      main = plan.files.find((file) => file.path === plan.entrypoint)!
    let stage = "create_skill",
      skillPage: string | undefined
    const bindings: Binding[] = []
    return yield* Effect.gen(function* () {
      const raw = yield* api.request(
        "v1/pages",
        {
          parent: { type: "data_source_id", data_source_id: library.skills.data_source_id },
          properties: recordProperties(plan),
          markdown: sharedNotionMarkdownWire(main.projection),
          markdown_version: "v2",
        },
        { method: "POST" },
      )
      skillPage = yield* createChecked(() => pageReceipt(raw))
      bindings.push({
        file_id: main.file_id,
        path: main.path,
        page_id: skillPage,
        event_id: main.event.event_id,
      })
      stage = "manifest"
      yield* manifestRecord(library, plan, skillPage, "create")
      stage = "retained_inputs"
      yield* retainInputs(library, plan, skillPage, "create")
      if (plan.version === 2 && plan.origin.candidate.source !== null) {
        stage = "source_registration"
        const source = plan.origin.candidate.source
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
      yield* assertBody(skillPage, main.projection.markdown)
      for (const file of plan.files.filter((file) => file.path !== plan.entrypoint)) {
        stage = `create_file:${file.file_id}`
        const ids = library.files.property_ids,
          rich = (value: string) => ({ rich_text: spans(value) })
        const rawFile = yield* api.request(
          "v1/pages",
          {
            parent: { type: "data_source_id", data_source_id: library.files.data_source_id },
            properties: {
              [ids.Name!]: { title: spans(file.path.split("/").at(-1) ?? file.path) },
              [ids["File ID"]!]: rich(file.file_id),
              [ids.Path!]: rich(file.path),
              [ids.Projection!]: rich(createProjectionBaseline(file)),
              [ids.Status!]: {
                select: { name: file.event.kind === "projected" ? "following" : "custom" },
              },
              [ids.Skill!]: { relation: [{ id: skillPage }] },
            },
            markdown: sharedNotionMarkdownWire(file.projection),
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
        stage = `body:${file.file_id}`
        yield* assertBody(page, file.projection.markdown)
      }
      stage = "file_events"
      for (const file of plan.files)
        yield* appendSharedRecord(library, {
          mode: "create",
          recordId: file.event.event_id,
          operationId: file.event.event_id,
          skillPageId: skillPage,
          kind: "file_event",
          entityId: file.file_id,
          payload: file.event,
        })
      stage = "complete_pre_enable"
      yield* verifyIndex(library, plan, skillPage, bindings, false)
      const currentMembers = yield* inventory(library, plan.name)
      yield* createChecked(() => checkInventory(plan, currentMembers))
      yield* verifyFacts(library, plan, skillPage)
      for (const file of plan.files)
        yield* assertBody(
          bindings.find((binding) => binding.file_id === file.file_id)!.page_id,
          file.projection.markdown,
        )
      stage = "enable"
      const enabled = yield* api.request(
        `v1/pages/${skillPage}`,
        { properties: { [library.skills.property_ids.Enabled!]: { checkbox: true } } },
        { method: "PATCH" },
      )
      if ((yield* createChecked(() => pageReceipt(enabled))) !== skillPage)
        return yield* Effect.fail(
          fail("SHARED_CREATE_RECEIPT_INVALID", "The enable receipt belongs to another page."),
        )
      stage = "complete_post_enable"
      yield* verifyIndex(library, plan, skillPage, bindings, true)
      yield* verifyFacts(library, plan, skillPage)
      stage = "outcome"
      yield* saveOutcome(
        library,
        plan,
        skillPage,
        "applied",
        "EXACT_NATIVE_TREE_AND_EVENTS_VERIFIED",
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
        protection: sharedCreateProtection,
        ...(yield* createChecked(() => sharedCreateExpectations(plan, bindings))),
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
          )
            yield* saveOutcome(library, plan, skillPage, "needs_review", error.code, bindings).pipe(
              Effect.mapError((failure) => recover(failure, plan, "review_outcome", skillPage)),
            )
          return yield* Effect.fail(recover(error, plan, stage, skillPage))
        }),
      ),
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
        if (
          terminal.bindings.length === 0 ||
          !terminal.bindings.some((binding) => binding.page_id === input.skillPageId)
        )
          return yield* Effect.fail(
            fail("SHARED_CREATE_INVALID", "A native creation completion has no main page binding."),
          )
        for (const binding of terminal.bindings) {
          const event = input.events.find((event) => event.event_id === binding.event_id)
          if (
            event === undefined ||
            event.file_id !== binding.file_id ||
            (event.kind !== "adopted" && (terminal.version !== 2 || event.kind !== "projected"))
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

/** Public native creation entry. Existing shared pages always use other operations. */
export function createSharedNative(
  library: SharedLibrary,
  input: {
    readonly portable: PortableSkill
    readonly defaultContext?: boolean
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
