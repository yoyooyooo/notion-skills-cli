import { Effect, Schema } from "effect"
import { invalidateSnapshotCache } from "./cache.ts"
import { decode, fail, listSchema, property, SkillsError, text, type Snapshot } from "./model.ts"
import { Notion } from "./notion.ts"
import { pageId } from "./ref.ts"
import { composeSharedFiles } from "./shared-composition.ts"
import { sharedSkillId } from "./shared-content.ts"
import {
  inspectSharedFileManagementContext,
  revalidateSharedFileManagementContext,
} from "./shared-file-management.ts"
import { assertSharedFileReferences } from "./shared-file-references.ts"
import { FileEventSchema, resolveFileState, type ResourceContent } from "./shared-file-state.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { querySharedOperationIndex } from "./shared-operation-index.ts"
import {
  pendingFileOperations,
  retainPendingFileOperation,
} from "./shared-pending-file-operations.ts"
import { appendSharedRecord, canonicalSharedJson, querySharedRecords } from "./shared-records.ts"
import {
  isResourceContent,
  isResourceFollowing,
  resourceContentForOwnership,
  loadSharedResourceContent,
  prepareSharedResourceContent,
  retainSharedResourceContent,
} from "./shared-resource-content.ts"
import {
  makeSharedResourceAuthoringPlan,
  identifyResourceEvent,
  resourceAuthoringChecked,
  resourceAuthoringOutcomeId,
  resourceAuthoringOutcomesEntity,
  resourceAuthoringProtection,
  validateSharedResourceAuthoringPlan,
  type SharedResourceAuthoringOutcome,
  type SharedResourceAuthoringPlan,
} from "./shared-resource-authoring-model.ts"
import {
  reconcileSharedResourceAuthoring,
  resourceOperationScope,
  resourceOriginalRecord,
  retireResourceOperation,
} from "./shared-resource-authoring-recovery.ts"
import {
  assertResourceSnapshotShareable,
  resourceCandidateTree,
  selectedResourceBytes,
} from "./shared-resource-lifecycle.ts"
import { querySharedSkillIndex, type SharedSkillIndex } from "./shared-skill-index.ts"
import {
  prepareSharedSnapshotHistory,
  retainSharedSnapshotHistory,
} from "./shared-snapshot-history.ts"
import { sha256, Store } from "./store.ts"

export {
  loadSharedResourceAuthoringPlan,
  loadPendingSharedResourceAuthoring,
  reconcileSharedResourceAuthoring,
} from "./shared-resource-authoring-recovery.ts"
export {
  resourceAuthoringProtection,
  type SharedResourceAuthoringPlan,
} from "./shared-resource-authoring-model.ts"

