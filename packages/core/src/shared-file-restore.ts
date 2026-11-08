import { Clock, Effect } from "effect"
import { authScope } from "./catalog.ts"
import { importDocument } from "./import.ts"
import { decode, fail, property, SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import { withReadOnlyNotion } from "./notion-readonly.ts"
import { normalizePath, pageId } from "./ref.ts"
import { restoreSharedFileFollowing, verifySharedAuthoredSnapshot } from "./shared-authoring.ts"
import { openSharedConsumer } from "./shared-consumer.ts"
import {
  FileEventSchema,
  normalizeObservedBody,
  notionWriteCapabilities,
  resolveFileState,
  isResourceFollowing,
  resourceContentForOwnership,
} from "./shared-file-state.ts"
import { reconcileSharedBodyWrite, validateSharedBodyWritePlan } from "./shared-body-write.ts"
import { sharedFileSourcePath } from "./shared-file-placement.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { querySharedRecords } from "./shared-records.ts"
import { resolveSelectedSharedSource } from "./shared-selected-source.ts"
import { querySharedSkillIndex } from "./shared-skill-index.ts"
import { sha256, Store } from "./store.ts"
import {
  nativeMainFrontmatter,
  splitNativeSupportingMarkdown,
} from "./shared-native-file-metadata.ts"
import {
  pendingFileOperationKey,
  pendingFileOperations,
  sharedPendingObservationPrefix,
} from "./shared-pending-file-operations.ts"

const checked = <A>(action: () => A) =>
  Effect.try({
    try: action,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("SHARED_RESTORE_INVALID", "The exact fixed-source file cannot be restored."),
  })

/** Restore only the source selected in Notion, retaining the previous complete custom body. */
export function restoreSelectedSharedFile<R = never>(input: {
  readonly library: SharedLibrary
  readonly skillPageId: string
  readonly path: string
  readonly dryRun?: boolean
  readonly allowLocalArchive?: boolean
  readonly beforeRestoreDispatch?: Effect.Effect<void, SkillsError, R>
}) {
  return Effect.gen(function* () {
    yield* checked(() => {
      if (
        pageId(input.skillPageId) !== input.skillPageId ||
        normalizePath(input.path) !== input.path ||
        !input.path ||
        input.path === "."
      )
        throw fail(
          "INVALID_ARGUMENT",
          "Restore requires an exact Skill page ID and canonical logical file path.",
        )
    })
    const index = yield* querySharedSkillIndex(input.library, input.skillPageId)
    if (!index.enabled)
      return yield* Effect.fail(
        fail("CONTENT_DISABLED", "Enable the selected Skill before restoring a file."),
      )
    if (!index.source_reference)
      return yield* Effect.fail(
        fail("SHARED_SOURCE_MISSING", "The Skill has no selected immutable source to follow."),
      )
    const binding = yield* checked(() => {
      const matches = [index.main, ...index.files].filter((file) => file.path === input.path)
      if (matches.length !== 1)
        throw fail(
          "SHARED_FILE_NOT_BOUND",
          "The requested path has no unique existing editable File ID.",
          { path: input.path },
        )
      return matches[0]!
    })
    const facts = yield* querySharedRecords(input.library, {
      skillPageId: index.page_id,
      kind: "file_event",
    })
    const state = yield* checked(() =>
      resolveFileState(
        binding.file_id,
        facts.flatMap((fact) => {
          const event = decode(FileEventSchema, fact.payload)
          if (fact.record_id !== event.event_id || fact.entity_id !== event.file_id)
            throw fail(
              "SHARED_STATE_SCOPE",
              "A file event disagrees with its exact shared record identity.",
            )
          return event.file_id === binding.file_id ? [event] : []
        }),
      ),
    )
    if (state.ownership.kind === "tombstone")
      return yield* Effect.fail(
        fail(
          "SHARED_BODY_WRITE_SCOPE",
          "A deleted file requires an explicit lifecycle restoration before restore-follow; its retained page and bytes are unchanged.",
        ),
      )
    if (
      resourceContentForOwnership(state.ownership) !== undefined ||
      isResourceFollowing(state.ownership)
    )
      return yield* Effect.fail(
        fail(
          "SHARED_RESTORE_UNSUPPORTED",
          "Raw resources require their retained byte restoration lifecycle; their management page is not Markdown file content.",
        ),
      )
    const expected = {
      path: binding.path,
      heads: state.heads,
      body_sha256:
        state.ownership.kind === "custom"
          ? state.ownership.content.sha256
          : state.ownership.projection.sha256,
    }
    const sourcePath = yield* checked(() => sharedFileSourcePath(binding.path, state))
    const source = yield* resolveSelectedSharedSource(
      input.library,
      index.page_id,
      index.source_reference,
    )
    const candidate = yield* checked(() => {
      const matches = source.files.filter((file) => file.path === sourcePath)
      if (matches.length !== 1)
        throw fail(
          "SHARED_SOURCE_FILE_MISSING",
          "The selected fixed source has no exact file at this file's retained source path.",
          { path: binding.path, source_path: sourcePath },
        )
      return matches[0]!
    })
    if (source.local_paths.includes(sourcePath) && !input.allowLocalArchive)
      return yield* Effect.fail(
        fail(
          "LOCAL_RESOURCE_ARCHIVE_REQUIRED",
          "Restoring this local resource would retain its bytes in shared Notion records. Authorize this exact file with --allow-local-archive.",
          { paths: [input.path] },
        ),
      )
    const document = yield* checked(() => {
      let text: string
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(candidate.bytes)
      } catch {
        throw fail(
          "BINARY_FILE",
          "A native editable page cannot restore binary source bytes; the original file is unchanged.",
          { path: input.path },
        )
      }
      if (text.includes("\0"))
        throw fail(
          "BINARY_FILE",
          "A native body restore requires complete UTF-8 Markdown without NUL.",
          { path: input.path },
        )
      const parsed =
        binding.file_id === index.main.file_id
          ? {
              body: importDocument(candidate, { name: index.name, description: index.description })
                .body,
              frontmatter: nativeMainFrontmatter(text),
            }
          : splitNativeSupportingMarkdown(text)
      return { ...parsed, body: normalizeObservedBody(parsed.body) }
    })
    const result = yield* restoreSharedFileFollowing({
      library: input.library,
      skillPageId: index.page_id,
      fileId: binding.file_id,
      candidateMarkdown: document.body,
      source: {
        source_id: source.source_id,
        revision: source.revision,
        path: sourcePath,
        ...(candidate.mode === undefined ? {} : { mode: candidate.mode }),
        ...(document.frontmatter === undefined ? {} : { frontmatter: document.frontmatter }),
      },
      expected,
      dryRun: input.dryRun,
      ...(input.beforeRestoreDispatch === undefined
        ? {}
        : { beforeRestoreDispatch: input.beforeRestoreDispatch }),
    })
    const sourceSha256 = yield* sha256(candidate.bytes)
    if (input.dryRun)
      return {
        ...result,
        execution:
          result.before_sha256 === result.candidate_sha256
            ? { kind: "no_body_write" as const, revalidation_required: true as const }
            : {
                kind: "blocked" as const,
                code: "BODY_REPLACEMENT_UNSAFE" as const,
                capability: notionWriteCapabilities.editable_projection_overwrite,
              },
        source_id: source.source_id,
        source_revision: source.revision,
        source_path: sourcePath,
        source_sha256: sourceSha256,
        request_metrics: (yield* Notion).requestMetrics?.(),
      }
    const current = yield* openSharedConsumer({
      library: input.library,
      target: index.page_id,
      scope: yield* authScope,
      startedAt: yield* Clock.currentTimeMillis,
      forceFull: true,
      readOnly: true,
    })
    yield* checked(() =>
      verifySharedAuthoredSnapshot(current, {
        file_id: result.file_id,
        candidate_sha256: result.candidate_sha256,
        operation_id: result.operation_id,
      }),
    )
    return {
      ...result,
      source_id: source.source_id,
      source_revision: source.revision,
      source_path: sourcePath,
      source_sha256: sourceSha256,
      snapshot_id: current.snapshot_id,
      version_id: current.version_id,
      record: current.record,
      ref: current.record.ref + `?snapshot=${current.snapshot_id}`,
      request_metrics: (yield* Notion).requestMetrics?.(),
    }
  })
}

