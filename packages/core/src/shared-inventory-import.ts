import { Effect, Path, Schema } from "effect"
import { importDocument } from "./import.ts"
import { fail, SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import { withReadOnlyNotion } from "./notion-readonly.ts"
import { executeSharedCreate, prepareSharedCreate, previewSharedCreate } from "./shared-create.ts"
import { SharedCreatePlanSchema, validateSharedCreatePlan } from "./shared-create-model.ts"
import { readFixedLocalFile } from "./shared-fixed-resources.ts"
import {
  readLocalSkillInventory,
  readSharedBaselineInventory,
  revalidateLocalInventoryEntity,
  reviewInventoryReconciliation,
} from "./shared-inventory.ts"
import { runSharedAudit } from "./shared-audit.ts"
import {
  prepareSharedBaselineInventory,
  type SharedBaselineInventory,
} from "./shared-inventory-remote.ts"
import { LocalInventoryEntitySchema, type LocalInventoryEntity } from "./shared-inventory-model.ts"
import {
  SharedLibrarySchema,
  preservesSharedLibraryBindings,
  type SharedLibrary,
} from "./shared-library-model.ts"
import { readPortable, portableRelationSelection, type PortableSkill } from "./portable.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { discoverSourceDefinition } from "./shared-source-adapters.ts"
import { readSourceDefinition } from "./shared-source-definitions.ts"
import { prepareSharedSourceProjection } from "./shared-source-projection.ts"
import { sha256, Store } from "./store.ts"
import type { SourceSnapshot } from "./upstream-source.ts"

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
export const InventoryImportPlanSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("inventory_import"),
  plan_id: Schema.String,
  library: SharedLibrarySchema,
  reconciliation_id: Schema.String,
  local_inventory_id: Schema.String,
  remote_inventory_id: Schema.String,
  local_entity: LocalInventoryEntitySchema,
  approved_manifest: Hash,
  action: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("create"),
      input_class: Schema.Literals(["native", "pure_upstream", "modified_upstream"]),
      creation: SharedCreatePlanSchema,
      baseline_revision: Schema.NullOr(Schema.String),
      selected_revision: Schema.NullOr(Schema.String),
      custom_paths: Schema.Array(Schema.String),
    }),
    Schema.Struct({
      kind: Schema.Literal("verify_existing"),
      page_id: Schema.String,
      skill_id: Schema.String,
      metadata_sha256: Hash,
      ownership_sha256: Hash,
      content_sha256: Hash,
    }),
  ]),
  permissions: Schema.Literal(
    "only_this_complete_reviewed_entity; no_local_changes; no_existing_content_replacement",
  ),
})
export type InventoryImportPlan = typeof InventoryImportPlanSchema.Type
export type InventoryImportDecision =
  | { readonly kind: "native" }
  | {
      readonly kind: "source"
      readonly source: string
      readonly member: string
      readonly baselineCommit?: string
    }
  | { readonly kind: "verify_existing" }
export interface PrepareInventoryImportInput {
  readonly library: SharedLibrary
  readonly reconciliationId: string
  readonly entityId: string
  readonly approvedManifest: string
  readonly decision: InventoryImportDecision
  readonly enabled?: boolean
}
const checked = <A>(read: () => A) =>
  Effect.try({
    try: read,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("INVENTORY_IMPORT_INVALID", "The complete reviewed import input is malformed."),
  })

/** Real file descriptors, not a warm object cache, prove the reviewed local input. */
export function readReviewedInventoryFiles(entity: LocalInventoryEntity) {
  return Effect.gen(function* () {
    if (
      entity.files.length === 0 ||
      entity.files.some(
        (file) => file.status !== "verified" || file.sha256 === null || file.sensitive,
      ) ||
      entity.findings.some((finding) => finding.severity === "blocked")
    )
      return yield* Effect.fail(
        fail(
          "INVENTORY_IMPORT_INCOMPLETE",
          "Every path must have verified shareable bytes and no blocked dependency or boundary.",
        ),
      )
    const path = yield* Path.Path
    const files: PortableSkill["files"][number][] = []
    for (const file of entity.files) {
      const bytes = yield* readFixedLocalFile(
        {
          path: path.basename(file.real_path),
          bytes: file.bytes,
          sha256: file.sha256!,
          mode: file.mode,
        },
        path.dirname(file.real_path),
      )
      if ((yield* sha256(bytes)) !== file.sha256)
        return yield* Effect.fail(
          fail(
            "INVENTORY_REVIEW_STALE",
            "The real file bytes changed after the complete inventory review.",
            { path: file.path },
          ),
        )
      files.push({ path: file.path, bytes, mode: file.mode })
    }
    return files
  })
}