function recovery(error: SkillsError, plan: SharedResourceAuthoringPlan, stage: string) {
  return fail(error.code, error.message, {
    ...property(error.details),
    resource_operation_id: plan.operation_id,
    stage,
    protection: resourceAuthoringProtection,
    recovery: { mode: "reconcile", plan },
  })
}
function contentEqual(left: ResourceContent, right: ResourceContent) {
  return canonicalSharedJson(left) === canonicalSharedJson(right)
}
function entryText(plan: SharedResourceAuthoringPlan) {
  return [
    `Resource: ${plan.destination_path ?? plan.path}`,
    `Action: ${plan.action}${plan.destination_path === null ? "" : ` from ${plan.path}`}`,
    `File ID: ${plan.file_id}`,
    `Version: sha256:${plan.content.sha256}`,
    `Bytes: ${plan.content.bytes}; mode: ${plan.content.mode ?? "unknown"}`,
    `Operation: ${plan.operation_id}`,
    "This page manages an exact-byte resource. Editing these notes does not change its bytes.",
    "",
  ].join("\n")
}
function entryBlock(plan: SharedResourceAuthoringPlan, retainedPage: string) {
  const content = entryText(plan)
  if (content.length > 1900)
    throw fail(
      "SHARED_RESOURCE_AUTHORING_INVALID",
      "The complete resource management entry exceeds the supported text size.",
    )
  return {
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: [
        { type: "text", text: { content } },
        {
          type: "text",
          text: {
            content: "Retained exact bytes",
            link: { url: `https://www.notion.so/${retainedPage.replaceAll("-", "")}` },
          },
        },
      ],
    },
  }
}
function verifyEntry(
  input: unknown,
  plan: SharedResourceAuthoringPlan,
  page: string,
  retainedPage: string,
): string {
  const block = property(input),
    paragraph = property(block.paragraph),
    parent = property(block.parent)
  const parts = paragraph.rich_text
  if (
    block.object !== "block" ||
    block.type !== "paragraph" ||
    typeof block.id !== "string" ||
    pageId(block.id) !== block.id ||
    block.archived === true ||
    block.in_trash === true ||
    parent.type !== "page_id" ||
    parent.page_id !== page ||
    !Array.isArray(parts) ||
    text(parts) !== entryText(plan) + "Retained exact bytes"
  )
    throw fail(
      "SHARED_RESOURCE_ENTRY_MISMATCH",
      "The resource version entry does not match its exact page and original operation.",
    )
  const links = parts.flatMap((part) => {
    const value = property(property(part).text),
      link = property(value.link)
    return typeof link.url === "string" ? [pageId(link.url)] : []
  })
  if (links.length !== 1 || links[0] !== retainedPage)
    throw fail(
      "SHARED_RESOURCE_ENTRY_MISMATCH",
      "The version entry does not link to the exact retained manifest.",
    )
  return block.id
}
function createdEntry(plan: SharedResourceAuthoringPlan, page: string, retainedPage: string) {
  return Effect.gen(function* () {
    const api = yield* Notion
    const cursors = new Set<string>(),
      matches: string[] = []
    let cursor: string | undefined
    for (;;) {
      const params = new URLSearchParams({
        page_size: "100",
        ...(cursor === undefined ? {} : { start_cursor: cursor }),
      })
      const response = yield* api.request(`v1/blocks/${page}/children?${params}`)
      const list = yield* resourceAuthoringChecked(() =>
        decode(listSchema(Schema.Unknown), response),
      )
      for (const block of list.results) {
        if (text(property(property(block).paragraph).rich_text).includes(plan.operation_id))
          matches.push(
            yield* resourceAuthoringChecked(() => verifyEntry(block, plan, page, retainedPage)),
          )
      }
      if (!list.has_more) {
        if (list.next_cursor !== null)
          return yield* Effect.fail(
            fail(
              "SHARED_RESOURCE_ENTRY_MISMATCH",
              "The version-entry query retained a terminal cursor.",
            ),
          )
        break
      }
      if (!list.next_cursor || cursors.has(list.next_cursor) || cursors.size >= 1000)
        return yield* Effect.fail(
          fail(
            "SHARED_RESOURCE_ENTRY_MISMATCH",
            "The complete version-entry query did not advance.",
          ),
        )
      cursor = list.next_cursor
      cursors.add(cursor)
    }
    if (matches.length !== 1)
      return yield* Effect.fail(
        fail(
          "SHARED_RESOURCE_ENTRY_MISMATCH",
          "The original created page has no unique exact resource version entry.",
        ),
      )
    return matches[0]!
  })
}

