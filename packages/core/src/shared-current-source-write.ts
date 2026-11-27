import { sameLegacySourceRegistration } from "./shared-current-source-legacy-registration.ts"
import {
  adoptSourceSkill,
  uninitializedSourceSkill,
  type SourceMaterializationWriteScope,
} from "./shared-current-source-adoption.ts"
import {
  readMaterializationRegistration,
  sourceRegistrationDigest,
} from "./shared-source-materialization-registration.ts"
import { Crypto, Effect, Schema } from "effect"
import { withCurrentSourceWriter } from "./shared-current-source-writer.ts"
import { fail, listSchema, property, SkillsError, text } from "./model.ts"
import { Notion } from "./notion.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256, type Store } from "./store.ts"
import { withCurrentInvocationBudget } from "./shared-current-invocation.ts"
import { resolveCurrentSourceConsumption } from "./shared-current-consumption.ts"
import {
  prepareCurrentSource,
  validateCurrentSourceInput,
  type PreparedCurrentSourceInput,
} from "./shared-current-source-input.ts"
import {
  currentSourceManagementMatches,
  currentSourceWriteProperties,
  parseCurrentSourceManagement,
  queryCurrentSourceManagement,
  queryCurrentSourceTargets,
  queryCurrentSourceTargetPages,
} from "./shared-current-source-management.ts"
import {
  inspectCurrentOperation,
  readCurrentOperationIntent,
  withCurrentOperation,
  type CurrentOperationIntent,
  type CurrentOperationSession,
  type CurrentWriteMode,
} from "./shared-current-operation.ts"
import {
  authorizeCoordinatedSkillWrite,
  inspectCoordinatedSkillDirectory,
  inspectCoordinatedSkillWrite,
  prepareCoordinatedSkillWrite,
  verifyCoordinatedSkillDirectory,
  writeCoordinatedSkill,
} from "./shared-current-write.ts"
import { currentWriteIdentity } from "./shared-current-write-input.ts"
import { assertCurrentSourceHandoffSettled } from "./shared-current-source-successor.ts"
import {
  prepareCurrentSharedSourceContent,
  type CurrentSharedSource,
} from "./shared-current-source.ts"
import { inspectSharedSourcePlan } from "./shared-source-plan.ts"
import { gitBlobOid } from "./shared-github-source.ts"
import {
  currentFileRecord,
  queryCurrentFilesForSkills,
  queryCurrentSkillIndex,
} from "./shared-current-index.ts"
import { parseCurrentFileContent } from "./shared-current-file.ts"
import {
  currentOwnedResourceCreateRequest,
  currentOwnedResourceFromPage,
  listCurrentOwnedResourceRecords,
  queryCurrentOwnedResourceRecord,
} from "./shared-current-records.ts"
import {
  readCurrentSharedResourceBytes,
  validateCurrentSharedResourceManifest,
  type PreparedCurrentSharedResource,
} from "./shared-current-resource.ts"
import { currentUploadActionPrefix, uploadCurrentSharedResource } from "./shared-current-upload.ts"
import type { SharedLibrary } from "./shared-library-model.ts"

const invalid = (message: string, details?: unknown) =>
  fail("CURRENT_SOURCE_WRITE_CONFLICT", message, details)
const checked = <A>(read: () => A) =>
  Effect.try({
    try: read,
    catch: (error) =>
      error instanceof SkillsError ? error : invalid("The current Source write is invalid."),
  })
type SourceWriteOptions = {
  readonly operation_id: string
  readonly mode?: CurrentWriteMode
  readonly dry_run?: boolean
  /** Read-only completion proof after a lost final response. Never repairs drift. */
  readonly verify_only?: boolean
  /** Exact additive management scope; ordinary apply remains a complete declaration. */
  readonly materialization?: SourceMaterializationWriteScope
}
type Pending = Effect.Success<ReturnType<typeof readCurrentOperationIntent>>

function selectedSourceMode(pending: Pending, input: SourceWriteOptions): CurrentWriteMode {
  return typeof input.mode === "object" &&
    pending?.intent.operation_id === input.operation_id &&
    pending.predecessor?.intent.operation_id === input.mode.operation_id
    ? "resume"
    : (input.mode ?? "apply")
}

function validateSourceWriteOptions(input: SourceWriteOptions) {
  currentWriteIdentity(input.operation_id, "Operation ID")
  if (typeof input.mode === "object") {
    if (input.mode.kind !== "supersede") throw invalid("Use an explicit current write mode.")
    currentWriteIdentity(input.mode.operation_id, "Previous Operation ID")
    if (input.mode.operation_id === input.operation_id)
      throw invalid("A successor requires a new Operation ID.")
  } else if (input.mode !== undefined && input.mode !== "apply" && input.mode !== "resume")
    throw invalid("Use apply, resume or an explicit supersede for a current Source intent.")
  if (input.dry_run && input.mode !== undefined && input.mode !== "apply")
    throw invalid("Dry run does not resume or replace an unfinished intent.")
}

function sourcePending(
  pending: Pending,
  configuration: string | undefined,
  options: SourceWriteOptions,
) {
  if (pending === undefined) return undefined
  const intent = pending.intent
  if (
    "source_input" in intent &&
    intent.source_input.kind === "declaration" &&
    typeof options.mode === "object" &&
    options.mode.kind === "supersede" &&
    intent.operation_id === options.mode.operation_id &&
    intent.operation_id !== options.operation_id
  )
    return intent
  if (
    !("source_input" in intent) ||
    intent.source_input.kind !== "declaration" ||
    options.mode !== "resume" ||
    options.dry_run === true ||
    intent.operation_id !== options.operation_id ||
    (configuration !== undefined && intent.source_input.configuration_sha256 !== configuration)
  )
    throw fail("CURRENT_OPERATION_PENDING", "This Source has a different unfinished input.", {
      owner: intent.owner,
      operation_id: intent.operation_id,
      input_sha256: intent.input_sha256,
      next: "resume_or_supersede_current",
      required_input:
        "Resume the original input only after its dispatch has terminal evidence. A successor requires every original dispatch to settle before --operation NEW --supersede OLD; stopping a process is not that proof.",
    })
  return intent
}

/** Only a complete declaration and a pinned provider observation enter the writer.
 * Resume gets the original commit from the finite intent before any discovery. */
export function applyCurrentSource(
  library: SharedLibrary,
  input: SourceWriteOptions & { readonly declaration: unknown },
) {
  return Effect.gen(function* () {
    const declaration = yield* checked(() => {
      validateSourceWriteOptions(input)
      return validateCurrentSourceInput(input.declaration)
    })
    const pending = yield* readCurrentOperationIntent(library, {
      kind: "source",
      id: declaration.definition.source_id,
    })
    yield* assertCurrentSourceHandoffSettled(library, pending, input.mode, input.operation_id)
    const selected = { ...input, mode: selectedSourceMode(pending, input) }
    const original = yield* checked(() => sourcePending(pending, undefined, selected))
    if (selected.mode !== "apply" && original === undefined)
      return yield* Effect.fail(
        fail("CURRENT_OPERATION_NOT_FOUND", "No unfinished Source intent was found."),
      )
    const prepared = yield* prepareCurrentSource(declaration, {
      ...(selected.mode === "resume" && original?.source_input.kind === "declaration"
        ? { exactCommit: original.source_input.resolved_commit }
        : {}),
      metrics: (yield* Notion).metrics,
    })
    return yield* executeCurrentSource(library, prepared, selected, pending)
  }).pipe(
    (effect) => withCurrentSourceWriter(library, effect),
    withCurrentInvocationBudget,
    Effect.map(({ result }) => result),
  )
}

