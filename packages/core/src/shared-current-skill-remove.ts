import { Crypto, Effect, Schema } from "effect"
import { fail, property, SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import { pageId } from "./ref.ts"
import { sharedRecordFromPage } from "./shared-content.ts"
import {
  currentFileRecord,
  queryCurrentSkillIndex,
  readCurrentSkillMetadata,
  type CurrentFileBinding,
} from "./shared-current-index.ts"
import { withCurrentInvocationBudget } from "./shared-current-invocation.ts"
import {
  currentOperationFailure,
  readCurrentOperationIntent,
  withCurrentOperation,
  type CurrentOperationIntent,
  type CurrentOperationSession,
} from "./shared-current-operation.ts"
import {
  currentOwnedResourceFromPage,
  listCurrentOwnedResourceRecords,
} from "./shared-current-records.ts"
import {
  CurrentSkillRemovalInputSchema,
  type CurrentSkillRemovalInput,
} from "./shared-current-skill-remove-input.ts"
import {
  assertCurrentSkillPage,
  assertNoCurrentSourceContribution,
  currentSkillField,
  currentSkillProperty,
  currentSkillText,
  queryCurrentSkillIdentity,
  queryCurrentTablePages,
  resolveCurrentSkillPage,
} from "./shared-current-skill-target.ts"
import { currentWriteIdentity } from "./shared-current-write-input.ts"
import { validateSharedRelationField } from "./shared-library.ts"
import type { SharedLibrary, SharedSkillRelationField } from "./shared-library-model.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { completeSharedSkillRelationIds } from "./shared-router-members.ts"
import { sha256 } from "./store.ts"

type Options = {
  readonly target: string
  readonly operation_id?: string
  readonly mode?: "auto" | "apply" | "resume"
  readonly dry_run?: boolean
}
type RemovalIntent = Extract<CurrentOperationIntent, { readonly skill_action: unknown }> & {
  readonly skill_action: CurrentSkillRemovalInput
}
type Relation = CurrentSkillRemovalInput["relations"][number]
type File = CurrentSkillRemovalInput["files"][number]
type Resource = CurrentSkillRemovalInput["resources"][number]
const fields = ["Members", "Requires"] as const
const invalid = (message: string, details?: unknown) =>
  fail("CURRENT_SKILL_REMOVE_CONFLICT", message, details)
const checked = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (error) =>
      error instanceof SkillsError ? error : invalid("Invalid current Skill removal."),
  })
const isTrashed = (raw: unknown) => {
  const row = property(raw)
  return row.in_trash === true || row.archived === true || row.is_archived === true
}
const live = (raw: unknown) => ({
  ...property(raw),
  in_trash: false,
  archived: false,
  is_archived: false,
})
const same = (left: unknown, right: unknown) =>
  canonicalSharedJson(left) === canonicalSharedJson(right)
const contentHash = (file: CurrentFileBinding) => sha256(canonicalSharedJson(file.content))
const ordered = (ids: readonly string[]) => [...ids].sort()

function assertNotionOwner(library: SharedLibrary, raw: unknown) {
  const origin = currentSkillField(library, "skills", raw, "Origin", "relation")
  if (!Array.isArray(origin.relation) || origin.has_more === true || origin.relation.length !== 0)
    throw fail(
      "CURRENT_SOURCE_MANAGEMENT_REQUIRED",
      "Remove Source ownership before deleting this Skill.",
    )
  if (
    library.skills.property_ids["Source Member"] !== undefined &&
    currentSkillText(library, "skills", raw, "Source Member") !== ""
  )
    throw fail(
      "CURRENT_SOURCE_MANAGEMENT_REQUIRED",
      "This Skill still has a Source member binding.",
    )
}