export function prepareSharedResourceAuthoring(input: {
  readonly library: SharedLibrary
  readonly snapshot: Snapshot
  readonly action: "add" | "replace"
  readonly path: string
  readonly bytes: Uint8Array
  readonly mode: "100644" | "100755"
}) {
  return Effect.gen(function* () {
    const context = yield* inspectSharedFileManagementContext(input.library, input.snapshot)
    const local = yield* pendingFileOperations(context.journal)
    if (local.length !== 0 || context.pending.length !== 0)
      return yield* Effect.fail(
        fail(
          "SHARED_RESOURCE_AUTHORING_PENDING",
          "Reconcile the original shared file operation before another resource change.",
        ),
      )
    const binding = context.index.files.find((file) => file.path === input.path)
    const originalFile = input.snapshot.files.find((file) => file.path === input.path)
    if (input.path === input.snapshot.entrypoint || /\.(md|markdown)$/iu.test(input.path))
      return yield* Effect.fail(
        fail(
          "SHARED_MAIN_FILE_PROTECTED",
          "Select a supporting non-document resource; Markdown keeps its editable-body path.",
        ),
      )
    if (
      input.action === "add"
        ? binding !== undefined || originalFile !== undefined
        : originalFile === undefined
    )
      return yield* Effect.fail(
        fail(
          "SHARED_RESOURCE_PATH_CONFLICT",
          "Add requires an absent path; replace requires one exact active resource path.",
        ),
      )
    const state = binding === undefined ? undefined : context.states.get(binding.file_id)
    if (
      binding !== undefined &&
      !(state?.ownership.kind === "custom" && isResourceContent(state.ownership.content)) &&
      !(state !== undefined && isResourceFollowing(state.ownership))
    )
      return yield* Effect.fail(
        fail(
          "SHARED_RESOURCE_NOT_MANAGED",
          "An editable or tombstoned native file cannot be implicitly converted into a raw resource.",
        ),
      )
    if (
      input.action === "replace" &&
      binding === undefined &&
      context.index.source_reference === ""
    )
      return yield* Effect.fail(
        fail(
          "SHARED_RESOURCE_NOT_MANAGED",
          "An unbound replacement requires the exact selected immutable source.",
        ),
      )
    yield* assertResourceSnapshotShareable(input.snapshot)
    const prepared = yield* prepareSharedResourceContent(input.bytes, input.mode)
    const beforeBytes =
      originalFile === undefined
        ? undefined
        : context.tree.find((file) => file.path === input.path)?.bytes
    if (originalFile !== undefined && beforeBytes === undefined)
      return yield* Effect.fail(
        fail(
          "SHARED_RESOURCE_AUTHORING_INVALID",
          "The complete original resource bytes are unavailable.",
        ),
      )
    const before =
      beforeBytes === undefined
        ? null
        : (yield* prepareSharedResourceContent(beforeBytes, originalFile?.mode ?? null)).content
    if (
      state?.ownership.kind === "custom" &&
      isResourceContent(state.ownership.content) &&
      before !== null &&
      !contentEqual(state.ownership.content, before)
    )
      return yield* Effect.fail(
        fail(
          "SHARED_RESOURCE_AUTHORING_INVALID",
          "The original resource bytes or mode differ from shared ownership.",
        ),
      )
    const fileId =
      binding?.file_id ??
      `resource-file-${yield* sha256(canonicalSharedJson([input.library.library_id, context.index.skill_id, input.snapshot.version_id, input.path, prepared.content]))}`
    const baseline =
      binding === undefined && before !== null
        ? yield* identifyResourceEvent({
            kind: "resource_followed",
            file_id: fileId,
            parents: [],
            source_id: context.index.source_reference,
            source_revision: context.evidence.source_revision,
            path: input.path,
            source_path: input.path,
            content: before,
            retained: null,
          })
        : null
    const candidate = yield* resourceAuthoringChecked(() =>
      composeSharedFiles({
        base: context.tree.filter((file) => file.path !== input.path),
        mounts: [],
        entrypoint: input.snapshot.entrypoint,
        overrides: [
          {
            kind: "custom",
            file_id: fileId,
            path: input.path,
            bytes: input.bytes,
            mode: input.mode,
          },
        ],
      }),
    )
    const referenceCheck = yield* resourceAuthoringChecked(() =>
      assertSharedFileReferences(candidate.files),
    )
    const prior = yield* prepareSharedSnapshotHistory(input.library, input.snapshot)
    const plan = yield* makeSharedResourceAuthoringPlan({
      action: input.action,
      library_id: input.library.library_id,
      skill_id: context.index.skill_id,
      skill_page_id: context.index.page_id,
      file_id: fileId,
      page_id: binding?.page_id ?? null,
      path: input.path,
      entrypoint: input.snapshot.entrypoint,
      destination_path: null,
      source_path:
        baseline?.source_path ??
        state?.placement?.source_path ??
        (state !== undefined && isResourceFollowing(state.ownership)
          ? state.ownership.source_path
          : null),
      source_id: context.index.source_reference,
      source_revision: context.evidence.source_revision,
      snapshot_id: input.snapshot.snapshot_id,
      snapshot_version_id: input.snapshot.version_id,
      snapshot_scope: context.scope,
      tree_sha256: context.tree_sha256,
      metadata_sha256: context.metadata_sha256,
      events_sha256: context.events_sha256,
      prior_pin: prior.pin_id,
      before,
      baseline,
      content: prepared.content,
      reference_check: referenceCheck,
      event: {
        kind: "adopted",
        file_id: fileId,
        parents: state?.heads ?? (baseline === null ? [] : [baseline.event_id]),
        content: prepared.content,
      },
    })
    yield* resourceAuthoringChecked(() => entryBlock(plan, plan.skill_page_id))
    yield* (yield* Store).writeBytes(
      `objects/${prepared.content.sha256}`,
      new Uint8Array(input.bytes),
    )
    return plan
  })
}

