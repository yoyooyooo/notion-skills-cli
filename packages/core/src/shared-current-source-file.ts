import { Effect, Schema } from "effect"
import { fail, SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import { withCurrentInvocationBudget } from "./shared-current-invocation.ts"
import {
  readCurrentOperationIntent,
  withCurrentOperation,
  type CurrentOperationIntent,
  type CurrentWriteMode,
} from "./shared-current-operation.ts"
import {
  CurrentSourceFileRequestSchema,
  validateCurrentSourceFileInput,
  type CurrentSourceFileInput,
  type CurrentSourceFileRequest,
} from "./shared-current-source-file-input.ts"
import {
  currentSourceManagementMatches,
  currentSourceProperty,
  currentSourceWriteProperties,
  parseCurrentSourceManagement,
  queryCurrentSourceManagement,
  queryCurrentSourceTargets,
  type CurrentSourceManagement,
} from "./shared-current-source-management.ts"
import { validateCurrentSourceContributions } from "./shared-current-source-input.ts"
import { assertCurrentSourceHandoffSettled } from "./shared-current-source-successor.ts"
import {
  prepareCurrentSourceManagementSelection,
  validateCurrentSourceId,
  type CurrentSharedSource,
} from "./shared-current-source.ts"
import {
  authorizeCoordinatedSkillWrite,
  inspectCoordinatedSkillWrite,
  prepareCurrentSourceFileSkillWrite,
  writeCoordinatedSkill,
  type PreparedCoordinatedSkillWrite,
} from "./shared-current-write.ts"
import { currentWriteIdentity } from "./shared-current-write-input.ts"
import { loadCurrentSharedResourceContent } from "./shared-current-resource.ts"
import { observeSharedBody } from "./shared-page-body.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256 } from "./store.ts"
import type { CurrentFileBinding, CurrentSkillIndex } from "./shared-current-index.ts"
import type { SharedLibrary } from "./shared-library-model.ts"

const invalid = (message: string, details?: unknown) =>
  fail("CURRENT_SOURCE_WRITE_CONFLICT", message, details)
const checked = <A>(read: () => A) =>
  Effect.try({
    try: read,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : invalid("The current file authority action is invalid."),
  })
type Pending = Effect.Success<ReturnType<typeof readCurrentOperationIntent>>
export type CurrentSourceFileAuthorityOptions = CurrentSourceFileRequest & {
  readonly source_id: string
  readonly operation_id: string
  readonly mode?: CurrentWriteMode
  readonly dry_run?: boolean
}
const allFiles = (target: CurrentSkillIndex) => [target.main, ...target.files]
const binding = ({ file_id, page_id, skill_page_id, path, content }: CurrentFileBinding) => ({
  file_id,
  page_id,
  skill_page_id,
  path,
  content,
})

function selectedPending(input: CurrentSourceFileAuthorityOptions, pending: Pending) {
  const mode = input.mode ?? "apply"
  const request = Schema.decodeUnknownSync(CurrentSourceFileRequestSchema)(
    {
      source_path: input.source_path,
      skill_id: input.skill_id,
      file_id: input.file_id,
      action: input.action,
    },
    { onExcessProperty: "error" },
  )
  if (pending === undefined) {
    if (mode !== "apply")
      throw fail("CURRENT_OPERATION_NOT_FOUND", "No unfinished Source file action was found.")
    return { request, original: undefined, previous: undefined }
  }
  const intent = pending.intent
  if (!("source_input" in intent) || intent.source_input.kind !== "file_authority")
    throw fail(
      "CURRENT_OPERATION_PENDING",
      "Finish or supersede the original Source action with its own complete input.",
      {
        operation_id: intent.operation_id,
        action: "source_input" in intent ? intent.source_input.kind : "skill",
        next: "reconcile_current",
      },
    )
  const sameRequest =
    canonicalSharedJson(intent.source_input.request) === canonicalSharedJson(request)
  if (intent.operation_id === input.operation_id && mode !== "apply" && sameRequest) {
    if (typeof mode === "object" && pending.predecessor?.intent.operation_id !== mode.operation_id)
      throw invalid("The successor does not name this exact previous operation.")
    return { request, original: intent.source_input, previous: undefined }
  }
  if (
    typeof mode !== "object" ||
    mode.operation_id !== intent.operation_id ||
    intent.source_input.request.source_path !== request.source_path ||
    intent.source_input.request.skill_id !== request.skill_id ||
    intent.source_input.request.file_id !== request.file_id
  )
    throw fail("CURRENT_OPERATION_PENDING", "This Source has another unfinished file action.", {
      operation_id: intent.operation_id,
      input_sha256: intent.input_sha256,
      action: intent.source_input.request.action.kind,
      next: "reconcile_current",
    })
  return { request, original: undefined, previous: intent.source_input }
}

function changedDeclaration(
  current: CurrentSourceManagement,
  request: CurrentSourceFileRequest,
  path: string,
) {
  const matches = current.declaration.contributions.flatMap((entry, index) => {
    if (entry.skill_id !== request.skill_id) return []
    const prefix = entry.member_key === "." ? "" : entry.member_key + "/"
    if (!request.source_path.startsWith(prefix)) return []
    const relative = request.source_path.slice(prefix.length)
    if (!relative) return []
    const mount = entry.mount_path === "" ? "" : entry.mount_path + "/"
    if (!path.startsWith(mount) || path.length === mount.length) return []
    const mapped = entry.mapping[relative] ?? relative
    if (request.action.kind === "takeover" && mount + mapped !== path) return []
    return [{ entry, index, relative, mapped: path.slice(mount.length) }]
  })
  if (matches.length !== 1)
    throw invalid("Select one current contribution that maps this Source file to the exact target.")
  const selected = matches[0]!
  const contributions = [...structuredClone(current.declaration.contributions)]
  const mapping = { ...selected.entry.mapping }
  if (
    request.action.kind === "restore_follow" &&
    (mapping[selected.relative] ?? selected.relative) !== selected.mapped
  )
    mapping[selected.relative] = selected.mapped
  const exclude = new Set(selected.entry.exclude)
  if (request.action.kind === "takeover") exclude.add(selected.relative)
  else exclude.delete(selected.relative)
  contributions[selected.index] = { ...selected.entry, mapping, exclude: [...exclude] }
  return {
    declaration: {
      ...current.declaration,
      contributions: validateCurrentSourceContributions(contributions),
    },
    already_excluded: selected.entry.exclude.includes(selected.relative),
  }
}

/** A whole-file authority change and its exact contribution exclusion/mapping are
 * one Source intent. Every other current File remains a live preserved binding. */
export function changeCurrentSourceFileAuthority(
  library: SharedLibrary,
  input: CurrentSourceFileAuthorityOptions,
) {
  return Effect.gen(function* () {
    yield* checked(() => {
      validateCurrentSourceId(input.source_id)
      currentWriteIdentity(input.operation_id, "Operation ID")
      const mode = input.mode ?? "apply"
      if (typeof mode === "object") {
        if (mode.kind !== "supersede" || Object.keys(mode).length !== 2)
          throw invalid("Use an exact superseded operation identity.")
        currentWriteIdentity(mode.operation_id, "Previous Operation ID")
        if (mode.operation_id === input.operation_id)
          throw invalid("A successor requires a new operation identity.")
      } else if (mode !== "apply" && mode !== "resume")
        throw invalid("Use apply, resume or explicit supersede for a current file action.")
      if (input.dry_run && mode !== "apply")
        throw invalid("Dry run cannot resume or supersede an unfinished intent.")
      Schema.decodeUnknownSync(CurrentSourceFileRequestSchema)(
        {
          source_path: input.source_path,
          skill_id: input.skill_id,
          file_id: input.file_id,
          action: input.action,
        },
        { onExcessProperty: "error" },
      )
    })
    const pending = yield* readCurrentOperationIntent(library, {
      kind: "source",
      id: input.source_id,
    })
    yield* assertCurrentSourceHandoffSettled(library, pending, input.mode, input.operation_id)
    const { request, original, previous } = yield* checked(() => selectedPending(input, pending))
    const current = yield* queryCurrentSourceManagement(library, input.source_id)
    if (current === undefined)
      return yield* Effect.fail(
        fail("CURRENT_SOURCE_MISSING", "The selected current Source is unavailable."),
      )
    if (
      current.state.state !== "ready" &&
      (pending === undefined ||
        ![pending.intent.operation_id, pending.predecessor?.intent.operation_id].includes(
          current.state.operation_id,
        ))
    )
      return yield* Effect.fail(
        fail("CURRENT_OPERATION_PENDING", "The Source is owned by another unfinished intent."),
      )
    if (request.action.kind === "restore_follow" && !current.declaration.definition.enabled)
      return yield* Effect.fail(
        fail("SOURCE_DISABLED", "Enable the selected Source before restoring follow."),
      )
    const configuration = yield* sha256(canonicalSharedJson(current.declaration))
    const contentHash = yield* sha256(canonicalSharedJson(current.content))
    const frozen = original ?? previous
    if (
      frozen !== undefined &&
      (frozen.source_page_id !== current.page_id ||
        frozen.revision !== current.revision ||
        frozen.source_content_sha256 !== contentHash ||
        ![frozen.before_configuration_sha256, frozen.configuration_sha256].includes(configuration))
    )
      return yield* Effect.fail(
        invalid("The current Source changed outside its frozen file intent."),
      )
    const targets = yield* queryCurrentSourceTargets(library, { skillIds: [request.skill_id] })
    const target = targets.get(request.skill_id)
    if (target === undefined)
      return yield* Effect.fail(invalid("The selected current Skill is unavailable."))
    const selectedFiles = allFiles(target).filter((file) => file.file_id === request.file_id)
    const selected = selectedFiles[0]
    if (selectedFiles.length !== 1 || selected === undefined)
      return yield* Effect.fail(invalid("Select one existing stable File in this Skill."))
    if (
      frozen !== undefined &&
      (frozen.target.skill_page_id !== target.page_id ||
        frozen.target.page_id !== selected.page_id ||
        frozen.target.path !== selected.path)
    )
      return yield* Effect.fail(
        invalid("The file authority intent changed physical identity or Path."),
      )
    const childOperation =
      "source-target-" +
      (yield* sha256(canonicalSharedJson([input.operation_id, request.skill_id])))
    if (target.state.state !== "ready") {
      const authorized = new Set<string>()
      if (pending !== undefined) {
        authorized.add(childOperation)
        for (const operation of [
          pending.intent.operation_id,
          pending.predecessor?.intent.operation_id,
        ]) {
          if (operation !== undefined)
            authorized.add(
              "source-target-" +
                (yield* sha256(canonicalSharedJson([operation, request.skill_id]))),
            )
        }
      }
      if (!authorized.has(target.state.operation_id))
        return yield* Effect.fail(
          fail("CURRENT_OPERATION_PENDING", "Another operation owns the selected Skill."),
        )
    }
    const changed = yield* checked(() => changedDeclaration(current, request, selected.path))
    const wantedConfiguration = yield* sha256(canonicalSharedJson(changed.declaration))
    if (original !== undefined && wantedConfiguration !== original.configuration_sha256)
      return yield* Effect.fail(
        invalid("The file action no longer produces its frozen Source configuration."),
      )
    const source = yield* prepareCurrentSourceManagementSelection(library, {
      source_id: input.source_id,
      page_id: current.page_id,
      content: current.content,
      revision: current.revision,
    })
    const candidates = source.manifest.filter((file) => file.path === request.source_path)
    const sourceFile = candidates[0]
    if (candidates.length !== 1 || sourceFile === undefined)
      return yield* Effect.fail(
        invalid("The current selected Source no longer contains this exact file."),
      )
    const alreadyOwned =
      request.action.kind === "takeover" &&
      selected.content.kind === request.action.to &&
      changed.already_excluded
    if (frozen === undefined && !alreadyOwned) {
      if (
        request.action.kind === "takeover" &&
        (selected.content.kind !== "source" ||
          selected.content.source_id !== input.source_id ||
          selected.content.source_path !== request.source_path ||
          selected.content.revision !== current.revision ||
          selected.content.sha256 !== sourceFile.sha256 ||
          selected.content.bytes !== sourceFile.bytes ||
          selected.content.mode !== sourceFile.mode ||
          changed.already_excluded)
      )
        return yield* Effect.fail(
          invalid("Takeover requires this exact current Source-owned file."),
        )
      if (
        request.action.kind === "restore_follow" &&
        selected.content.kind === "source" &&
        (selected.content.source_id !== input.source_id ||
          selected.content.source_path !== request.source_path)
      )
        return yield* Effect.fail(
          invalid("Restore-follow cannot take a File from another Source binding."),
        )
    }
    if (
      allFiles(target).some(
        (file) =>
          file.page_id !== selected.page_id &&
          file.content.kind === "source" &&
          file.content.source_id === input.source_id &&
          file.content.source_path === request.source_path,
      )
    )
      return yield* Effect.fail(invalid("Another current File already follows this Source path."))
    const nativeHash =
      original !== undefined
        ? original.target.native_sha256
        : selected.content.kind === "native" && !alreadyOwned
          ? (yield* observeSharedBody(selected.page_id)).fingerprint.sha256
          : null
    const targetContentHash = yield* sha256(canonicalSharedJson(selected.content))
    const transfer =
      original ??
      (yield* checked(() =>
        validateCurrentSourceFileInput({
          kind: "file_authority",
          configuration_sha256: wantedConfiguration,
          affected_skill_ids: [request.skill_id],
          source_page_id: current.page_id,
          revision: source.revision,
          before_configuration_sha256: configuration,
          source_content_sha256: contentHash,
          request,
          target: {
            skill_page_id: target.page_id,
            page_id: selected.page_id,
            path: selected.path,
            content_sha256: targetContentHash,
            native_sha256: nativeHash,
          },
          selected: { sha256: sourceFile.sha256, bytes: sourceFile.bytes, mode: sourceFile.mode },
        }),
      ))
    const intent = {
      operation_id: input.operation_id,
      owner: { kind: "source" as const, id: input.source_id },
      input_sha256: yield* sha256(canonicalSharedJson({ source_input: transfer })),
      source_input: transfer,
    } satisfies CurrentOperationIntent
    if (
      original !== undefined &&
      pending !== undefined &&
      canonicalSharedJson(intent) !== canonicalSharedJson(pending.intent)
    )
      return yield* Effect.fail(invalid("The original file authority input changed."))
    const resultBase = {
      version: 1 as const,
      contract: "current" as const,
      library: {
        library_id: library.library_id,
        database_id: library.skills.database_id,
        data_source_id: library.skills.data_source_id,
      },
      sources_data_source_id: library.sources.data_source_id,
      source_id: input.source_id,
      source_page_id: current.page_id,
      source_path: request.source_path,
      file_id: request.file_id,
      action: request.action.kind,
      operation_id: input.operation_id,
      input_sha256: intent.input_sha256,
      configuration_sha256: wantedConfiguration,
      revision: source.revision,
      affected_skill_ids: [request.skill_id],
    }
    if (alreadyOwned && pending === undefined) {
      if (target.state.state !== "ready" || current.state.state !== "ready")
        return yield* Effect.fail(
          fail("CURRENT_OPERATION_PENDING", "A current owner is not ready."),
        )
      if (selected.content.kind === "native") yield* observeSharedBody(selected.page_id)
      else if (selected.content.kind === "resource")
        yield* loadCurrentSharedResourceContent(library, {
          owner: { kind: "skill", page_id: target.page_id },
          content: selected.content,
        })
      const latestSource = yield* queryCurrentSourceManagement(library, input.source_id)
      const latestTarget = (yield* queryCurrentSourceTargets(library, {
        skillIds: [request.skill_id],
      })).get(request.skill_id)
      if (
        latestSource === undefined ||
        !currentSourceManagementMatches(latestSource, current) ||
        latestSource.page_id !== current.page_id ||
        latestSource.state.state !== "ready" ||
        latestTarget === undefined ||
        latestTarget.state.state !== "ready" ||
        canonicalSharedJson(allFiles(latestTarget).map(binding)) !==
          canonicalSharedJson(allFiles(target).map(binding))
      )
        return yield* Effect.fail(
          invalid("The already-owned current file changed during inspection."),
        )
      if (input.dry_run)
        return {
          ...resultBase,
          status: "inspected" as const,
          remote_writes: 0 as const,
          targets: [
            {
              contract: "current",
              skill_id: target.skill_id,
              page_id: target.page_id,
              input_sha256: intent.input_sha256,
              remote_writes: 0,
              replaces_complete_tree: true,
              files: allFiles(target).map((file) => ({
                path: file.path,
                file_id: file.file_id,
                page_id: file.page_id,
                authority: file.content.kind,
                action: "preserve",
              })),
              remove: [],
            },
          ],
        }
      return {
        ...resultBase,
        status: "unchanged" as const,
        state: "ready" as const,
        targets: [
          {
            contract: "current",
            library: resultBase.library,
            skill_id: target.skill_id,
            page_id: target.page_id,
            operation_id: childOperation,
            input_sha256: intent.input_sha256,
            files: allFiles(target).length,
            status: "unchanged",
            state: "ready",
          },
        ],
      }
    }
    const materialized = yield* source.materialize([request.source_path])
    const originalFile = materialized.files.find((file) => file.path === request.source_path)
    if (
      materialized.files.length !== 1 ||
      originalFile === undefined ||
      originalFile.bytes.byteLength !== transfer.selected.bytes ||
      originalFile.mode !== transfer.selected.mode ||
      (yield* sha256(originalFile.bytes)) !== transfer.selected.sha256
    )
      return yield* Effect.fail(
        invalid("The selected Source original differs from the frozen file action."),
      )
    const plan = yield* prepareCurrentSourceFileSkillWrite({
      skill_id: target.skill_id,
      kind: target.kind,
      source: { source_id: source.source_id, revision: source.revision },
      create: { name: "Source file target", description: "Current file authority." },
      transfer,
      files: allFiles(target).map((file) =>
        file.page_id === selected.page_id
          ? {
              kind: "write" as const,
              file: {
                path: file.path,
                file_id: file.file_id,
                bytes: originalFile.bytes,
                mode: originalFile.mode,
                authority:
                  request.action.kind === "takeover"
                    ? { kind: request.action.to }
                    : {
                        kind: "source" as const,
                        source_id: source.source_id,
                        revision: source.revision,
                        source_path: request.source_path,
                      },
              },
            }
          : { kind: "preserve" as const, binding: binding(file) },
      ),
    })
    const inspected = yield* inspectCoordinatedSkillWrite(library, plan, source)
    if (input.dry_run)
      return {
        ...resultBase,
        status: "inspected" as const,
        remote_writes: 0 as const,
        targets: [inspected],
      }
    const wanted = {
      declaration: changed.declaration,
      content: current.content,
      revision: current.revision,
    }
    return yield* applyFileAuthority(library, {
      input,
      intent,
      plan,
      source,
      wanted,
      baseline: current,
      resultBase,
      childOperation,
    })
  }).pipe(
    withCurrentInvocationBudget,
    Effect.map(({ result }) => result),
  )
}

function applyFileAuthority<Result extends object>(
  library: SharedLibrary,
  context: {
    readonly input: CurrentSourceFileAuthorityOptions
    readonly intent: Extract<CurrentOperationIntent, { source_input: unknown }> & {
      readonly source_input: CurrentSourceFileInput
    }
    readonly plan: PreparedCoordinatedSkillWrite
    readonly source: CurrentSharedSource
    readonly wanted: Pick<CurrentSourceManagement, "declaration" | "content" | "revision">
    readonly baseline: CurrentSourceManagement
    readonly resultBase: Result
    readonly childOperation: string
  },
) {
  const { input, intent, plan, source, wanted, baseline, resultBase, childOperation } = context
  const checkSource = (raw: unknown) =>
    checked(() => {
      const row = parseCurrentSourceManagement(library, raw)
      if (row.page_id !== source.page_id || !currentSourceManagementMatches(row, wanted))
        throw invalid("The current Source changed during its file authority intent.")
    })
  return withCurrentOperation(library, {
    intent,
    ownerPageId: source.page_id,
    mode: input.mode,
    run: (session) =>
      Effect.gen(function* () {
        const api = yield* Notion
        const property = yield* checked(() => currentSourceProperty(library, "Contributions"))
        const fields = yield* checked(() => currentSourceWriteProperties(library, wanted))
        yield* session.dispatch({
          key: "source:properties",
          replay: "idempotent",
          request: {
            path: `v1/pages/${source.page_id}`,
            body: { properties: { [property]: fields[property] } },
            options: { method: "PATCH" },
          },
          observe: () =>
            Effect.gen(function* () {
              const raw = yield* api.request(`v1/pages/${source.page_id}`)
              const row = yield* checked(() => parseCurrentSourceManagement(library, raw))
              if (row.page_id !== source.page_id)
                return yield* Effect.fail(invalid("The Source changed physical identity."))
              if (currentSourceManagementMatches(row, wanted))
                return { status: "complete" as const, value: undefined }
              const configuration = yield* sha256(canonicalSharedJson(row.declaration))
              if (
                configuration !== intent.source_input.before_configuration_sha256 ||
                row.revision !== source.revision ||
                (yield* sha256(canonicalSharedJson(row.content))) !==
                  intent.source_input.source_content_sha256
              )
                return yield* Effect.fail(
                  invalid("The Source configuration changed before updating its contribution."),
                )
              return { status: "missing" as const }
            }),
          acknowledge: checkSource,
        })
        const authorization = yield* authorizeCoordinatedSkillWrite(session, {
          plan,
          source,
          assertSourceCurrent: checkSource,
        })
        const child = yield* writeCoordinatedSkill(library, {
          plan,
          operation_id: childOperation,
          mode: typeof input.mode === "object" ? "apply" : input.mode,
          authorization,
        })
        yield* session.markSourceChildComplete(plan.skill_id)
        yield* checkSource(yield* session.assertCurrent())
        return {
          ...resultBase,
          state: "ready" as const,
          status:
            !currentSourceManagementMatches(baseline, wanted) || child.status !== "unchanged"
              ? ("applied" as const)
              : ("unchanged" as const),
          targets: [child],
        }
      }),
    verify: (session) =>
      Effect.gen(function* () {
        yield* checkSource(yield* session.assertCurrent())
        const unique = yield* queryCurrentSourceManagement(library, source.source_id)
        if (
          unique === undefined ||
          unique.page_id !== source.page_id ||
          !currentSourceManagementMatches(unique, wanted)
        )
          return yield* Effect.fail(
            invalid("The Source identity changed before completing its file action."),
          )
        const target = (yield* queryCurrentSourceTargets(library, {
          skillIds: [plan.skill_id],
        })).get(plan.skill_id)
        if (
          target === undefined ||
          target.page_id !== intent.source_input.target.skill_page_id ||
          target.state.state !== "ready" ||
          allFiles(target).length !== plan.files.length
        )
          return yield* Effect.fail(
            invalid("The complete target tree is not ready after the file action."),
          )
        for (const file of plan.files) {
          const actual = allFiles(target).find((entry) => entry.file_id === file.file_id)
          const page =
            file.kind === "preserve" ? file.binding.page_id : intent.source_input.target.page_id
          if (
            actual === undefined ||
            actual.page_id !== page ||
            actual.path !== file.path ||
            canonicalSharedJson(actual.content) !== canonicalSharedJson(file.content)
          )
            return yield* Effect.fail(
              invalid("A current File changed before completing the authority transfer."),
            )
        }
      }),
  })
}
