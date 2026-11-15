import { Effect, Schema } from "effect"
import { fail, property, SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import { withReadOnlyNotion } from "./notion-readonly.ts"
import { withSharedAuthoringTarget } from "./shared-authoring-context.ts"
import { loadSharedLibrary } from "./shared-library.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import { SourceOnboardingScopeSchema } from "./shared-source-onboarding-model.ts"
import { readSourceOnboardingInventory } from "./shared-source-onboarding.ts"
import { listSourceDefinitions, readSourceDefinition } from "./shared-source-definitions.ts"
import { discoverSourceDefinition } from "./shared-source-adapters.ts"
import { sourceMemberStorageDecision } from "./shared-source-member.ts"
import {
  SourceRefreshPlanSchema,
  prepareSourceRefreshFromSnapshot,
  reviewSourceMembers,
  applySourceRefresh,
  reconcileSourceRefresh,
} from "./shared-source-refresh.ts"
import { resolveSelectedSharedSourceReference } from "./shared-selected-source.ts"
import { sharedCreateRetainedBinding } from "./shared-create-retained.ts"
import { SharedCreateManifestSchema, sharedCreateManifestEntity } from "./shared-create-model.ts"
import { canonicalSharedJson, querySharedRecords } from "./shared-records.ts"
import { querySharedSkillIndex } from "./shared-skill-index.ts"
import { sha256 } from "./store.ts"
import { pageId } from "./ref.ts"
import { withSourceUpdateLock } from "./shared-source-policy.ts"

const checked = <A>(f: () => A) =>
  Effect.try({
    try: f,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("SOURCE_STORAGE_INVALID", "The exact storage request or proof is invalid."),
  })
const hash = (value: unknown) => sha256(canonicalSharedJson(value))
const same = (a: unknown, b: unknown) => canonicalSharedJson(a) === canonicalSharedJson(b)
const ManifestFile = Schema.Struct({
  path: Schema.String,
  sha256: Schema.String,
  bytes: Schema.Number,
  mode: Schema.Literals(["100644", "100755"]),
})
const AlignmentSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("source_storage_alignment"),
  plan_id: Schema.String,
  entry: Schema.String,
  governance_sha256: Schema.String,
  original_source_id: Schema.String,
  original_revision: Schema.String,
  original_files: Schema.Array(ManifestFile),
  refresh: SourceRefreshPlanSchema,
})
export type SourceStorageAlignment = typeof AlignmentSchema.Type

function governance(library: SharedLibrary, target: string) {
  return Effect.gen(function* () {
    const raw = property(yield* (yield* Notion).request(`v1/pages/${target}`))
    const index = yield* querySharedSkillIndex(library, target, raw)
    const fields = Object.entries(property(raw.properties))
      .filter(([key, value]) => {
        const field = property(value)
        return (
          key !== library.skills.property_ids.Source &&
          field.id !== library.skills.property_ids.Source &&
          !["last_edited_time", "last_edited_by", "formula", "rollup"].includes(String(field.type))
        )
      })
      .sort(([a], [b]) => a.localeCompare(b))
    return {
      index,
      sha256: yield* hash({
        id: raw.id,
        parent: raw.parent,
        properties: Object.fromEntries(fields),
      }),
    }
  })
}

