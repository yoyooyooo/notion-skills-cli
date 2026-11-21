import { posix } from "node:path"
import { Crypto, Effect } from "effect"
import { markLocalContentRestriction } from "./content-restrictions.ts"
import { fail, SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import { normalizePath } from "./ref.ts"
import {
  resolveCurrentSkillConsumption,
  type CurrentSkillConsumption,
} from "./shared-current-consumption.ts"
import type { CurrentFileContent } from "./shared-current-file.ts"
import {
  queryCurrentSkillIndex,
  type CurrentFileBinding,
  type CurrentSkillIndex,
} from "./shared-current-index.ts"
import { withCurrentInvocationBudget } from "./shared-current-invocation.ts"
import {
  currentOperationFailure,
  readCurrentOperationIntent,
  withCurrentOperation,
  type CurrentOperationSession,
} from "./shared-current-operation.ts"
import {
  applyCurrentProjection,
  inspectCurrentProjection,
  isCurrentProjectionBinary,
  renderCurrentProjection,
} from "./shared-current-projection.ts"
import {
  currentProjectionArchiveFileAction,
  currentProjectionCreateFileAction,
  currentProjectionUpdateFileAction,
  readCurrentProjectionFile,
} from "./shared-current-projection-files.ts"
import { readCurrentSharedResourceBytes } from "./shared-current-resource.ts"
import { currentWriteIdentity } from "./shared-current-write-input.ts"
import { isGithubGitUrl } from "./shared-git-origin.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { observeSharedBody } from "./shared-page-body.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import type { SharedSourcePlanOptions } from "./shared-source-plan.ts"
import { sha256, Store } from "./store.ts"

export const currentProjectionDefaultInclude = ["**/*.md"] as const
export const currentProjectionDefaultExclude = [
  "**/{test,tests,__tests__,__snapshots__,fixtures,corpus,testdata,node_modules,vendor,dist,build,coverage}/**",
] as const

export type CurrentSkillProjectionOptions = {
  readonly target: string
  readonly operation_id: string
  readonly mode?: "apply" | "resume"
  readonly dry_run?: boolean
  readonly include?: readonly string[]
  readonly exclude?: readonly string[]
  readonly sourceOptions?: SharedSourcePlanOptions
}
type FileIdentity = {
  readonly file_id: string
  readonly page_id?: string
  readonly path: string
}
export type CurrentProjectionFileResult = FileIdentity & {
  readonly authority: CurrentFileContent["kind"]
  readonly bytes: number
} & (
    | { readonly status: "native_verified" }
    | { readonly status: "skipped_binary"; readonly reason: "non_text_original" }
    | {
        readonly status: "unchanged" | "would_write" | "applied"
        readonly representation: "markdown" | "code"
        readonly blocks: number
      }
  )
type ExclusionReason = "not_included" | "excluded_by_pattern"
export type CurrentProjectionExcludedFile = {
  readonly path: string
  readonly reason: ExclusionReason
  readonly pattern?: string
}
export type CurrentProjectionRowResult = FileIdentity & {
  readonly status:
    | "unchanged"
    | "would_create"
    | "created"
    | "would_update"
    | "updated"
    | "would_archive"
    | "archived"
  readonly reason?: ExclusionReason | "upstream_removed"
}
export type CurrentSkillProjectionResult = {
  readonly version: 1
  readonly contract: "current"
  readonly library: { readonly library_id: string; readonly entry: string }
  readonly skill_id: string
  readonly page_id: string
  readonly operation_id: string
  readonly input_sha256: string
  readonly status: "dry_run" | "unchanged" | "applied"
  readonly policy: { readonly include: readonly string[]; readonly exclude: readonly string[] }
  readonly full_tree_total: number
  readonly selected: number
  readonly excluded: readonly CurrentProjectionExcludedFile[]
  readonly rows: readonly CurrentProjectionRowResult[]
  readonly files: readonly CurrentProjectionFileResult[]
  readonly counts: {
    readonly total: number
    readonly selected: number
    readonly excluded: number
    readonly created: number
    readonly archived: number
    readonly updated: number
    readonly would_create: number
    readonly would_archive: number
    readonly would_update: number
    readonly native_verified: number
    readonly skipped_binary: number
    readonly unchanged: number
    readonly would_write: number
    readonly applied: number
  }
}
type SelectedFile = FileIdentity & { readonly content: CurrentFileContent }
type PreparedFile =
  | { readonly kind: "native"; readonly file: SelectedFile; readonly bytes: number }
  | { readonly kind: "text" | "binary"; readonly file: SelectedFile; readonly bytes: Uint8Array }

const invalid = (message: string, details?: unknown) =>
  fail("CURRENT_PROJECTION_CONFLICT", message, details)
const checked = <A>(read: () => A) =>
  Effect.try({
    try: read,
    catch: (error) =>
      error instanceof SkillsError ? error : invalid("The current projection input is invalid."),
  })
function comparePaths(left: string, right: string): number {
  let leftOffset = 0,
    rightOffset = 0
  for (;;) {
    const a = left.codePointAt(leftOffset),
      b = right.codePointAt(rightOffset)
    if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1
    if (a !== b) return a - b
    leftOffset += a > 0xffff ? 2 : 1
    rightOffset += b > 0xffff ? 2 : 1
  }
}
const sorted = <T extends { readonly path: string }>(files: readonly T[]) =>
  files.toSorted((left, right) => comparePaths(left.path, right.path))
const binding = ({ file_id, page_id, skill_page_id, path, content }: CurrentFileBinding) => ({
  file_id,
  page_id,
  skill_page_id,
  path,
  content,
})
const fileIdentity = ({ file_id, page_id, path }: FileIdentity): FileIdentity => ({
  file_id,
  ...(page_id === undefined ? {} : { page_id }),
  path,
})
const sameContent = (a: CurrentFileContent, b: CurrentFileContent) =>
  canonicalSharedJson(a) === canonicalSharedJson(b)
const directory = (files: readonly CurrentFileBinding[]) =>
  canonicalSharedJson(sorted(files).map(binding))
const consumptionIdentity = (value: CurrentSkillConsumption) =>
  canonicalSharedJson({ files: sorted(value.files), source_fingerprint: value.source_fingerprint })

function assertSameBinding(actual: CurrentFileBinding, expected: CurrentFileBinding) {
  if (canonicalSharedJson(binding(actual)) !== canonicalSharedJson(binding(expected)))
    throw invalid("The current file authority or physical binding changed during projection.", {
      path: expected.path,
      page_id: expected.page_id,
    })
}
export function currentProjectionPolicy(
  input: Pick<CurrentSkillProjectionOptions, "include" | "exclude">,
) {
  const include = [...(input.include ?? currentProjectionDefaultInclude)]
  const exclude = [...(input.exclude ?? currentProjectionDefaultExclude)]
  for (const patterns of [include, exclude]) {
    if (
      patterns.length > 100 ||
      patterns.some(
        (pattern) =>
          typeof pattern !== "string" ||
          !pattern ||
          pattern.length > 512 ||
          pattern.startsWith("/") ||
          pattern.includes("\\") ||
          /[\u0000-\u001f\u007f]/u.test(pattern) ||
          pattern.split("/").includes(".."),
      )
    )
      throw invalid("Projection patterns must be bounded relative POSIX globs.")
  }
  return { include, exclude }
}
function excludedBy(
  path: string,
  policy: ReturnType<typeof currentProjectionPolicy>,
): CurrentProjectionExcludedFile | undefined {
  const pattern = policy.exclude.find((pattern) => posix.matchesGlob(path, pattern))
  if (pattern !== undefined) return { path, reason: "excluded_by_pattern", pattern }
  if (!policy.include.some((pattern) => posix.matchesGlob(path, pattern)))
    return { path, reason: "not_included" }
}
function verifyBytes(file: SelectedFile, bytes: Uint8Array) {
  return Effect.gen(function* () {
    if (
      file.content.kind === "native" ||
      bytes.byteLength !== file.content.bytes ||
      (yield* sha256(bytes)) !== file.content.sha256
    )
      return yield* Effect.fail(
        invalid("The selected original does not match the current authoritative descriptor.", {
          path: file.path,
        }),
      )
    return bytes
  })
}

/** The physical page map works for both dense reading inventories and sparse document pages. */
export function currentProjectionLinkRewriter(
  fromPath: string,
  pages: ReadonlyMap<string, string>,
  consumption: CurrentSkillConsumption,
) {
  const files = new Map(consumption.files.map((file) => [file.path, file.content]))
  return (href: string): string | undefined => {
    if (!href || /^(?:[a-z][a-z0-9+.-]*:|\/|#)/iu.test(href)) return
    try {
      const pathPart = href.split(/[?#]/u)[0]
      if (pathPart === undefined) return
      const path = normalizePath(decodeURIComponent(pathPart), fromPath)
      const page = pages.get(path)
      if (page !== undefined) return "https://www.notion.so/" + page.replaceAll("-", "")
      const target = files.get(path)
      if (target?.kind !== "source") return
      const origin = consumption.sources.get(target.source_id)?.git_origin
      if (origin === undefined || !isGithubGitUrl(origin.url)) return
      return (
        origin.url +
        "/blob/" +
        origin.commit +
        "/" +
        target.source_path.split("/").map(encodeURIComponent).join("/") +
        href.slice(pathPart.length)
      )
    } catch {
      return
    }
  }
}

/** Fetch only selected reading originals. The full consumption tree remains a metadata fact. */
export function prepareCurrentProjectionFiles(
  library: SharedLibrary,
  index: CurrentSkillIndex,
  files: readonly SelectedFile[],
  consumption: CurrentSkillConsumption,
) {
  return Effect.gen(function* () {
    const store = yield* Store
    const bytesByPath = new Map<string, Uint8Array>()
    for (const file of files) {
      if (file.content.kind === "native") continue
      const cached = yield* store.readBytes("objects/" + file.content.sha256).pipe(
        Effect.catchIf(
          (error) => error.code === "SNAPSHOT_MISSING",
          () => Effect.succeed(undefined),
        ),
      )
      if (cached !== undefined) bytesByPath.set(file.path, yield* verifyBytes(file, cached))
    }
    for (const source of consumption.sources.values()) {
      const missing = files.filter(
        (file) =>
          file.content.kind === "source" &&
          file.content.source_id === source.source_id &&
          !bytesByPath.has(file.path),
      )
      if (!missing.length) continue
      const acquired = yield* source.materialize([
        ...new Set(
          missing.flatMap((file) =>
            file.content.kind === "source" ? [file.content.source_path] : [],
          ),
        ),
      ])
      for (const file of missing) {
        const content = file.content
        if (content.kind !== "source") continue
        const original = acquired.files.find((entry) => entry.path === content.source_path)
        if (original === undefined || original.mode !== content.mode)
          return yield* Effect.fail(
            invalid("A selected Source original is missing.", { path: file.path }),
          )
        const bytes = yield* verifyBytes(file, original.bytes)
        if (acquired.local_paths.includes(content.source_path))
          yield* markLocalContentRestriction(content.sha256)
        yield* store.writeBytes("objects/" + content.sha256, bytes)
        bytesByPath.set(file.path, bytes)
      }
    }
    const prepared: PreparedFile[] = []
    for (const file of files) {
      const content = file.content
      if (content.kind === "native") {
        if (file.page_id === undefined)
          return yield* Effect.fail(invalid("A native current file has no authoritative page."))
        const body = yield* observeSharedBody(file.page_id)
        prepared.push({
          kind: "native",
          file,
          bytes: new TextEncoder().encode(content.frontmatter + body.markdown).byteLength,
        })
        continue
      }
      let bytes = bytesByPath.get(file.path)
      if (bytes === undefined && content.kind === "resource") {
        bytes = yield* readCurrentSharedResourceBytes(library, {
          owner: { kind: "skill", page_id: index.page_id },
          content,
        }).pipe(Effect.flatMap((value) => verifyBytes(file, value)))
        yield* store.writeBytes("objects/" + content.sha256, bytes)
      }
      if (bytes === undefined)
        return yield* Effect.fail(
          invalid("A complete current original is unavailable.", { path: file.path }),
        )
      prepared.push({
        kind: isCurrentProjectionBinary(file.path, bytes) ? "binary" : "text",
        file,
        bytes,
      })
    }
    return prepared
  })
}

/** Explicit management only. Source manifests own the full tree; Files rows are selected reading pages. */
export function projectCurrentSkill(library: SharedLibrary, input: CurrentSkillProjectionOptions) {
  return Effect.gen(function* () {
    const policy = yield* checked(() => {
      currentWriteIdentity(input.operation_id, "Operation ID")
      if (input.mode !== undefined && input.mode !== "apply" && input.mode !== "resume")
        throw invalid("Use apply or resume for a current reading projection.")
      if (input.dry_run && input.mode === "resume")
        throw invalid("Dry run cannot resume an unfinished current projection.")
      return currentProjectionPolicy(input)
    })
    const index = yield* queryCurrentSkillIndex(library, input.target)
    if (index.state.state !== "ready")
      return yield* Effect.fail(
        fail(
          "CURRENT_OPERATION_PENDING",
          "Finish the current content operation before projecting it.",
          {
            operation_id: index.state.operation_id,
            page_id: index.page_id,
            next: "reconcile_current",
          },
        ),
      )
    const pending = yield* readCurrentOperationIntent(library, {
      kind: "skill",
      id: index.skill_id,
    })
    if (
      pending !== undefined &&
      (!("projection" in pending.intent) ||
        pending.intent.projection !== true ||
        pending.intent.operation_id !== input.operation_id ||
        input.mode !== "resume")
    )
      return yield* Effect.fail(
        currentOperationFailure(
          fail(
            "CURRENT_OPERATION_PENDING",
            "Resume or cancel the existing current operation before projecting this Skill.",
          ),
          pending.intent,
          null,
          index.page_id,
        ),
      )
    const consumption = yield* resolveCurrentSkillConsumption(library, index, {
      sourceOptions: input.sourceOptions,
    }).pipe(
      Effect.mapError((error) =>
        pending === undefined
          ? error
          : currentOperationFailure(error, pending.intent, null, index.page_id),
      ),
    )
    const fullTree = sorted(consumption.files)
    const main = fullTree.find((file) => file.path === index.main.path)
    if (main === undefined)
      return yield* Effect.fail(invalid("The complete consumption tree has no main document."))
    const excluded: CurrentProjectionExcludedFile[] = []
    const included = [
      main,
      ...fullTree.filter((file) => {
        if (file.path === main.path) return false
        const reason = file.content.kind === "source" ? excludedBy(file.path, policy) : undefined
        if (reason !== undefined) {
          excluded.push(reason)
          return false
        }
        return true
      }),
    ]
    const existingByPath = new Map(index.files.map((file) => [file.path, file]))
    const selected: SelectedFile[] = []
    for (const file of included) {
      const existing = file.path === index.main.path ? index.main : existingByPath.get(file.path)
      if (
        file.content.kind !== "source" &&
        (existing === undefined || !sameContent(existing.content, file.content))
      )
        return yield* Effect.fail(
          invalid("A Notion-owned authoritative file lost its physical binding.", {
            path: file.path,
          }),
        )
      if (
        file.content.kind === "source" &&
        existing !== undefined &&
        existing.content.kind !== "source"
      )
        return yield* Effect.fail(
          invalid("A native or resource File cannot be adopted by reading projection.", {
            path: file.path,
          }),
        )
      selected.push({
        path: file.path,
        content: file.content,
        file_id:
          existing?.file_id ??
          "projection-" +
            (yield* sha256(canonicalSharedJson([library.library_id, index.skill_id, file.path]))),
        ...(existing === undefined ? {} : { page_id: existing.page_id }),
      })
    }
    const selectedByPath = new Map(selected.map((file) => [file.path, file]))
    const excludedByPath = new Map(excluded.map((file) => [file.path, file]))
    const fullByPath = new Map(fullTree.map((file) => [file.path, file]))
    const reasonForArchive = (file: CurrentFileBinding) => {
      if (file.content.kind !== "source")
        throw invalid("Native and resource rows cannot be pruned by projection.")
      if (!fullByPath.has(file.path)) return "upstream_removed" as const
      const reason = excludedByPath.get(file.path)?.reason
      if (reason === undefined)
        throw invalid("An included current source document cannot be archived.", {
          path: file.path,
        })
      return reason
    }
    const toArchive = sorted(
      index.files.filter(
        (file) => file.content.kind === "source" && !selectedByPath.has(file.path),
      ),
    )
    const expectedFiles = new Map(index.files.map((file) => [file.page_id, file]))
    const pageByPath = new Map([
      [index.main.path, index.main],
      ...index.files.map((file) => [file.path, file] as const),
    ])
    const originalConsumption = consumptionIdentity(consumption)
    const input_sha256 = yield* sha256(
      canonicalSharedJson({
        purpose: "current_text_projection",
        version: 1,
        owner: {
          skill_id: index.skill_id,
          page_id: index.page_id,
          main_file_id: index.main.file_id,
          main: index.main.path,
        },
        consumption: originalConsumption,
        policy,
      }),
    )
    const prepared = yield* prepareCurrentProjectionFiles(
      library,
      index,
      selected,
      consumption,
    ).pipe(
      Effect.mapError((error) =>
        pending === undefined
          ? error
          : currentOperationFailure(error, pending.intent, null, index.page_id),
      ),
    )
    const assertOwner = (current: CurrentSkillIndex) => {
      if (current.skill_id !== index.skill_id || current.state.state !== "ready")
        throw invalid("The selected Skill no longer owns this projection.")
      assertSameBinding(current.main, index.main)
    }
    const assertInventory = Effect.gen(function* () {
      const current = yield* queryCurrentSkillIndex(library, index.page_id)
      yield* checked(() => {
        assertOwner(current)
        if (directory(current.files) !== directory([...expectedFiles.values()]))
          throw invalid("The current physical File inventory changed during projection.")
      })
      const admitted = yield* resolveCurrentSkillConsumption(library, current, {
        sourceOptions: input.sourceOptions,
      })
      if (consumptionIdentity(admitted) !== originalConsumption)
        return yield* Effect.fail(
          invalid("The current authoritative consumption tree changed during projection."),
        )
    })
    const render = (prepared: Extract<PreparedFile, { kind: "text" | "binary" }>) =>
      checked(() => {
        const plan = renderCurrentProjection({
          path: prepared.file.path,
          bytes: prepared.bytes,
          rewriteLink: currentProjectionLinkRewriter(
            prepared.file.path,
            new Map(
              selected.flatMap((file) => {
                const page = pageByPath.get(file.path)?.page_id
                return page === undefined ? [] : [[file.path, page] as const]
              }),
            ),
            consumption,
          ),
        })
        if (plan.representation === "binary")
          throw invalid("A selected text file produced a binary projection.")
        return { ...plan, representation: plan.representation }
      })
    const result = (
      files: readonly CurrentProjectionFileResult[],
      rows: readonly CurrentProjectionRowResult[],
    ): CurrentSkillProjectionResult => ({
      version: 1,
      contract: "current",
      library: { library_id: library.library_id, entry: library.skills.database_id },
      skill_id: index.skill_id,
      page_id: index.page_id,
      operation_id: input.operation_id,
      input_sha256,
      status: input.dry_run
        ? "dry_run"
        : files.some((file) => file.status === "applied") ||
            rows.some((row) => ["created", "updated", "archived"].includes(row.status))
          ? "applied"
          : "unchanged",
      policy,
      full_tree_total: fullTree.length,
      selected: selected.length,
      excluded,
      rows,
      files,
      counts: {
        total: files.length,
        selected: selected.length,
        excluded: excluded.length,
        created: rows.filter((row) => row.status === "created").length,
        archived: rows.filter((row) => row.status === "archived").length,
        updated: rows.filter((row) => row.status === "updated").length,
        would_create: rows.filter((row) => row.status === "would_create").length,
        would_archive: rows.filter((row) => row.status === "would_archive").length,
        would_update: rows.filter((row) => row.status === "would_update").length,
        native_verified: files.filter((file) => file.status === "native_verified").length,
        skipped_binary: files.filter((file) => file.status === "skipped_binary").length,
        unchanged: files.filter((file) => file.status === "unchanged").length,
        would_write: files.filter((file) => file.status === "would_write").length,
        applied: files.filter((file) => file.status === "applied").length,
      },
    })
    const nonText = (file: PreparedFile): CurrentProjectionFileResult => ({
      ...fileIdentity({ ...file.file, page_id: pageByPath.get(file.file.path)?.page_id }),
      authority: file.file.content.kind,
      ...(file.kind === "native"
        ? { bytes: file.bytes, status: "native_verified" as const }
        : {
            bytes: file.bytes.byteLength,
            status: "skipped_binary" as const,
            reason: "non_text_original" as const,
          }),
    })
    const plannedRows = (): CurrentProjectionRowResult[] => [
      ...toArchive.map((file) => ({
        ...fileIdentity(file),
        status: "would_archive" as const,
        reason: reasonForArchive(file),
      })),
      ...selected
        .filter((file) => file.path !== main.path && file.content.kind === "source")
        .map((file) => ({
          ...fileIdentity(file),
          status:
            file.page_id === undefined
              ? ("would_create" as const)
              : sameContent(existingByPath.get(file.path)!.content, file.content)
                ? ("unchanged" as const)
                : ("would_update" as const),
        })),
    ]
    const inspect = Effect.gen(function* () {
      const files: CurrentProjectionFileResult[] = []
      for (const file of prepared) {
        if (file.kind !== "text") {
          files.push(nonText(file))
          continue
        }
        const plan = yield* render(file)
        const page = pageByPath.get(file.file.path)?.page_id
        const observed =
          page === undefined ? undefined : yield* inspectCurrentProjection({ pageId: page, plan })
        files.push({
          ...fileIdentity(file.file),
          authority: file.file.content.kind,
          bytes: file.bytes.byteLength,
          representation: plan.representation,
          blocks: plan.blocks.length,
          status: observed?.matches === true ? "unchanged" : "would_write",
        })
      }
      yield* assertInventory
      return result(files, plannedRows())
    })
    if (input.dry_run) return yield* inspect
    const api = yield* Notion
    const readRow = (raw: unknown, allowArchived = false) =>
      readCurrentProjectionFile(library, index.page_id, raw, allowArchived)
    const assertSessionOwner = (session: CurrentOperationSession) =>
      Effect.gen(function* () {
        const raw = yield* session.assertCurrent()
        const current = yield* queryCurrentSkillIndex(library, index.page_id, raw, index.files)
        yield* checked(() => assertOwner(current))
      })
    const assertFile = (session: CurrentOperationSession, file: CurrentFileBinding) =>
      Effect.gen(function* () {
        yield* assertSessionOwner(session)
        if (file.page_id === index.page_id) return
        const current = yield* readRow(yield* api.request("v1/pages/" + file.page_id))
        yield* checked(() => assertSameBinding(current, file))
      })
    const remember = (file: CurrentFileBinding) => {
      expectedFiles.set(file.page_id, file)
      pageByPath.set(file.path, file)
    }
    const stageRows = (session: CurrentOperationSession) =>
      Effect.gen(function* () {
        const rows: CurrentProjectionRowResult[] = []
        const archives = [...toArchive]
        const pendingArchive = /^projection-file:([a-f0-9-]{36}):archive$/u.exec(
          session.pendingActionKey ?? "",
        )?.[1]
        if (
          pendingArchive !== undefined &&
          !archives.some((file) => file.page_id === pendingArchive)
        ) {
          const file = yield* readRow(yield* api.request("v1/pages/" + pendingArchive), true)
          yield* checked(() => reasonForArchive(file))
          archives.unshift(file)
        }
        // Remove obsolete paths before creating descendants, so each intermediate index stays unambiguous.
        for (const file of archives) {
          const reason = yield* checked(() => reasonForArchive(file))
          yield* assertSessionOwner(session)
          yield* session.dispatch(
            yield* currentProjectionArchiveFileAction(
              library,
              index.page_id,
              file,
              assertFile(session, file),
            ),
          )
          expectedFiles.delete(file.page_id)
          pageByPath.delete(file.path)
          rows.push({ ...fileIdentity(file), status: "archived", reason })
        }
        for (const file of selected) {
          if (file.path === main.path || file.content.kind !== "source") continue
          let existing = pageByPath.get(file.path)
          const createKey = "projection-file:" + file.file_id + ":create"
          const creating = existing === undefined || session.pendingActionKey === createKey
          if (creating) {
            yield* assertSessionOwner(session)
            existing = yield* session.dispatch(
              yield* currentProjectionCreateFileAction(library, index.page_id, {
                ...file,
                content: file.content,
              }),
            )
            remember(existing)
          }
          if (existing === undefined)
            return yield* Effect.fail(invalid("A selected source document has no File page."))
          const original = existing
          const contentKey = "projection-file:" + original.page_id + ":content"
          const updating =
            !sameContent(original.content, file.content) || session.pendingActionKey === contentKey
          if (updating) {
            yield* assertSessionOwner(session)
            const updated = yield* session.dispatch(
              yield* currentProjectionUpdateFileAction(
                library,
                index.page_id,
                original,
                file.content,
              ),
            )
            remember(updated)
          }
          rows.push({
            ...fileIdentity({ ...file, page_id: original.page_id }),
            status: creating ? "created" : updating ? "updated" : "unchanged",
          })
        }
        return rows
      })
    return yield* withCurrentOperation(library, {
      intent: {
        operation_id: input.operation_id,
        input_sha256,
        owner: { kind: "skill", id: index.skill_id },
        projection: true,
      },
      ownerPageId: index.page_id,
      mode: input.mode,
      beforeMutation: assertInventory,
      verifyCompletedResume: () =>
        inspect.pipe(
          Effect.flatMap((value) =>
            value.counts.would_write +
              value.counts.would_create +
              value.counts.would_archive +
              value.counts.would_update ===
            0
              ? Effect.succeed(value)
              : Effect.fail(
                  invalid("The completed projection is no longer complete; start a new operation."),
                ),
          ),
        ),
      run: (session) =>
        Effect.gen(function* () {
          const rows = yield* stageRows(session)
          const files: CurrentProjectionFileResult[] = []
          for (const file of prepared) {
            if (file.kind !== "text") {
              files.push(nonText(file))
              continue
            }
            const physical = pageByPath.get(file.file.path)
            if (physical === undefined)
              return yield* Effect.fail(invalid("A selected reading page is missing."))
            const plan = yield* render(file)
            const identity = { ...fileIdentity(file.file), page_id: physical.page_id }
            if (!session.pendingActionKey?.startsWith("projection:" + physical.page_id + ":")) {
              const observed = yield* inspectCurrentProjection({ pageId: physical.page_id, plan })
              if (observed.matches) {
                files.push({
                  ...identity,
                  authority: file.file.content.kind,
                  bytes: file.bytes.byteLength,
                  representation: plan.representation,
                  blocks: observed.blocks,
                  status: "unchanged",
                })
                continue
              }
            }
            const written = yield* applyCurrentProjection<Notion | Crypto.Crypto | Store>({
              pageId: physical.page_id,
              content: file.file.content,
              plan,
              assertCurrent: assertFile(session, physical),
              dispatch: session.dispatch,
            })
            files.push({
              ...identity,
              authority: file.file.content.kind,
              bytes: file.bytes.byteLength,
              representation: plan.representation,
              blocks: written.blocks,
              status: written.changed ? "applied" : "unchanged",
            })
          }
          return result(files, rows)
        }),
      verify: () => assertInventory,
    })
  }).pipe(
    (effect) => withCurrentInvocationBudget(effect),
    Effect.map(({ result }) => result),
  )
}
