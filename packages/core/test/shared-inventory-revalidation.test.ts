import "../src/shared-source-registration.ts"
import { expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, realpath, symlink, unlink } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Effect, Schema } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import {
  scanLocalSkillInventory,
  readLocalSkillInventory,
  revalidateLocalInventoryEntity,
  prepareSharedBaselineInventory,
  reconcileSkillInventories,
} from "../src/shared-inventory.ts"
import { prepareInventoryImport } from "../src/shared-inventory-import.ts"
import { runSharedAudit } from "../src/shared-audit.ts"
import { fileRef } from "../src/ref.ts"
import { sharedSkillId } from "../src/shared-content.ts"
import { auditFixture } from "./shared-audit-fixture.ts"
import { saveInventoryArtifact } from "../src/shared-inventory-store.ts"
import { Store } from "../src/store.ts"
import { property } from "../src/model.ts"
import { id, library, skillPage } from "./shared-snapshot-fixture.ts"

async function fixture() {
  const f = await auditFixture(1)
  const root = await realpath(await mkdtemp(join(tmpdir(), "ntn-inventory-revalidation-")))
  const skill = join(root, "skills", "sample")
  const provenance = join(root, ".ak", "notion-handoffs.json")
  await mkdir(skill, { recursive: true })
  await mkdir(join(root, ".ak"))
  await writeFile(
    join(skill, "SKILL.md"),
    "---\nname: sample\ndescription: Native input\n---\n# Main\n",
  )
  await writeFile(provenance, JSON.stringify({ version: 1, skills: [] }))
  const scan = (files = [provenance]) =>
    f.run(scanLocalSkillInventory({ roots: [skill], provenance_files: files }))
  return { f, root, skill, provenance, scan }
}

test("entity revalidation permits unrelated valid handoffs while preserving both inventory observations", async () => {
  const { f, provenance, scan } = await fixture()
  const original = await scan()
  const entity = original.entities[0]!
  await writeFile(
    provenance,
    JSON.stringify({
      version: 1,
      skills: [
        { name: "retired", path: "skills/retired", ref: fileRef(id(70), "SKILL.md") },
        { name: "router", path: "skills/router", ref: fileRef(id(71), "ROUTER.md") },
        {
          name: "stable",
          path: "skills/stable",
          ref: fileRef(sharedSkillId(library.library_id, "other-skill"), "PROMPT.md"),
        },
      ],
    }),
  )
  const checked = await f.run(
    revalidateLocalInventoryEntity(original.inventory_id, entity.entity_id),
  )
  expect(checked.entity).toEqual(entity)
  expect(checked.original_inventory_id).toBe(original.inventory_id)
  expect(checked.inventory_id).not.toBe(original.inventory_id)
  const old = await f.run(readLocalSkillInventory(original.inventory_id))
  const fresh = await f.run(readLocalSkillInventory(checked.inventory_id))
  const { inventory_id: originalId, ...originalReport } = original
  expect(originalId).toBe(checked.original_inventory_id)
  expect(old).toEqual(originalReport)
  expect(fresh.provenance[0]?.sha256).not.toBe(old.provenance[0]?.sha256)
  expect(fresh.findings.some((finding) => finding.code === "HANDOFF_IDENTITY_INVALID")).toBe(false)
  expect(f.ledger).toHaveLength(0)
})

