import { Effect } from "effect"
import { authScope } from "./catalog.ts"
import { fail, type Snapshot } from "./model.ts"
import { withReadOnlyNotion } from "./notion-readonly.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import {
  makeSharedBodyWritePlan,
  validateSharedBodyWritePlan,
  type SharedBodyWritePlan,
} from "./shared-body-write-model.ts"
import { executeSharedBodyWrite, reconcileSharedBodyWrite } from "./shared-body-write.ts"
import {
  inspectSharedFileManagementContext,
  revalidateSharedFileManagementContext,
  readManagedFileBody,
} from "./shared-file-management.ts"
import {
  gitMainChecked,
  gitMainInput,
  readGitMainInitializationContext,
} from "./shared-git-main-initialization.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256, Store } from "./store.ts"
import { projectSharedNotionMarkdown } from "./shared-notion-projection.ts"
import {
  pendingFileOperations,
  pendingFileOperationKey,
  retainPendingFileOperation,
  sharedPendingObservationPrefix,
} from "./shared-pending-file-operations.ts"
import { invalidateSnapshotCache } from "./cache.ts"
import { sharedSkillId } from "./shared-content.ts"
import { assertSparseGitFileReferences } from "./shared-sparse-git-references.ts"
import { querySharedOperationIndex } from "./shared-operation-index.ts"
import { loadPendingSharedMetadataWrites } from "./shared-metadata-write.ts"

export const gitMainTakeoverProtection = {
  strategy: "initial_empty_native_append",
  conditional_body_replace: false,
  original_file: "complete_fixed_git_input",
  native_preimage: "verified_empty_control_page",
  exact_postcondition_required: true,
  automatic_retry: false,
} as const

function journal(
  library: SharedLibrary,
  plan: Pick<SharedBodyWritePlan, "skill_id" | "skill_page_id">,
) {
  return Effect.gen(function* () {
    const scope = yield* authScope
    return {
      scope,
      library_id: library.library_id,
      skill_id: plan.skill_id,
      skill_page_id: plan.skill_page_id,
      prefix: yield* sharedPendingObservationPrefix(scope, library.library_id, plan.skill_id),
    }
  })
}

/** Explicit complete input only: this never promotes an empty page into a
 * following file, nor changes a previously materialized native main. */
export function prepareSharedGitMainTakeover(input: {
  readonly library: SharedLibrary
  readonly snapshot: Snapshot
  readonly path: string
  readonly markdown: string
  readonly mode: "100644" | "100755"
}) {
  return Effect.gen(function* () {
    const { library, snapshot } = input
    const locator = snapshot.record.locator
    const acquisition = snapshot.shared_acquisition
    if (
      locator.type !== "shared_skill" ||
      snapshot.record.kind !== "skill" ||
      input.path !== snapshot.entrypoint ||
      input.path !== "SKILL.md" ||
      acquisition?.source?.kind !== "git_member" ||
      !acquisition.files.some(
        (file) =>
          file.kind === "source" && file.path === input.path && file.source_path === input.path,
      ) ||
      (snapshot.members?.length ?? 0) !== 0
    )
      return yield* Effect.fail(
        fail(
          "SHARED_GIT_MAIN_SCOPE",
          "--input takes over only the original, unmaterialized Git main of this exact Skill. Existing native files use their original write or review path.",
        ),
      )
    const inspected = yield* inspectSharedFileManagementContext(library, snapshot)
    if (
      inspected.events.some((event) => event.file_id === inspected.index.main.file_id) ||
      inspected.pending.length !== 0 ||
      (yield* pendingFileOperations(inspected.journal)).length !== 0 ||
      (yield* loadPendingSharedMetadataWrites(library, {
        skillPageId: locator.page_id,
        headers: inspected.headers,
      })).length !== 0
    )
      return yield* Effect.fail(
        fail(
          "SHARED_FILE_INTENT_PENDING",
          "Existing native history or pending operations cannot authorize a new initial Git main insertion.",
        ),
      )
    const selected = yield* readGitMainInitializationContext(library, locator.page_id)
    const original = inspected.tree.find((file) => file.path === input.path)
    if (
      !original ||
      selected.index.skill_id !== locator.skill_id ||
      selected.index.source_reference !== acquisition.source.source_id ||
      selected.revision !== acquisition.source.revision ||
      (yield* sha256(original.bytes)) !== selected.sourceFile.sha256 ||
      original.bytes.length !== selected.sourceFile.bytes ||
      original.mode !== selected.sourceFile.mode
    )
      return yield* Effect.fail(
        fail(
          "SHARED_GIT_MAIN_STALE",
          "The complete main bytes are not the exact fixed Git preimage from this original owner.",
        ),
      )
    const sourceInput = yield* gitMainChecked(() =>
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(original.bytes),
    )
    const bindings = [selected.index.main, ...selected.index.files].map((file) => ({
      page_id: file.page_id,
      path: file.path,
    }))
    const authored = yield* gitMainChecked(() =>
      gitMainInput({
        text: input.markdown,
        name: selected.index.name,
        description: selected.index.description,
        path: input.path,
        bindings,
        source_member: selected.sourceContext.definition!.member,
      }),
    )
    yield* gitMainChecked(() =>
      assertSparseGitFileReferences(
        inspected.tree.map((file) =>
          file.path === input.path
            ? { ...file, bytes: new TextEncoder().encode(input.markdown), mode: input.mode }
            : file,
        ),
        snapshot.files.map((file) => file.path),
        selected.sourceContext.definition!.member,
      ),
    )
    const before = yield* readManagedFileBody(locator.page_id)
    if (before.raw_markdown !== "" || before.markdown !== "")
      return yield* Effect.fail(
        fail(
          "SHARED_GIT_MAIN_STALE",
          "The original control page is no longer empty. Preserve the native edit; no insertion was prepared.",
        ),
      )
    const projection = yield* gitMainChecked(() =>
      projectSharedNotionMarkdown(authored.body, {
        version: 17,
        purpose: "data_source_create",
      }),
    )
    const plan = yield* makeSharedBodyWritePlan({
      library_id: library.library_id,
      skill_page_id: locator.page_id,
      skill_id: locator.skill_id,
      file_id: selected.index.main.file_id,
      page_id: locator.page_id,
      path: input.path,
      source_id: selected.index.source_reference,
      source_context: selected.sourceContext,
      action: "write",
      before,
      parents: [],
      candidateMarkdown: projection.markdown,
      input_projection: projection,
      authored_input_sha256: yield* sha256(input.markdown),
      git_main_initialization: {
        version: 1,
        source_revision: selected.revision,
        source_file: selected.sourceFile,
        source_input: sourceInput,
        authored_input: input.markdown,
        authored_mode: input.mode,
        name: selected.index.name,
        description: selected.index.description,
        owner_metadata_sha256: selected.ownerMetadataSha256,
        bindings,
        snapshot_id: snapshot.snapshot_id,
        snapshot_version_id: snapshot.version_id,
        snapshot_scope: snapshot.scope,
        tree_sha256: inspected.tree_sha256,
        metadata_sha256: inspected.metadata_sha256,
        events_sha256: inspected.events_sha256,
      },
    })
    return {
      status: "planned" as const,
      dry_run: true as const,
      operation_id: plan.operation_id,
      path: plan.path,
      page_id: plan.page_id,
      file_id: plan.file_id,
      protection: gitMainTakeoverProtection,
      plan,
    }
  }).pipe(withReadOnlyNotion)
}