/** Observe the exact original restore without selecting, retaining or rewriting anything. */
export function reconcileSelectedSharedFileRestore(input: {
  readonly library: SharedLibrary
  readonly skillPageId: string
  readonly path: string
  readonly operationId: string
}) {
  return Effect.gen(function* () {
    if (!/^body-write-follow-[a-f0-9]{64}\.[a-f0-9]{64}$/u.test(input.operationId))
      return yield* Effect.fail(
        fail(
          "INVALID_ARGUMENT",
          "Reconcile requires the exact original restore-follow operation ID.",
        ),
      )
    const records = yield* querySharedRecords(input.library, {
      skillPageId: input.skillPageId,
      kind: "operation",
      recordId: input.operationId,
      payloadContainsBody: true,
    })
    const record = records[0]
    if (records.length !== 1 || record === undefined)
      return yield* Effect.fail(
        fail(
          "SHARED_BODY_WRITE_UNRESOLVED",
          "The original restore plan is unavailable; no new operation was created.",
        ),
      )
    const plan = yield* validateSharedBodyWritePlan(record.payload)
    if (
      plan.action !== "restore_follow" ||
      plan.library_id !== input.library.library_id ||
      plan.skill_page_id !== input.skillPageId ||
      plan.path !== input.path ||
      plan.operation_id !== input.operationId ||
      record.record_id !== plan.operation_id ||
      record.operation_id !== plan.operation_id ||
      record.entity_id !== plan.file_id
    )
      return yield* Effect.fail(
        fail(
          "SHARED_BODY_WRITE_SCOPE",
          "The original restore belongs to another exact library, Skill or file.",
        ),
      )
    const original = yield* reconcileSharedBodyWrite(input.library, plan)
    const scope = yield* authScope
    const journal = {
      prefix: yield* sharedPendingObservationPrefix(scope, input.library.library_id, plan.skill_id),
      scope,
      library_id: input.library.library_id,
      skill_id: plan.skill_id,
      skill_page_id: plan.skill_page_id,
    }
    if (
      (yield* pendingFileOperations(journal)).some(
        (entry) => entry.plan.operation_id === plan.operation_id,
      )
    )
      yield* (yield* Store).retireKeys([yield* pendingFileOperationKey(journal.prefix, plan)])
    return {
      ...original,
      file_id: plan.file_id,
      page_id: plan.page_id,
      path: plan.path,
      source: plan.restore_source,
      selected_version: plan.source_id,
      remote_writes: 0 as const,
    }
  }).pipe(withReadOnlyNotion)
}
