import { Crypto, Effect, Schema } from "effect"
import { entrypointFor, fail, property, validateDescription, validateDisplayName } from "./model.ts"
import { Notion } from "./notion.ts"
import { pageId } from "./ref.ts"
import { planSharedFiles } from "./shared-composition.ts"
import { sharedRecordFromPage } from "./shared-content.ts"
import { parseCurrentFileContent } from "./shared-current-file.ts"
import {
  currentFileRecord,
  queryCurrentSkillIndex,
  readCurrentSkillMetadata,
} from "./shared-current-index.ts"
import { withCurrentInvocationBudget } from "./shared-current-invocation.ts"
import {
  currentOperationFailure,
  readCurrentOperationIntent,
  withCurrentOperation,
  type CurrentOperationIntent,
} from "./shared-current-operation.ts"
import { currentRecordText } from "./shared-current-records.ts"
import { prepareCurrentRelations } from "./shared-current-relations.ts"
import {
  CurrentSkillRegistrationInputSchema,
  type CurrentSkillRegistrationInput,
} from "./shared-current-skill-register-input.ts"
import {
  assertCurrentSkillPage,
  assertNoCurrentSourceContribution,
  checkedSkillManagement as checked,
  currentSkillField,
  currentSkillProperty,
  currentSkillText,
  queryCurrentSkillIdentity,
  queryCurrentTablePages,
} from "./shared-current-skill-target.ts"
import { currentWriteIdentity } from "./shared-current-write-input.ts"
import { assertSharedFileReferences } from "./shared-file-references.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { observeSharedBody } from "./shared-page-body.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { completeSharedSkillRelationIds } from "./shared-router-members.ts"
import { sha256 } from "./store.ts"

type Options = {
  readonly target: string
  readonly skill_id?: string
  readonly name?: string
  readonly description?: string
  readonly enabled?: boolean
  readonly default_context?: boolean
  readonly operation_id?: string
  readonly mode?: "auto" | "apply" | "resume"
  readonly dry_run?: boolean
}
type RegistrationIntent = Extract<CurrentOperationIntent, { readonly skill_action: unknown }> & {
  readonly skill_action: CurrentSkillRegistrationInput
}
type FileInput = CurrentSkillRegistrationInput["files"][number]
const invalid = (message: string, details?: unknown) =>
  fail("CURRENT_SKILL_REGISTER_CONFLICT", message, details)
const hash = (value: unknown) => sha256(canonicalSharedJson(value))
const rich = (value: string) => ({ rich_text: currentRecordText(value) })
const title = (value: string) => ({ title: currentRecordText(value) })

