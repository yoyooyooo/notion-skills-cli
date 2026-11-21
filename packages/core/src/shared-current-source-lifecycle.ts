import { Effect } from "effect"
import { fail, property, SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import {
  currentFileRecord,
  queryCurrentLibraryCensus,
  queryCurrentSkillIndex,
} from "./shared-current-index.ts"
import { currentSourceContributionFiles } from "./shared-current-consumption.ts"
import { withCurrentInvocationBudget } from "./shared-current-invocation.ts"
import {
  readCurrentOperationIntent,
  withCurrentOperation,
  type CurrentOperationIntent,
  type CurrentOperationSession,
  type CurrentWriteMode,
} from "./shared-current-operation.ts"
import { assertCurrentBodyReplaceable } from "./shared-current-projection.ts"
import { listCurrentOwnedResourceRecords } from "./shared-current-records.ts"
import {
  currentSourceOriginContains,
  currentSourceProperty,
  parseCurrentSourceManagement,
  queryCurrentSourceManagement,
  type CurrentSourceManagement,
} from "./shared-current-source-management.ts"
import {
  prepareCurrentSourceManagementSelection,
  validateCurrentSourceId,
  type CurrentSharedSource,
} from "./shared-current-source.ts"
import { retireSourceManifests } from "./shared-current-source-write.ts"
import { currentWriteIdentity } from "./shared-current-write-input.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256 } from "./store.ts"

type Options = {
  readonly source_id: string
  readonly operation_id: string
  readonly mode?: CurrentWriteMode
  readonly dry_run?: boolean
}
type Action = { readonly kind: "enabled"; readonly enabled: boolean } | { readonly kind: "remove" }
const invalid = (message: string, details?: unknown) =>
  fail("CURRENT_SOURCE_LIFECYCLE_CONFLICT", message, details)
const checked = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (error) =>
      error instanceof SkillsError ? error : invalid("Invalid current Source action."),
  })

/** Lifecycle changes must see semantic Content references, including Files whose
 * owner has lost its Origin relation. This is one library, not a workspace scan. */
export function queryCurrentSourceReferences(
  library: SharedLibrary,
  source: Pick<CurrentSourceManagement, "page_id" | "declaration" | "content" | "revision">,
) {
  return Effect.gen(function* () {
    const selection = yield* prepareCurrentSourceManagementSelection(library, {
      source_id: source.declaration.definition.source_id,
      page_id: source.page_id,
      content: source.content,
      revision: source.revision,
    })
    return yield* querySourceReferences(library, source, selection)
  })
}

/** Authority alone establishes the Source scope; bytes and registration are
 * validated for the whole selected Skill below. Unrelated legacy rows are not
 * admitted to current consumption. Unknown nonempty authority cannot prove absence. */
function contentReferencesSource(encoded: string, sourceId: string): boolean {
  if (encoded === "") return false
  let raw: unknown
  try {
    raw = JSON.parse(encoded)
  } catch {
    throw fail("CURRENT_CONTENT_INVALID", "Content must contain one complete JSON descriptor.")
  }
  const content = property(raw)
  switch (content.kind) {
    case "native":
    case "resource":
      // A conflicting explicit binding is still in scope; full decoding rejects it.
      return content.source_id === sourceId
    case "source":
      if (typeof content.source_id === "string")
        return validateCurrentSourceId(content.source_id) === sourceId
      break
  }
  throw fail("CURRENT_CONTENT_INVALID", "Content does not identify an exact current authority.")
}

