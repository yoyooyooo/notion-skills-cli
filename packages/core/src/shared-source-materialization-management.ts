import { readMaterializationClosure } from "./shared-source-materialization-closure.ts"
import { Context, Effect, Schema } from "effect"
import { authScope } from "./catalog.ts"
import { invalidateCurrentLibraryCatalog, invalidateSnapshotCache } from "./cache.ts"
import { fail, property, text, type ContentRecord } from "./model.ts"
import { Notion } from "./notion.ts"
import { pageId } from "./ref.ts"
import { skillIdentity } from "./shared-content.ts"
import { currentSourceOriginContains } from "./shared-current-source-management.ts"
import { queryCurrentSkillIndex } from "./shared-current-index.ts"
import { resolveCurrentSkillConsumption } from "./shared-current-consumption.ts"
import { relationIds } from "./shared-current-relations.ts"
import { readCurrentOperationIntent } from "./shared-current-operation.ts"
import {
  currentSourcePlan,
  prepareCurrentSharedSourceContent,
  readCurrentSourceGitOrigin,
} from "./shared-current-source.ts"
import {
  CurrentSourceInputSchema,
  prepareCurrentSource,
  resolveCurrentSourceContributions,
  validateCurrentSourceContributions,
  validateCurrentSourceInput,
  type CurrentSourceDeclaration,
  type PreparedCurrentSourceInput,
} from "./shared-current-source-input.ts"
import { writePreparedCurrentSource } from "./shared-current-source-write.ts"
import { SourceManagerExecution, withCurrentSourceWriter } from "./shared-current-source-writer.ts"
import {
  inspectSourceSkillAdoption,
  uninitializedSourceSkill,
  SourceMaterializationWriteScopeSchema,
  type SourceMaterializationWriteScope,
} from "./shared-current-source-adoption.ts"
import {
  SourceMaterializationRequestSchema,
  decodeSourceMaterializationRequest,
  type SourceMaterializationRequest,
  type SourceMaterializationReceipt,
} from "./shared-source-materialization-model.ts"
import {
  materializationChecked,
  materializationRecord,
  materializationSkillId,
  parseMaterializationRegistration,
  queryMaterializationPages,
  readMaterializationRegistration,
  sourceRegistrationDigest,
  type MaterializationRegistration,
} from "./shared-source-materialization-registration.ts"
import { sourceMemberBindings } from "./shared-source-member-discovery.ts"
import {
  SOURCE_MATERIALIZATION_PENDING_PREFIX,
  SourceMemberCacheSchema,
  sourceMemberCacheKey,
} from "./shared-source-materialization-state.ts"
import { SharedSourcePlanSchema } from "./shared-source-plan-model.ts"
import { validateSharedSourcePlan, type SharedSourcePlan } from "./shared-source-plan.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256, Store } from "./store.ts"
import type { SharedLibrary } from "./shared-library-model.ts"

/** The actual provider remains the default; controlled unit observations use the same planner and writer. */
export const CurrentSourceMaterializationProvider = Context.Reference<{
  readonly prepare: typeof prepareCurrentSource
}>("ntn-skills/CurrentSourceMaterializationProvider", {
  defaultValue: () => ({ prepare: prepareCurrentSource }),
})

const FrozenPlanSchema = Schema.Struct({
  operation_id: Schema.String,
  declaration: CurrentSourceInputSchema,
  commit: Schema.String,
  scope: SourceMaterializationWriteScopeSchema,
  previous_plan: Schema.optional(SharedSourcePlanSchema),
})
type FrozenPlan = typeof FrozenPlanSchema.Type
const FrozenMaterializationSchema = Schema.Struct({
  version: Schema.Literal(1),
  request: SourceMaterializationRequestSchema,
  skill_ids: Schema.Array(Schema.String),
  requires: Schema.Array(
    Schema.Struct({
      page_id: Schema.String,
      skill_id: Schema.String,
      pages: Schema.Array(Schema.String),
    }),
  ),
  plans: Schema.Array(FrozenPlanSchema),
})
type FrozenMaterialization = typeof FrozenMaterializationSchema.Type
const pendingCodes = new Set([
  "CURRENT_OPERATION_PENDING",
  "CURRENT_OPERATION_UNRESOLVED",
  "WRITE_OUTCOME_UNKNOWN",
  "CURRENT_WRITE_UNRESOLVED",
  "LOCAL_LOCK_BUSY",
  "CURRENT_SOURCE_BUSY",
])

