import { Effect, Schema } from "effect"
import { authScope, databaseId } from "./catalog.ts"
import {
  decode,
  fail,
  listSchema,
  property,
  text,
  validateDisplayName,
  validateDescription,
  type Source,
} from "./model.ts"
import { Notion } from "./notion.ts"
import { pageId, fileRef } from "./ref.ts"
import { loadSharedLibrary, type SharedLibrary } from "./shared-library.ts"
import {
  sharedMetadataEntryFromPage,
  sharedRecordFromPage,
  sharedSkillId,
  sharedSkillProperty,
} from "./shared-content.ts"
import { querySharedMetadataInventory } from "./shared-metadata-inventory.ts"
import { querySkillFiles } from "./skill-file-index.ts"
import { observeSharedBody } from "./shared-page-body.ts"
import { assertSharedFileReferences } from "./shared-file-references.ts"
import { materializeSharedNativeFile } from "./shared-native-file-content.ts"
import { appendSharedRecord, canonicalSharedJson, querySharedRecords } from "./shared-records.ts"
import {
  commitSharedObservationPlan,
  reconcileSharedObservation,
} from "./shared-observation-operation.ts"
import type { SharedOperationHeader } from "./shared-operation-index.ts"
import {
  pendingFileOperations,
  pendingFileOperationKey,
  retainPendingFileOperation,
  sharedPendingObservationPrefix,
  type SharedPendingFileScope,
} from "./shared-pending-file-operations.ts"
import { Store } from "./store.ts"
import {
  adoptionChecked,
  makeSharedNativeAdoptionPlan,
  nativeAdoptionEntity,
  nativeAdoptionIdentity,
  nativeAdoptionOutcomeId,
  nativeAdoptionProtection,
  validateSharedNativeAdoptionPlan,
  type NativeAdoptionMetadata,
  type SharedNativeAdoptionPlan,
} from "./shared-native-adoption-model.ts"

const OutcomeSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("native_adoption_outcome"),
  status: Schema.Literal("adopted"),
  operation_id: Schema.String.check(Schema.isPattern(/^skill-adopt-[a-f0-9]{64}$/u)),
  skill_page_id: Schema.String,
  skill_id: Schema.String,
  file_id: Schema.String,
  body_sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
})
const sourceFor = (library: SharedLibrary): Source => ({
  alias: library.library_id,
  title: "",
  role: "content",
  database_id: library.skills.database_id,
  data_source_ids: [library.skills.data_source_id],
  shared_library: library,
})
const recovery = (library: SharedLibrary, selected: string, operation?: string) => ({
  ...(operation === undefined ? {} : { adoption_operation_id: operation }),
  next: {
    argv: [
      "ntn-skills",
      "adopt",
      selected,
      "--database",
      library.skills.database_id,
      "--reconcile",
    ],
  },
})

function rich(raw: unknown, library: SharedLibrary, name: string) {
  const field = sharedSkillProperty(raw, library, name)
  if (
    field.type !== "rich_text" ||
    !Array.isArray(field.rich_text) ||
    (field.has_more !== undefined && field.has_more !== false)
  )
    throw fail("SHARED_ADOPTION_SCOPE", "Adoption requires complete registered text properties.", {
      property: name,
    })
  for (const part of field.rich_text) {
    const value = property(part)
    if (
      typeof value.plain_text !== "string" &&
      !(value.type === "text" && typeof property(value.text).content === "string")
    )
      throw fail("SHARED_ADOPTION_SCOPE", "A registered adoption property is unreadable.", {
        property: name,
      })
  }
  return text(field.rich_text)
}