/** The prepared boundary is useful for embedded management and controlled provider
 * tests. It checks the full declared contribution again; it is not a bypass token. */
export function writePreparedCurrentSource(
  library: SharedLibrary,
  input: SourceWriteOptions & { readonly prepared: PreparedCurrentSourceInput },
) {
  return Effect.gen(function* () {
    yield* checked(() => validateSourceWriteOptions(input))
    const prepared = yield* copyPreparedSource(input.prepared, input.materialization)
    const pending = yield* readCurrentOperationIntent(library, {
      kind: "source",
      id: prepared.declaration.definition.source_id,
    })
    yield* assertCurrentSourceHandoffSettled(library, pending, input.mode, input.operation_id)
    const selected = { ...input, mode: selectedSourceMode(pending, input) }
    yield* checked(() => sourcePending(pending, prepared.configuration_sha256, selected))
    if (selected.mode !== "apply" && pending === undefined)
      return yield* Effect.fail(
        fail("CURRENT_OPERATION_NOT_FOUND", "No unfinished Source intent was found."),
      )
    return yield* executeCurrentSource(library, prepared, selected, pending)
  }).pipe(
    (effect) => withCurrentSourceWriter(library, effect),
    withCurrentInvocationBudget,
    Effect.map(({ result }) => result),
  )
}

function copyPreparedSource(
  input: PreparedCurrentSourceInput,
  materialization?: SourceMaterializationWriteScope,
) {
  return Effect.gen(function* () {
    const value = yield* checked(() => structuredClone(input))
    const declaration = yield* checked(() => validateCurrentSourceInput(value.declaration))
    const inspection = yield* checked(() => inspectSharedSourcePlan(value.plan))
    if (
      inspection.plan.base?.kind !== "git" ||
      inspection.plan.mounts.length !== 0 ||
      inspection.plan.base.source.root !== "" ||
      inspection.plan.base.source.commit !== value.resolved_commit ||
      declaration.definition.adapter.type !== "git" ||
      !declaration.definition.enabled ||
      (declaration.definition.policy === "pinned" &&
        declaration.definition.adapter.ref !== value.resolved_commit) ||
      (typeof declaration.definition.options.accepted_ref === "string" &&
        declaration.definition.options.accepted_ref !== value.resolved_commit) ||
      inspection.plan.base.source.url !== declaration.definition.adapter.url ||
      (yield* sha256(canonicalSharedJson(declaration))) !== value.configuration_sha256
    )
      return yield* Effect.fail(
        invalid("The prepared Source differs from its declaration or commit."),
      )
    const source = yield* prepareCurrentSharedSourceContent(inspection.plan)
    if (
      source.revision !== value.prepared_source.revision ||
      canonicalSharedJson(source.content) !== canonicalSharedJson(value.prepared_source.content)
    )
      return yield* Effect.fail(invalid("The prepared Source manifest changed before writing."))
    const expected = new Map<string, Map<string, string>>()
    for (const contribution of declaration.contributions) {
      if (
        materialization !== undefined &&
        !materialization.skill_ids.includes(contribution.skill_id)
      )
        continue
      const target = expected.get(contribution.skill_id) ?? new Map<string, string>()
      const prefix = contribution.member_key === "." ? "" : contribution.member_key + "/"
      for (const entry of inspection.manifest) {
        if (!entry.path.startsWith(prefix)) continue
        const relative = entry.path.slice(prefix.length)
        if (contribution.exclude.includes(relative)) continue
        const mapped = contribution.mapping[relative] ?? relative
        const path = contribution.mount_path ? contribution.mount_path + "/" + mapped : mapped
        if (target.has(path)) return yield* Effect.fail(invalid("Source contributions collide."))
        target.set(path, entry.path)
      }
      expected.set(contribution.skill_id, target)
    }
    if (
      new Set(value.targets.map((target) => target.skill_id)).size !== value.targets.length ||
      value.targets.length !== expected.size
    )
      return yield* Effect.fail(invalid("The prepared Source target scope is incomplete."))
    const manifest = new Map(inspection.manifest.map((file) => [file.path, file]))
    for (const target of value.targets) {
      const paths = expected.get(target.skill_id)
      if (
        target.kind !== "skill" ||
        paths === undefined ||
        paths.size !== target.files.length ||
        new Set(target.files.map((file) => file.path)).size !== target.files.length
      )
        return yield* Effect.fail(invalid("The prepared Source contribution is incomplete."))
      for (const file of target.files) {
        const selected = manifest.get(file.authority.source_path)
        if (
          file.authority.kind !== "source" ||
          file.authority.source_id !== declaration.definition.source_id ||
          file.authority.revision !== source.revision ||
          paths.get(file.path) !== file.authority.source_path ||
          selected === undefined ||
          selected.identity.kind !== "git" ||
          selected.identity.git_oid !== (yield* gitBlobOid(file.bytes)) ||
          selected.bytes !== file.bytes.byteLength ||
          (selected.mode ?? "100644") !== file.mode ||
          selected.identity.sha256 !== (yield* sha256(file.bytes))
        )
          return yield* Effect.fail(
            invalid("Prepared Source bytes or contribution bindings changed."),
          )
      }
    }
    return { ...value, declaration, plan: inspection.plan, prepared_source: source }
  })
}

function sourceManifest(prepared: PreparedCurrentSourceInput) {
  const inspection = inspectSharedSourcePlan(prepared.plan)
  return {
    source_id: prepared.declaration.definition.source_id,
    revision: prepared.prepared_source.revision,
    manifest: inspection.manifest.map((file) => {
      if (file.identity.sha256 === undefined) throw invalid("A Source file has no exact hash.")
      return {
        path: file.path,
        sha256: file.identity.sha256,
        bytes: file.bytes,
        mode: file.mode ?? "100644",
      }
    }),
  } satisfies Pick<CurrentSharedSource, "source_id" | "revision" | "manifest">
}

/** A Source must not invalidate an unfinished projection on an old or new target.
 * Only the exact current parent's child, or its explicit predecessor, may enter.
 * This is a single-writer precondition, not a cross-machine compare-and-swap. */
export function assertCurrentSourceTargetsAvailable(
  library: SharedLibrary,
  affected: readonly string[],
  intent: Extract<CurrentOperationIntent, { source_input: unknown }>,
  predecessor?: Extract<CurrentOperationIntent, { source_input: unknown }>,
) {
  return Effect.gen(function* () {
    for (const skill_id of affected) {
      const pending = yield* readCurrentOperationIntent(library, { kind: "skill", id: skill_id })
      if (pending === undefined) continue
      const binding = "source" in pending.intent ? pending.intent.source : undefined
      const allowed = [intent, ...(predecessor === undefined ? [] : [predecessor])]
      const parent = allowed.find(
        (parent) =>
          binding !== undefined &&
          binding.source_id === parent.owner.id &&
          binding.operation_id === parent.operation_id &&
          binding.input_sha256 === parent.input_sha256,
      )
      const child =
        parent === undefined
          ? undefined
          : "source-target-" + (yield* sha256(canonicalSharedJson([parent.operation_id, skill_id])))
      if (parent === undefined || pending.intent.operation_id !== child)
        return yield* Effect.fail(
          fail(
            "CURRENT_OPERATION_PENDING",
            "Finish the target's original intent before changing its Source.",
            {
              source_id: intent.owner.id,
              skill_id,
              operation_id: pending.intent.operation_id,
              next: "resume_original_target_intent",
            },
          ),
        )
    }
  })
}