function exactFiles(
  input: readonly { path: string; sha256?: string; bytes: number; mode?: string }[],
) {
  return Schema.decodeUnknownSync(Schema.Array(ManifestFile))(
    input.map((file) => ({
      path: file.path,
      sha256: file.sha256,
      bytes: file.bytes,
      mode: file.mode,
    })),
    { onExcessProperty: "error" },
  )
}
function originalRevision(
  library: SharedLibrary,
  target: string,
  sourcePage: string,
  member: string,
  pin: string,
) {
  return Effect.gen(function* () {
    const selected = yield* resolveSelectedSharedSourceReference(library, {
      skillPageId: target,
      sourceId: pin,
    })
    if (selected.kind === "git")
      return {
        kind: "git" as const,
        revision: selected.binding.commit,
      }
    if (selected.kind !== "retained_bundle")
      return yield* Effect.fail(
        fail(
          "SOURCE_STORAGE_REVIEW_REQUIRED",
          "This current selection is not an immutable retained original or fixed Git source; preserve it for explicit review.",
        ),
      )
    const revisions = new Set<string>()
    const manifests = yield* querySharedRecords(library, {
      skillPageId: target,
      kind: "operation",
      entityId: sharedCreateManifestEntity,
    })
    for (const row of manifests) {
      const manifest = yield* checked(() =>
        Schema.decodeUnknownSync(SharedCreateManifestSchema)(row.payload, {
          onExcessProperty: "error",
        }),
      )
      const frozen = manifest.source_projection
      if (
        frozen?.version !== 2 ||
        frozen.definition.page_id !== sourcePage ||
        frozen.definition.member !== member
      )
        continue
      const source = yield* sharedCreateRetainedBinding(library, frozen.retained, target)
      if (source.source_id === pin) revisions.add(frozen.provider_revision)
    }
    if (revisions.size === 0) {
      const candidates = yield* querySharedRecords(library, { skillPageId: target, kind: "source" })
      for (const row of candidates) {
        const candidate = property(row.payload)
        if (
          candidate.kind === "source_refresh_candidate" &&
          candidate.bundle_id === pin &&
          candidate.source_page_id === sourcePage &&
          candidate.member === member &&
          typeof candidate.provider_revision === "string"
        )
          revisions.add(candidate.provider_revision)
      }
    }
    if (revisions.size !== 1)
      return yield* Effect.fail(
        fail(
          "SOURCE_STORAGE_ORIGINAL_REVISION_UNPROVEN",
          "The exact original Git revision is missing or ambiguous; current branch/HEAD cannot substitute.",
          { target, pin },
        ),
      )
    const revision = [...revisions][0]!
    if (!/^[a-f0-9]{40}$/u.test(revision))
      return yield* Effect.fail(
        fail(
          "SOURCE_STORAGE_ORIGINAL_REVISION_UNPROVEN",
          "The retained source has no full original Git commit.",
        ),
      )
    return {
      kind: "retained_bundle" as const,
      revision,
      files: yield* checked(() => exactFiles(selected.binding.files)),
    }
  })
}

/** Full forward metadata roster only: no source discovery, ZIP/body read or
 * provider access. A native/empty selection is not evidence of a healthy import. */
export function reviewSourceStorage(input: { readonly entry: string; readonly scope: unknown }) {
  return Effect.gen(function* () {
    const library = yield* loadSharedLibrary(input.entry)
    const scope = yield* checked(() =>
      Schema.decodeUnknownSync(SourceOnboardingScopeSchema)(input.scope, {
        onExcessProperty: "error",
      }),
    )
    const inventory = yield* readSourceOnboardingInventory(library)
    const sources =
      scope.kind === "all"
        ? yield* listSourceDefinitions(library)
        : [yield* readSourceDefinition(library, scope.source)]
    const results = []
    for (const source of sources) {
      const rows = inventory.filter(
        (row) =>
          row.origin === source.page_id &&
          (scope.kind !== "source" ||
            scope.members === undefined ||
            scope.members.includes(row.member)),
      )
      for (const row of rows) {
        const storage =
          row.selected_version.startsWith("source-") &&
          !row.selected_version.startsWith("source-plan-")
            ? "fixed_git"
            : row.selected_version.startsWith("bundle-")
              ? "retained_bundle"
              : row.selected_version.startsWith("source-plan-")
                ? "composition"
                : row.selected_version.startsWith("snapshot-")
                  ? "snapshot"
                  : row.selected_version === ""
                    ? "native_or_unfinished"
                    : "unknown"
        results.push({
          ...row,
          source_id: source.source_id,
          source_enabled: source.enabled,
          source_provider: "adapter" in source ? source.adapter.type : source.provider,
          source_storage_policy:
            "options" in source ? (source.options.storage ?? "auto") : "unobserved",
          storage,
          disposition:
            row.kind !== "skill"
              ? "not_skill"
              : storage === "fixed_git"
                ? "already_external"
                : storage === "retained_bundle"
                  ? "review_same_revision"
                  : "review_required",
          original_completion: "unobserved",
          custom_content: "unobserved",
          body_verification: "unobserved",
        })
      }
    }
    return {
      version: 1,
      kind: "source_storage_inventory",
      scope,
      coverage: "complete_forward_inventory",
      items: results,
      sources: sources.length,
      inventory_rows: inventory.length,
      selected_scope_rows: results.length,
      summary: {
        fixed_git: results.filter((row) => row.storage === "fixed_git").length,
        retained_skills: results.filter(
          (row) => row.storage === "retained_bundle" && row.kind === "skill",
        ).length,
        retained_routers: results.filter(
          (row) => row.storage === "retained_bundle" && row.kind === "router",
        ).length,
        other: results.filter(
          (row) => row.storage !== "fixed_git" && row.storage !== "retained_bundle",
        ).length,
      },
      remote_writes: 0,
      provider_requests: 0,
      body_requests: 0,
      policy: "external_first_explicit_retention",
      history_cleanup: false,
    }
  }).pipe(withReadOnlyNotion)
}

