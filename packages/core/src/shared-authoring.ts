import { Effect, Schema } from "effect"
import { authScope } from "./catalog.ts"
import { invalidateSnapshotCache } from "./cache.ts"
import { fail, property, SkillsError, type Snapshot } from "./model.ts"
import { normalizePath, pageId } from "./ref.ts"
import { parseYaml } from "./yaml.ts"
import { loadSharedLibrary } from "./shared-library.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import {
  executeSharedBodyWrite,
  prepareSharedBodyWrite,
  reconcileSharedBodyWrite,
} from "./shared-body-write.ts"
import {
  sharedBodyWriteProtection,
  type RestoreSource,
  type SharedBodyWritePlan,
} from "./shared-body-write-model.ts"
import { normalizeObservedBody } from "./shared-file-state.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { querySharedSkillIndex } from "./shared-skill-index.ts"
import {
  pendingFileOperations,
  pendingFileOperationKey,
  retainPendingFileOperation,
  sharedPendingObservationPrefix,
  type SharedPendingFileScope,
} from "./shared-pending-file-operations.ts"
import { sha256, Store } from "./store.ts"

/** Fresh-read evidence only; never serialized into a fixed snapshot or used as shared ownership. */
export type SharedAuthoringEvidence = {
  readonly version: 1
  readonly scope: string
  readonly snapshot_id: string
  readonly library_id: string
  readonly skill_id: string
  readonly skill_page_id: string
  readonly source_id: string
  readonly files: readonly {
    readonly file_id: string
    readonly page_id: string
    readonly path: string
    readonly heads: readonly string[]
    readonly body_sha256: string
  }[]
}
const EvidenceSchema = Schema.Struct({
  version: Schema.Literal(1),
  scope: Schema.String,
  snapshot_id: Schema.String,
  library_id: Schema.String,
  skill_id: Schema.String,
  skill_page_id: Schema.String,
  source_id: Schema.String,
  files: Schema.Array(
    Schema.Struct({
      file_id: Schema.String,
      page_id: Schema.String,
      path: Schema.String,
      heads: Schema.Array(Schema.String),
      body_sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
    }),
  ),
})
const checked = <A>(action: () => A) =>
  Effect.try({
    try: action,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("SHARED_AUTHORING_INVALID", "The shared file input is invalid."),
  })

/** Main metadata stays in Notion properties; unsupported frontmatter is never silently lost. */
export function sharedAuthoringMarkdown(
  snapshot: Snapshot,
  path: string,
  bytes: Uint8Array,
): string {
  const locator = snapshot.record.locator
  if (locator.type !== "shared_skill")
    throw fail("CONTENT_NOT_MUTABLE", "This authoring path requires a shared Skill.")
  if (normalizePath(path) !== path || !snapshot.files.some((file) => file.path === path))
    throw fail(
      "SHARED_FILE_NOT_BOUND",
      "Select an existing bound file; this operation does not create, delete or move paths.",
      { path },
    )
  let markdown: string
  try {
    markdown = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw fail("INVALID_INPUT", "Shared body writes require complete UTF-8 text.", { path })
  }
  if (markdown.includes("\0"))
    throw fail("INVALID_INPUT", "Shared body writes cannot contain NUL bytes.", { path })
  markdown = normalizeObservedBody(markdown)
  if (path !== snapshot.entrypoint) return markdown
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(markdown)
  if (match) {
    let value: unknown
    try {
      value = parseYaml(match[1] ?? "")
    } catch {
      throw fail("INVALID_SKILL", "The main file frontmatter must be valid YAML.")
    }
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw fail("INVALID_SKILL", "The main file frontmatter must be a metadata mapping.")
    const metadata = property(value)
    const unknown = Object.keys(metadata)
      .filter((name) => !["name", "description", "notion_page_id"].includes(name))
      .sort()
    if (unknown.length !== 0)
      throw fail(
        "SHARED_FRONTMATTER_UNSUPPORTED",
        "This body-only write cannot preserve additional main frontmatter fields. No fields were discarded or written.",
        { fields: unknown },
      )
    if (
      (metadata.name !== undefined && metadata.name !== snapshot.record.name) ||
      (metadata.description !== undefined && metadata.description !== snapshot.record.description)
    )
      throw fail(
        "SHARED_METADATA_CONFLICT",
        "Main name and description must match the current Notion properties; edit those properties explicitly.",
      )
    if (
      metadata.notion_page_id !== undefined &&
      (typeof metadata.notion_page_id !== "string" ||
        pageId(metadata.notion_page_id) !== locator.page_id)
    )
      throw fail(
        "SNAPSHOT_CONFLICT",
        "The main file notion_page_id belongs to another shared page.",
      )
    markdown = markdown.slice(match[0].length).replace(/^\n/u, "")
  }
  if (snapshot.record.kind === "router") {
    if (snapshot.router_members === undefined)
      throw fail(
        "SHARED_ROUTER_SNAPSHOT_INCOMPLETE",
        "Refresh the Router to obtain its exact generated Members index before writing.",
      )
    const members = snapshot.router_members.map((member) => {
      const metadata = property(member.metadata)
      if (
        metadata.version !== 1 ||
        metadata.kind !== "skill" ||
        metadata.enabled !== true ||
        metadata.library_id !== locator.library_id ||
        typeof metadata.name !== "string" ||
        typeof metadata.description !== "string"
      )
        throw fail("INVALID_MEMBERS", "The frozen Router member metadata is incomplete.")
      return `- [${metadata.name}](${member.ref}) — ${metadata.description}`
    })
    const footer = `\n\n## Members\n\n${members.join("\n")}\n`.trimEnd()
    const trimmed = markdown.trimEnd()
    if (!trimmed.endsWith(footer))
      throw fail(
        "SHARED_ROUTER_MEMBERS_CONFLICT",
        "Keep the exact generated Members index in the submitted Router file; member edits belong to the native relation.",
      )
    markdown = trimmed.slice(0, -footer.length)
  }
  return markdown
}