function selection(library: SharedLibrary, raw: unknown, name: string): string {
  const selected = currentSkillField(library, "skills", raw, name, "select").select
  if (selected === null) return ""
  const nameValue = property(selected).name
  if (typeof nameValue !== "string")
    throw invalid("A selected metadata value is incomplete.", { property: name })
  return nameValue
}
function checkbox(library: SharedLibrary, raw: unknown, name: string): boolean {
  const value = currentSkillField(library, "skills", raw, name, "checkbox").checkbox
  if (typeof value !== "boolean")
    throw invalid("A checkbox value is incomplete.", { property: name })
  return value
}
function assertNativeOwner(library: SharedLibrary, raw: unknown) {
  const origin = currentSkillField(library, "skills", raw, "Origin", "relation")
  if (
    !Array.isArray(origin.relation) ||
    origin.has_more === true ||
    origin.relation.length !== 0 ||
    (library.skills.property_ids["Source Member"] !== undefined &&
      currentSkillText(library, "skills", raw, "Source Member") !== "")
  )
    throw fail(
      "CURRENT_SOURCE_MANAGEMENT_REQUIRED",
      "Source ownership must be managed before native registration.",
    )
}
function nativeDescriptor(encoded: string): string {
  const value =
    encoded === ""
      ? { kind: "native" as const, mode: "100644" as const, frontmatter: "" }
      : parseCurrentFileContent(encoded)
  if (value.kind !== "native")
    throw fail(
      "CURRENT_AUTHORITY_CONFLICT",
      "Registration cannot turn an existing resource or Source into a native body.",
    )
  return encoded === "" ? canonicalSharedJson(value) : encoded
}
function ownerValues(library: SharedLibrary, raw: unknown) {
  assertNativeOwner(library, raw)
  return {
    skill_id: currentSkillText(library, "skills", raw, "Skill ID"),
    name: currentSkillText(library, "skills", raw, "Name", "title"),
    description: currentSkillText(library, "skills", raw, "Description"),
    content_kind: selection(library, raw, "Kind"),
    main_file_id: currentSkillText(library, "skills", raw, "Main File ID"),
    main_content: currentSkillText(library, "skills", raw, "Content"),
    enabled: checkbox(library, raw, "Enabled"),
    default_context: checkbox(library, raw, "Default Context"),
  }
}
function desiredOwner(input: CurrentSkillRegistrationInput) {
  return {
    skill_id: input.skill_id,
    name: input.name,
    description: input.description,
    content_kind: input.content_kind,
    main_file_id: input.main_file_id,
    main_content: input.main_content,
    enabled: input.enabled,
    default_context: input.default_context,
  }
}
function fileValues(library: SharedLibrary, raw: unknown, owner: string) {
  const relation = currentSkillField(library, "files", raw, "Skill", "relation")
  if (
    !Array.isArray(relation.relation) ||
    relation.has_more === true ||
    relation.relation.length !== 1 ||
    pageId(String(property(relation.relation[0]).id)) !== owner
  )
    throw invalid("Every supporting File needs exactly this Skill as its owner.")
  return {
    file_id: currentSkillText(library, "files", raw, "File ID"),
    path: currentSkillText(library, "files", raw, "Path"),
    name: currentSkillText(library, "files", raw, "Name", "title"),
    content: currentSkillText(library, "files", raw, "Content"),
  }
}
function desiredFile(input: FileInput) {
  return { file_id: input.file_id, path: input.path, name: input.name, content: input.content }
}
function properties(
  library: SharedLibrary,
  input: CurrentSkillRegistrationInput,
): Record<string, unknown> {
  const field = (name: string) => currentSkillProperty(library, "skills", name)
  return {
    [field("Name")]: title(input.name),
    [field("Description")]: rich(input.description),
    [field("Skill ID")]: rich(input.skill_id),
    [field("Kind")]: { select: { name: input.content_kind } },
    [field("Main File ID")]: rich(input.main_file_id),
    [field("Content")]: rich(input.main_content),
    [field("Enabled")]: { checkbox: input.enabled },
    [field("Default Context")]: { checkbox: input.default_context },
  }
}
function fileProperties(library: SharedLibrary, input: FileInput) {
  const field = (name: string) => currentSkillProperty(library, "files", name)
  return {
    [field("Name")]: title(input.name),
    [field("File ID")]: rich(input.file_id),
    [field("Path")]: rich(input.path),
    [field("Content")]: rich(input.content),
  }
}
/** A virtual current header permits full preflight without touching author content. */
function virtualPage(raw: unknown, desired: Readonly<Record<string, unknown>>) {
  const original = property(raw)
  const fields: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(property(original.properties))) {
    const field = property(value)
    fields[typeof field.id === "string" ? field.id : key] = value
  }
  for (const [id, value] of Object.entries(desired)) {
    const encoded = property(value)
    fields[id] = { id, type: Object.keys(encoded)[0], ...encoded }
  }
  return { ...original, properties: fields }
}
function scopedFiles(library: SharedLibrary, page: string) {
  return queryCurrentTablePages(library, "files", {
    property: currentSkillProperty(library, "files", "Skill"),
    relation: { contains: page },
  })
}
function verifyBodiesAndRelations(library: SharedLibrary, input: CurrentSkillRegistrationInput) {
  return Effect.gen(function* () {
    const api = yield* Notion
    const raw = yield* api.request("v1/pages/" + input.page_id)
    const current = virtualPage(raw, {
      ...properties(library, input),
      [currentSkillProperty(library, "skills", "Current State")]: { select: { name: "ready" } },
      [currentSkillProperty(library, "skills", "Operation")]: rich(""),
    })
    const files: import("./shared-current-index.ts").CurrentFileBinding[] = []
    for (const file of input.files) {
      const observed = yield* api.request("v1/pages/" + file.page_id)
      yield* checked(() => assertCurrentSkillPage(library, "files", observed, file.page_id))
      files.push(
        yield* checked(() =>
          currentFileRecord(
            virtualPage(observed, fileProperties(library, file)),
            input.page_id,
            library.files.data_source_id,
            library.files.property_ids,
          ),
        ),
      )
    }
    const index = yield* queryCurrentSkillIndex(library, input.page_id, current, files)
    const bodies: { path: string; bytes: Uint8Array }[] = []
    for (const file of [index.main, ...index.files]) {
      if (file.content.kind !== "native")
        return yield* Effect.fail(invalid("Registration requires native author bodies."))
      const body = yield* observeSharedBody(file.page_id)
      bodies.push({
        path: file.path,
        bytes: new TextEncoder().encode(file.content.frontmatter + body.markdown),
      })
    }
    yield* checked(() => assertSharedFileReferences(bodies))
    if (input.content_kind === "prompt") {
      yield* checked(() => {
        for (const name of ["Members", "Requires"]) {
          const field = currentSkillField(library, "skills", current, name, "relation")
          if (
            !Array.isArray(field.relation) ||
            field.has_more === true ||
            field.relation.length !== 0
          )
            throw invalid("Prompts cannot carry Members or Requires.")
        }
      })
      return { files: bodies.length, paths: bodies.map((file) => file.path) }
    }
    const record = yield* checked(() =>
      sharedRecordFromPage(
        current,
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
    const relations: {
      version: 1
      ownership: "notion"
      library_id: string
      members?: string[]
      requires?: string[]
    } = { version: 1, ownership: "notion", library_id: library.library_id }
    for (const field of ["Members", "Requires"] as const) {
      const ids = yield* completeSharedSkillRelationIds(library, record, current, field, {
        allowDisabled: true,
      })
      const refs: string[] = []
      for (const target of ids) {
        const metadata = yield* readCurrentSkillMetadata(library, target)
        refs.push(
          "shared_skill:" +
            encodeURIComponent(library.library_id) +
            ":" +
            encodeURIComponent(metadata.skill_id),
        )
      }
      if (field === "Members") relations.members = refs
      else relations.requires = refs
    }
    yield* prepareCurrentRelations(library, {
      skill_id: input.skill_id,
      kind: input.content_kind,
      relations,
      reconciling: true,
      owner: { page_id: input.page_id, raw: current },
    })
    return { files: bodies.length, paths: bodies.map((file) => file.path) }
  })
}
function assertRegistrationState(library: SharedLibrary, raw: unknown, operationId?: string) {
  const state = selection(library, raw, "Current State")
  const operation = currentSkillText(library, "skills", raw, "Operation")
  if (
    state === "" || state === "ready"
      ? operation !== ""
      : (state !== "applying" && state !== "attention") ||
        operationId === undefined ||
        operation !== operationId
  )
    throw invalid(
      "Registration cannot replace another current operation or clear an inconsistent state.",
    )
}
function assertScope(
  library: SharedLibrary,
  input: CurrentSkillRegistrationInput,
  operationId?: string,
) {
  return Effect.gen(function* () {
    const raw = yield* (yield* Notion).request("v1/pages/" + input.page_id)
    const current = yield* checked(() => {
      assertCurrentSkillPage(library, "skills", raw, input.page_id)
      assertRegistrationState(library, raw, operationId)
      return ownerValues(library, raw)
    })
    const actual = yield* hash(current)
    if (actual !== input.owner_before_sha256 && actual !== (yield* hash(desiredOwner(input))))
      return yield* Effect.fail(
        invalid("The selected Skill metadata changed outside registration."),
      )
    const unique = yield* queryCurrentSkillIdentity(library, input.skill_id)
    if (unique !== undefined && property(unique).id !== input.page_id)
      return yield* Effect.fail(invalid("Another page now owns the selected Skill ID."))
    yield* assertNoCurrentSourceContribution(library, input.skill_id)
    const rows = yield* scopedFiles(library, input.page_id)
    if (rows.length !== input.files.length)
      return yield* Effect.fail(
        invalid("The supporting File directory changed during registration."),
      )
    for (const row of rows) {
      const expected = input.files.find((file) => file.page_id === property(row).id)
      if (expected === undefined)
        return yield* Effect.fail(invalid("An unexpected File appeared during registration."))
      const actual = yield* hash(yield* checked(() => fileValues(library, row, input.page_id)))
      if (actual !== expected.before_sha256 && actual !== (yield* hash(desiredFile(expected))))
        return yield* Effect.fail(
          invalid("A supporting File changed outside registration.", { page_id: expected.page_id }),
        )
    }
  })
}

export function registerCurrentNotionSkill(library: SharedLibrary, options: Options) {
  return Effect.gen(function* () {
    const selected = yield* checked(() => {
      const id = pageId(options.target)
      if (id === undefined)
        throw fail("INVALID_ARGUMENT", "Register one exact existing Notion Skill page ID or URL.")
      if (options.skill_id !== undefined) currentWriteIdentity(options.skill_id, "Skill ID")
      if (options.operation_id !== undefined)
        currentWriteIdentity(options.operation_id, "Operation ID")
      if (options.mode !== undefined && !["auto", "apply", "resume"].includes(options.mode))
        throw fail("INVALID_ARGUMENT", "Use auto, apply or resume for registration.")
      if (options.dry_run && options.mode === "resume")
        throw fail("INVALID_ARGUMENT", "Dry run cannot resume registration.")
      return id
    })
    const raw = yield* (yield* Notion).request("v1/pages/" + selected)
    const before = yield* checked(() => {
      assertCurrentSkillPage(library, "skills", raw, selected)
      return ownerValues(library, raw)
    })
    const skillId = yield* checked(() => {
      if (before.skill_id && options.skill_id !== undefined && options.skill_id !== before.skill_id)
        throw invalid("Registration preserves an existing stable Skill ID.")
      return currentWriteIdentity(
        before.skill_id || options.skill_id || "skill-" + selected.replace(/-/gu, ""),
        "Skill ID",
      )
    })
    const requestHash = yield* hash({
      page_id: selected,
      skill_id: options.skill_id ?? null,
      name: options.name ?? null,
      description: options.description ?? null,
      enabled: options.enabled ?? null,
      default_context: options.default_context ?? null,
    })
    const owner = { kind: "skill" as const, id: skillId }
    const pending = yield* readCurrentOperationIntent(library, owner)
    if (
      pending !== undefined &&
      (!("skill_action" in pending.intent) ||
        pending.intent.skill_action.kind !== "register" ||
        pending.intent.skill_action.page_id !== selected ||
        pending.intent.skill_action.request_sha256 !== requestHash ||
        options.mode === "apply" ||
        options.dry_run ||
        (options.operation_id !== undefined &&
          options.operation_id !== pending.intent.operation_id))
    )
      return yield* Effect.fail(
        currentOperationFailure(
          fail(
            "CURRENT_OPERATION_PENDING",
            "Another current intent owns this Skill. Repeat its original management command.",
          ),
          pending.intent,
          null,
          selected,
        ),
      )
    const frozen: RegistrationIntent | undefined =
      pending !== undefined &&
      "skill_action" in pending.intent &&
      pending.intent.skill_action.kind === "register"
        ? { ...pending.intent, skill_action: pending.intent.skill_action }
        : undefined
    if (frozen === undefined && options.mode === "resume")
      return yield* Effect.fail(
        fail("CURRENT_OPERATION_NOT_FOUND", "No unfinished registration was found."),
      )
    let input = frozen?.skill_action
    if (input === undefined) {
      const admitted = yield* checked(() => {
        const state = selection(library, raw, "Current State")
        if (
          !["", "ready"].includes(state) ||
          currentSkillText(library, "skills", raw, "Operation") !== ""
        )
          throw invalid("Registration cannot clear an unfinished or unknown operation.")
        const kind = before.content_kind || "skill"
        if (kind !== "skill" && kind !== "router" && kind !== "prompt")
          throw invalid("Use a valid current Skill kind.")
        const registered = before.skill_id !== "" && state === "ready"
        return {
          name: validateDisplayName(options.name ?? before.name),
          description: validateDescription(options.description ?? before.description),
          content_kind: kind as "skill" | "router" | "prompt",
          main_content: nativeDescriptor(before.main_content),
          owner_was_registered: registered,
          enabled: options.enabled ?? (registered ? before.enabled : true),
          default_context: options.default_context ?? (registered ? before.default_context : false),
        }
      })
      const main = entrypointFor(admitted.content_kind)
      const mainFile = before.main_file_id || "file-" + (yield* hash([skillId, main]))
      yield* checked(() => currentWriteIdentity(mainFile, "Main File ID"))
      const files: FileInput[] = []
      for (const row of yield* scopedFiles(library, selected)) {
        const page = yield* checked(() => assertCurrentSkillPage(library, "files", row))
        const original = yield* checked(() => fileValues(library, row, selected))
        if (!original.path)
          return yield* Effect.fail(
            invalid("Supporting Files require an explicit canonical Path; titles are not paths.", {
              page_id: page,
            }),
          )
        const fileId = original.file_id || "file-" + (yield* hash([skillId, original.path]))
        yield* checked(() => currentWriteIdentity(fileId, "File ID"))
        files.push({
          page_id: page,
          file_id: fileId,
          path: original.path,
          name: original.name || original.path,
          content: yield* checked(() => nativeDescriptor(original.content)),
          before_sha256: yield* hash(original),
        })
      }
      yield* checked(() =>
        planSharedFiles({
          base: [{ path: main }, ...files],
          mounts: [],
          overrides: [],
          entrypoint: main,
        }),
      )
      const ownerBeforeHash = yield* hash(before)
      input = yield* checked(() =>
        Schema.decodeUnknownSync(CurrentSkillRegistrationInputSchema)(
          {
            kind: "register",
            page_id: selected,
            skill_id: skillId,
            request_sha256: requestHash,
            owner_before_sha256: ownerBeforeHash,
            ...admitted,
            main_file_id: mainFile,
            files: files.sort((a, b) => a.path.localeCompare(b.path, "en")),
          },
          { onExcessProperty: "error" },
        ),
      )
    }
    // The input below is frozen before allocation; author bodies never enter it.
    const selectedInput = input
    yield* assertScope(library, selectedInput, frozen?.operation_id)
    const verified = yield* verifyBodiesAndRelations(library, selectedInput)
    const desiredHash = yield* hash(desiredOwner(selectedInput))
    const unchanged =
      (yield* hash(before)) === desiredHash &&
      (yield* Effect.forEach(selectedInput.files, (file) =>
        hash(desiredFile(file)).pipe(Effect.map((value) => value === file.before_sha256)),
      )).every(Boolean) &&
      selection(library, raw, "Current State") === "ready"
    const base = {
      version: 1 as const,
      contract: "current" as const,
      action: "register" as const,
      library: {
        library_id: library.library_id,
        database_id: library.skills.database_id,
        data_source_id: library.skills.data_source_id,
      },
      skill_id: skillId,
      page_id: selected,
      files: verified.files,
      paths: verified.paths,
    }
    if (options.dry_run)
      return {
        ...base,
        dry_run: true,
        status: unchanged ? "unchanged" : "planned",
        remote_writes: 0 as const,
      }
    if (frozen === undefined && unchanged)
      return {
        ...base,
        state: "ready" as const,
        status: "unchanged" as const,
        remote_writes: 0 as const,
      }
    const operationId =
      frozen?.operation_id ??
      options.operation_id ??
      (yield* (yield* Crypto.Crypto)
        .randomUUIDv4()
        .pipe(Effect.mapError(() => fail("CRYPTO_ERROR", "Cannot identify registration."))))
    const intent: RegistrationIntent = frozen ?? {
      operation_id: operationId,
      input_sha256: yield* hash(selectedInput),
      owner,
      skill_action: selectedInput,
    }
    const result = {
      ...base,
      state: "ready" as const,
      status: "registered" as const,
      operation_id: operationId,
      input_sha256: intent.input_sha256,
    }
    const verify = () =>
      Effect.gen(function* () {
        yield* assertScope(library, selectedInput, operationId)
        const fresh = yield* (yield* Notion).request("v1/pages/" + selected)
        if ((yield* hash(yield* checked(() => ownerValues(library, fresh)))) !== desiredHash)
          return yield* Effect.fail(
            invalid("Registration did not converge to its complete metadata."),
          )
        for (const file of selectedInput.files) {
          const raw = yield* (yield* Notion).request("v1/pages/" + file.page_id)
          if (
            (yield* hash(yield* checked(() => fileValues(library, raw, selected)))) !==
            (yield* hash(desiredFile(file)))
          )
            return yield* Effect.fail(
              invalid("A supporting File did not converge to its registration."),
            )
        }
        yield* verifyBodiesAndRelations(library, selectedInput)
      })
    return yield* withCurrentOperation(library, {
      intent,
      ownerPageId: pending?.owner_page_id ?? (selectedInput.owner_was_registered ? selected : null),
      mode: frozen === undefined ? "apply" : "resume",
      assertScope: assertScope(library, selectedInput, operationId),
      run: (session) =>
        Effect.gen(function* () {
          const ownerProperties = properties(library, selectedInput)
          const seeded = !selectedInput.owner_was_registered
          if (seeded) {
            ownerProperties[currentSkillProperty(library, "skills", "Current State")] = {
              select: { name: "applying" },
            }
            ownerProperties[currentSkillProperty(library, "skills", "Operation")] =
              rich(operationId)
          }
          yield* session.dispatch({
            key: "skill:register",
            replay: "idempotent",
            request: {
              path: "v1/pages/" + selected,
              body: { properties: ownerProperties },
              options: { method: "PATCH" },
            },
            observe: () =>
              Effect.gen(function* () {
                const current = yield* (yield* Notion).request("v1/pages/" + selected)
                yield* checked(() => {
                  assertCurrentSkillPage(library, "skills", current, selected)
                  assertRegistrationState(library, current, operationId)
                })
                const digest = yield* hash(yield* checked(() => ownerValues(library, current)))
                if (digest !== desiredHash) {
                  if (digest !== selectedInput.owner_before_sha256)
                    return yield* Effect.fail(
                      invalid("Skill metadata changed outside registration."),
                    )
                  return { status: "missing" } as const
                }
                if (
                  seeded &&
                  session.ownerPageId === null &&
                  (selection(library, current, "Current State") !== "applying" ||
                    currentSkillText(library, "skills", current, "Operation") !== operationId)
                )
                  return { status: "missing" } as const
                return { status: "complete", value: undefined } as const
              }),
          })
          if (session.ownerPageId === null) yield* session.bindOwner(selected)
          for (const file of selectedInput.files) {
            const desired = yield* hash(desiredFile(file))
            yield* session.dispatch({
              key: "file:" + file.page_id + ":register",
              replay: "idempotent",
              request: {
                path: "v1/pages/" + file.page_id,
                body: { properties: fileProperties(library, file) },
                options: { method: "PATCH" },
              },
              observe: () =>
                Effect.gen(function* () {
                  const raw = yield* (yield* Notion).request("v1/pages/" + file.page_id)
                  yield* checked(() => assertCurrentSkillPage(library, "files", raw, file.page_id))
                  const actual = yield* hash(
                    yield* checked(() => fileValues(library, raw, selected)),
                  )
                  if (actual === desired) return { status: "complete", value: undefined } as const
                  if (actual !== file.before_sha256)
                    return yield* Effect.fail(
                      invalid("Supporting File changed outside registration."),
                    )
                  return { status: "missing" } as const
                }),
            })
          }
          return result
        }),
      verify: () => verify(),
      verifyCompletedResume: () => verify().pipe(Effect.as(result)),
    })
  }).pipe(
    withCurrentInvocationBudget,
    Effect.map(({ result }) => result),
  )
}
