import { posix } from "node:path"
import { Crypto, Effect, Schema } from "effect"
import { authScope } from "./catalog.ts"
import { invalidateSnapshotCache, invalidateCurrentLibraryCatalog } from "./cache.ts"
import {
  ContentKindSchema,
  decode,
  entrypointFor,
  fail,
  listSchema,
  property,
  SkillsError,
  text,
  validateDescription,
  validateDisplayName,
} from "./model.ts"
import { Notion } from "./notion.ts"
import { pageId } from "./ref.ts"
import { withCurrentInvocationBudget } from "./shared-current-invocation.ts"
import { sharedRecordFromPage, sharedSkillId, sharedSkillTextProperty } from "./shared-content.ts"
import {
  currentFileRecord,
  queryCurrentSkillIndex,
  type CurrentFileBinding,
  type CurrentSkillIndex,
} from "./shared-current-index.ts"
import {
  currentOperationFailure,
  currentOperationOwnerState,
  withCurrentOperation,
  type CurrentOperationSession,
  type CurrentSourceIntentBinding,
} from "./shared-current-operation.ts"
import {
  applyCurrentProjection,
  assertCurrentBodyReplaceable,
  isCurrentProjectionBinary,
  inspectCurrentProjection,
  renderCurrentProjection,
} from "./shared-current-projection.ts"
import {
  currentOwnedResourceCreateRequest,
  currentOwnedResourceFromPage,
  currentRecordText,
  listCurrentOwnedResourceRecords,
  queryCurrentOwnedResourceRecord,
} from "./shared-current-records.ts"
import {
  loadCurrentSharedResourceContent,
  validateCurrentSharedResourceManifest,
} from "./shared-current-resource.ts"
import {
  resolveCurrentSharedSources,
  validateCurrentSourceId,
  type CurrentSharedSource,
} from "./shared-current-source.ts"
import { decodeCurrentFileContent } from "./shared-current-file.ts"
import { planSharedFiles } from "./shared-composition.ts"
import { assertSelectedSharedFileReferences } from "./shared-file-references.ts"
import {
  applyCurrentRelations,
  currentRelationsInfo,
  prepareCurrentRelations,
  verifyCurrentRelations,
} from "./shared-current-relations.ts"
import {
  currentUploadActionPrefix,
  currentUploadFileSpec,
  makeCurrentUploadScope,
  uploadCurrentSharedResource,
} from "./shared-current-upload.ts"
import {
  copyValidatedCurrentSkillWrite,
  copyValidatedCurrentWriteFile,
  currentWriteFileFingerprint,
  prepareCurrentWriteFile,
  type CurrentSkillWriteInput,
  type CurrentWriteAuthority,
  currentWriteIdentity,
  type PreparedCurrentSkillWrite,
  type PreparedCurrentWriteFile,
} from "./shared-current-write-input.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { observeSharedBody } from "./shared-page-body.ts"
import {
  compileSharedNativeReferences,
  type NativeReferenceSource,
} from "./shared-native-references.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256, Store } from "./store.ts"

export { prepareCurrentSkillWrite } from "./shared-current-write-input.ts"
export type {
  CurrentSkillWriteInput,
  PreparedCurrentSkillWrite,
} from "./shared-current-write-input.ts"
const invalid = (message: string, details?: unknown) =>
  fail("CURRENT_WRITE_CONFLICT", message, details)
const checked = <A>(read: () => A) =>
  Effect.try({
    try: read,
    catch: (error) =>
      error instanceof SkillsError ? error : invalid("The current write boundary is invalid."),
  })
function exactId(input: unknown): string {
  if (
    typeof input !== "string" ||
    !/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/iu.test(input)
  )
    throw invalid("Use an exact physical page identity.")
  const id = pageId(input)
  if (!id) throw invalid("Use an exact physical page identity.")
  return id
}
function binding(library: SharedLibrary, table: "skills" | "files", name: string): string {
  const id = library[table].property_ids[name]
  if (!id)
    throw fail(
      "CURRENT_SCHEMA_REQUIRED",
      "The current writer requires its registered table property.",
      { table, missing: name },
    )
  return id
}
function livePage(raw: unknown, id: string, table: string): void {
  const row = property(raw),
    parent = property(row.parent)
  if (
    row.object !== "page" ||
    exactId(row.id) !== id ||
    row.in_trash === true ||
    row.archived === true ||
    parent.type !== "data_source_id" ||
    exactId(parent.data_source_id) !== table
  )
    throw invalid("The selected page is unavailable or belongs to another table.", { page_id: id })
}
function fieldsMatch(raw: unknown, desired: Readonly<Record<string, unknown>>): boolean {
  const actual = Object.entries(property(property(raw).properties))
  for (const [id, wantedRaw] of Object.entries(desired)) {
    const matches = actual.flatMap(([key, value]) =>
      key === id || property(value).id === id ? [property(value)] : [],
    )
    const selected = matches[0],
      wanted = property(wantedRaw)
    if (matches.length !== 1 || selected === undefined || selected.has_more === true)
      throw invalid("A current property is missing, repeated or incomplete.", { property_id: id })
    if ("rich_text" in wanted || "title" in wanted) {
      const kind = "title" in wanted ? "title" : "rich_text"
      if (
        selected.type !== kind ||
        !Array.isArray(selected[kind]) ||
        text(selected[kind]) !== text(wanted[kind])
      )
        return false
    } else if ("select" in wanted) {
      if (
        selected.type !== "select" ||
        property(selected.select).name !== property(wanted.select).name
      )
        return false
    } else if ("checkbox" in wanted) {
      if (selected.type !== "checkbox" || selected.checkbox !== wanted.checkbox) return false
    } else if ("relation" in wanted) {
      if (
        selected.type !== "relation" ||
        !Array.isArray(selected.relation) ||
        !Array.isArray(wanted.relation)
      )
        throw invalid("A current relation is incomplete.")
      const a = selected.relation.map((row) => exactId(property(row).id)).sort(),
        b = wanted.relation.map((row) => exactId(property(row).id)).sort()
      if (new Set(a).size !== a.length || canonicalSharedJson(a) !== canonicalSharedJson(b))
        return false
    } else throw invalid("The writer received an unsupported property operation.")
  }
  return true
}
function queryPages(table: string, filter: unknown, ids?: readonly string[]) {
  return Effect.gen(function* () {
    const api = yield* Notion,
      params = new URLSearchParams()
    for (const id of ids ?? []) params.append("filter_properties", id)
    const rows: unknown[] = [],
      seen = new Set<string>(),
      cursors = new Set<string>()
    let cursor: string | undefined
    for (;;) {
      const raw = yield* api.request(
        `v1/data_sources/${table}/query${ids?.length ? "?" + params : ""}`,
        { page_size: 100, filter, ...(cursor === undefined ? {} : { start_cursor: cursor }) },
        { method: "POST" },
      )
      const result = yield* checked(() => {
        const outer = property(raw)
        if (
          outer.object !== "list" ||
          (outer.request_status !== undefined && property(outer.request_status).type !== "complete")
        )
          throw invalid("The current inventory is incomplete.")
        const list = Schema.decodeUnknownSync(listSchema(Schema.Unknown))(raw)
        if (
          list.has_more
            ? !list.next_cursor || cursors.has(list.next_cursor)
            : list.next_cursor !== null
        )
          throw invalid("The current inventory did not finish or advance.")
        for (const row of list.results) {
          const id = exactId(property(row).id)
          livePage(row, id, table)
          if (seen.has(id)) throw invalid("The current inventory repeats a physical page.")
          seen.add(id)
        }
        return list
      })
      rows.push(...result.results)
      if (!result.has_more) return rows
      cursor = result.next_cursor!
      cursors.add(cursor)
    }
  })
}
function queryOwner(library: SharedLibrary, skillId: string) {
  return Effect.gen(function* () {
    const rows = yield* queryPages(library.skills.data_source_id, {
      property: binding(library, "skills", "Skill ID"),
      rich_text: { equals: skillId },
    })
    if (rows.length > 1)
      return yield* Effect.fail(
        invalid("The stable Skill ID belongs to several physical pages.", { skill_id: skillId }),
      )
    const row = rows[0]
    if (row !== undefined)
      yield* checked(() => {
        if (sharedSkillTextProperty(row, library, "Skill ID") !== skillId)
          throw invalid("The Skill query returned a foreign logical identity.")
      })
    return row
  })
}
function queryFilePages(library: SharedLibrary, owner: string) {
  return Effect.gen(function* () {
    const rows = yield* queryPages(
      library.files.data_source_id,
      { property: binding(library, "files", "Skill"), relation: { contains: owner } },
      ["Name", "File ID", "Path", "Content", "Skill"].map((name) =>
        binding(library, "files", name),
      ),
    )
    return yield* checked(
      () =>
        new Map(
          rows.map((raw) => {
            const file = currentFileRecord(
              raw,
              owner,
              library.files.data_source_id,
              library.files.property_ids,
            )
            return [file.page_id, { raw, file }] as const
          }),
        ),
    )
  })
}
function loadCurrentTarget(library: SharedLibrary, raw: unknown) {
  return Effect.gen(function* () {
    if (raw === undefined) return undefined
    const page = yield* checked(() => exactId(property(raw).id)),
      files = yield* queryFilePages(library, page)
    const index = yield* queryCurrentSkillIndex(
      library,
      page,
      raw,
      [...files.values()].map((row) => row.file),
    )
    return { raw, files, index }
  })
}
type Target = Exclude<Effect.Success<ReturnType<typeof loadCurrentTarget>>, undefined>
type PreservedBinding = Pick<
  CurrentFileBinding,
  "file_id" | "page_id" | "skill_page_id" | "path" | "content"
