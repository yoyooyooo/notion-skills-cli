import "../src/shared-source-registration.ts"
import { expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, realpath, symlink, unlink } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Effect } from "effect"
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