function querySourceReferences(
  library: SharedLibrary,
  source: Pick<CurrentSourceManagement, "page_id" | "declaration">,
  selection: Pick<CurrentSharedSource, "source_id" | "revision" | "manifest">,
) {
  return Effect.gen(function* () {
    const census = yield* queryCurrentLibraryCensus(library)
    const sourceId = source.declaration.definition.source_id
    const selectedIds = new Set(source.declaration.contributions.map((entry) => entry.skill_id))
    const selectedPages = new Set<string>()
    const originPages = new Set<string>()
    for (const [page, metadata] of census) {
      const origin = yield* currentSourceOriginContains(library, page, metadata.raw, source.page_id)
      if (origin) originPages.add(page)
      const contentReference = yield* checked(() =>
        [metadata, ...metadata.files].some((file) =>
          contentReferencesSource(file.content, sourceId),
        ),
      )
      if (origin || contentReference) {
        selectedPages.add(page)
        if (metadata.skill_id !== "") selectedIds.add(metadata.skill_id)
      }
    }
    const targets: { skill_id: string; skill_page_id: string }[] = []
    const identities = new Set<string>()
    const references: {
      skill_id: string
      skill_page_id: string
      file_id: string
      file_page_id: string
      path: string
    }[] = []
    const origins: { skill_id: string; skill_page_id: string }[] = []
    const contributions: {
      skill_id: string
      skill_page_id: string
      path: string
      source_path: string
    }[] = []
    for (const [page, metadata] of census) {
      if (!selectedIds.has(metadata.skill_id) && !selectedPages.has(page)) continue
      const files = yield* checked(() =>
        metadata.files.map((file) =>
          currentFileRecord(
            file.raw,
            page,
            library.files.data_source_id,
            library.files.property_ids,
          ),
        ),
      )
      const skill = yield* queryCurrentSkillIndex(library, page, metadata.raw, files)
      if (identities.has(skill.skill_id))
        return yield* Effect.fail(
          fail("CURRENT_INDEX_INVALID", "Several current Skills claim the same stable identity.", {
            skill_id: skill.skill_id,
          }),
        )
      identities.add(skill.skill_id)
      targets.push({ skill_id: skill.skill_id, skill_page_id: skill.page_id })
      const owned = new Set(
        [skill.main, ...skill.files]
          .filter((file) => file.content.kind !== "source")
          .map((file) => file.path),
      )
      const complete = yield* checked(() =>
        currentSourceContributionFiles(skill.skill_id, source.declaration.contributions, selection),
      )
      for (const file of complete)
        if (!owned.has(file.path))
          contributions.push({
            skill_id: skill.skill_id,
            skill_page_id: skill.page_id,
            path: file.path,
            source_path: file.content.source_path,
          })
      for (const file of [skill.main, ...skill.files])
        if (file.content.kind === "source" && file.content.source_id === sourceId) {
          references.push({
            skill_id: skill.skill_id,
            skill_page_id: skill.page_id,
            file_id: file.file_id,
            file_page_id: file.page_id,
            path: file.path,
          })
        }
      if (originPages.has(page))
        origins.push({ skill_id: skill.skill_id, skill_page_id: skill.page_id })
    }
    targets.sort((a, b) => a.skill_id.localeCompare(b.skill_id, "en"))
    return { references, contributions, origins, targets }
  })
}
type References = Effect.Success<ReturnType<typeof queryCurrentSourceReferences>>
function requireUnreferenced(value: References, sourceId: string) {
  if (value.references.length || value.contributions.length || value.origins.length)
    throw fail(
      "CURRENT_SOURCE_REFERENCED",
      "The Source still supplies current consumption paths or has File or Origin references.",
      {
        source_id: sourceId,
        files: value.references,
        contributions: value.contributions,
        origins: value.origins,
        next: value.references.length
          ? "takeover_source_files"
          : value.contributions.length
            ? "correct_current_contributions"
            : "correct_current_origin",
        required_input:
          "Remove effective Source contributions or take over their files, and clear stale Origin links before removing this Source.",
      },
    )
}

function validateOptions(input: Options, action: Action) {
  validateCurrentSourceId(input.source_id)
  currentWriteIdentity(input.operation_id, "Operation ID")
  if (action.kind === "enabled" && typeof action.enabled !== "boolean")
    throw invalid("Source enabled must be a boolean.")
  if (typeof input.mode === "object") {
    if (input.mode.kind !== "supersede") throw invalid("Use an explicit current write mode.")
    currentWriteIdentity(input.mode.operation_id, "Previous Operation ID")
    if (input.mode.operation_id === input.operation_id)
      throw invalid("A successor needs a different Operation ID.")
  } else if (input.mode !== undefined && input.mode !== "apply" && input.mode !== "resume")
    throw invalid("Use apply, resume or explicit supersede.")
  if (input.dry_run && input.mode !== undefined && input.mode !== "apply")
    throw invalid("Dry run cannot resume or replace an unfinished intent.")
}

