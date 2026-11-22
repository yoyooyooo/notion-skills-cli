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
import { normalizePath, pageId } from "./ref.ts"
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
  inspectCurrentOperation,
  readCurrentOperationIntent,
  withCurrentOperation,
  type CurrentOperationSession,
  type CurrentSourceIntentBinding,
  type CurrentWriteMode,
} from "./shared-current-operation.ts"
import {
  validateCurrentSourceFileInput,
  type CurrentSourceFileInput,
} from "./shared-current-source-file-input.ts"
import { assertCurrentBodyReplaceable } from "./shared-current-projection.ts"
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
  type CurrentSharedSourceSelection,
} from "./shared-current-source.ts"
import { decodeCurrentFileContent } from "./shared-current-file.ts"
import { planSharedFiles } from "./shared-composition.ts"
import {
  assertSelectedSharedFileReferences,
  assertSelectedSharedSourceReferences,
} from "./shared-file-references.ts"
import {
  applyCurrentRelations,
  currentRelationsInfo,
  prepareCurrentRelations,
  verifyCurrentRelations,
  validateCurrentWriteRelations,
} from "./shared-current-relations.ts"
import {
  CurrentSkillPatchScopeSchema,
  type CurrentSkillPatchScope,
} from "./shared-current-skill-patch-input.ts"
import {
  currentUploadActionPrefix,
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
import { compareNativeMarkdown, nativeFileTransport } from "./shared-native-markdown.ts"
import {
  applyCurrentNativePlainText,
  nativePlainTextPlan,
  planCurrentNativePlainText,
  type CurrentNativePlainTextTarget,
} from "./shared-native-plain-text.ts"
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
type CoordinatedSkillBase = {
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
  readonly consumption_paths: readonly string[]
  readonly consumption_sources: readonly CurrentSharedSourceSelection[]
  readonly input_sha256: string
}
export type PreparedCoordinatedSkillWrite = CoordinatedSkillBase &
  (
    | {
        readonly authority_transfer: null
        readonly files: readonly (SourceWriteFile | PreparedPreservedFile)[]
      }
    | {
        readonly authority_transfer: CurrentSourceFileInput
        readonly files: readonly (PreparedCurrentWriteFile | PreparedPreservedFile)[]
      }
  )
type PatchMetadata = Partial<
  Pick<CurrentSkillWriteInput, "name" | "description" | "enabled" | "default_context" | "relations">
>
export type CurrentSkillPatchInput = {
  readonly target: string
  readonly metadata?: PatchMetadata
  readonly files?: readonly (Omit<
    CurrentSkillWriteInput["files"][number],
    "file_id" | "authority"
  > & { readonly authority?: { readonly kind: "native" | "resource" } })[]
  readonly remove?: readonly string[]
  readonly scope?: CurrentSkillPatchScope
}
export type PreparedCurrentSkillPatch = Omit<PreparedCurrentSkillWrite, "files"> & {
  readonly contract: "notion-patch"
  readonly scope: CurrentSkillPatchScope
  readonly metadata: PatchMetadata
  readonly remove: readonly string[]
  readonly files: readonly (PreparedCurrentWriteFile | PreparedPreservedFile)[]
}
type CurrentWritePlan =
  | PreparedCurrentSkillWrite
  | PreparedCoordinatedSkillWrite
  | PreparedCurrentSkillPatch
type CurrentPlanFile = PreparedCurrentWriteFile | PreparedPreservedFile
const writablePlanFiles = (files: readonly CurrentPlanFile[]) =>
  files.filter((file): file is PreparedCurrentWriteFile => file.kind !== "preserve")
const isCoordinated = (plan: CurrentWritePlan): plan is PreparedCoordinatedSkillWrite =>
  "source" in plan
const isPatch = (plan: CurrentWritePlan): plan is PreparedCurrentSkillPatch =>
  "contract" in plan && plan.contract === "notion-patch"
function preservedBinding(binding: PreservedBinding): PreservedBinding {
  return {
    file_id: currentWriteIdentity(binding.file_id, "File ID"),
    page_id: exactId(binding.page_id),
    skill_page_id: exactId(binding.skill_page_id),
    path: binding.path,
    content: decodeCurrentFileContent(structuredClone(binding.content)),
  }
}
function patchScope(input: unknown): CurrentSkillPatchScope {
  const scope = Schema.decodeUnknownSync(CurrentSkillPatchScopeSchema)(input, {
    onExcessProperty: "error",
  })
  const bindings = scope.bindings.map(preservedBinding)
  const main = entrypointFor(scope.kind)
  if (bindings.some((file) => file.content.kind === "source"))
    throw fail(
      "CURRENT_SOURCE_MANAGEMENT_REQUIRED",
      "A Notion-owned patch cannot replace or remove Source content.",
    )
  if (
    bindings.filter((file) => file.page_id === scope.page_id && file.path === main).length !== 1 ||
    bindings.some((file) => file.skill_page_id !== scope.page_id) ||
    new Set(bindings.map((file) => file.page_id)).size !== bindings.length ||
    new Set(bindings.map((file) => file.file_id)).size !== bindings.length
  )
    throw invalid(
      "A Notion-owned patch needs one exact main and distinct native/resource bindings.",
    )
  planSharedFiles({ base: bindings, mounts: [], overrides: [], entrypoint: main })
  return { ...scope, bindings }
}
function patchMetadata(input: PatchMetadata, scope: CurrentSkillPatchScope): PatchMetadata {
  const unknown = Object.keys(input).filter(
    (key) => !["name", "description", "enabled", "default_context", "relations"].includes(key),
  )
  if (unknown.length) throw invalid("Unknown patch metadata.", { fields: unknown })
  if (
    (input.enabled !== undefined && typeof input.enabled !== "boolean") ||
    (input.default_context !== undefined && typeof input.default_context !== "boolean")
  )
    throw invalid("Patch flags must be booleans.")
  return {
    ...(input.name === undefined ? {} : { name: validateDisplayName(input.name) }),
    ...(input.description === undefined
      ? {}
      : { description: validateDescription(input.description) }),
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    ...(input.default_context === undefined ? {} : { default_context: input.default_context }),
    ...(input.relations === undefined
      ? {}
      : { relations: validateCurrentWriteRelations(input.relations, scope.kind, scope.skill_id) }),
  }
}
function patchFingerprint(plan: Omit<PreparedCurrentSkillPatch, "input_sha256">) {
  return {
    contract: plan.contract,
    scope: plan.scope,
    metadata: plan.metadata,
    remove: plan.remove,
    files: plan.files.map((file) =>
      file.kind === "preserve"
        ? { kind: "preserve", binding: file.binding }
        : { kind: "write", file: currentWriteFileFingerprint(file) },
    ),
  }
}
function validatePatchTree(plan: Omit<PreparedCurrentSkillPatch, "input_sha256">): void {
  if (
    plan.contract !== "notion-patch" ||
    "source" in plan ||
    plan.scope.skill_id !== plan.skill_id ||
    plan.scope.kind !== plan.kind ||
    plan.main !== entrypointFor(plan.kind)
  )
    throw invalid("The patch changed its exact Skill identity or kind.")
  validateDisplayName(plan.name)
  validateDescription(plan.description)
  if (
    canonicalSharedJson(patchMetadata(plan.metadata, plan.scope)) !==
    canonicalSharedJson(plan.metadata)
  )
    throw invalid("Patch metadata changed after preparation.")
  for (const field of ["enabled", "default_context", "relations"] as const)
    if (
      canonicalSharedJson(plan[field] ?? null) !== canonicalSharedJson(plan.metadata[field] ?? null)
    )
      throw invalid("The patch changed an unselected management field.", { field })
  if (
    (plan.metadata.name !== undefined && plan.name !== plan.metadata.name) ||
    (plan.metadata.description !== undefined && plan.description !== plan.metadata.description)
  )
    throw invalid("Patch display metadata changed after preparation.")
  if (
    new Set(plan.remove).size !== plan.remove.length ||
    plan.remove.some((path) => !path || path === plan.main || normalizePath(path) !== path)
  )
    throw invalid("Select distinct canonical supporting paths for removal.")
  planSharedFiles({ base: plan.files, mounts: [], overrides: [], entrypoint: plan.main })
  if (
    plan.files.length > 10000 ||
    writablePlanFiles(plan.files).reduce((size, file) => size + file.bytes.byteLength, 0) >
      128 * 1024 * 1024
  )
    throw invalid("The complete patch exceeds its file or byte limit.")
  const ids = new Set<string>()
  for (const file of plan.files) {
    if (
      file.content.kind === "source" ||
      file.file_id === undefined ||
      ids.has(file.file_id) ||
      plan.remove.includes(file.path)
    )
      throw invalid("A patch cannot change Source authority or repeat a selected identity.")
    ids.add(currentWriteIdentity(file.file_id, "File ID"))
    const old = plan.scope.bindings.find((binding) => binding.path === file.path)
    if (old !== undefined && old.file_id !== file.file_id)
      throw invalid("A patch preserves existing File identities.")
    if (
      file.kind === "preserve" &&
      (old === undefined ||
        canonicalSharedJson(file.binding) !== canonicalSharedJson(old) ||
        file.path !== old.path ||
        canonicalSharedJson(file.content) !== canonicalSharedJson(old.content))
    )
      throw invalid("The preserved patch binding changed.")
  }
  for (const old of plan.scope.bindings)
    if (!plan.remove.includes(old.path) && !plan.files.some((file) => file.path === old.path))
      throw invalid("An unselected File cannot disappear from a patch.", { path: old.path })
  assertSelectedSharedFileReferences(
    writablePlanFiles(plan.files),
    plan.files.map((file) => file.path),
  )
}
function assertPatchTarget(plan: PreparedCurrentSkillPatch, current: Target | undefined): void {
  if (
    current === undefined ||
    current.index.page_id !== plan.scope.page_id ||
    current.index.skill_id !== plan.skill_id ||
    current.index.kind !== plan.kind
  )
    throw invalid("The patch requires its exact existing Skill.")
  const allowed = new Map(plan.scope.bindings.map((file) => [file.file_id, file]))
  const writes = new Map(writablePlanFiles(plan.files).map((file) => [file.file_id, file]))
  for (const file of [current.index.main, ...current.index.files]) {
    const old = allowed.get(file.file_id),
      selected = writes.get(file.file_id)
    if (file.content.kind === "source")
      throw fail(
        "CURRENT_SOURCE_MANAGEMENT_REQUIRED",
        "A Notion-owned patch cannot replace or remove Source content.",
        { path: file.path },
      )
    if (
      (old === undefined &&
        (selected === undefined ||
          selected.path !== file.path ||
          canonicalSharedJson(selected.content) !== canonicalSharedJson(file.content))) ||
      (old !== undefined && old.page_id !== file.page_id)
    )
      throw invalid("The complete patch directory changed outside its selected work.", {
        path: file.path,
        file_id: file.file_id,
      })
  }
}

/** Prepare only explicitly selected edits; untouched native bodies remain live. */
export function prepareCurrentSkillPatch(library: SharedLibrary, input: CurrentSkillPatchInput) {
  return Effect.gen(function* () {
    const target = yield* checked(() => exactId(input.target))
    const current = yield* loadCurrentTarget(
      library,
      yield* (yield* Notion).request(`v1/pages/${target}`),
    )
    if (current === undefined)
      return yield* Effect.fail(invalid("The patch target is unavailable."))
    const scope = yield* checked(() =>
      patchScope(
        input.scope ?? {
          page_id: current.index.page_id,
          skill_id: current.index.skill_id,
          kind: current.index.kind,
          bindings: [current.index.main, ...current.index.files].map(preservedBinding),
        },
      ),
    )
    const metadata = yield* checked(() => patchMetadata(input.metadata ?? {}, scope))
    const remove = yield* checked(() => [...(input.remove ?? [])].sort())
    const files: CurrentPlanFile[] = []
    const selected = new Set<string>()
    for (const file of input.files ?? []) {
      if (
        selected.has(file.path) ||
        (file.authority !== undefined && !["native", "resource"].includes(file.authority.kind))
      )
        return yield* Effect.fail(invalid("Select each native/resource patch path once."))
      selected.add(file.path)
      const old = scope.bindings.find((binding) => binding.path === file.path)
      files.push(
        yield* prepareCurrentWriteFile({
          path: file.path,
          bytes: file.bytes,
          mode: file.mode ?? old?.content.mode,
          file_id:
            old?.file_id ??
            "file-" + (yield* sha256(canonicalSharedJson([scope.skill_id, file.path]))),
          authority: file.authority ?? { kind: "native" },
        }),
      )
    }
    for (const binding of scope.bindings) {
      if (selected.has(binding.path) || remove.includes(binding.path)) continue
      files.push({
        kind: "preserve",
        path: binding.path,
        file_id: binding.file_id,
        content: binding.content,
        binding,
      })
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    const plan = {
      contract: "notion-patch" as const,
      scope,
      metadata,
      remove,
      skill_id: scope.skill_id,
      kind: scope.kind,
      name: metadata.name ?? current.index.name,
      description: metadata.description ?? current.index.description,
      ...metadata,
      main: entrypointFor(scope.kind),
      files,
    }
    yield* checked(() => validatePatchTree(plan))
    const prepared = {
      ...plan,
      input_sha256: yield* sha256(canonicalSharedJson(patchFingerprint(plan))),
    }
    yield* checked(() => assertPatchTarget(prepared, current))
    return prepared satisfies PreparedCurrentSkillPatch
  })
}
function copyCurrentSkillPatch(input: PreparedCurrentSkillPatch) {
  return Effect.gen(function* () {
    const plan = yield* checked(() => structuredClone(input))
    yield* checked(() => patchScope(plan.scope))
    const files = yield* Effect.forEach(
      plan.files,
      (file): Effect.Effect<CurrentPlanFile, SkillsError, Crypto.Crypto> =>
        file.kind === "preserve"
          ? checked(() => ({ ...file, binding: preservedBinding(file.binding) }))
          : copyValidatedCurrentWriteFile(file),
    )
    const copied = { ...plan, files }
    yield* checked(() => validatePatchTree(copied))
    if ((yield* sha256(canonicalSharedJson(patchFingerprint(copied)))) !== plan.input_sha256)
      return yield* Effect.fail(
        invalid("The prepared patch changed. Prepare the selected edits again."),
      )
    return copied
  })
}
function coordinatedFingerprint(plan: Omit<PreparedCoordinatedSkillWrite, "input_sha256">) {
  return {
    contract: plan.contract,
    skill_id: plan.skill_id,
    kind: plan.kind,
    source: plan.source,
    authority_transfer: plan.authority_transfer,
    consumption_paths: plan.consumption_paths,
    consumption_sources: plan.consumption_sources,
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
  planSharedFiles({
    base: plan.consumption_paths.map((path) => ({ path })),
    mounts: [],
    overrides: [],
    entrypoint: plan.main,
  })
  const sourceIds = new Set<string>()
  for (const source of plan.consumption_sources) {
    validateCurrentSourceId(source.source_id)
    if (sourceIds.has(source.source_id) || !/^[a-f0-9]{64}$/u.test(source.revision))
      throw invalid("A complete consumption tree needs one exact revision per Source.")
    sourceIds.add(source.source_id)
  }
  const transfer = plan.authority_transfer
  if (transfer !== null) {
    validateCurrentSourceFileInput(transfer)
    if (
      transfer.request.skill_id !== plan.skill_id ||
      transfer.revision !== plan.source.revision ||
      plan.files.filter((file) => file.kind !== "preserve").length !== 1
    )
      throw invalid("A file authority intent selects exactly one current File.")
  }
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
      if (
        transfer === null &&
        file.content.kind === "source" &&
        file.content.source_id === plan.source.source_id
      )
        throw invalid(
          "This Source must declare its complete managed contribution, rather than preserve its previous revision.",
        )
    } else {
      if (transfer === null) {
        if (
          file.kind !== "source" ||
          file.content.source_id !== plan.source.source_id ||
          file.content.revision !== plan.source.revision
        )
          throw invalid("A coordinated write may change only this Source contribution.")
      } else {
        const action = transfer.request.action
        if (
          file.file_id !== transfer.request.file_id ||
          file.path !== transfer.target.path ||
          file.sha256 !== transfer.selected.sha256 ||
          file.bytes.byteLength !== transfer.selected.bytes ||
          file.mode !== transfer.selected.mode ||
          (action.kind === "takeover"
            ? file.kind !== action.to
            : file.kind !== "source" ||
              file.content.source_id !== plan.source.source_id ||
              file.content.revision !== plan.source.revision ||
              file.content.source_path !== transfer.request.source_path)
        )
          throw invalid("The prepared authority transfer differs from its exact selected File.")
      }
      totalBytes += file.bytes.byteLength
    }
  }
  if (totalBytes > 128 * 1024 * 1024)
    throw invalid("One coordinated target exceeds 128 MiB of selected bytes.")
  assertSelectedSharedFileReferences(
    writablePlanFiles(plan.files).filter((file) => file.kind !== "source"),
    plan.consumption_paths,
  )
}
/** The complete directory is frozen; preserved bodies are references, never old content snapshots. */
export function prepareCoordinatedSkillWrite(input: {
  readonly skill_id: string
  readonly kind: CurrentSkillWriteInput["kind"]
  readonly source: PreparedCoordinatedSkillWrite["source"]
  readonly consumption_paths: readonly string[]
  readonly consumption_sources: readonly CurrentSharedSourceSelection[]
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
  return prepareCoordinatedPlan(input, null)
}

/** Only a parent file-authority input may select a writable Notion-owned File. */
export function prepareCurrentSourceFileSkillWrite(input: {
  readonly skill_id: string
  readonly kind: CurrentSkillWriteInput["kind"]
  readonly source: PreparedCoordinatedSkillWrite["source"]
  readonly consumption_paths: readonly string[]
  readonly consumption_sources: readonly CurrentSharedSourceSelection[]
  readonly create: Pick<CurrentSkillWriteInput, "name" | "description">
  readonly transfer: CurrentSourceFileInput
  readonly files: readonly (
    | { readonly kind: "write"; readonly file: CurrentSkillWriteInput["files"][number] }
    | { readonly kind: "preserve"; readonly binding: PreservedBinding }
  )[]
}) {
  return prepareCoordinatedPlan(input, input.transfer)
}

function prepareCoordinatedPlan(
  input: {
    readonly skill_id: string
    readonly kind: CurrentSkillWriteInput["kind"]
    readonly source: PreparedCoordinatedSkillWrite["source"]
    readonly consumption_paths: readonly string[]
    readonly consumption_sources: readonly CurrentSharedSourceSelection[]
    readonly create: Pick<
      CurrentSkillWriteInput,
      "name" | "description" | "enabled" | "default_context"
    >
    readonly files: readonly (
      | { readonly kind: "write"; readonly file: CurrentSkillWriteInput["files"][number] }
      | { readonly kind: "preserve"; readonly binding: PreservedBinding }
    )[]
  },
  transferInput: CurrentSourceFileInput | null,
) {
  return Effect.gen(function* () {
    const transfer =
      transferInput === null
        ? null
        : yield* checked(() => validateCurrentSourceFileInput(transferInput))
    const files: (PreparedCurrentWriteFile | PreparedPreservedFile)[] = []
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
        if (transfer === null && file.kind !== "source")
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
      authority_transfer: transfer,
      main: entrypointFor(input.kind),
      consumption_paths: [...input.consumption_paths].sort(),
      consumption_sources: input.consumption_sources
        .map((source) => ({ ...source }))
        .sort((a, b) => (a.source_id < b.source_id ? -1 : a.source_id > b.source_id ? 1 : 0)),
      files,
    }
    yield* checked(() => validateCoordinatedTree(plan))
    const input_sha256 = yield* sha256(canonicalSharedJson(coordinatedFingerprint(plan)))
    if (transfer !== null)
      return {
        ...plan,
        authority_transfer: transfer,
        input_sha256,
      } satisfies PreparedCoordinatedSkillWrite
    const sourceFiles = yield* checked(() =>
      files.map((file) => {
        if (file.kind !== "preserve" && file.kind !== "source")
          throw invalid("Only Source bytes enter a contribution intent.")
        return file
      }),
    )
    return {
      ...plan,
      authority_transfer: null,
      files: sourceFiles,
      input_sha256,
    } satisfies PreparedCoordinatedSkillWrite
  })
}
function copyCoordinatedPlan(input: PreparedCoordinatedSkillWrite) {
  return Effect.gen(function* () {
    const snapshot = yield* checked(() => structuredClone(input))
    const files: (PreparedCurrentWriteFile | PreparedPreservedFile)[] = []
    for (const selected of snapshot.files) {
      if (selected.kind === "preserve") {
        const binding = yield* checked(() => preservedBinding(selected.binding))
        files.push({ ...selected, binding, content: decodeCurrentFileContent(selected.content) })
      } else {
        const file = yield* copyValidatedCurrentWriteFile(selected)
        if (snapshot.authority_transfer === null && file.kind !== "source")
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
    if (plan.authority_transfer !== null)
      return {
        ...plan,
        authority_transfer: validateCurrentSourceFileInput(plan.authority_transfer),
      } satisfies PreparedCoordinatedSkillWrite
    const sourceFiles = yield* checked(() =>
      files.map((file) => {
        if (file.kind !== "preserve" && file.kind !== "source")
          throw invalid("Only Source bytes enter a contribution intent.")
        return file
      }),
    )
    return {
      ...plan,
      authority_transfer: null,
      files: sourceFiles,
    } satisfies PreparedCoordinatedSkillWrite
  })
}
type SourceSelection = Pick<CurrentSharedSource, "source_id" | "revision" | "manifest">
function assertSourceFiles(plan: CurrentWritePlan, source: SourceSelection) {
  assertSelectedSharedSourceReferences(
    writablePlanFiles(plan.files).flatMap((file) =>
      file.kind === "source" && file.content.source_id === source.source_id
        ? [{ path: file.path, source_path: file.content.source_path, bytes: file.bytes }]
        : [],
    ),
    source.manifest.map((file) => file.path),
  )
  if (
    isCoordinated(plan) &&
    plan.source.source_id === source.source_id &&
    plan.source.revision !== source.revision
  )
    throw invalid("The coordinated target belongs to another Source input.")
  for (const file of plan.files) {
    if (file.content.kind !== "source" || file.content.source_id !== source.source_id) continue
    const content = file.content
    const declared = source.manifest.filter((entry) => entry.path === content.source_path)
    if (
      declared.length !== 1 ||
      declared[0]!.sha256 !== file.content.sha256 ||
      declared[0]!.bytes !== file.content.bytes ||
      declared[0]!.mode !== file.content.mode ||
      file.content.revision !== source.revision
    )
      throw invalid("Supplied Source bytes differ from its complete current manifest.", {
        path: file.path,
      })
  }
  if (isCoordinated(plan) && plan.authority_transfer !== null) {
    const transfer = plan.authority_transfer
    const selected = source.manifest.filter((file) => file.path === transfer.request.source_path)
    if (
      selected.length !== 1 ||
      selected[0]!.sha256 !== transfer.selected.sha256 ||
      selected[0]!.bytes !== transfer.selected.bytes ||
      selected[0]!.mode !== transfer.selected.mode
    )
      throw invalid("The authority transfer differs from the current Source original.")
  }
}
const sourceAuthorization = Symbol("current Source target authorization")
function assertCoordinatedSource(plan: PreparedCoordinatedSkillWrite, source: SourceSelection) {
  if (plan.source.source_id !== source.source_id || plan.source.revision !== source.revision)
    throw invalid("The coordinated target belongs to another Source input.")
  assertSourceFiles(plan, source)
}
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
  readonly completed: boolean
  readonly predecessor:
    | {
        readonly intent_json: string
        readonly source_id: string
        readonly source_page_id: string | null
        readonly operation_id: string
        readonly input_sha256: string
        readonly current_skill_id: string | null
      }
    | undefined
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
      selected = structuredClone({
        source_id: input.source.source_id,
        page_id: input.source.page_id,
        revision: input.source.revision,
        manifest: input.source.manifest,
      })
    const source = Object.freeze({
      ...selected,
      manifest: Object.freeze(selected.manifest.map((file) => Object.freeze(file))),
    })
    yield* checked(() => {
      assertCoordinatedSource(plan, source)
      if (
        session.owner.kind !== "source" ||
        session.owner.id !== source.source_id ||
        session.ownerPageId !== exactId(source.page_id) ||
        !("source_input" in session.intent) ||
        !session.intent.source_input.affected_skill_ids.includes(plan.skill_id)
      )
        throw invalid("The parent Source intent does not authorize this exact target.")
      if (
        "source_input" in session.intent &&
        (plan.authority_transfer !== null
          ? session.intent.source_input.kind !== "file_authority" ||
            canonicalSharedJson(session.intent.source_input) !==
              canonicalSharedJson(plan.authority_transfer) ||
            plan.authority_transfer.source_page_id !== source.page_id
          : session.intent.source_input.kind === "file_authority")
      )
        throw invalid("The parent Source intent does not authorize this authority transfer.")
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
      const completing =
        session.pendingActionKey === "$owner.ready" &&
        "source_input" in session.intent &&
        session.sourceProgress.next_index ===
          session.intent.source_input.affected_skill_ids.length &&
        !session.sourceProgress.child_started &&
        childIndex < session.sourceProgress.next_index
      if (session.pendingActionKey !== undefined && !completing)
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
      completed:
        session.sourceProgress !== undefined && childIndex < session.sourceProgress.next_index,
      predecessor: (() => {
        const previous = session.predecessor
        if (previous === undefined || !("source_input" in previous.intent)) return undefined
        return Object.freeze({
          intent_json: canonicalSharedJson(previous.intent),
          source_id: previous.intent.owner.id,
          source_page_id: previous.owner_page_id,
          operation_id: previous.intent.operation_id,
          input_sha256: previous.intent.input_sha256,
          current_skill_id:
            previous.source_progress === undefined
              ? null
              : (previous.intent.source_input.affected_skill_ids[
                  previous.source_progress.next_index
                ] ?? null),
        })
      })(),
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
    const authorityTransfer = isCoordinated(plan) ? plan.authority_transfer : null
    const before = current === undefined ? [] : [current.index.main, ...current.index.files]
    const selected: ResolvedFile[] = [],
      ids = new Set<string>(),
      pages = new Set<string>()
    for (const file of plan.files) {
      const transfer =
        authorityTransfer !== null &&
        file.kind !== "preserve" &&
        file.file_id === authorityTransfer.request.file_id
          ? authorityTransfer
          : null
      const old =
        transfer !== null
          ? before.find((row) => row.page_id === transfer.target.page_id)
          : file.kind === "preserve"
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
      if (transfer !== null) {
        if (
          old === undefined ||
          old.file_id !== transfer.request.file_id ||
          old.skill_page_id !== transfer.target.skill_page_id ||
          old.path !== transfer.target.path ||
          old.page_id !== transfer.target.page_id
        )
          return yield* Effect.fail(
            invalid("The authority transfer changed its exact File binding."),
          )
        const actualHash = yield* sha256(canonicalSharedJson(old.content))
        const wantedHash = yield* sha256(canonicalSharedJson(file.content))
        if (actualHash !== transfer.target.content_sha256 && actualHash !== wantedHash)
          return yield* Effect.fail(
            invalid("The authority transfer observed another current Content."),
          )
      }
      if (
        isCoordinated(plan) &&
        file.kind !== "preserve" &&
        transfer === null &&
        old !== undefined &&
        (old.content.kind === "source"
          ? old.content.source_id !== plan.source.source_id
          : file.kind !== "source" || old.path !== file.path || old.file_id !== file.file_id)
      )
        return yield* Effect.fail(
          invalid("A Source cannot overwrite another Source or an unselected current File.", {
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
        if (authorityTransfer !== null) {
          const selected = retained.get(previous.page_id)
          if (
            previous.page_id === authorityTransfer.target.page_id
              ? selected === undefined || selected.input.kind === "preserve"
              : selected?.input.kind !== "preserve"
          )
            return yield* Effect.fail(
              invalid("A file authority intent must preserve every other current File."),
            )
          continue
        }
        if (
          previous.content.kind === "source" &&
          previous.content.source_id === plan.source.source_id
        )
          continue
        const replacement = retained.get(previous.page_id)
        if (
          replacement?.input.kind !== "preserve" &&
          !(
            previous.content.kind !== "source" &&
            replacement?.input.kind === "source" &&
            replacement.input.path === previous.path &&
            replacement.file_id === previous.file_id
          )
        )
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
    if ((!isCoordinated(plan) && !isPatch(plan)) || current === undefined) return
    const before = [current.index.main, ...current.index.files]
    const topologyChanged = before.some((old) => {
      const next = resolved.find((file) => file.page_id === old.page_id)
      return next === undefined || next.input.path !== old.path
    })
    // A Source-only path can disappear without changing the sparse page inventory.
    // Preserved author references must therefore use the full selected consumption tree.
    const otherSources =
      suppliedSources ??
      (yield* resolveCurrentSharedSources(library, {
        selections: plan.files.flatMap((file) =>
          topologyChanged && file.kind === "preserve" && file.content.kind === "source"
            ? [file.content]
            : [],
        ),
      }))
    const completePaths = isCoordinated(plan)
      ? plan.consumption_paths
      : plan.files.map((file) => file.path)
    const bodies: { path: string; bytes: Uint8Array }[] = []
    const native: NativeReferenceSource[] = []
    for (const file of plan.files) {
      if (
        file.kind !== "preserve" ||
        (file.content.kind !== "native" && !/\.(?:md|markdown)$/iu.test(file.path)) ||
        (file.content.kind === "source" && !topologyChanged)
      )
        continue
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
      (isPatch(plan) ? plan.scope.bindings : before)
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
function inspectPreparedCurrentSkillWrite(
  library: SharedLibrary,
  plan: PreparedCurrentSkillWrite | PreparedCurrentSkillPatch,
) {
  return Effect.gen(function* () {
    plan = yield* isPatch(plan) ? copyCurrentSkillPatch(plan) : copyValidatedCurrentSkillWrite(plan)
    const current = yield* loadCurrentTarget(library, yield* queryOwner(library, plan.skill_id)),
      selected = yield* resolveFiles(plan, current)
    if (isPatch(plan)) {
      const patch = plan
      yield* checked(() => assertPatchTarget(patch, current))
      yield* validatePreservedCoordinatedReferences(library, patch, current, selected)
    }
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
      replaces_complete_tree: !isPatch(plan),
      ...(isPatch(plan) ? { preserves_unselected_files: true } : {}),
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
export function inspectCurrentSkillWrite(library: SharedLibrary, plan: PreparedCurrentSkillWrite) {
  return inspectPreparedCurrentSkillWrite(library, plan)
}
export function inspectCurrentSkillPatch(library: SharedLibrary, plan: PreparedCurrentSkillPatch) {
  return inspectPreparedCurrentSkillWrite(library, plan)
}

export function inspectCoordinatedSkillWrite(
  library: SharedLibrary,
  input: PreparedCoordinatedSkillWrite,
  source: SourceSelection,
) {
  return Effect.gen(function* () {
    const plan = yield* copyCoordinatedPlan(input)
    yield* checked(() => assertCoordinatedSource(plan, source))
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
              : [current?.index.main, ...(current?.index.files ?? [])].some(
                    (before) =>
                      before !== undefined &&
                      before.page_id === file.page_id &&
                      before.content.kind !== "source" &&
                      file.input.kind === "source",
                  )
                ? "authority_replace"
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

function retainedCurrentResources(
  plan: CurrentWritePlan,
  resources: Effect.Success<ReturnType<typeof listCurrentOwnedResourceRecords>>,
) {
  return Effect.gen(function* () {
    const retained = new Set(
      plan.files.flatMap((file) =>
        file.content.kind === "resource" ? [file.content.object_id] : [],
      ),
    )
    // A preserved Source may retain a reading original with the same exact bytes.
    for (const file of plan.files) {
      if (file.kind !== "preserve" || file.content.kind !== "source") continue
      for (const row of resources) {
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
        retained.add(row.record.record_id)
      }
    }
    return retained
  })
}

function coordinatedDirectoryMatches(
  plan: PreparedCoordinatedSkillWrite,
  current: CurrentSkillIndex,
  inspected: Pick<
    Effect.Success<ReturnType<typeof inspectCoordinatedSkillWrite>>,
    "page_id" | "files"
  >,
) {
  if (
    current.skill_id !== plan.skill_id ||
    current.kind !== plan.kind ||
    current.state.state !== "ready" ||
    current.main.path !== plan.main ||
    (inspected.page_id !== null && current.page_id !== inspected.page_id) ||
    current.files.length + 1 !== plan.files.length
  )
    return false
  return [current.main, ...current.files].every((file) => {
    const desired = plan.files.find((entry) => entry.path === file.path)
    const before = inspected.files.find((entry) => entry.path === file.path)
    return (
      desired !== undefined &&
      desired.file_id === file.file_id &&
      canonicalSharedJson(desired.content) === canonicalSharedJson(file.content) &&
      (before?.page_id == null || before.page_id === file.page_id) &&
      (desired.kind !== "preserve" ||
        canonicalSharedJson(preservedBinding(file)) === canonicalSharedJson(desired.binding))
    )
  })
}

/** A complete observation may prove no work is needed. Explicit directory,
 * Origin or resource differences still require the ordinary guarded writer. */
export function inspectCoordinatedSkillDirectory(
  library: SharedLibrary,
  plan: PreparedCoordinatedSkillWrite,
  source: SourceSelection & { readonly page_id: string },
  target: CurrentSkillIndex,
  inspected: Pick<
    Effect.Success<ReturnType<typeof inspectCoordinatedSkillWrite>>,
    "page_id" | "files"
  >,
) {
  return Effect.gen(function* () {
    yield* checked(() => assertCoordinatedSource(plan, source))
    if (plan.authority_transfer !== null)
      return yield* Effect.fail(
        invalid("An authority transfer requires its original child writer."),
      )
    if (!coordinatedDirectoryMatches(plan, target, inspected)) return undefined
    const raw = yield* (yield* Notion).request(`v1/pages/${target.page_id}`)
    yield* checked(() => livePage(raw, target.page_id, library.skills.data_source_id))
    const current = yield* queryCurrentSkillIndex(library, target.page_id, raw, target.files)
    yield* checked(() => {
      if (!coordinatedDirectoryMatches(plan, current, inspected))
        throw invalid("The observed Source target changed its owner or complete directory.")
    })
    const sources = yield* resolveCurrentSharedSources(library, {
      selections: plan.consumption_sources.filter(
        (selected) => selected.source_id !== source.source_id,
      ),
    })
    const origins = new Map<string, SourceSelection & { readonly page_id: string }>(sources)
    if (plan.consumption_sources.some((selected) => selected.source_id === source.source_id))
      origins.set(source.source_id, source)
    for (const selected of origins.values()) yield* checked(() => assertSourceFiles(plan, selected))
    const originMatches = yield* checked(() =>
      fieldsMatch(raw, {
        [binding(library, "skills", "Origin")]: {
          relation: [...origins.values()].map((selected) => ({ id: selected.page_id })),
        },
      }),
    )
    if (!originMatches) return undefined
    const resources = yield* listCurrentOwnedResourceRecords(library, {
      kind: "skill",
      page_id: current.page_id,
    })
    const retained = yield* retainedCurrentResources(plan, resources)
    if (resources.some((row) => !retained.has(row.record.record_id))) return undefined
    const pending = yield* readCurrentOperationIntent(library, { kind: "skill", id: plan.skill_id })
    if (pending !== undefined)
      return yield* Effect.fail(
        fail(
          "CURRENT_OPERATION_PENDING",
          "A ready Source target still has an unfinished current intent.",
          {
            skill_id: plan.skill_id,
            operation_id: pending.intent.operation_id,
            owner_page_id: pending.owner_page_id,
          },
        ),
      )
    return current
  })
}

/** A completed prefix or final result must already satisfy the entire directory. */
export function verifyCoordinatedSkillDirectory(
  ...args: Parameters<typeof inspectCoordinatedSkillDirectory>
) {
  return inspectCoordinatedSkillDirectory(...args).pipe(
    Effect.flatMap((current) =>
      current === undefined
        ? Effect.fail(
            invalid(
              "The completed Source target differs from its exact directory, Origin or retained resources.",
            ),
          )
        : Effect.succeed(current),
    ),
  )
}

type CurrentWriteRequest = {
  readonly plan: PreparedCurrentSkillWrite
  readonly operation_id: string
  readonly mode?: CurrentWriteMode
  readonly create_only?: true
}
type InternalWriteRequest = Omit<CurrentWriteRequest, "plan"> & {
  readonly plan: CurrentWritePlan
  readonly authorization?: CurrentSourceSkillAuthorization
  readonly completedNativeTransfer?: true
  readonly supersedingSourceChild?: {
    readonly previous: CurrentSourceIntentBinding
    readonly next: CurrentSourceIntentBinding
  }
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
export function writeCurrentSkillPatch(
  library: SharedLibrary,
  input: Omit<CurrentWriteRequest, "plan" | "create_only"> & {
    readonly plan: PreparedCurrentSkillPatch
  },
) {
  return Effect.gen(function* () {
    const plan = yield* copyCurrentSkillPatch(input.plan)
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
    let mode = input.mode
    let supersedingSourceChild: InternalWriteRequest["supersedingSourceChild"]
    const completedNativeTransfer =
      grant.completed &&
      plan.authority_transfer !== null &&
      plan.authority_transfer.request.action.kind === "takeover" &&
      plan.authority_transfer.request.action.to === "native"
    const pending =
      grant.predecessor !== undefined || completedNativeTransfer
        ? yield* readCurrentOperationIntent(library, { kind: "skill", id: plan.skill_id })
        : undefined
    if (completedNativeTransfer && pending !== undefined)
      return yield* Effect.fail(
        invalid("A completed native transfer still has an unfinished child intent."),
      )
    if (grant.predecessor !== undefined) {
      if (pending !== undefined && pending.intent.operation_id !== input.operation_id) {
        const previous = grant.predecessor
        const oldChildOperation =
          "source-target-" +
          (yield* sha256(canonicalSharedJson([previous.operation_id, plan.skill_id])))
        const old = "source" in pending.intent ? pending.intent.source : undefined
        const authorizationHash = yield* sha256(
          canonicalSharedJson({
            parent: JSON.parse(previous.intent_json),
            page_id: grant.source.page_id,
            skill_id: plan.skill_id,
            input_sha256: pending.intent.input_sha256,
          }),
        )
        if (
          previous.current_skill_id !== plan.skill_id ||
          previous.source_page_id !== grant.source.page_id ||
          pending.intent.operation_id !== oldChildOperation ||
          old === undefined ||
          old.source_id !== previous.source_id ||
          old.source_page_id !== previous.source_page_id ||
          old.operation_id !== previous.operation_id ||
          old.input_sha256 !== previous.input_sha256 ||
          old.authorization_sha256 !== authorizationHash
        )
          return yield* Effect.fail(
            invalid("The previous Source intent does not authorize this unfinished child."),
          )
        mode = { kind: "supersede", operation_id: oldChildOperation }
        supersedingSourceChild = { previous: old, next: grant.source_intent }
      } else if (pending?.intent.operation_id === input.operation_id) {
        if (pending.intent.input_sha256 !== plan.input_sha256)
          return yield* Effect.fail(
            invalid("The selected Source child has a different frozen input."),
          )
        mode = "resume"
      }
    }
    return yield* executeCurrentSkillWrite(library, {
      ...input,
      plan,
      mode,
      ...(supersedingSourceChild === undefined ? {} : { supersedingSourceChild }),
      ...(completedNativeTransfer ? { completedNativeTransfer: true } : {}),
    })
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
      if (input.supersedingSourceChild !== undefined && input.authorization === undefined)
        throw invalid("Only the exact parent Source may supersede its child intent.")
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
      ...(isPatch(plan) ? { skill_action: { kind: "update" as const, scope: plan.scope } } : {}),
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
    if (isPatch(plan)) yield* checked(() => assertPatchTarget(plan, current))
    if (input.create_only === true && current !== undefined) {
      const pending =
        input.mode === "resume"
          ? yield* inspectCurrentOperation(library, { kind: "skill", id: plan.skill_id })
          : undefined
      // An accepted CREATE can exist before its ACK binds the physical owner.
      // The unique page must still carry the original in-flight creation marker.
      const unboundCreation =
        pending?.owner_page_id === null &&
        pending.in_flight?.key === "skill:create" &&
        current.index.state.state === "applying" &&
        current.index.state.operation_id === input.operation_id
      if (
        pending === undefined ||
        pending.intent.operation_id !== input.operation_id ||
        pending.intent.input_sha256 !== plan.input_sha256 ||
        (pending.owner_page_id !== current.index.page_id && !unboundCreation)
      )
        return yield* Effect.fail(
          fail(
            "CURRENT_SKILL_EXISTS",
            "This stable Skill already exists. Use an explicit update to change its content.",
            { skill_id: plan.skill_id, page_id: current.index.page_id },
          ),
        )
    }
    const resolved = yield* resolveFiles(plan, current)
    if (input.completedNativeTransfer) {
      const transfer = isCoordinated(plan) ? plan.authority_transfer : null
      const selected =
        transfer === null
          ? undefined
          : resolved.find((file) => file.file_id === transfer.request.file_id)
      const observed =
        current === undefined
          ? undefined
          : [current.index.main, ...current.index.files].find(
              (file) => file.page_id === transfer?.target.page_id,
            )
      if (
        input.authorization?.completed !== true ||
        transfer === null ||
        current?.index.state.state !== "ready" ||
        selected?.input.kind !== "native" ||
        observed === undefined ||
        observed.file_id !== selected.file_id ||
        canonicalSharedJson(observed.content) !== canonicalSharedJson(selected.input.content)
      )
        return yield* Effect.fail(
          invalid(
            "The completed native transfer no longer owns this exact current authoring surface.",
          ),
        )
    }
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
      ...(current !== undefined
        ? { owner: { page_id: current.index.page_id, raw: current.raw } }
        : {}),
    })
    const writableFiles = writablePlanFiles(plan.files)
    const sourceSelections = isCoordinated(plan)
      ? plan.consumption_sources
      : plan.files.flatMap((file) => (file.content.kind === "source" ? [file.content] : []))
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
    // Source originals remain at their selected provider. Only Notion-owned
    // resources need durable resource records before the Skill becomes ready.
    const resourceFiles = writableFiles.filter(
      (file): file is Extract<PreparedCurrentWriteFile, { kind: "resource" }> =>
        file.kind === "resource",
    )
    const validatePreservedReferences = validatePreservedCoordinatedReferences(
      library,
      plan,
      current,
      resolved,
      otherSources,
    )
    const assertCoordinatedScope = Effect.gen(function* () {
      if (input.authorization === undefined && !isPatch(plan)) return
      if (input.authorization !== undefined) yield* input.authorization.assertCurrent
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
    const nativeVerified = new Map<string, "exact" | "normalized" | "current">()
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
            ...(!isPatch(plan) || plan.metadata.name !== undefined
              ? {
                  [binding(library, "skills", "Name")]: { title: currentRecordText(plan.name) },
                }
              : {}),
            ...(!isPatch(plan) || plan.metadata.description !== undefined
              ? {
                  [binding(library, "skills", "Description")]: {
                    rich_text: currentRecordText(plan.description),
                  },
                }
              : {}),
            ...(!isPatch(plan)
              ? { [binding(library, "skills", "Kind")]: { select: { name: plan.kind } } }
              : {}),
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
      ...(!isPatch(plan)
        ? {
            [binding(library, "skills", "Origin")]: {
              relation: [...sources.values()].map((source) => ({ id: source.page_id })),
            },
          }
        : {}),
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
    const verifyCurrentDirectory = (
      final: CurrentSkillIndex,
      raw: unknown,
      pages: ReadonlyMap<string, string>,
      operationId: string,
    ) =>
      Effect.gen(function* () {
        const verdict = yield* checked(() =>
          assertCurrentDirectory(final, raw, pages, operationId),
        ).pipe(Effect.result)
        if (verdict._tag === "Success") return
        if (
          verdict.failure.message !==
            "The current owner or complete directory differs from the intended tree." &&
          verdict.failure.message !== "The current File locator differs from the verified tree."
        )
          return yield* Effect.fail(verdict.failure)
        const wantedFields = fieldsForSkill(false)
        const actualFields = Object.entries(property(property(raw).properties))
        const fields = yield* Effect.forEach(Object.entries(wantedFields), ([id, wanted]) =>
          Effect.gen(function* () {
            const matches = actualFields.flatMap(([key, value]) =>
              key === id || property(value).id === id ? [value] : [],
            )
            const checkedField = yield* checked(() => fieldsMatch(raw, { [id]: wanted })).pipe(
              Effect.result,
            )
            return {
              property_id: id,
              matches: checkedField._tag === "Success" ? checkedField.success : false,
              complete: matches.length === 1 && property(matches[0]).has_more !== true,
              expected_sha256: yield* sha256(canonicalSharedJson(wanted)),
              actual_sha256: yield* sha256(canonicalSharedJson(matches)),
            }
          }),
        )
        const expected = yield* Effect.forEach(plan.files, (file) =>
          Effect.gen(function* () {
            return {
              path: file.path,
              page_id: pages.get(file.path) ?? null,
              file_id: resolved.find((item) => item.input.path === file.path)?.file_id ?? null,
              content_sha256: yield* sha256(canonicalSharedJson(file.content)),
            }
          }),
        )
        const actual = yield* Effect.forEach([final.main, ...final.files], (file) =>
          Effect.gen(function* () {
            return {
              path: file.path,
              page_id: file.page_id,
              file_id: file.file_id,
              content_sha256: yield* sha256(canonicalSharedJson(file.content)),
            }
          }),
        )
        const sort = (
          bindings: readonly {
            readonly path: string
            readonly page_id: string | null
            readonly file_id: string | null
            readonly content_sha256: string
          }[],
        ) =>
          [...bindings].sort((a, b) => canonicalSharedJson(a).localeCompare(canonicalSharedJson(b)))
        const intended = sort(expected),
          observed = sort(actual)
        const expectedRows = new Set(intended.map(canonicalSharedJson)),
          actualRows = new Set(observed.map(canonicalSharedJson))
        const missing = intended.filter((row) => !actualRows.has(canonicalSharedJson(row))),
          unexpected = observed.filter((row) => !expectedRows.has(canonicalSharedJson(row)))
        return yield* Effect.fail(
          invalid(verdict.failure.message, {
            ...property(verdict.failure.details),
            verification: {
              stage: "complete-current-directory",
              expected: {
                skill_id: plan.skill_id,
                main_file_id: main.file_id,
                operation_id: operationId,
                files: intended.length,
                directory_sha256: yield* sha256(canonicalSharedJson(intended)),
              },
              actual: {
                skill_id: final.skill_id,
                main_file_id: final.main.file_id,
                state: final.state,
                files: observed.length,
                directory_sha256: yield* sha256(canonicalSharedJson(observed)),
              },
              properties: fields.filter((field) => !field.matches),
              directory: {
                missing: missing.slice(0, 50),
                unexpected: unexpected.slice(0, 50),
                omitted: Math.max(0, missing.length - 50) + Math.max(0, unexpected.length - 50),
              },
            },
          }),
        )
      })
    let finalPages = new Map<string, string>()
    const operation = {
      intent: {
        operation_id: input.operation_id,
        owner: { kind: "skill" as const, id: plan.skill_id },
        input_sha256: plan.input_sha256,
        ...(isPatch(plan) ? { skill_action: { kind: "update" as const, scope: plan.scope } } : {}),
        ...(input.authorization === undefined ? {} : { source: input.authorization.source_intent }),
      },
      ownerPageId: current?.index.page_id ?? null,
      mode: input.mode,
      ...(isPatch(plan) ? { assertScope: assertCoordinatedScope } : {}),
      ...(input.supersedingSourceChild === undefined
        ? {}
        : {
            supersedingSourceChild: input.supersedingSourceChild,
          }),
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
            get ownerRetired() {
              return session.ownerRetired
            },
            get predecessor() {
              return session.predecessor
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
          // Coordinated and partial writes recheck the selected binding after a
          // missing observation, immediately before destructive or replacing
          // actions, so an unrelated authority change survives.
          const assertCoordinatedBinding = (
            page: string,
            wanted?: ResolvedFile,
            retiring = false,
            actionKey?: string,
          ) =>
            Effect.gen(function* () {
              if (input.authorization === undefined && !isPatch(plan)) return
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
                    invalid("The current Skill no longer belongs to this selected write."),
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
              if (isPatch(plan)) {
                const original = plan.scope.bindings.find((file) => file.page_id === page)
                const staged = `.ntn-current-${yield* sha256(canonicalSharedJson([input.operation_id, observed.file_id]))}.pending`
                const candidates = [
                  ...(original === undefined ? [] : [original]),
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
                if (
                  observed.content.kind === "source" ||
                  (retiring && (original === undefined || !plan.remove.includes(original.path))) ||
                  !candidates.some(
                    (expected) =>
                      expected.file_id === observed.file_id &&
                      (expected.path === observed.path ||
                        (page !== created && observed.path === staged)) &&
                      canonicalSharedJson(expected.content) ===
                        canonicalSharedJson(observed.content),
                  )
                )
                  return yield* Effect.fail(
                    invalid("The selected patch File identity or authority changed.", {
                      page_id: page,
                      file_id: observed.file_id,
                    }),
                  )
                if (
                  wanted?.input.kind === "preserve" &&
                  canonicalSharedJson(preservedBinding(observed)) !==
                    canonicalSharedJson(wanted.input.binding)
                )
                  return yield* Effect.fail(invalid("The preserved patch File binding changed."))
                return
              }
              if (input.authorization === undefined)
                return yield* Effect.fail(
                  invalid("A coordinated File needs its Source authorization."),
                )
              const transfer = isCoordinated(plan) ? plan.authority_transfer : null
              if (transfer !== null && page === transfer.target.page_id) {
                if (
                  retiring ||
                  wanted === undefined ||
                  wanted.input.kind === "preserve" ||
                  observed.skill_page_id !== transfer.target.skill_page_id ||
                  observed.file_id !== transfer.request.file_id ||
                  observed.path !== transfer.target.path
                )
                  return yield* Effect.fail(
                    invalid("The selected authority-transfer File changed."),
                  )
                const actualHash = yield* sha256(canonicalSharedJson(observed.content))
                const wantedHash = yield* sha256(canonicalSharedJson(wanted.input.content))
                if (actualHash !== transfer.target.content_sha256 && actualHash !== wantedHash)
                  return yield* Effect.fail(
                    invalid("Another actor changed the selected authority."),
                  )
                if (
                  transfer.target.native_sha256 !== null &&
                  (actionKey === `file:${observed.file_id}:properties` ||
                    actionKey === "skill:properties")
                ) {
                  const body = yield* observeSharedBody(page)
                  if (body.fingerprint.sha256 !== transfer.target.native_sha256)
                    return yield* Effect.fail(
                      fail(
                        "CURRENT_NATIVE_CHANGED",
                        "The native author body changed after selecting this authority transfer.",
                        {
                          file_id: observed.file_id,
                          page_id: page,
                        },
                      ),
                    )
                }
              } else if (wanted?.input.kind === "preserve") {
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
                  (observed.content.kind === "source" &&
                    observed.content.source_id !== input.authorization.source.source_id) ||
                  (!(trashed && retiring && candidates.length === 0) &&
                    !candidates.some(
                      (expected) =>
                        (expected.content.kind !== "source" ||
                          expected.content.source_id === input.authorization!.source.source_id) &&
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
                          ? assertCoordinatedBinding(page, wanted, false, action.key)
                          : Effect.void,
                      ),
                    ),
              })
          const assertCoordinatedResourceRetirement = Effect.gen(function* () {
            if (input.authorization === undefined && !isPatch(plan)) return
            const raw = yield* session.assertCurrent(),
              latestFiles = yield* queryFilePages(library, created)
            const latest = yield* queryCurrentSkillIndex(
              library,
              created,
              raw,
              [...latestFiles.values()].map((row) => row.file),
            )
            yield* verifyCurrentDirectory(latest, raw, filePages, session.operation_id)
            if (input.authorization !== undefined) yield* input.authorization.assertCurrent
          })
          const resources = new Map(
            (yield* listCurrentOwnedResourceRecords(library, owner)).map((row) => [
              row.record.record_id,
              row,
            ]),
          )
          const verifiedResources = new Set<string>(),
            uploadScope = makeCurrentUploadScope(managedSession)
          const desiredResources = yield* retainedCurrentResources(plan, [...resources.values()])
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
            }
            verifiedResources.add(file.content.object_id)
          }
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
          // Generated source/resource reading bodies are a separate management
          // operation. Only authored native bodies participate in this commit.
          for (const file of writableFiles) {
            const page = filePages.get(file.path)!
            if (file.kind === "native") {
              let corrections: readonly CurrentNativePlainTextTarget[] | undefined
              const observe = () =>
                Effect.gen(function* () {
                  const body = yield* observeSharedBody(page)
                  const comparison = yield* checked(() =>
                    compareNativeMarkdown({ expected: file.markdown, observed: body.markdown }),
                  )
                  corrections = undefined
                  if (
                    input.completedNativeTransfer !== true &&
                    /\.(?:md|markdown)$/iu.test(file.path) &&
                    (comparison === "different" ||
                      session.pendingActionKey?.startsWith(`native:${page}:plain:`))
                  ) {
                    const groups = yield* checked(() =>
                      nativePlainTextPlan({ expected: file.markdown, observed: body.markdown }),
                    )
                    if (groups !== undefined) {
                      corrections = yield* planCurrentNativePlainText({
                        page,
                        groups,
                        pendingAction: session.pendingActionKey,
                      })
                      // The Markdown action has completed its structure stage. A
                      // plain-span correction is still pending in this same intent.
                      // Only the final strict read below verifies authored content.
                      return { status: "complete", value: undefined } as const
                    }
                  }
                  if (comparison === "different" && input.completedNativeTransfer !== true)
                    return { status: "missing" } as const
                  nativeVerified.set(file.path, comparison === "different" ? "current" : comparison)
                  return { status: "complete", value: undefined } as const
                })
              yield* coordinatedDispatch(
                resolved.find((selected) => selected.input.path === file.path)!,
                page,
              )({
                key: `native:${page}:body`,
                replay: "idempotent",
                request: {
                  path: `v1/pages/${page}/markdown`,
                  body: {
                    markdown_version: "v2",
                    type: "replace_content",
                    replace_content: { new_str: nativeFileTransport(file) },
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
                          "The complete Notion body differs from the intended native Markdown structure, text, code or links. The current intent remains pending.",
                          { path: file.path },
                        ),
                      )
                  }),
              })
              if (corrections !== undefined) {
                yield* applyCurrentNativePlainText({
                  page,
                  targets: corrections,
                  dispatch: coordinatedDispatch(
                    resolved.find((selected) => selected.input.path === file.path)!,
                    page,
                  ),
                })
                const body = yield* observeSharedBody(page)
                const comparison = yield* checked(() =>
                  compareNativeMarkdown({ expected: file.markdown, observed: body.markdown }),
                )
                if (comparison === "different")
                  return yield* Effect.fail(
                    fail(
                      "CURRENT_NATIVE_ROUNDTRIP",
                      "The complete corrected native body still differs from the original author intent. The current intent remains pending.",
                      { path: file.path },
                    ),
                  )
                nativeVerified.set(file.path, comparison)
              }
              continue
            }
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
                    const raw = yield* api.request(`v1/pages/${page}`)
                    const trashed = yield* check(raw)
                    if (!trashed) {
                      if (role === "file") {
                        const file = yield* checked(() =>
                          currentFileRecord(
                            raw,
                            created,
                            library.files.data_source_id,
                            library.files.property_ids,
                          ),
                        )
                        if (file.content.kind === "native")
                          yield* assertCurrentBodyReplaceable(page)
                        yield* assertCoordinatedBinding(page, undefined, true)
                      } else yield* assertCoordinatedResourceRetirement
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
          // Desired exact resources and native bodies are verified before any
          // unreferenced Notion-owned original is removed.
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
          const raw =
            session.predecessor === undefined
              ? yield* api.request(`v1/pages/${value.page_id}`)
              : yield* queryOwner(library, plan.skill_id)
          if (raw === undefined || exactId(property(raw).id) !== value.page_id)
            return yield* Effect.fail(
              invalid("The stable Skill identity changed before completion."),
            )
          const files = yield* queryFilePages(library, value.page_id)
          const final = yield* queryCurrentSkillIndex(
            library,
            value.page_id,
            raw,
            [...files.values()].map((row) => row.file),
          )
          yield* verifyCurrentDirectory(final, raw, finalPages, session.operation_id)
          yield* verifyCurrentRelations(library, relations, value.page_id, raw)
          if (input.authorization !== undefined || isPatch(plan)) {
            yield* validatePreservedReferences
            if (input.authorization !== undefined) yield* input.authorization.assertCurrent
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
      native: {
        verified: [...nativeVerified.values()].filter((comparison) => comparison !== "current")
          .length,
        normalized_paths: [...nativeVerified]
          .filter(([, comparison]) => comparison === "normalized")
          .map(([path]) => path),
      },
      relations: currentRelationsInfo(relations),
      state: "ready",
      request_metrics: api.requestMetrics?.(),
    }
  })
}