function repositoryIdentity(value: string): string | undefined {
  try {
    const scp = /^([^@\s]+)@([^:\s]+):(.+)$/u.exec(value)
    const url = new URL(scp ? `ssh://${scp[1]}@${scp[2]}/${scp[3]}` : value)
    if (
      !["https:", "ssh:", "http:"].includes(url.protocol) ||
      url.password ||
      url.search ||
      url.hash
    )
      return undefined
    return `${url.hostname.toLowerCase()}${url.pathname.replace(/\.git\/?$/u, "").replace(/\/$/u, "")}`
  } catch {
    return undefined
  }
}
function exactMember(snapshot: SourceSnapshot, key: string) {
  if (!snapshot.revision || (snapshot.unavailable?.length ?? 0) !== 0)
    throw fail(
      "INVENTORY_IMPORT_SOURCE_INCOMPLETE",
      "The complete fixed provider member is unavailable.",
    )
  const members = snapshot.members.filter((member) => member.member_key === key)
  if (members.length !== 1)
    throw fail("INVENTORY_IMPORT_MEMBER", "Choose one exact discovered provider member.")
  return members[0]!
}
function sourceFiles(member: SourceSnapshot["members"][number]) {
  return member.portable.files.map((file) => ({
    ...file,
    mode:
      member.git_manifest?.files.find((entry) => entry.path === file.path)?.mode ??
      file.mode ??
      ("100644" as const),
  }))
}
function changedPaths(local: PortableSkill["files"], baseline: ReturnType<typeof sourceFiles>) {
  return Effect.gen(function* () {
    const hashes = new Map(
      yield* Effect.forEach(baseline, (file) =>
        sha256(file.bytes).pipe(
          Effect.map((hash) => [file.path, { hash, mode: file.mode }] as const),
        ),
      ),
    )
    const changed = new Set(
      baseline
        .filter((file) => !local.some((candidate) => candidate.path === file.path))
        .map((file) => file.path),
    )
    for (const file of local) {
      const before = hashes.get(file.path)
      if (
        before === undefined ||
        before.hash !== (yield* sha256(file.bytes)) ||
        before.mode !== file.mode
      )
        changed.add(file.path)
    }
    return [...changed].sort()
  })
}

type BaselineResource = SharedBaselineInventory["resources"][number]
function contentObserved(resource: BaselineResource | undefined): resource is BaselineResource {
  return (
    resource !== undefined &&
    !resource.reasons.some((reason) =>
      ["audit_coverage_incomplete", "resource_coverage_incomplete", "content_unobserved"].includes(
        reason,
      ),
    ) &&
    resource.files.length > 0 &&
    resource.files.every(
      (file) =>
        file.current_sha256 !== null &&
        file.current_bytes !== null &&
        file.current_mode !== null &&
        !file.reasons.includes("ownership_unobserved"),
    )
  )
}