function executeCurrentSource(
  library: SharedLibrary,
  prepared: PreparedCurrentSourceInput,
  options: SourceWriteOptions,
  pending: Pending,
) {
  return Effect.gen(function* () {
    const source_id = prepared.declaration.definition.source_id
    const registered =
      options.materialization === undefined
        ? undefined
        : yield* readMaterializationRegistration(
            library,
            source_id,
            options.materialization.legacy_registration === undefined
              ? undefined
              : {
                  registration: options.materialization.legacy_registration,
                  operation_id: options.operation_id,
                },
          )
    if (
      registered !== undefined &&
      (registered.page_id !== options.materialization!.source_page_id ||
        (yield* sourceRegistrationDigest(registered)) !==
          options.materialization!.registration_digest)
    )
      return yield* Effect.fail(
        invalid("The Source registration changed before additive materialization."),
      )
    if (
      registered !== undefined &&
      registered.current === undefined &&
      !sameLegacySourceRegistration(
        registered.legacy_registration,
        options.materialization?.legacy_registration,
      )
    )
      return yield* Effect.fail(
        fail(
          "SOURCE_LEGACY_REGISTRATION_CHANGED",
          "The frozen legacy Source evidence changed before materialization.",
        ),
      )
    const current =
      registered === undefined
        ? yield* queryCurrentSourceManagement(library, source_id)
        : registered.current
    const currentPage = current?.page_id ?? registered?.page_id
    const adoptions = new Map(
      (options.materialization?.adoptions ?? []).map((entry) => [entry.skill_id, entry]),
    )
    const declaredScope =
      options.materialization === undefined ? {} : { declaredOnly: true as const }
    if (
      current !== undefined &&
      options.materialization !== undefined &&
      current.declaration.contributions.some(
        (entry) =>
          !prepared.declaration.contributions.some(
            (desired) => canonicalSharedJson(entry) === canonicalSharedJson(desired),
          ),
      )
    )
      return yield* Effect.fail(
        invalid("Additive materialization must preserve every existing contribution."),
      )
    if (current !== undefined && options.materialization !== undefined) {
      const existing = yield* queryCurrentSourceTargetPages(library, {
        skillIds: current.declaration.contributions.map((entry) => entry.skill_id),
        declaredOnly: true,
      })
      for (const entry of current.declaration.contributions) {
        const owner = existing.get(entry.skill_id)
        if (owner === undefined)
          return yield* Effect.fail(
            invalid("A declared materialized owner disappeared.", { skill_id: entry.skill_id }),
          )
        if (
          !(yield* checked(() => uninitializedSourceSkill(library, owner.page))) &&
          !options.materialization.skill_ids.includes(entry.skill_id)
        )
          return yield* Effect.fail(
            invalid("A growing Source manifest must rebind every materialized owner.", {
              skill_id: entry.skill_id,
            }),
          )
      }
    }
    const original = yield* checked(() =>
      sourcePending(pending, prepared.configuration_sha256, options),
    )
    const targetIds = options.materialization?.skill_ids ?? [
      ...prepared.targets.map((target) => target.skill_id),
      ...(current?.declaration.contributions.map((entry) => entry.skill_id) ?? []),
      ...(original?.source_input.affected_skill_ids ?? []),
    ]
    const targets = yield* queryCurrentSourceTargets(library, {
      skillIds: targetIds,
      ...declaredScope,
      uninitializedSkillIds: [...adoptions.keys()],
      sourceId: source_id,
      ...(currentPage === undefined ? {} : { sourcePageId: currentPage }),
    })
    const affected = [...new Set([...targetIds, ...targets.keys()])].sort()
    if (
      options.mode === "resume" &&
      original !== undefined &&
      canonicalSharedJson(affected) !==
        canonicalSharedJson(original.source_input.affected_skill_ids)
    )
      return yield* Effect.fail(
        invalid("The affected Source scope changed during its unfinished intent."),
      )
    const source = yield* checked(() => sourceManifest(prepared))
    const desiredBySkill = new Map(prepared.targets.map((target) => [target.skill_id, target]))
    const plans: Effect.Success<ReturnType<typeof prepareCoordinatedSkillWrite>>[] = []
    const retirements: { skill_id: string; page_id: string }[] = []
    const frozenRetirements = new Map(
      original?.source_input.kind === "declaration"
        ? original.source_input.retirements.map((target) => [target.skill_id, target])
        : [],
    )
    for (const skill_id of affected) {
      const previous = targets.get(skill_id),
        desired = desiredBySkill.get(skill_id)
      if (desired === undefined) {
        const frozen = frozenRetirements.get(skill_id)
        if (previous === undefined && frozen === undefined)
          return yield* Effect.fail(invalid("An affected current Skill disappeared.", { skill_id }))
        if (
          previous !== undefined &&
          (previous.state.state !== "ready" ||
            [previous.main, ...previous.files].some(
              (file) => file.content.kind !== "source" || file.content.source_id !== source_id,
            ) ||
            (frozen !== undefined && frozen.page_id !== previous.page_id))
        )
          return yield* Effect.fail(
            invalid("Only a pure Source-owned Skill can retire with its removed member.", {
              skill_id,
            }),
          )
        retirements.push(frozen ?? { skill_id, page_id: previous!.page_id })
        continue
      }
      const adoption = adoptions.get(skill_id)
      const bindings =
        previous === undefined ? [...(adoption?.files ?? [])] : [previous.main, ...previous.files]
      const owned = bindings.filter(
        (file) => file.content.kind === "source" && file.content.source_id === source_id,
      )
      const desiredPaths = new Set(desired.files.map((file) => file.path))
      const files: Parameters<typeof prepareCoordinatedSkillWrite>[0]["files"][number][] = bindings
        .filter(
          (file) =>
            !(file.content.kind === "source" && file.content.source_id === source_id) &&
            !desiredPaths.has(file.path),
        )
        .map(({ file_id, page_id, skill_page_id, path, content }) => ({
          kind: "preserve",
          binding: { file_id, page_id, skill_page_id, path, content },
        }))
      for (const file of desired?.files ?? []) {
        const selected = owned.filter(
          (entry) =>
            entry.content.kind === "source" &&
            entry.content.source_path === file.authority.source_path,
        )
        if (selected.length > 1)
          return yield* Effect.fail(
            invalid("Several Files claim the same Source contribution.", {
              skill_id,
              source_path: file.authority.source_path,
            }),
          )
        const samePath = bindings.find((entry) => entry.path === file.path)
        if (
          options.materialization !== undefined &&
          samePath !== undefined &&
          samePath.content.kind !== "source"
        )
          return yield* Effect.fail(
            invalid(
              "Materialization cannot replace native or resource authority. Preserve it with its existing contribution exclusion.",
              { skill_id, path: file.path },
            ),
          )
        if (samePath?.content.kind === "source" && samePath.content.source_id !== source_id)
          return yield* Effect.fail(
            invalid("The desired Source path belongs to another Source.", {
              skill_id,
              path: file.path,
              source_id: samePath.content.source_id,
            }),
          )
        // Source owns the complete manifest, while support pages are a sparse
        // reading inventory. Only projection creates a new supporting File page.
        if (file.path !== "SKILL.md" && selected[0] === undefined && samePath === undefined)
          continue
        files.push({
          kind: "write",
          file: {
            ...file,
            file_id:
              selected[0]?.file_id ??
              samePath?.file_id ??
              (file.path === "SKILL.md" ? adoption?.main_file_id : undefined) ??
              "source-file-" +
                (yield* sha256(
                  canonicalSharedJson([
                    library.library_id,
                    source_id,
                    skill_id,
                    file.authority.source_path,
                  ]),
                )),
          },
        })
      }
      const defaults = desired.defaults
      const otherSources = yield* resolveCurrentSourceConsumption(library, skill_id, {
        excludeSourceIds: [source_id],
      })
      const consumption_paths = [...desired.files, ...otherSources.files].map((file) => file.path)
      const consumption_sources = [
        ...new Map(
          [
            ...desired.files.map((file) => file.authority),
            ...otherSources.files.map((file) => file.content),
          ].map(({ source_id, revision }) => [source_id, { source_id, revision }]),
        ).values(),
      ]
      for (const file of files)
        if (file.kind === "preserve" && file.binding.content.kind !== "source")
          consumption_paths.push(file.binding.path)
      plans.push(
        yield* prepareCoordinatedSkillWrite({
          skill_id,
          kind: previous?.kind ?? desired.kind,
          source: { source_id, revision: source.revision },
          consumption_paths,
          consumption_sources,
          create: { name: defaults.name, description: defaults.description },
          files,
        }),
      )
    }
    const source_input = {
      kind: "declaration" as const,
      configuration_sha256: prepared.configuration_sha256,
      resolved_commit: prepared.resolved_commit,
      affected_skill_ids: affected,
      retirements,
      ...(options.materialization === undefined
        ? {}
        : {
            materialization_sha256: yield* sha256(canonicalSharedJson(options.materialization)),
            ...(options.materialization.legacy_registration === undefined
              ? {}
              : {
                  legacy_registration: options.materialization.legacy_registration,
                }),
          }),
    }
    const intent = {
      operation_id: options.operation_id,
      owner: { kind: "source" as const, id: source_id },
      input_sha256: yield* sha256(canonicalSharedJson({ source_input, revision: source.revision })),
      source_input,
    } satisfies CurrentOperationIntent
    if (
      options.mode === "resume" &&
      original !== undefined &&
      canonicalSharedJson(intent) !== canonicalSharedJson(original)
    )
      return yield* Effect.fail(
        invalid("The selected Source differs from the original frozen intent."),
      )
    const predecessor = typeof options.mode === "object" ? original : pending?.predecessor?.intent
    const targetFence = assertCurrentSourceTargetsAvailable(
      library,
      affected,
      intent,
      predecessor !== undefined && "source_input" in predecessor ? predecessor : undefined,
    )
    yield* targetFence
    const inspected = []
    const inspectedPlans = new Map<
      string,
      Effect.Success<ReturnType<typeof inspectCoordinatedSkillWrite>>
    >()
    for (const plan of plans) {
      const adoption = adoptions.get(plan.skill_id)
      if (adoption !== undefined) {
        inspected.push({
          contract: "current",
          skill_id: plan.skill_id,
          page_id: adoption.page_id,
          action: "adopt",
          remote_writes: 0,
          source_files: desiredBySkill.get(plan.skill_id)!.files.length,
          notion_pages: adoption.files.length + 1,
        })
        continue
      }
      const target = yield* inspectCoordinatedSkillWrite(library, plan, source)
      inspected.push({
        ...target,
        source_files: desiredBySkill.get(plan.skill_id)!.files.length,
        notion_pages: target.files.length,
      })
      inspectedPlans.set(plan.skill_id, target)
    }
    for (const target of retirements)
      inspected.push({
        contract: "current",
        ...target,
        action: "retire",
        remote_writes: 0,
        source_files: 0,
        notion_pages: 0,
      })
    const resultBase = {
      version: 1 as const,
      contract: "current" as const,
      action: "declaration" as const,
      library: {
        library_id: library.library_id,
        database_id: library.skills.database_id,
        data_source_id: library.skills.data_source_id,
      },
      sources_data_source_id: library.sources.data_source_id,
      source_id,
      operation_id: options.operation_id,
      input_sha256: intent.input_sha256,
      configuration_sha256: prepared.configuration_sha256,
      revision: source.revision,
      resolved_commit: prepared.resolved_commit,
      affected_skill_ids: affected,
      source_files: source.manifest.length,
    }
    if (options.dry_run)
      return {
        ...resultBase,
        status: "inspected" as const,
        source_page_id: currentPage ?? null,
        remote_writes: 0 as const,
        targets: inspected,
      }
    const wanted = {
      declaration: prepared.declaration,
      content: prepared.prepared_source.content,
      revision: source.revision,
    }
    // The original finite parent cursor is the only proof that a child finished.
    // Verify that prefix before entering the writer, so drift causes no writes.
    const parent =
      options.mode === "resume" && original !== undefined
        ? yield* inspectCurrentOperation(library, intent.owner)
        : undefined
    const completed = new Map<
      string,
      Effect.Success<ReturnType<typeof verifyCoordinatedSkillDirectory>>
    >()
    if (
      parent?.record_observed &&
      parent.source_progress !== undefined &&
      parent.source_progress.next_index > 0
    ) {
      if (
        canonicalSharedJson(parent.intent) !== canonicalSharedJson(intent) ||
        parent.owner_page_id !== currentPage ||
        parent.owner_in_trash !== false ||
        parent.completion !== "ready" ||
        current === undefined ||
        !currentSourceManagementMatches(current, wanted)
      )
        return yield* Effect.fail(
          invalid("The completed Source prefix no longer belongs to its exact parent intent."),
        )
      const prefix = new Set(affected.slice(0, parent.source_progress.next_index))
      const completedPlans = plans.filter((plan) => prefix.has(plan.skill_id))
      const actual =
        completedPlans.length === 0
          ? new Map<string, Effect.Success<ReturnType<typeof verifyCoordinatedSkillDirectory>>>()
          : yield* queryCurrentSourceTargets(library, {
              skillIds: completedPlans.map((plan) => plan.skill_id),
            })
      if (actual.size !== completedPlans.length)
        return yield* Effect.fail(
          invalid("A completed Source target is missing or changed physical identity."),
        )
      for (const plan of completedPlans) {
        const target = actual.get(plan.skill_id)
        if (target === undefined)
          return yield* Effect.fail(invalid("A completed Source target disappeared."))
        completed.set(
          plan.skill_id,
          yield* verifyCoordinatedSkillDirectory(
            library,
            plan,
            { ...source, page_id: current.page_id },
            target,
            inspectedPlans.get(plan.skill_id)!,
          ),
        )
      }
    }
    const unchanged = new Map<
      string,
      Effect.Success<ReturnType<typeof verifyCoordinatedSkillDirectory>>
    >()
    if (
      options.mode === "apply" &&
      original === undefined &&
      retirements.length === 0 &&
      current?.state.state === "ready" &&
      currentSourceManagementMatches(current, wanted)
    ) {
      const actual = yield* queryCurrentSourceTargets(library, {
        skillIds: affected,
        ...declaredScope,
        sourcePageId: current.page_id,
        sourceId: source_id,
      })
      if ([...actual.keys()].some((skillId) => !affected.includes(skillId)))
        return yield* Effect.fail(invalid("The Source target scope changed after inspection."))
      for (const plan of plans) {
        const target = actual.get(plan.skill_id)
        if (target === undefined || target.state.state !== "ready") continue
        const inspected = inspectedPlans.get(plan.skill_id)!
        if (inspected.page_id !== null && inspected.page_id !== target.page_id)
          return yield* Effect.fail(
            invalid("The Source target changed physical identity after inspection."),
          )
        const verified = yield* inspectCoordinatedSkillDirectory(
          library,
          plan,
          { ...source, page_id: current.page_id },
          target,
          inspected,
        )
        if (verified !== undefined) unchanged.set(plan.skill_id, verified)
      }
    }
    if (options.verify_only) {
      if (
        current === undefined ||
        current.state.state !== "ready" ||
        original !== undefined ||
        !currentSourceManagementMatches(current, wanted) ||
        retirements.length !== 0 ||
        unchanged.size !== plans.length
      )
        return yield* Effect.fail(
          invalid("The completed Source cannot be verified without another write."),
        )
      return {
        ...resultBase,
        source_page_id: current.page_id,
        state: "ready" as const,
        status: "unchanged" as const,
        targets: plans.map((plan) => ({
          skill_id: plan.skill_id,
          page_id: unchanged.get(plan.skill_id)!.page_id,
          status: "unchanged" as const,
          notion_pages: unchanged.get(plan.skill_id)!.files.length + 1,
          source_files: desiredBySkill.get(plan.skill_id)!.files.length,
        })),
      }
    }
    return yield* withCurrentOperation(library, {
      intent,
      ownerPageId: currentPage ?? null,
      mode: options.mode,
      beforeMutation: targetFence,
      run: (session) =>
        Effect.gen(function* () {
          if (
            completed.size !== 0 &&
            canonicalSharedJson(session.sourceProgress) !==
              canonicalSharedJson(parent?.source_progress)
          )
            return yield* Effect.fail(
              invalid("The Source cursor changed after completed-prefix verification."),
            )
          let changed = current === undefined || !currentSourceManagementMatches(current, wanted)
          const api = yield* Notion
          let latest = current
          const created =
            currentPage ??
            (yield* session.dispatch<string, Notion | Crypto.Crypto>({
              key: "source:create",
              replay: "never",
              request: {
                path: "v1/pages",
                body: {
                  parent: {
                    type: "data_source_id",
                    data_source_id: library.sources.data_source_id,
                  },
                  properties: yield* checked(() =>
                    currentSourceWriteProperties(library, {
                      ...wanted,
                      creatingOperation: options.operation_id,
                    }),
                  ),
                },
                options: { method: "POST" },
              },
              observe: ({ fresh }) =>
                Effect.gen(function* () {
                  if (fresh || latest === undefined)
                    latest = yield* queryCurrentSourceManagement(library, source_id)
                  if (latest === undefined) return { status: "missing" } as const
                  if (current !== undefined && latest.page_id !== current.page_id)
                    return yield* Effect.fail(invalid("The Source changed physical identity."))
                  if (
                    current === undefined &&
                    (!currentSourceManagementMatches(latest, wanted) ||
                      latest.state.state === "ready" ||
                      latest.state.operation_id !== options.operation_id)
                  )
                    return yield* Effect.fail(
                      invalid("Another writer created this Source after target inspection."),
                    )
                  return { status: "complete", value: latest.page_id } as const
                }),
              acknowledge: (raw) =>
                checked(() => {
                  const row = parseCurrentSourceManagement(library, raw)
                  if (
                    !currentSourceManagementMatches(row, wanted) ||
                    row.state.state === "ready" ||
                    row.state.operation_id !== options.operation_id
                  )
                    throw fail(
                      "WRITE_OUTCOME_UNKNOWN",
                      "Source CREATE did not confirm the selected intent.",
                    )
                  latest = row
                  return row.page_id
                }),
            }))
          if (session.ownerPageId === null) yield* session.bindOwner(created)
          else if (session.ownerPageId !== created)
            return yield* Effect.fail(invalid("The Source intent has a different physical owner."))
          const manifestResource =
            "resource" in prepared.prepared_source ? prepared.prepared_source.resource : undefined
          if (manifestResource !== undefined)
            yield* storeSourceManifest(library, session, manifestResource)
          yield* session.dispatch({
            key: "source:properties",
            replay: "idempotent",
            request: {
              path: `v1/pages/${created}`,
              body: {
                properties: yield* checked(() => currentSourceWriteProperties(library, wanted)),
              },
              options: { method: "PATCH" },
            },
            observe: () =>
              Effect.gen(function* () {
                const raw = yield* api.request(`v1/pages/${created}`)
                if (current === undefined && registered !== undefined) {
                  const observed = yield* readMaterializationRegistration(
                    library,
                    source_id,
                    options.materialization?.legacy_registration === undefined
                      ? undefined
                      : {
                          registration: options.materialization.legacy_registration,
                          operation_id: options.operation_id,
                        },
                  )
                  if (observed.current === undefined) {
                    if (
                      observed.page_id !== created ||
                      (yield* sourceRegistrationDigest(observed)) !==
                        options.materialization!.registration_digest ||
                      !sameLegacySourceRegistration(
                        observed.legacy_registration,
                        options.materialization?.legacy_registration,
                      )
                    )
                      return yield* Effect.fail(
                        invalid("The uninitialized Source registration changed."),
                      )
                    return { status: "missing" as const }
                  }
                }
                const row = yield* checked(() => parseCurrentSourceManagement(library, raw))
                if (currentSourceManagementMatches(row, wanted))
                  return { status: "complete" as const, value: undefined }
                if (current === undefined || !currentSourceManagementMatches(row, current))
                  return yield* Effect.fail(
                    invalid("The Source configuration changed after target inspection."),
                  )
                return { status: "missing" as const }
              }),
            acknowledge: (raw) =>
              checked(() => {
                if (
                  !currentSourceManagementMatches(
                    parseCurrentSourceManagement(library, raw),
                    wanted,
                  )
                )
                  throw fail(
                    "WRITE_OUTCOME_UNKNOWN",
                    "The selected Source configuration was not confirmed.",
                  )
              }),
          })
          const checkSourceCurrent = (raw: unknown) =>
            checked(() => {
              const row = parseCurrentSourceManagement(library, raw)
              if (!currentSourceManagementMatches(row, wanted))
                throw invalid("The Source configuration changed during this intent.")
            })
          const assertSourceCurrent = Effect.gen(function* () {
            yield* checkSourceCurrent(yield* session.assertCurrent())
          })
          // A parent retirement can be left in flight after earlier children
          // completed. Reconcile that exact action before rechecking those children.
          if (/^retire-source-target:/u.test(session.pendingActionKey ?? "")) {
            const skill_id = affected[session.sourceProgress?.next_index ?? -1]
            const target = retirements.find((target) => target.skill_id === skill_id)
            if (target === undefined)
              return yield* Effect.fail(
                invalid("The pending retirement is outside the frozen Source cursor."),
              )
            yield* retireCurrentSourceTarget(
              library,
              session,
              source_id,
              target,
              assertSourceCurrent,
            )
          }
          if (session.pendingActionKey?.startsWith("retire-source-orphan:"))
            yield* retireOrphanedSourceFiles(library, session, source_id, assertSourceCurrent)
          if (session.pendingActionKey?.startsWith("retire-source-manifest:"))
            yield* retireSourceManifests(library, session, wanted.content, assertSourceCurrent)
          for (const adoption of adoptions.values()) {
            yield* assertSourceCurrent
            yield* adoptSourceSkill(
              library,
              session,
              adoption,
              desiredBySkill.get(adoption.skill_id)!,
            )
          }
          const results = []
          for (const skill_id of affected) {
            const retirement = retirements.find((target) => target.skill_id === skill_id)
            if (retirement !== undefined) {
              yield* retireCurrentSourceTarget(
                library,
                session,
                source_id,
                retirement,
                assertSourceCurrent,
              )
              results.push({
                version: 1 as const,
                contract: "current" as const,
                library: resultBase.library,
                ...retirement,
                operation_id: options.operation_id,
                input_sha256: intent.input_sha256,
                state: "removed" as const,
                status: "removed" as const,
                source_files: 0,
                notion_pages: 0,
              })
              changed = true
              if ((session.sourceProgress?.next_index ?? -1) <= affected.indexOf(skill_id))
                yield* session.markSourceChildComplete(skill_id)
              continue
            }
            const plan = plans.find((target) => target.skill_id === skill_id)!
            const verified = completed.get(skill_id) ?? unchanged.get(skill_id)
            if (verified !== undefined) {
              results.push({
                contract: "current",
                library: resultBase.library,
                status: "unchanged",
                operation_id:
                  "source-target-" +
                  (yield* sha256(canonicalSharedJson([options.operation_id, plan.skill_id]))),
                skill_id,
                page_id: verified.page_id,
                input_sha256: plan.input_sha256,
                source_files: desiredBySkill.get(skill_id)!.files.length,
                notion_pages: verified.files.length + 1,
                relations: {},
                state: "ready",
                request_metrics: api.requestMetrics?.(),
              })
              if (unchanged.has(skill_id)) yield* session.markSourceChildComplete(skill_id)
              continue
            }
            const authorization = yield* authorizeCoordinatedSkillWrite(session, {
              plan,
              source: { ...source, page_id: created },
              assertSourceCurrent: checkSourceCurrent,
            })
            const result = yield* writeCoordinatedSkill(library, {
              plan,
              operation_id:
                "source-target-" +
                (yield* sha256(canonicalSharedJson([options.operation_id, plan.skill_id]))),
              mode: typeof options.mode === "object" ? "apply" : options.mode,
              authorization,
            })
            const { files: notion_pages, ...targetResult } = result
            results.push({
              ...targetResult,
              source_files: desiredBySkill.get(skill_id)!.files.length,
              notion_pages,
            })
            if (result.status !== "unchanged") changed = true
            if (!authorization.completed) yield* session.markSourceChildComplete(plan.skill_id)
          }
          if (
            options.materialization === undefined &&
            (yield* retireOrphanedSourceFiles(library, session, source_id, assertSourceCurrent)) > 0
          )
            changed = true
          if (
            (yield* retireSourceManifests(library, session, wanted.content, assertSourceCurrent)) >
            0
          )
            changed = true
          yield* assertSourceCurrent
          return {
            ...resultBase,
            source_page_id: created,
            state: "ready" as const,
            status: changed ? ("applied" as const) : ("unchanged" as const),
            targets: results,
          }
        }),
      verify: (session, value) =>
        Effect.gen(function* () {
          const raw = yield* session.assertCurrent()
          const row = yield* checked(() => parseCurrentSourceManagement(library, raw))
          if (!currentSourceManagementMatches(row, wanted))
            return yield* Effect.fail(
              invalid("The Source no longer matches its completed targets."),
            )
          const unique = yield* queryCurrentSourceManagement(library, source_id)
          if (
            unique === undefined ||
            unique.page_id !== session.ownerPageId ||
            unique.page_id !== row.page_id ||
            !currentSourceManagementMatches(unique, wanted)
          )
            return yield* Effect.fail(
              invalid("The stable Source identity changed before completion."),
            )
          const actual = yield* queryCurrentSourceTargets(library, {
            skillIds: affected,
            ...declaredScope,
            sourcePageId: row.page_id,
            sourceId: source_id,
          })
          if (actual.size !== plans.length || plans.some((plan) => !actual.has(plan.skill_id)))
            return yield* Effect.fail(invalid("The Source target scope changed before ready."))
          for (const target of retirements) {
            const page = property(yield* (yield* Notion).request(`v1/pages/${target.page_id}`))
            if (page.in_trash !== true && page.archived !== true)
              return yield* Effect.fail(invalid("A removed Source member remains live.", target))
            const remaining = yield* queryCurrentFilesForSkills({
              dataSourceId: library.files.data_source_id,
              skillPageIds: [target.page_id],
              propertyIds: library.files.property_ids,
            })
            if ((remaining.get(target.page_id)?.length ?? 0) !== 0)
              return yield* Effect.fail(
                invalid("A removed Source member still owns live Files.", target),
              )
          }
          for (const plan of plans) {
            const target = actual.get(plan.skill_id)
            if (target === undefined || target.state.state !== "ready")
              return yield* Effect.fail(invalid("An affected Skill is not completely ready."))
            yield* verifyCoordinatedSkillDirectory(
              library,
              plan,
              { ...source, page_id: row.page_id },
              target,
              {
                page_id: value.targets.find((result) => result.skill_id === plan.skill_id)!.page_id,
                files: [],
              },
            )
          }
        }),
    })
  })
}