function readOwner(library: SharedLibrary, raw: unknown, page: string) {
  return Effect.gen(function* () {
    yield* checked(() => {
      assertCurrentSkillPage(library, "skills", raw, page, true)
      assertNotionOwner(library, raw)
    })
    const owner = yield* readCurrentSkillMetadata(library, page, live(raw))
    if (owner.main.content.kind === "source")
      return yield* Effect.fail(
        fail(
          "CURRENT_SOURCE_MANAGEMENT_REQUIRED",
          "Source-backed Skills require Source management.",
        ),
      )
    const hash = yield* sha256(
      canonicalSharedJson({
        skill_id: owner.skill_id,
        page_id: owner.page_id,
        kind: owner.kind,
        name: owner.name,
        description: owner.description,
        enabled: owner.enabled,
        default_context: owner.default_context,
        main: { file_id: owner.main.file_id, path: owner.main.path, content: owner.main.content },
      }),
    )
    return { owner, hash, trashed: isTrashed(raw) }
  })
}

function relationValues(library: SharedLibrary, raw: unknown, field: SharedSkillRelationField) {
  return Effect.gen(function* () {
    const page = yield* checked(() => assertCurrentSkillPage(library, "skills", raw))
    const metadata = yield* readCurrentSkillMetadata(library, page, raw)
    if (
      metadata.state.state !== "ready" ||
      (yield* readCurrentOperationIntent(library, { kind: "skill", id: metadata.skill_id })) !==
        undefined
    )
      return yield* Effect.fail(
        invalid("A referring Skill has unfinished work.", { page_id: page, field }),
      )
    const unique = yield* queryCurrentSkillIdentity(library, metadata.skill_id)
    if (property(unique).id !== page)
      return yield* Effect.fail(
        invalid("The referring Skill changed its stable identity.", { page_id: page }),
      )
    const record = yield* checked(() =>
      sharedRecordFromPage(
        raw,
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
    const ids = yield* completeSharedSkillRelationIds(library, record, raw, field, {
      allowDisabled: true,
    })
    return { skill_id: metadata.skill_id, page_id: page, field, ids: ordered(ids) }
  })
}

function reverseRelations(library: SharedLibrary, ownerPage: string) {
  return Effect.gen(function* () {
    const result: Relation[] = []
    for (const field of fields) {
      const rows = yield* queryCurrentTablePages(library, "skills", {
        property: currentSkillProperty(library, "skills", field),
        relation: { contains: ownerPage },
      })
      for (const raw of rows) {
        const selected = yield* relationValues(library, raw, field)
        if (selected.page_id === ownerPage || !selected.ids.includes(ownerPage))
          return yield* Effect.fail(
            invalid("The reverse relation query returned a foreign or self reference."),
          )
        const after = selected.ids.filter((id) => id !== ownerPage)
        if (after.length > 100)
          return yield* Effect.fail(
            invalid(
              "Removing this relation would require writing more than 100 remaining targets.",
              {
                page_id: selected.page_id,
                field,
                remaining: after.length,
              },
            ),
          )
        result.push({
          skill_id: selected.skill_id,
          page_id: selected.page_id,
          field,
          before: selected.ids,
          after,
        })
      }
    }
    return result.sort((a, b) =>
      `${a.page_id}:${a.field}`.localeCompare(`${b.page_id}:${b.field}`, "en"),
    )
  })
}

function assertRelationSchema(library: SharedLibrary) {
  return Effect.gen(function* () {
    const raw = yield* (yield* Notion).request(`v1/data_sources/${library.skills.data_source_id}`)
    yield* checked(() => {
      if (
        property(raw).object !== "data_source" ||
        property(raw).id !== library.skills.data_source_id
      )
        throw invalid("The relation schema belongs to another Skills table.")
      for (const field of fields) {
        const id = currentSkillProperty(library, "skills", field)
        if (
          validateSharedRelationField(
            currentSkillField(library, "skills", raw, field, "relation"),
            library.skills.data_source_id,
          ) !== id ||
          Object.entries(library.skills.property_ids).some(
            ([name, value]) => name !== field && value === id,
          )
        )
          throw invalid("The managed relation property does not match its registered identity.")
      }
    })
  })
}

function prepareRemoval(library: SharedLibrary, raw: unknown, page: string) {
  return Effect.gen(function* () {
    const selected = yield* readOwner(library, raw, page)
    if (selected.trashed || selected.owner.state.state !== "ready")
      return yield* Effect.fail(invalid("Start removal from one ready live Skill."))
    yield* assertNoCurrentSourceContribution(library, selected.owner.skill_id)
    yield* assertRelationSchema(library)
    const index = yield* queryCurrentSkillIndex(library, page, raw)
    const files: File[] = []
    for (const file of index.files) {
      if (file.content.kind === "source")
        return yield* Effect.fail(
          fail(
            "CURRENT_SOURCE_MANAGEMENT_REQUIRED",
            "A mixed Skill still has Source-backed Files.",
          ),
        )
      files.push({
        file_id: file.file_id,
        page_id: file.page_id,
        path: file.path,
        content_sha256: yield* contentHash(file),
      })
    }
    const resources = (yield* listCurrentOwnedResourceRecords(library, {
      kind: "skill",
      page_id: page,
    })).map(({ record }) => ({
      resource_id: record.record_id,
      page_id: record.page_id,
      payload_sha256: record.hash,
    }))
    for (const file of [index.main, ...index.files]) {
      const content = file.content
      if (
        content.kind === "resource" &&
        !resources.some((resource) => resource.resource_id === content.object_id)
      )
        return yield* Effect.fail(
          invalid("A current descriptor has no unique owned Resource.", { file_id: file.file_id }),
        )
    }
    const relations = yield* reverseRelations(library, page)
    return yield* checked(() =>
      Schema.decodeUnknownSync(CurrentSkillRemovalInputSchema)(
        {
          kind: "remove",
          page_id: page,
          owner_sha256: selected.hash,
          files: files.sort((a, b) => a.page_id.localeCompare(b.page_id, "en")),
          resources: resources.sort((a, b) => a.page_id.localeCompare(b.page_id, "en")),
          relations,
        },
        { onExcessProperty: "error" },
      ),
    )
  })
}

function inspectFile(
  library: SharedLibrary,
  input: CurrentSkillRemovalInput,
  file: File,
  raw: unknown,
  retiredOwner = false,
) {
  return Effect.gen(function* () {
    const current = yield* checked(() =>
      currentFileRecord(
        frozenChildMetadata(library, "files", input.page_id, file.page_id, raw, retiredOwner),
        input.page_id,
        library.files.data_source_id,
        library.files.property_ids,
      ),
    )
    if (
      current.page_id !== file.page_id ||
      current.file_id !== file.file_id ||
      current.path !== file.path ||
      current.content.kind === "source" ||
      (yield* contentHash(current)) !== file.content_sha256
    )
      return yield* Effect.fail(
        invalid("A retiring File changed its binding or authority.", { page_id: file.page_id }),
      )
    return isTrashed(raw)
  })
}

function inspectResource(
  library: SharedLibrary,
  input: CurrentSkillRemovalInput,
  resource: Resource,
  raw: unknown,
  retiredOwner = false,
) {
  return Effect.gen(function* () {
    const metadata = yield* checked(() =>
      frozenChildMetadata(library, "records", input.page_id, resource.page_id, raw, retiredOwner),
    )
    const { record } = yield* currentOwnedResourceFromPage(library, metadata, {
      owner: { kind: "skill", page_id: input.page_id },
      objectId: resource.resource_id,
    })
    if (record.page_id !== resource.page_id || record.hash !== resource.payload_sha256)
      return yield* Effect.fail(invalid("A retiring Resource changed its identity or payload."))
    return isTrashed(raw)
  })
}

/** Notion hides relations to a trashed page even in direct GET responses. Only
 * after the kernel proves terminal owner retirement may an already-trashed,
 * frozen child have that unavailable relation filled for its strict decoder.
 * Actual liveness and foreign owners are checked before this read-only view. */
function frozenChildMetadata(
  library: SharedLibrary,
  table: "files" | "records",
  owner: string,
  page: string,
  raw: unknown,
  retiredOwner: boolean,
) {
  assertCurrentSkillPage(library, table, raw, page, true)
  if (!retiredOwner) return live(raw)
  if (!isTrashed(raw))
    throw invalid("A retired owner still has a live frozen child.", { page_id: page })
  const relation = currentSkillField(library, table, raw, "Skill", "relation")
  if (
    !Array.isArray(relation.relation) ||
    relation.has_more === true ||
    relation.relation.length > 1 ||
    relation.relation.some((item) => property(item).id !== owner)
  )
    throw invalid("The frozen retired child has a foreign or incomplete owner.", { page_id: page })
  if (relation.relation.length !== 0) return live(raw)
  const id = currentSkillProperty(library, table, "Skill")
  return {
    ...live(raw),
    properties: Object.fromEntries(
      Object.entries(property(property(raw).properties)).map(([key, value]) => [
        key,
        key === id || property(value).id === id
          ? { ...property(value), relation: [{ id: owner }] }
          : value,
      ]),
    ),
  }
}

function inspectRelation(library: SharedLibrary, relation: Relation, raw: unknown) {
  return Effect.gen(function* () {
    const current = yield* relationValues(library, raw, relation.field)
    if (
      current.page_id !== relation.page_id ||
      current.skill_id !== relation.skill_id ||
      (!same(current.ids, relation.before) && !same(current.ids, relation.after))
    )
      return yield* Effect.fail(
        invalid("A referring relation changed outside this removal.", {
          page_id: relation.page_id,
          field: relation.field,
        }),
      )
    return same(current.ids, relation.after)
  })
}

/** Retire one pure Notion-owned tree through the existing finite owner kernel. */
export function removeCurrentNotionSkill(library: SharedLibrary, options: Options) {
  return Effect.gen(function* () {
    yield* checked(() => {
      if (typeof options.target !== "string" || options.target === "")
        throw invalid("Select one exact Skill identity.")
      if (pageId(options.target) === undefined) currentWriteIdentity(options.target, "Skill ID")
      if (options.operation_id !== undefined)
        currentWriteIdentity(options.operation_id, "Operation ID")
      if (options.mode !== undefined && !["auto", "apply", "resume"].includes(options.mode))
        throw invalid("Use auto, apply or resume for removal.")
      if (options.dry_run && options.mode === "resume")
        throw invalid("Dry run cannot resume a removal.")
    })
    const api = yield* Notion
    const logical = pageId(options.target) === undefined ? options.target : undefined
    let pending =
      logical === undefined
        ? undefined
        : yield* readCurrentOperationIntent(library, { kind: "skill", id: logical })
    const selected = yield* resolveCurrentSkillPage(
      library,
      pending !== undefined &&
        "skill_action" in pending.intent &&
        pending.intent.skill_action.kind === "remove"
        ? pending.intent.skill_action.page_id
        : options.target,
      { allowTrash: true },
    ).pipe(
      Effect.catch((error) =>
        error.code === "SKILL_NOT_FOUND" && logical !== undefined && pending === undefined
          ? Effect.succeed(undefined)
          : Effect.fail(error),
      ),
    )
    const base = {
      version: 1 as const,
      contract: "current" as const,
      action: "remove" as const,
      library: {
        library_id: library.library_id,
        database_id: library.skills.database_id,
        data_source_id: library.skills.data_source_id,
      },
    }
    if (selected === undefined && options.mode === "resume")
      return yield* Effect.fail(
        fail("CURRENT_OPERATION_NOT_FOUND", "No unfinished Skill removal was found."),
      )
    if (selected === undefined)
      return {
        ...base,
        skill_id: options.target,
        page_id: null,
        state: "removed" as const,
        status: "not_found" as const,
        cleanup_verified: false as const,
        remote_writes: 0 as const,
      }
    const initial = yield* readOwner(library, selected.raw, selected.page_id)
    const owner = { kind: "skill" as const, id: initial.owner.skill_id }
    pending ??= yield* readCurrentOperationIntent(library, owner)
    if (
      pending !== undefined &&
      (!("skill_action" in pending.intent) ||
        pending.intent.skill_action.kind !== "remove" ||
        pending.intent.skill_action.page_id !== selected.page_id ||
        options.mode === "apply" ||
        options.dry_run ||
        (options.operation_id !== undefined &&
          options.operation_id !== pending.intent.operation_id))
    )
      return yield* Effect.fail(
        currentOperationFailure(
          fail(
            "CURRENT_OPERATION_PENDING",
            "Another current intent owns this Skill; removal cannot replace it.",
          ),
          pending.intent,
          null,
          selected.page_id,
        ),
      )
    const frozen: RemovalIntent | undefined =
      pending !== undefined &&
      "skill_action" in pending.intent &&
      pending.intent.skill_action.kind === "remove"
        ? { ...pending.intent, skill_action: pending.intent.skill_action }
        : undefined
    if (frozen === undefined && options.mode === "resume")
      return yield* Effect.fail(
        fail("CURRENT_OPERATION_NOT_FOUND", "No unfinished Skill removal was found."),
      )
    if (frozen === undefined && initial.trashed) {
      yield* assertNoCurrentSourceContribution(library, owner.id)
      return {
        ...base,
        skill_id: owner.id,
        page_id: selected.page_id,
        state: "removed" as const,
        status: "already_trashed" as const,
        cleanup_verified: false as const,
        remote_writes: 0 as const,
      }
    }
    const input =
      frozen?.skill_action ?? (yield* prepareRemoval(library, selected.raw, selected.page_id))
    const input_sha256 = yield* sha256(canonicalSharedJson(input))
    if (frozen !== undefined && frozen.input_sha256 !== input_sha256)
      return yield* Effect.fail(
        invalid("The unfinished removal input differs from its fingerprint."),
      )
    const operation_id =
      frozen?.operation_id ??
      options.operation_id ??
      (yield* (yield* Crypto.Crypto)
        .randomUUIDv4()
        .pipe(Effect.mapError(() => fail("CRYPTO_ERROR", "Cannot identify Skill removal."))))
    const intent: RemovalIntent = { owner, operation_id, input_sha256, skill_action: input }
    const result = {
      ...base,
      skill_id: owner.id,
      page_id: selected.page_id,
      operation_id,
      input_sha256,
      files: input.files,
      resources: input.resources,
      relations: input.relations,
    }
    if (options.dry_run)
      return { ...result, status: "inspected" as const, remote_writes: 0 as const }

    const assertOwner = () =>
      Effect.gen(function* () {
        const current = yield* readOwner(
          library,
          yield* api.request(`v1/pages/${input.page_id}`),
          input.page_id,
        )
        if (
          current.owner.skill_id !== owner.id ||
          current.hash !== input.owner_sha256 ||
          (current.owner.state.state !== "ready" &&
            current.owner.state.operation_id !== operation_id)
        )
          return yield* Effect.fail(
            invalid("The current Skill changed after removal was selected."),
          )
        const unique = yield* queryCurrentSkillIdentity(library, owner.id)
        if (current.trashed ? unique !== undefined : property(unique).id !== input.page_id)
          return yield* Effect.fail(invalid("The stable Skill identity changed during removal."))
        yield* assertNoCurrentSourceContribution(library, owner.id)
        return current
      })
    const assertScope = () =>
      Effect.gen(function* () {
        const current = yield* assertOwner()
        yield* assertRelationSchema(library)
        if (current.trashed) return current
        const index = yield* queryCurrentSkillIndex(library, input.page_id)
        for (const file of index.files) {
          const frozen = input.files.find((row) => row.page_id === file.page_id)
          if (
            frozen === undefined ||
            frozen.file_id !== file.file_id ||
            frozen.path !== file.path ||
            file.content.kind === "source" ||
            (yield* contentHash(file)) !== frozen.content_sha256
          )
            return yield* Effect.fail(
              invalid("The complete owned Files scope changed during removal."),
            )
        }
        for (const { record } of yield* listCurrentOwnedResourceRecords(library, {
          kind: "skill",
          page_id: input.page_id,
        })) {
          const frozen = input.resources.find((row) => row.page_id === record.page_id)
          if (
            frozen === undefined ||
            frozen.resource_id !== record.record_id ||
            frozen.payload_sha256 !== record.hash
          )
            return yield* Effect.fail(
              invalid("The complete owned Resource scope changed during removal."),
            )
        }
        for (const relation of yield* reverseRelations(library, input.page_id)) {
          const frozen = input.relations.find(
            (row) => row.page_id === relation.page_id && row.field === relation.field,
          )
          if (frozen === undefined || !same(frozen, relation))
            return yield* Effect.fail(invalid("The reverse relation scope changed during removal."))
        }
        return current
      })
    const verify = () =>
      Effect.gen(function* () {
        const current = yield* assertScope()
        for (const relation of input.relations)
          if (
            !(yield* inspectRelation(
              library,
              relation,
              yield* api.request(`v1/pages/${relation.page_id}`),
            ))
          )
            return yield* Effect.fail(
              invalid("A managed relation still references the retiring Skill."),
            )
        for (const file of input.files)
          if (
            !(yield* inspectFile(
              library,
              input,
              file,
              yield* api.request(`v1/pages/${file.page_id}`),
              current.trashed,
            ))
          )
            return yield* Effect.fail(invalid("An owned File has not been retired."))
        for (const resource of input.resources)
          if (
            !(yield* inspectResource(
              library,
              input,
              resource,
              yield* api.request(`v1/pages/${resource.page_id}`),
              current.trashed,
            ))
          )
            return yield* Effect.fail(invalid("An owned Resource has not been retired."))
      })
    const removed = {
      ...result,
      state: "removed" as const,
      status: "removed" as const,
      cleanup_verified: true as const,
    }
    return yield* withCurrentOperation(library, {
      intent,
      ownerPageId: input.page_id,
      mode: frozen === undefined ? "apply" : "resume",
      completion: "retired",
      beforeMutation: assertScope().pipe(Effect.asVoid),
      run: (session: CurrentOperationSession) =>
        Effect.gen(function* () {
          if (session.ownerRetired) return removed
          yield* assertScope()
          for (const relation of input.relations)
            yield* session.dispatch({
              key: `remove:relation:${relation.page_id}:${relation.field}`,
              replay: "idempotent",
              request: {
                path: `v1/pages/${relation.page_id}`,
                body: {
                  properties: {
                    [currentSkillProperty(library, "skills", relation.field)]: {
                      relation: relation.after.map((id) => ({ id })),
                    },
                  },
                },
                options: { method: "PATCH" },
              },
              observe: () =>
                Effect.gen(function* () {
                  const complete = yield* inspectRelation(
                    library,
                    relation,
                    yield* api.request(`v1/pages/${relation.page_id}`),
                  )
                  yield* assertOwner()
                  return complete
                    ? { status: "complete" as const, value: undefined }
                    : { status: "missing" as const }
                }),
            })
          yield* assertScope()
          for (const file of input.files)
            yield* session.dispatch({
              key: `remove:file:${file.page_id}`,
              replay: "idempotent",
              request: {
                path: `v1/pages/${file.page_id}`,
                body: { in_trash: true },
                options: { method: "PATCH" },
              },
              observe: () =>
                Effect.gen(function* () {
                  const complete = yield* inspectFile(
                    library,
                    input,
                    file,
                    yield* api.request(`v1/pages/${file.page_id}`),
                  )
                  yield* assertOwner()
                  return complete
                    ? { status: "complete" as const, value: undefined }
                    : { status: "missing" as const }
                }),
            })
          yield* assertScope()
          for (const resource of input.resources)
            yield* session.dispatch({
              key: `remove:resource:${resource.page_id}`,
              replay: "idempotent",
              request: {
                path: `v1/pages/${resource.page_id}`,
                body: { in_trash: true },
                options: { method: "PATCH" },
              },
              observe: () =>
                Effect.gen(function* () {
                  const complete = yield* inspectResource(
                    library,
                    input,
                    resource,
                    yield* api.request(`v1/pages/${resource.page_id}`),
                  )
                  yield* assertOwner()
                  return complete
                    ? { status: "complete" as const, value: undefined }
                    : { status: "missing" as const }
                }),
            })
          return removed
        }),
      verify: () => verify(),
      verifyCompletedResume: () => verify().pipe(Effect.as(removed)),
    })
  }).pipe(
    withCurrentInvocationBudget,
    Effect.map(({ result }) => result),
  )
}