function pendingScope(scope: string, library: SharedLibrary, skillId: string, skillPageId: string) {
  return Effect.gen(function* () {
    return {
      prefix: yield* sharedPendingObservationPrefix(scope, library.library_id, skillId),
      scope,
      library_id: library.library_id,
      skill_id: skillId,
      skill_page_id: skillPageId,
    } satisfies SharedPendingFileScope
  })
}

function reconcileLocalBeforeNewPlan(library: SharedLibrary, scope: SharedPendingFileScope) {
  return Effect.gen(function* () {
    const first = (yield* pendingFileOperations(scope))[0]
    if (first === undefined) return
    if (first.plan.kind !== "body_write")
      return yield* Effect.fail(
        fail(
          "SHARED_OBSERVATION_PENDING",
          "A previous observation must be reconciled by a current read before another write can be planned.",
          { observation_operation_id: first.plan.operation_id },
        ),
      )
    const result = yield* reconcileSharedBodyWrite(library, first.plan)
    yield* invalidateSnapshotCache(
      `shared_skill:${library.library_id}:${scope.skill_id}`,
      scope.scope,
    )
    yield* (yield* Store).retireKeys([first.key])
    return yield* Effect.fail(
      fail(
        "SHARED_BODY_WRITE_RECONCILED",
        "The original body write is verified. Read the current page again before preparing new intent.",
        {
          body_write_operation_id: first.plan.operation_id,
          status: result.status,
          read_again: true,
        },
      ),
    )
  })
}

function dispatch(
  library: SharedLibrary,
  scope: SharedPendingFileScope,
  plan: SharedBodyWritePlan,
  dryRun: boolean,
) {
  return Effect.gen(function* () {
    if (dryRun)
      return {
        status: "planned" as const,
        dry_run: true as const,
        operation_id: plan.operation_id,
        path: plan.path,
        page_id: plan.page_id,
        file_id: plan.file_id,
        before_sha256: plan.before.fingerprint.sha256,
        candidate_sha256: plan.candidate.content.sha256,
        protection: sharedBodyWriteProtection,
        verified: true as const,
        unchanged:
          plan.action === "write" &&
          plan.before.fingerprint.sha256 === plan.candidate.content.sha256,
      }
    const result = yield* executeSharedBodyWrite(library, {
      plan,
      mode: "create",
      beforePlanWrite: (original) => retainPendingFileOperation(scope, original),
    })
    if (result.status !== "unchanged") {
      yield* invalidateSnapshotCache(
        `shared_skill:${library.library_id}:${scope.skill_id}`,
        scope.scope,
      )
      yield* (yield* Store).retireKeys([yield* pendingFileOperationKey(scope.prefix, plan)])
    }
    return {
      ...result,
      path: plan.path,
      page_id: plan.page_id,
      file_id: plan.file_id,
      before_sha256: plan.before.fingerprint.sha256,
      candidate_sha256: plan.candidate.content.sha256,
      unchanged: result.status === "unchanged",
      protection: sharedBodyWriteProtection,
    }
  })
}