function metadata(
  raw: unknown,
  library: SharedLibrary,
  selected: string,
  plan?: SharedNativeAdoptionPlan,
): NativeAdoptionMetadata {
  const entry = sharedMetadataEntryFromPage(raw, sourceFor(library), library.skills.data_source_id)
  const id = entry.state === "registered" ? entry.record.locator.page_id : entry.page_id
  const kind = entry.state === "registered" ? entry.record.kind : entry.kind
  if (
    id !== selected ||
    kind !== "skill" ||
    (plan === undefined
      ? entry.state !== "unregistered"
      : entry.state !== "registered" ||
        entry.record.locator.skill_id !== plan.skill_id ||
        entry.record.enabled)
  )
    throw fail(
      "SHARED_ADOPTION_SCOPE",
      "Select one unregistered disabled native Skill; existing managed identities require their ordinary authoring or original recovery path.",
      { page_id: selected },
    )
  for (const name of ["Source", "Projection", "References"])
    if (rich(raw, library, name) !== "")
      throw fail(
        "SHARED_ADOPTION_BOUND",
        "The page already has source or file lifecycle metadata; preserve it for its existing workflow.",
        { property: name, page_id: selected },
      )
  if (rich(raw, library, "Main File ID") !== (plan?.file_id ?? ""))
    throw fail("SHARED_ADOPTION_BOUND", "The page already has a different main-file binding.", {
      page_id: selected,
    })
  for (const name of ["Members", "Requires"]) {
    if (library.skills.property_ids[name] === undefined) continue
    const field = sharedSkillProperty(raw, library, name)
    if (
      field.type !== "relation" ||
      !Array.isArray(field.relation) ||
      field.has_more === true ||
      field.relation.length !== 0
    )
      throw fail(
        "SHARED_ADOPTION_BOUND",
        "Initialize a native draft before adding managed relations.",
        { property: name, page_id: selected },
      )
  }
  const defaults = sharedSkillProperty(raw, library, "Default Context")
  if (typeof defaults.checkbox !== "boolean")
    throw fail("SHARED_ADOPTION_SCOPE", "Default Context must be a complete checkbox.")
  return {
    name: validateDisplayName(entry.state === "registered" ? entry.record.name : entry.name),
    description: validateDescription(rich(raw, library, "Description")),
    default_context: defaults.checkbox,
  }
}

function emptyFiles(library: SharedLibrary, selected: string) {
  return Effect.gen(function* () {
    const files = yield* querySkillFiles({
      dataSourceId: library.files.data_source_id,
      skillPageId: selected,
      propertyIds: library.files.property_ids,
    })
    if (files.length !== 0)
      return yield* Effect.fail(
        fail(
          "SHARED_ADOPTION_BOUND",
          "The page already owns Files; adoption cannot replace or omit that inventory.",
          { page_id: selected },
        ),
      )
  })
}

/** Only compact headers are needed to prove no prior/foreign lifecycle exists. */
function recordsWithin(library: SharedLibrary, selected: string, allowed: ReadonlySet<string>) {
  return Effect.gen(function* () {
    const ids = library.records.property_ids
    const query = new URLSearchParams()
    for (const name of ["Record ID", "Kind", "Skill"]) query.append("filter_properties", ids[name]!)
    const cursors = new Set<string>()
    let cursor: string | undefined
    for (;;) {
      const raw = yield* (yield* Notion).request(
        `v1/data_sources/${library.records.data_source_id}/query?${query}`,
        {
          page_size: 100,
          filter: { property: ids.Skill, relation: { contains: selected } },
          ...(cursor === undefined ? {} : { start_cursor: cursor }),
        },
      )
      const batch = yield* adoptionChecked(() => {
        if (property(raw).object !== "list")
          throw fail("SHARED_ADOPTION_HISTORY", "Records history is incomplete.")
        return decode(listSchema(Schema.Unknown), raw)
      })
      for (const row of batch.results) {
        const values = Object.values(property(property(row).properties)).map(property)
        const record = values.find((value) => value.id === ids["Record ID"])
        const relation = values.find((value) => value.id === ids.Skill)
        if (
          property(property(row).parent).data_source_id !== library.records.data_source_id ||
          record?.type !== "rich_text" ||
          !Array.isArray(record.rich_text) ||
          record.has_more === true ||
          relation?.type !== "relation" ||
          !Array.isArray(relation.relation) ||
          relation.relation.length !== 1 ||
          property(relation.relation[0]).id !== selected ||
          relation.has_more === true ||
          !allowed.has(text(record.rich_text))
        )
          return yield* Effect.fail(
            fail(
              "SHARED_ADOPTION_HISTORY",
              "The page has existing or conflicting Records history; do not initialize a replacement lifecycle.",
              { page_id: selected },
            ),
          )
      }
      if (!batch.has_more) {
        if (batch.next_cursor !== null)
          return yield* Effect.fail(
            fail("SHARED_ADOPTION_HISTORY", "Records history pagination is incomplete."),
          )
        return
      }
      if (!batch.next_cursor || cursors.has(batch.next_cursor))
        return yield* Effect.fail(
          fail("SHARED_ADOPTION_HISTORY", "Records history pagination did not advance."),
        )
      cursor = batch.next_cursor
      cursors.add(cursor)
    }
  })
}