function saveOutcome(
  library: SharedLibrary,
  plan: SharedResourceAuthoringPlan,
  status: SharedResourceAuthoringOutcome["status"],
  reason: string,
  page: string | null = null,
  block: string | null = null,
) {
  return appendSharedRecord(library, {
    mode: "create",
    skillPageId: plan.skill_page_id,
    kind: "operation",
    entityId: resourceAuthoringOutcomesEntity,
    recordId: resourceAuthoringOutcomeId(plan.operation_id),
    operationId: plan.operation_id,
    payload: {
      version: 1,
      kind: "resource_authoring_outcome",
      operation_id: plan.operation_id,
      file_id: plan.file_id,
      status,
      reason_code: reason,
      page_id: page,
      entry_block_id: block,
      event_id: status === "applied" ? plan.event.event_id : null,
    } satisfies SharedResourceAuthoringOutcome,
  })
}
function sameOthers(
  before: SharedSkillIndex,
  after: SharedSkillIndex,
  plan: SharedResourceAuthoringPlan,
) {
  const shape = (index: SharedSkillIndex) => ({
    ...index,
    main:
      plan.page_id === null ? { ...index.main, last_edited_time: "relation_creation" } : index.main,
    files: index.files
      .filter((file) => file.file_id !== plan.file_id)
      .sort((a, b) => a.file_id.localeCompare(b.file_id)),
  })
  return canonicalSharedJson(shape(before)) === canonicalSharedJson(shape(after))
}
function readEvents(library: SharedLibrary, skillPageId: string) {
  return Effect.gen(function* () {
    const rows = yield* querySharedRecords(library, { skillPageId, kind: "file_event" })
    return yield* resourceAuthoringChecked(() =>
      rows.map((row) => {
        const event = decode(FileEventSchema, row.payload)
        if (row.record_id !== event.event_id || row.entity_id !== event.file_id)
          throw fail("SHARED_STATE_SCOPE", "The resource operation found a foreign file event.")
        return event
      }),
    )
  })
}
function eventsDigest(events: readonly unknown[]) {
  return sha256(
    canonicalSharedJson(
      [...events].sort((a, b) =>
        String(property(a).event_id).localeCompare(String(property(b).event_id)),
      ),
    ),
  )
}