function retireOrphanedSourceFiles(
  library: SharedLibrary,
  session: CurrentOperationSession,
  sourceId: string,
  assertSourceCurrent: Effect.Effect<void, SkillsError, Notion | Crypto.Crypto | Store>,
) {
  return Effect.gen(function* () {
    const api = yield* Notion
    const field = (raw: unknown, name: string) => {
      const id = library.files.property_ids[name]
      const matches = Object.entries(property(property(raw).properties)).filter(
        ([key, value]) => key === id || property(value).id === id,
      )
      if (matches.length !== 1)
        throw invalid("A Source File property is missing or repeated.", { property: name })
      return property(matches[0]![1])
    }
    const inspect = (raw: unknown) =>
      checked(() => {
        const row = property(raw),
          parent = property(row.parent)
        if (
          row.object !== "page" ||
          typeof row.id !== "string" ||
          !/^[a-f0-9-]{36}$/u.test(row.id) ||
          parent.type !== "data_source_id" ||
          parent.data_source_id !== library.files.data_source_id
        )
          throw invalid("The Source File query returned a foreign physical row.")
        const encoded = field(raw, "Content"),
          owner = field(raw, "Skill")
        if (
          encoded.type !== "rich_text" ||
          encoded.has_more === true ||
          !Array.isArray(encoded.rich_text)
        )
          throw invalid("The Source File Content is incomplete.")
        const content = parseCurrentFileContent(text(encoded.rich_text))
        if (content.kind !== "source" || content.source_id !== sourceId) return undefined
        if (
          owner.type !== "relation" ||
          owner.has_more === true ||
          !Array.isArray(owner.relation) ||
          owner.relation.length > 1
        )
          throw invalid("A Source File has incomplete or ambiguous ownership.")
        const id = text(field(raw, "File ID").rich_text)
        currentWriteIdentity(id, "File ID")
        const ownerPage = owner.relation.length ? property(owner.relation[0]).id : undefined
        if (
          ownerPage !== undefined &&
          (typeof ownerPage !== "string" || !/^[a-f0-9-]{36}$/u.test(ownerPage))
        )
          throw invalid("The Source File has an invalid owner identity.")
        return {
          page_id: row.id,
          file_id: id,
          owner_page_id: ownerPage,
          retired: row.in_trash === true || row.archived === true,
        }
      })
    const orphaned = (owner: string | undefined) =>
      Effect.gen(function* () {
        if (owner === undefined) return true
        const raw = property(yield* api.request(`v1/pages/${owner}`)),
          parent = property(raw.parent)
        if (
          raw.id !== owner ||
          raw.object !== "page" ||
          parent.type !== "data_source_id" ||
          parent.data_source_id !== library.skills.data_source_id
        )
          return yield* Effect.fail(
            invalid("The Source File owner is outside the current library."),
          )
        return raw.in_trash === true || raw.archived === true
      })
    const retire = (page: string) =>
      session.dispatch({
        key: `retire-source-orphan:${page}`,
        replay: "idempotent",
        request: {
          path: `v1/pages/${page}`,
          body: { in_trash: true },
          options: { method: "PATCH" },
        },
        observe: () =>
          Effect.gen(function* () {
            const file = yield* inspect(yield* api.request(`v1/pages/${page}`))
            if (
              file === undefined ||
              file.page_id !== page ||
              !(yield* orphaned(file.owner_page_id))
            )
              return yield* Effect.fail(
                invalid("The orphan File acquired another Source or a live Skill owner."),
              )
            yield* assertSourceCurrent
            return file.retired
              ? { status: "complete" as const, value: undefined }
              : { status: "missing" as const }
          }),
        acknowledge: (raw) =>
          Effect.gen(function* () {
            const file = yield* inspect(raw)
            if (file === undefined || file.page_id !== page || !file.retired)
              return yield* Effect.fail(
                fail(
                  "WRITE_OUTCOME_UNKNOWN",
                  "The orphan Source File retirement was not confirmed.",
                ),
              )
          }),
      })
    let retired = 0
    const pending = /^retire-source-orphan:([a-f0-9-]{36})$/u.exec(session.pendingActionKey ?? "")
    if (pending) {
      yield* retire(pending[1]!)
      retired++
    }
    const cursors = new Set<string>(),
      pages = new Set<string>(),
      owners = new Map<string | undefined, boolean>()
    let cursor: string | undefined
    const selected: string[] = []
    for (;;) {
      const raw = yield* api.request(
        `v1/data_sources/${library.files.data_source_id}/query`,
        {
          page_size: 100,
          filter: {
            property: library.files.property_ids.Content,
            rich_text: { contains: sourceId },
          },
          ...(cursor === undefined ? {} : { start_cursor: cursor }),
        },
        { method: "POST" },
      )
      const list = yield* checked(() => {
        const result = Schema.decodeUnknownSync(listSchema(Schema.Unknown))(raw)
        if (
          property(raw).object !== "list" ||
          (result.has_more
            ? !result.next_cursor || cursors.has(result.next_cursor)
            : result.next_cursor !== null)
        )
          throw invalid("The Source-owned Files inventory is incomplete.")
        return result
      })
      for (const row of list.results) {
        const file = yield* inspect(row)
        if (file === undefined) continue
        if (file.retired || pages.has(file.page_id))
          return yield* Effect.fail(
            invalid("The Source Files inventory repeats or includes a retired page."),
          )
        pages.add(file.page_id)
        if (!owners.has(file.owner_page_id))
          owners.set(file.owner_page_id, yield* orphaned(file.owner_page_id))
        if (owners.get(file.owner_page_id)) selected.push(file.page_id)
      }
      if (!list.has_more) break
      cursor = list.next_cursor!
      cursors.add(cursor)
    }
    for (const page of selected) {
      yield* retire(page)
      retired++
    }
    return retired
  })
}