function originalFacts(plan: SharedNativeAdoptionPlan) {
  return new Set([
    plan.operation_id,
    plan.observation.operation_id,
    plan.observation.event.content.object_id,
    plan.observation.event.event_id,
  ])
}

function verifyOriginalPage(plan: SharedNativeAdoptionPlan, assigned: boolean) {
  return Effect.gen(function* () {
    const library = yield* loadSharedLibrary(plan.library.skills.database_id)
    if (canonicalSharedJson(library) !== canonicalSharedJson(plan.library))
      return yield* Effect.fail(
        fail("SHARED_ADOPTION_SCOPE", "The registered library changed after adoption preparation."),
      )
    const raw = yield* (yield* Notion).request(`v1/pages/${plan.skill_page_id}`)
    const current = yield* adoptionChecked(() =>
      metadata(raw, library, plan.skill_page_id, assigned ? plan : undefined),
    )
    if (canonicalSharedJson(current) !== canonicalSharedJson(plan.metadata))
      return yield* Effect.fail(
        fail(
          "WRITE_CONFLICT",
          "The draft metadata changed after the original adoption observation.",
        ),
      )
    yield* emptyFiles(library, plan.skill_page_id)
    const body = yield* observeSharedBody(plan.skill_page_id)
    if (
      body.fingerprint.sha256 !== plan.observation.body.fingerprint.sha256 ||
      body.bytes !== plan.observation.body.bytes ||
      canonicalSharedJson(body.native_body_completion ?? null) !==
        canonicalSharedJson(plan.observation.body.native_body_completion ?? null)
    )
      return yield* Effect.fail(
        fail(
          "WRITE_CONFLICT",
          "The complete original draft body changed; preserve it instead of adopting another version.",
        ),
      )
    return raw
  })
}

function appendPlan(plan: SharedNativeAdoptionPlan, mode: "create" | "reconcile") {
  return appendSharedRecord(plan.library, {
    mode,
    recordId: plan.operation_id,
    operationId: plan.operation_id,
    skillPageId: plan.skill_page_id,
    kind: "operation",
    entityId: nativeAdoptionEntity,
    payload: plan,
    payloadContainsBody: true,
  })
}
function expectedOutcome(plan: SharedNativeAdoptionPlan) {
  return {
    version: 1 as const,
    kind: "native_adoption_outcome" as const,
    status: "adopted" as const,
    operation_id: plan.operation_id,
    skill_page_id: plan.skill_page_id,
    skill_id: plan.skill_id,
    file_id: plan.file_id,
    body_sha256: plan.observation.body.fingerprint.sha256,
  }
}
function result(plan: SharedNativeAdoptionPlan, reconciled: boolean) {
  return {
    status: reconciled ? ("reconciled" as const) : ("adopted" as const),
    verified: true as const,
    verification: reconciled
      ? ("original_adoption_outcome" as const)
      : ("current_page_at_adoption" as const),
    adoption_operation_id: plan.operation_id,
    skill_page_id: plan.skill_page_id,
    skill_id: plan.skill_id,
    main_file_id: plan.file_id,
    body_sha256: plan.observation.body.fingerprint.sha256,
    enabled_at_adoption: false as const,
    ...(reconciled ? {} : { enabled: false as const }),
    ref: fileRef(sharedSkillId(plan.library_id, plan.skill_id), "SKILL.md"),
    protection: nativeAdoptionProtection,
    requires_fresh_read: true as const,
    next: {
      argv: [
        "ntn-skills",
        "read",
        plan.skill_page_id,
        "--database",
        plan.library.skills.database_id,
        "--authoring",
      ],
    },
  }
}

/** Historical completion only: no current body or equality can authorize a replay. */
export function reconcileSharedNativeAdoption(planInput: SharedNativeAdoptionPlan) {
  return Effect.gen(function* () {
    const plan = yield* validateSharedNativeAdoptionPlan(planInput)
    yield* appendPlan(plan, "reconcile")
    yield* reconcileSharedObservation(plan.library, plan.observation)
    yield* appendSharedRecord(plan.library, {
      mode: "reconcile",
      recordId: nativeAdoptionOutcomeId(plan.operation_id),
      operationId: plan.operation_id,
      skillPageId: plan.skill_page_id,
      kind: "operation",
      entityId: nativeAdoptionEntity,
      payload: expectedOutcome(plan),
    })
    return result(plan, true)
  })
}

