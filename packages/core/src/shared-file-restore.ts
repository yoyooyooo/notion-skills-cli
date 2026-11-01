import { Clock, Effect } from "effect"
import { authScope } from "./catalog.ts"
import { importDocument } from "./import.ts"
import { decode, fail, SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import { normalizePath, pageId } from "./ref.ts"
import { restoreSharedFileFollowing, verifySharedAuthoredSnapshot } from "./shared-authoring.ts"
import { openSharedConsumer } from "./shared-consumer.ts"
import { FileEventSchema, normalizeObservedBody, resolveFileState } from "./shared-file-state.ts"
import { sharedFileSourcePath } from "./shared-file-placement.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { querySharedRecords } from "./shared-records.ts"
import { resolveSelectedSharedSource } from "./shared-selected-source.ts"
import { querySharedSkillIndex } from "./shared-skill-index.ts"
import { sha256 } from "./store.ts"

const checked = <A>(action: () => A) =>
  Effect.try({
    try: action,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("SHARED_RESTORE_INVALID", "The exact fixed-source file cannot be restored."),
  })

/** Restore only the source selected in Notion, retaining the previous complete custom body. */
export function restoreSelectedSharedFile(input: {
  readonly library: SharedLibrary
  readonly skillPageId: string
  readonly path: string
  readonly dryRun?: boolean
  readonly allowLocalArchive?: boolean
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
    const markdown = yield* checked(() => {
      let value: string
      if (binding.file_id === index.main.file_id) {
        value = importDocument(candidate, { name: index.name, description: index.description }).body
      } else {
        try {
          value = new TextDecoder("utf-8", { fatal: true }).decode(candidate.bytes)
        } catch {
          throw fail(
            "BINARY_FILE",
            "A native editable page cannot restore binary source bytes; the original file is unchanged.",
            { path: input.path },
          )
        }
      }
      if (value.includes("\0"))
        throw fail(
          "BINARY_FILE",
          "A native body restore requires complete UTF-8 Markdown without NUL.",
          { path: input.path },
        )
      return normalizeObservedBody(value)
    })
    const result = yield* restoreSharedFileFollowing({
      library: input.library,
      skillPageId: index.page_id,
      fileId: binding.file_id,
      candidateMarkdown: markdown,
      source: { source_id: source.source_id, revision: source.revision, path: sourcePath },
      expected,
      dryRun: input.dryRun,
    })
    const sourceSha256 = yield* sha256(candidate.bytes)
    if (input.dryRun)
      return {
        ...result,
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