export function executeSharedResourceAuthoring(
  library: SharedLibrary,
  input: { readonly plan: SharedResourceAuthoringPlan; readonly mode: "create" | "reconcile" },
) {
  return Effect.gen(function* () {
    const plan = yield* validateSharedResourceAuthoringPlan(input.plan)
    if (input.mode === "reconcile") return yield* reconcileSharedResourceAuthoring(library, plan)
    if (input.mode !== "create")
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "Resource authoring requires create or reconcile mode."),
      )
    const journal = yield* resourceOperationScope(library, plan)
    const local = yield* pendingFileOperations(journal)
    const original = local.find((entry) => entry.plan.operation_id === plan.operation_id)
    if (original !== undefined) {
      if (canonicalSharedJson(original.plan) !== canonicalSharedJson(plan))
        return yield* Effect.fail(
          fail("STATE_CORRUPT", "The original resource plan cannot be replaced."),
        )
      return yield* reconcileSharedResourceAuthoring(library, plan)
    }
    const headers = yield* querySharedOperationIndex(library, plan.skill_page_id)
    if (headers.some((header) => header.record_id === plan.operation_id))
      return yield* reconcileSharedResourceAuthoring(library, plan)
    const before = yield* revalidateSharedFileManagementContext(library, plan)
    if (local.length !== 0 || before.pending.length !== 0)
      return yield* Effect.fail(
        fail(
          "SHARED_RESOURCE_AUTHORING_PENDING",
          "An original shared file operation must be reconciled before resource dispatch.",
        ),
      )
    yield* resourceAuthoringChecked(() => {
      const binding = before.index.files.find((file) => file.file_id === plan.file_id)
      const originalFile = before.snapshot.files.find((file) => file.path === plan.path)
      if (plan.page_id === null) {
        if (
          binding !== undefined ||
          before.index.files.some((file) => file.path === plan.path) ||
          (plan.action === "add"
            ? originalFile !== undefined
            : originalFile === undefined || before.index.source_reference === "")
        )
          throw fail(
            "SHARED_RESOURCE_PATH_CONFLICT",
            "The original new resource binding is no longer absent.",
          )
      } else {
        const state = before.states.get(plan.file_id)
        const owned = state === undefined ? undefined : resourceContentForOwnership(state.ownership)
        if (
          binding === undefined ||
          binding.page_id !== plan.page_id ||
          binding.path !== plan.path ||
          state === undefined ||
          owned === undefined ||
          plan.before === null ||
          (!isResourceFollowing(state.ownership) && !contentEqual(owned, plan.before)) ||
          (state.ownership.kind === "tombstone" &&
            plan.action !== "restore" &&
            plan.action !== "undelete") ||
          (plan.action === "undelete" && state.ownership.kind !== "tombstone") ||
          (plan.action === "restore" && isResourceFollowing(state.ownership)) ||
          canonicalSharedJson(state.heads) !== canonicalSharedJson(plan.event.parents)
        )
          throw fail(
            "SHARED_RESOURCE_AUTHORING_STALE",
            "The original managed resource or its complete frontier changed.",
          )
      }
      if (
        plan.destination_path !== null &&
        before.index.files.some(
          (file) => file.path === plan.destination_path && file.file_id !== plan.file_id,
        )
      )
        throw fail(
          "SHARED_RESOURCE_PATH_CONFLICT",
          "The destination belongs to another stable File ID.",
        )
      const deleted = before.states.get(plan.file_id)?.ownership.kind === "tombstone"
      if (
        deleted
          ? originalFile !== undefined
          : plan.before !== null &&
            (originalFile?.sha256 !== plan.before.sha256 ||
              originalFile?.bytes !== plan.before.bytes ||
              (originalFile.mode ?? null) !== plan.before.mode)
      )
        throw fail(
          "SHARED_RESOURCE_AUTHORING_STALE",
          "The original resource differs from its frozen complete snapshot.",
        )
    })
    if (
      plan.action === "replace" &&
      before.states.get(plan.file_id)?.ownership.kind === "custom" &&
      plan.page_id !== null &&
      plan.before !== null &&
      contentEqual(plan.before, plan.content)
    )
      return {
        status: "unchanged" as const,
        file_id: plan.file_id,
        page_id: plan.page_id,
        verified: true as const,
        remote_writes: 0 as const,
      }
    yield* assertResourceSnapshotShareable(before.snapshot)
    const store = yield* Store
    const bytes = yield* store.readBytes(`objects/${plan.content.sha256}`)
    const prepared = yield* prepareSharedResourceContent(bytes, plan.content.mode)
    if (!contentEqual(prepared.content, plan.content))
      return yield* Effect.fail(
        fail(
          "SHARED_RESOURCE_AUTHORING_INVALID",
          "The frozen resource input failed its complete content identity.",
        ),
      )
    if (plan.action === "restore") {
      const selected = yield* selectedResourceBytes(library, {
        skill_page_id: plan.skill_page_id,
        source_id: plan.source_id,
        source_revision: plan.source_revision,
        source_path: plan.source_path!,
      })
      const expected = yield* prepareSharedResourceContent(selected.bytes, selected.mode)
      if (!contentEqual(expected.content, plan.content))
        return yield* Effect.fail(
          fail(
            "SHARED_RESOURCE_SOURCE_STALE",
            "The restored bytes differ from the exact source frozen in the original plan.",
          ),
        )
    }
    const oldPrepared =
      plan.before === null
        ? undefined
        : yield* prepareSharedResourceContent(
            yield* store.readBytes(`objects/${plan.before.sha256}`),
            plan.before.mode,
          )
    if (
      oldPrepared !== undefined &&
      plan.before !== null &&
      !contentEqual(oldPrepared.content, plan.before)
    )
      return yield* Effect.fail(
        fail(
          "SHARED_RESOURCE_AUTHORING_INVALID",
          "The complete prior resource failed its frozen identity.",
        ),
      )
    const prior = yield* prepareSharedSnapshotHistory(library, before.snapshot)
    if (prior.pin_id !== plan.prior_pin)
      return yield* Effect.fail(
        fail(
          "SHARED_RESOURCE_AUTHORING_INVALID",
          "The exact prior snapshot differs from the original retained pin.",
        ),
      )
    const { reference_check: referenceCheck } = yield* resourceAuthoringChecked(() =>
      resourceCandidateTree(before.tree, plan, bytes),
    )
    if (canonicalSharedJson(referenceCheck) !== canonicalSharedJson(plan.reference_check))
      return yield* Effect.fail(
        fail(
          "SHARED_RESOURCE_AUTHORING_INVALID",
          "The checked complete reference tree differs from the original plan.",
        ),
      )
    yield* resourceAuthoringChecked(() => entryBlock(plan, plan.skill_page_id))
    yield* retainPendingFileOperation(journal, plan)
    yield* invalidateSnapshotCache(sharedSkillId(plan.library_id, plan.skill_id), journal.scope)
    yield* resourceOriginalRecord(library, plan, "create").pipe(
      Effect.mapError((error) => recovery(error, plan, "plan")),
    )
    yield* retainSharedSnapshotHistory(library, { plan: prior, mode: "create" }).pipe(
      Effect.mapError((error) => recovery(error, plan, "prior_snapshot")),
    )
    if (oldPrepared !== undefined)
      yield* retainSharedResourceContent(library, {
        skillPageId: plan.skill_page_id,
        prepared: oldPrepared,
        mode: "create",
      }).pipe(Effect.mapError((error) => recovery(error, plan, "prior_resource")))
    const retained = yield* retainSharedResourceContent(library, {
      skillPageId: plan.skill_page_id,
      prepared,
      mode: "create",
    }).pipe(Effect.mapError((error) => recovery(error, plan, "resource")))
    const rechecked = yield* revalidateSharedFileManagementContext(library, plan).pipe(
      Effect.result,
    )
    if (rechecked._tag === "Failure") {
      yield* saveOutcome(library, plan, "not_sent", rechecked.failure.code, plan.page_id).pipe(
        Effect.mapError((error) => recovery(error, plan, "outcome")),
      )
      return yield* Effect.fail(recovery(rechecked.failure, plan, "pre_send"))
    }
    if (rechecked.success.pending.some((pending) => pending.operation_id !== plan.operation_id)) {
      yield* saveOutcome(
        library,
        plan,
        "not_sent",
        "SHARED_RESOURCE_AUTHORING_PENDING",
        plan.page_id,
      )
      return yield* Effect.fail(
        recovery(
          fail(
            "SHARED_RESOURCE_AUTHORING_PENDING",
            "Another original file operation appeared before dispatch.",
          ),
          plan,
          "pre_send",
        ),
      )
    }
    const api = yield* Notion
    const entry = yield* resourceAuthoringChecked(() => entryBlock(plan, retained.record.page_id))
    const field = library.files.property_ids
    const rich = (value: string) => ({ rich_text: [{ type: "text", text: { content: value } }] })
    const targetPath = plan.destination_path ?? plan.path
    const pathChanged = plan.action === "move" && plan.page_id !== null
    if (pathChanged) {
      const moved = yield* api
        .request(
          `v1/pages/${plan.page_id}`,
          { properties: { [field.Path!]: rich(targetPath) } },
          { method: "PATCH" },
        )
        .pipe(Effect.result)
      if (moved._tag === "Failure") {
        const details = property(moved.failure.details)
        if (
          moved.failure.code === "NOTION_REQUEST_FAILED" &&
          details.phase === "definitive_rejection" &&
          details.http_status === 400 &&
          details.notion_code === "validation_error"
        )
          yield* saveOutcome(library, plan, "rejected", moved.failure.code, plan.page_id).pipe(
            Effect.mapError((error) => recovery(error, plan, "outcome")),
          )
        return yield* Effect.fail(recovery(moved.failure, plan, "move_path"))
      }
      const receipt = property(moved.success)
      if (receipt.object !== "page" || receipt.id !== plan.page_id) {
        yield* saveOutcome(
          library,
          plan,
          "needs_review",
          "SHARED_RESOURCE_ENTRY_MISMATCH",
          plan.page_id,
        ).pipe(Effect.mapError((error) => recovery(error, plan, "outcome")))
        return yield* Effect.fail(
          recovery(
            fail(
              "SHARED_RESOURCE_AUTHORING_REVIEW_REQUIRED",
              "The original Path update returned no exact page receipt; preserve the original operation.",
            ),
            plan,
            "move_path",
          ),
        )
      }
    }
    const response = yield* (
      plan.page_id === null
        ? api.request(
            "v1/pages",
            {
              parent: { type: "data_source_id", data_source_id: library.files.data_source_id },
              properties: {
                [field.Name!]: {
                  title: [
                    { type: "text", text: { content: targetPath.split("/").at(-1) ?? targetPath } },
                  ],
                },
                [field["File ID"]!]: rich(plan.file_id),
                [field.Path!]: rich(targetPath),
                [field.Projection!]: { rich_text: [] },
                [field.Status!]: {
                  select: {
                    name:
                      plan.action === "delete"
                        ? "tombstone"
                        : plan.action === "move"
                          ? "following"
                          : "custom",
                  },
                },
                [field.Skill!]: { relation: [{ id: plan.skill_page_id }] },
              },
              children: [entry],
            },
            { method: "POST" },
          )
        : api.request(
            `v1/blocks/${plan.page_id}/children`,
            { children: [entry] },
            { method: "PATCH" },
          )
    ).pipe(Effect.result)
    if (response._tag === "Failure") {
      const details = property(response.failure.details)
      if (
        response.failure.code === "NOTION_REQUEST_FAILED" &&
        details.phase === "definitive_rejection" &&
        details.http_status === 400 &&
        details.notion_code === "validation_error"
      )
        yield* saveOutcome(
          library,
          plan,
          pathChanged ? "needs_review" : "rejected",
          response.failure.code,
          plan.page_id,
        ).pipe(Effect.mapError((error) => recovery(error, plan, "outcome")))
      return yield* Effect.fail(
        recovery(
          response.failure,
          plan,
          plan.page_id === null ? "create_page" : "append_version_entry",
        ),
      )
    }
    let selectedPage = plan.page_id
    let blockId: string | null = null
    const verified = yield* Effect.gen(function* () {
      if (selectedPage === null) {
        const result = property(response.success)
        if (
          result.object !== "page" ||
          typeof result.id !== "string" ||
          pageId(result.id) !== result.id
        )
          return yield* Effect.fail(
            fail(
              "SHARED_RESOURCE_ENTRY_MISMATCH",
              "The original create returned no exact page receipt.",
            ),
          )
        selectedPage = result.id
        blockId = yield* createdEntry(plan, selectedPage, retained.record.page_id)
      } else {
        const result = yield* resourceAuthoringChecked(() =>
          decode(listSchema(Schema.Unknown), response.success),
        )
        if (result.results.length !== 1 || result.has_more || result.next_cursor !== null)
          return yield* Effect.fail(
            fail(
              "SHARED_RESOURCE_ENTRY_MISMATCH",
              "The append returned no single complete original block receipt.",
            ),
          )
        blockId = yield* resourceAuthoringChecked(() =>
          verifyEntry(result.results[0], plan, selectedPage!, retained.record.page_id),
        )
        const current = yield* api.request(`v1/blocks/${blockId}`)
        if (
          (yield* resourceAuthoringChecked(() =>
            verifyEntry(current, plan, selectedPage!, retained.record.page_id),
          )) !== blockId
        )
          return yield* Effect.fail(
            fail(
              "SHARED_RESOURCE_ENTRY_MISMATCH",
              "The original version block changed during readback.",
            ),
          )
      }
      const index = yield* querySharedSkillIndex(library, plan.skill_page_id)
      const binding = index.files.find((file) => file.file_id === plan.file_id)
      if (
        binding === undefined ||
        binding.page_id !== selectedPage ||
        binding.path !== targetPath ||
        !sameOthers(before.index, index, plan)
      )
        return yield* Effect.fail(
          fail(
            "SHARED_RESOURCE_AUTHORING_STALE",
            "The exact resource binding, source or other Skill metadata changed during dispatch.",
          ),
        )
      const events = yield* readEvents(library, plan.skill_page_id)
      if ((yield* eventsDigest(events)) !== plan.events_sha256)
        return yield* Effect.fail(
          fail(
            "SHARED_RESOURCE_AUTHORING_STALE",
            "The shared file frontier changed during dispatch.",
          ),
        )
      yield* loadSharedResourceContent(library, {
        skillPageId: plan.skill_page_id,
        content: plan.content,
      })
      yield* resourceAuthoringChecked(() =>
        resolveFileState(plan.file_id, [
          ...events.filter((event) => event.file_id === plan.file_id),
          ...(plan.baseline === null ? [] : [plan.baseline]),
          plan.event,
        ]),
      )
      return { page_id: binding.page_id, block_id: blockId }
    }).pipe(Effect.result)
    if (verified._tag === "Failure") {
      yield* saveOutcome(
        library,
        plan,
        "needs_review",
        verified.failure.code,
        selectedPage,
        blockId,
      ).pipe(Effect.mapError((error) => recovery(error, plan, "outcome")))
      return yield* Effect.fail(
        recovery(
          fail(
            "SHARED_RESOURCE_AUTHORING_REVIEW_REQUIRED",
            "The exact resource postcondition was not verified; preserve the page, bytes and original intent.",
            { cause_code: verified.failure.code },
          ),
          plan,
          "postcondition",
        ),
      )
    }
    if (plan.baseline !== null)
      yield* appendSharedRecord(library, {
        mode: "create",
        skillPageId: plan.skill_page_id,
        kind: "file_event",
        entityId: plan.file_id,
        recordId: plan.baseline.event_id,
        operationId: plan.baseline.event_id,
        payload: plan.baseline,
      }).pipe(Effect.mapError((error) => recovery(error, plan, "source_baseline")))
    yield* appendSharedRecord(library, {
      mode: "create",
      skillPageId: plan.skill_page_id,
      kind: "file_event",
      entityId: plan.file_id,
      recordId: plan.event.event_id,
      operationId: plan.event.event_id,
      payload: plan.event,
    }).pipe(Effect.mapError((error) => recovery(error, plan, "event")))
    const facts = yield* readEvents(library, plan.skill_page_id)
    const state = yield* resourceAuthoringChecked(() =>
      resolveFileState(
        plan.file_id,
        facts.filter((event) => event.file_id === plan.file_id),
      ),
    ).pipe(Effect.mapError((error) => recovery(error, plan, "event_frontier")))
    if (
      !facts.some(
        (event) =>
          event.event_id === plan.event.event_id &&
          canonicalSharedJson(event) === canonicalSharedJson(plan.event),
      )
    )
      return yield* Effect.fail(
        recovery(
          fail(
            "SHARED_RESOURCE_AUTHORING_UNRESOLVED",
            "The original resource event is not yet visible.",
          ),
          plan,
          "event",
        ),
      )
    yield* saveOutcome(
      library,
      plan,
      "applied",
      "EXACT_RESOURCE_AND_EVENT_VERIFIED",
      verified.success.page_id,
      verified.success.block_id,
    ).pipe(Effect.mapError((error) => recovery(error, plan, "outcome")))
    yield* retireResourceOperation(library, plan)
    return {
      status: "applied" as const,
      operation_id: plan.operation_id,
      file_id: plan.file_id,
      page_id: verified.success.page_id,
      path: targetPath,
      content: plan.content,
      prior_pin: plan.prior_pin,
      event: plan.event,
      state,
      verified: true as const,
      requires_fresh_read: true as const,
    }
  })
}