/** Public write's exact fresh baseline. No legacy authored export or local ownership state. */
export function writeSharedSkillFile(input: {
  readonly snapshot: Snapshot
  readonly path: string
  readonly bytes: Uint8Array
  readonly dryRun?: boolean
}) {
  return Effect.gen(function* () {
    const snapshot = input.snapshot
    const locator = snapshot.record.locator
    if (locator.type !== "shared_skill")
      return yield* Effect.fail(fail("CONTENT_NOT_MUTABLE", "Select a shared Skill file."))
    const markdown = yield* checked(() =>
      sharedAuthoringMarkdown(snapshot, input.path, input.bytes),
    )
    const evidence = yield* checked(() =>
      Schema.decodeUnknownSync(EvidenceSchema)(property(snapshot).shared_authoring),
    )
    if (
      evidence.scope !== snapshot.scope ||
      evidence.snapshot_id !== snapshot.snapshot_id ||
      evidence.library_id !== locator.library_id ||
      evidence.skill_id !== locator.skill_id ||
      evidence.skill_page_id !== locator.page_id
    )
      return yield* Effect.fail(
        fail(
          "WRITE_CONFLICT",
          "The shared authoring baseline does not describe this exact fresh snapshot.",
        ),
      )
    const files = evidence.files.filter((file) => file.path === input.path)
    const file = files[0]
    if (files.length !== 1 || file === undefined)
      return yield* Effect.fail(
        fail("SHARED_FILE_NOT_BOUND", "The requested file has no unique active editable page.", {
          path: input.path,
        }),
      )
    const scope = yield* authScope
    if (scope !== snapshot.scope)
      return yield* Effect.fail(
        fail("SNAPSHOT_CONFLICT", "The snapshot belongs to another authenticated account scope."),
      )
    const library = yield* loadSharedLibrary(locator.database_id)
    if (
      library.library_id !== locator.library_id ||
      library.skills.data_source_id !== locator.data_source_id
    )
      return yield* Effect.fail(
        fail(
          "SHARED_FILE_SCOPE",
          "The fresh library descriptor differs from the snapshot's exact source.",
        ),
      )
    const journal = yield* pendingScope(scope, library, locator.skill_id, locator.page_id)
    yield* reconcileLocalBeforeNewPlan(library, journal)
    const index = yield* querySharedSkillIndex(library, locator.page_id)
    if (
      index.skill_id !== locator.skill_id ||
      index.name !== snapshot.record.name ||
      index.description !== snapshot.record.description ||
      index.kind !== snapshot.record.kind ||
      index.default_context !== snapshot.record.default_context ||
      !index.enabled
    )
      return yield* Effect.fail(
        fail("WRITE_CONFLICT", "The Skill metadata changed after the selected read."),
      )
    const plan = yield* prepareSharedBodyWrite({
      library,
      skillPageId: locator.page_id,
      fileId: file.file_id,
      action: "write",
      candidateMarkdown: markdown,
      expected: { heads: file.heads, body_sha256: file.body_sha256 },
    })
    if (
      plan.page_id !== file.page_id ||
      plan.path !== file.path ||
      plan.skill_id !== locator.skill_id ||
      plan.source_id !== evidence.source_id
    )
      return yield* Effect.fail(
        fail(
          "WRITE_CONFLICT",
          "The file binding or selected source changed after the selected read.",
        ),
      )
    return {
      ...(yield* dispatch(library, journal, plan, input.dryRun ?? false)),
      input_sha256: yield* sha256(input.bytes),
    }
  })
}

/** Same authentication, original-journal and dispatch boundary for explicit restore-follow. */
export function restoreSharedFileFollowing(input: {
  readonly library: SharedLibrary
  readonly skillPageId: string
  readonly fileId: string
  readonly candidateMarkdown: string
  readonly source: RestoreSource
  readonly dryRun?: boolean
}) {
  return Effect.gen(function* () {
    const scope = yield* authScope
    const library = yield* loadSharedLibrary(input.library.skills.database_id)
    if (canonicalSharedJson(library) !== canonicalSharedJson(input.library))
      return yield* Effect.fail(
        fail(
          "SHARED_FILE_SCOPE",
          "The registered shared library changed before restoring following.",
        ),
      )
    const index = yield* querySharedSkillIndex(library, input.skillPageId)
    const journal = yield* pendingScope(scope, library, index.skill_id, input.skillPageId)
    yield* reconcileLocalBeforeNewPlan(library, journal)
    const plan = yield* prepareSharedBodyWrite({
      library,
      skillPageId: input.skillPageId,
      fileId: input.fileId,
      action: "restore_follow",
      candidateMarkdown: input.candidateMarkdown,
      source: input.source,
    })
    return yield* dispatch(library, journal, plan, input.dryRun ?? false)
  })
}

/** A freshly read current body must still be the accepted candidate before public write success. */
export function verifySharedAuthoredSnapshot(
  snapshot: Snapshot,
  input: {
    readonly file_id: string
    readonly candidate_sha256: string
    readonly operation_id: string
  },
): void {
  const evidence = Schema.decodeUnknownSync(EvidenceSchema)(property(snapshot).shared_authoring)
  const files = evidence.files.filter((file) => file.file_id === input.file_id)
  if (
    evidence.snapshot_id !== snapshot.snapshot_id ||
    files.length !== 1 ||
    files[0]?.body_sha256 !== input.candidate_sha256
  )
    throw fail(
      "WRITE_VERIFICATION_FAILED",
      "The original write was verified, but a later current read differs from its frozen candidate. Preserve the later content.",
      { body_write_operation_id: input.operation_id, requires_fresh_read: true },
    )
}
