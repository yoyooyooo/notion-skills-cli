import { Effect } from "effect"
import { fail, property, SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import type { CurrentFileContent } from "./shared-current-file.ts"
import {
  currentFileRecord,
  queryCurrentFilesForSkills,
  type CurrentFileBinding,
} from "./shared-current-index.ts"
import type { CurrentOperationAction } from "./shared-current-operation.ts"
import { assertCurrentBodyReplaceable } from "./shared-current-projection.ts"
import { currentRecordText } from "./shared-current-records.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { canonicalSharedJson } from "./shared-records.ts"

type SourceContent = Extract<CurrentFileContent, { readonly kind: "source" }>
type SelectedSourceFile = {
  readonly file_id: string
  readonly path: string
  readonly content: SourceContent
}
const invalid = (message: string) => fail("CURRENT_PROJECTION_CONFLICT", message)
const checked = <A>(read: () => A) =>
  Effect.try({
    try: read,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : invalid("The current projection File input is invalid."),
  })
const comparable = ({ file_id, page_id, skill_page_id, path, content }: CurrentFileBinding) =>
  canonicalSharedJson({ file_id, page_id, skill_page_id, path, content })
const sameContent = (a: CurrentFileContent, b: CurrentFileContent) =>
  canonicalSharedJson(a) === canonicalSharedJson(b)

export function readCurrentProjectionFile(
  library: SharedLibrary,
  ownerPageId: string,
  raw: unknown,
  allowArchived = false,
) {
  return checked(() => {
    const row = property(raw)
    return currentFileRecord(
      allowArchived ? { ...row, in_trash: false, archived: false, is_archived: false } : row,
      ownerPageId,
      library.files.data_source_id,
      library.files.property_ids,
    )
  })
}
function field(library: SharedLibrary, name: string) {
  const value = library.files.property_ids[name]
  if (value === undefined) throw invalid("A current Files property is not registered: " + name)
  return value
}

/** One precise request and readback contract, shared by projection and cancellation. */
export function currentProjectionCreateFileAction(
  library: SharedLibrary,
  ownerPageId: string,
  file: SelectedSourceFile,
): Effect.Effect<CurrentOperationAction<CurrentFileBinding, Notion>, SkillsError> {
  return checked(() => {
    const desired = {
      [field(library, "Name")]: { title: currentRecordText(file.path) },
      [field(library, "File ID")]: { rich_text: currentRecordText(file.file_id) },
      [field(library, "Path")]: { rich_text: currentRecordText(file.path) },
      [field(library, "Content")]: {
        rich_text: currentRecordText(canonicalSharedJson(file.content)),
      },
      [field(library, "Skill")]: { relation: [{ id: ownerPageId }] },
    }
    const match = (found: CurrentFileBinding) =>
      checked(() => {
        if (
          found.file_id !== file.file_id ||
          found.path !== file.path ||
          !sameContent(found.content, file.content)
        )
          throw invalid("The created reading File does not match its exact current request.")
        return found
      })
    return {
      key: "projection-file:" + file.file_id + ":create",
      replay: "never",
      request: {
        path: "v1/pages",
        body: {
          parent: { type: "data_source_id", data_source_id: library.files.data_source_id },
          properties: desired,
        },
        options: { method: "POST" },
      },
      observe: () =>
        Effect.gen(function* () {
          const all = yield* queryCurrentFilesForSkills({
            dataSourceId: library.files.data_source_id,
            skillPageIds: [ownerPageId],
            propertyIds: library.files.property_ids,
          })
          const current = all.get(ownerPageId) ?? []
          const found = current.find((row) => row.file_id === file.file_id)
          if (found === undefined) {
            if (current.some((row) => row.path === file.path))
              return yield* Effect.fail(
                invalid("Another File acquired the intended projection path."),
              )
            return { status: "missing" } as const
          }
          return { status: "complete", value: yield* match(found) } as const
        }),
      acknowledge: (raw) =>
        readCurrentProjectionFile(library, ownerPageId, raw).pipe(Effect.flatMap(match)),
    }
  })
}

export function currentProjectionUpdateFileAction(
  library: SharedLibrary,
  ownerPageId: string,
  original: CurrentFileBinding,
  content: SourceContent,
): Effect.Effect<CurrentOperationAction<CurrentFileBinding, Notion>, SkillsError> {
  return checked(() => {
    if (original.content.kind !== "source")
      throw invalid("A projection cannot update a Notion-owned File.")
    const target = { ...original, content }
    const match = (found: CurrentFileBinding) =>
      checked(() => {
        if (
          found.content.kind !== "source" ||
          (comparable(found) !== comparable(original) && comparable(found) !== comparable(target))
        )
          throw invalid("The source reading File acquired a different authority or binding.")
        return found
      })
    return {
      key: "projection-file:" + original.page_id + ":content",
      replay: "idempotent",
      request: {
        path: "v1/pages/" + original.page_id,
        body: {
          properties: {
            [field(library, "Content")]: {
              rich_text: currentRecordText(canonicalSharedJson(content)),
            },
          },
        },
        options: { method: "PATCH" },
      },
      observe: () =>
        Effect.gen(function* () {
          const found = yield* readCurrentProjectionFile(
            library,
            ownerPageId,
            yield* (yield* Notion).request("v1/pages/" + original.page_id),
          ).pipe(Effect.flatMap(match))
          return sameContent(found.content, content)
            ? ({ status: "complete", value: found } as const)
            : ({ status: "missing" } as const)
        }),
      acknowledge: (raw) =>
        Effect.gen(function* () {
          const found = yield* readCurrentProjectionFile(library, ownerPageId, raw).pipe(
            Effect.flatMap(match),
          )
          if (!sameContent(found.content, content))
            return yield* Effect.fail(
              invalid("The source reading File descriptor was not confirmed."),
            )
          return found
        }),
    }
  })
}

export function currentProjectionArchiveFileAction<R = never>(
  library: SharedLibrary,
  ownerPageId: string,
  file: CurrentFileBinding,
  assertCurrent: Effect.Effect<void, SkillsError, R> = Effect.void,
): Effect.Effect<CurrentOperationAction<void, Notion | R>, SkillsError> {
  return checked(() => {
    if (file.content.kind !== "source")
      throw invalid("A projection cannot retire a Notion-owned File.")
    const match = (found: CurrentFileBinding) =>
      checked(() => {
        if (comparable(found) !== comparable(file))
          throw invalid("The source projection File authority or physical binding changed.")
      })
    return {
      key: "projection-file:" + file.page_id + ":archive",
      replay: "idempotent",
      request: {
        path: "v1/pages/" + file.page_id,
        body: { in_trash: true },
        options: { method: "PATCH" },
      },
      observe: () =>
        Effect.gen(function* () {
          const raw = property(yield* (yield* Notion).request("v1/pages/" + file.page_id))
          const current = yield* readCurrentProjectionFile(library, ownerPageId, raw, true)
          yield* match(current)
          if (raw.in_trash === true || raw.archived === true)
            return { status: "complete", value: undefined } as const
          yield* assertCurrentBodyReplaceable(file.page_id)
          yield* assertCurrent
          return { status: "missing" } as const
        }),
      acknowledge: (raw) =>
        Effect.gen(function* () {
          const current = yield* readCurrentProjectionFile(library, ownerPageId, raw, true)
          yield* match(current)
          if (property(raw).in_trash !== true && property(raw).archived !== true)
            return yield* Effect.fail(
              invalid("The source projection File retirement was not confirmed."),
            )
        }),
    }
  })
}
