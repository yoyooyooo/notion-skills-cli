import { Effect } from "effect"
import { localContentRestrictedHashes } from "./content-restrictions.ts"
import { fail, type Snapshot } from "./model.ts"
import { composeSharedFiles, type CompositionFile } from "./shared-composition.ts"
import { inspectSharedFileManagementContext } from "./shared-file-management.ts"
import { assertSharedFileReferences } from "./shared-file-references.ts"
import {
  isResourceFollowing,
  resourceContentForOwnership,
  resolveFileState,
  type ResourceContent,
} from "./shared-file-state.ts"
import { gitBlobOid } from "./shared-github-source.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { pendingFileOperations } from "./shared-pending-file-operations.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import {
  identifyResourceEvent,
  makeSharedResourceAuthoringPlan,
  resourceAuthoringChecked,
  type SharedResourceAuthoringPlan,
} from "./shared-resource-authoring-model.ts"
import {
  loadSharedResourceContent,
  prepareSharedResourceContent,
  SHARED_RESOURCE_MAX_BYTES,
} from "./shared-resource-content.ts"
import { planSelectedSharedSource } from "./shared-selected-source.ts"
import { prepareSharedSnapshotHistory } from "./shared-snapshot-history.ts"
import { sha256, Store } from "./store.ts"

/** An explicitly selected new input does not authorize sharing other local-only
 * files copied incidentally by complete prior-snapshot retention. */
export function assertResourceSnapshotShareable(snapshot: Snapshot) {
  return Effect.gen(function* () {
    const restricted = new Set(
      yield* localContentRestrictedHashes(snapshot.files.map((file) => file.sha256)),
    )
    const paths = snapshot.files
      .filter((file) => restricted.has(file.sha256))
      .map((file) => file.path)
    if (paths.length !== 0)
      return yield* Effect.fail(
        fail(
          "SHARED_RESOURCE_LOCAL_SCOPE",
          "The previous complete snapshot contains local-only resources without an explicit sharing scope.",
          { paths, reason: "prior_snapshot_local_content" },
        ),
      )
  })
}

export function selectedResourceBytes(
  library: SharedLibrary,
  input: {
    readonly skill_page_id: string
    readonly source_id: string
    readonly source_revision: string
    readonly source_path: string
  },
) {
  return Effect.gen(function* () {
    if (input.source_id === "")
      return yield* Effect.fail(
        fail(
          "SHARED_SOURCE_FILE_MISSING",
          "Restoring a raw resource requires an explicitly selected immutable source.",
        ),
      )
    const source = yield* planSelectedSharedSource(library, input.skill_page_id, input.source_id)
    if (source.revision !== input.source_revision)
      return yield* Effect.fail(
        fail(
          "SHARED_RESOURCE_SOURCE_STALE",
          "The selected immutable source differs from the frozen revision.",
        ),
      )
    const descriptor = source.manifest.find((file) => file.path === input.source_path)
    if (descriptor === undefined)
      return yield* Effect.fail(
        fail(
          "SHARED_SOURCE_FILE_MISSING",
          "The selected source does not contain the exact resource path.",
          { source_path: input.source_path },
        ),
      )
    if (descriptor.bytes > SHARED_RESOURCE_MAX_BYTES)
      return yield* Effect.fail(
        fail(
          "SHARED_RESOURCE_TOO_LARGE",
          "The selected raw resource exceeds the 8 MiB retained-resource limit.",
        ),
      )
    if (source.local_paths.includes(input.source_path))
      return yield* Effect.fail(
        fail(
          "SHARED_RESOURCE_LOCAL_SCOPE",
          "Local-source consumption does not authorize sharing its bytes in Records.",
          { source_path: input.source_path },
        ),
      )
    const materialized = yield* source.materialize([input.source_path])
    const file = materialized.files[0]
    if (
      materialized.files.length !== 1 ||
      file === undefined ||
      file.path !== input.source_path ||
      file.bytes.length !== descriptor.bytes ||
      file.mode !== descriptor.mode
    )
      return yield* Effect.fail(
        fail(
          "SHARED_RESOURCE_SOURCE_STALE",
          "The selected raw resource differs from its complete fixed descriptor.",
        ),
      )
    const hash = yield* sha256(file.bytes)
    if (descriptor.identity.sha256 !== undefined && descriptor.identity.sha256 !== hash)
      return yield* Effect.fail(
        fail(
          "SHARED_RESOURCE_SOURCE_STALE",
          "The selected raw resource failed its frozen SHA-256.",
        ),
      )
    if (
      descriptor.identity.kind === "sha256"
        ? descriptor.identity.sha256 !== hash
        : descriptor.identity.git_oid !== (yield* gitBlobOid(file.bytes))
    )
      return yield* Effect.fail(
        fail(
          "SHARED_RESOURCE_SOURCE_STALE",
          "The selected raw resource failed its immutable source checksum.",
        ),
      )
    if (
      materialized.local_paths.includes(input.source_path) ||
      (yield* localContentRestrictedHashes([hash])).length !== 0
    )
      return yield* Effect.fail(
        fail(
          "SHARED_RESOURCE_LOCAL_SCOPE",
          "This resource carries a durable local-only restriction; it cannot be published incidentally.",
          { source_path: input.source_path },
        ),
      )
    return { bytes: file.bytes, mode: file.mode ?? null }
  })
}