function legacyAcceptedCommit(raw: unknown): string | undefined {
  const values = Object.entries(property(property(raw).properties)).flatMap(([key, value]) =>
    key === "Upstream Revision" ? [property(value)] : [],
  )
  const value = values.length === 1 ? text(values[0]!.rich_text) : ""
  return /^[a-f0-9]{40}$/u.test(value) ? value : undefined
}
function currentReady(library: SharedLibrary, raw: unknown) {
  return Effect.gen(function* () {
    if (yield* materializationChecked(() => uninitializedSourceSkill(library, raw))) return false
    const record = yield* materializationChecked(() => materializationRecord(library, raw))
    if (record.locator.type !== "shared_skill") return false
    const index = yield* queryCurrentSkillIndex(library, record.locator.page_id, raw)
    if (index.state.state !== "ready") return false
    yield* resolveCurrentSkillConsumption(library, index)
    return true
  })
}
function unionSourcePlan(
  previous: SharedSourcePlan | undefined,
  prepared: PreparedCurrentSourceInput,
) {
  if (previous === undefined) return prepared.plan
  const next = prepared.plan
  if (
    previous.base?.kind !== "git" ||
    next.base?.kind !== "git" ||
    previous.mounts.length ||
    next.mounts.length ||
    previous.base.source.url !== next.base.source.url ||
    previous.base.source.commit !== next.base.source.commit ||
    previous.base.source.tree !== next.base.source.tree
  )
    throw fail(
      "SOURCE_MATERIALIZATION_REVISION_CHANGED",
      "Additive materialization must preserve the accepted Git origin and commit.",
    )
  const files = new Map(previous.base.source.files.map((file) => [file.source_path, file]))
  for (const file of next.base.source.files) {
    const old = files.get(file.source_path)
    if (old !== undefined && canonicalSharedJson(old) !== canonicalSharedJson(file))
      throw fail(
        "SOURCE_MATERIALIZATION_REVISION_CHANGED",
        "The same accepted Git file has conflicting bytes or modes.",
      )
    files.set(file.source_path, file)
  }
  return validateSharedSourcePlan({
    ...next,
    base: {
      kind: "git",
      source: {
        ...next.base.source,
        files: [...files.values()].sort((a, b) =>
          a.source_path < b.source_path ? -1 : a.source_path > b.source_path ? 1 : 0,
        ),
      },
    },
  })
}
function prepareFrozenMaterialization(plan: FrozenPlan) {
  return Effect.gen(function* () {
    const selected = plan.declaration.contributions.filter((entry) =>
      plan.scope.skill_ids.includes(entry.skill_id),
    )
    const prepared = yield* (yield* CurrentSourceMaterializationProvider).prepare(
      { ...plan.declaration, contributions: selected },
      {
        exactCommit: plan.commit,
        memberKeys: [...new Set(selected.map((entry) => entry.member_key))],
        metrics: (yield* Notion).metrics,
      },
    )
    const union = yield* materializationChecked(() => unionSourcePlan(plan.previous_plan, prepared))
    const source = yield* prepareCurrentSharedSourceContent(union)
    return {
      ...prepared,
      declaration: plan.declaration,
      configuration_sha256: yield* sha256(canonicalSharedJson(plan.declaration)),
      plan: union,
      prepared_source: source,
      targets: prepared.targets.map((target) => ({
        ...target,
        files: target.files.map((file) => ({
          ...file,
          authority: { ...file.authority, revision: source.revision },
        })),
      })),
    } satisfies PreparedCurrentSourceInput
  })
}
function assertManagedSource(sourceId: string) {
  return Effect.gen(function* () {
    const manager = yield* SourceManagerExecution
    if (manager === null || !manager.source_ids.includes(sourceId))
      return yield* Effect.fail(
        fail(
          "SOURCE_MANAGER_SCOPE_MISMATCH",
          "The configured manager does not authorize this Source.",
          { source_id: sourceId },
        ),
      )
  })
}
function collectRequest(
  library: SharedLibrary,
  request: SourceMaterializationRequest,
  registration: MaterializationRegistration,
  rows: readonly unknown[],
) {
  return Effect.gen(function* () {
    const bindings = yield* sourceMemberBindings(library, registration, rows)
    const roots = bindings.get(request.target.member_key) ?? []
    const assigned =
      roots.length === 0
        ? yield* resolveCurrentSourceContributions({
            source_id: request.target.source_id,
            members: [request.target.member_key],
            overrides: [],
          })
        : roots.map((entry) => ({
            member_key: request.target.member_key,
            skill_id: entry.skill_id,
          }))
    if (assigned.length !== 1 || assigned[0]!.skill_id !== request.target.expected_skill_id)
      return yield* Effect.fail(
        fail(
          "SOURCE_MEMBER_IDENTITY_CHANGED",
          "The candidate no longer identifies one exact Source member and Skill.",
        ),
      )
    const root = roots.find((entry) => entry.skill_id === request.target.expected_skill_id)
    if (root !== undefined && root.raw === undefined)
      return yield* Effect.fail(
        fail(
          "SOURCE_MEMBER_OWNER_MISSING",
          "A declared member lost its physical owner. Restore or reconcile it explicitly before materialization.",
        ),
      )
    const byPage = new Map(rows.map((raw) => [String(property(raw).id), raw]))
    const selected = new Map<string, { raw?: unknown; ready: boolean }>()
    const edges: { page_id: string; skill_id: string; pages: readonly string[] }[] = []
    const active = new Set<string>()
    const stack: { raw: unknown; exit?: boolean }[] =
      root?.raw === undefined ? [] : [{ raw: root.raw }]
    if (root?.raw === undefined) selected.set(request.target.expected_skill_id, { ready: false })
    while (stack.length !== 0) {
      const item = stack.pop()!,
        raw = item.raw
      const record = yield* materializationChecked(() => materializationRecord(library, raw))
      if (record.locator.type !== "shared_skill")
        return yield* Effect.fail(
          fail(
            "SOURCE_MEMBER_IDENTITY_CHANGED",
            "Requires must identify a registered physical Skill.",
          ),
        )
      const id = record.locator.skill_id,
        page = record.locator.page_id
      if (item.exit) {
        active.delete(page)
        continue
      }
      if (active.has(page))
        return yield* Effect.fail(
          fail("CURRENT_REQUIRES_CYCLE", "The selected Requires closure contains a cycle."),
        )
      if (selected.has(id)) continue
      if (selected.size >= 100)
        return yield* Effect.fail(
          fail(
            "CURRENT_RELATION_GRAPH_LIMIT",
            "Materialization Requires exceeds its bounded request.",
          ),
        )
      if (request.purpose === "use" && record.enabled === false)
        return yield* Effect.fail(
          fail("SKILL_DISABLED", "Explicit use cannot enable a disabled Skill."),
        )
      active.add(page)
      const ready = yield* currentReady(library, raw)
      selected.set(id, { raw, ready })
      stack.push({ raw, exit: true })
      if (request.purpose === "use") {
        const pages = yield* relationIds(library, raw, "Requires")
        edges.push({ page_id: page, skill_id: id, pages: [...pages].sort() })
        for (const dependency of [...pages].reverse()) {
          const child =
            byPage.get(dependency) ?? (yield* (yield* Notion).request(`v1/pages/${dependency}`))
          stack.push({ raw: child })
        }
      }
    }
    return { selected, edges }
  })
}
function freezeRequest(library: SharedLibrary, request: SourceMaterializationRequest) {
  return Effect.gen(function* () {
    yield* assertManagedSource(request.target.source_id)
    if (request.authorization_root !== undefined) {
      const closure = yield* readMaterializationClosure(
        library,
        request.authorization_root.skill_id,
      )
      if (
        request.purpose !== "use" ||
        canonicalSharedJson(closure.authorization_root) !==
          canonicalSharedJson(request.authorization_root) ||
        !closure.entries.some(
          (entry) =>
            entry.record.locator.type === "shared_skill" &&
            entry.record.locator.skill_id === request.target.expected_skill_id,
        )
      )
        return yield* Effect.fail(
          fail(
            "SOURCE_MATERIALIZATION_AUTHORITY_CHANGED",
            "The exact accepted root no longer Requires this member.",
          ),
        )
      if (closure.entries.some((entry) => entry.record.enabled === false))
        return yield* Effect.fail(
          fail("SKILL_DISABLED", "The authorized use closure contains a disabled member."),
        )
    }
    const registration = yield* readMaterializationRegistration(library, request.target.source_id)
    if (!registration.definition.enabled)
      return yield* Effect.fail(
        fail("SOURCE_DISABLED", "Materialization cannot enable a disabled Source."),
      )
    if ((yield* sourceRegistrationDigest(registration)) !== request.target.registration_digest)
      return yield* Effect.fail(
        fail(
          "SOURCE_REGISTRATION_CHANGED",
          "The Source registration changed; refresh its exact candidate.",
        ),
      )
    if (registration.state.state !== "ready" && registration.state.state !== "uninitialized")
      return yield* Effect.fail(
        fail("CURRENT_OPERATION_PENDING", "This Source has an unfinished management operation."),
      )
    const origin =
      registration.current === undefined
        ? undefined
        : yield* readCurrentSourceGitOrigin(library, {
            ...registration.current,
            source_id: request.target.source_id,
          })
    const acceptedCommit =
      origin?.commit || registration.legacy_registration?.last_revision || undefined
    if (
      request.target.expected_source_commit !== undefined &&
      acceptedCommit !== undefined &&
      request.target.expected_source_commit !== acceptedCommit
    )
      return yield* Effect.fail(
        fail(
          "SOURCE_MATERIALIZATION_REVISION_CHANGED",
          "The accepted Source commit changed; refresh its exact candidate.",
        ),
      )
    if (
      request.target.expected_source_revision !== undefined &&
      registration.current?.revision !== request.target.expected_source_revision &&
      request.target.expected_source_commit === undefined
    )
      return yield* Effect.fail(
        fail(
          "SOURCE_MATERIALIZATION_REVISION_CHANGED",
          "A changed Source plan needs its original commit evidence or a fresh candidate.",
        ),
      )
    const rows = yield* queryMaterializationPages(library, "skills")
    const collected = yield* collectRequest(library, request, registration, rows)
    const groups = new Map<
      string,
      { registration: MaterializationRegistration; requested: Map<string, string> }
    >()
    const allSourceRows = [...collected.selected.values()].some(
      (entry) => !entry.ready && entry.raw !== undefined,
    )
      ? yield* queryMaterializationPages(library, "sources")
      : []
    for (const [skillId, entry] of collected.selected) {
      if (entry.ready) continue
      if (skillId === request.target.expected_skill_id) {
        const group = groups.get(request.target.source_id) ?? {
          registration,
          requested: new Map<string, string>(),
        }
        group.requested.set(request.target.member_key, skillId)
        groups.set(request.target.source_id, group)
        continue
      }
      const matches: { registration: MaterializationRegistration; member: string }[] = []
      for (const raw of allSourceRows) {
        if (
          !(yield* currentSourceOriginContains(
            library,
            String(property(entry.raw).id),
            entry.raw,
            String(property(raw).id),
          ))
        )
          continue
        const registered = yield* materializationChecked(() =>
          parseMaterializationRegistration(library, raw),
        )
        const members = yield* sourceMemberBindings(library, registered, rows)
        for (const [member, owners] of members)
          if (owners.some((owner) => owner.skill_id === skillId))
            matches.push({ registration: registered, member })
      }
      if (matches.length !== 1)
        return yield* Effect.fail(
          fail(
            "SOURCE_MEMBER_IDENTITY_AMBIGUOUS",
            "A missing Requires member has no unique registered Source identity.",
          ),
        )
      const match = matches[0]!,
        id = match.registration.definition.source_id
      yield* assertManagedSource(id)
      const group = groups.get(id) ?? {
        registration: match.registration,
        requested: new Map<string, string>(),
      }
      group.requested.set(match.member, skillId)
      groups.set(id, group)
    }
    const plans: FrozenPlan[] = [],
      prepared = new Map<string, PreparedCurrentSourceInput>()
    for (const [sourceId, group] of groups) {
      const current = group.registration
      if (
        !current.definition.enabled ||
        (current.state.state !== "ready" && current.state.state !== "uninitialized")
      )
        return yield* Effect.fail(
          fail("CURRENT_OPERATION_PENDING", "A required Source is disabled or unfinished."),
        )
      if (
        (yield* readCurrentOperationIntent(library, { kind: "source", id: sourceId })) !== undefined
      )
        return yield* Effect.fail(
          fail("CURRENT_OPERATION_PENDING", "A Source has an unresolved finite intent."),
        )
      const members = yield* sourceMemberBindings(library, current, rows)
      const readyIds = new Set<string>()
      for (const contribution of current.contributions) {
        const existing = members
          .get(contribution.member_key)
          ?.find((entry) => entry.skill_id === contribution.skill_id)
        if (
          existing?.raw !== undefined &&
          !(yield* materializationChecked(() => uninitializedSourceSkill(library, existing.raw)))
        ) {
          if (!(yield* currentReady(library, existing.raw)))
            return yield* Effect.fail(
              fail(
                "CURRENT_OPERATION_PENDING",
                "An existing materialized contribution is not ready.",
              ),
            )
          readyIds.add(contribution.skill_id)
        }
      }
      const contributionList = [...current.contributions]
      for (const [member_key, skill_id] of group.requested) {
        readyIds.add(skill_id)
        const existing = contributionList.filter((entry) => entry.member_key === member_key)
        if (existing.length > 0 && !existing.some((entry) => entry.skill_id === skill_id))
          return yield* Effect.fail(
            fail(
              "SOURCE_MEMBER_IDENTITY_CHANGED",
              "A current contribution chose a different stable Skill.",
            ),
          )
        if (!existing.some((entry) => entry.skill_id === skill_id))
          contributionList.push({ member_key, skill_id, mount_path: "", mapping: {}, exclude: [] })
      }
      const declaration: CurrentSourceDeclaration = yield* materializationChecked(() =>
        validateCurrentSourceInput({
          version: 1,
          definition: current.definition,
          contributions: validateCurrentSourceContributions(contributionList),
        }),
      )
      const adoptions = []
      for (const id of readyIds) {
        const raw = rows.find((row) => materializationSkillId(library, row) === id)
        if (
          raw !== undefined &&
          (yield* materializationChecked(() => uninitializedSourceSkill(library, raw)))
        )
          adoptions.push(yield* inspectSourceSkillAdoption(library, raw))
      }
      const previous =
        current.current === undefined
          ? undefined
          : yield* currentSourcePlan(library, { ...current.current, source_id: sourceId })
      const accepted =
        previous?.base?.kind === "git"
          ? previous.base.source.commit
          : current.legacy_registration?.last_revision ||
            (sourceId === request.target.source_id
              ? request.target.expected_source_commit
              : undefined)
      const legacyCommits = new Set(
        adoptions.flatMap((entry) => {
          const raw = rows.find((row) => materializationSkillId(library, row) === entry.skill_id)
          const commit = legacyAcceptedCommit(raw)
          return commit === undefined ? [] : [commit]
        }),
      )
      if (accepted === undefined && legacyCommits.size > 1)
        return yield* Effect.fail(
          fail(
            "SOURCE_MATERIALIZATION_REVISION_CHANGED",
            "Legacy members disagree about their accepted commit.",
          ),
        )
      const fixed = accepted ?? [...legacyCommits][0]
      const selected = declaration.contributions.filter((entry) => readyIds.has(entry.skill_id))
      const initial = yield* (yield* CurrentSourceMaterializationProvider).prepare(
        { ...declaration, contributions: selected },
        {
          ...(fixed === undefined ? {} : { exactCommit: fixed }),
          memberKeys: [...new Set(selected.map((entry) => entry.member_key))],
          metrics: (yield* Notion).metrics,
        },
      )
      const scope: SourceMaterializationWriteScope = {
        source_page_id: current.page_id,
        registration_digest: yield* sourceRegistrationDigest(current),
        ...(current.legacy_registration === undefined
          ? {}
          : { legacy_registration: current.legacy_registration }),
        skill_ids: [...readyIds].sort(),
        adoptions,
      }
      const plan: FrozenPlan = {
        operation_id: `source-materialize-${yield* sha256(canonicalSharedJson([request.request_id, sourceId]))}`,
        declaration,
        commit: initial.resolved_commit,
        scope,
        ...(previous === undefined ? {} : { previous_plan: previous }),
      }
      const union = yield* materializationChecked(() => unionSourcePlan(previous, initial))
      const source = yield* prepareCurrentSharedSourceContent(union)
      prepared.set(sourceId, {
        ...initial,
        declaration,
        configuration_sha256: yield* sha256(canonicalSharedJson(declaration)),
        plan: union,
        prepared_source: source,
        targets: initial.targets.map((target) => ({
          ...target,
          files: target.files.map((file) => ({
            ...file,
            authority: { ...file.authority, revision: source.revision },
          })),
        })),
      })
      plans.push(plan)
    }
    const frozen: FrozenMaterialization = {
      version: 1,
      request,
      skill_ids: [...collected.selected.keys()],
      requires: collected.edges,
      plans,
    }
    return { frozen, prepared }
  })
}

