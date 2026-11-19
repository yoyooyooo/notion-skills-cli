import { posix } from "node:path"
import { Crypto, Effect, Schema } from "effect"
import { authScope } from "./catalog.ts"
import { invalidateSnapshotCache, invalidateSubscriptionCatalog } from "./cache.ts"
import { fail, listSchema, property, SkillsError, text } from "./model.ts"
import { Notion } from "./notion.ts"
import { pageId } from "./ref.ts"
import { withCurrentInvocationBudget } from "./shared-current-invocation.ts"
import { sharedSkillId, sharedSkillTextProperty } from "./shared-content.ts"
import {
  currentFileRecord,
  queryCurrentSkillIndex,
  type CurrentFileBinding,
} from "./shared-current-index.ts"
import {
  currentOperationFailure,
  currentOperationOwnerState,
  withCurrentSkillOperation,
  type CurrentOperationSession,
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
import { resolveCurrentSharedSources } from "./shared-current-source.ts"
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
  currentWriteIdentity,
  type PreparedCurrentSkillWrite,
  type PreparedCurrentWriteFile,
} from "./shared-current-write-input.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { observeSharedBody } from "./shared-page-body.ts"
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
type ResolvedFile = {
  readonly input: PreparedCurrentWriteFile
  readonly file_id: string
  readonly page_id?: string
}
type UploadHandle = Effect.Success<ReturnType<typeof uploadCurrentSharedResource>>
function resolveFiles(plan: PreparedCurrentSkillWrite, current?: Target) {
  return Effect.gen(function* () {
    const before = current === undefined ? [] : [current.index.main, ...current.index.files]
    const selected: ResolvedFile[] = [],
      ids = new Set<string>(),
      pages = new Set<string>()
    for (const file of plan.files) {
      const old =
        file.path === plan.main
          ? current?.index.main
          : file.file_id === undefined
            ? before.find((row) => row.path === file.path && row.page_id !== current?.index.page_id)
            : before.find(
                (row) => row.file_id === file.file_id && row.page_id !== current?.index.page_id,
              )
      const id =
        file.file_id ??
        old?.file_id ??
        "file-" + (yield* sha256(canonicalSharedJson([plan.skill_id, file.path])))
      yield* checked(() => {
        if (old !== undefined && file.file_id !== undefined && old.file_id !== file.file_id)
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
    return selected
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
        bytes: file.input.bytes.byteLength,
        sha256: file.input.sha256,
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

type CurrentWriteRequest = {
  readonly plan: PreparedCurrentSkillWrite
  readonly operation_id: string
  readonly mode?: "apply" | "resume"
}
/** One complete current-tree write, followed by reachability cleanup. No older
 * pointer, completion receipt or version chain is consulted or produced. */
export function writeCurrentSkill(library: SharedLibrary, input: CurrentWriteRequest) {
  return Effect.gen(function* () {
    const plan = yield* copyValidatedCurrentSkillWrite(input.plan)
    yield* checked(() => {
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
      skill_id: plan.skill_id,
      input_sha256: plan.input_sha256,
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
  input: CurrentWriteRequest,
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
    const sourceFiles = plan.files.filter((file) => file.kind === "source")
    const resourceMedia = new Map<string, Set<string>>()
    for (const file of plan.files)
      if (file.kind === "resource") {
        const types = resourceMedia.get(file.content.object_id) ?? new Set<string>()
        types.add(currentUploadFileSpec(file.path).contentType)
        resourceMedia.set(file.content.object_id, types)
      }
    const imagePreview = (file: PreparedCurrentWriteFile) =>
      file.kind !== "resource" || resourceMedia.get(file.content.object_id)?.size === 1
    const sources = yield* resolveCurrentSharedSources(library, {
      selections: sourceFiles.map((file) => file.content),
    })
    for (const file of sourceFiles) {
      const source = sources.get(file.content.source_id),
        declared = source?.manifest.find((item) => item.path === file.content.source_path)
      if (
        declared === undefined ||
        declared.sha256 !== file.sha256 ||
        declared.bytes !== file.bytes.byteLength ||
        declared.mode !== file.mode
      )
        return yield* Effect.fail(
          invalid("Supplied Source bytes differ from its complete current manifest.", {
            path: file.path,
          }),
        )
    }
    let changed = false,
      cacheInvalidated = false
    const invalidate = Effect.gen(function* () {
      if (cacheInvalidated) return
      const scope = yield* authScope
      yield* invalidateSubscriptionCatalog(scope, library.skills.database_id)
      yield* invalidateSnapshotCache(sharedSkillId(library.library_id, plan.skill_id), scope)
      cacheInvalidated = true
    })
    const api = yield* Notion
    const fieldsForSkill = (creating: boolean): Record<string, unknown> => ({
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
      [binding(library, "skills", "Skill ID")]: { rich_text: currentRecordText(plan.skill_id) },
      [binding(library, "skills", "Main File ID")]: { rich_text: currentRecordText(main.file_id) },
      [binding(library, "skills", "Content")]: {
        rich_text: currentRecordText(canonicalSharedJson(main.input.content)),
      },
      ...(library.skills.property_ids.Origin === undefined
        ? {}
        : {
            [library.skills.property_ids.Origin]: {
              relation: [...sources.values()].map((source) => ({ id: source.page_id })),
            },
          }),
      ...(creating
        ? {
            [binding(library, "skills", "Current State")]: { select: { name: "applying" } },
            [binding(library, "skills", "Operation")]: {
              rich_text: currentRecordText(input.operation_id),
            },
          }
        : {}),
    })
    let finalPages = new Map<string, string>()
    const result = yield* withCurrentSkillOperation(library, {
      intent: {
        operation_id: input.operation_id,
        skill_id: plan.skill_id,
        input_sha256: plan.input_sha256,
      },
      skillPageId: current?.index.page_id ?? null,
      mode: input.mode,
      run: (session) =>
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
            get skillPageId() {
              return session.skillPageId
            },
            get pendingActionKey() {
              return session.pendingActionKey
            },
            operation_id: session.operation_id,
            skill_id: session.skill_id,
            bindSkill: session.bindSkill,
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
          if (session.skillPageId === null) yield* session.bindSkill(created)
          else if (session.skillPageId !== created)
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
          const desiredResources = new Set(
            plan.files.flatMap((file) =>
              file.kind === "resource" ? [file.content.object_id] : [],
            ),
          )
          for (const file of plan.files) {
            if (file.kind !== "resource" || verifiedResources.has(file.content.object_id)) continue
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
                  return found.path === staged || found.path === selected?.input.path
                    ? ({ status: "complete", value: undefined } as const)
                    : ({ status: "missing" } as const)
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
            yield* dispatch({
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
          yield* dispatch({
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
          for (const candidate of plan.files) {
            if (
              candidate.kind !== "resource" ||
              !isCurrentProjectionBinary(candidate.path, candidate.bytes) ||
              checkedBinaryResources.has(candidate.content.object_id)
            )
              continue
            checkedBinaryResources.add(candidate.content.object_id)
            const siblings = plan.files.filter(
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
            const original = plan.files.find(
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
          for (const file of plan.files) {
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
            const resource = file.kind === "resource" ? file : undefined
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
              dispatch,
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
                    if (!trashed) yield* assertCurrentBodyReplaceable(page)
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
      verify: (session, value) =>
        Effect.gen(function* () {
          const raw = yield* api.request(`v1/pages/${value.page_id}`),
            files = yield* queryFilePages(library, value.page_id)
          const final = yield* queryCurrentSkillIndex(
            library,
            value.page_id,
            raw,
            [...files.values()].map((row) => row.file),
          )
          const expected = new Map(plan.files.map((file) => [file.path, file]))
          if (
            final.skill_id !== plan.skill_id ||
            final.main.file_id !== main.file_id ||
            !fieldsMatch(raw, fieldsForSkill(false)) ||
            final.files.length + 1 !== expected.size ||
            (final.state.state !== "ready" && final.state.operation_id !== session.operation_id)
          )
            return yield* Effect.fail(
              invalid(
                "The final current owner or complete directory differs from the intended tree.",
              ),
            )
          for (const file of [final.main, ...final.files]) {
            const desired = expected.get(file.path)
            if (
              desired === undefined ||
              finalPages.get(file.path) !== file.page_id ||
              resolved.find((item) => item.input.path === file.path)?.file_id !== file.file_id ||
              canonicalSharedJson(desired.content) !== canonicalSharedJson(file.content)
            )
              return yield* Effect.fail(
                invalid("The final current File locator differs from the verified tree.", {
                  path: file.path,
                }),
              )
          }
          yield* verifyCurrentRelations(library, relations, value.page_id, raw)
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