/** This coordinator prepares original author/source operations; it has no upload dispatcher. */
export function prepareInventoryImport(
  input: PrepareInventoryImportInput,
  acquire: typeof discoverSourceDefinition = discoverSourceDefinition,
) {
  return Effect.gen(function* () {
    const review = yield* reviewInventoryReconciliation(input.reconciliationId)
    if (review.library_id !== input.library.library_id)
      return yield* Effect.fail(
        fail("INVENTORY_IMPORT_SCOPE", "Use the original reconciliation for this exact library."),
      )
    const inventory = yield* readLocalSkillInventory(review.local_inventory_id)
    const entity = inventory.entities.find((entry) => entry.entity_id === input.entityId)
    const match = review.matches.find((entry) => entry.entity_id === input.entityId)
    if (
      entity === undefined ||
      match === undefined ||
      entity.manifest_sha256 !== input.approvedManifest
    )
      return yield* Effect.fail(
        fail(
          "INVENTORY_IMPORT_APPROVAL",
          "Select the exact reviewed entity and explicitly approve its complete manifest digest.",
        ),
      )
    if (match.classification === "blocked" || match.classification === "ambiguous")
      return yield* Effect.fail(
        fail(
          "INVENTORY_IMPORT_BLOCKED",
          "Resolve the recorded identity or content blockers before import.",
          { reasons: match.reasons },
        ),
      )
    const remote = yield* readSharedBaselineInventory(review.remote_inventory_id)
    if (
      remote.library_id !== input.library.library_id ||
      remote.entry_id !== input.library.skills.database_id ||
      remote.visible_registered_census?.coverage !== "full"
    )
      return yield* Effect.fail(
        fail(
          "INVENTORY_IMPORT_SCOPE",
          "The exact library needs a complete, stable census of its visible registered tables. Unrelated content findings remain in the original inventory; missing metadata coverage cannot authorize a new target.",
        ),
      )
    const confirmed = yield* revalidateLocalInventoryEntity(
      review.local_inventory_id,
      input.entityId,
    )
    const files = yield* readReviewedInventoryFiles(confirmed.entity)
    let action: InventoryImportPlan["action"]
    if (input.decision.kind === "verify_existing") {
      const existing = remote.resources.find(
        (entry) =>
          entry.page_id === match.remote_page_id && entry.skill_id === match.remote_skill_id,
      )
      if (
        match.classification !== "managed_equal" ||
        !contentObserved(existing) ||
        existing.skill_id === null
      )
        return yield* Effect.fail(
          fail(
            "INVENTORY_EXISTING_REVIEW_REQUIRED",
            "Existing content requires exact established ownership and complete equality. Differences must use a separate reviewed author operation; import never overwrites them.",
          ),
        )
      action = {
        kind: "verify_existing",
        page_id: existing.page_id,
        skill_id: existing.skill_id,
        metadata_sha256: existing.metadata_sha256,
        ownership_sha256: existing.ownership_sha256,
        content_sha256: existing.content_sha256,
      }
    } else {
      if (
        match.remote_page_id !== null ||
        match.candidates.length !== 0 ||
        entity.identities.some((identity) => identity.page_id !== null)
      )
        return yield* Effect.fail(
          fail(
            "INVENTORY_EXISTING_REVIEW_REQUIRED",
            "An existing, unavailable or ambiguous identity cannot become a new Skill. Review its exact existing target first.",
            { remote_page_id: match.remote_page_id, candidates: match.candidates },
          ),
        )
      if (input.decision.kind === "native") {
        if (
          entity.identities.some(
            (identity) => identity.commit !== null || identity.repository !== null,
          )
        )
          return yield* Effect.fail(
            fail(
              "INVENTORY_SOURCE_DECISION_REQUIRED",
              "This entity has upstream provenance; choose its exact Source/member so custom ancestry is preserved.",
            ),
          )
        const main = files.find((file) => file.path === entity.main)
        if (main === undefined)
          return yield* Effect.fail(
            fail("INVENTORY_IMPORT_INCOMPLETE", "The complete manifest has no main document."),
          )
        const metadata = yield* checked(() => importDocument(main))
        const portable = yield* checked(
          () =>
            readPortable(files) ?? {
              kind: "skill" as const,
              main: entity.main,
              files,
              name: metadata.name,
              description: metadata.description,
            },
        )
        const relations = yield* checked(() =>
          portableRelationSelection(portable.relations, input.library.library_id),
        )
        const creation = yield* prepareSharedCreate(input.library, {
          portable,
          ...relations,
          enabled: input.enabled ?? false,
          completeResources: true,
          markdownImport: true,
        })
        action = {
          kind: "create",
          input_class: "native",
          creation,
          baseline_revision: null,
          selected_revision: null,
          custom_paths: portable.files.map((file) => file.path),
        }
      } else {
        const decision = input.decision
        const localPortable = yield* checked(() => readPortable(files))
        const localFiles = localPortable?.files ?? files
        if (localPortable?.relations !== undefined)
          yield* checked(() =>
            portableRelationSelection(localPortable.relations, input.library.library_id),
          )
        const definition = yield* readSourceDefinition(input.library, decision.source)
        if (!definition.enabled)
          return yield* Effect.fail(
            fail("SOURCE_DISABLED", "Enable the reviewed Source before admitting a new member."),
          )
        const acquired = yield* acquire(definition, { metrics: (yield* Notion).metrics })
        const member = yield* checked(() => exactMember(acquired, decision.member))
        if (localPortable !== undefined) {
          if (
            localPortable.main !== member.portable.main ||
            localPortable.kind !== member.portable.kind
          )
            return yield* Effect.fail(
              fail(
                "INVENTORY_SOURCE_FORMAT_CONFLICT",
                "The reviewed portable kind and entrypoint must match this exact Source member; neither is silently discarded.",
              ),
            )
          const main = localFiles.find((file) => file.path === localPortable.main)
          if (main === undefined)
            return yield* Effect.fail(
              fail("INVENTORY_IMPORT_INCOMPLETE", "The reviewed portable entrypoint is missing."),
            )
          const metadata = yield* checked(() => importDocument(main))
          if (
            metadata.name !== localPortable.name ||
            metadata.description !== localPortable.description
          )
            return yield* Effect.fail(
              fail(
                "INVENTORY_SOURCE_METADATA_CONFLICT",
                "The portable metadata differs from its authored main document. Resolve the explicit local metadata before Source import.",
              ),
            )
        }
        const providerRepository =
          acquired.provenance.git_url ??
          (definition.adapter.type === "git" ? definition.adapter.url : undefined)
        const declared = entity.identities.filter((identity) => identity.repository !== null)
        if (
          declared.length > 0 &&
          (providerRepository === undefined ||
            !declared.some(
              (identity) =>
                repositoryIdentity(identity.repository!) ===
                  repositoryIdentity(providerRepository) &&
                (identity.member === decision.member ||
                  identity.source_path === member.source_path),
            ))
        )
          return yield* Effect.fail(
            fail(
              "INVENTORY_SOURCE_IDENTITY_MISMATCH",
              "The selected Source/member does not match the original registered repository identity; equal bytes or names cannot replace it.",
            ),
          )
        const currentDifferences = yield* changedPaths(localFiles, sourceFiles(member))
        const hasDeclaredBaseline = declared.some(
          (identity) =>
            identity.commit !== null &&
            identity.repository !== null &&
            providerRepository !== undefined &&
            repositoryIdentity(identity.repository) === repositoryIdentity(providerRepository) &&
            (identity.member === decision.member || identity.source_path === member.source_path),
        )
        let baseline: SourceSnapshot | undefined
        let changes = currentDifferences
        if (
          currentDifferences.length !== 0 ||
          hasDeclaredBaseline ||
          decision.baselineCommit !== undefined
        ) {
          if (definition.adapter.type !== "git")
            return yield* Effect.fail(
              fail(
                "INVENTORY_BASELINE_UNAVAILABLE",
                "An upstream import with local differences or declared ancestry needs a proven retrievable fixed baseline; current content cannot replace it.",
              ),
            )
          const repo = repositoryIdentity(definition.adapter.url)
          const proofs = entity.identities.filter(
            (identity) =>
              identity.repository !== null &&
              repositoryIdentity(identity.repository) === repo &&
              identity.commit !== null &&
              /^[a-f0-9]{40}$/u.test(identity.commit) &&
              (identity.member === decision.member ||
                identity.source_path === member.source_path) &&
              (decision.baselineCommit === undefined ||
                identity.commit === decision.baselineCommit),
          )
          const revisions = [...new Set(proofs.map((identity) => identity.commit!))]
          if (repo === undefined || revisions.length !== 1)
            return yield* Effect.fail(
              fail(
                "INVENTORY_BASELINE_UNAVAILABLE",
                "The reviewed provenance does not establish one exact repository/member/commit baseline.",
              ),
            )
          baseline =
            acquired.revision === revisions[0]
              ? acquired
              : yield* acquire(
                  {
                    ...definition,
                    adapter: { ...definition.adapter, ref: revisions[0]! },
                    options: { ...definition.options, accepted_ref: revisions[0]! },
                  },
                  { metrics: (yield* Notion).metrics },
                )
          if (baseline.revision !== revisions[0])
            return yield* Effect.fail(
              fail(
                "INVENTORY_BASELINE_CHANGED",
                "The baseline provider did not return the exact reviewed commit.",
              ),
            )
          changes = yield* changedPaths(
            localFiles,
            sourceFiles(yield* checked(() => exactMember(baseline!, decision.member))),
          )
        }
        const creation = yield* prepareSharedSourceProjection({
          library: input.library,
          definition,
          acquired,
          member: decision.member,
          enabled: input.enabled ?? false,
          markdownImport: true,
          ...(changes.length === 0 && localPortable?.relations === undefined
            ? {}
            : {
                local: {
                  baseline: baseline ?? acquired,
                  files: localFiles,
                  ...(localPortable?.relations === undefined
                    ? {}
                    : { relations: localPortable.relations }),
                },
              }),
        })
        action = {
          kind: "create",
          input_class: changes.length === 0 ? "pure_upstream" : "modified_upstream",
          creation,
          baseline_revision: baseline?.revision ?? acquired.revision,
          selected_revision: acquired.revision,
          custom_paths: changes,
        }
      }
    }
    // Recheck the complete path set after all file descriptors and provider work.
    yield* revalidateLocalInventoryEntity(review.local_inventory_id, input.entityId)
    const contents = {
      version: 1 as const,
      kind: "inventory_import" as const,
      library: input.library,
      reconciliation_id: input.reconciliationId,
      local_inventory_id: review.local_inventory_id,
      remote_inventory_id: review.remote_inventory_id,
      local_entity: entity,
      approved_manifest: input.approvedManifest,
      action,
      permissions:
        "only_this_complete_reviewed_entity; no_local_changes; no_existing_content_replacement" as const,
    }
    const plan = {
      ...contents,
      plan_id: `inventory-import-${yield* sha256(canonicalSharedJson(contents))}`,
    } satisfies InventoryImportPlan
    const store = yield* Store
    const key = `plans/shared-inventory-imports/${plan.plan_id}.json`
    const prior = yield* store.readJson(key, InventoryImportPlanSchema)
    if (prior !== undefined && canonicalSharedJson(prior) !== canonicalSharedJson(plan))
      return yield* Effect.fail(
        fail(
          "INVENTORY_IMPORT_CONFLICT",
          "The original prepared import identity is already bound to different input.",
        ),
      )
    if (prior === undefined) yield* store.writeJson(key, plan)
    return plan
  }).pipe(withReadOnlyNotion)
}