>
type PreparedPreservedFile = {
  readonly kind: "preserve"
  readonly path: string
  readonly file_id: string
  readonly content: CurrentFileBinding["content"]
  readonly binding: PreservedBinding
}
type SourceWriteFile = Extract<PreparedCurrentWriteFile, { kind: "source" }>
export type PreparedCoordinatedSkillWrite = {
  readonly contract: "source-coordinated"
  readonly skill_id: string
  readonly kind: CurrentSkillWriteInput["kind"]
  readonly name: string
  readonly description: string
  readonly enabled?: boolean
  readonly default_context?: boolean
  readonly relations?: never
  readonly source: { readonly source_id: string; readonly revision: string }
  readonly main: string
  readonly files: readonly (SourceWriteFile | PreparedPreservedFile)[]
  readonly input_sha256: string
}
type CurrentWritePlan = PreparedCurrentSkillWrite | PreparedCoordinatedSkillWrite
type CurrentPlanFile = PreparedCurrentWriteFile | PreparedPreservedFile
const isCoordinated = (plan: CurrentWritePlan): plan is PreparedCoordinatedSkillWrite =>
  "source" in plan
function preservedBinding(binding: PreservedBinding): PreservedBinding {
  return {
    file_id: currentWriteIdentity(binding.file_id, "File ID"),
    page_id: exactId(binding.page_id),
    skill_page_id: exactId(binding.skill_page_id),
    path: binding.path,
    content: decodeCurrentFileContent(structuredClone(binding.content)),
  }
}
function coordinatedFingerprint(plan: Omit<PreparedCoordinatedSkillWrite, "input_sha256">) {
  return {
    contract: plan.contract,
    skill_id: plan.skill_id,
    kind: plan.kind,
    source: plan.source,
    create: {
      name: plan.name,
      description: plan.description,
      enabled: plan.enabled ?? true,
      default_context: plan.default_context ?? false,
    },
    files: plan.files.map((file) =>
      file.kind === "preserve"
        ? { kind: "preserve", binding: file.binding }
        : { kind: "write", file: currentWriteFileFingerprint(file) },
    ),
  }
}
function validateCoordinatedTree(plan: Omit<PreparedCoordinatedSkillWrite, "input_sha256">) {
  currentWriteIdentity(plan.skill_id, "Skill ID")
  validateCurrentSourceId(plan.source.source_id)
  if (!/^[a-f0-9]{64}$/u.test(plan.source.revision))
    throw invalid("Use the exact current Source revision.")
  if (decode(ContentKindSchema, plan.kind) !== plan.kind || plan.main !== entrypointFor(plan.kind))
    throw invalid("Use the canonical current entrypoint.")
  validateDisplayName(plan.name)
  validateDescription(plan.description)
  if (
    (plan.enabled !== undefined && typeof plan.enabled !== "boolean") ||
    (plan.default_context !== undefined && typeof plan.default_context !== "boolean")
  )
    throw invalid("New target defaults must be boolean values.")
  planSharedFiles({ base: plan.files, mounts: [], overrides: [], entrypoint: plan.main })
  const ids = new Set<string>(),
    pages = new Set<string>()
  let totalBytes = 0
  for (const file of plan.files) {
    const id = currentWriteIdentity(file.file_id!, "File ID")
    if (ids.has(id)) throw invalid("A coordinated tree repeats a stable File ID.")
    ids.add(id)
    if (file.kind === "preserve") {
      if (
        file.path !== file.binding.path ||
        file.file_id !== file.binding.file_id ||
        canonicalSharedJson(file.content) !== canonicalSharedJson(file.binding.content)
      )
        throw invalid("The preserved File locator changed.")
      if (pages.has(file.binding.page_id))
        throw invalid("A coordinated tree repeats a preserved physical page.")
      pages.add(file.binding.page_id)
      if (file.content.kind === "source" && file.content.source_id === plan.source.source_id)
        throw invalid(
          "This Source must declare its complete managed contribution, rather than preserve its previous revision.",
        )
    } else {
      if (
        file.kind !== "source" ||
        file.content.source_id !== plan.source.source_id ||
        file.content.revision !== plan.source.revision
      )
        throw invalid("A coordinated write may change only this Source contribution.")
      totalBytes += file.bytes.byteLength
    }
  }
  if (totalBytes > 128 * 1024 * 1024)
    throw invalid("One coordinated target exceeds 128 MiB of selected bytes.")
  assertSelectedSharedFileReferences(
    plan.files.filter((file) => file.kind !== "preserve"),
    plan.files.map((file) => file.path),
  )
}
/** The complete directory is frozen; preserved bodies are references, never old content snapshots. */
export function prepareCoordinatedSkillWrite(input: {
  readonly skill_id: string
  readonly kind: CurrentSkillWriteInput["kind"]
  readonly source: PreparedCoordinatedSkillWrite["source"]
  readonly create: Pick<
    CurrentSkillWriteInput,
    "name" | "description" | "enabled" | "default_context"
  >
  readonly files: readonly (
    | {
        readonly kind: "write"
        readonly file: CurrentSkillWriteInput["files"][number] & {
          readonly file_id: string
          readonly authority: Extract<CurrentWriteAuthority, { kind: "source" }>
        }
      }
    | { readonly kind: "preserve"; readonly binding: PreservedBinding }
  )[]
}) {
  return Effect.gen(function* () {
    const files: (SourceWriteFile | PreparedPreservedFile)[] = []
    for (const item of input.files) {
      if (item.kind === "preserve") {
        const binding = yield* checked(() => preservedBinding(item.binding))
        files.push({
          kind: "preserve",
          path: binding.path,
          file_id: binding.file_id,
          content: binding.content,
          binding,
        })
      } else {
        const file = yield* prepareCurrentWriteFile(item.file)
        if (file.kind !== "source")
          return yield* Effect.fail(
            invalid("Only declared Source bytes enter a coordinated write."),
          )
        files.push(file)
      }
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    const plan = {
      contract: "source-coordinated" as const,
      skill_id: input.skill_id,
      kind: input.kind,
      name: input.create.name,
      description: input.create.description,
      ...(input.create.enabled === undefined ? {} : { enabled: input.create.enabled }),
      ...(input.create.default_context === undefined
        ? {}
        : { default_context: input.create.default_context }),
      source: { ...input.source },
      main: entrypointFor(input.kind),
      files,
    }
    yield* checked(() => validateCoordinatedTree(plan))
    return {
      ...plan,
      input_sha256: yield* sha256(canonicalSharedJson(coordinatedFingerprint(plan))),
    }
  })
}
function copyCoordinatedPlan(input: PreparedCoordinatedSkillWrite) {
  return Effect.gen(function* () {
    const snapshot = yield* checked(() => structuredClone(input))
    const files: (SourceWriteFile | PreparedPreservedFile)[] = []
    for (const selected of snapshot.files) {
      if (selected.kind === "preserve") {
        const binding = yield* checked(() => preservedBinding(selected.binding))
        files.push({ ...selected, binding, content: decodeCurrentFileContent(selected.content) })
      } else {
        const file = yield* copyValidatedCurrentWriteFile(selected)
        if (file.kind !== "source")
          return yield* Effect.fail(invalid("Only Source bytes may be changed by this intent."))
        files.push(file)
      }
    }
    const plan = { ...snapshot, files }
    yield* checked(() => validateCoordinatedTree(plan))
    if ((yield* sha256(canonicalSharedJson(coordinatedFingerprint(plan)))) !== input.input_sha256)
      return yield* Effect.fail(
        invalid("The prepared coordinated input changed. Resupply its original selected input."),
      )
    return plan
  })
}
type SourceSelection = Pick<CurrentSharedSource, "source_id" | "revision" | "manifest">
function assertSourceFiles(plan: CurrentWritePlan, source: SourceSelection) {
  if (
    isCoordinated(plan) &&
    (plan.source.source_id !== source.source_id || plan.source.revision !== source.revision)
  )
    throw invalid("The coordinated target belongs to another Source input.")
  for (const file of plan.files) {
    if (file.kind !== "source" || file.content.source_id !== source.source_id) continue
    const declared = source.manifest.filter((entry) => entry.path === file.content.source_path)
    if (
      declared.length !== 1 ||
      declared[0]!.sha256 !== file.sha256 ||
      declared[0]!.bytes !== file.bytes.byteLength ||
      declared[0]!.mode !== file.mode ||
      file.content.revision !== source.revision
    )
      throw invalid("Supplied Source bytes differ from its complete current manifest.", {
        path: file.path,
      })
  }
}
const sourceAuthorization = Symbol("current Source target authorization")
const sourceAuthorizations = new WeakSet<object>()
export type CurrentSourceSkillAuthorization = {
  readonly [sourceAuthorization]: true
  readonly source: Pick<CurrentSharedSource, "source_id" | "page_id" | "revision" | "manifest">
  readonly source_intent: CurrentSourceIntentBinding
  readonly skill_id: string
  readonly input_sha256: string
  readonly assertCurrent: Effect.Effect<void, SkillsError, Notion | Crypto.Crypto | Store>
  readonly activate: Effect.Effect<void, SkillsError, Notion | Crypto.Crypto | Store>
  readonly afterActivate: Effect.Effect<void, SkillsError, Notion | Crypto.Crypto | Store>
  readonly unstarted: boolean
}
export function authorizeCoordinatedSkillWrite(
  session: CurrentOperationSession,
  input: {
    readonly plan: PreparedCoordinatedSkillWrite
    readonly source: CurrentSourceSkillAuthorization["source"]
    readonly assertSourceCurrent: (
      observedOwner: unknown,
    ) => Effect.Effect<void, SkillsError, Notion | Crypto.Crypto | Store>
  },
) {
  return Effect.gen(function* () {
    const plan = yield* copyCoordinatedPlan(input.plan),
      selected = structuredClone(input.source)
    const source = Object.freeze({
      ...selected,
      manifest: Object.freeze(selected.manifest.map((file) => Object.freeze(file))),
    })
    yield* checked(() => {
      assertSourceFiles(plan, source)
      if (
        session.owner.kind !== "source" ||
        session.owner.id !== source.source_id ||
        session.ownerPageId !== exactId(source.page_id) ||
        !("source_input" in session.intent) ||
        !session.intent.source_input.affected_skill_ids.includes(plan.skill_id)
      )
        throw invalid("The parent Source intent does not authorize this exact target.")
    })
    const childIndex =
      "source_input" in session.intent
        ? session.intent.source_input.affected_skill_ids.indexOf(plan.skill_id)
        : -1
    const assertCurrent = Effect.gen(function* () {
      if (
        session.sourceProgress === undefined ||
        childIndex < 0 ||
        childIndex > session.sourceProgress.next_index
      )
        return yield* Effect.fail(invalid("The target is outside the current Source cursor."))
      if (session.pendingActionKey !== undefined)
        return yield* Effect.fail(
          fail(
            "CURRENT_OPERATION_PENDING",
            "Resolve the parent Source action before entering a child target.",
            { pending_action: session.pendingActionKey },
          ),
        )
      const raw = yield* session.assertCurrent()
      yield* input.assertSourceCurrent(raw)
    })
    yield* assertCurrent
    const source_intent = Object.freeze({
      source_id: source.source_id,
      source_page_id: source.page_id,
      operation_id: session.operation_id,
      input_sha256: session.intent.input_sha256,
      authorization_sha256: yield* sha256(
        canonicalSharedJson({
          parent: session.intent,
          page_id: source.page_id,
          skill_id: plan.skill_id,
          input_sha256: plan.input_sha256,
        }),
      ),
    })
    const grant: CurrentSourceSkillAuthorization = Object.freeze({
      [sourceAuthorization]: true as const,
      source,
      source_intent,
      skill_id: plan.skill_id,
      input_sha256: plan.input_sha256,
      assertCurrent,
      unstarted:
        session.sourceProgress?.next_index === childIndex && !session.sourceProgress.child_started,
      activate: Effect.gen(function* () {
        yield* assertCurrent
        if (session.sourceProgress?.next_index !== childIndex)
          return yield* Effect.fail(
            invalid("A completed Source target cannot start another child write."),
          )
        yield* session.activate()
        yield* assertCurrent
      }),
      afterActivate: Effect.gen(function* () {
        yield* assertCurrent
        yield* session.markSourceChildStarted(plan.skill_id)
      }),
    })
    sourceAuthorizations.add(grant)
    return grant
  })
}
type ResolvedFile = {
  readonly input: CurrentPlanFile
  readonly file_id: string
  readonly page_id?: string
}
type UploadHandle = Effect.Success<ReturnType<typeof uploadCurrentSharedResource>>
function resolveFiles(plan: CurrentWritePlan, current?: Target) {
  return Effect.gen(function* () {
    const before = current === undefined ? [] : [current.index.main, ...current.index.files]
    const selected: ResolvedFile[] = [],
      ids = new Set<string>(),
      pages = new Set<string>()
    for (const file of plan.files) {
      const old =
        file.kind === "preserve"
          ? before.find((row) => row.page_id === file.binding.page_id)
          : file.path === plan.main
            ? current?.index.main
            : file.file_id === undefined
              ? before.find(
                  (row) => row.path === file.path && row.page_id !== current?.index.page_id,
                )
              : before.find(
                  (row) => row.file_id === file.file_id && row.page_id !== current?.index.page_id,
                )
      if (file.kind === "preserve")
        yield* checked(() => {
          if (
            old === undefined ||
            canonicalSharedJson(preservedBinding(old)) !== canonicalSharedJson(file.binding)
          )
            throw invalid("A preserved File identity, path or authority changed.", {
              file_id: file.file_id,
              path: file.path,
            })
        })
      if (
        isCoordinated(plan) &&
        file.kind !== "preserve" &&
        old !== undefined &&
        !(old.content.kind === "source" && old.content.source_id === plan.source.source_id)
      )
        return yield* Effect.fail(
          invalid("A Source cannot overwrite an unmanaged current File.", {
            path: file.path,
            file_id: old.file_id,
          }),
        )
      const id =
        file.file_id ??
        old?.file_id ??
        "file-" + (yield* sha256(canonicalSharedJson([plan.skill_id, file.path])))
      yield* checked(() => {
        if (
          old !== undefined &&
          file.file_id !== undefined &&
          old.file_id !== file.file_id &&
          old.content.kind !== "source"
        )
          throw invalid("The main File ID cannot silently change.")
        if (ids.has(id) || (old !== undefined && pages.has(old.page_id)))
          throw invalid("A desired tree selects the same current File twice.")
        if (current?.index.main.file_id === id && file.path !== plan.main)
          throw invalid("The main File ID cannot be reassigned to a supporting row.")
      })
      ids.add(id)
      if (old !== undefined) pages.add(old.page_id)
      selected.push({
        input: file,
        file_id: id,
        ...(old === undefined ? {} : { page_id: old.page_id }),
      })
    }
    const retained = new Map(selected.map((file) => [file.page_id, file]))
    for (const previous of before) {
      if (isCoordinated(plan)) {
        if (
          previous.content.kind === "source" &&
          previous.content.source_id === plan.source.source_id
        )
          continue
        if (retained.get(previous.page_id)?.input.kind !== "preserve")
          return yield* Effect.fail(
            invalid("The complete coordinated tree must preserve every unmanaged File.", {
              file_id: previous.file_id,
              path: previous.path,
            }),
          )
        continue
      }
      if (previous.content.kind !== "source") continue
      const desired = retained.get(previous.page_id)
      const reason =
        desired === undefined || desired.file_id !== previous.file_id
          ? "file_removed_or_reidentified"
          : desired.input.path !== previous.path
            ? "path_changed"
            : desired.input.kind !== "source"
              ? "authority_changed"
              : desired.input.content.source_id !== previous.content.source_id ||
                  desired.input.content.source_path !== previous.content.source_path
                ? "source_binding_changed"
                : undefined
      if (reason !== undefined)
        return yield* Effect.fail(
          fail(
            "CURRENT_SOURCE_MANAGEMENT_REQUIRED",
            "Changing or removing an existing Source file requires coordinated Source contribution management.",
            {
              skill_id: plan.skill_id,
              file_id: previous.file_id,
              path: previous.path,
              source_id: previous.content.source_id,
              source_path: previous.content.source_path,
              reason,
              next: "Preserve the current File identity, path and Source binding until Source management can update its contribution and exclusions together.",
            },
          ),
        )
    }
    return selected
  })
}

function validatePreservedCoordinatedReferences(
  library: SharedLibrary,
  plan: CurrentWritePlan,
  current: Target | undefined,
  resolved: readonly ResolvedFile[],
  suppliedSources?: ReadonlyMap<string, CurrentSharedSource>,
) {
  return Effect.gen(function* () {
    if (!isCoordinated(plan) || current === undefined) return
    const before = [current.index.main, ...current.index.files]
    const topologyChanged = before.some((old) => {
      const next = resolved.find((file) => file.page_id === old.page_id)
      return next === undefined || next.input.path !== old.path
    })
    if (!topologyChanged) return
    const otherSources =
      suppliedSources ??
      (yield* resolveCurrentSharedSources(library, {
        selections: plan.files.flatMap((file) =>
          file.kind === "preserve" && file.content.kind === "source" ? [file.content] : [],
        ),
      }))
    const completePaths = plan.files.map((file) => file.path)
    const bodies: { path: string; bytes: Uint8Array }[] = []
    const native: NativeReferenceSource[] = []
    for (const file of plan.files) {
      if (file.kind !== "preserve" || !/\.(?:md|markdown)$/iu.test(file.path)) continue
      let bytes: Uint8Array
      if (file.content.kind === "native") {
        const body = yield* observeSharedBody(file.binding.page_id)
        bytes = new TextEncoder().encode(file.content.frontmatter + body.markdown)
        native.push({
          path: file.path,
          page_id: file.binding.page_id,
          markdown: body.markdown,
          body_sha256: body.fingerprint.sha256,
          ...(body.native_body_completion === undefined
            ? {}
            : { native_body_completion: body.native_body_completion }),
        })
      } else if (file.content.kind === "resource") {
        bytes = (yield* loadCurrentSharedResourceContent(library, {
          owner: { kind: "skill", page_id: current.index.page_id },
          content: file.content,
        })).bytes
      } else {
        const source = otherSources.get(file.content.source_id)
        if (source === undefined)
          return yield* Effect.fail(invalid("A preserved Source is unavailable."))
        const content = file.content
        const materialized = yield* source.materialize([content.source_path])
        const selected = materialized.files.find((entry) => entry.path === content.source_path)
        if (
          selected === undefined ||
          selected.bytes.byteLength !== file.content.bytes ||
          selected.mode !== file.content.mode ||
          (yield* sha256(selected.bytes)) !== file.content.sha256
        )
          return yield* Effect.fail(
            invalid("A preserved Source no longer supplies its selected original."),
          )
        bytes = selected.bytes
      }
      bodies.push({ path: file.path, bytes })
    }
    yield* checked(() => assertSelectedSharedFileReferences(bodies, completePaths))
    const removedPages = new Set(
      before
        .filter((old) => !resolved.some((file) => file.page_id === old.page_id))
        .map((file) => file.page_id),
    )
    if (native.length !== 0 && removedPages.size !== 0) {
      const record = yield* checked(() =>
        sharedRecordFromPage(
          current.raw,
          {
            alias: library.library_id,
            title: "",
            role: "content",
            database_id: library.skills.database_id,
            data_source_ids: [library.skills.data_source_id],
            shared_library: library,
          },
          library.skills.data_source_id,
        ),
      )
      const compiled = yield* compileSharedNativeReferences({
        library,
        record,
        files: native,
        bindings: before,
        relations: {},
      })
      const broken = [
        ...(compiled.index?.entries ?? []),
        ...(compiled.index?.unresolved ?? []),
      ].filter((reference) => removedPages.has(reference.page_id))
      if (broken.length !== 0)
        return yield* Effect.fail(
          fail(
            "SHARED_REFERENCE_BROKEN",
            "A preserved native body still refers to a File selected for removal.",
            { references: broken },
          ),
        )
    }
  })
}

/** Read-only preparation. Body drift is checked by the same writer immediately
 * before mutation; metadata alone is never advertised as a complete no-op. */
export function inspectCurrentSkillWrite(library: SharedLibrary, plan: PreparedCurrentSkillWrite) {
  return Effect.gen(function* () {
    plan = yield* copyValidatedCurrentSkillWrite(plan)
    const current = yield* loadCurrentTarget(library, yield* queryOwner(library, plan.skill_id)),
      selected = yield* resolveFiles(plan, current)
    if (current !== undefined && current.index.kind !== plan.kind)
      return yield* Effect.fail(
        invalid(
          "Import preserves the current content kind. Choose its matching canonical entrypoint.",
          { current: current.index.kind, selected: plan.kind },
        ),
      )
    const kept = new Set(
      selected.flatMap((file) => (file.page_id === undefined ? [] : [file.page_id])),
    )
    const relations = yield* prepareCurrentRelations(library, {
      skill_id: plan.skill_id,
      kind: plan.kind,
      relations: plan.relations,
      ...(current === undefined
        ? {}
        : { owner: { page_id: current.index.page_id, raw: current.raw } }),
    })
    return {
      contract: "current",
      library: {
        library_id: library.library_id,
        database_id: library.skills.database_id,
        data_source_id: library.skills.data_source_id,
      },
      skill_id: plan.skill_id,
      page_id: current?.index.page_id ?? null,
      input_sha256: plan.input_sha256,
      replaces_complete_tree: true,
      remote_writes: 0,
      metadata: {
        name: plan.name,
        description: plan.description,
        kind: plan.kind,
        enabled: plan.enabled ?? current?.index.enabled ?? true,
        default_context: plan.default_context ?? current?.index.default_context ?? false,
      },
      files: selected.map((file) => ({
        path: file.input.path,
        file_id: file.file_id,
        page_id: file.page_id ?? null,
        authority: file.input.content.kind,
        bytes: file.input.kind === "preserve" ? null : file.input.bytes.byteLength,
        sha256: file.input.kind === "preserve" ? null : file.input.sha256,
        previous_authority:
          (current === undefined ? [] : [current.index.main, ...current.index.files]).find(
            (row) => row.page_id === file.page_id,
          )?.content.kind ?? null,
        action: file.page_id === undefined ? "create" : "verify_or_replace",
      })),
      remove:
        current?.index.files
          .filter((file) => !kept.has(file.page_id))
          .map((file) => ({ file_id: file.file_id, page_id: file.page_id, path: file.path })) ?? [],
      body_verification: "required_during_apply",
      state: current?.index.state ?? null,
      relations: currentRelationsInfo(relations),
    }
  }).pipe(
    withCurrentInvocationBudget,
    Effect.map(({ result }) => result),
  )
}

export function inspectCoordinatedSkillWrite(
  library: SharedLibrary,
  input: PreparedCoordinatedSkillWrite,
  source: SourceSelection,
) {
  return Effect.gen(function* () {
    const plan = yield* copyCoordinatedPlan(input)
    yield* checked(() => assertSourceFiles(plan, source))
    const current = yield* loadCurrentTarget(library, yield* queryOwner(library, plan.skill_id))
    const selected = yield* resolveFiles(plan, current)
    if (current !== undefined && current.index.kind !== plan.kind)
      return yield* Effect.fail(invalid("A Source preserves the current target kind."))
    yield* validatePreservedCoordinatedReferences(library, plan, current, selected)
    const kept = new Set(selected.map((file) => file.page_id))
    return {
      contract: "current",
      skill_id: plan.skill_id,
      page_id: current?.index.page_id ?? null,
      input_sha256: plan.input_sha256,
      remote_writes: 0,
      replaces_complete_tree: true,
      body_verification: "required_during_apply",
      files: selected.map((file) => ({
        path: file.input.path,
        file_id: file.file_id,
        page_id: file.page_id ?? null,
        authority: file.input.content.kind,
        action:
          file.input.kind === "preserve"
            ? "preserve"
            : file.page_id === undefined
              ? "create"
              : "verify_or_replace",
      })),
      remove:
        current?.index.files
          .filter((file) => !kept.has(file.page_id))
          .map((file) => ({ file_id: file.file_id, path: file.path, page_id: file.page_id })) ?? [],
      state: current?.index.state ?? null,
    }
  }).pipe(
    withCurrentInvocationBudget,
    Effect.map(({ result }) => result),
  )
}
type CurrentWriteRequest = {
  readonly plan: PreparedCurrentSkillWrite
  readonly operation_id: string
  readonly mode?: "apply" | "resume"
}
type InternalWriteRequest = Omit<CurrentWriteRequest, "plan"> & {
  readonly plan: CurrentWritePlan
  readonly authorization?: CurrentSourceSkillAuthorization
}
/** One complete current-tree write, followed by reachability cleanup. */
export function writeCurrentSkill(library: SharedLibrary, input: CurrentWriteRequest) {
  return Effect.gen(function* () {
    const plan = yield* copyValidatedCurrentSkillWrite(input.plan)
    return yield* executeCurrentSkillWrite(library, { ...input, plan })
  }).pipe(
    withCurrentInvocationBudget,
    Effect.map(({ result }) => result),
  )
}
export function writeCoordinatedSkill(
  library: SharedLibrary,
  input: Omit<CurrentWriteRequest, "plan"> & {
    readonly plan: PreparedCoordinatedSkillWrite
    readonly authorization: CurrentSourceSkillAuthorization
  },
) {
  return Effect.gen(function* () {
    const plan = yield* copyCoordinatedPlan(input.plan),
      grant = input.authorization
    const expectedOperation =
      "source-target-" +
      (yield* sha256(canonicalSharedJson([grant.source_intent.operation_id, plan.skill_id])))
    yield* checked(() => {
      if (
        !sourceAuthorizations.has(grant) ||
        grant[sourceAuthorization] !== true ||
        grant.skill_id !== plan.skill_id ||
        grant.input_sha256 !== plan.input_sha256 ||
        input.operation_id !== expectedOperation ||
        grant.source.source_id !== plan.source.source_id ||
        grant.source.revision !== plan.source.revision
      )
        throw invalid(
          "The Source authorization does not bind this exact child input and operation.",
        )
      assertSourceFiles(plan, grant.source)
    })
    yield* grant.assertCurrent
    return yield* executeCurrentSkillWrite(library, { ...input, plan })
  }).pipe(
    withCurrentInvocationBudget,
    Effect.map(({ result }) => result),
  )
}
function executeCurrentSkillWrite(library: SharedLibrary, input: InternalWriteRequest) {
  return Effect.gen(function* () {
    const plan = input.plan
    yield* checked(() => {
      if (isCoordinated(plan) !== (input.authorization !== undefined))
        throw invalid("A coordinated Source tree requires its exact live parent authorization.")
      currentWriteIdentity(input.operation_id, "Operation ID")
      for (const name of [
        "Name",
        "Description",
        "Kind",
        "Enabled",
        "Default Context",
        "Skill ID",
        "Main File ID",
        "Content",
        "Current State",
        "Operation",
      ])
        binding(library, "skills", name)
      for (const name of ["Name", "File ID", "Path", "Content", "Skill"])
        binding(library, "files", name)
    })
    const raw = yield* queryOwner(library, plan.skill_id)
    const intent = {
      operation_id: input.operation_id,
      owner: { kind: "skill" as const, id: plan.skill_id },
      input_sha256: plan.input_sha256,
      ...(input.authorization === undefined ? {} : { source: input.authorization.source_intent }),
    }
    const unfinishedOwner = yield* checked(() => {
      if (raw === undefined) return undefined
      const page = exactId(property(raw).id)
      const state = currentOperationOwnerState(library, intent, page, raw)
      return state.state !== "ready" && state.operation_id === intent.operation_id
        ? page
        : undefined
    })
    // The same observed header confirms this unfinished owner before Files
    // enumeration. All subsequent preparation and kernel failures keep its
    // locator; a more specific original intent from the kernel takes precedence.
    return yield* applyPreparedCurrentSkillWrite(
      library,
      { ...input, plan },
      raw,
      input.mode === "resume" && unfinishedOwner !== undefined,
    ).pipe(
      Effect.mapError((error) =>
        unfinishedOwner === undefined
          ? error
          : currentOperationFailure(error, intent, null, unfinishedOwner),
      ),
    )
  }).pipe(
    withCurrentInvocationBudget,
    Effect.map(({ result }) => result),
  )
}

function applyPreparedCurrentSkillWrite(
  library: SharedLibrary,
  input: InternalWriteRequest,
  raw: unknown,
  reconciling: boolean,
) {
  return Effect.gen(function* () {
    const plan = input.plan
    const current = yield* loadCurrentTarget(library, raw)
    const resolved = yield* resolveFiles(plan, current)
    if (current !== undefined && current.index.kind !== plan.kind)
      return yield* Effect.fail(
        invalid(
          "Import preserves the current content kind. Choose its matching canonical entrypoint.",
          { current: current.index.kind, selected: plan.kind },
        ),
      )
    const main = resolved.find((file) => file.input.path === plan.main)!
    const relations = yield* prepareCurrentRelations(library, {
      skill_id: plan.skill_id,
      kind: plan.kind,
      relations: plan.relations,
      reconciling,
      ...(current === undefined
        ? {}
        : { owner: { page_id: current.index.page_id, raw: current.raw } }),
    })
    const writableFiles = plan.files.filter(
      (file): file is PreparedCurrentWriteFile => file.kind !== "preserve",
    )
    const sourceSelections = plan.files.flatMap((file) =>
      file.content.kind === "source" ? [file.content] : [],
    )
    const otherSources = yield* resolveCurrentSharedSources(library, {
      selections: sourceSelections.filter(
        (content) => content.source_id !== input.authorization?.source.source_id,
      ),
    })
    const sources = new Map<
      string,
      Pick<CurrentSharedSource, "source_id" | "page_id" | "revision" | "manifest">
    >(otherSources)
    if (
      input.authorization !== undefined &&
      sourceSelections.some(
        (content) => content.source_id === input.authorization!.source.source_id,
      )
    )
      sources.set(input.authorization.source.source_id, input.authorization.source)
    for (const source of sources.values()) yield* checked(() => assertSourceFiles(plan, source))
    // A Source binary has a derived reading original, while its Content remains
    // Source authority. The same upload/readback/retirement code owns both kinds.
    const resourceFile = (
      file: PreparedCurrentWriteFile,
    ): Extract<PreparedCurrentWriteFile, { kind: "resource" }> | undefined =>
      file.kind === "resource"
        ? file
        : file.kind === "source" && file.reading_resource !== null
          ? {
              path: file.path,
              bytes: file.bytes,
              sha256: file.sha256,
              mode: file.mode,
              file_id: file.file_id,
              kind: "resource",
              content: file.reading_resource.content,
              resource: file.reading_resource,
            }
          : undefined
    const resourceFiles = writableFiles.flatMap((file) => {
      const original = resourceFile(file)
      return original === undefined ? [] : [original]
    })
    const resourceMedia = new Map<string, Set<string>>()
    for (const file of resourceFiles) {
      const types = resourceMedia.get(file.content.object_id) ?? new Set<string>()
      types.add(currentUploadFileSpec(file.path).contentType)
      resourceMedia.set(file.content.object_id, types)
    }
    const imagePreview = (file: PreparedCurrentWriteFile) => {
      const original = resourceFile(file)
      return original === undefined || resourceMedia.get(original.content.object_id)?.size === 1
    }
    const validatePreservedReferences = validatePreservedCoordinatedReferences(
      library,
      plan,
      current,
      resolved,
      otherSources,
    )
    const assertCoordinatedScope = Effect.gen(function* () {
      if (input.authorization === undefined) return
      yield* input.authorization.assertCurrent
      const fresh = yield* loadCurrentTarget(library, yield* queryOwner(library, plan.skill_id))
      const footprint = (target: Target | undefined) =>
        target === undefined
          ? null
          : {
              page_id: target.index.page_id,
              kind: target.index.kind,
              files: [target.index.main, ...target.index.files]
                .map(preservedBinding)
                .sort((a, b) => (a.file_id < b.file_id ? -1 : a.file_id > b.file_id ? 1 : 0)),
            }
      if (canonicalSharedJson(footprint(fresh)) !== canonicalSharedJson(footprint(current)))
        return yield* Effect.fail(
          invalid(
            "The current complete directory changed before its coordinated lock was acquired.",
          ),
        )
      yield* validatePreservedReferences
    })
    let changed = false,
      cacheInvalidated = false
    const invalidate = Effect.gen(function* () {
      if (cacheInvalidated) return
      const scope = yield* authScope
      yield* invalidateCurrentLibraryCatalog(scope, library.skills.database_id)
      yield* invalidateSnapshotCache(sharedSkillId(library.library_id, plan.skill_id), scope)
      cacheInvalidated = true
    })
    const api = yield* Notion
    const fieldsForSkill = (creating: boolean): Record<string, unknown> => ({
      ...(creating || !isCoordinated(plan)
        ? {
            [binding(library, "skills", "Name")]: { title: currentRecordText(plan.name) },
            [binding(library, "skills", "Description")]: {
              rich_text: currentRecordText(plan.description),
            },
            [binding(library, "skills", "Kind")]: { select: { name: plan.kind } },
            ...(creating || plan.enabled !== undefined
              ? { [binding(library, "skills", "Enabled")]: { checkbox: plan.enabled ?? true } }
              : {}),
            ...(creating || plan.default_context !== undefined
              ? {
                  [binding(library, "skills", "Default Context")]: {
                    checkbox: plan.default_context ?? false,
                  },
                }
              : {}),
          }
        : {}),
      ...(creating || !isCoordinated(plan)
        ? {
            [binding(library, "skills", "Skill ID")]: {
              rich_text: currentRecordText(plan.skill_id),
            },
          }
        : {}),
      ...(creating || main.input.kind !== "preserve"
        ? {
            [binding(library, "skills", "Main File ID")]: {
              rich_text: currentRecordText(main.file_id),
            },
          }
        : {}),
      ...(main.input.kind === "preserve" && !creating
        ? {}
        : {
            [binding(library, "skills", "Content")]: {
              rich_text: currentRecordText(canonicalSharedJson(main.input.content)),
            },
          }),
      [binding(library, "skills", "Origin")]: {
        relation: [...sources.values()].map((source) => ({ id: source.page_id })),
      },
      ...(creating
        ? {
            [binding(library, "skills", "Current State")]: { select: { name: "applying" } },
            [binding(library, "skills", "Operation")]: {
              rich_text: currentRecordText(input.operation_id),
            },
          }
        : {}),
    })
    const baselineBindings = new Map(
      (current === undefined ? [] : [current.index.main, ...current.index.files]).map((file) => [
        file.page_id,
        file,
      ]),
    )
    const assertCurrentDirectory = (
      final: CurrentSkillIndex,
      raw: unknown,
      pages: ReadonlyMap<string, string>,
      operationId: string,
    ) => {
      const expected = new Map(plan.files.map((file) => [file.path, file]))
      if (
        final.skill_id !== plan.skill_id ||
        final.main.file_id !== main.file_id ||
        !fieldsMatch(raw, fieldsForSkill(false)) ||
        final.files.length + 1 !== expected.size ||
        (final.state.state !== "ready" && final.state.operation_id !== operationId)
      )
        throw invalid("The current owner or complete directory differs from the intended tree.")
      for (const file of [final.main, ...final.files]) {
        const desired = expected.get(file.path)
        if (
          desired === undefined ||
          pages.get(file.path) !== file.page_id ||
          resolved.find((item) => item.input.path === file.path)?.file_id !== file.file_id ||
          canonicalSharedJson(desired.content) !== canonicalSharedJson(file.content)
        )
          throw invalid("The current File locator differs from the verified tree.", {
            path: file.path,
          })
      }
    }
    let finalPages = new Map<string, string>()
    const operation = {
      intent: {
        operation_id: input.operation_id,
        owner: { kind: "skill" as const, id: plan.skill_id },
        input_sha256: plan.input_sha256,
        ...(input.authorization === undefined ? {} : { source: input.authorization.source_intent }),
      },
      ownerPageId: current?.index.page_id ?? null,
      mode: input.mode,
      ...(input.authorization === undefined
        ? {}
        : {
            assertScope: assertCoordinatedScope,
            beforeMutation: input.authorization.activate,
            afterActivate: input.authorization.afterActivate,
            ...(input.authorization.unstarted
              ? { unstartedSourceChild: input.authorization.source_intent }
              : {}),
          }),
      run: (session: CurrentOperationSession) =>
        Effect.gen(function* () {
          const dispatch: CurrentOperationSession["dispatch"] = (action) =>
            session.dispatch({
              ...action,
              observe: (options) =>
                action.observe(options).pipe(
                  Effect.tap((observed) =>
                    observed.status === "missing"
                      ? Effect.gen(function* () {
                          changed = true
                          yield* invalidate
                        })
                      : Effect.void,
                  ),
                ),
            })
          const managedSession: CurrentOperationSession = {
            get ownerPageId() {
              return session.ownerPageId
            },
            get pendingActionKey() {
              return session.pendingActionKey
            },
            get sourceProgress() {
              return session.sourceProgress
            },
            markSourceChildStarted: session.markSourceChildStarted,
            markSourceChildComplete: session.markSourceChildComplete,
            operation_id: session.operation_id,
            intent: session.intent,
            owner: session.owner,
            assertCurrent: session.assertCurrent,
            activate: session.activate,
            bindOwner: session.bindOwner,
            dispatch,
          }
          let ownerRaw: unknown = current?.raw
          const created = yield* dispatch<string, Notion>({
            key: "skill:create",
            replay: "never",
            request: {
              path: "v1/pages",
              body: {
                parent: { type: "data_source_id", data_source_id: library.skills.data_source_id },
                properties: fieldsForSkill(true),
              },
              options: { method: "POST" },
            },
            observe: ({ fresh }) =>
              Effect.gen(function* () {
                const row =
                  fresh || ownerRaw === undefined
                    ? yield* queryOwner(library, plan.skill_id)
                    : ownerRaw
                if (row === undefined) return { status: "missing" } as const
                const page = yield* checked(() => exactId(property(row).id))
                if (current !== undefined && page !== current.index.page_id)
                  return yield* Effect.fail(invalid("The current Skill changed physical identity."))
                ownerRaw = row
                return { status: "complete", value: page } as const
              }),
            acknowledge: (raw) =>
              checked(() => {
                const page = exactId(property(raw).id)
                livePage(raw, page, library.skills.data_source_id)
                if (!fieldsMatch(raw, fieldsForSkill(true)))
                  throw fail(
                    "WRITE_OUTCOME_UNKNOWN",
                    "The Skill CREATE response did not confirm this exact current intent.",
                  )
                ownerRaw = raw
                return page
              }),
          })
          if (session.ownerPageId === null) yield* session.bindOwner(created)
          else if (session.ownerPageId !== created)
            return yield* Effect.fail(
              invalid("The current intent is bound to another physical Skill."),
            )
          const owner = { kind: "skill" as const, page_id: created }
          let files = current?.files ?? (yield* queryFilePages(library, created))
          const filePages = new Map<string, string>([[plan.main, created]])
          const assertOwner = Effect.gen(function* () {
            const row = yield* api.request(`v1/pages/${created}`)
            const index = yield* queryCurrentSkillIndex(library, created, row, [])
            if (
              index.skill_id !== plan.skill_id ||
              (index.state.state !== "ready" && index.state.operation_id !== input.operation_id)
            )
              return yield* Effect.fail(invalid("The current write no longer owns its Skill."))
            ownerRaw = row
          })
          // This guard is only for the parent-authorized Source contribution.
          // It runs after a missing observation, immediately before destructive
          // or replacing actions, so a newly observed native authority survives.
          const assertCoordinatedBinding = (
            page: string,
            wanted?: ResolvedFile,
            retiring = false,
          ) =>
            Effect.gen(function* () {
              if (input.authorization === undefined) return
              const raw =
                page === created
                  ? yield* session.assertCurrent()
                  : yield* api.request(`v1/pages/${page}`)
              const row = property(raw),
                trashed = row.in_trash === true || row.archived === true
              if (trashed && !retiring)
                return yield* Effect.fail(
                  invalid("The coordinated File was retired by another actor."),
                )
              let observed: CurrentFileBinding
              if (page === created) {
                const index = yield* queryCurrentSkillIndex(library, created, raw, [])
                if (
                  index.skill_id !== plan.skill_id ||
                  index.kind !== plan.kind ||
                  (index.state.state !== "ready" &&
                    index.state.operation_id !== session.operation_id)
                )
                  return yield* Effect.fail(
                    invalid("The current Skill no longer belongs to this Source child."),
                  )
                observed = index.main
              } else {
                observed = yield* checked(() =>
                  currentFileRecord(
                    trashed ? { ...row, in_trash: false, archived: false } : raw,
                    created,
                    library.files.data_source_id,
                    library.files.property_ids,
                  ),
                )
                yield* session.assertCurrent()
              }
              const baseline = baselineBindings.get(page)
              if (wanted?.input.kind === "preserve") {
                if (
                  canonicalSharedJson(preservedBinding(observed)) !==
                  canonicalSharedJson(wanted.input.binding)
                )
                  return yield* Effect.fail(invalid("The preserved current File binding changed."))
              } else {
                const candidates = [
                  ...(baseline === undefined
                    ? []
                    : [
                        {
                          file_id: baseline.file_id,
                          path: baseline.path,
                          content: baseline.content,
                        },
                      ]),
                  ...(wanted === undefined
                    ? []
                    : [
                        {
                          file_id: wanted.file_id,
                          path: wanted.input.path,
                          content: wanted.input.content,
                        },
                      ]),
                ]
                const staged = `.ntn-current-${yield* sha256(canonicalSharedJson([input.operation_id, observed.file_id]))}.pending`
                if (
                  observed.content.kind !== "source" ||
                  observed.content.source_id !== input.authorization.source.source_id ||
                  (!(trashed && retiring && candidates.length === 0) &&
                    !candidates.some(
                      (expected) =>
                        expected.content.kind === "source" &&
                        expected.content.source_id === input.authorization!.source.source_id &&
                        expected.file_id === observed.file_id &&
                        (expected.path === observed.path ||
                          (page !== created && staged === observed.path)) &&
                        canonicalSharedJson(expected.content) ===
                          canonicalSharedJson(observed.content),
                    ))
                )
                  return yield* Effect.fail(
                    invalid(
                      "The coordinated File authority, source path or selected content changed.",
                      { page_id: page, file_id: observed.file_id },
                    ),
                  )
              }
              yield* input.authorization.assertCurrent
            })
          const coordinatedDispatch =
            (wanted: ResolvedFile, page: string): CurrentOperationSession["dispatch"] =>
            (action) =>
              dispatch({
                ...action,
                observe: (options) =>
                  action
                    .observe(options)
                    .pipe(
                      Effect.tap((observed) =>
                        observed.status === "missing"
                          ? assertCoordinatedBinding(page, wanted)
                          : Effect.void,
                      ),
                    ),
              })
          const assertCoordinatedResourceRetirement = Effect.gen(function* () {
            if (input.authorization === undefined) return
            const raw = yield* session.assertCurrent(),
              latestFiles = yield* queryFilePages(library, created)
            const latest = yield* queryCurrentSkillIndex(
              library,
              created,
              raw,
              [...latestFiles.values()].map((row) => row.file),
            )
            yield* checked(() =>
              assertCurrentDirectory(latest, raw, filePages, session.operation_id),
            )
            yield* input.authorization.assertCurrent
          })
          const resources = new Map(
            (yield* listCurrentOwnedResourceRecords(library, owner)).map((row) => [
              row.record.record_id,
              row,
            ]),
          )
          const resourceAttachments = new Map<string, unknown>(),
            uploadIds = new Map<string, UploadHandle>()
          const verifiedResources = new Set<string>(),
            uploadScope = makeCurrentUploadScope(managedSession)
          const desiredResources = new Set([
            ...resourceFiles.map((file) => file.content.object_id),
            ...plan.files.flatMap((file) =>
              file.kind === "preserve" && file.content.kind === "resource"
                ? [file.content.object_id]
                : [],
            ),
          ])
          // Preserve a different Source's existing reading original without
          // fetching or rewriting that Source's body. Its manifest still names
          // the selected exact bytes; unrelated originals remain collectible.
          for (const file of plan.files) {
            if (file.kind !== "preserve" || file.content.kind !== "source") continue
            for (const row of resources.values()) {
              const payload = property(row.record.payload)
              if (
                payload.sha256 !== file.content.sha256 ||
                payload.bytes !== file.content.bytes ||
                payload.mode !== file.content.mode
              )
                continue
              const storage = property(payload.storage)
              if (storage.kind === "zip_attachment" && storage.entry !== file.path) continue
              yield* validateCurrentSharedResourceManifest(
                {
                  kind: "resource",
                  object_id: row.record.record_id,
                  sha256: file.content.sha256,
                  bytes: file.content.bytes,
                  mode: file.content.mode,
                },
                row.record.payload,
              )
              desiredResources.add(row.record.record_id)
            }
          }
          for (const file of resourceFiles) {
            if (verifiedResources.has(file.content.object_id)) continue
            const existing = resources.get(file.content.object_id)
            let upload: UploadHandle | undefined
            const pendingUpload =
              file.resource.status === "needs_attachment" &&
              session.pendingActionKey?.startsWith(
                yield* currentUploadActionPrefix({
                  session: managedSession,
                  path: file.path,
                  prepared: file.resource,
                }),
              ) === true
            if (
              (existing === undefined ||
                pendingUpload ||
                session.pendingActionKey === `resource:${file.content.object_id}:create` ||
                session.pendingActionKey === `resource:${file.content.object_id}:attachment`) &&
              file.resource.status === "needs_attachment"
            ) {
              upload = yield* uploadCurrentSharedResource({
                session: managedSession,
                path: file.path,
                prepared: file.resource,
                scope: uploadScope,
              })
              uploadIds.set(file.content.object_id, upload)
            }
            const request = yield* currentOwnedResourceCreateRequest(library, {
              owner,
              objectId: file.content.object_id,
              payload: file.resource.manifest,
              ...(upload === undefined ? {} : { upload: { id: upload.id, name: upload.filename } }),
            })
            const stored = yield* dispatch<
              Effect.Success<ReturnType<typeof currentOwnedResourceFromPage>>,
              Notion | Crypto.Crypto
            >({
              key: `resource:${file.content.object_id}:create`,
              replay: "never",
              request,
              observe: ({ fresh }) =>
                Effect.gen(function* () {
                  const found = fresh
                    ? yield* queryCurrentOwnedResourceRecord(library, {
                        owner,
                        objectId: file.content.object_id,
                      })
                    : existing
                  if (found === undefined) return { status: "missing" } as const
                  yield* validateCurrentSharedResourceManifest(file.content, found.record.payload)
                  return { status: "complete", value: found } as const
                }),
              acknowledge: (response) =>
                currentOwnedResourceFromPage(library, response, {
                  owner,
                  objectId: file.content.object_id,
                }),
            })
            resources.set(file.content.object_id, stored)
            yield* validateCurrentSharedResourceManifest(file.content, stored.record.payload)
            const attachment = yield* checked(() => {
              const field = property(stored.resource)
              if (
                field.type !== "files" ||
                !Array.isArray(field.files) ||
                field.has_more === true ||
                field.files.length !== (file.resource.manifest.storage.kind === "inline" ? 0 : 1)
              )
                throw invalid("The original resource attachment is incomplete.")
              return field.files[0]
            })
            if (attachment !== undefined) {
              const original = yield* loadCurrentSharedResourceContent(library, {
                owner,
                content: file.content,
              })
              if (
                original.bytes.byteLength !== file.bytes.byteLength ||
                (yield* sha256(original.bytes)) !== file.sha256
              )
                return yield* Effect.fail(
                  invalid("The uploaded original differs from the selected input bytes.", {
                    path: file.path,
                  }),
                )
              resourceAttachments.set(file.content.object_id, attachment)
            }
            verifiedResources.add(file.content.object_id)
          }
          const replaceAttachment = (
            file: Extract<PreparedCurrentWriteFile, { kind: "resource" }>,
            upload: UploadHandle,
          ) =>
            Effect.gen(function* () {
              const selected = resources.get(file.content.object_id)
              if (selected === undefined)
                return yield* Effect.fail(
                  invalid("The current original has no owned resource row."),
                )
              const id = library.records.property_ids.Resource
              if (!id)
                return yield* Effect.fail(
                  fail("CURRENT_SCHEMA_REQUIRED", "The current Resource property is missing."),
                )
              const check = (raw: unknown) =>
                Effect.gen(function* () {
                  const value = yield* currentOwnedResourceFromPage(library, raw, {
                    owner,
                    objectId: file.content.object_id,
                  })
                  yield* validateCurrentSharedResourceManifest(file.content, value.record.payload)
                  const attachment = yield* checked(() => {
                    const field = property(value.resource)
                    if (
                      !Array.isArray(field.files) ||
                      field.files.length !== 1 ||
                      field.has_more === true
                    )
                      throw invalid("The current original attachment is incomplete.")
                    return field.files[0]
                  })
                  resources.set(file.content.object_id, value)
                  resourceAttachments.set(file.content.object_id, attachment)
                  return property(attachment).name === upload.filename
                })
              yield* dispatch({
                key: `resource:${file.content.object_id}:attachment`,
                replay: "idempotent",
                request: {
                  path: `v1/pages/${selected.record.page_id}`,
                  body: {
                    properties: {
                      [id]: {
                        files: [
                          {
                            name: upload.filename,
                            type: "file_upload",
                            file_upload: { id: upload.id },
                          },
                        ],
                      },
                    },
                  },
                  options: { method: "PATCH" },
                },
                observe: () =>
                  Effect.gen(function* () {
                    return (yield* check(yield* api.request(`v1/pages/${selected.record.page_id}`)))
                      ? ({ status: "complete", value: undefined } as const)
                      : ({ status: "missing" } as const)
                  }),
                acknowledge: (raw) =>
                  Effect.gen(function* () {
                    if (!(yield* check(raw)))
                      return yield* Effect.fail(
                        fail(
                          "WRITE_OUTCOME_UNKNOWN",
                          "The current original attachment replacement was not confirmed.",
                        ),
                      )
                  }),
              })
              // This must fetch the actual new locator; an object-cache hit cannot
              // establish that replacing the current attachment preserved bytes.
              const original = yield* loadCurrentSharedResourceContent(library, {
                owner,
                content: file.content,
              })
              if (
                original.bytes.byteLength !== file.bytes.byteLength ||
                (yield* sha256(original.bytes)) !== file.sha256
              )
                return yield* Effect.fail(
                  invalid("The replaced current attachment changed its original bytes."),
                )
              return resourceAttachments.get(file.content.object_id)
            })
          // Move every vacated path aside before assigning desired paths. A
          // stopped rename still leaves a complete, unambiguous current index.
          const keptPages = new Set(
            resolved.flatMap((file) => (file.page_id === undefined ? [] : [file.page_id])),
          )
          for (const row of [...files.values()].sort((a, b) =>
            a.file.file_id.localeCompare(b.file.file_id),
          )) {
            const selected = resolved.find((file) => file.page_id === row.file.page_id)
            if (
              selected?.input.path === row.file.path &&
              session.pendingActionKey !== `file:${row.file.page_id}:stage`
            )
              continue
            const staged = `.ntn-current-${yield* sha256(canonicalSharedJson([input.operation_id, row.file.file_id]))}.pending`
            if (plan.files.some((file) => file.path === staged))
              return yield* Effect.fail(
                invalid("The input collides with its temporary rename path."),
              )
            const desired = {
              [binding(library, "files", "Path")]: { rich_text: currentRecordText(staged) },
            }
            yield* dispatch({
              key: `file:${row.file.page_id}:stage`,
              replay: "idempotent",
              request: {
                path: `v1/pages/${row.file.page_id}`,
                body: { properties: desired },
                options: { method: "PATCH" },
              },
              observe: ({ fresh }) =>
                Effect.gen(function* () {
                  const raw = fresh
                    ? yield* api.request(`v1/pages/${row.file.page_id}`)
                    : files.get(row.file.page_id)!.raw
                  const found = yield* checked(() =>
                    currentFileRecord(
                      raw,
                      created,
                      library.files.data_source_id,
                      library.files.property_ids,
                    ),
                  )
                  if (found.file_id !== row.file.file_id)
                    return yield* Effect.fail(invalid("The staged File changed identity."))
                  files.set(found.page_id, { raw, file: found })
                  if (found.path === staged || found.path === selected?.input.path)
                    return { status: "complete", value: undefined } as const
                  yield* assertCoordinatedBinding(row.file.page_id, selected)
                  return { status: "missing" } as const
                }),
              acknowledge: (raw) =>
                checked(() => {
                  const found = currentFileRecord(
                    raw,
                    created,
                    library.files.data_source_id,
                    library.files.property_ids,
                  )
                  if (found.file_id !== row.file.file_id || found.path !== staged)
                    throw fail("WRITE_OUTCOME_UNKNOWN", "The temporary rename was not confirmed.")
                  files.set(found.page_id, { raw, file: found })
                }),
            })
          }
          for (const file of resolved) {
            if (file.input.path === plan.main) continue
            if (file.input.kind === "preserve") {
              filePages.set(file.input.path, file.input.binding.page_id)
              continue
            }
            const desired = {
              [binding(library, "files", "Name")]: { title: currentRecordText(file.input.path) },
              [binding(library, "files", "File ID")]: {
                rich_text: currentRecordText(file.file_id),
              },
              [binding(library, "files", "Path")]: {
                rich_text: currentRecordText(file.input.path),
              },
              [binding(library, "files", "Content")]: {
                rich_text: currentRecordText(canonicalSharedJson(file.input.content)),
              },
              [binding(library, "files", "Skill")]: { relation: [{ id: created }] },
            }
            // CREATE always has the same key and request, even after its response
            // was lost. Observing a physical row never changes that request identity.
            const request = {
              path: "v1/pages",
              body: {
                parent: { type: "data_source_id", data_source_id: library.files.data_source_id },
                properties: desired,
              },
              options: { method: "POST" as const },
            }
            const foundPage = yield* dispatch<string, Notion>({
              key: `file:${file.file_id}:create`,
              replay: "never",
              request,
              observe: ({ fresh }) =>
                Effect.gen(function* () {
                  if (fresh) files = yield* queryFilePages(library, created)
                  const matches = [...files.values()].filter(
                    (row) => row.file.file_id === file.file_id,
                  )
                  if (matches.length > 1)
                    return yield* Effect.fail(
                      invalid("The current File ID has duplicate physical rows."),
                    )
                  const found = matches[0]
                  if (found === undefined) return { status: "missing" } as const
                  return { status: "complete", value: found.file.page_id } as const
                }),
              acknowledge: (raw) =>
                checked(() => {
                  const fileRow = currentFileRecord(
                    raw,
                    created,
                    library.files.data_source_id,
                    library.files.property_ids,
                  )
                  if (fileRow.file_id !== file.file_id || !fieldsMatch(raw, desired))
                    throw fail(
                      "WRITE_OUTCOME_UNKNOWN",
                      "The current File CREATE was not confirmed.",
                    )
                  files.set(fileRow.page_id, { raw, file: fileRow })
                  return fileRow.page_id
                }),
            })
            yield* coordinatedDispatch(
              file,
              foundPage,
            )({
              key: `file:${file.file_id}:properties`,
              replay: "idempotent",
              request: {
                path: `v1/pages/${foundPage}`,
                body: { properties: desired },
                options: { method: "PATCH" },
              },
              observe: ({ fresh }) =>
                Effect.gen(function* () {
                  const raw = fresh
                    ? yield* api.request(`v1/pages/${foundPage}`)
                    : files.get(foundPage)!.raw
                  const parsed = yield* checked(() =>
                    currentFileRecord(
                      raw,
                      created,
                      library.files.data_source_id,
                      library.files.property_ids,
                    ),
                  )
                  if (parsed.file_id !== file.file_id)
                    return yield* Effect.fail(invalid("The current File changed identity."))
                  files.set(foundPage, { raw, file: parsed })
                  return yield* checked(() =>
                    fieldsMatch(raw, desired)
                      ? ({ status: "complete", value: undefined } as const)
                      : ({ status: "missing" } as const),
                  )
                }),
              acknowledge: (raw) =>
                checked(() => {
                  const parsed = currentFileRecord(
                    raw,
                    created,
                    library.files.data_source_id,
                    library.files.property_ids,
                  )
                  if (parsed.file_id !== file.file_id || !fieldsMatch(raw, desired))
                    throw fail(
                      "WRITE_OUTCOME_UNKNOWN",
                      "The current File metadata was not confirmed.",
                    )
                  files.set(foundPage, { raw, file: parsed })
                }),
            })
            keptPages.add(foundPage)
            filePages.set(file.input.path, foundPage)
          }
          const metadata = fieldsForSkill(false)
          yield* coordinatedDispatch(
            main,
            created,
          )({
            key: "skill:properties",
            replay: "idempotent",
            request: {
              path: `v1/pages/${created}`,
              body: { properties: metadata },
              options: { method: "PATCH" },
            },
            observe: ({ fresh }) =>
              Effect.gen(function* () {
                if (fresh) ownerRaw = yield* api.request(`v1/pages/${created}`)
                return yield* checked(() => {
                  livePage(ownerRaw, created, library.skills.data_source_id)
                  return fieldsMatch(ownerRaw, metadata)
                    ? ({ status: "complete", value: undefined } as const)
                    : ({ status: "missing" } as const)
                })
              }),
            acknowledge: (raw) =>
              checked(() => {
                livePage(raw, created, library.skills.data_source_id)
                if (!fieldsMatch(raw, metadata))
                  throw fail(
                    "WRITE_OUTCOME_UNKNOWN",
                    "The current Skill metadata was not confirmed.",
                  )
                ownerRaw = raw
              }),
          })
          // Decide attachment replacement for the whole resource before rendering
          // any of its pages. Shared originals cannot leave earlier projections
          // behind when a later page needs the same original uploaded again.
          const checkedBinaryResources = new Set<string>()
          for (const candidate of resourceFiles) {
            if (
              candidate.kind !== "resource" ||
              !isCurrentProjectionBinary(candidate.path, candidate.bytes) ||
              checkedBinaryResources.has(candidate.content.object_id)
            )
              continue
            checkedBinaryResources.add(candidate.content.object_id)
            const siblings = resourceFiles.filter(
              (file) =>
                file.kind === "resource" &&
                file.content.object_id === candidate.content.object_id &&
                isCurrentProjectionBinary(file.path, file.bytes),
            )
            let missing =
              session.pendingActionKey === `resource:${candidate.content.object_id}:attachment`
            for (const file of siblings) {
              const page = filePages.get(file.path)!
              const projection = yield* checked(() =>
                renderCurrentProjection({
                  path: file.path,
                  bytes: file.bytes,
                  attachment: { name: currentUploadFileSpec(file.path).name },
                  imagePreview: imagePreview(file),
                }),
              )
              if (
                session.pendingActionKey?.startsWith(`projection:${page}:`) === true ||
                !(yield* inspectCurrentProjection({
                  pageId: page,
                  plan: projection,
                  attachment: resourceAttachments.get(candidate.content.object_id),
                })).matches
              )
                missing = true
            }
            if (!missing) continue
            const original = resourceFiles.find(
              (file): file is Extract<PreparedCurrentWriteFile, { kind: "resource" }> =>
                file.kind === "resource" && file.content.object_id === candidate.content.object_id,
            )!
            let upload = uploadIds.get(candidate.content.object_id)
            if (upload === undefined) {
              upload = yield* uploadCurrentSharedResource({
                session: managedSession,
                path: original.path,
                prepared: original.resource,
                scope: uploadScope,
              })
              uploadIds.set(candidate.content.object_id, upload)
            }
            if (
              property(resourceAttachments.get(candidate.content.object_id)).name !==
                upload.filename ||
              session.pendingActionKey === `resource:${candidate.content.object_id}:attachment`
            )
              yield* replaceAttachment(original, upload)
          }
          for (const file of writableFiles) {
            const page = filePages.get(file.path)!
            if (file.kind === "native") {
              const observe = () =>
                observeSharedBody(page).pipe(
                  Effect.map((body) =>
                    body.markdown === file.markdown
                      ? ({ status: "complete", value: undefined } as const)
                      : ({ status: "missing" } as const),
                  ),
                )
              yield* dispatch({
                key: `native:${page}:body`,
                replay: "idempotent",
                request: {
                  path: `v1/pages/${page}/markdown`,
                  body: {
                    markdown_version: "v2",
                    type: "replace_content",
                    replace_content: { new_str: file.markdown },
                  },
                  options: { method: "PATCH" },
                },
                observe: () =>
                  Effect.gen(function* () {
                    const result = yield* observe()
                    if (result.status === "missing") yield* assertCurrentBodyReplaceable(page)
                    return result
                  }),
                acknowledge: () =>
                  Effect.gen(function* () {
                    if ((yield* observe()).status !== "complete")
                      return yield* Effect.fail(
                        fail(
                          "CURRENT_NATIVE_ROUNDTRIP",
                          "Notion changed this native Markdown representation. The current intent remains pending; retain an exact resource when this format cannot round-trip.",
                          { path: file.path },
                        ),
                      )
                  }),
              })
              continue
            }
            const resource = resourceFile(file)
            let attachment =
              resource === undefined
                ? undefined
                : resourceAttachments.get(resource.content.object_id)
            const binary = isCurrentProjectionBinary(file.path, file.bytes)
            let upload =
              resource === undefined ? undefined : uploadIds.get(resource.content.object_id)
            const rewriteLink = (href: string) => {
              if (/^(?:[a-z][a-z0-9+.-]*:|\/|#|\?)/iu.test(href)) return undefined
              try {
                const suffixAt = href.search(/[?#]/u),
                  target = posix.normalize(
                    posix.join(
                      posix.dirname(file.path),
                      decodeURIComponent(suffixAt < 0 ? href : href.slice(0, suffixAt)),
                    ),
                  )
                const linked = filePages.get(target)
                return linked === undefined
                  ? undefined
                  : `https://www.notion.so/${linked.replaceAll("-", "")}${suffixAt < 0 ? "" : href.slice(suffixAt)}`
              } catch {
                return undefined
              }
            }
            const name = currentUploadFileSpec(file.path).name
            let projection = yield* checked(() =>
              renderCurrentProjection({
                path: file.path,
                bytes: file.bytes,
                ...(binary
                  ? { attachment: upload === undefined ? { name } : { id: upload.id, name } }
                  : {}),
                rewriteLink,
                imagePreview: imagePreview(file),
              }),
            )
            const pendingAttachment =
              resource !== undefined &&
              session.pendingActionKey === `resource:${resource.content.object_id}:attachment`
            if (
              !pendingAttachment &&
              session.pendingActionKey?.startsWith(`projection:${page}:`) !== true &&
              (yield* inspectCurrentProjection({ pageId: page, plan: projection, attachment }))
                .matches
            )
              continue
            if (binary && upload !== undefined && resource !== undefined) {
              if (property(attachment).name !== upload.filename || pendingAttachment)
                attachment = yield* replaceAttachment(resource, upload)
              projection = yield* checked(() =>
                renderCurrentProjection({
                  path: file.path,
                  bytes: file.bytes,
                  attachment: { id: upload!.id, name },
                  rewriteLink,
                  imagePreview: imagePreview(file),
                }),
              )
            }
            yield* applyCurrentProjection<Notion | Crypto.Crypto | Store>({
              pageId: page,
              content: file.content,
              plan: projection,
              attachment,
              assertCurrent: assertOwner,
              dispatch: coordinatedDispatch(
                resolved.find((selected) => selected.input.path === file.path)!,
                page,
              ),
            })
          }
          yield* applyCurrentRelations(library, relations, {
            page_id: created,
            raw: ownerRaw,
            dispatch,
          })
          const retire = (page: string, role: "file" | "resource") =>
            Effect.gen(function* () {
              const check = (raw: unknown) =>
                Effect.gen(function* () {
                  const row = property(raw),
                    active = { ...row, in_trash: false, archived: false }
                  if (exactId(row.id) !== page)
                    return yield* Effect.fail(invalid("Retirement returned another page."))
                  if (role === "file") {
                    if (keptPages.has(page))
                      return yield* Effect.fail(
                        invalid("A selected current File cannot be retired."),
                      )
                    yield* checked(() =>
                      currentFileRecord(
                        active,
                        created,
                        library.files.data_source_id,
                        library.files.property_ids,
                      ),
                    )
                  } else {
                    const recordId = Object.entries(property(row.properties)).flatMap(
                      ([key, value]) =>
                        key === library.records.property_ids["Record ID"] ||
                        property(value).id === library.records.property_ids["Record ID"]
                          ? [text(property(value).rich_text)]
                          : [],
                    )
                    if (recordId.length !== 1 || desiredResources.has(recordId[0]!))
                      return yield* Effect.fail(
                        invalid("A selected current original cannot be retired."),
                      )
                    yield* currentOwnedResourceFromPage(library, active, {
                      owner,
                      objectId: recordId[0]!,
                    })
                  }
                  return row.in_trash === true
                })
              yield* dispatch({
                key: `retire-${role}:${page}`,
                replay: "idempotent",
                request: {
                  path: `v1/pages/${page}`,
                  body: { in_trash: true },
                  options: { method: "PATCH" },
                },
                observe: () =>
                  Effect.gen(function* () {
                    const trashed = yield* check(yield* api.request(`v1/pages/${page}`))
                    if (!trashed) {
                      yield* assertCurrentBodyReplaceable(page)
                      if (role === "file") yield* assertCoordinatedBinding(page, undefined, true)
                      else yield* assertCoordinatedResourceRetirement
                    }
                    return trashed
                      ? ({ status: "complete", value: undefined } as const)
                      : ({ status: "missing" } as const)
                  }),
                acknowledge: (raw) =>
                  Effect.gen(function* () {
                    if (!(yield* check(raw)))
                      return yield* Effect.fail(
                        fail("WRITE_OUTCOME_UNKNOWN", "Current retirement was not confirmed."),
                      )
                  }),
              })
            })
          // An accepted archive disappears from active queries. Recover that one
          // exact in-flight page before walking the remaining live rows.
          const pendingRetirement = /^retire-(file|resource):([a-f0-9-]{36})$/u.exec(
            session.pendingActionKey ?? "",
          )
          if (pendingRetirement)
            yield* retire(
              pendingRetirement[2]!,
              pendingRetirement[1] === "file" ? "file" : "resource",
            )
          for (const row of files.values())
            if (!keptPages.has(row.file.page_id)) yield* retire(row.file.page_id, "file")
          // Desired bytes and every reading page have been checked before any
          // unreferenced exact original is removed.
          for (const row of resources.values())
            if (!desiredResources.has(row.record.record_id))
              yield* retire(row.record.page_id, "resource")
          finalPages = filePages
          return { page_id: created, files: filePages.size }
        }),
      verify: (
        session: CurrentOperationSession,
        value: { readonly page_id: string; readonly files: number },
      ) =>
        Effect.gen(function* () {
          const raw = yield* api.request(`v1/pages/${value.page_id}`),
            files = yield* queryFilePages(library, value.page_id)
          const final = yield* queryCurrentSkillIndex(
            library,
            value.page_id,
            raw,
            [...files.values()].map((row) => row.file),
          )
          yield* checked(() => assertCurrentDirectory(final, raw, finalPages, session.operation_id))
          yield* verifyCurrentRelations(library, relations, value.page_id, raw)
          if (input.authorization !== undefined) {
            yield* validatePreservedReferences
            yield* input.authorization.assertCurrent
          }
        }),
    }
    const result = yield* withCurrentOperation(library, {
      ...operation,
      ...(input.authorization === undefined
        ? {}
        : {
            verifyCompletedResume: (session: CurrentOperationSession) =>
              operation.run(session).pipe(Effect.tap((value) => operation.verify(session, value))),
          }),
    })
    return {
      contract: "current",
      library: {
        library_id: library.library_id,
        database_id: library.skills.database_id,
        data_source_id: library.skills.data_source_id,
      },
      status: changed ? "applied" : "unchanged",
      operation_id: input.operation_id,
      skill_id: plan.skill_id,
      page_id: result.page_id,
      input_sha256: plan.input_sha256,
      files: result.files,
      relations: currentRelationsInfo(relations),
      state: "ready",
      request_metrics: api.requestMetrics?.(),
    }
  })
}