function execute(library: SharedLibrary, supplied: Options, action: Action) {
  return Effect.gen(function* () {
    yield* checked(() => validateOptions(supplied, action))
    const pending = yield* readCurrentOperationIntent(library, {
      kind: "source",
      id: supplied.source_id,
    })
    const input: Options =
      typeof supplied.mode === "object" &&
      pending?.intent.operation_id === supplied.operation_id &&
      pending.predecessor?.intent.operation_id === supplied.mode.operation_id
        ? { ...supplied, mode: "resume" }
        : supplied
    const previous = pending?.intent
    if (previous !== undefined) {
      const selected = typeof input.mode === "object" ? input.mode.operation_id : input.operation_id
      if (
        !("source_input" in previous) ||
        previous.source_input.kind !== action.kind ||
        input.mode === undefined ||
        input.mode === "apply" ||
        input.dry_run ||
        previous.operation_id !== selected
      )
        return yield* Effect.fail(
          fail(
            "CURRENT_OPERATION_PENDING",
            "Resume or explicitly replace the original Source action.",
            {
              operation_id: previous.operation_id,
              owner: previous.owner,
              action: "source_input" in previous ? previous.source_input.kind : "skill",
              next: "resume_original_source_action",
            },
          ),
        )
    } else if (input.mode !== undefined && input.mode !== "apply")
      return yield* Effect.fail(
        fail("CURRENT_OPERATION_NOT_FOUND", "No unfinished Source action was found."),
      )

    let current = yield* queryCurrentSourceManagement(library, input.source_id)
    // Only a matching remove resume may inspect its exact already-trashed owner.
    // The kernel independently proves that its terminal action caused retirement.
    if (
      current === undefined &&
      action.kind === "remove" &&
      input.mode === "resume" &&
      pending?.owner_page_id &&
      previous &&
      "source_input" in previous &&
      previous.source_input.kind === "remove"
    ) {
      const raw = property(yield* (yield* Notion).request(`v1/pages/${pending.owner_page_id}`))
      if (raw.in_trash !== true && raw.archived !== true)
        return yield* Effect.fail(invalid("The missing Source is not its exact retired owner."))
      current = yield* checked(() =>
        parseCurrentSourceManagement(library, { ...raw, in_trash: false, archived: false }),
      )
    }
    if (current === undefined)
      return yield* Effect.fail(
        fail("CURRENT_SOURCE_NOT_FOUND", "The exact current Source does not exist.", {
          source_id: input.source_id,
        }),
      )
    const selected = current
    if (previous === undefined && selected.state.state !== "ready")
      return yield* Effect.fail(
        fail(
          "CURRENT_OPERATION_UNRESOLVED",
          "The unfinished Source has no observable current intent.",
          {
            source_id: input.source_id,
            source_page_id: selected.page_id,
            operation_id: selected.state.operation_id,
            next: "inspect_current_operation",
          },
        ),
      )
    const desiredDeclaration = (row: CurrentSourceManagement) =>
      action.kind === "enabled"
        ? {
            ...row.declaration,
            definition: { ...row.declaration.definition, enabled: action.enabled },
          }
        : row.declaration
    const configuration = yield* sha256(canonicalSharedJson(desiredDeclaration(selected)))
    const selection = yield* prepareCurrentSourceManagementSelection(library, {
      source_id: input.source_id,
      page_id: selected.page_id,
      content: selected.content,
      revision: selected.revision,
    })
    const references = yield* querySourceReferences(library, selected, selection)
    if (action.kind === "remove")
      yield* checked(() => requireUnreferenced(references, input.source_id))
    const affected = references.targets.map((target) => target.skill_id)
    const common = {
      configuration_sha256: configuration,
      affected_skill_ids: affected,
      source_page_id: selected.page_id,
      revision: selected.revision,
    }
    const source_input =
      action.kind === "enabled"
        ? { kind: "enabled" as const, ...common, enabled: action.enabled }
        : { kind: "remove" as const, ...common }
    const intent = {
      operation_id: input.operation_id,
      owner: { kind: "source" as const, id: input.source_id },
      source_input,
      input_sha256: yield* sha256(canonicalSharedJson(source_input)),
    } satisfies CurrentOperationIntent
    if (input.mode === "resume" && canonicalSharedJson(intent) !== canonicalSharedJson(previous))
      return yield* Effect.fail(
        invalid("The current Source or affected scope differs from the unfinished action."),
      )
    const base = {
      version: 1 as const,
      contract: "current" as const,
      action: action.kind,
      ...(action.kind === "enabled" ? { enabled: action.enabled } : {}),
      library: {
        library_id: library.library_id,
        database_id: library.skills.database_id,
        data_source_id: library.skills.data_source_id,
      },
      sources_data_source_id: library.sources.data_source_id,
      source_id: input.source_id,
      source_page_id: selected.page_id,
      operation_id: input.operation_id,
      input_sha256: intent.input_sha256,
      configuration_sha256: configuration,
      revision: selected.revision,
      affected_skill_ids: affected,
      targets: references.targets,
    }
    if (input.dry_run) return { ...base, status: "inspected" as const, remote_writes: 0 as const }
    const checkSelected = (raw: unknown, retired = false) =>
      Effect.gen(function* () {
        const page = property(raw)
        const row = yield* checked(() =>
          parseCurrentSourceManagement(
            library,
            retired ? { ...page, in_trash: false, archived: false } : page,
          ),
        )
        if (
          row.page_id !== selected.page_id ||
          row.revision !== selected.revision ||
          row.declaration.definition.source_id !== input.source_id ||
          (yield* sha256(canonicalSharedJson(desiredDeclaration(row)))) !== configuration
        )
          return yield* Effect.fail(invalid("The Source changed after action inspection."))
        return row
      })
    const checkScope = () =>
      Effect.gen(function* () {
        const actual = yield* querySourceReferences(library, selected, selection)
        if (canonicalSharedJson(actual.targets) !== canonicalSharedJson(references.targets))
          return yield* Effect.fail(invalid("The affected Source scope changed before completion."))
        if (action.kind === "remove")
          yield* checked(() => requireUnreferenced(actual, input.source_id))
      })
    const verify = (session: CurrentOperationSession) =>
      Effect.gen(function* () {
        const row = yield* checkSelected(yield* session.assertCurrent(), session.ownerRetired)
        if (action.kind === "enabled" && row.declaration.definition.enabled !== action.enabled)
          return yield* Effect.fail(invalid("The Source enabled value was not confirmed."))
        const unique = yield* queryCurrentSourceManagement(library, input.source_id)
        if (session.ownerRetired ? unique !== undefined : unique?.page_id !== selected.page_id)
          return yield* Effect.fail(
            invalid("The stable Source identity changed before completion."),
          )
        yield* checkScope()
        if (
          action.kind === "remove" &&
          (yield* listCurrentOwnedResourceRecords(library, {
            kind: "source",
            page_id: selected.page_id,
          })).length !== 0
        )
          return yield* Effect.fail(invalid("Source-owned resources remain before retirement."))
      })
    const result = () =>
      action.kind === "remove"
        ? { ...base, state: "removed" as const, status: "removed" as const }
        : {
            ...base,
            state: "ready" as const,
            status:
              selected.declaration.definition.enabled !== action.enabled || previous !== undefined
                ? ("applied" as const)
                : ("unchanged" as const),
          }
    return yield* withCurrentOperation(library, {
      intent,
      ownerPageId: selected.page_id,
      mode: input.mode,
      completion: action.kind === "remove" ? "retired" : "ready",
      run: (session) =>
        Effect.gen(function* () {
          if (session.ownerRetired) return result()
          // Metadata actions have no child writes. Complete their frozen read scope
          // in memory before activation, so one Source toggle does not write N cursors.
          for (const skillId of affected.slice(session.sourceProgress?.next_index ?? 0))
            yield* session.markSourceChildComplete(skillId)
          const assertSelected = Effect.gen(function* () {
            yield* checkSelected(yield* session.assertCurrent())
            if (action.kind === "remove") yield* checkScope()
          })
          if (action.kind === "remove") {
            yield* checkScope()
            yield* assertCurrentBodyReplaceable(selected.page_id)
            yield* session.activate()
            yield* retireSourceManifests(library, session, null, assertSelected)
          } else {
            const api = yield* Notion
            yield* session.dispatch({
              key: "source:enabled",
              replay: "idempotent",
              request: {
                path: `v1/pages/${selected.page_id}`,
                body: {
                  properties: {
                    [currentSourceProperty(library, "Enabled")]: { checkbox: action.enabled },
                  },
                },
                options: { method: "PATCH" },
              },
              observe: () =>
                Effect.gen(function* () {
                  const row = yield* checkSelected(
                    yield* api.request(`v1/pages/${selected.page_id}`),
                  )
                  if (row.declaration.definition.enabled === action.enabled)
                    return { status: "complete" as const, value: undefined }
                  yield* checkScope()
                  return { status: "missing" as const }
                }),
              acknowledge: (raw) =>
                Effect.gen(function* () {
                  if ((yield* checkSelected(raw)).declaration.definition.enabled !== action.enabled)
                    return yield* Effect.fail(
                      fail("WRITE_OUTCOME_UNKNOWN", "Source enabled change was not confirmed."),
                    )
                }),
            })
          }
          return result()
        }),
      verify: (session) => verify(session),
      verifyCompletedResume: (session) =>
        Effect.gen(function* () {
          yield* verify(session)
          return result()
        }),
    })
  }).pipe(
    withCurrentInvocationBudget,
    Effect.map(({ result }) => result),
  )
}

export function changeCurrentSourceEnabled(
  library: SharedLibrary,
  input: Options & { readonly enabled: boolean },
) {
  return execute(library, input, { kind: "enabled", enabled: input.enabled })
}
export function removeCurrentSource(library: SharedLibrary, input: Options) {
  return execute(library, input, { kind: "remove" })
}