export function prepareSourceStorageAlignment(
  input: { readonly entry: string; readonly source: string; readonly target: string },
  acquire: typeof discoverSourceDefinition = discoverSourceDefinition,
) {
  return Effect.gen(function* () {
    if (pageId(input.target) !== input.target)
      return yield* Effect.fail(
        fail("EXACT_TARGET_REQUIRED", "Use one original Skill page for storage alignment."),
      )
    const library = yield* loadSharedLibrary(input.entry),
      definition = yield* readSourceDefinition(library, input.source)
    if (definition.adapter.type !== "git" || !definition.enabled)
      return yield* Effect.fail(
        fail(
          "SOURCE_STORAGE_REVIEW_REQUIRED",
          "Align an enabled exact Git Source; leave other providers unchanged.",
        ),
      )
    if (definition.options.storage === "retained")
      return yield* Effect.fail(
        fail(
          "SOURCE_STORAGE_EXPLICIT_RETENTION",
          "This Source explicitly selects retained storage. Review that source-level choice before aligning current versions; do not silently override it.",
        ),
      )
    const inventory = yield* readSourceOnboardingInventory(library),
      row = inventory.find((row) => row.page_id === input.target)
    if (
      !row ||
      row.kind !== "skill" ||
      row.origin !== definition.page_id ||
      !row.member ||
      !row.selected_version
    )
      return yield* Effect.fail(
        fail(
          "SOURCE_STORAGE_REVIEW_REQUIRED",
          "The original bound Skill has no completed selectable source. Preserve incomplete operations and custom native content.",
          { target: input.target },
        ),
      )
    const before = yield* governance(library, input.target)
    const original = yield* originalRevision(
      library,
      input.target,
      definition.page_id,
      row.member,
      row.selected_version,
    )
    if (original.kind === "git")
      return {
        status: "unchanged" as const,
        source_pin: row.selected_version,
        revision: original.revision,
        remote_writes: 0 as const,
      }
    const acquired = yield* acquire(
      {
        ...definition,
        adapter: { ...definition.adapter, ref: original.revision },
        options: { ...definition.options, accepted_ref: original.revision },
      },
      { metrics: (yield* Notion).metrics },
    )
    if (acquired.revision !== original.revision)
      return yield* Effect.fail(
        fail(
          "SOURCE_STORAGE_REVISION_CHANGED",
          "Storage alignment cannot select a newer or different upstream revision.",
        ),
      )
    const decision = yield* checked(() =>
      sourceMemberStorageDecision(definition, acquired, row.member, "fixed-git"),
    )
    if (decision.kind !== "fixed_git")
      return yield* Effect.fail(
        fail(
          "SOURCE_STORAGE_REVIEW_REQUIRED",
          "The original member is not directly reproducible as fixed Git; no entire archive upload is authorized.",
          decision,
        ),
      )
    const member = acquired.members.find((member) => member.member_key === row.member)!
    const sourceFiles = yield* Effect.forEach(member.portable.files, (file) =>
      Effect.gen(function* () {
        const mode =
          member.git_manifest?.files.find((entry) => entry.path === file.path)?.mode ?? file.mode
        return {
          path: file.path,
          sha256: yield* sha256(file.bytes),
          bytes: file.bytes.length,
          mode,
        }
      }),
    )
    const exact = yield* checked(() => exactFiles(sourceFiles))
    if (
      !same(
        [...original.files].sort((a, b) => a.path.localeCompare(b.path)),
        [...exact].sort((a, b) => a.path.localeCompare(b.path)),
      )
    )
      return yield* Effect.fail(
        fail(
          "SOURCE_STORAGE_CONTENT_DIFFERS",
          "The fixed upstream tree does not exactly reproduce every old path/hash/byte length/mode. Preserve old storage and review transformations.",
        ),
      )
    const memberReview = yield* reviewSourceMembers(library, definition.page_id, acquired)
    const refresh = yield* withSharedAuthoringTarget(
      input.target,
      prepareSourceRefreshFromSnapshot(library, {
        definition,
        acquired,
        memberReview,
        target: input.target,
        storage: "fixed-git",
      }),
    )
    if (refresh.version !== 4 || refresh.previous_pin !== row.selected_version)
      return yield* Effect.fail(
        fail("SOURCE_STORAGE_INVALID", "Expected the original fixed Git selection protocol."),
      )
    if ((yield* governance(library, input.target)).sha256 !== before.sha256)
      return yield* Effect.fail(
        fail("SOURCE_TARGET_CHANGED", "Skill governance changed while freezing storage alignment."),
      )
    const fields = {
      version: 1 as const,
      kind: "source_storage_alignment" as const,
      entry: input.entry,
      governance_sha256: before.sha256,
      original_source_id: row.selected_version,
      original_revision: original.revision,
      original_files: original.files,
      refresh,
    }
    return {
      status: "prepared" as const,
      plan: { ...fields, plan_id: "source-storage-" + (yield* hash(fields)) },
      decision,
      new_archive_bytes: 0,
      new_binary_objects: 0,
      remote_writes: 0 as const,
    }
  }).pipe(withReadOnlyNotion)
}

