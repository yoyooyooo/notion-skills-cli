import { basename, isAbsolute } from "node:path"
import { Effect, Schema } from "effect"
import { parseDocument } from "yaml"
import { decode, fail } from "./model.ts"
import type { LocalSkillInventory } from "./shared-inventory-model.ts"
import { inventoryAssetsSkills, unresolvedInstallClaims } from "./shared-inventory-provenance.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sha256, Store } from "./store.ts"

const BeforeSchema = Schema.Struct({
  version: Schema.Literal(1),
  documents: Schema.Array(Schema.Struct({ path: Schema.String, text: Schema.String })),
})
const invalid = () =>
  fail(
    "INVENTORY_PROVENANCE_PROOF_INVALID",
    "Original provenance must contain each exact approved registry or assets configuration at most once, with complete bytes matching its retained SHA-256.",
  )
const stale = () =>
  fail(
    "INVENTORY_REVIEW_STALE",
    "Registered identity or unresolved provenance changed after inventory review. Legacy opaque findings require the exact original registry bytes, not redacted diagnostic equality.",
  )

/** Recheck only retained opaque facts; never infer their ownership or resolve new paths. */
export function reviewInventoryProvenance(
  originalId: string,
  original: LocalSkillInventory,
  fresh: LocalSkillInventory & { readonly inventory_id: string },
  entityId: string,
  input?: unknown,
) {
  return Effect.gen(function* () {
    const beforeDigests = new Map<string, string>()
    if (input !== undefined) {
      const proof = yield* Effect.try({ try: () => decode(BeforeSchema, input), catch: invalid })
      if (proof.documents.length === 0 || proof.documents.length > original.provenance.length)
        return yield* Effect.fail(invalid())
      for (const document of proof.documents) {
        const retained = original.provenance.find((entry) => entry.path === document.path)
        if (
          !isAbsolute(document.path) ||
          !["install-sources.json", "assets.yaml"].includes(basename(document.path)) ||
          !original.scope.provenance_files.includes(document.path) ||
          beforeDigests.has(document.path) ||
          retained?.status !== "verified" ||
          Buffer.byteLength(document.text) > 2 * 1024 * 1024 ||
          (yield* sha256(document.text)) !== retained.sha256
        )
          return yield* Effect.fail(invalid())
        const isAssets = basename(document.path) === "assets.yaml"
        const claims = yield* Effect.try({
          try: () => {
            if (!isAssets) return unresolvedInstallClaims(JSON.parse(document.text))
            const parsed = parseDocument(document.text, { logLevel: "silent" })
            if (parsed.errors.length) throw invalid()
            return inventoryAssetsSkills(parsed.toJS())
          },
          catch: invalid,
        })
        if (claims === undefined) return yield* Effect.fail(invalid())
        const digest = yield* sha256(canonicalSharedJson(claims))
        const retainedDigest = isAssets
          ? retained.assets_skills_sha256
          : retained.unresolved_install_claims_sha256
        if (retainedDigest !== undefined && retainedDigest !== digest)
          return yield* Effect.fail(invalid())
        beforeDigests.set(document.path, digest)
      }
    }
    const assets = original.provenance.filter((entry) => basename(entry.path) === "assets.yaml")
    const assetReviews: {
      path: string
      original_sha256: string
      current_sha256: string
      assets_skills_sha256: string
      original_evidence: "retained_inventory" | "exact_original_file"
    }[] = []
    const assetsCompatible = assets.every((entry) => {
      const current = fresh.provenance.find((candidate) => candidate.path === entry.path)
      if (
        entry.status !== "verified" ||
        entry.sha256 === null ||
        current?.status !== "verified" ||
        current.sha256 === null
      )
        return false
      if (current.sha256 === entry.sha256) return true
      const digest = entry.assets_skills_sha256 ?? beforeDigests.get(entry.path)
      if (digest === undefined || digest !== current.assets_skills_sha256) return false
      assetReviews.push({
        path: entry.path,
        original_sha256: entry.sha256,
        current_sha256: current.sha256,
        assets_skills_sha256: digest,
        original_evidence:
          entry.assets_skills_sha256 === undefined ? "exact_original_file" : "retained_inventory",
      })
      return true
    })
    if (
      !assetsCompatible &&
      [...original.findings, ...fresh.findings].some(
        (finding) => finding.code === "INSTALL_PROVENANCE_UNSUPPORTED",
      )
    )
      return yield* Effect.fail(stale())
    const reviews: {
      path: string
      original_sha256: string
      current_sha256: string
      unresolved_install_claims_sha256: string
      original_evidence: "retained_inventory" | "exact_original_file"
    }[] = []
    for (const current of fresh.provenance) {
      const before = original.provenance.find((entry) => entry.path === current.path)
      if (before?.sha256 === current.sha256) continue
      const currentFindings = fresh.findings.filter((finding) => finding.path === current.path)
      const opaque = [...original.findings, ...currentFindings].some(
        (finding) =>
          finding.path === current.path && finding.code === "INSTALL_PROVENANCE_UNSUPPORTED",
      )
      if (opaque) {
        const digest = before?.unresolved_install_claims_sha256 ?? beforeDigests.get(current.path)
        if (
          basename(current.path) !== "install-sources.json" ||
          !assetsCompatible ||
          before?.status !== "verified" ||
          before.sha256 === null ||
          current.sha256 === null ||
          digest === undefined ||
          digest !== current.unresolved_install_claims_sha256
        )
          return yield* Effect.fail(stale())
        reviews.push({
          path: current.path,
          original_sha256: before.sha256,
          current_sha256: current.sha256,
          unresolved_install_claims_sha256: digest,
          original_evidence:
            before.unresolved_install_claims_sha256 === undefined
              ? "exact_original_file"
              : "retained_inventory",
        })
      }
      if (
        currentFindings.some(
          (finding) => !opaque || finding.code !== "INSTALL_PROVENANCE_UNSUPPORTED",
        )
      )
        return yield* Effect.fail(stale())
    }
    if (reviews.length === 0 && assetReviews.length === 0) return undefined
    const review = {
      version: 1,
      original_inventory_id: originalId,
      current_inventory_id: fresh.inventory_id,
      entity_id: entityId,
      documents: reviews,
      asset_configuration_reviews: assetReviews,
      unchanged_assets: assets
        .filter((entry) =>
          fresh.provenance.some(
            (current) => current.path === entry.path && current.sha256 === entry.sha256,
          ),
        )
        .map(({ path, sha256 }) => ({ path, sha256 })),
      original_inventory_modified: false,
      ownership_inferred: false,
      source_writes: 0,
      remote_writes: 0,
    }
    const id = `inventory-provenance-review-${yield* sha256(canonicalSharedJson(review))}`
    yield* (yield* Store).writeJson(`inventory/provenance-reviews/${id}.json`, {
      review_id: id,
      ...review,
    })
    return id
  })
}