/** Readers inspect only the small completion, never the retained original body plan. */
export function assertSharedNativeAdoptionComplete(
  library: SharedLibrary,
  selected: string,
  headers: readonly SharedOperationHeader[],
) {
  return Effect.gen(function* () {
    for (const header of headers.filter(
      (value) =>
        value.entity_id === nativeAdoptionEntity && value.record_id.startsWith("skill-adopt-"),
    )) {
      const records = yield* querySharedRecords(library, {
        skillPageId: selected,
        kind: "operation",
        entityId: nativeAdoptionEntity,
        recordId: nativeAdoptionOutcomeId(header.record_id),
      })
      if (records.length !== 1)
        return yield* Effect.fail(
          fail(
            "SHARED_ADOPTION_PENDING",
            "The original native adoption has no verified completion. Reconcile that exact operation before authoring or consumption.",
            recovery(library, selected, header.record_id),
          ),
        )
      const outcome = yield* adoptionChecked(() =>
        Schema.decodeUnknownSync(OutcomeSchema)(records[0]!.payload, { onExcessProperty: "error" }),
      )
      const identity = yield* nativeAdoptionIdentity(library.library_id, selected)
      if (
        outcome.operation_id !== header.record_id ||
        outcome.skill_page_id !== selected ||
        records[0]!.operation_id !== header.record_id ||
        outcome.skill_id !== identity.skill_id ||
        outcome.file_id !== identity.file_id
      )
        return yield* Effect.fail(
          fail(
            "SHARED_ADOPTION_INVALID",
            "The retained adoption completion belongs to another original operation.",
          ),
        )
    }
  })
}

