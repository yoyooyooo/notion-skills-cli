import {
  SourceMemberCacheSchema,
  SOURCE_MEMBER_CACHE_VERSION,
  sourceMemberCacheKey,
} from "./shared-source-materialization-state.ts"
import { readMaterializationClosure } from "./shared-source-materialization-closure.ts"
import { Effect, Option } from "effect"
import { RequestBudget } from "./request-budget.ts"
import { authScope } from "./catalog.ts"
import { aliasFor, fail, type ContentRecord } from "./model.ts"
import { Notion } from "./notion.ts"
import {
  currentSourceOriginContains,
  parseCurrentSourceIdentity,
} from "./shared-current-source-management.ts"
import {
  resolveCurrentSourceContributions,
  currentSourceMemberWriteReason,
  validateCurrentSourceInput,
} from "./shared-current-source-input.ts"
import { uninitializedSourceSkill } from "./shared-current-source-adoption.ts"
import { readCurrentSourceGitOrigin } from "./shared-current-source.ts"
import { sourceDiscoveryInput } from "./shared-source-adapters.ts"
import { sourceDefinitionOptions } from "./shared-source-definition-options.ts"
import { discoverSourceDirectory } from "./upstream-source.ts"
import { Store } from "./store.ts"
import {
  type SourceMemberCandidate,
  type SourceMemberDiscovery,
} from "./shared-source-materialization-model.ts"
import {
  legacySourceMember,
  materializationChecked,
  materializationRecord,
  materializationSkillId,
  parseMaterializationRegistration,
  queryMaterializationPages,
  sourceRegistrationDigest,
  type MaterializationRegistration,
} from "./shared-source-materialization-registration.ts"
import type { SharedLibrary } from "./shared-library-model.ts"

