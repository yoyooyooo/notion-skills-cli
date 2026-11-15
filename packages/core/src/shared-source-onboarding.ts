import { Clock, Effect, Option, Schema } from "effect"
import { authScope } from "./catalog.ts"
import { aliasFor, fail, property, text, type SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import { withReadOnlyNotion } from "./notion-readonly.ts"
import { normalizePath, pageId } from "./ref.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { querySharedMetadataInventory } from "./shared-metadata-inventory.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { discoverSourceDefinition } from "./shared-source-adapters.ts"
import { resolveSourceBinding, type SharedGitSourceBinding } from "./shared-source-binding.ts"
import {
  guardedSourceMutation,
  listSourceDefinitions,
  readSourceDefinition,
  sourceChecked,
  sourceField,
  sourceRich,
} from "./shared-source-definitions.ts"
import { prepareSharedSourceProjection } from "./shared-source-projection.ts"
import { withSourceUpdateLock } from "./shared-source-policy.ts"
import {
  executeSharedCreate,
  pendingSharedCreatePlans,
  previewSharedCreate,
} from "./shared-create.ts"
import { validateSharedCreatePlan } from "./shared-create-model.ts"
import { retainSourceFact } from "./shared-source-refresh.ts"
import type { SourceMemberStorage } from "./shared-source-member.ts"
import type { SourceDefinition } from "./shared-sources-model.ts"
import type { SourceSnapshot } from "./upstream-source.ts"
import { sha256 } from "./store.ts"
import { RequestBudget } from "./request-budget.ts"
import {
  SourceOnboardingPlanSchema,
  SourceOnboardingScopeSchema,
  SourceOnboardingBindingDecisionSchema,
  type SourceOnboardingBindingDecision,
  type SourceOnboardingAction,
  type SourceOnboardingBinding,
  type SourceOnboardingMember,
  type SourceOnboardingPlan,
  type SourceOnboardingReport,
} from "./shared-source-onboarding-model.ts"

const inventoryFields = [
  "Name",
  "Kind",
  "Skill ID",
  "Main File ID",
  "Enabled",
  "Origin",
  "Source Member",
  "Source",
]

function bindingFromRow(library: SharedLibrary, input: unknown): SourceOnboardingBinding {
  const row = property(input)
  if (
    typeof row.id !== "string" ||
    pageId(row.id) !== row.id ||
    row.object !== "page" ||
    row.archived === true ||
    row.in_trash === true ||
    property(row.parent).data_source_id !== library.skills.data_source_id
  )
    throw fail(
      "SOURCE_INVENTORY_INCOMPLETE",
      "A Skill inventory row is unavailable or outside the library.",
    )
  const field = (name: string) => sourceField(row, library.skills.property_ids[name]!)
  const rich = (name: string, type: "title" | "rich_text" = "rich_text") => {
    const value = field(name),
      parts = value[type]
    if (!Array.isArray(parts) || parts.length >= 25 || value.has_more === true)
      throw fail(
        "SOURCE_INVENTORY_INCOMPLETE",
        "An identity field is incomplete; absence cannot be inferred.",
        {
          page_id: row.id,
          property: name,
        },
      )
    return text(parts)
  }
  const origin = field("Origin"),
    relations = origin.relation
  if (
    origin.has_more === true ||
    !Array.isArray(relations) ||
    relations.length > 1 ||
    relations.some(
      (item) => typeof property(item).id !== "string" || !pageId(String(property(item).id)),
    )
  )
    throw fail(
      "SOURCE_BINDING_CONFLICT",
      "A Skill has incomplete or ambiguous Origin membership.",
      { page_id: row.id },
    )
  const kind = property(field("Kind").select).name,
    enabled = field("Enabled").checkbox
  if (typeof kind !== "string" || typeof enabled !== "boolean")
    throw fail("SOURCE_INVENTORY_INCOMPLETE", "A Skill has invalid kind or eligibility metadata.", {
      page_id: row.id,
    })
  return {
    page_id: row.id,
    skill_id: rich("Skill ID"),
    main_file_id: rich("Main File ID"),
    name: rich("Name", "title"),
    kind,
    enabled,
    origin: relations.length === 0 ? "none" : String(property(relations[0]).id),
    member: rich("Source Member"),
    selected_version: rich("Source"),
  }
}

export function readSourceOnboardingInventory(library: SharedLibrary) {
  return Effect.gen(function* () {
    const observation = yield* querySharedMetadataInventory(
      library,
      "skills",
      "reference",
      inventoryFields,
    )
    const rows = yield* sourceChecked(() =>
      observation.pages.map((row) => bindingFromRow(library, row)),
    )
    if (new Set(rows.map((row) => row.page_id)).size !== rows.length)
      return yield* Effect.fail(
        fail("SOURCE_INVENTORY_INCOMPLETE", "The complete inventory repeated a page."),
      )
    return rows
  })
}

function readBinding(library: SharedLibrary, target: string) {
  return Effect.gen(function* () {
    const row = yield* (yield* Notion).request(`v1/pages/${target}`)
    const binding = yield* sourceChecked(() => bindingFromRow(library, row))
    if (binding.page_id !== target)
      return yield* Effect.fail(
        fail("SOURCE_BINDING_SCOPE", "The returned page differs from the frozen target."),
      )
    return binding
  })
}

/** Repository spelling is a locator comparison, never a content or ownership proof. */
function repository(value: string) {
  try {
    const url = new URL(value)
    if (!/^https?:$/u.test(url.protocol) || url.username || url.password || url.search || url.hash)
      return null
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/u, "").replace(/\.git$/u, "")}`
  } catch {
    return null
  }
}

function matchingFixedSource(
  library: SharedLibrary,
  definition: SourceDefinition,
  target: SourceOnboardingBinding,
) {
  return Effect.gen(function* () {
    if (
      definition.adapter.type !== "git" ||
      !/^source-[a-f0-9]{64}$/u.test(target.selected_version)
    )
      return null
    const binding = yield* resolveSourceBinding(library, {
      skillPageId: target.page_id,
      sourceId: target.selected_version,
    })
    return rootForDefinition(definition, binding)
  })
}

function rootForDefinition(definition: SourceDefinition, binding: SharedGitSourceBinding) {
  const expected = definition.adapter.type === "git" ? repository(definition.adapter.url) : null
  return expected !== null && repository(binding.url) === expected ? binding.root : null
}

const identity = (library: SharedLibrary, source: string, member: string) =>
  sha256(canonicalSharedJson(["source-onboarding-v1", library.library_id, source, member])).pipe(
    Effect.map((hash) => `skill-${hash}`),
  )
const errorValue = (error: SkillsError) => ({
  code: error.code,
  message: error.message,
  ...(error.details === undefined ? {} : { details: error.details }),
})

/** The frozen parent already retains complete child inputs. Do not copy those
 * bytes into an Agent-facing error while preserving original recovery IDs. */
export function sourceOnboardingError(error: SkillsError, action: SourceOnboardingAction) {
  const details = property(error.details)
  const recovery = property(details.recovery)
  if (!Object.hasOwn(recovery, "plan"))
    return { ...errorValue(error), details: error.details ?? null }
  const { plan: originalPlan, ...rest } = recovery
  const original = property(originalPlan)
  return {
    code: error.code,
    message: error.message,
    details: {
      ...details,
      recovery: {
        ...rest,
        original_plan: {
          operation_id: original.operation_id ?? null,
          skill_id: original.skill_id ?? null,
          retained_in_parent_plan:
            action.kind === "create" &&
            canonicalSharedJson(originalPlan) === canonicalSharedJson(action.plan),
          full_input_omitted: true,
        },
      },
    },
  }
}
const alias = (name: string) => (name.trim() ? aliasFor(name) : "")

export interface SourceOnboardingReviewOptions {
  readonly sourceTimeoutMs?: number
}

function remainingReviewTime() {
  return Effect.gen(function* () {
    const budget = Option.getOrUndefined(yield* Effect.serviceOption(RequestBudget))
    if (budget === undefined) return Number.POSITIVE_INFINITY
    const usage = yield* budget.snapshot
    if (usage.exhausted !== null) return 0
    // Reserve time for local classification and a truthful partial report.
    return Math.max(
      0,
      usage.limits.duration_ms - usage.elapsed_ms - Math.min(5000, usage.limits.duration_ms / 10),
    )
  })
}

/** One current inventory and one provider observation per selected Source. No author mutations. */
function inspect(
  library: SharedLibrary,
  input: unknown,
  acquire: typeof discoverSourceDefinition,
  options: SourceOnboardingReviewOptions = {},
  retainAcquired = false,
) {
  return Effect.gen(function* () {
    const scope = yield* sourceChecked(() =>
      Schema.decodeUnknownSync(SourceOnboardingScopeSchema)(input, { onExcessProperty: "error" }),
    )
    const requested = scope.kind === "source" ? scope.members : undefined
    if (
      requested !== undefined &&
      (requested.length === 0 ||
        requested.length > 100 ||
        new Set(requested).size !== requested.length ||
        requested.some((member) => !member || (member !== "." && normalizePath(member) !== member)))
    )
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "Select one to 100 unique exact provider member keys."),
      )
    const sourceTimeout = options.sourceTimeoutMs ?? (scope.kind === "all" ? 30_000 : 120_000)
    if (!Number.isSafeInteger(sourceTimeout) || sourceTimeout <= 0 || sourceTimeout > 3_600_000)
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "sourceTimeoutMs must be an integer from 1 to 3600000."),
      )
    const rows = yield* readSourceOnboardingInventory(library)
    const pending = yield* pendingSharedCreatePlans(yield* authScope, library.library_id)
    const choices =
      scope.kind === "all"
        ? (yield* listSourceDefinitions(library)).map((row) => ({
            selector: row.page_id,
            id: row.source_id,
          }))
        : [{ selector: scope.source, id: scope.source }]
    const acquired = new Map<string, { definition: SourceDefinition; snapshot: SourceSnapshot }>()
    // These are immutable selected identities from this credential-scoped observation,
    // not a second persistent cache or a renewed current-metadata timestamp.
    const selectedProofs = new Map<string, SharedGitSourceBinding>()
    const selectedErrors = new Map<string, SkillsError>()
    type SourceReview = SourceOnboardingReport["sources"][number]
    const sources: Array<{ -readonly [K in keyof SourceReview]: SourceReview[K] }> = []
    for (const choice of choices) {
      const time = Math.min(sourceTimeout, yield* remainingReviewTime())
      if (time <= 0) {
        sources.push({
          source_id: choice.id,
          page_id: pageId(choice.selector) ?? "",
          fingerprint: null,
          provider_revision: null,
          status: "unavailable",
          members: [],
          unresolved_bindings: [],
          error: {
            code: "SOURCE_REVIEW_BUDGET",
            message: "Not checked within this invocation budget; no absence is inferred.",
          },
        })
        continue
      }
      const result = yield* Effect.gen(function* () {
        const definition = yield* readSourceDefinition(library, choice.selector)
        if (!definition.enabled) return { definition, snapshot: null }
        const snapshot = yield* acquire(definition, { metrics: (yield* Notion).metrics })
        if (!snapshot.revision || (snapshot.unavailable?.length ?? 0) > 0)
          return yield* Effect.fail(
            fail(
              "SOURCE_REFRESH_INCOMPLETE",
              "Provider discovery has unresolved resources; no absence or admission is inferred.",
              {
                source_id: definition.source_id,
                source_page_id: definition.page_id,
                provider_revision: snapshot.revision || null,
                unavailable_count: snapshot.unavailable?.length ?? 0,
                unavailable: (snapshot.unavailable ?? []).slice(0, 20),
                unavailable_truncated: (snapshot.unavailable?.length ?? 0) > 20,
              },
            ),
          )
        const absent =
          requested?.filter(
            (key) => !snapshot.members.some((member) => member.member_key === key),
          ) ?? []
        if (absent.length > 0)
          return yield* Effect.fail(
            fail(
              "SOURCE_MEMBER_UNAVAILABLE",
              "The complete configured discovery did not return all explicitly requested members.",
              { members: absent },
            ),
          )
        if (
          (yield* readSourceDefinition(library, definition.page_id)).fingerprint !==
          definition.fingerprint
        )
          return yield* Effect.fail(
            fail("SOURCE_DEFINITION_CHANGED", "Source configuration changed during discovery."),
          )
        return { definition, snapshot }
      }).pipe(
        Effect.timeout(time),
        Effect.catchTag("TimeoutError", () =>
          Effect.fail(
            fail(
              "SOURCE_REVIEW_TIMEOUT",
              "This Source did not complete within its bounded discovery time; other Sources remain independently reviewable.",
              { source: choice.id, duration_ms: time },
            ),
          ),
        ),
        Effect.result,
      )
      if (result._tag === "Failure") {
        sources.push({
          source_id: choice.id,
          page_id: pageId(choice.selector) ?? "",
          fingerprint: null,
          provider_revision: null,
          status: "unavailable",
          members: [],
          unresolved_bindings: [],
          error: errorValue(result.failure),
        })
        continue
      }
      const { definition, snapshot } = result.success
      if (snapshot !== null && retainAcquired)
        acquired.set(definition.page_id, { definition, snapshot })
      const source: { -readonly [K in keyof SourceReview]: SourceReview[K] } = {
        source_id: definition.source_id,
        page_id: definition.page_id,
        fingerprint: definition.fingerprint,
        provider_revision: snapshot?.revision ?? null,
        status: snapshot === null ? "disabled" : "reviewed",
        members: [],
        unresolved_bindings: [],
        error: null,
      }
      sources.push(source)
      if (snapshot === null) continue
      const bindings = rows.filter((row) => row.origin === definition.page_id)
      const proofs = new Map<string, string>()
      const proofErrors = new Map<string, SkillsError>()
      // Immutable selected-source metadata is sufficient. Do not reread custom bodies or fetch old provider bytes.
      for (const row of rows.filter(
        (row) =>
          row.kind === "skill" &&
          (row.origin === "none" || (row.origin === definition.page_id && row.member === "")),
      )) {
        if (
          definition.adapter.type !== "git" ||
          !/^source-[a-f0-9]{64}$/u.test(row.selected_version)
        )
          continue
        const key = `${row.page_id}:${row.selected_version}`
        if (!selectedProofs.has(key) && !selectedErrors.has(key)) {
          const proof = yield* (
            (yield* remainingReviewTime()) <= 0
              ? Effect.fail(
                  fail(
                    "SOURCE_REVIEW_BUDGET",
                    "The selected identity proof was not checked within this budget.",
                  ),
                )
              : resolveSourceBinding(library, {
                  skillPageId: row.page_id,
                  sourceId: row.selected_version,
                })
          ).pipe(Effect.result)
          if (proof._tag === "Failure") selectedErrors.set(key, proof.failure)
          else selectedProofs.set(key, proof.success)
        }
        const error = selectedErrors.get(key),
          binding = selectedProofs.get(key)
        if (error !== undefined) proofErrors.set(row.page_id, error)
        if (binding !== undefined) {
          const root = rootForDefinition(definition, binding)
          if (root !== null) proofs.set(row.page_id, root)
        }
      }
      const members: SourceOnboardingMember[] = []
      for (const candidate of snapshot.members) {
        if (requested !== undefined && !requested.includes(candidate.member_key)) continue
        const common = { member_key: candidate.member_key, name: candidate.portable.name }
        const skillId = yield* identity(library, definition.page_id, candidate.member_key)
        const original = pending.filter(
          (plan) =>
            plan.skill_id === skillId ||
            alias(plan.name) === alias(candidate.portable.name) ||
            (plan.source_projection?.definition.page_id === definition.page_id &&
              plan.source_projection.definition.member === candidate.member_key),
        )
        const exact = bindings.filter((row) => row.member === candidate.member_key)
        const names = rows.filter(
          (row) => alias(row.name) === alias(candidate.portable.name) || row.skill_id === skillId,
        )
        const matches = rows.filter((row) => proofs.get(row.page_id) === candidate.member_key)
        const blocked = (
          reason: string,
          found: readonly SourceOnboardingBinding[] = names,
        ): SourceOnboardingMember => ({
          ...common,
          kind: "blocked",
          reason,
          candidates: found.map((row) => row.page_id),
          original_operations: original.map((plan) => plan.operation_id),
        })
        if (original.length > 0)
          members.push(blocked("original_creation_pending", exact.length ? exact : names))
        else if (
          snapshot.members.filter((row) => row.member_key === candidate.member_key).length !== 1
        )
          members.push(blocked("duplicate_provider_member"))
        else if (exact.length > 1) members.push(blocked("duplicate_source_member", exact))
        else if (exact.length === 1) {
          const target = exact[0]!
          members.push(
            target.kind !== "skill" ||
              !target.skill_id ||
              !target.main_file_id ||
              !target.selected_version ||
              rows.filter((row) => row.skill_id === target.skill_id).length !== 1
              ? blocked("registered_member_incomplete", exact)
              : { ...common, kind: "registered", target, content_verification: "unobserved" },
          )
        } else if (
          matches.length === 1 &&
          names.every((row) => row.page_id === matches[0]!.page_id)
        ) {
          const before = matches[0]!
          members.push(
            before.skill_id &&
              before.main_file_id &&
              rows.filter((row) => row.skill_id === before.skill_id).length === 1
              ? { ...common, kind: "bind", before, proof: "selected_git_source" }
              : blocked("binding_target_incomplete", matches),
          )
        } else if (matches.length > 1)
          members.push(blocked("ambiguous_fixed_source_identity", matches))
        else if (names.length > 0)
          members.push(
            blocked(
              names.some((row) => proofErrors.has(row.page_id))
                ? "selected_source_unavailable"
                : "existing_identity_needs_review",
            ),
          )
        else if (proofErrors.size > 0)
          members.push(
            blocked(
              "unbound_source_identity_unavailable",
              rows.filter((row) => proofErrors.has(row.page_id)),
            ),
          )
        else members.push({ ...common, kind: "admit" })
      }
      const unresolved = bindings
        .filter((row) => requested === undefined || requested.includes(row.member))
        // A source directory Router owns an authored member index, not an
        // upstream SKILL.md member. Preserve and report it without inventing a
        // Source Member key or counting it as an incomplete Skill binding.
        .filter((row) => row.kind !== "router" || row.member !== "")
        .filter((row) => !snapshot.members.some((candidate) => candidate.member_key === row.member))
        .filter(
          (row) =>
            !members.some(
              (member) => member.kind === "bind" && member.before.page_id === row.page_id,
            ),
        )
        .map((row) => ({
          page_id: row.page_id,
          member: row.member,
          reason: row.member
            ? "bound_member_not_discovered_preserved"
            : "bound_identity_has_no_member_key",
        }))
      source.members = members
      source.unresolved_bindings = unresolved
      source.source_routers = bindings.filter((row) => row.kind === "router" && row.member === "")
    }
    // Multiple discovered members must not race to create the same public name, including across Sources.
    const all = sources.flatMap((source) => source.members.map((member) => ({ source, member })))
    for (const { source, member } of all) {
      if (member.kind !== "admit") continue
      if (all.filter((other) => alias(other.member.name) === alias(member.name)).length > 1) {
        source.members = source.members.map((row) =>
          row === member
            ? {
                member_key: row.member_key,
                name: row.name,
                kind: "blocked" as const,
                reason: "candidate_name_collision",
                candidates: [],
                original_operations: [],
              }
            : row,
        )
      }
    }
    const report: SourceOnboardingReport = {
      version: 1,
      library_id: library.library_id,
      entry: library.skills.database_id,
      scope,
      observed_at: yield* Clock.currentTimeMillis,
      coverage: sources.some((source) => source.status === "unavailable") ? "partial" : "complete",
      inventory_count: rows.length,
      inventory_issues: rows
        .filter((row) => !row.skill_id || !row.main_file_id)
        .map((row) => ({ page_id: row.page_id, reason: "uninitialized_identity" })),
      sources,
      remote_writes: 0,
    }
    return { report, acquired, rows }
  }).pipe(withReadOnlyNotion)
}

export function reviewSourceOnboarding(
  library: SharedLibrary,
  scope: unknown,
  acquire: typeof discoverSourceDefinition = discoverSourceDefinition,
  options: SourceOnboardingReviewOptions = {},
) {
  return inspect(library, scope, acquire, options).pipe(Effect.map(({ report }) => report))
}

export function prepareSourceOnboarding(
  library: SharedLibrary,
  scope: unknown,
  options: SourceOnboardingReviewOptions & {
    readonly storage?: SourceMemberStorage
    readonly bindings?: readonly SourceOnboardingBindingDecision[]
  } = {},
  acquire: typeof discoverSourceDefinition = discoverSourceDefinition,
) {
  return Effect.gen(function* () {
    if (
      options.storage !== undefined &&
      !["auto", "fixed-git", "retained"].includes(options.storage)
    )
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "Use auto, fixed-git or retained storage."),
      )
    const decisions = yield* sourceChecked(() =>
      Schema.decodeUnknownSync(Schema.Array(SourceOnboardingBindingDecisionSchema))(
        options.bindings ?? [],
        { onExcessProperty: "error" },
      ),
    )
    if (
      new Set(decisions.map((item) => item.member)).size !== decisions.length ||
      new Set(decisions.map((item) => item.target)).size !== decisions.length ||
      decisions.some((item) => pageId(item.target) !== item.target || !item.member)
    )
      return yield* Effect.fail(
        fail(
          "SOURCE_BINDING_DECISION_INVALID",
          "Choose each exact member and target page only once.",
        ),
      )
    const selectedScope = yield* sourceChecked(() =>
      Schema.decodeUnknownSync(SourceOnboardingScopeSchema)(scope, { onExcessProperty: "error" }),
    )
    if (decisions.length > 0 && selectedScope.kind !== "source")
      return yield* Effect.fail(
        fail(
          "SOURCE_BINDING_DECISION_INVALID",
          "Explicit binding decisions require one exact Source, not --all.",
        ),
      )
    const { report, acquired, rows } = yield* inspect(
      library,
      selectedScope,
      acquire,
      options,
      true,
    )
    const sources = report.sources.map((source) => ({ ...source }))
    for (const decision of decisions) {
      const source = sources[0]
      const found = source?.members.filter((member) => member.member_key === decision.member)
      const member = found?.[0]
      const before = rows.find((row) => row.page_id === decision.target)
      if (
        !source ||
        source.status !== "reviewed" ||
        found?.length !== 1 ||
        !before ||
        before.kind !== "skill" ||
        !before.skill_id ||
        !before.main_file_id ||
        !before.selected_version ||
        (before.origin !== "none" && (before.origin !== source.page_id || before.member !== "")) ||
        rows.filter((row) => row.skill_id === before.skill_id).length !== 1 ||
        member?.kind !== "blocked" ||
        member.reason !== "existing_identity_needs_review" ||
        member.original_operations.length !== 0 ||
        !member.candidates.includes(before.page_id)
      )
        return yield* Effect.fail(
          fail(
            "SOURCE_BINDING_DECISION_INVALID",
            "The exact candidate is not an available unbound Skill awaiting a new association decision. This option cannot override an unknown operation, foreign owner, invalid identity or missing provider member.",
            { member: decision.member, target: decision.target },
          ),
        )
      source.members = source.members.map((item) =>
        item === member
          ? {
              member_key: member.member_key,
              name: member.name,
              kind: "bind" as const,
              before,
              proof: "explicit_binding_decision" as const,
            }
          : item,
      )
      source.unresolved_bindings = source.unresolved_bindings.filter(
        (item) => item.page_id !== before.page_id,
      )
    }
    const actions: SourceOnboardingAction[] = []
    for (const source of sources) {
      const data = acquired.get(source.page_id)
      if (data === undefined) continue
      const { definition, snapshot } = data
      const reference = {
        page_id: definition.page_id,
        source_id: definition.source_id,
        fingerprint: definition.fingerprint,
      }
      const members: SourceOnboardingMember[] = []
      for (const member of source.members) {
        if (member.kind === "bind")
          actions.push({
            kind: "bind",
            source: reference,
            member: member.member_key,
            before: member.before,
            proof: member.proof,
          })
        if (member.kind === "admit") {
          const child = yield* (
            (yield* remainingReviewTime()) <= 0
              ? Effect.fail(
                  fail(
                    "SOURCE_ONBOARDING_BUDGET",
                    "Candidate discovery completed but no creation plan was prepared within this budget.",
                  ),
                )
              : prepareSharedSourceProjection({
                  library,
                  definition,
                  acquired: snapshot,
                  member: member.member_key,
                  skillId: yield* identity(library, definition.page_id, member.member_key),
                  enabled: false,
                  markdownImport: true,
                  storage: options.storage,
                })
          ).pipe(Effect.result)
          if (child._tag === "Failure") {
            members.push({
              member_key: member.member_key,
              name: member.name,
              kind: "blocked",
              reason: child.failure.code,
              candidates: [],
              original_operations: [],
              error: errorValue(child.failure),
            })
            continue
          }
          actions.push({
            kind: "create",
            source: reference,
            member: member.member_key,
            plan: child.success,
          })
        }
        members.push(member)
      }
      source.members = members
    }
    const contents = {
      version: 1 as const,
      kind: "source_onboarding" as const,
      permission_scope: yield* authScope,
      library,
      report: { ...report, sources },
      actions,
    }
    return {
      ...contents,
      plan_id: `source-onboarding-${yield* sha256(canonicalSharedJson(contents))}`,
    } satisfies SourceOnboardingPlan
  }).pipe(withReadOnlyNotion)
}

function validatePlan(library: SharedLibrary, value: unknown) {
  return Effect.gen(function* () {
    const plan = yield* sourceChecked(() =>
      Schema.decodeUnknownSync(SourceOnboardingPlanSchema)(value, { onExcessProperty: "error" }),
    )
    const { plan_id, ...contents } = plan
    if (
      canonicalSharedJson(library) !== canonicalSharedJson(plan.library) ||
      plan.report.library_id !== library.library_id ||
      plan.report.entry !== library.skills.database_id ||
      plan_id !== `source-onboarding-${yield* sha256(canonicalSharedJson(contents))}`
    )
      return yield* Effect.fail(
        fail("SOURCE_ONBOARDING_INVALID", "The frozen onboarding plan, library or digest differs."),
      )
    const seen = new Set<string>()
    const requested = plan.report.scope.kind === "source" ? plan.report.scope.members : undefined
    for (const action of plan.actions) {
      const key = `${action.source.page_id}:${action.member}`
      if (
        seen.has(key) ||
        !action.member ||
        pageId(action.source.page_id) !== action.source.page_id ||
        (requested !== undefined && !requested.includes(action.member))
      )
        return yield* Effect.fail(
          fail("SOURCE_ONBOARDING_INVALID", "A frozen action has a duplicate or invalid member."),
        )
      seen.add(key)
      const source = plan.report.sources.find(
        (item) =>
          item.page_id === action.source.page_id &&
          item.source_id === action.source.source_id &&
          item.fingerprint === action.source.fingerprint,
      )
      const reviewed = source?.members.filter((item) => item.member_key === action.member)
      if (
        source?.status !== "reviewed" ||
        reviewed?.length !== 1 ||
        reviewed[0]?.kind !== (action.kind === "create" ? "admit" : "bind")
      )
        return yield* Effect.fail(
          fail("SOURCE_ONBOARDING_INVALID", "An action has no matching reviewed member."),
        )
      if (action.kind === "create") {
        const child = yield* validateSharedCreatePlan(action.plan)
        const origin = child.source_projection?.definition
        if (
          !origin ||
          origin.page_id !== action.source.page_id ||
          origin.source_id !== action.source.source_id ||
          origin.fingerprint !== action.source.fingerprint ||
          origin.member !== action.member ||
          child.enabled !== false ||
          child.default_context !== false ||
          canonicalSharedJson(child.library) !== canonicalSharedJson(library) ||
          child.skill_id !== (yield* identity(library, action.source.page_id, action.member))
        )
          return yield* Effect.fail(
            fail(
              "SOURCE_ONBOARDING_INVALID",
              "The child creation differs from its exact disabled Source admission.",
            ),
          )
      } else if (
        reviewed[0]?.kind !== "bind" ||
        reviewed[0].proof !== action.proof ||
        canonicalSharedJson(reviewed[0].before) !== canonicalSharedJson(action.before) ||
        (action.before.origin !== "none" &&
          (action.before.origin !== action.source.page_id || action.before.member !== ""))
      )
        return yield* Effect.fail(
          fail(
            "SOURCE_ONBOARDING_INVALID",
            "A binding action cannot replace another discovery owner.",
          ),
        )
    }
    return plan
  })
}

function executeBinding(
  library: SharedLibrary,
  parent: SourceOnboardingPlan,
  action: Extract<SourceOnboardingAction, { kind: "bind" }>,
  mode: "apply" | "dry-run" | "reconcile",
) {
  return Effect.gen(function* () {
    const after = { ...action.before, origin: action.source.page_id, member: action.member }
    const assertBefore = Effect.gen(function* () {
      const definition = yield* readSourceDefinition(library, action.source.page_id)
      if (
        definition.fingerprint !== action.source.fingerprint ||
        !definition.enabled ||
        canonicalSharedJson(yield* readBinding(library, action.before.page_id)) !==
          canonicalSharedJson(action.before) ||
        (action.proof === "selected_git_source" &&
          (yield* matchingFixedSource(library, definition, action.before)) !== action.member)
      )
        return yield* Effect.fail(
          fail(
            "SOURCE_BINDING_CHANGED",
            "The target, selected immutable provenance or Source changed before binding.",
          ),
        )
      const others = (yield* readSourceOnboardingInventory(library)).filter(
        (row) =>
          row.origin === action.source.page_id &&
          row.member === action.member &&
          row.page_id !== action.before.page_id,
      )
      if (others.length > 0)
        return yield* Effect.fail(
          fail("SOURCE_MEMBER_ALREADY_BOUND", "Another Skill already owns the member."),
        )
    })
    const result = yield* guardedSourceMutation(
      library,
      {
        // Share the public bind operation identity; another entry point must
        // not turn an unknown original PATCH into a fresh dispatch.
        identity: `${action.source.source_id}:${action.before.page_id}`,
        path: `v1/pages/${action.before.page_id}`,
        method: "PATCH",
        body: {
          properties: {
            [library.skills.property_ids.Origin!]: { relation: [{ id: action.source.page_id }] },
            [library.skills.property_ids["Source Member"]!]: {
              rich_text: sourceRich(action.member),
            },
          },
        },
        dryRun: mode !== "apply",
        repeat: "never",
        beforeDispatch: Effect.gen(function* () {
          yield* assertBefore
          const recordId = `decision-${yield* sha256(canonicalSharedJson(action))}`
          yield* retainSourceFact(library, {
            recordId,
            operationId: parent.plan_id,
            skillPageId: action.before.page_id,
            entityId: recordId,
            kind: "source",
            payload: {
              version: 1,
              kind: "source_onboarding_binding",
              plan_id: parent.plan_id,
              action,
            },
          })
          yield* assertBefore
        }),
      },
      Effect.gen(function* () {
        const current = yield* readBinding(library, action.before.page_id)
        return canonicalSharedJson(current) === canonicalSharedJson(after) ? current : undefined
      }),
    )
    if (mode === "dry-run" && result.status === "planned") yield* assertBefore
    return {
      ...result,
      page_id: action.before.page_id,
      verified:
        ("verified" in result && result.verified === true) ||
        ("original_outcome" in result && result.original_outcome === "applied"),
    }
  })
}

export function sourceOnboardingRemaining(report: SourceOnboardingReport) {
  return report.sources.reduce(
    (n, source) =>
      n +
      (source.status === "unavailable" ? 1 : 0) +
      source.unresolved_bindings.length +
      source.members.filter((member) => member.kind === "blocked").length,
    0,
  )
}

/** The saved child plans/journals own dispatch and recovery; this executor never regenerates a candidate. */
export function executeSourceOnboarding(
  library: SharedLibrary,
  input: unknown,
  mode: "apply" | "dry-run" | "reconcile",
) {
  const run = Effect.gen(function* () {
    if (!["apply", "dry-run", "reconcile"].includes(mode))
      return yield* Effect.fail(fail("INVALID_ARGUMENT", "Choose apply, dry-run or reconcile."))
    const plan = yield* validatePlan(library, input)
    if (mode !== "reconcile" && plan.permission_scope !== (yield* authScope))
      return yield* Effect.fail(
        fail(
          "SOURCE_ONBOARDING_SCOPE",
          "Apply the reviewed plan in its original credential scope.",
        ),
      )
    const results: Array<{
      source_id: string
      member: string
      kind: "create" | "bind"
      verified: boolean
      page_id: string | null
      operation_id: string | null
      result?: unknown
      error?: { code: string; message: string; details: unknown }
    }> = []
    for (const action of plan.actions) {
      const executed = yield* Effect.gen(function* () {
        const definition = yield* readSourceDefinition(library, action.source.page_id)
        if (
          definition.source_id !== action.source.source_id ||
          definition.fingerprint !== action.source.fingerprint ||
          !definition.enabled
        )
          return yield* Effect.fail(
            fail(
              "SOURCE_DEFINITION_CHANGED",
              "The frozen Source identity or configuration changed.",
            ),
          )
        if (action.kind === "bind") return yield* executeBinding(library, plan, action, mode)
        if (mode === "dry-run") {
          const preview = yield* previewSharedCreate(library, action.plan)
          const { plan: _fullInput, ...summary } = preview
          return { ...summary, verified: false, page_id: null }
        }
        return yield* executeSharedCreate(library, {
          plan: action.plan,
          mode: mode === "apply" ? "create" : "reconcile",
        })
      }).pipe(Effect.result)
      if (executed._tag === "Failure") {
        results.push({
          source_id: action.source.source_id,
          member: action.member,
          kind: action.kind,
          verified: false,
          page_id:
            action.kind === "bind"
              ? action.before.page_id
              : (pageId(String(property(executed.failure.details).skill_page_id ?? "")) ?? null),
          operation_id: action.kind === "create" ? action.plan.operation_id : null,
          error: sourceOnboardingError(executed.failure, action),
        })
        if (executed.failure.code === "REQUEST_BUDGET_EXHAUSTED") break
      } else
        results.push({
          source_id: action.source.source_id,
          member: action.member,
          kind: action.kind,
          verified: executed.success.verified === true,
          page_id: executed.success.page_id,
          operation_id: executed.success.operation_id,
          result: executed.success,
        })
    }
    const remaining = sourceOnboardingRemaining(plan.report)
    const failed = results.some(
      (row) => row.error !== undefined || (mode !== "dry-run" && !row.verified),
    )
    return {
      plan_id: plan.plan_id,
      mode,
      status:
        failed || remaining > 0 || results.length !== plan.actions.length
          ? ("partial" as const)
          : mode === "dry-run"
            ? ("previewed" as const)
            : ("completed" as const),
      results,
      unresolved_review_items: remaining,
      unexecuted_actions: plan.actions.length - results.length,
      ...(mode !== "apply" ? { remote_writes: 0 as const } : {}),
      new_skills_enabled: false as const,
      existing_bodies_changed: false as const,
      existing_selected_versions_changed: false as const,
    }
  })
  return mode === "apply" ? withSourceUpdateLock(library, run) : run.pipe(withReadOnlyNotion)
}