export function adoptSharedNative(
  target: string,
  options: {
    readonly database?: string
    readonly dryRun?: boolean
    readonly reconcile?: boolean
  } = {},
) {
  return Effect.gen(function* () {
    const selected = pageId(target)
    if (!selected || (options.dryRun && options.reconcile))
      return yield* Effect.fail(
        fail(
          "INVALID_ARGUMENT",
          "Adopt requires an exact page ID or URL; dry-run and reconcile are mutually exclusive.",
        ),
      )
    const api = yield* Notion,
      store = yield* Store
    const raw = yield* api.request(`v1/pages/${selected}`)
    const parent = property(property(raw).parent)
    const database = typeof parent.database_id === "string" ? pageId(parent.database_id) : undefined
    if (
      !database ||
      (options.database !== undefined && database !== (yield* databaseId(options.database)))
    )
      return yield* Effect.fail(
        fail("SHARED_ADOPTION_SCOPE", "The selected page is outside the exact shared library."),
      )
    const library = yield* loadSharedLibrary(database)
    const scope = yield* authScope
    const identity = yield* nativeAdoptionIdentity(library.library_id, selected)
    const pendingScope: SharedPendingFileScope = {
      prefix: yield* sharedPendingObservationPrefix(scope, library.library_id, identity.skill_id),
      scope,
      library_id: library.library_id,
      skill_id: identity.skill_id,
      skill_page_id: selected,
    }
    const pending = yield* pendingFileOperations(pendingScope)
    if (pending.some((value) => value.plan.kind !== "native_adoption"))
      return yield* Effect.fail(
        fail(
          "SHARED_ADOPTION_PENDING",
          "The selected identity already has an unresolved authoring operation.",
        ),
      )
    const retained = yield* querySharedRecords(library, {
      skillPageId: selected,
      kind: "operation",
      entityId: nativeAdoptionEntity,
      payloadContainsBody: true,
    })
    const plans = retained.filter((value) => value.record_id.startsWith("skill-adopt-"))
    if (plans.length > 1 || pending.length > 1)
      return yield* Effect.fail(
        fail("SHARED_ADOPTION_INVALID", "Several original adoption intents claim the same page."),
      )
    const shared =
      plans[0] === undefined ? undefined : yield* validateSharedNativeAdoptionPlan(plans[0].payload)
    const local = pending[0]?.plan
    if (
      local !== undefined &&
      shared !== undefined &&
      canonicalSharedJson(local) !== canonicalSharedJson(shared)
    )
      return yield* Effect.fail(
        fail("SHARED_ADOPTION_INVALID", "Local and shared original adoption plans disagree."),
      )
    const original = local?.kind === "native_adoption" ? local : shared
    if (original !== undefined) {
      if (
        original.skill_page_id !== selected ||
        canonicalSharedJson(original.library) !== canonicalSharedJson(library)
      )
        return yield* Effect.fail(
          fail(
            "SHARED_ADOPTION_SCOPE",
            "The retained original adoption belongs to another page or descriptor.",
          ),
        )
      const observed = yield* reconcileSharedNativeAdoption(original).pipe(
        Effect.mapError((error) =>
          fail(error.code, error.message, {
            ...property(error.details),
            ...recovery(library, selected, original.operation_id),
          }),
        ),
      )
      if (!options.dryRun && pending[0] !== undefined) yield* store.retireKeys([pending[0].key])
      return observed
    }
    if (options.reconcile)
      return yield* Effect.fail(
        fail(
          "SHARED_ADOPTION_PENDING",
          "No original adoption is visible; absence never authorizes a replacement write.",
          recovery(library, selected),
        ),
      )
    const before = yield* adoptionChecked(() => metadata(raw, library, selected))
    yield* emptyFiles(library, selected)
    yield* recordsWithin(library, selected, new Set())
    const inventory = yield* querySharedMetadataInventory(library, "skills")
    const pages = new Set<string>()
    for (const row of inventory.pages) {
      const entry = yield* adoptionChecked(() =>
        sharedMetadataEntryFromPage(row, sourceFor(library), library.skills.data_source_id),
      )
      const page = entry.state === "registered" ? entry.record.locator.page_id : entry.page_id
      if (
        pages.has(page) ||
        (entry.state === "registered" && entry.record.locator.skill_id === identity.skill_id)
      )
        return yield* Effect.fail(
          fail(
            "SHARED_SKILL_ID_CONFLICT",
            "Another metadata entry claims the proposed native identity.",
          ),
        )
      pages.add(page)
    }
    if (!pages.has(selected))
      return yield* Effect.fail(
        fail(
          "SHARED_ADOPTION_SCOPE",
          "The selected page is absent from the complete registered Skills inventory.",
        ),
      )
    const body = yield* observeSharedBody(selected)
    yield* adoptionChecked(() =>
      assertSharedFileReferences([
        {
          path: "SKILL.md",
          bytes: new TextEncoder().encode(
            materializeSharedNativeFile(
              body.markdown,
              "SKILL.md",
              [],
              [],
              undefined,
              body.native_body_completion,
            ),
          ),
        },
      ]),
    )
    const plan = yield* makeSharedNativeAdoptionPlan({
      library,
      pageId: selected,
      metadata: before,
      body,
    })
    if (options.dryRun)
      return {
        status: "planned" as const,
        dry_run: true as const,
        plan,
        protection: nativeAdoptionProtection,
      }
    yield* retainPendingFileOperation(pendingScope, plan)
    const execution = Effect.gen(function* () {
      yield* appendPlan(plan, "create")
      yield* commitSharedObservationPlan(library, { mode: "create", plan: plan.observation })
      yield* verifyOriginalPage(plan, false)
      yield* recordsWithin(library, selected, originalFacts(plan))
      const value = (content: string) => ({ rich_text: [{ type: "text", text: { content } }] })
      const response = yield* api.request(
        `v1/pages/${selected}`,
        {
          properties: {
            [library.skills.property_ids["Skill ID"]!]: value(plan.skill_id),
            [library.skills.property_ids["Main File ID"]!]: value(plan.file_id),
          },
        },
        { method: "PATCH" },
      )
      yield* adoptionChecked(() => metadata(response, library, selected, plan))
      const saved = yield* verifyOriginalPage(plan, true)
      yield* recordsWithin(library, selected, originalFacts(plan))
      yield* appendSharedRecord(library, {
        mode: "create",
        recordId: nativeAdoptionOutcomeId(plan.operation_id),
        operationId: plan.operation_id,
        skillPageId: selected,
        kind: "operation",
        entityId: nativeAdoptionEntity,
        payload: expectedOutcome(plan),
      })
      const record = yield* adoptionChecked(() =>
        sharedRecordFromPage(saved, sourceFor(library), library.skills.data_source_id),
      )
      yield* store.retireKeys([yield* pendingFileOperationKey(pendingScope.prefix, plan)])
      return { ...result(plan, false), record }
    })
    return yield* execution.pipe(
      Effect.mapError((error) =>
        fail(error.code, error.message, {
          ...property(error.details),
          ...recovery(library, selected, plan.operation_id),
        }),
      ),
    )
  })
}