function retireCurrentSourceTarget(
  library: SharedLibrary,
  session: CurrentOperationSession,
  sourceId: string,
  target: { readonly skill_id: string; readonly page_id: string },
  assertSourceCurrent: Effect.Effect<void, SkillsError, Notion | Crypto.Crypto | Store>,
) {
  return Effect.gen(function* () {
    const api = yield* Notion
    const active = (raw: unknown) => ({ ...property(raw), in_trash: false, archived: false })
    const inspectOwner = (raw: unknown) =>
      Effect.gen(function* () {
        const row = property(raw)
        const index = yield* queryCurrentSkillIndex(library, target.page_id, active(raw), [])
        if (
          index.skill_id !== target.skill_id ||
          index.state.state !== "ready" ||
          index.main.content.kind !== "source" ||
          index.main.content.source_id !== sourceId
        )
          return yield* Effect.fail(
            invalid("The retiring Skill no longer belongs exclusively to this Source.", target),
          )
        return row.in_trash === true || row.archived === true
      })
    yield* inspectOwner(yield* api.request(`v1/pages/${target.page_id}`))
    const retireFile = (page: string) =>
      Effect.gen(function* () {
        const inspect = (raw: unknown) =>
          checked(() => {
            const row = property(raw)
            const file = currentFileRecord(
              active(raw),
              target.page_id,
              library.files.data_source_id,
              library.files.property_ids,
            )
            if (
              file.page_id !== page ||
              file.content.kind !== "source" ||
              file.content.source_id !== sourceId
            )
              throw invalid("The retiring File changed its Source ownership.", {
                ...target,
                page_id: page,
              })
            return row.in_trash === true || row.archived === true
          })
        yield* session.dispatch({
          key: `retire-source-target:file:${page}`,
          replay: "idempotent",
          request: {
            path: `v1/pages/${page}`,
            body: { in_trash: true },
            options: { method: "PATCH" },
          },
          observe: () =>
            Effect.gen(function* () {
              const retired = yield* inspect(yield* api.request(`v1/pages/${page}`))
              yield* assertSourceCurrent
              return retired
                ? { status: "complete" as const, value: undefined }
                : { status: "missing" as const }
            }),
          acknowledge: (raw) =>
            Effect.gen(function* () {
              if (!(yield* inspect(raw)))
                return yield* Effect.fail(
                  fail("WRITE_OUTCOME_UNKNOWN", "Source File retirement was not confirmed."),
                )
            }),
        })
      })
    const pendingFile = /^retire-source-target:file:([a-f0-9-]{36})$/u.exec(
      session.pendingActionKey ?? "",
    )
    if (pendingFile) yield* retireFile(pendingFile[1]!)
    const files =
      (yield* queryCurrentFilesForSkills({
        dataSourceId: library.files.data_source_id,
        skillPageIds: [target.page_id],
        propertyIds: library.files.property_ids,
      })).get(target.page_id) ?? []
    for (const file of files) yield* retireFile(file.page_id)
    const owner = { kind: "skill" as const, page_id: target.page_id }
    const retireResource = (page: string) =>
      Effect.gen(function* () {
        const inspect = (raw: unknown) =>
          Effect.gen(function* () {
            const row = property(raw)
            const objectId = text(
              Object.entries(property(row.properties)).flatMap(([key, value]) =>
                key === library.records.property_ids["Record ID"] ||
                property(value).id === library.records.property_ids["Record ID"]
                  ? property(value).rich_text
                  : [],
              ),
            )
            const { record } = yield* currentOwnedResourceFromPage(library, active(raw), {
              owner,
              objectId,
            })
            if (record.page_id !== page)
              return yield* Effect.fail(invalid("The retiring resource changed physical identity."))
            return row.in_trash === true || row.archived === true
          })
        yield* session.dispatch({
          key: `retire-source-target:resource:${page}`,
          replay: "idempotent",
          request: {
            path: `v1/pages/${page}`,
            body: { in_trash: true },
            options: { method: "PATCH" },
          },
          observe: () =>
            Effect.gen(function* () {
              const retired = yield* inspect(yield* api.request(`v1/pages/${page}`))
              yield* assertSourceCurrent
              return retired
                ? { status: "complete" as const, value: undefined }
                : { status: "missing" as const }
            }),
          acknowledge: (raw) =>
            Effect.gen(function* () {
              if (!(yield* inspect(raw)))
                return yield* Effect.fail(
                  fail("WRITE_OUTCOME_UNKNOWN", "Source resource retirement was not confirmed."),
                )
            }),
        })
      })
    const pendingResource = /^retire-source-target:resource:([a-f0-9-]{36})$/u.exec(
      session.pendingActionKey ?? "",
    )
    if (pendingResource) yield* retireResource(pendingResource[1]!)
    for (const { record } of yield* listCurrentOwnedResourceRecords(library, owner))
      yield* retireResource(record.page_id)
    const origin = library.skills.property_ids.Origin
    if (origin === undefined)
      return yield* Effect.fail(invalid("The current Origin property is not registered."))
    yield* session.dispatch({
      key: `retire-source-target:skill:${target.page_id}`,
      replay: "idempotent",
      request: {
        path: `v1/pages/${target.page_id}`,
        body: { in_trash: true, properties: { [origin]: { relation: [] } } },
        options: { method: "PATCH" },
      },
      observe: () =>
        Effect.gen(function* () {
          const retired = yield* inspectOwner(yield* api.request(`v1/pages/${target.page_id}`))
          yield* assertSourceCurrent
          return retired
            ? { status: "complete" as const, value: undefined }
            : { status: "missing" as const }
        }),
      acknowledge: (raw) =>
        Effect.gen(function* () {
          if (!(yield* inspectOwner(raw)))
            return yield* Effect.fail(
              fail("WRITE_OUTCOME_UNKNOWN", "Source Skill retirement was not confirmed."),
            )
        }),
    })
  })
}

