import { Effect, Schema } from "effect"
import { decode, fail, property, text, SkillsError } from "./model.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256 } from "./store.ts"
import { scanLocalSkillInventory } from "./shared-inventory-local.ts"
import { INVENTORY_RULES, LocalSkillInventorySchema } from "./shared-inventory-model.ts"
import { readInventoryArtifact, saveInventoryArtifact } from "./shared-inventory-store.ts"
import { readSharedBaselineInventory } from "./shared-inventory-remote.ts"

export {
  scanLocalSkillInventory,
  type ScanLocalSkillInventoryInput,
} from "./shared-inventory-local.ts"
export {
  prepareSharedBaselineInventory,
  readSharedBaselineInventory,
} from "./shared-inventory-remote.ts"
export { readInventoryArtifact } from "./shared-inventory-store.ts"
const checked = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("INVENTORY_INVALID", "The retained inventory is malformed."),
  })

export function readLocalSkillInventory(id: string) {
  return readInventoryArtifact(id, "local").pipe(
    Effect.flatMap((artifact) =>
      checked(() => decode(LocalSkillInventorySchema, artifact.payload)),
    ),
  )
}

/** Recheck one approved entity without enlarging the original readable scope. */
export function revalidateLocalInventoryEntity(inventoryId: string, entityId: string) {
  return Effect.gen(function* () {
    const original = yield* readLocalSkillInventory(inventoryId)
    const entity = original.entities.find((entity) => entity.entity_id === entityId)
    if (entity === undefined)
      return yield* Effect.fail(
        fail("INVENTORY_ENTITY_NOT_FOUND", "The exact local entity is absent from this inventory."),
      )
    const fresh = yield* scanLocalSkillInventory({
      roots: entity.aliases,
      expected_root_targets: Object.fromEntries(
        entity.aliases.map((alias) => [alias, entity.real_root]),
      ),
      allow_targets: [entity.real_root, ...original.scope.roots, ...original.scope.allow_targets],
      provenance_files: original.scope.provenance_files,
    })
    const current = fresh.entities.find((entry) => entry.entity_id === entityId)
    if (
      fresh.coverage !== "full" ||
      current === undefined ||
      current.files.some((file) => file.status !== "verified") ||
      current.findings.some((finding) => finding.severity === "blocked")
    )
      return yield* Effect.fail(
        fail(
          "INVENTORY_ENTITY_INCOMPLETE",
          "The complete approved local entity cannot currently be verified.",
          { entity_id: entityId, inventory_id: fresh.inventory_id },
        ),
      )
    if (
      current.manifest_sha256 !== entity.manifest_sha256 ||
      canonicalSharedJson(current.identities) !== canonicalSharedJson(entity.identities) ||
      canonicalSharedJson(fresh.provenance) !== canonicalSharedJson(original.provenance)
    )
      return yield* Effect.fail(
        fail(
          "INVENTORY_REVIEW_STALE",
          "Local content, paths, modes or registered identity changed after inventory review.",
          { entity_id: entityId, inventory_id: fresh.inventory_id },
        ),
      )
    return {
      original_inventory_id: inventoryId,
      inventory_id: fresh.inventory_id,
      entity: current,
      scope: original.scope,
    }
  })
}

export const InventoryReconciliationSchema = Schema.Struct({
  version: Schema.Literal(1),
  rules_version: Schema.Literal(INVENTORY_RULES),
  review_id: Schema.String,
  remote_inventory_id: Schema.String,
  local_inventory_id: Schema.String,
  remote_plan_id: Schema.String,
  local_manifest_id: Schema.String,
  library_id: Schema.String,
  coverage: Schema.Literals(["full", "partial"]),
  matches: Schema.Array(
    Schema.Struct({
      entity_id: Schema.String,
      real_root: Schema.String,
      aliases: Schema.Array(Schema.String),
      classification: Schema.Literals([
        "managed_equal",
        "managed_local_changes",
        "managed_review_required",
        "upstream_candidate",
        "local_custom",
        "ambiguous",
        "blocked",
      ]),
      authority: Schema.Literals([
        "exact_page_identity",
        "exact_source_provenance",
        "unestablished",
      ]),
      remote_page_id: Schema.NullOr(Schema.String),
      remote_skill_id: Schema.NullOr(Schema.String),
      reasons: Schema.Array(Schema.String),
      files: Schema.Array(Schema.Unknown),
      candidates: Schema.Array(Schema.Struct({ page_id: Schema.String, reason: Schema.String })),
    }),
  ),
  unmatched_remote: Schema.Array(Schema.String),
  action: Schema.Literal("review_only"),
  remote_writes: Schema.Literal(0),
  source_writes: Schema.Literal(0),
})
export type InventoryReconciliation = typeof InventoryReconciliationSchema.Type
function repoIdentity(value: unknown) {
  if (typeof value !== "string") return null
  try {
    const url = new URL(value)
    return `${url.hostname.toLowerCase()}${url.pathname.replace(/\.git$/u, "").replace(/\/$/u, "")}`
  } catch {
    return null
  }
}
function resourceName(metadata: unknown) {
  const values = Object.values(property(property(property(metadata).skill).properties)).map(
    property,
  )
  return text(values.find((value) => value.type === "title")?.title)
}

