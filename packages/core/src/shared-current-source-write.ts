import { Crypto, Effect } from "effect"
import { fail, property, SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256, type Store } from "./store.ts"
import { withCurrentInvocationBudget } from "./shared-current-invocation.ts"
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
} from "./shared-current-source-management.ts"
import {
  readCurrentOperationIntent,
  withCurrentOperation,
  type CurrentOperationIntent,
  type CurrentOperationSession,
  type CurrentWriteMode,
} from "./shared-current-operation.ts"
import {
  authorizeCoordinatedSkillWrite,
  inspectCoordinatedSkillWrite,
  prepareCoordinatedSkillWrite,
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
import { assertCurrentBodyReplaceable } from "./shared-current-projection.ts"
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

function sourcePending(pending: Pending, configuration: string, options: SourceWriteOptions) {
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
    intent.source_input.configuration_sha256 !== configuration
  )
    throw fail("CURRENT_OPERATION_PENDING", "This Source has a different unfinished input.", {
      owner: intent.owner,
      operation_id: intent.operation_id,
      input_sha256: intent.input_sha256,
      next: "resume_or_supersede_current",
      required_input:
        "Resume the original input, or stop its writer and supply a complete new input with --operation NEW --supersede OLD.",
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
    const configuration = yield* sha256(canonicalSharedJson(declaration))
    const pending = yield* readCurrentOperationIntent(library, {
      kind: "source",
      id: declaration.definition.source_id,
    })
    yield* assertCurrentSourceHandoffSettled(library, pending, input.mode, input.operation_id)
    const selected = { ...input, mode: selectedSourceMode(pending, input) }
    const original = yield* checked(() => sourcePending(pending, configuration, selected))
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
    const prepared = yield* copyPreparedSource(input.prepared)
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
    withCurrentInvocationBudget,
    Effect.map(({ result }) => result),
  )
}

function copyPreparedSource(input: PreparedCurrentSourceInput) {
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
      inspection.plan.base.source.url.replace(/\.git$/u, "") !==
        declaration.definition.adapter.url.replace(/\.git$/u, "") ||
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

function executeCurrentSource(
  library: SharedLibrary,
  prepared: PreparedCurrentSourceInput,
  options: SourceWriteOptions,
  pending: Pending,
) {
  return Effect.gen(function* () {
    const source_id = prepared.declaration.definition.source_id
    const current = yield* queryCurrentSourceManagement(library, source_id)
    const original = yield* checked(() =>
      sourcePending(pending, prepared.configuration_sha256, options),
    )
    const targetIds = [
      ...prepared.targets.map((target) => target.skill_id),
      ...(current?.declaration.contributions.map((entry) => entry.skill_id) ?? []),
      ...(original?.source_input.affected_skill_ids ?? []),
    ]
    const targets = yield* queryCurrentSourceTargets(library, {
      skillIds: targetIds,
      ...(current === undefined ? {} : { sourcePageId: current.page_id }),
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
    for (const skill_id of affected) {
      const previous = targets.get(skill_id),
        desired = desiredBySkill.get(skill_id)
      if (previous === undefined && desired === undefined)
        return yield* Effect.fail(invalid("An affected current Skill disappeared.", { skill_id }))
      const bindings = previous === undefined ? [] : [previous.main, ...previous.files]
      const owned = bindings.filter(
        (file) => file.content.kind === "source" && file.content.source_id === source_id,
      )
      const files: Parameters<typeof prepareCoordinatedSkillWrite>[0]["files"][number][] = bindings
        .filter((file) => !(file.content.kind === "source" && file.content.source_id === source_id))
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
        files.push({
          kind: "write",
          file: {
            ...file,
            file_id:
              selected[0]?.file_id ??
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
      // Removed contributions can only address existing targets. Their create-only
      // defaults are constant and never freeze or replace human metadata.
      const defaults = desired?.defaults ?? {
        name: "Source target",
        description: "Current Source contribution.",
      }
      plans.push(
        yield* prepareCoordinatedSkillWrite({
          skill_id,
          kind: previous?.kind ?? desired!.kind,
          source: { source_id, revision: source.revision },
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
    const inspected = []
    for (const plan of plans)
      inspected.push(yield* inspectCoordinatedSkillWrite(library, plan, source))
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
    }
    if (options.dry_run)
      return {
        ...resultBase,
        status: "inspected" as const,
        source_page_id: current?.page_id ?? null,
        remote_writes: 0 as const,
        targets: inspected,
      }
    const wanted = {
      declaration: prepared.declaration,
      content: prepared.prepared_source.content,
      revision: source.revision,
    }
    return yield* withCurrentOperation(library, {
      intent,
      ownerPageId: current?.page_id ?? null,
      mode: options.mode,
      run: (session) =>
        Effect.gen(function* () {
          let changed = current === undefined || !currentSourceManagementMatches(current, wanted)
          const api = yield* Notion
          let latest = current
          const created = yield* session.dispatch<string, Notion | Crypto.Crypto>({
            key: "source:create",
            replay: "never",
            request: {
              path: "v1/pages",
              body: {
                parent: { type: "data_source_id", data_source_id: library.sources.data_source_id },
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
          })
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
          const results = []
          for (const plan of plans) {
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
            results.push(result)
            if (result.status !== "unchanged") changed = true
            yield* session.markSourceChildComplete(plan.skill_id)
          }
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
      verify: (session) =>
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
            sourcePageId: row.page_id,
          })
          if (actual.size !== affected.length || affected.some((id) => !actual.has(id)))
            return yield* Effect.fail(invalid("The Source target scope changed before ready."))
          for (const plan of plans) {
            const target = actual.get(plan.skill_id)
            if (target === undefined || target.state.state !== "ready")
              return yield* Effect.fail(invalid("An affected Skill is not completely ready."))
            const selected = [target.main, ...target.files].filter(
              (file) => file.content.kind === "source" && file.content.source_id === source_id,
            )
            const wantedFiles = desiredBySkill.get(plan.skill_id)?.files ?? []
            if (selected.length !== wantedFiles.length)
              return yield* Effect.fail(invalid("The current Source contribution is incomplete."))
            for (const file of wantedFiles) {
              const found = selected.find((entry) => entry.path === file.path)
              const planned = plan.files.find((entry) => entry.path === file.path)
              if (
                found?.content.kind !== "source" ||
                found.file_id !== planned?.file_id ||
                found.content.source_path !== file.authority.source_path ||
                found.content.revision !== source.revision ||
                found.content.mode !== file.mode ||
                found.content.bytes !== file.bytes.byteLength ||
                found.content.sha256 !== (yield* sha256(file.bytes))
              )
                return yield* Effect.fail(
                  invalid("A Source target changed before completion.", {
                    skill_id: plan.skill_id,
                    path: file.path,
                  }),
                )
            }
          }
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
              if (!trashed) yield* assertCurrentBodyReplaceable(page)
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