/** A separate management action. Ordinary consumers never enter this function. */
export function materializeRegisteredSource(
  library: SharedLibrary,
  supplied: SourceMaterializationRequest,
) {
  return withCurrentSourceWriter(
    library,
    Effect.gen(function* () {
      const request = yield* materializationChecked(() =>
        decodeSourceMaterializationRequest(supplied),
      )
      if (pageId(request.library) !== library.library_id)
        return yield* Effect.fail(
          fail(
            "SOURCE_MANAGER_SCOPE_MISMATCH",
            "The materialization request belongs to another Library.",
          ),
        )
      const scope = yield* authScope,
        store = yield* Store
      const key = `${SOURCE_MATERIALIZATION_PENDING_PREFIX}/${library.library_id}/${yield* sha256(request.request_id)}.json`
      let attempted = false
      let affected: string[] = []
      let operation: string | undefined
      const result = yield* Effect.gen(function* () {
        const saved = yield* store.readJson(key, FrozenMaterializationSchema)
        if (
          saved !== undefined &&
          canonicalSharedJson(saved.request) !== canonicalSharedJson(request)
        )
          return yield* Effect.fail(
            fail(
              "SOURCE_MATERIALIZATION_REQUEST_CONFLICT",
              "A request ID cannot change its accepted materialization target.",
            ),
          )
        const initial =
          saved === undefined
            ? yield* freezeRequest(library, request)
            : { frozen: saved, prepared: new Map<string, PreparedCurrentSourceInput>() }
        const frozen = initial.frozen
        for (const plan of frozen.plans)
          yield* assertManagedSource(plan.declaration.definition.source_id)
        affected = [
          ...new Set([
            ...frozen.skill_ids,
            ...frozen.plans.flatMap((plan) => plan.scope.skill_ids),
          ]),
        ]
        if (saved === undefined && frozen.plans.length !== 0) yield* store.writeJson(key, frozen)
        const expectedRevisions = new Map<string, string>()
        for (const plan of frozen.plans) {
          operation = plan.operation_id
          const prepared =
            initial.prepared.get(plan.declaration.definition.source_id) ??
            (yield* prepareFrozenMaterialization(plan))
          const pending = yield* readCurrentOperationIntent(library, {
            kind: "source",
            id: plan.declaration.definition.source_id,
          })
          if (pending !== undefined && pending.intent.operation_id !== plan.operation_id)
            return yield* Effect.fail(
              fail("CURRENT_OPERATION_PENDING", "Another Source intent must settle first."),
            )
          attempted = true
          yield* writePreparedCurrentSource(library, {
            operation_id: plan.operation_id,
            mode: pending === undefined ? "apply" : "resume",
            prepared,
            materialization: plan.scope,
          })
          expectedRevisions.set(
            plan.declaration.definition.source_id,
            prepared.prepared_source.revision,
          )
        }
        const rawRows = yield* queryMaterializationPages(library, "skills", {
          or: frozen.skill_ids.map((id) => ({
            property: library.skills.property_ids["Skill ID"],
            rich_text: { equals: id },
          })),
        })
        const records: ContentRecord[] = []
        for (const id of frozen.skill_ids) {
          const selected = rawRows.filter((raw) => materializationSkillId(library, raw) === id)
          if (selected.length !== 1 || !(yield* currentReady(library, selected[0])))
            return yield* Effect.fail(
              fail(
                "SOURCE_MATERIALIZATION_READBACK_FAILED",
                "The exact materialized closure is not ready.",
              ),
            )
          const record = yield* materializationChecked(() =>
            materializationRecord(library, selected[0]),
          )
          if (request.purpose === "use" && record.enabled === false)
            return yield* Effect.fail(
              fail("SKILL_DISABLED", "The selected member became disabled before delivery."),
            )
          const before = frozen.requires.find((entry) => entry.skill_id === id)
          if (
            before !== undefined &&
            (record.locator.type !== "shared_skill" ||
              record.locator.page_id !== before.page_id ||
              canonicalSharedJson(
                [...(yield* relationIds(library, selected[0], "Requires"))].sort(),
              ) !== canonicalSharedJson(before.pages))
          )
            return yield* Effect.fail(
              fail(
                "SOURCE_MATERIALIZATION_CLOSURE_CHANGED",
                "The selected Requires closure changed during materialization.",
              ),
            )
          records.push(record)
        }
        // Successful receipts identify the target even when it needed no write.
        // Read actual current owners after the closure, never copy an expected
        // revision or omit the target when only another Source's Requires changed.
        const revisions: { source_id: string; revision: string }[] = []
        for (const sourceId of new Set([request.target.source_id, ...expectedRevisions.keys()])) {
          const registration = yield* readMaterializationRegistration(library, sourceId)
          const current = registration.current
          const frozenPlan = frozen.plans.find(
            (plan) => plan.declaration.definition.source_id === sourceId,
          )
          if (
            current === undefined ||
            current.state.state !== "ready" ||
            !registration.definition.enabled ||
            (expectedRevisions.has(sourceId) &&
              current.revision !== expectedRevisions.get(sourceId))
          )
            return yield* Effect.fail(
              fail(
                "SOURCE_MATERIALIZATION_READBACK_FAILED",
                "The exact materialized Source is not ready at its accepted revision.",
              ),
            )
          if (
            (yield* sourceRegistrationDigest(registration)) !==
            (frozenPlan?.scope.registration_digest ?? request.target.registration_digest)
          )
            return yield* Effect.fail(
              fail("SOURCE_REGISTRATION_CHANGED", "The accepted Source registration changed."),
            )
          const plan = yield* currentSourcePlan(library, { ...current, source_id: sourceId })
          const commit = frozenPlan?.commit ?? request.target.expected_source_commit
          if (
            commit !== undefined &&
            (plan.base?.kind !== "git" || plan.base.source.commit !== commit)
          )
            return yield* Effect.fail(
              fail(
                "SOURCE_MATERIALIZATION_REVISION_CHANGED",
                "The accepted Source commit changed before receipt publication.",
              ),
            )
          revisions.push({ source_id: sourceId, revision: current.revision })
        }
        if (frozen.plans.length !== 0) yield* store.retireKeys([key])
        return {
          version: 1,
          request_id: request.request_id,
          library_id: library.library_id,
          scope,
          target: request.target,
          ...(request.authorization_root === undefined
            ? {}
            : { authorization_root: request.authorization_root }),
          status: frozen.plans.length === 0 ? "already_ready" : "ready",
          ...(operation === undefined ? {} : { operation_id: operation }),
          records,
          affected_skill_ids: affected,
          source_revisions: revisions,
          effects: { remote_writes: attempted ? "management" : "none", projection: "none" },
        } satisfies SourceMaterializationReceipt
      }).pipe(Effect.result)
      if (result._tag === "Success") return result.success
      const error = result.failure
      return {
        version: 1,
        request_id: request.request_id,
        library_id: library.library_id,
        scope,
        target: request.target,
        ...(request.authorization_root === undefined
          ? {}
          : { authorization_root: request.authorization_root }),
        status:
          pendingCodes.has(error.code) || error.code.includes("UNRESOLVED") ? "pending" : "blocked",
        ...(operation === undefined ? {} : { operation_id: operation }),
        records: [],
        affected_skill_ids: affected,
        source_revisions: [],
        effects: { remote_writes: attempted ? "unknown" : "none", projection: "none" },
        reason: error.code,
      } satisfies SourceMaterializationReceipt
    }),
  )
}

/** Receipt invalidation belongs to each consumer Store, including another host. */
export function invalidateMaterializationFacts(
  library: SharedLibrary,
  receipt: SourceMaterializationReceipt,
) {
  return Effect.gen(function* () {
    if (receipt.library_id !== library.library_id)
      return yield* Effect.fail(
        fail("SOURCE_MANAGER_SCOPE_MISMATCH", "The receipt belongs to another Library."),
      )
    // A preflight rejection can prove the selected candidate stale without
    // writing remotely. Retire its exact target even when no affected set exists.
    const affected = new Set([receipt.target.expected_skill_id, ...receipt.affected_skill_ids])
    const scope = yield* authScope
    yield* invalidateCurrentLibraryCatalog(scope, library.skills.database_id)
    for (const skillId of affected)
      yield* invalidateSnapshotCache(skillIdentity(library.library_id, skillId), scope)
    const store = yield* Store,
      key = sourceMemberCacheKey(scope, library.library_id)
    const cached = yield* store.readJson(key, SourceMemberCacheSchema)
    if (cached !== undefined)
      yield* store.writeJson(key, {
        ...cached,
        candidates: cached.candidates.filter(
          (candidate) => !affected.has(candidate.expected_skill_id),
        ),
      })
  })
}