export function reconcileSkillInventories(input: {
  readonly remote_inventory_id: string
  readonly local_inventory_id: string
}) {
  return Effect.gen(function* () {
    const remote = yield* readSharedBaselineInventory(input.remote_inventory_id)
    const local = yield* readLocalSkillInventory(input.local_inventory_id)
    const matches: InventoryReconciliation["matches"][number][] = []
    const matched = new Set<string>()
    for (const entity of local.entities) {
      const byPage = remote.resources.filter((resource) =>
        entity.identities.some(
          (identity) =>
            identity.page_id === resource.page_id &&
            (identity.library_id === null || identity.library_id === remote.library_id),
        ),
      )
      const bySource = remote.resources.filter((resource) => {
        const selected = property(resource.selected),
          binding = property(selected.binding),
          context = property(property(resource.source_context).definition)
        return entity.identities.some((identity) => {
          if (
            identity.source_id !== null &&
            identity.library_id === remote.library_id &&
            identity.source_id === context.source_id &&
            identity.member !== null &&
            identity.member === context.member
          )
            return identity.commit !== null && identity.commit === selected.revision
          return (
            selected.kind === "git" &&
            identity.repository !== null &&
            identity.commit !== null &&
            identity.source_path !== null &&
            repoIdentity(identity.repository) === repoIdentity(binding.url) &&
            identity.commit === binding.commit &&
            identity.source_path === binding.root
          )
        })
      })
      const choices = byPage.length ? byPage : bySource
      const selected = choices.length === 1 ? choices[0] : undefined
      const reasons: string[] = []
      if (remote.coverage !== "full" || local.coverage !== "full")
        reasons.push("inventory_coverage_incomplete")
      if (entity.findings.length) reasons.push("local_findings_require_review")
      if (entity.files.some((file) => file.status !== "verified" || file.sensitive))
        reasons.push("local_bytes_not_admissible")
      if (choices.length > 1) reasons.push("identity_ambiguous")
      const fileComparisons =
        selected === undefined
          ? []
          : entity.files.map((file) => {
              const other = selected.files.find((candidate) => candidate.path === file.path)
              const sameBytes =
                other !== undefined &&
                file.sha256 !== null &&
                file.sha256 === other.current_sha256 &&
                file.bytes === other.current_bytes
              const comparison =
                other === undefined
                  ? "local_only"
                  : !sameBytes
                    ? "different"
                    : other.current_mode === null
                      ? "bytes_equal_mode_unestablished"
                      : other.current_mode === file.mode
                        ? "equal"
                        : "mode_different"
              return {
                path: file.path,
                local_sha256: file.sha256,
                local_mode: file.mode,
                remote_file_id: other?.file_id ?? null,
                remote_page_id: other?.page_id ?? null,
                remote_sha256: other?.current_sha256 ?? null,
                remote_mode: other?.current_mode ?? null,
                comparison,
                remote_ownership: other?.ownership ?? null,
              }
            })
      const remoteOnly =
        selected?.files
          .filter((file) => !entity.files.some((local) => local.path === file.path))
          .map((file) => ({
            path: file.path,
            comparison: "remote_only",
            remote_file_id: file.file_id,
            remote_page_id: file.page_id,
            remote_ownership: file.ownership,
          })) ?? []
      const equal =
        selected !== undefined &&
        !remoteOnly.length &&
        fileComparisons.every((file) => file.comparison === "equal")
      const modeUnobserved = fileComparisons.some(
        (file) => file.comparison === "bytes_equal_mode_unestablished",
      )
      if (modeUnobserved) reasons.push("remote_mode_unestablished")
      const changed =
        remoteOnly.length > 0 ||
        fileComparisons.some((file) =>
          ["different", "local_only", "mode_different"].includes(file.comparison),
        )
      if (selected !== undefined) matched.add(selected.page_id)
      const candidates =
        selected === undefined
          ? remote.resources.flatMap((resource) => {
              const name = resourceName(resource.metadata)
              const sameBytes =
                resource.files.length === entity.files.length &&
                entity.files.every((file) =>
                  resource.files.some(
                    (other) =>
                      file.path === other.path &&
                      file.sha256 !== null &&
                      file.sha256 === other.current_sha256,
                  ),
                )
              return name === entity.name || sameBytes
                ? [
                    {
                      page_id: resource.page_id,
                      reason: sameBytes
                        ? "same_bytes_do_not_establish_authority"
                        : "same_name_does_not_establish_authority",
                    },
                  ]
                : []
            })
          : []
      if (selected === undefined && candidates.length)
        reasons.push("similarity_is_not_management_authority")
      matches.push({
        entity_id: entity.entity_id,
        real_root: entity.real_root,
        aliases: entity.aliases,
        classification: entity.files.some((file) => file.status !== "verified" || file.sensitive)
          ? "blocked"
          : choices.length > 1
            ? "ambiguous"
            : selected !== undefined
              ? byPage.length
                ? equal
                  ? "managed_equal"
                  : changed
                    ? "managed_local_changes"
                    : "managed_review_required"
                : "upstream_candidate"
              : entity.identities.some((identity) => identity.commit !== null)
                ? "upstream_candidate"
                : "local_custom",
        authority:
          selected === undefined
            ? "unestablished"
            : byPage.length
              ? "exact_page_identity"
              : "exact_source_provenance",
        remote_page_id: selected?.page_id ?? null,
        remote_skill_id: selected?.skill_id ?? null,
        reasons,
        files: [...fileComparisons, ...remoteOnly],
        candidates,
      })
    }
    const core = {
      version: 1 as const,
      rules_version: INVENTORY_RULES,
      remote_plan_id: remote.plan_id,
      local_manifest_id: local.manifest_id,
      library_id: remote.library_id,
      coverage:
        remote.coverage === "full" && local.coverage === "full"
          ? ("full" as const)
          : ("partial" as const),
      matches,
      unmatched_remote: remote.resources
        .filter((resource) => !matched.has(resource.page_id))
        .map((resource) => resource.page_id),
      action: "review_only" as const,
      remote_writes: 0 as const,
      source_writes: 0 as const,
    } as const
    const output: InventoryReconciliation = {
      ...core,
      ...input,
      review_id: `inventory-review-${yield* sha256(canonicalSharedJson(core))}`,
    }
    return { inventory_id: yield* saveInventoryArtifact("reconciliation", output), ...output }
  })
}

export function reviewInventoryReconciliation(
  id: string,
  current?: { readonly remote_inventory_id: string; readonly local_inventory_id: string },
) {
  return Effect.gen(function* () {
    const artifact = yield* readInventoryArtifact(id, "reconciliation")
    const reviewed = yield* checked(() => decode(InventoryReconciliationSchema, artifact.payload))
    if (current !== undefined) {
      const remote = yield* readSharedBaselineInventory(current.remote_inventory_id)
      const local = yield* readLocalSkillInventory(current.local_inventory_id)
      if (
        reviewed.remote_plan_id !== remote.plan_id ||
        reviewed.local_manifest_id !== local.manifest_id ||
        reviewed.library_id !== remote.library_id
      )
        return yield* Effect.fail(
          fail(
            "INVENTORY_REVIEW_STALE",
            "The remote baseline, local manifest or exact library changed after reconciliation review.",
          ),
        )
    }
    return {
      inventory_id: id,
      ...reviewed,
      verification:
        current === undefined
          ? ("historical_observation" as const)
          : ("supplied_observations_match" as const),
    }
  })
}