test("changed provenance cannot hide selected, malformed, unobserved or conflicting claims", async () => {
  const { f, root, provenance, scan } = await fixture()
  const alias = join(root, "registry-alias")
  await symlink(join(root, ".ak"), alias)
  const logical = join(alias, "notion-handoffs.json")
  const original = await scan([logical])
  const entity = original.entities[0]!
  const selected = { name: "sample", path: "skills/sample", ref: fileRef(skillPage, "SKILL.md") }
  for (const document of [
    { version: 1, skills: [selected] },
    { version: 1, skills: [{ ...selected, ref: "skill://same-display-name/SKILL.md" }] },
    { version: 1, skills: [{ ...selected, ref: "skill://%broken/SKILL.md" }] },
    { version: 1, skills: [{ ...selected, path: "../outside" }] },
    { version: 1, skills: [selected, { ...selected, ref: fileRef(id(72), "SKILL.md") }] },
    { version: 1, skills: [{ ...selected, path: "skills/other", ref: "invalid" }] },
    { version: 2, skills: [] },
    { version: 1, unsupported: [] },
    {
      version: 1,
      skills: [
        { ...selected, ref: fileRef(sharedSkillId(library.library_id, "new-owner"), "SKILL.md") },
      ],
    },
  ]) {
    await writeFile(provenance, JSON.stringify(document))
    const result = await f.run(
      revalidateLocalInventoryEntity(original.inventory_id, entity.entity_id).pipe(Effect.result),
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure")
      expect(["INVENTORY_REVIEW_STALE", "INVENTORY_ENTITY_INCOMPLETE"]).toContain(
        result.failure.code,
      )
  }
  await writeFile(provenance, "{invalid json")
  const invalid = await f.run(
    revalidateLocalInventoryEntity(original.inventory_id, entity.entity_id).pipe(Effect.result),
  )
  expect(invalid._tag).toBe("Failure")
  await unlink(provenance)
  const missing = await f.run(
    revalidateLocalInventoryEntity(original.inventory_id, entity.entity_id).pipe(Effect.result),
  )
  expect(missing._tag).toBe("Failure")
  expect(f.ledger).toHaveLength(0)
})

test("changing a selected discovery mode invalidates an unchanged file manifest", async () => {
  const { f, root, provenance, scan } = await fixture()
  const assets = join(root, ".ak", "assets.yaml")
  const config = (name: string) =>
    `assets:\n  skills:\n    name: ${name}\n    path: skills\n    layout: skill-dir\n`
  await writeFile(assets, config("manual"))
  const original = await scan([provenance, assets])
  const entity = original.entities[0]!
  await writeFile(assets, config("auto"))
  const current = await scan([provenance, assets])
  expect(current.entities[0]?.manifest_sha256).toBe(entity.manifest_sha256)
  const result = await f.run(
    revalidateLocalInventoryEntity(original.inventory_id, entity.entity_id).pipe(Effect.flip),
  )
  expect(result.code).toBe("INVENTORY_REVIEW_STALE")
  expect(f.ledger).toHaveLength(0)
})

async function installReviewFixture(assetSuffix = "") {
  const context = await fixture()
  const install = join(context.root, ".ak", "install-sources.json")
  const assets = join(context.root, ".ak", "assets.yaml")
  const assetText =
    "assets:\n  skills:\n    name: manual\n    path: skills\n    layout: skill-dir\n" + assetSuffix
  await writeFile(assets, assetText)
  const opaque = {
    type: "local",
    installedName: "other",
    mode: "manual",
    source: "/unchanged/source",
  }
  const git = {
    type: "git",
    installedName: "retired",
    mode: "manual",
    source: "owner/repo",
    resolvedRef: "a".repeat(40),
    sourcePath: "skills/retired",
  }
  const before = JSON.stringify({ version: 1, skills: { other: opaque, retired: git } })
  await writeFile(install, before)
  const original = await context.scan([assets, install])
  const { inventory_id: unused, ...report } = original
  const legacy = {
    ...report,
    provenance: report.provenance.map(
      ({
        unresolved_install_claims_sha256: unused,
        assets_skills_sha256: unusedAssets,
        ...entry
      }) => entry,
    ),
  }
  const legacyId = await context.f.run(saveInventoryArtifact("local", legacy))
  await writeFile(install, JSON.stringify({ version: 1, skills: { other: opaque } }))
  return {
    ...context,
    install,
    assets,
    assetText,
    opaque,
    before,
    original,
    legacy,
    legacyId,
    proof: { version: 1, documents: [{ path: install, text: before }] },
    entity: original.entities[0]!,
  }
}

test("unchanged complete opaque install claims survive unrelated valid retirements", async () => {
  const x = await installReviewFixture()
  const checked = await x.f.run(
    revalidateLocalInventoryEntity(x.original.inventory_id, x.entity.entity_id),
  )
  expect(checked.entity).toEqual(x.entity)
  expect(checked.provenance_review_id).toMatch(/^inventory-provenance-review-[a-f0-9]{64}$/u)
  const before = await x.f.run(readLocalSkillInventory(x.original.inventory_id))
  expect(
    before.provenance.find((entry) => entry.path === x.install)?.unresolved_install_claims_sha256,
  ).toMatch(/^[a-f0-9]{64}$/u)
  expect(x.f.ledger).toHaveLength(0)
})

test("legacy opaque findings require an exact original whole-file preimage without rewriting the inventory", async () => {
  const x = await installReviewFixture()
  const missing = await x.f.run(
    revalidateLocalInventoryEntity(x.legacyId, x.entity.entity_id).pipe(Effect.flip),
  )
  expect(missing.code).toBe("INVENTORY_REVIEW_STALE")
  const checked = await x.f.run(
    revalidateLocalInventoryEntity(x.legacyId, x.entity.entity_id, x.proof),
  )
  expect(checked.entity).toEqual(x.entity)
  expect(checked.provenance_review_id).toMatch(/^inventory-provenance-review-[a-f0-9]{64}$/u)
  expect(await x.f.run(readLocalSkillInventory(x.legacyId))).toEqual(x.legacy)
  for (const proof of [
    { ...x.proof, documents: [{ path: x.install, text: x.before + "\n" }] },
    { ...x.proof, documents: [...x.proof.documents, ...x.proof.documents] },
    { ...x.proof, documents: [{ path: join(x.root, "unapproved.json"), text: x.before }] },
  ]) {
    const rejected = await x.f.run(
      revalidateLocalInventoryEntity(x.legacyId, x.entity.entity_id, proof).pipe(Effect.flip),
    )
    expect(rejected.code).toBe("INVENTORY_PROVENANCE_PROOF_INVALID")
  }
  expect(x.f.ledger).toHaveLength(0)
})

test("opaque proof rejects changed keys, full rows, membership, assets and parsed selected identity", async () => {
  const x = await installReviewFixture()
  for (const skills of [
    { sample: x.opaque },
    { other: { ...x.opaque, source: "/different/source" } },
    { other: x.opaque, added: { ...x.opaque, installedName: "added" } },
    {},
    {
      other: x.opaque,
      sample: {
        type: "git",
        installedName: "sample",
        mode: "manual",
        source: "owner/repo",
        resolvedRef: "b".repeat(40),
        sourcePath: "skills/sample",
      },
    },
  ]) {
    await writeFile(x.install, JSON.stringify({ version: 1, skills }))
    const result = await x.f.run(
      revalidateLocalInventoryEntity(x.legacyId, x.entity.entity_id, x.proof).pipe(Effect.result),
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure.code).toBe("INVENTORY_REVIEW_STALE")
  }
  await writeFile(x.install, JSON.stringify({ version: 1, skills: { other: x.opaque } }))
  await writeFile(x.assets, x.assetText + "# changed context\n")
  const contextChanged = await x.f.run(
    revalidateLocalInventoryEntity(x.legacyId, x.entity.entity_id, x.proof).pipe(Effect.flip),
  )
  expect(contextChanged.code).toBe("INVENTORY_REVIEW_STALE")
  await writeFile(x.install, x.before)
  const onlyContextChanged = await x.f.run(
    revalidateLocalInventoryEntity(x.legacyId, x.entity.entity_id, x.proof).pipe(Effect.flip),
  )
  expect(onlyContextChanged.code).toBe("INVENTORY_REVIEW_STALE")
  expect(x.f.ledger).toHaveLength(0)
})

test("a file alias cannot substitute differently named assets before opaque provenance review", async () => {
  const x = await installReviewFixture()
  const alias = join(x.root, "mode-config.yaml")
  await symlink(x.assets, alias)
  const scanned = await x.scan([alias, x.install])
  expect(scanned.coverage).toBe("partial")
  expect(scanned.provenance.find((entry) => entry.path === alias)?.status).toBe("unavailable")
  const refused = await x.f.run(
    revalidateLocalInventoryEntity(scanned.inventory_id, x.entity.entity_id).pipe(Effect.flip),
  )
  expect(refused.code).toBe("INVENTORY_ENTITY_INCOMPLETE")
  expect(x.f.ledger).toHaveLength(0)
})

const mirrorMapping =
  "mirrors:\n  ai-coding-os-goal-proof:\n    assets:\n      skills:\n        mappings:\n          goal-proof: experiments/goal-proof/skill\n"

test("exact assets preimage permits only mirror retirement outside the complete skills configuration", async () => {
  const x = await installReviewFixture(mirrorMapping)
  await writeFile(
    x.assets,
    x.assetText.replace(
      "mappings:\n          goal-proof: experiments/goal-proof/skill",
      "mappings: {}",
    ),
  )
  const missingAssets = await x.f.run(
    revalidateLocalInventoryEntity(x.legacyId, x.entity.entity_id, x.proof).pipe(Effect.flip),
  )
  expect(missingAssets.code).toBe("INVENTORY_REVIEW_STALE")
  const proof = {
    ...x.proof,
    documents: [...x.proof.documents, { path: x.assets, text: x.assetText }],
  }
  const checked = await x.f.run(
    revalidateLocalInventoryEntity(x.legacyId, x.entity.entity_id, proof),
  )
  expect(checked.entity).toEqual(x.entity)
  expect(await x.f.run(readLocalSkillInventory(x.legacyId))).toEqual(x.legacy)
  const review = await x.f.run(
    Effect.flatMap(Store, (store) =>
      store.readJson(
        `inventory/provenance-reviews/${checked.provenance_review_id}.json`,
        Schema.Unknown,
      ),
    ),
  )
  expect(property(review).asset_configuration_reviews).toEqual([
    {
      path: x.assets,
      original_sha256: x.original.provenance.find((entry) => entry.path === x.assets)?.sha256,
      current_sha256: expect.any(String),
      assets_skills_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      original_evidence: "exact_original_file",
    },
  ])
  expect(property(review).unchanged_assets).toEqual([])
  const retained = await x.f.run(
    revalidateLocalInventoryEntity(x.original.inventory_id, x.entity.entity_id),
  )
  expect(retained.entity).toEqual(x.entity)
  expect(x.f.ledger).toHaveLength(0)
})

test("asset context review refuses changed roots, unknown skill fields and wrong original bytes", async () => {
  const x = await installReviewFixture(mirrorMapping)
  const proof = {
    ...x.proof,
    documents: [...x.proof.documents, { path: x.assets, text: x.assetText }],
  }
  for (const current of [
    x.assetText.replace("name: manual", "name: auto"),
    x.assetText.replace(
      "layout: skill-dir",
      "layout: skill-dir\n    unknown_install_context: changed",
    ),
    x.assetText.replace(
      "layout: skill-dir",
      "layout: skill-dir\n    roots:\n      - name: other\n        path: other-skills\n        layout: skill-dir",
    ),
  ]) {
    await writeFile(x.assets, current)
    const refused = await x.f.run(
      revalidateLocalInventoryEntity(x.legacyId, x.entity.entity_id, proof).pipe(Effect.result),
    )
    expect(refused._tag).toBe("Failure")
    if (refused._tag === "Failure") expect(refused.failure.code).toBe("INVENTORY_REVIEW_STALE")
  }
  await writeFile(x.assets, x.assetText + "# presentation only\n")
  const wrong = await x.f.run(
    revalidateLocalInventoryEntity(x.legacyId, x.entity.entity_id, {
      ...proof,
      documents: [...x.proof.documents, { path: x.assets, text: x.assetText + "\n" }],
    }).pipe(Effect.flip),
  )
  expect(wrong.code).toBe("INVENTORY_PROVENANCE_PROOF_INVALID")
  expect(x.f.ledger).toHaveLength(0)
})

test("stable handoffs require the exact library and Skill and cannot authorize a replacement create", async () => {
  const { f, provenance, scan } = await fixture()
  const audit = await f.run(
    runSharedAudit({
      entry: library.skills.database_id,
      selector: { kind: "library" },
      depth: "content",
    }),
  )
  const remote = await f.run(prepareSharedBaselineInventory(audit.run_id))
  f.clearLedger()
  for (const libraryId of [library.library_id, "foreign-library"]) {
    await writeFile(
      provenance,
      JSON.stringify({
        version: 1,
        skills: [
          {
            name: "sample",
            path: "skills/sample",
            ref: fileRef(sharedSkillId(libraryId, "stable-skill"), "SKILL.md"),
          },
        ],
      }),
    )
    const local = await scan()
    const entity = local.entities[0]!
    expect(entity.classification).toBe("managed_candidate")
    expect(entity.identities[0]).toMatchObject({
      library_id: libraryId,
      skill_id: "stable-skill",
      page_id: null,
    })
    const reconciled = await f.run(
      reconcileSkillInventories({
        remote_inventory_id: remote.inventory_id,
        local_inventory_id: local.inventory_id,
      }),
    )
    expect(reconciled.matches[0]?.remote_page_id).toBe(
      libraryId === library.library_id ? skillPage : null,
    )
    const prepared = await f.run(
      prepareInventoryImport({
        library,
        reconciliationId: reconciled.inventory_id,
        entityId: entity.entity_id,
        approvedManifest: entity.manifest_sha256,
        decision: { kind: "native" },
      }).pipe(Effect.provide(NodeServices.layer), Effect.result),
    )
    expect(prepared._tag).toBe("Failure")
    if (prepared._tag === "Failure")
      expect(prepared.failure.code).toBe("INVENTORY_EXISTING_REVIEW_REQUIRED")
  }
  expect(
    f.ledger.every(
      (entry) =>
        entry.method === "GET" ||
        (entry.method === "POST" && /^v1\/data_sources\/[^/]+\/query(?:\?|$)/u.test(entry.path)),
    ),
  ).toBe(true)
})