export function sourceMemberBindings(
  library: SharedLibrary,
  registration: MaterializationRegistration,
  skillRows: readonly unknown[],
) {
  return Effect.gen(function* () {
    const members = new Map<string, { skill_id: string; raw?: unknown; record?: ContentRecord }[]>()
    const byId = new Map<string, unknown>()
    const declared = new Set(registration.contributions.map((entry) => entry.skill_id))
    for (const raw of skillRows) {
      const skillId = yield* materializationChecked(() => materializationSkillId(library, raw))
      const member = yield* materializationChecked(() => legacySourceMember(raw))
      const relevant =
        declared.has(skillId) ||
        (member !== undefined &&
          (yield* currentSourceOriginContains(
            library,
            String((raw as { id: unknown }).id),
            raw,
            registration.page_id,
          )))
      if (!relevant) continue
      if (byId.has(skillId))
        return yield* Effect.fail(
          fail(
            "SOURCE_MEMBER_IDENTITY_AMBIGUOUS",
            "Several physical Skills share a stable identity.",
          ),
        )
      byId.set(skillId, raw)
    }
    for (const entry of registration.contributions) {
      const raw = byId.get(entry.skill_id)
      const record =
        raw === undefined
          ? undefined
          : yield* materializationChecked(() => materializationRecord(library, raw))
      const previous = members.get(entry.member_key) ?? []
      previous.push({ skill_id: entry.skill_id, ...(raw === undefined ? {} : { raw, record }) })
      members.set(entry.member_key, previous)
    }
    for (const raw of byId.values()) {
      const member = yield* materializationChecked(() => legacySourceMember(raw))
      if (!member) continue
      const record = yield* materializationChecked(() => materializationRecord(library, raw))
      if (record.locator.type !== "shared_skill") continue
      if (
        !(yield* currentSourceOriginContains(
          library,
          record.locator.page_id,
          raw,
          registration.page_id,
        ))
      )
        continue
      const previous = members.get(member) ?? []
      if (
        previous.some(
          (entry) => entry.skill_id !== record.locator.skill_id && entry.raw !== undefined,
        )
      )
        return yield* Effect.fail(
          fail(
            "SOURCE_MEMBER_IDENTITY_AMBIGUOUS",
            "A registered Source member matches more than one existing Skill.",
          ),
        )
      const same = previous.find((entry) => entry.skill_id === record.locator.skill_id)
      if (same !== undefined) continue
      // A real legacy row wins only when no current assignment chose another ID.
      if (previous.length !== 0)
        return yield* Effect.fail(
          fail(
            "SOURCE_MEMBER_IDENTITY_AMBIGUOUS",
            "A current member assignment conflicts with its legacy physical owner.",
          ),
        )
      members.set(member, [{ skill_id: record.locator.skill_id, raw, record }])
    }
    return members
  })
}
function matches(
  query: string | undefined,
  candidate: { name?: string; alias?: string; member_key: string; expected_skill_id: string },
) {
  return (
    query === undefined ||
    [candidate.name, candidate.alias, candidate.member_key, candidate.expected_skill_id].some(
      (value) => value === query,
    )
  )
}
function discoverDirectSourceMembers(
  library: SharedLibrary,
  input: { readonly query?: string; readonly source_id?: string } = {},
) {
  return Effect.gen(function* () {
    if (input.query !== undefined && (!input.query || input.query.length > 4096))
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "Source member discovery requires a bounded query."),
      )
    const scope = yield* authScope
    const skillRows = yield* queryMaterializationPages(library, "skills")
    const exactRows =
      input.query === undefined
        ? []
        : skillRows.filter((raw) => materializationSkillId(library, raw) === input.query)
    if (exactRows.length > 1)
      return yield* Effect.fail(
        fail("SOURCE_MEMBER_IDENTITY_AMBIGUOUS", "The exact stable Skill identity is repeated."),
      )
    const sourceRows = yield* queryMaterializationPages(
      library,
      "sources",
      input.source_id === undefined
        ? undefined
        : {
            property: library.sources.property_ids["Source ID"],
            rich_text: { equals: input.source_id },
          },
    )
    const candidates: SourceMemberCandidate[] = [],
      failures: { source_id: string; code: string }[] = []
    // Identity and duplicates are resolved before any concurrent provider work.
    // Each fiber returns its own result; Effect.forEach retains registration order.
    const observations = yield* Effect.forEach(sourceRows, (row) =>
      Effect.gen(function* () {
        if (
          exactRows[0] !== undefined &&
          !(yield* currentSourceOriginContains(
            library,
            String((exactRows[0] as { id: unknown }).id),
            exactRows[0],
            String((row as { id: unknown }).id),
          ))
        )
          return undefined
        const identity = yield* materializationChecked(() =>
          parseCurrentSourceIdentity(library, row),
        ).pipe(Effect.result)
        return { row, identity }
      }),
    )
    const selected = observations.filter((entry) => entry !== undefined)
    const identityCounts = new Map<string, number>()
    for (const { identity } of selected)
      if (identity._tag === "Success") {
        const id = identity.success.source_id
        identityCounts.set(id, (identityCounts.get(id) ?? 0) + 1)
      }
    const results = yield* Effect.forEach(
      selected,
      ({ row, identity }) =>
        Effect.gen(function* () {
          const source_id =
            identity._tag === "Success"
              ? identity.success.source_id
              : (input.source_id ?? "unresolved")
          const result = yield* Effect.gen(function* () {
            if (identity._tag === "Failure") return yield* Effect.fail(identity.failure)
            if (identityCounts.get(source_id) !== 1)
              return yield* Effect.fail(
                fail("CURRENT_SOURCE_DUPLICATE", "Several registrations share one Source ID."),
              )
            const registration = yield* materializationChecked(() =>
              parseMaterializationRegistration(library, row),
            )
            if (!registration.definition.enabled) return []
            const digest = yield* sourceRegistrationDigest(registration)
            const bindings = yield* sourceMemberBindings(library, registration, skillRows)
            const found: SourceMemberCandidate[] = []
            const git =
              registration.current === undefined
                ? undefined
                : yield* readCurrentSourceGitOrigin(library, { ...registration.current, source_id })
            const acceptedCommit =
              git?.commit || registration.legacy_registration?.last_revision || undefined
            const available =
              registration.state.state === "ready" || registration.state.state === "uninitialized"
            const writable = yield* materializationChecked(() =>
              validateCurrentSourceInput({
                version: 1,
                definition: registration.definition,
                contributions: [],
              }),
            ).pipe(Effect.result)
            if (
              writable._tag === "Failure" &&
              ![
                "CURRENT_SOURCE_WRITE_UNSUPPORTED",
                "SOURCE_COMPOSITION_REVIEW_REQUIRED",
                "SOURCE_STORAGE_REVIEW_REQUIRED",
              ].includes(writable.failure.code)
            )
              return yield* Effect.fail(writable.failure)
            const writeReason = writable._tag === "Failure" ? writable.failure.code : undefined
            // Existing ready records do not acquire a new write requirement.
            // Some read-only registrations cannot be parsed as fixed Git inputs.
            const discoveryInput =
              writeReason === undefined
                ? yield* materializationChecked(() => sourceDiscoveryInput(registration.definition))
                : undefined
            const base = {
              type: "source_member" as const,
              library_id: library.library_id,
              scope,
              source_id,
              registration_digest: digest,
              ...(acceptedCommit === undefined ? {} : { expected_source_commit: acceptedCommit }),
              ...(registration.current === undefined
                ? {}
                : { expected_source_revision: registration.current.revision }),
            }
            for (const [member_key, entries] of bindings)
              for (const entry of entries) {
                if (entry.record === undefined) continue
                if (entry.record.kind !== "skill") {
                  if (
                    matches(input.query, {
                      ...entry.record,
                      member_key,
                      expected_skill_id: entry.skill_id,
                    })
                  )
                    return yield* Effect.fail(
                      fail(
                        "SOURCE_MATERIALIZATION_UNSUPPORTED",
                        "A registered Git member must retain the Skill content kind.",
                      ),
                    )
                  continue
                }
                const uninitialized =
                  entry.record.enabled !== false && available
                    ? yield* materializationChecked(() =>
                        uninitializedSourceSkill(library, entry.raw),
                      )
                    : false
                const memberWriteReason =
                  discoveryInput === undefined
                    ? writeReason
                    : currentSourceMemberWriteReason(discoveryInput, member_key)
                const blocked = uninitialized && memberWriteReason !== undefined
                const candidate = {
                  ...base,
                  member_key,
                  expected_skill_id: entry.skill_id,
                  name: entry.record.name,
                  alias: entry.record.alias,
                  description: entry.record.description,
                  enabled: entry.record.enabled !== false,
                  record: entry.record,
                  readiness:
                    entry.record.enabled === false
                      ? ("blocked" as const)
                      : !available
                        ? ("preparing" as const)
                        : uninitialized
                          ? blocked
                            ? ("blocked" as const)
                            : ("materializable" as const)
                          : ("ready" as const),
                  ...(blocked && available && entry.record.enabled !== false
                    ? { reason: memberWriteReason }
                    : {}),
                }
                if (matches(input.query, candidate)) found.push(candidate)
              }
            // Exact stable physical selection needs no upstream scan. It is still
            // only a candidate; the manager re-reads configuration and original bytes.
            if (
              input.query !== undefined &&
              found.some((entry) => entry.expected_skill_id === input.query)
            )
              return found
            const definition =
              acceptedCommit === undefined
                ? registration.definition
                : {
                    ...registration.definition,
                    options: {
                      ...sourceDefinitionOptions(registration.definition.options),
                      accepted_ref: acceptedCommit,
                    },
                  }
            const observation = yield* discoverSourceDirectory(
              { ...sourceDiscoveryInput(definition), allow_empty: true },
              { metrics: (yield* Notion).metrics },
            )
            const assigned = yield* resolveCurrentSourceContributions({
              source_id,
              members: observation.members.map((member) => member.member_key),
              overrides: registration.contributions,
            })
            for (const member of observation.members) {
              const memberWriteReason =
                discoveryInput === undefined
                  ? writeReason
                  : currentSourceMemberWriteReason(
                      discoveryInput,
                      member.member_key,
                      member.git_representation,
                    )
              // A name lookup observes the complete pinned layout as well as the
              // existing physical row. Ready content does not require a new write.
              if (memberWriteReason !== undefined)
                for (let index = 0; index < found.length; index++) {
                  const candidate = found[index]!
                  if (
                    candidate.member_key === member.member_key &&
                    candidate.readiness === "materializable"
                  )
                    found[index] = { ...candidate, readiness: "blocked", reason: memberWriteReason }
                }
              if (bindings.get(member.member_key)?.some((entry) => entry.record !== undefined))
                continue
              const rows = assigned.filter((entry) => entry.member_key === member.member_key)
              for (const entry of rows) {
                const candidate = {
                  ...base,
                  expected_source_commit: observation.revision,
                  member_key: member.member_key,
                  expected_skill_id: entry.skill_id,
                  name: member.name,
                  alias: aliasFor(member.name),
                  description: member.description,
                  enabled: true,
                  readiness: !available
                    ? ("preparing" as const)
                    : memberWriteReason === undefined
                      ? ("materializable" as const)
                      : ("blocked" as const),
                  ...(available && memberWriteReason !== undefined
                    ? { reason: memberWriteReason }
                    : {}),
                }
                if (matches(input.query, candidate)) found.push(candidate)
              }
            }
            return found
          }).pipe(Effect.result)
          return { source_id, result }
        }),
      { concurrency: 4 },
    )
    for (const { source_id, result } of results)
      if (result._tag === "Success") candidates.push(...result.success)
      else failures.push({ source_id, code: result.failure.code })
    const store = yield* Store,
      key = sourceMemberCacheKey(scope, library.library_id)
    const budget = yield* Effect.serviceOption(RequestBudget)
    if (Option.isSome(budget)) yield* budget.value.check
    const previous = yield* store.readJson(key, SourceMemberCacheSchema)
    const cached = new Map(
      (previous?.version === SOURCE_MEMBER_CACHE_VERSION ? previous.candidates : []).map(
        (entry) => [
          JSON.stringify([entry.source_id, entry.member_key, entry.expected_skill_id]),
          entry,
        ],
      ),
    )
    for (const entry of candidates)
      cached.set(
        JSON.stringify([entry.source_id, entry.member_key, entry.expected_skill_id]),
        entry,
      )
    // Provider failures may be partial directory facts; a spent parent budget
    // is not a completed observation and must not publish a late candidate slot.
    if (Option.isSome(budget)) yield* budget.value.check
    yield* store.writeJson(key, {
      version: SOURCE_MEMBER_CACHE_VERSION,
      library_id: library.library_id,
      scope,
      candidates: [...cached.values()],
    })
    return {
      version: 1,
      library_id: library.library_id,
      scope,
      coverage: failures.length === 0 ? "complete" : "partial",
      candidates,
      failures,
      effects: { remote_writes: "none" },
    } satisfies SourceMemberDiscovery
  })
}

