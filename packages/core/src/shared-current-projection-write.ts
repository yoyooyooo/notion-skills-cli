import { Crypto, Effect } from "effect"
import { markLocalContentRestriction } from "./content-restrictions.ts"
import { fail, SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import { normalizePath } from "./ref.ts"
import {
  currentFileRecord,
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
  type CurrentProjectionPlan,
} from "./shared-current-projection.ts"
import { readCurrentSharedResourceBytes } from "./shared-current-resource.ts"
import { resolveCurrentSharedSources } from "./shared-current-source.ts"
import { currentWriteIdentity } from "./shared-current-write-input.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { observeSharedBody } from "./shared-page-body.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import type { SharedSourcePlanOptions } from "./shared-source-plan.ts"
import { sha256, Store } from "./store.ts"

export type CurrentSkillProjectionOptions = {
  readonly target: string
  readonly operation_id: string
  readonly mode?: "apply" | "resume"
  readonly dry_run?: boolean
  readonly sourceOptions?: SharedSourcePlanOptions
}
type FileIdentity = Pick<CurrentFileBinding, "file_id" | "page_id" | "path">
export type CurrentProjectionFileResult = FileIdentity & {
  readonly authority: CurrentFileBinding["content"]["kind"]
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
export type CurrentSkillProjectionResult = {
  readonly version: 1
  readonly contract: "current"
  readonly library: { readonly library_id: string; readonly entry: string }
  readonly skill_id: string
  readonly page_id: string
  readonly operation_id: string
  readonly input_sha256: string
  readonly status: "dry_run" | "unchanged" | "applied"
  readonly files: readonly CurrentProjectionFileResult[]
  readonly counts: {
    readonly total: number
    readonly native_verified: number
    readonly skipped_binary: number
    readonly unchanged: number
    readonly would_write: number
    readonly applied: number
  }
}
type PreparedFile =
  | { readonly kind: "native" | "binary"; readonly result: CurrentProjectionFileResult }
  | {
      readonly kind: "text"
      readonly binding: CurrentFileBinding
      readonly bytes: number
      readonly plan: CurrentProjectionPlan & { readonly representation: "markdown" | "code" }
    }

const invalid = (message: string, details?: unknown) =>
  fail("CURRENT_PROJECTION_CONFLICT", message, details)
const checked = <A>(read: () => A) =>
  Effect.try({
    try: read,
    catch: (error) =>
      error instanceof SkillsError ? error : invalid("The current projection input is invalid."),
  })
const allFiles = (index: CurrentSkillIndex) => [index.main, ...index.files]
const sourceSelections = (index: CurrentSkillIndex) =>
  allFiles(index).flatMap((file) =>
    file.content.kind === "source"
      ? [{ source_id: file.content.source_id, revision: file.content.revision }]
      : [],
  )
const binding = ({ file_id, page_id, skill_page_id, path, content }: CurrentFileBinding) => ({
  file_id,
  page_id,
  skill_page_id,
  path,
  content,
})
const fileIdentity = ({ file_id, page_id, path }: CurrentFileBinding): FileIdentity => ({
  file_id,
  page_id,
  path,
})
const directory = (index: CurrentSkillIndex) =>
  canonicalSharedJson({
    skill_id: index.skill_id,
    page_id: index.page_id,
    files: allFiles(index)
      .map(binding)
      .sort((a, b) => a.path.localeCompare(b.path, "en")),
  })

function assertSameBinding(actual: CurrentFileBinding, expected: CurrentFileBinding) {
  if (canonicalSharedJson(binding(actual)) !== canonicalSharedJson(binding(expected)))
    throw invalid("The current file authority or physical binding changed during projection.", {
      path: expected.path,
      page_id: expected.page_id,
    })
}

function verifyBytes(file: CurrentFileBinding, bytes: Uint8Array) {
  return Effect.gen(function* () {
    if (
      file.content.kind === "native" ||
      bytes.byteLength !== file.content.bytes ||
      (yield* sha256(bytes)) !== file.content.sha256
    )
      return yield* Effect.fail(
        invalid("The selected original does not match the current File descriptor.", {
          path: file.path,
          page_id: file.page_id,
        }),
      )
    return bytes
  })
}

/** Read only the requested current originals, reusing the existing verified object cache. */
function prepareFiles(
  library: SharedLibrary,
  index: CurrentSkillIndex,
  sourceOptions?: SharedSourcePlanOptions,
) {
  return Effect.gen(function* () {
    const store = yield* Store,
      files = allFiles(index),
      bytesByPath = new Map<string, Uint8Array>()
    const sources = yield* resolveCurrentSharedSources(library, {
      selections: sourceSelections(index),
      ...(sourceOptions === undefined ? {} : { sourceOptions }),
    })
    for (const file of files) {
      const content = file.content
      if (content.kind === "native") continue
      if (content.kind === "source") {
        const source = sources.get(content.source_id),
          declared = source?.manifest.find((entry) => entry.path === content.source_path)
        if (
          declared === undefined ||
          declared.sha256 !== content.sha256 ||
          declared.bytes !== content.bytes ||
          declared.mode !== content.mode
        )
          return yield* Effect.fail(
            invalid("The current Source manifest does not own the selected File bytes.", {
              path: file.path,
              source_id: content.source_id,
            }),
          )
      }
      const cached = yield* store.readBytes(`objects/${content.sha256}`).pipe(
        Effect.catchIf(
          (error) => error.code === "SNAPSHOT_MISSING",
          () => Effect.succeed(undefined),
        ),
      )
      if (cached !== undefined) bytesByPath.set(file.path, yield* verifyBytes(file, cached))
    }
    for (const source of sources.values()) {
      const missing = files.filter(
        (file) =>
          file.content.kind === "source" &&
          file.content.source_id === source.source_id &&
          !bytesByPath.has(file.path),
      )
      if (missing.length === 0) continue
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
        yield* store.writeBytes(`objects/${content.sha256}`, bytes)
        bytesByPath.set(file.path, bytes)
      }
    }
    const result: PreparedFile[] = []
    const byPath = new Map(files.map((file) => [file.path, file.page_id]))
    for (const file of files) {
      const content = file.content
      if (content.kind === "native") {
        const body = yield* observeSharedBody(file.page_id)
        result.push({
          kind: "native",
          result: {
            ...fileIdentity(file),
            authority: "native",
            bytes: new TextEncoder().encode(content.frontmatter + body.markdown).byteLength,
            status: "native_verified",
          },
        })
        continue
      }
      let bytes = bytesByPath.get(file.path)
      if (bytes === undefined && content.kind === "resource") {
        bytes = yield* readCurrentSharedResourceBytes(library, {
          owner: { kind: "skill", page_id: index.page_id },
          content,
        }).pipe(Effect.flatMap((value) => verifyBytes(file, value)))
        yield* store.writeBytes(`objects/${content.sha256}`, bytes)
      }
      if (bytes === undefined)
        return yield* Effect.fail(
          invalid("A complete current original is unavailable.", { path: file.path }),
        )
      if (isCurrentProjectionBinary(file.path, bytes)) {
        result.push({
          kind: "binary",
          result: {
            ...fileIdentity(file),
            authority: content.kind,
            bytes: bytes.byteLength,
            status: "skipped_binary",
            reason: "non_text_original",
          },
        })
        continue
      }
      const plan = yield* checked(() =>
        renderCurrentProjection({
          path: file.path,
          bytes,
          rewriteLink: (href) => {
            if (!href || /^(?:[a-z][a-z0-9+.-]*:|\/|#)/iu.test(href)) return
            // Invalid/unselected relative links stay literal; no external lookup or authority change.
            try {
              const path = normalizePath(decodeURIComponent(href.split(/[?#]/u)[0]!), file.path),
                page = byPath.get(path)
              return page === undefined
                ? undefined
                : `https://www.notion.so/${page.replaceAll("-", "")}`
            } catch {
              return
            }
          },
        }),
      )
      if (plan.representation === "binary")
        return yield* Effect.fail(invalid("A selected text file produced a binary projection."))
      result.push({
        kind: "text",
        binding: file,
        bytes: bytes.byteLength,
        plan: { ...plan, representation: plan.representation },
      })
    }
    return result
  })
}

/** Explicit management only. Exact originals and native author bodies remain authoritative. */
export function projectCurrentSkill(library: SharedLibrary, input: CurrentSkillProjectionOptions) {
  return Effect.gen(function* () {
    yield* checked(() => {
      currentWriteIdentity(input.operation_id, "Operation ID")
      if (input.mode !== undefined && input.mode !== "apply" && input.mode !== "resume")
        throw invalid("Use apply or resume for a current text projection.")
      if (input.dry_run && input.mode === "resume")
        throw invalid("Dry run cannot resume an unfinished current projection.")
    })
    const index = yield* queryCurrentSkillIndex(library, input.target),
      originalDirectory = directory(index)
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
            "Resume the existing current operation before projecting this Skill.",
          ),
          pending.intent,
          null,
          index.page_id,
        ),
      )
    const prepared = yield* prepareFiles(library, index, input.sourceOptions).pipe(
      Effect.mapError((error) =>
        pending === undefined
          ? error
          : currentOperationFailure(error, pending.intent, null, index.page_id),
      ),
    )
    const input_sha256 = yield* sha256(
      canonicalSharedJson({
        purpose: "current_text_projection",
        version: 1,
        directory: originalDirectory,
        plans: prepared.flatMap((file) => (file.kind === "text" ? [file.plan] : [])),
      }),
    )
    const result = (
      files: readonly CurrentProjectionFileResult[],
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
        : files.some((file) => file.status === "applied")
          ? "applied"
          : "unchanged",
      files,
      counts: {
        total: files.length,
        native_verified: files.filter((file) => file.status === "native_verified").length,
        skipped_binary: files.filter((file) => file.status === "skipped_binary").length,
        unchanged: files.filter((file) => file.status === "unchanged").length,
        would_write: files.filter((file) => file.status === "would_write").length,
        applied: files.filter((file) => file.status === "applied").length,
      },
    })
    const assertInventory = Effect.gen(function* () {
      const current = yield* queryCurrentSkillIndex(library, index.page_id)
      if (current.state.state !== "ready" || directory(current) !== originalDirectory)
        return yield* Effect.fail(invalid("The current Skill directory changed during projection."))
      // Source acquisition can outlive its ready/enablement/revision observation.
      // Re-admit only current metadata here; never materialize provider files again.
      yield* resolveCurrentSharedSources(library, {
        selections: sourceSelections(index),
        ...(input.sourceOptions === undefined ? {} : { sourceOptions: input.sourceOptions }),
      })
    })
    const inspect = Effect.gen(function* () {
      const files: CurrentProjectionFileResult[] = []
      for (const file of prepared) {
        if (file.kind !== "text") {
          files.push(file.result)
          continue
        }
        const observed = yield* inspectCurrentProjection({
          pageId: file.binding.page_id,
          plan: file.plan,
        })
        files.push({
          ...fileIdentity(file.binding),
          authority: file.binding.content.kind,
          bytes: file.bytes,
          representation: file.plan.representation,
          blocks: file.plan.blocks.length,
          status: observed.matches ? "unchanged" : "would_write",
        })
      }
      yield* assertInventory
      return result(files)
    })
    if (input.dry_run) return yield* inspect
    const api = yield* Notion
    const assertFile = (session: CurrentOperationSession, file: CurrentFileBinding) =>
      Effect.gen(function* () {
        const raw = yield* session.assertCurrent(),
          current = yield* queryCurrentSkillIndex(library, index.page_id, raw, index.files)
        if (current.skill_id !== index.skill_id || current.state.state !== "ready")
          return yield* Effect.fail(invalid("The selected Skill no longer owns this projection."))
        yield* checked(() => assertSameBinding(current.main, index.main))
        if (file.page_id !== index.page_id) {
          const rawFile = yield* api.request(`v1/pages/${file.page_id}`)
          yield* checked(() =>
            assertSameBinding(
              currentFileRecord(
                rawFile,
                index.page_id,
                library.files.data_source_id,
                library.files.property_ids,
              ),
              file,
            ),
          )
        }
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
            value.counts.would_write === 0
              ? Effect.succeed(value)
              : Effect.fail(
                  invalid("The completed projection is no longer complete; start a new operation."),
                ),
          ),
        ),
      run: (session) =>
        Effect.gen(function* () {
          const files: CurrentProjectionFileResult[] = []
          for (const file of prepared) {
            if (file.kind !== "text") {
              files.push(file.result)
              continue
            }
            const written = yield* applyCurrentProjection<Notion | Crypto.Crypto | Store>({
              pageId: file.binding.page_id,
              content: file.binding.content,
              plan: file.plan,
              assertCurrent: assertFile(session, file.binding),
              dispatch: session.dispatch,
            })
            files.push({
              ...fileIdentity(file.binding),
              authority: file.binding.content.kind,
              bytes: file.bytes,
              representation: file.plan.representation,
              blocks: written.blocks,
              status: written.changed ? "applied" : "unchanged",
            })
          }
          return result(files)
        }),
      verify: () => assertInventory,
    })
  }).pipe(
    (effect) => withCurrentInvocationBudget(effect),
    Effect.map(({ result }) => result),
  )
}
