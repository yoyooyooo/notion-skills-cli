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
import {
  nativeSupportingMarkdown,
  splitNativeSupportingMarkdown,
} from "./shared-native-file-metadata.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { assertSharedFileReferences, sharedMarkdownReferences } from "./shared-file-references.ts"
import { restoreSharedNativeFileLinks } from "./shared-native-file-content.ts"
import {
  prepareSharedFileManagement,
  executeSharedFileManagement,
  inspectSharedFileManagementContext,
  readManagedFileBody,
  sharedFileMembershipShape,
} from "./shared-file-management.ts"
import { fileManagementProtection } from "./shared-file-management-model.ts"
import type { SharedFileManagementPlan } from "./shared-file-management-model.ts"
import {
  assertMaintenanceReferences,
  classifyMaintenanceChanges,
  type MaintenanceTreeFile,
} from "./shared-skill-apply-tree.ts"
import type { SharedApplyChangesManifest } from "./shared-skill-apply-model.ts"
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
  /** Replacement omissions. Apply does not treat a missing input file as removal. */
  readonly inferredRemove?: readonly string[]
  readonly changes?: SharedApplyChangesManifest | null
  /** Present only for an explicitly imported portable manifest, never a source refresh. */
  readonly portableRelations?: PortableRelations
}

const encoder = new TextEncoder()

function maintenanceChanges(
  requested: readonly ImportFile[],
  removed: readonly string[],
  moves: readonly { readonly from: string; readonly to: string }[],
  revived: readonly string[],
) {
  return {
    files: requested.map((file) => file.path),
    removed,
    ...(moves.length === 0 ? {} : { moves }),
    ...(revived.length === 0 ? {} : { revived }),
  }
}