export function discoverRegisteredSourceMembers(
  library: SharedLibrary,
  input: {
    readonly query?: string
    readonly source_id?: string
    readonly requires_of?: string
  } = {},
) {
  return Effect.gen(function* () {
    if (input.requires_of === undefined) return yield* discoverDirectSourceMembers(library, input)
    if (input.query !== undefined || input.source_id !== undefined)
      return yield* Effect.fail(
        fail(
          "INVALID_ARGUMENT",
          "requires_of selects one exact root, without a separate query or Source filter.",
        ),
      )
    const closure = yield* readMaterializationClosure(library, input.requires_of)
    const candidates: SourceMemberCandidate[] = [],
      failures: { source_id: string; code: string }[] = []
    for (const entry of closure.entries) {
      if (
        entry.record.locator.type !== "shared_skill" ||
        entry.record.locator.skill_id === input.requires_of ||
        !(yield* materializationChecked(() => uninitializedSourceSkill(library, entry.raw)))
      )
        continue
      const found = yield* discoverDirectSourceMembers(library, {
        query: entry.record.locator.skill_id,
      })
      candidates.push(...found.candidates)
      failures.push(...found.failures)
    }
    return {
      version: 1,
      library_id: library.library_id,
      scope: yield* authScope,
      coverage: failures.length === 0 ? "complete" : "partial",
      authorization_root: closure.authorization_root,
      root: closure.root,
      candidates,
      failures,
      effects: { remote_writes: "none" },
    } satisfies SourceMemberDiscovery
  }).pipe(Effect.map((value): SourceMemberDiscovery => value))
}