/** The existing body-write journal owns every send and outcome. An original
 * plan is reconciled read-only; current equal text never creates a missing ACK. */
export function executeSharedGitMainTakeover(input: {
  readonly library: SharedLibrary
  readonly plan: SharedBodyWritePlan
  readonly mode: "create" | "reconcile"
}) {
  return Effect.gen(function* () {
    if (input.mode !== "create" && input.mode !== "reconcile")
      return yield* Effect.fail(
        fail("INVALID_INPUT", "Initial main takeover mode must be create or reconcile."),
      )
    const plan = yield* validateSharedBodyWritePlan(input.plan)
    const initial = plan.git_main_initialization
    if (!initial || plan.library_id !== input.library.library_id)
      return yield* Effect.fail(
        fail(
          "SHARED_GIT_MAIN_SCOPE",
          "This takeover requires its original initial-Git-main plan in the exact library.",
        ),
      )
    const scope = yield* journal(input.library, plan)
    const local = yield* pendingFileOperations(scope)
    const headers = yield* querySharedOperationIndex(input.library, plan.skill_page_id)
    const original = local.find((item) => item.plan.operation_id === plan.operation_id)
    if (original && canonicalSharedJson(original.plan) !== canonicalSharedJson(plan))
      return yield* Effect.fail(
        fail(
          "SHARED_RECORD_CONFLICT",
          "The original local body-write plan differs from the supplied initial takeover.",
        ),
      )
    if (
      input.mode === "reconcile" ||
      original ||
      headers.some((row) => row.record_id === plan.operation_id)
    ) {
      const result = yield* reconcileSharedBodyWrite(input.library, plan).pipe(withReadOnlyNotion)
      if (original) yield* (yield* Store).retireKeys([original.key])
      return { ...result, protection: gitMainTakeoverProtection }
    }
    const beforeDispatch = Effect.gen(function* () {
      const current = yield* revalidateSharedFileManagementContext(input.library, {
        ...plan,
        ...initial,
      })
      const pending = [
        ...current.pending,
        ...(yield* pendingFileOperations(scope)).map((item) => item.plan),
        ...(yield* loadPendingSharedMetadataWrites(input.library, {
          skillPageId: plan.skill_page_id,
          headers: current.headers,
        })),
      ]
      if (
        pending.some(
          (item) =>
            item.operation_id !== plan.operation_id ||
            canonicalSharedJson(item) !== canonicalSharedJson(plan),
        )
      )
        return yield* Effect.fail(
          fail(
            "SHARED_FILE_INTENT_PENDING",
            "Another original operation blocks the initial native insertion; reconcile it without replay.",
          ),
        )
    })
    yield* beforeDispatch.pipe(withReadOnlyNotion)
    const result = yield* executeSharedBodyWrite(input.library, {
      plan,
      mode: "create",
      beforePlanWrite: (original) => retainPendingFileOperation(scope, original),
      beforeDispatch,
    })
    yield* invalidateSnapshotCache(
      sharedSkillId(input.library.library_id, plan.skill_id),
      scope.scope,
    )
    yield* (yield* Store).retireKeys([yield* pendingFileOperationKey(scope.prefix, plan)])
    return { ...result, protection: gitMainTakeoverProtection }
  })
}
