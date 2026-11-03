import { Effect, Schema } from "effect"
import { authScope } from "./catalog.ts"
import { validateSnapshot } from "./cache.ts"
import { fail, property, snapshotMembers, type Snapshot } from "./model.ts"
import { normalizePath } from "./ref.ts"
import { BUNDLE, MANIFEST, withoutPortableMemberIndex, type PortableRelations } from "./portable.ts"
import type { ImportFile } from "./import.ts"
import {
  sharedAuthoringMarkdown,
  SharedAuthoringEvidenceSchema,
  verifySharedAuthoredSnapshot,
} from "./shared-authoring.ts"
import {
  updateSharedSkillMetadata,
  type SharedMetadataUpdateOptions,
} from "./shared-metadata-authoring.ts"
import { prepareSharedBodyWrite } from "./shared-body-write.ts"
import { projectSharedNotionMarkdown } from "./shared-notion-projection.ts"
import { assertSharedFileReferences } from "./shared-file-references.ts"
import {
  prepareSharedFileManagement,
  executeSharedFileManagement,
} from "./shared-file-management.ts"
import { fileManagementProtection } from "./shared-file-management-model.ts"
import { loadSharedLibrary } from "./shared-library.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import {
  makeSharedSkillApplyPlan,
  applyChecked,
  sharedSkillApplyProtection,
  type SharedSkillApplyPlan,
} from "./shared-skill-apply-model.ts"
import { executeSharedSkillApply } from "./shared-skill-apply.ts"
import { sha256, Store } from "./store.ts"

export type SharedApplyInput = SharedMetadataUpdateOptions & {
  readonly files: readonly ImportFile[]
  readonly remove?: readonly string[]
  /** Present only for an explicitly imported portable manifest, never a source refresh. */
  readonly portableRelations?: PortableRelations
}