/** One parent apply for explicit adds, moves, deletes, revives and body edits. */
function applyMaintenanceTree(
  library: SharedLibrary,
  snapshot: Snapshot,
  input: SharedApplyInput,
  scope: string,
) {
  return Effect.gen(function* () {
    const locator = snapshot.record.locator
    if (locator.type !== "shared_skill")
      return yield* Effect.fail(
        fail("CONTENT_NOT_MUTABLE", "Select an exact shared Skill for apply."),
      )
    const inspected = yield* inspectSharedFileManagementContext(library, snapshot)
    const store = yield* Store
    const active = yield* Effect.forEach(snapshot.files, (file) =>
      store.readBytes(`objects/${file.sha256}`).pipe(
        Effect.map((bytes) => ({
          path: file.path,
          bytes,
          ...(file.mode === undefined ? {} : { mode: file.mode }),
        })),
      ),
    )
    const revivePaths = new Set((input.changes?.revives ?? []).map((item) => item.path))
    const tombstones: MaintenanceTreeFile[] = []
    for (const binding of inspected.index.files) {
      const state = inspected.states.get(binding.file_id)
      if (state?.ownership.kind !== "tombstone") continue
      const bytes = revivePaths.has(binding.path)
        ? encoder.encode((yield* readManagedFileBody(binding.page_id)).markdown)
        : new Uint8Array()
      const mode = state.ownership.retained.mode
      tombstones.push({ path: binding.path, bytes, ...(mode == null ? {} : { mode }) })
    }
    const classified = yield* applyChecked(() =>
      classifyMaintenanceChanges({
        entrypoint: snapshot.entrypoint,
        active,
        tombstones,
        requested: input.files,
        explicitRemoves: input.remove ?? [],
        changes: input.changes ?? null,
      }),
    )
    // New Notion pages have no page IDs until their allocation is acknowledged.
    // Never send a local URL that the service can reinterpret as an HTTPS host.
    // Stage references first, then submit linked bodies against the fresh pin.
    yield* applyChecked(() => {
      const addedPaths = new Set(classified.adds.map((file) => file.path))
      const unresolved = [...classified.adds, ...classified.edits].flatMap((file) =>
        sharedMarkdownReferences(
          file.path,
          new TextDecoder("utf-8", { fatal: true }).decode(file.bytes),
        )
          .filter(
            (ref) =>
              addedPaths.has(ref.target) && !ref.href.startsWith("#") && !ref.href.startsWith("?"),
          )
          .map((ref) => ({ from: ref.from, target: ref.target })),
      )
      if (unresolved.length)
        throw fail(
          "SHARED_NATIVE_REFERENCE_UNBOUND",
          "A linked new file has no native page yet. Add the reference files first, read the current Skill again, then apply the linked main/files. No writes were sent.",
          {
            references: unresolved,
            writes_sent: false,
            next: {
              argv: [
                "ntn-skills",
                "ctl",
                "library",
                "files",
                locator.page_id,
                "--entry",
                locator.database_id,
              ],
              read_only: true,
              reason:
                "Inspect existing native bindings. Stage new files before linking them; do not guess a page URL.",
            },
          },
        )
    })
    const project = (file: (typeof classified.edits)[number], currentBytes?: Uint8Array) =>
      applyChecked(() =>
        projectSharedNotionMarkdown(
          sharedAuthoringMarkdown(snapshot, file.path, file.bytes, {
            name: input.name,
            description: input.description,
            ...(currentBytes === undefined ? {} : { currentBytes }),
          }),
        ),
      )
    const edited: {
      file: (typeof classified.edits)[number]
      projection: ReturnType<typeof projectSharedNotionMarkdown>
    }[] = []
    for (const file of classified.edits) {
      const current = snapshot.files.find((entry) => entry.path === file.path)
      const currentBytes =
        current === undefined ? undefined : yield* store.readBytes(`objects/${current.sha256}`)
      edited.push({ file, projection: yield* project(file, currentBytes) })
    }
    const added: {
      file: (typeof classified.adds)[number]
      projection: ReturnType<typeof projectSharedNotionMarkdown>
    }[] = []
    for (const file of classified.adds)
      added.push({
        file,
        projection: yield* applyChecked(() => {
          const document = splitNativeSupportingMarkdown(
            new TextDecoder("utf-8", { fatal: true }).decode(file.bytes),
          )
          return projectSharedNotionMarkdown(
            restoreSharedNativeFileLinks(document.body, file.path, snapshot.file_bindings ?? []),
            { purpose: "data_source_create" },
          )
        }),
      })
    if (
      classified.adds.length +
        classified.moves.length +
        classified.removes.length +
        classified.revives.length >
        1 &&
      classified.moves.some(
        (move) =>
          classified.removes.includes(move.to) ||
          classified.adds.some((file) => file.path === move.from),
      )
    )
      return yield* Effect.fail(
        fail(
          "SHARED_APPLY_LAYOUT_CYCLE",
          "A path cycle across add, move and remove is not executed in one parent. No writes were sent. Split it into explicit applies.",
          { writes_sent: false },
        ),
      )
    const referenceFiles: { path: string; bytes: Uint8Array }[] = []
    for (const file of classified.finalFiles) {
      const edit = edited.find((item) => item.file.path === file.path)
      if (edit !== undefined) {
        referenceFiles.push({ path: file.path, bytes: encoder.encode(edit.projection.markdown) })
        continue
      }
      const add = added.find((item) => item.file.path === file.path)
      if (add !== undefined) {
        referenceFiles.push({ path: file.path, bytes: encoder.encode(add.projection.markdown) })
        continue
      }
      referenceFiles.push({ path: file.path, bytes: file.bytes })
    }
    const referenceCheck = yield* applyChecked(() => assertMaintenanceReferences(referenceFiles))
    const finalFiles = yield* Effect.forEach(
      [...referenceFiles].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      (file) =>
        sha256(file.bytes).pipe(
          Effect.map((hash) => ({
            path: file.path,
            sha256: hash,
            bytes: file.bytes.byteLength,
            ...(classified.finalFiles.find((value) => value.path === file.path)?.mode === undefined
              ? {}
              : { mode: classified.finalFiles.find((value) => value.path === file.path)!.mode }),
          })),
        ),
    )
    const target_tree_sha256 = yield* sha256(canonicalSharedJson(finalFiles))
    const baseline_tree_sha256 = yield* sha256(canonicalSharedJson(snapshot.files))
    const membership_sha256 = yield* sha256(
      canonicalSharedJson(sharedFileMembershipShape(inspected.index)),
    )
    const preparedLayout: SharedFileManagementPlan[] = []
    for (const file of classified.adds)
      preparedLayout.push(
        yield* prepareSharedFileManagement({
          library,
          snapshot,
          action: "add",
          path: file.path,
          ...(file.mode === undefined ? {} : { mode: file.mode }),
          markdown: yield* applyChecked(() =>
            new TextDecoder("utf-8", { fatal: true }).decode(file.bytes),
          ),
          referenceCheck,
        }),
      )
    for (const revive of classified.revives) {
      const binding = inspected.index.files.find((file) => file.path === revive.path)
      if (binding === undefined)
        return yield* Effect.fail(
          fail("SHARED_FILE_NOT_TOMBSTONE", "The revive path has no stable file.", {
            path: revive.path,
          }),
        )
      preparedLayout.push(
        yield* prepareSharedFileManagement({
          library,
          snapshot,
          action: "undelete",
          fileId: binding.file_id,
          referenceCheck,
        }),
      )
    }
    for (const move of classified.moves) {
      const binding = inspected.evidence.files.find((file) => file.path === move.from)
      if (binding === undefined)
        return yield* Effect.fail(
          fail("SHARED_FILE_NOT_BOUND", "Only a uniquely bound native file can be moved.", {
            path: move.from,
          }),
        )
      preparedLayout.push(
        yield* prepareSharedFileManagement({
          library,
          snapshot,
          action: "move",
          fileId: binding.file_id,
          destinationPath: move.to,
          referenceCheck,
        }),
      )
    }
    for (const path of classified.removes) {
      const binding = inspected.evidence.files.find((file) => file.path === path)
      if (binding === undefined)
        return yield* Effect.fail(
          fail("SHARED_FILE_NOT_BOUND", "Only a uniquely bound native file can be deleted.", {
            path,
          }),
        )
      preparedLayout.push(
        yield* prepareSharedFileManagement({
          library,
          snapshot,
          action: "delete",
          fileId: binding.file_id,
          referenceCheck,
        }),
      )
    }
    const layout = preparedLayout
    const bodies = []
    for (const entry of edited) {
      const bindings = inspected.evidence.files.filter((file) => file.path === entry.file.path)
      if (bindings.length !== 1 || bindings[0] === undefined)
        return yield* Effect.fail(
          fail(
            "SHARED_FILE_NOT_BOUND",
            "Apply can author only an existing unique native file binding.",
            { path: entry.file.path },
          ),
        )
      const plan = yield* prepareSharedBodyWrite({
        library,
        skillPageId: locator.page_id,
        fileId: bindings[0].file_id,
        action: "write",
        candidateMarkdown: entry.projection.markdown,
        inputProjection: entry.projection,
        authoredInputSha256: yield* sha256(entry.file.bytes),
        expected: { heads: bindings[0].heads, body_sha256: bindings[0].body_sha256 },
      })
      if (plan.before.fingerprint.sha256 !== plan.candidate.content.sha256) bodies.push(plan)
    }
    const hasMetadata =
      input.name !== undefined ||
      input.description !== undefined ||
      input.defaultContext !== undefined ||
      input.members !== undefined ||
      input.requires !== undefined
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
    const metadataPlan =
      metadata?.status === "planned" &&
      metadata.plan.changes.some(
        (change) => canonicalSharedJson(change.before) !== canonicalSharedJson(change.after),
      )
        ? metadata.plan
        : undefined
    const changes = maintenanceChanges(
      input.files,
      classified.removes,
      classified.moves.map((move) => ({ from: move.from, to: move.to })),
      classified.revives.map((file) => file.path),
    )
    if (layout.length === 0 && bodies.length === 0 && metadataPlan === undefined)
      return {
        status: "unchanged" as const,
        kind: "skill_apply" as const,
        changes,
        verified: true as const,
        protection: sharedSkillApplyProtection,
      }
    const stages = [
      ...(layout.some((plan) => plan.action === "add")
        ? [
            {
              name: "allocate" as const,
              operation_ids: layout
                .filter((plan) => plan.action === "add")
                .map((plan) => plan.operation_id),
            },
          ]
        : []),
      ...(layout.some((plan) => plan.action === "undelete")
        ? [
            {
              name: "revive" as const,
              operation_ids: layout
                .filter((plan) => plan.action === "undelete")
                .map((plan) => plan.operation_id),
            },
          ]
        : []),
      ...(layout.some((plan) => plan.action === "move")
        ? [
            {
              name: "move" as const,
              operation_ids: layout
                .filter((plan) => plan.action === "move")
                .map((plan) => plan.operation_id),
            },
          ]
        : []),
      ...(layout.some((plan) => plan.action === "delete")
        ? [
            {
              name: "retire" as const,
              operation_ids: layout
                .filter((plan) => plan.action === "delete")
                .map((plan) => plan.operation_id),
            },
          ]
        : []),
      ...(bodies.length === 0
        ? []
        : [
            {
              name: "author" as const,
              operation_ids: bodies.map((plan) => plan.operation_id),
            },
          ]),
      ...(metadataPlan === undefined
        ? []
        : [{ name: "metadata" as const, operation_ids: [metadataPlan.operation_id] }]),
    ]
    const main = inspected.evidence.files.filter((file) => file.path === snapshot.entrypoint)
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
      source_id: inspected.evidence.source_id,
      baseline_tree_sha256,
      target_tree_sha256,
      membership_sha256,
      reference_check: referenceCheck,
      final_files: finalFiles,
      changes: input.changes ?? null,
      bodies,
      layout,
      ...(metadataPlan === undefined ? {} : { metadata: metadataPlan }),
      stages,
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
          {
            apply_operation_id: plan.operation_id,
            requires_fresh_read: true,
          },
        ),
      )
    return { ...result, kind: "skill_apply" as const, plan, changes }
  })
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
    const inferred = [...(input.inferredRemove ?? [])].sort()
    const manifestLayout =
      (input.changes?.moves?.length ?? 0) +
      (input.changes?.removes?.length ?? 0) +
      (input.changes?.revives?.length ?? 0) +
      (input.changes?.rewrites?.length ?? 0)
    const explicitLayout = additions.length + requested.removed.length + manifestLayout
    if (inferred.length > 0) {
      const isolated =
        inferred.length === 1 &&
        explicitLayout === 0 &&
        requested.files.length === 0 &&
        !hasMetadata
      if (!isolated)
        return yield* Effect.fail(
          fail(
            "SHARED_APPLY_LAYOUT_BATCH_UNSUPPORTED",
            "Replacement still refuses to infer a mixed or multiple-file deletion from omitted input. No writes were sent. Use apply --input for new files and an explicit changes manifest for moves, removals and revives.",
            {
              added: additions.map((file) => file.path),
              removed: inferred,
              writes_sent: false,
            },
          ),
        )
      requested.removed.push(inferred[0]!)
    }
    const isolatedExplicit =
      manifestLayout === 0 &&
      !hasMetadata &&
      ((additions.length === 1 &&
        requested.removed.length === 0 &&
        requested.files.length === additions.length) ||
        (additions.length === 0 && requested.removed.length === 1 && requested.files.length === 0))
    if (!isolatedExplicit && (explicitLayout > 0 || inferred.length > 0))
      return yield* applyMaintenanceTree(library, snapshot, input, scope)
    if (additions.length !== 0 || requested.removed.length !== 0) {
      const added = additions[0]
      const removed = requested.removed[0]
      const plan =
        added !== undefined
          ? yield* prepareSharedFileManagement({
              library,
              snapshot,
              action: "add",
              path: added.path,
              ...(added.mode === undefined ? {} : { mode: added.mode }),
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
    const inputs = yield* Effect.forEach(changedFiles, (file) =>
      Effect.gen(function* () {
        const current = snapshot.files.find((entry) => entry.path === file.path)
        const bindings = evidence.files.filter((entry) => entry.path === file.path)
        if (current === undefined || bindings.length !== 1 || bindings[0] === undefined)
          return yield* Effect.fail(
            fail(
              "SHARED_FILE_NOT_BOUND",
              "Apply can author only an existing unique native file binding; a provider-only file requires an explicit editable binding.",
              { path: file.path },
            ),
          )
        const currentBytes = yield* store.readBytes(`objects/${current.sha256}`)
        if (
          currentBytes.length !== current.bytes ||
          (yield* sha256(currentBytes)) !== current.sha256
        )
          return yield* Effect.fail(
            fail(
              "SNAPSHOT_CONFLICT",
              "The exact selected authoring object is unavailable or differs.",
            ),
          )
        const projection = yield* applyChecked(() =>
          projectSharedNotionMarkdown(
            sharedAuthoringMarkdown(snapshot, file.path, file.bytes, {
              name: input.name,
              description: input.description,
              currentBytes,
            }),
          ),
        )
        return { file, binding: bindings[0], projection }
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
          yield* applyChecked(() => {
            const retainedInput = sharedAuthoringMarkdown(
              snapshot,
              entry.file.path,
              entry.file.bytes,
              {
                name: input.name,
                description: input.description,
                currentBytes: new TextEncoder().encode(plan.before.frontmatter ?? ""),
              },
            )
            if (retainedInput !== entry.projection.input_markdown)
              throw fail(
                "SHARED_METADATA_CONFLICT",
                "The submitted header has no matching retained native ownership baseline.",
                { path: entry.file.path },
              )
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
  if (plan.version === 2)
    for (const child of plan.layout) {
      if (child.action === "add" || child.action === "undelete")
        verifySharedAuthoredSnapshot(snapshot, {
          file_id: child.file_id,
          candidate_sha256: child.content.retained.sha256,
          operation_id: child.operation_id,
        })
      else if (child.action === "delete" && snapshot.files.some((file) => file.path === child.path))
        throw fail(
          "WRITE_VERIFICATION_FAILED",
          "The deleted logical path is still present in the current complete snapshot.",
          { apply_operation_id: plan.operation_id, path: child.path },
        )
      else if (
        child.action === "move" &&
        (snapshot.files.some((file) => file.path === child.path) ||
          !snapshot.files.some((file) => file.path === child.destination_path))
      )
        throw fail(
          "WRITE_VERIFICATION_FAILED",
          "The moved file is not at its frozen destination.",
          { apply_operation_id: plan.operation_id, path: child.destination_path },
        )
    }
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