function storeSourceManifest(
  library: SharedLibrary,
  session: CurrentOperationSession,
  prepared: PreparedCurrentSharedResource,
) {
  return Effect.gen(function* () {
    if (session.ownerPageId === null || session.owner.kind !== "source")
      return yield* Effect.fail(invalid("Bind the Source before storing its current manifest."))
    const owner = { kind: "source" as const, page_id: session.ownerPageId }
    const objectId = prepared.content.object_id
    const existing = yield* queryCurrentOwnedResourceRecord(library, { owner, objectId })
    let upload: Effect.Success<ReturnType<typeof uploadCurrentSharedResource>> | undefined
    if (prepared.status !== "inline") {
      const prefix = yield* currentUploadActionPrefix({
        session,
        path: "source-manifest.json",
        prepared,
      })
      if (existing === undefined || session.pendingActionKey?.startsWith(prefix))
        upload = yield* uploadCurrentSharedResource({
          session,
          path: "source-manifest.json",
          prepared,
        })
    }
    const request = yield* currentOwnedResourceCreateRequest(library, {
      owner,
      objectId,
      payload: prepared.manifest,
      ...(upload === undefined ? {} : { upload: { id: upload.id, name: upload.filename } }),
    })
    const record = yield* session.dispatch<
      Effect.Success<ReturnType<typeof currentOwnedResourceFromPage>>,
      Notion | Crypto.Crypto
    >({
      key: `source-manifest:${objectId}:create`,
      request,
      replay: "never",
      observe: ({ fresh }) =>
        Effect.gen(function* () {
          const found = fresh
            ? yield* queryCurrentOwnedResourceRecord(library, { owner, objectId })
            : existing
          if (found === undefined) return { status: "missing" } as const
          yield* validateCurrentSharedResourceManifest(prepared.content, found.record.payload)
          return { status: "complete", value: found } as const
        }),
      acknowledge: (raw) => currentOwnedResourceFromPage(library, raw, { owner, objectId }),
    })
    yield* validateCurrentSharedResourceManifest(prepared.content, record.record.payload)
    const actual = yield* readCurrentSharedResourceBytes(library, {
      owner,
      content: prepared.content,
    })
    if ((yield* sha256(actual)) !== prepared.content.sha256)
      return yield* Effect.fail(
        invalid("The uploaded current manifest differs from its selected plan."),
      )
  })
}