/** All requested bytes and paths are checked before any original operation is dispatched. */
export function applySharedSkillChanges(snapshot: Snapshot, input: SharedApplyInput) {
  return Effect.gen(function* () {
    const locator = snapshot.record.locator
    if (locator.type !== "shared_skill")
      return yield* Effect.fail(
        fail("CONTENT_NOT_MUTABLE", "Select an exact shared Skill for apply."),
      )
    const scope = yield* authScope
    if (scope !== snapshot.scope)
      return yield* Effect.fail(
        fail(
          "SNAPSHOT_CONFLICT",
          "The selected apply snapshot belongs to another authentication scope.",
        ),
      )
    const evidence = yield* applyChecked(() =>
      Schema.decodeUnknownSync(SharedAuthoringEvidenceSchema)(property(snapshot).shared_authoring),
    )
    if (
      !evidence.read_only ||
      evidence.scope !== snapshot.scope ||
      evidence.snapshot_id !== snapshot.snapshot_id ||
      evidence.library_id !== locator.library_id ||
      evidence.skill_id !== locator.skill_id ||
      evidence.skill_page_id !== locator.page_id
    )
      return yield* Effect.fail(
        fail(
          "SHARED_APPLY_STALE",
          "Apply needs this invocation's complete fresh read-only shared snapshot; a cached or pinned object is not fresh authoring evidence.",
        ),
      )
    const library = yield* loadSharedLibrary(locator.database_id)
    if (
      library.library_id !== locator.library_id ||
      library.skills.data_source_id !== locator.data_source_id
    )
      return yield* Effect.fail(
        fail(
          "SHARED_APPLY_SCOPE",
          "The current registered descriptor differs from the exact selected snapshot.",
        ),
      )
    const requested = yield* applyChecked(() => {
      const paths = new Set<string>(),
        removed = new Set<string>()
      const files = input.files
        .map((file) => {
          if (
            file.path === "" ||
            normalizePath(file.path) !== file.path ||
            [BUNDLE, MANIFEST].includes(file.path) ||
            paths.has(file.path)
          )
            throw fail(
              "INVALID_PATH",
              "Apply requires each canonical nonreserved file path exactly once.",
              { path: file.path },
            )
          paths.add(file.path)
          return file
        })
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      for (const path of input.remove ?? []) {
        if (
          path === "" ||
          normalizePath(path) !== path ||
          path === snapshot.entrypoint ||
          [BUNDLE, MANIFEST].includes(path) ||
          paths.has(path) ||
          removed.has(path)
        )
          throw fail(
            "INVALID_PATH",
            "Remove each existing supporting path once, without also writing it.",
            { path },
          )
        if (!snapshot.files.some((file) => file.path === path))
          throw fail(
            "FILE_NOT_FOUND",
            "The removed file is absent from the selected complete Skill.",
            { path },
          )
        removed.add(path)
      }
      return { files, removed: [...removed].sort() }
    })
    const additions = requested.files.filter(
      (file) => !snapshot.files.some((existing) => existing.path === file.path),
    )
    const hasMetadata =
      input.name !== undefined ||
      input.description !== undefined ||
      input.defaultContext !== undefined ||
      input.members !== undefined ||
      input.requires !== undefined
    if (additions.length !== 0 || requested.removed.length !== 0) {
      if (
        additions.length + requested.removed.length !== 1 ||
        requested.files.length !== additions.length ||
        hasMetadata
      )
        return yield* Effect.fail(
          fail(
            "SHARED_APPLY_LAYOUT_BATCH_UNSUPPORTED",
            "A mixed or multiple-file layout change needs staged whole-tree checkpoints. No writes were sent. Apply one isolated add/delete, or use the existing file commands; body and metadata batches remain supported.",
            {
              added: additions.map((file) => file.path),
              removed: requested.removed,
              writes_sent: false,
            },
          ),
        )
      const added = additions[0]
      const removed = requested.removed[0]
      const plan =
        added !== undefined
          ? yield* prepareSharedFileManagement({
              library,
              snapshot,
              action: "add",
              path: added.path,
              markdown: yield* applyChecked(() =>
                new TextDecoder("utf-8", { fatal: true }).decode(added.bytes),
              ),
            })
          : yield* Effect.gen(function* () {
              const targets = evidence.files.filter((file) => file.path === removed)
              if (targets.length !== 1 || targets[0] === undefined)
                return yield* Effect.fail(
                  fail(
                    "SHARED_FILE_NOT_BOUND",
                    "Only a uniquely bound native file can be deleted through this apply path.",
                  ),
                )
              return yield* prepareSharedFileManagement({
                library,
                snapshot,
                action: "delete",
                fileId: targets[0].file_id,
              })
            })
      if (input.dryRun)
        return {
          status: "planned" as const,
          kind: "file_management" as const,
          operation_id: plan.operation_id,
          plan,
          dry_run: true as const,
          changes: { files: requested.files.map((file) => file.path), removed: requested.removed },
          protection: fileManagementProtection,
        }
      const result = yield* executeSharedFileManagement(library, { plan, mode: "create" })
      if (result.status !== "applied")
        return yield* Effect.fail(
          fail(
            "SHARED_APPLY_UNRESOLVED",
            "The original lifecycle operation has no applied outcome; read and review its original result.",
            { operation_id: plan.operation_id },
          ),
        )
      return {
        ...result,
        kind: "file_management" as const,
        plan,
        changes: { files: requested.files.map((file) => file.path), removed: requested.removed },
        protection: fileManagementProtection,
      }
    }
    const store = yield* Store
    const changedFiles = yield* Effect.filter(requested.files, (file) =>
      Effect.gen(function* () {
        const current = snapshot.files.find((entry) => entry.path === file.path)
        if (current === undefined) return true
        if (current.bytes === file.bytes.length && current.sha256 === (yield* sha256(file.bytes)))
          return false
        if (file.path !== snapshot.entrypoint || input.portableRelations?.members === undefined)
          return true
        const currentBytes = yield* store.readBytes(`objects/${current.sha256}`)
        const authored = yield* applyChecked(() => ({
          before: withoutPortableMemberIndex(
            { path: current.path, bytes: currentBytes },
            snapshot.record.kind,
            snapshotMembers(snapshot)?.map((member) => member.id),
          ),
          after: withoutPortableMemberIndex(
            file,
            snapshot.record.kind,
            input.portableRelations!.members,
          ),
        }))
        return (yield* sha256(authored.before.bytes)) !== (yield* sha256(authored.after.bytes))
      }),
    )
    // An unchanged exported tree may contain provider-only resources and extra
    // frontmatter. It does not request a native body write or new ownership.
    const inputs = yield* applyChecked(() =>
      changedFiles.map((file) => {
        const bindings = evidence.files.filter((entry) => entry.path === file.path)
        if (bindings.length !== 1 || bindings[0] === undefined)
          throw fail(
            "SHARED_FILE_NOT_BOUND",
            "Apply can author only an existing unique native file binding; a provider-only file requires an explicit editable binding.",
            { path: file.path },
          )
        const markdown = sharedAuthoringMarkdown(snapshot, file.path, file.bytes, {
          name: input.name,
          description: input.description,
        })
        return { file, binding: bindings[0], projection: projectSharedNotionMarkdown(markdown) }
      }),
    )
    // Verify references against the final complete proposed tree, retaining all
    // omitted files. The immutable snapshot objects remain the pinned originals.
    yield* validateSnapshot(snapshot)
    const tree = yield* Effect.forEach(snapshot.files, (file) => {
      const proposed = inputs.find((entry) => entry.file.path === file.path)
      return proposed === undefined
        ? store
            .readBytes(`objects/${file.sha256}`)
            .pipe(Effect.map((bytes) => ({ path: file.path, bytes })))
        : Effect.succeed({
            path: file.path,
            bytes: new TextEncoder().encode(proposed.projection.markdown),
          })
    })
    yield* applyChecked(() => assertSharedFileReferences(tree))
    const metadata = hasMetadata
      ? yield* updateSharedSkillMetadata(snapshot, {
          name: input.name,
          description: input.description,
          defaultContext: input.defaultContext,
          members: input.members,
          requires: input.requires,
          dryRun: true,
        })
      : undefined
    if (metadata !== undefined && metadata.status !== "planned")
      return yield* Effect.fail(
        fail(
          "SHARED_APPLY_INVALID",
          "Metadata preparation did not return a frozen read-only plan.",
        ),
      )
    const prepared = yield* Effect.forEach(
      inputs,
      (entry) =>
        Effect.gen(function* () {
          const plan = yield* prepareSharedBodyWrite({
            library,
            skillPageId: locator.page_id,
            fileId: entry.binding.file_id,
            action: "write",
            candidateMarkdown: entry.projection.markdown,
            inputProjection: entry.projection,
            authoredInputSha256: yield* sha256(entry.file.bytes),
            expected: { heads: entry.binding.heads, body_sha256: entry.binding.body_sha256 },
          })
          if (
            plan.page_id !== entry.binding.page_id ||
            plan.path !== entry.binding.path ||
            plan.source_id !== evidence.source_id ||
            plan.skill_id !== locator.skill_id
          )
            return yield* Effect.fail(
              fail(
                "SHARED_APPLY_STALE",
                "A bound file or source changed after the selected complete snapshot.",
              ),
            )
          return plan
        }),
      { concurrency: 4 },
    )
    const bodies = prepared.filter(
      (plan) => plan.before.fingerprint.sha256 !== plan.candidate.content.sha256,
    )
    const metadataPlan =
      metadata?.status === "planned" &&
      metadata.plan.changes.some(
        (change) => canonicalSharedJson(change.before) !== canonicalSharedJson(change.after),
      )
        ? metadata.plan
        : undefined
    const changes = {
      files: requested.files.map((file) => file.path),
      removed: [] as readonly string[],
    }
    if (bodies.length === 0 && metadataPlan === undefined)
      return {
        status: "unchanged" as const,
        kind: "skill_apply" as const,
        changes,
        verified: true as const,
        protection: sharedSkillApplyProtection,
      }
    const main = evidence.files.filter((file) => file.path === snapshot.entrypoint)
    if (main.length !== 1 || main[0] === undefined)
      return yield* Effect.fail(
        fail("SHARED_APPLY_INVALID", "The complete snapshot has no unique native main file."),
      )
    const plan = yield* makeSharedSkillApplyPlan({
      library_id: library.library_id,
      skill_id: locator.skill_id,
      skill_page_id: locator.page_id,
      file_id: main[0].file_id,
      snapshot_id: snapshot.snapshot_id,
      snapshot_version_id: snapshot.version_id,
      snapshot_scope: scope,
      source_id: evidence.source_id,
      bodies,
      ...(metadataPlan === undefined ? {} : { metadata: metadataPlan }),
    })
    const result = yield* executeSharedSkillApply(library, {
      plan,
      mode: "create",
      dryRun: input.dryRun,
    })
    if (result.status === "partial")
      return yield* Effect.fail(
        fail(
          "SHARED_APPLY_PARTIAL",
          "The original apply ended partially. Read the current Skill before new intent.",
          { apply_operation_id: plan.operation_id, requires_fresh_read: true },
        ),
      )
    return { ...result, kind: "skill_apply" as const, plan, changes }
  })
}

export function verifySharedAppliedSnapshot(snapshot: Snapshot, plan: SharedSkillApplyPlan): void {
  for (const body of plan.bodies)
    verifySharedAuthoredSnapshot(snapshot, {
      file_id: body.file_id,
      candidate_sha256: body.candidate.content.sha256,
      operation_id: body.operation_id,
    })
  for (const change of plan.metadata?.changes ?? []) {
    const actual =
      change.field === "Name"
        ? snapshot.record.name
        : change.field === "Description"
          ? snapshot.record.description
          : change.field === "Default Context"
            ? snapshot.record.default_context
            : change.field === "Members"
              ? (snapshot.members ?? snapshot.router_members)
                  ?.map((member) => property(member.metadata).page_id)
                  .sort()
              : change.field === "Requires"
                ? snapshot.required?.map((member) => property(member.metadata).page_id).sort()
                : undefined
    if (canonicalSharedJson(actual) !== canonicalSharedJson(change.after))
      throw fail(
        "WRITE_VERIFICATION_FAILED",
        "The original apply was verified, but a later current metadata read differs from its requested value. Preserve that later edit.",
        { apply_operation_id: plan.operation_id, field: change.field, requires_fresh_read: true },
      )
  }
}