export function validateInventoryImport(input: unknown) {
  return Effect.gen(function* () {
    const plan = yield* checked(() =>
      Schema.decodeUnknownSync(InventoryImportPlanSchema)(input, { onExcessProperty: "error" }),
    )
    const { plan_id, ...contents } = plan
    if (
      plan.approved_manifest !== plan.local_entity.manifest_sha256 ||
      plan_id !== `inventory-import-${yield* sha256(canonicalSharedJson(contents))}`
    )
      return yield* Effect.fail(
        fail("INVENTORY_IMPORT_INVALID", "The frozen import digest or approved manifest differs."),
      )
    if (plan.action.kind === "create") yield* validateSharedCreatePlan(plan.action.creation)
    return plan
  })
}

export function executeInventoryImport(
  library: SharedLibrary,
  input: unknown,
  options: { readonly dryRun?: boolean; readonly reconcile?: boolean } = {},
) {
  const work = Effect.gen(function* () {
    const plan = yield* validateInventoryImport(input)
    if (!preservesSharedLibraryBindings(plan.library, library))
      return yield* Effect.fail(
        fail(
          "INVENTORY_IMPORT_SCOPE",
          "The target no longer preserves the original exact library bindings.",
        ),
      )
    if (!options.reconcile) {
      const saved = yield* (yield* Store).readJson(
        `plans/shared-inventory-imports/${plan.plan_id}.json`,
        InventoryImportPlanSchema,
      )
      if (saved === undefined || canonicalSharedJson(saved) !== canonicalSharedJson(plan))
        return yield* Effect.fail(
          fail(
            "INVENTORY_IMPORT_NOT_PREPARED",
            "Apply requires the exact locally prepared plan and its original inventory scope. A rehashed or copied JSON is not a new sharing authorization; reconciliation remains read-only.",
          ),
        )
      const current = yield* revalidateLocalInventoryEntity(
        plan.local_inventory_id,
        plan.local_entity.entity_id,
      )
      if (current.entity.manifest_sha256 !== plan.approved_manifest)
        return yield* Effect.fail(
          fail("INVENTORY_REVIEW_STALE", "The approved original input changed."),
        )
      yield* readReviewedInventoryFiles(current.entity)
    }
    if (plan.action.kind === "verify_existing") {
      const audit = yield* runSharedAudit({
        entry: library.skills.database_id,
        selector: { kind: "skill", page_id: plan.action.page_id },
        depth: "content",
        incremental: false,
      })
      const inventory = yield* prepareSharedBaselineInventory(audit.run_id)
      const original = plan.action
      const current = inventory.resources.find(
        (entry) => entry.page_id === original.page_id && entry.skill_id === original.skill_id,
      )
      // A targeted audit retains the full library denominator. Other unaudited
      // Skills keep that derived inventory partial; only this exact target can
      // establish this operation's unchanged content and ownership.
      if (
        audit.coverage !== "full" ||
        !contentObserved(current) ||
        current.metadata_sha256 !== original.metadata_sha256 ||
        current.ownership_sha256 !== original.ownership_sha256 ||
        current.content_sha256 !== original.content_sha256
      )
        return yield* Effect.fail(
          fail(
            "INVENTORY_REMOTE_CHANGED",
            "The exact remote content, ownership or metadata differs from the reviewed baseline.",
            { audit_run_id: audit.run_id, inventory_id: inventory.inventory_id },
          ),
        )
      return {
        plan_id: plan.plan_id,
        status: "existing_verified" as const,
        verified: true,
        audit_run_id: audit.run_id,
        remote_writes: 0,
      }
    }
    if (options.dryRun)
      return {
        plan_id: plan.plan_id,
        ...(yield* previewSharedCreate(library, plan.action.creation)),
        verified: false,
      }
    if (!options.reconcile) {
      const store = yield* Store
      const key = `operations/shared-inventory-imports/${plan.plan_id}.json`
      const prior = yield* store.readJson(key, InventoryImportPlanSchema)
      if (prior !== undefined && canonicalSharedJson(prior) !== canonicalSharedJson(plan))
        return yield* Effect.fail(
          fail(
            "INVENTORY_IMPORT_CONFLICT",
            "The original import operation differs from this frozen plan.",
          ),
        )
      if (prior === undefined) yield* store.writeJson(key, plan)
    }
    const result = yield* executeSharedCreate(library, {
      plan: plan.action.creation,
      mode: options.reconcile ? "reconcile" : "create",
    })
    return {
      plan_id: plan.plan_id,
      input_class: plan.action.input_class,
      ...result,
      local_writes: 0,
      imported_from_frozen_manifest: plan.approved_manifest,
    }
  })
  const handled = work.pipe(
    Effect.mapError((error) =>
      error instanceof SkillsError
        ? error
        : fail(
            "INVENTORY_IMPORT_IO_FAILED",
            "The original import could not complete its local evidence or audit I/O. Preserve the frozen operation and inspect it before further writes.",
          ),
    ),
  )
  return options.dryRun || options.reconcile ? handled.pipe(withReadOnlyNotion) : handled
}