export function retireSourceManifests(
  library: SharedLibrary,
  session: CurrentOperationSession,
  content: PreparedCurrentSourceInput["prepared_source"]["content"] | null,
  assertSourceCurrent: Effect.Effect<void, SkillsError, Notion | Crypto.Crypto | Store>,
) {
  return Effect.gen(function* () {
    if (session.ownerPageId === null || session.owner.kind !== "source")
      return yield* Effect.fail(invalid("Source cleanup requires its exact current owner."))
    yield* assertSourceCurrent
    const owner = { kind: "source" as const, page_id: session.ownerPageId },
      retained = content !== null && "resource" in content ? content.resource.object_id : undefined,
      api = yield* Notion
    const retire = (page: string) =>
      Effect.gen(function* () {
        const observe = (raw: unknown) =>
          Effect.gen(function* () {
            const row = property(raw)
            const matches = Object.entries(property(row.properties)).flatMap(([key, raw]) => {
              const field = property(raw)
              return key === library.records.property_ids["Record ID"] ||
                field.id === library.records.property_ids["Record ID"]
                ? [field]
                : []
            })
            const field = matches[0]
            if (
              row.id !== page ||
              matches.length !== 1 ||
              field?.type !== "rich_text" ||
              field.has_more === true ||
              !Array.isArray(field.rich_text)
            )
              return yield* Effect.fail(invalid("The obsolete manifest Record is incomplete."))
            const objectId = field.rich_text
              .map((part) => {
                const value = property(part)
                return typeof value.plain_text === "string"
                  ? value.plain_text
                  : property(value.text).content
              })
              .join("")
            if (objectId === retained)
              return yield* Effect.fail(invalid("The selected manifest cannot be retired."))
            yield* currentOwnedResourceFromPage(
              library,
              { ...row, in_trash: false, archived: false },
              { owner, objectId },
            )
            return row.in_trash === true
          })
        yield* session.dispatch({
          key: `retire-source-manifest:${page}`,
          replay: "idempotent",
          request: {
            path: `v1/pages/${page}`,
            body: { in_trash: true },
            options: { method: "PATCH" },
          },
          observe: () =>
            Effect.gen(function* () {
              const trashed = yield* observe(yield* api.request(`v1/pages/${page}`))
              yield* assertSourceCurrent
              return trashed
                ? { status: "complete" as const, value: undefined }
                : { status: "missing" as const }
            }),
          acknowledge: (raw) =>
            Effect.gen(function* () {
              if (!(yield* observe(raw)))
                return yield* Effect.fail(
                  fail("WRITE_OUTCOME_UNKNOWN", "Manifest retirement was not confirmed."),
                )
            }),
        })
      })
    const pending = /^retire-source-manifest:([a-f0-9-]{36})$/u.exec(session.pendingActionKey ?? "")
    let retired = 0
    if (pending) {
      yield* retire(pending[1]!)
      retired++
    }
    const records = yield* listCurrentOwnedResourceRecords(library, owner)
    for (const { record } of records)
      if (record.record_id !== retained) {
        yield* retire(record.page_id)
        retired++
      }
    return retired
  })
}