function validateAlignment(input: unknown) {
  return Effect.gen(function* () {
    const plan = yield* checked(() =>
        Schema.decodeUnknownSync(AlignmentSchema)(input, { onExcessProperty: "error" }),
      ),
      { plan_id, ...fields } = plan
    if (
      plan_id !== "source-storage-" + (yield* hash(fields)) ||
      plan.refresh.version !== 4 ||
      plan.refresh.previous_pin !== plan.original_source_id ||
      plan.refresh.provider_revision !== plan.original_revision ||
      !same(
        [...plan.original_files].sort((a, b) => a.path.localeCompare(b.path)),
        [...plan.refresh.source_files].sort((a, b) => a.path.localeCompare(b.path)),
      )
    )
      return yield* Effect.fail(
        fail(
          "SOURCE_STORAGE_INVALID",
          "Storage plan digest, original version or exact bytes differ.",
        ),
      )
    return plan
  })
}
export function applySourceStorageAlignment(input: {
  readonly plan: unknown
  readonly dryRun?: boolean
}) {
  return Effect.gen(function* () {
    const plan = yield* validateAlignment(input.plan),
      library = yield* loadSharedLibrary(plan.entry)
    const action = Effect.gen(function* () {
      if (
        (yield* governance(library, plan.refresh.target_page_id)).sha256 !== plan.governance_sha256
      )
        return yield* Effect.fail(
          fail(
            "SOURCE_STORAGE_GOVERNANCE_CHANGED",
            "Original identity, enabled state, relations or other native properties changed; do not apply stale storage intent.",
          ),
        )
      const original = yield* originalRevision(
        library,
        plan.refresh.target_page_id,
        plan.refresh.source_page_id,
        plan.refresh.member,
        plan.original_source_id,
      )
      if (
        original.kind !== "retained_bundle" ||
        original.revision !== plan.original_revision ||
        !same(
          [...original.files].sort((a, b) => a.path.localeCompare(b.path)),
          [...plan.original_files].sort((a, b) => a.path.localeCompare(b.path)),
        )
      )
        return yield* Effect.fail(
          fail(
            "SOURCE_STORAGE_ORIGINAL_CHANGED",
            "The reviewed old source content and original revision no longer match their immutable records; no new selection is authorized.",
          ),
        )
      const result = yield* applySourceRefresh(library, plan.refresh, input.dryRun === true, false)
      if (
        (yield* governance(library, plan.refresh.target_page_id)).sha256 !== plan.governance_sha256
      )
        return yield* Effect.fail(
          fail(
            "SOURCE_STORAGE_GOVERNANCE_CHANGED",
            "Governance changed during the acknowledged selection; preserve the actual state, do not roll back.",
          ),
        )
      return {
        plan_id: plan.plan_id,
        source_plan_id: plan.refresh.plan_id,
        result,
        source_bytes_unchanged: true,
        history_preserved: true,
        new_archive_bytes: 0,
        new_binary_objects: 0,
        body_writes: 0,
      }
    })
    return yield* withSharedAuthoringTarget(
      plan.refresh.target_page_id,
      withSourceUpdateLock(library, input.dryRun ? action.pipe(withReadOnlyNotion) : action),
    )
  })
}
export function reconcileSourceStorageAlignment(input: { readonly plan: unknown }) {
  return Effect.gen(function* () {
    const plan = yield* validateAlignment(input.plan),
      library = yield* loadSharedLibrary(plan.entry)
    const result = yield* withSharedAuthoringTarget(
      plan.refresh.target_page_id,
      reconcileSourceRefresh(library, plan.refresh),
    )
    return { plan_id: plan.plan_id, result, remote_writes: 0, requires_fresh_read: true }
  }).pipe(withReadOnlyNotion)
}