export function resourceCandidateTree(
  files: readonly CompositionFile[],
  input: Pick<
    SharedResourceAuthoringPlan,
    "action" | "path" | "destination_path" | "file_id" | "entrypoint" | "content"
  >,
  bytes: Uint8Array,
) {
  if (input.destination_path !== null && files.some((file) => file.path === input.destination_path))
    throw fail(
      "SHARED_RESOURCE_PATH_CONFLICT",
      "The move destination already belongs to the current complete tree.",
      { path: input.destination_path },
    )
  const composed = composeSharedFiles({
    base: files.filter((file) => file.path !== input.path),
    mounts: [],
    entrypoint: input.entrypoint,
    overrides:
      input.action === "delete"
        ? []
        : [
            {
              kind: "custom",
              file_id: input.file_id,
              path: input.destination_path ?? input.path,
              bytes,
              ...(input.content.mode === null ? {} : { mode: input.content.mode }),
            },
          ],
  })
  return { files: composed.files, reference_check: assertSharedFileReferences(composed.files) }
}

export function prepareSharedResourceLifecycle(input: {
  readonly library: SharedLibrary
  readonly snapshot: Snapshot
  readonly action: "delete" | "move" | "restore" | "undelete"
  readonly path: string
  readonly destinationPath?: string
  readonly sourcePath?: string
}) {
  return Effect.gen(function* () {
    const context = yield* inspectSharedFileManagementContext(input.library, input.snapshot)
    const local = yield* pendingFileOperations(context.journal)
    if (local.length !== 0 || context.pending.length !== 0)
      return yield* Effect.fail(
        fail(
          "SHARED_RESOURCE_AUTHORING_PENDING",
          "Reconcile original file operations before changing a resource lifecycle.",
        ),
      )
    if (
      (input.action === "move") !== (input.destinationPath !== undefined) ||
      (input.sourcePath !== undefined && input.action !== "restore")
    )
      return yield* Effect.fail(
        fail(
          "INVALID_ARGUMENT",
          "Only a move selects a destination; only restore selects an optional source path.",
        ),
      )
    if (input.path === input.snapshot.entrypoint || /\.(md|markdown)$/iu.test(input.path))
      return yield* Effect.fail(
        fail("SHARED_MAIN_FILE_PROTECTED", "Select a supporting non-document resource."),
      )
    const binding = context.index.files.find((file) => file.path === input.path)
    const state = binding === undefined ? undefined : context.states.get(binding.file_id)
    const owned = state === undefined ? undefined : resourceContentForOwnership(state.ownership)
    if (binding !== undefined && owned === undefined)
      return yield* Effect.fail(
        fail(
          "SHARED_RESOURCE_NOT_MANAGED",
          "Editable native files keep their native lifecycle commands.",
        ),
      )
    if (
      input.destinationPath !== undefined &&
      context.index.files.some(
        (file) => file.path === input.destinationPath && file.file_id !== binding?.file_id,
      )
    )
      return yield* Effect.fail(
        fail(
          "SHARED_RESOURCE_PATH_CONFLICT",
          "The move destination is reserved by another stable File ID.",
          { path: input.destinationPath },
        ),
      )
    if (
      input.action === "restore" &&
      state !== undefined &&
      isResourceFollowing(state.ownership) &&
      input.sourcePath !== undefined &&
      input.sourcePath !== state.ownership.source_path
    )
      return yield* Effect.fail(
        fail(
          "INVALID_ARGUMENT",
          "This resource already follows another exact source path; replace or move it through an explicit owner operation before selecting a different source path.",
        ),
      )
    if (
      (input.action === "restore" && state !== undefined && isResourceFollowing(state.ownership)) ||
      (input.action === "delete" && state?.ownership.kind === "tombstone") ||
      (input.action === "move" &&
        input.destinationPath === input.path &&
        state?.ownership.kind !== "tombstone" &&
        input.snapshot.files.some((file) => file.path === input.path))
    )
      return {
        status: "unchanged" as const,
        file_id: binding?.file_id ?? null,
        path: input.path,
        verified: true as const,
        remote_writes: 0 as const,
      }
    if (input.action === "move" && state?.ownership.kind === "tombstone")
      return yield* Effect.fail(
        fail("SHARED_RESOURCE_NOT_ACTIVE", "Restore the exact deleted resource before moving it."),
      )
    if (
      (input.action === "restore" || input.action === "undelete") &&
      (binding === undefined || state === undefined || owned === undefined)
    )
      return yield* Effect.fail(
        fail(
          "SHARED_RESOURCE_NOT_MANAGED",
          "Restore requires one explicit custom or tombstoned resource binding.",
        ),
      )
    if (input.action === "undelete" && state?.ownership.kind !== "tombstone")
      return yield* Effect.fail(
        fail(
          "SHARED_RESOURCE_NOT_DELETED",
          "Undelete requires one exact tombstoned resource; use replace for an active resource.",
        ),
      )
    yield* assertResourceSnapshotShareable(input.snapshot)
    const original = input.snapshot.files.find((file) => file.path === input.path)
    let before: ResourceContent
    if (state?.ownership.kind === "tombstone" && owned !== undefined) {
      const retained = yield* loadSharedResourceContent(input.library, {
        skillPageId: context.index.page_id,
        content: owned,
      })
      before = retained.content
      yield* (yield* Store).writeBytes(`objects/${before.sha256}`, retained.bytes)
    } else {
      const file = context.tree.find((file) => file.path === input.path)
      if (
        file === undefined ||
        original === undefined ||
        (binding === undefined && context.index.source_reference === "")
      )
        return yield* Effect.fail(
          fail(
            "SHARED_RESOURCE_NOT_MANAGED",
            "Select one exact active managed or fixed-source resource.",
          ),
        )
      before = (yield* prepareSharedResourceContent(file.bytes, file.mode ?? null)).content
      if (
        state?.ownership.kind === "custom" &&
        canonicalSharedJson(before) !== canonicalSharedJson(owned)
      )
        return yield* Effect.fail(
          fail(
            "SHARED_RESOURCE_AUTHORING_STALE",
            "The current custom resource differs from its accepted ownership.",
          ),
        )
    }
    const fileId =
      binding?.file_id ??
      `resource-file-${yield* sha256(canonicalSharedJson([input.library.library_id, context.index.skill_id, input.snapshot.version_id, input.path, before]))}`
    const baseline =
      binding === undefined
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
    const sourcePath =
      input.action === "restore"
        ? (input.sourcePath ?? state?.placement?.source_path ?? input.path)
        : (baseline?.source_path ??
          state?.placement?.source_path ??
          (state !== undefined && isResourceFollowing(state.ownership)
            ? state.ownership.source_path
            : null))
    const selected =
      input.action === "restore"
        ? yield* selectedResourceBytes(input.library, {
            skill_page_id: context.index.page_id,
            source_id: context.index.source_reference,
            source_revision: context.evidence.source_revision,
            source_path: sourcePath!,
          })
        : { bytes: yield* (yield* Store).readBytes(`objects/${before.sha256}`), mode: before.mode }
    const content = (yield* prepareSharedResourceContent(selected.bytes, selected.mode)).content
    const parents = state?.heads ?? (baseline === null ? [] : [baseline.event_id])
    const destination = input.destinationPath ?? null
    const event =
      input.action === "restore"
        ? {
            kind: "resource_followed" as const,
            file_id: fileId,
            parents,
            source_id: context.index.source_reference,
            source_revision: context.evidence.source_revision,
            path: input.path,
            source_path: sourcePath!,
            content,
            retained: before,
          }
        : input.action === "undelete"
          ? { kind: "adopted" as const, file_id: fileId, parents, content }
          : input.action === "delete"
            ? { kind: "deleted" as const, file_id: fileId, parents, retained: before }
            : {
                kind: "moved" as const,
                file_id: fileId,
                parents,
                from_path: input.path,
                to_path: destination!,
                source_path: sourcePath,
                suppressed_paths: [
                  ...new Set([
                    ...(state?.placement?.suppressed_paths ?? []),
                    input.path,
                    ...(sourcePath === null ? [] : [sourcePath]),
                  ]),
                ]
                  .filter((path) => path !== destination)
                  .sort(),
                retained: before,
              }
    const candidate = yield* resourceAuthoringChecked(() =>
      resourceCandidateTree(
        context.tree,
        {
          action: input.action,
          path: input.path,
          destination_path: destination,
          file_id: fileId,
          entrypoint: input.snapshot.entrypoint,
          content,
        },
        selected.bytes,
      ),
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
      destination_path: destination,
      source_path: sourcePath,
      entrypoint: input.snapshot.entrypoint,
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
      content,
      reference_check: candidate.reference_check,
      event,
    })
    yield* resourceAuthoringChecked(() =>
      resolveFileState(fileId, [
        ...context.events.filter((value) => value.file_id === fileId),
        ...(baseline === null ? [] : [baseline]),
        plan.event,
      ]),
    )
    yield* (yield* Store).writeBytes(`objects/${content.sha256}`, selected.bytes)
    return { status: "planned" as const, plan }
  })
}
