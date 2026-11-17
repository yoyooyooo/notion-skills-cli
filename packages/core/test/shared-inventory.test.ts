// Initialize the existing registration/schema cycle for this standalone fixture,
// rather than relying on a different test file having loaded it first.
import "../src/shared-source-registration.ts"
import { expect, test } from "bun:test"
import {
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  chmod,
  readFile,
  lstat,
  realpath,
  unlink,
} from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import {
  scanLocalSkillInventory,
  prepareSharedBaselineInventory,
  reconcileSkillInventories,
  revalidateLocalInventoryEntity,
  reviewInventoryReconciliation,
} from "../src/shared-inventory.ts"
import { runSharedAudit } from "../src/shared-audit.ts"
import { readAuditRun, saveAuditRun } from "../src/shared-audit-store.ts"
import { property, text } from "../src/model.ts"
import { auditFixture } from "./shared-audit-fixture.ts"
import { id, library, rich, skillPage } from "./shared-snapshot-fixture.ts"

async function localFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ntn-inventory-test-")))
  const repository = join(root, "repo"),
    skills = join(repository, "skills"),
    skill = join(skills, "group", "sample")
  await mkdir(join(skill, "scripts"), { recursive: true })
  await mkdir(join(repository, ".ak"))
  await writeFile(join(skill, "SKILL.md"), "# Native main\n")
  await writeFile(join(skill, "scripts", "tool.bin"), new Uint8Array([0, 255, 13, 10, 1]))
  await chmod(join(skill, "scripts", "tool.bin"), 0o755)
  return { root, repository, skills, skill }
}

test("local inventory deduplicates exact real aliases, preserves binary modes, and changes no source bytes or links", async () => {
  const f = await auditFixture(1),
    local = await localFixture()
  const hosts = join(local.root, "host")
  await mkdir(hosts)
  await symlink(local.skill, join(hosts, "one"))
  await symlink(local.skill, join(hosts, "two"))
  const before = await lstat(join(hosts, "one"), { bigint: true })
  const first = await f.run(
    scanLocalSkillInventory({ roots: [local.skills, hosts], allow_targets: [local.skills] }),
  )
  expect(first.coverage).toBe("full")
  expect(first.entities).toHaveLength(1)
  expect(first.entities[0]?.aliases).toEqual(
    expect.arrayContaining([local.skill, join(hosts, "one"), join(hosts, "two")]),
  )
  expect(first.entities[0]?.files.find((file) => file.path === "scripts/tool.bin")?.mode).toBe(
    "100755",
  )
  expect(first.entities[0]?.files.find((file) => file.path === "scripts/tool.bin")?.bytes).toBe(5)
  expect(new Uint8Array(await readFile(join(local.skill, "scripts", "tool.bin")))).toEqual(
    new Uint8Array([0, 255, 13, 10, 1]),
  )
  expect((await lstat(join(hosts, "one"), { bigint: true })).mtimeNs).toBe(before.mtimeNs)
  const repeated = await f.run(
    scanLocalSkillInventory({ roots: [hosts, local.skills], allow_targets: [local.skills] }),
  )
  expect(repeated.manifest_id).toBe(first.manifest_id)
  expect(f.ledger).toHaveLength(0)
  expect(first.source_writes).toBe(0)
})

test("local inventory prefers the root Skill entrypoint while retaining Prompt, Router and nested resources", async () => {
  const f = await auditFixture(1),
    local = await localFixture()
  await writeFile(join(local.skill, "PROMPT.md"), "# Demo prompts\r\n")
  await writeFile(join(local.skill, "ROUTER.md"), "# Supporting router\n")
  await mkdir(join(local.skill, "nested"))
  await writeFile(join(local.skill, "nested", "SKILL.md"), "# Nested resource\n")
  const report = await f.run(scanLocalSkillInventory({ roots: [local.skills] }))
  expect(report.entities).toHaveLength(1)
  const entity = report.entities[0]!
  expect(entity.main).toBe("SKILL.md")
  expect(entity.files.map((file) => file.path)).toEqual([
    "nested/SKILL.md",
    "PROMPT.md",
    "ROUTER.md",
    "scripts/tool.bin",
    "SKILL.md",
  ])
  expect(entity.files.find((file) => file.path === "scripts/tool.bin")?.mode).toBe("100755")
  expect(await readFile(join(local.skill, "PROMPT.md"), "utf8")).toBe("# Demo prompts\r\n")
  expect(report.source_writes).toBe(0)
  expect(f.ledger).toHaveLength(0)
})

test("local inventory keeps Prompt and Router fallback and never promotes a nested Skill past a parent entrypoint", async () => {
  const f = await auditFixture(1)
  for (const paths of [
    ["PROMPT.md"],
    ["ROUTER.md"],
    ["PROMPT.md", "ROUTER.md"],
    ["PROMPT.md", "nested/SKILL.md"],
  ]) {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ntn-inventory-main-")))
    for (const path of paths) {
      await mkdir(join(root, path, ".."), { recursive: true })
      await writeFile(join(root, path), `# ${path}\n`)
    }
    const report = await f.run(scanLocalSkillInventory({ roots: [root] }))
    expect(report.entities).toHaveLength(1)
    expect(report.entities[0]?.main).toBe(paths[0]!)
    expect(report.entities[0]?.files.map((file) => file.path).sort()).toEqual([...paths].sort())
    expect(report.source_writes).toBe(0)
  }
  expect(f.ledger).toHaveLength(0)
})

test("outside/broken symlinks, secrets and finite budgets stay explicit without reading secret values into reports", async () => {
  const f = await auditFixture(1),
    local = await localFixture()
  const outside = join(local.root, "outside")
  await mkdir(outside)
  await writeFile(join(outside, "SKILL.md"), "Private outside body")
  await symlink(outside, join(local.skill, "outside"))
  await symlink(join(local.root, "missing"), join(local.skill, "broken"))
  const secret = "ghp_" + "a".repeat(40)
  await writeFile(join(local.skill, ".env"), `TOKEN=${secret}\n`)
  const report = await f.run(scanLocalSkillInventory({ roots: [local.skills] }))
  expect(report.coverage).toBe("partial")
  expect(report.findings.some((finding) => finding.code === "SYMLINK_OUTSIDE_SCOPE")).toBe(true)
  expect(report.findings.some((finding) => finding.code === "BROKEN_SYMLINK")).toBe(true)
  expect(report.entities[0]?.files.some((file) => file.path.includes("outside"))).toBe(false)
  expect(JSON.stringify(report)).not.toContain(secret)
  expect(report.entities[0]?.files.find((file) => file.path === ".env")?.sensitive).toBe(true)
  const bounded = await f.run(
    scanLocalSkillInventory({ roots: [local.skills], budget: { entries: 2 } }),
  )
  expect(bounded.coverage).toBe("partial")
  expect(bounded.metrics.entries).toBe(2)
  expect(bounded.metrics.limit).toBe("entries")
  const bytes = await f.run(
    scanLocalSkillInventory({ roots: [local.skills], budget: { bytes: 1 } }),
  )
  expect(bytes.coverage).toBe("partial")
  expect(bytes.metrics.bytes).toBeLessThanOrEqual(2)
})

test("exact env example templates preserve empty credentials, bounded timeouts, original bytes and modes", async () => {
  const f = await auditFixture(1),
    local = await localFixture(),
    path = join(local.skill, ".env.example"),
    template =
      "# Optional settings\r\n# PASSWORD=\r\nSERVICE_USER=\r\nSERVICE_PASSWORD=\r\nSERVICE_TOKEN=\r\nSERVICE_WAIT_SECONDS=10\r\nSERVICE_TIMEOUT_SECONDS=60\r\n"
  for (const [permissions, mode] of [
    [0o644, "100644"],
    [0o755, "100755"],
  ] as const) {
    await writeFile(path, template)
    await chmod(path, permissions)
    const report = await f.run(scanLocalSkillInventory({ roots: [local.skill] }))
    expect(report.coverage).toBe("full")
    expect(report.entities[0]!.files.find((file) => file.path === ".env.example")).toMatchObject({
      status: "verified",
      sensitive: false,
      mode,
      bytes: Buffer.byteLength(template),
      sha256: createHash("sha256").update(template).digest("hex"),
    })
    expect(await readFile(path, "utf8")).toBe(template)
    expect(report.source_writes).toBe(0)
  }
  expect(f.ledger).toHaveLength(0)
})

test("env example recognition rejects numeric credentials, other names, unsupported syntax and embedded secret signatures", async () => {
  const f = await auditFixture(1),
    local = await localFixture(),
    syntheticSecret = "ghp_" + "x".repeat(40)
  const cases: readonly (readonly [string, string | Uint8Array])[] = [
    [".env", "SERVICE_PASSWORD=\nSERVICE_TIMEOUT_SECONDS=10\n"],
    [".env.local", "SERVICE_PASSWORD=\n"],
    [".env.example.local", "SERVICE_PASSWORD=\n"],
    [".ENV.EXAMPLE", "SERVICE_PASSWORD=\n"],
    [".env.example", "PASSWORD=123456\n"],
    [".env.example", "API_KEY=123456\n"],
    [".env.example", "TOKEN=123456\n"],
    [".env.example", "# PASSWORD=123456\nSERVICE_TIMEOUT_SECONDS=10\n"],
    [".env.example", "PASSWORD_TIMEOUT_SECONDS=10\n"],
    [".env.example", "API_KEY_WAIT_SECONDS=10\n"],
    [".env.example", "ACCESS_TOKEN_TIMEOUT_SECONDS=10\n"],
    [".env.example", "SERVICE_TIMEOUT_SECONDS=86401\n"],
    [".env.example", "SERVICE_TIMEOUT_SECONDS=99999999999999999999\n"],
    [".env.example", "SERVICE_TIMEOUT_SECONDS=-1\n"],
    [".env.example", "SERVICE_TIMEOUT_SECONDS=1.5\n"],
    [".env.example", "SERVICE_TIMEOUT_SECONDS=1e2\n"],
    [".env.example", "SERVICE_TOKEN=synthetic-private-value\n"],
    [".env.example", 'SERVICE_TIMEOUT_SECONDS="10"\n'],
    [".env.example", "SERVICE_TIMEOUT_SECONDS=${VALUE}\n"],
    [".env.example", "SERVICE_TIMEOUT_SECONDS=$(printf 10)\n"],
    [".env.example", "export SERVICE_TIMEOUT_SECONDS=10\n"],
    [".env.example", "SERVICE_TIMEOUT_SECONDS=10 # inline comments are outside this grammar\n"],
    [".env.example", "SERVICE_TIMEOUT_SECONDS=10\nSERVICE_TIMEOUT_SECONDS=20\n"],
    [".env.example", "SERVICE_PASSWORD=\rSERVICE_TIMEOUT_SECONDS=10\n"],
    [".env.example", "# bad control \u0000\nSERVICE_PASSWORD=\n"],
    [".env.example", new Uint8Array([0x23, 0xff, 0x0a])],
    [".env.example", `# ${syntheticSecret}\nSERVICE_PASSWORD=\n`],
  ]
  for (const [name, body] of cases) {
    const path = join(local.skill, name)
    await writeFile(path, body)
    const report = await f.run(scanLocalSkillInventory({ roots: [local.skill] }))
    expect(report.coverage, name).toBe("partial")
    expect(report.entities[0]!.files.find((file) => file.path === name)?.sensitive, name).toBe(true)
    expect(
      report.findings.some((finding) => finding.code === "SENSITIVE_CONTENT_REQUIRES_REVIEW"),
    ).toBe(true)
    expect(JSON.stringify(report)).not.toContain(syntheticSecret)
    await unlink(path)
  }
  expect(f.ledger).toHaveLength(0)
})

test("safe env examples use the original whole-entity revalidation and reject byte, mode or credential drift", async () => {
  const f = await auditFixture(1),
    local = await localFixture(),
    path = join(local.skill, ".env.example"),
    original = "SERVICE_PASSWORD=\nSERVICE_TIMEOUT_SECONDS=10\n"
  await writeFile(path, original)
  await chmod(path, 0o644)
  const report = await f.run(scanLocalSkillInventory({ roots: [local.skill] }))
  expect(report.coverage).toBe("full")
  const entity = report.entities[0]!
  const unchanged = await f.run(
    revalidateLocalInventoryEntity(report.inventory_id, entity.entity_id),
  )
  expect(unchanged.entity.manifest_sha256).toBe(entity.manifest_sha256)
  for (const body of [
    original.replace("10", "11"),
    "SERVICE_PASSWORD=123456\nSERVICE_TIMEOUT_SECONDS=10\n",
  ]) {
    await writeFile(path, body)
    const refused = await f.run(
      revalidateLocalInventoryEntity(report.inventory_id, entity.entity_id).pipe(Effect.flip),
    )
    expect(refused.code).toBe(
      body.includes("123456") ? "INVENTORY_ENTITY_INCOMPLETE" : "INVENTORY_REVIEW_STALE",
    )
  }
  await writeFile(path, original)
  await chmod(path, 0o755)
  const mode = await f.run(
    revalidateLocalInventoryEntity(report.inventory_id, entity.entity_id).pipe(Effect.flip),
  )
  expect(mode.code).toBe("INVENTORY_REVIEW_STALE")
  expect(entity.files.find((file) => file.path === ".env.example")?.mode).toBe("100644")
  expect(f.ledger).toHaveLength(0)
})

test("exact handoff identity reconciles while equal names or hashes cannot acquire management authority", async () => {
  const f = await auditFixture(1),
    local = await localFixture()
  const audit = await f.run(
    runSharedAudit({
      entry: library.skills.database_id,
      selector: { kind: "library" },
      depth: "content",
    }),
  )
  f.clearLedger()
  const remote = await f.run(prepareSharedBaselineInventory(audit.run_id))
  const plain = await f.run(scanLocalSkillInventory({ roots: [local.skills] }))
  const unbound = await f.run(
    reconcileSkillInventories({
      remote_inventory_id: remote.inventory_id,
      local_inventory_id: plain.inventory_id,
    }),
  )
  expect(unbound.matches[0]?.authority).toBe("unestablished")
  const provenance = join(local.repository, ".ak", "notion-handoffs.json")
  await writeFile(
    provenance,
    JSON.stringify({
      version: 1,
      skills: [
        {
          name: "sample",
          path: "skills/group/sample",
          ref: `skill://${skillPage}/SKILL.md`,
          aliases: ["sample"],
        },
      ],
    }),
  )
  const managed = await f.run(
    scanLocalSkillInventory({ roots: [local.skills], provenance_files: [provenance] }),
  )
  const matched = await f.run(
    reconcileSkillInventories({
      remote_inventory_id: remote.inventory_id,
      local_inventory_id: managed.inventory_id,
    }),
  )
  expect(matched.matches[0]?.authority).toBe("exact_page_identity")
  expect(matched.matches[0]?.remote_page_id).toBe(skillPage)
  expect(matched.matches[0]?.classification).toBe("managed_local_changes")
  expect(f.ledger).toHaveLength(0)
  await f.run(
    reviewInventoryReconciliation(matched.inventory_id, {
      remote_inventory_id: remote.inventory_id,
      local_inventory_id: managed.inventory_id,
    }),
  )
  await writeFile(join(local.skill, "SKILL.md"), "Changed after approval\n")
  const stale = await f.run(
    revalidateLocalInventoryEntity(managed.inventory_id, managed.entities[0]!.entity_id).pipe(
      Effect.flip,
    ),
  )
  expect(stale.code).toBe("INVENTORY_REVIEW_STALE")
  const changed = await f.run(
    scanLocalSkillInventory({ roots: [local.skills], provenance_files: [provenance] }),
  )
  const review = await f.run(
    reviewInventoryReconciliation(matched.inventory_id, {
      remote_inventory_id: remote.inventory_id,
      local_inventory_id: changed.inventory_id,
    }).pipe(Effect.flip),
  )
  expect(review.code).toBe("INVENTORY_REVIEW_STALE")
})

test("baseline identity ignores transport request IDs, retains anomalies and never releases custom ownership", async () => {
  const f = await auditFixture(1)
  const report = await f.run(
    runSharedAudit({
      entry: library.skills.database_id,
      selector: { kind: "library" },
      depth: "content",
    }),
  )
  const first = await f.run(prepareSharedBaselineInventory(report.run_id))
  expect(first.resources[0]?.automatic_candidate).toBe(false)
  expect(first.resources[0]?.classification).toBe("custom")
  const original = await f.run(readAuditRun(report.run_id))
  await f.run(
    saveAuditRun({
      ...original,
      inventory: {
        ...original.inventory,
        skills: original.inventory.skills.map((row) => ({
          ...property(row),
          request_id: "another-transport",
        })),
      },
    }),
  )
  const second = await f.run(prepareSharedBaselineInventory(report.run_id))
  expect(second.plan_id).toBe(first.plan_id)
  expect(second.resources[0]?.metadata_sha256).toBe(first.resources[0]?.metadata_sha256)
  expect(first.remote_writes).toBe(0)
})

test("Git dirty observation is readonly and does not refresh the index", async () => {
  const f = await auditFixture(1),
    local = await localFixture(),
    git = promisify(execFile)
  await git("git", ["init", "--quiet", local.repository])
  await git("git", ["-C", local.repository, "add", "skills"])
  await git("git", [
    "-C",
    local.repository,
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "user.name=Inventory test",
    "commit",
    "--quiet",
    "-m",
    "controlled fixture",
  ])
  const index = await readFile(join(local.repository, ".git", "index"))
  await writeFile(join(local.skill, "SKILL.md"), "Dirty local custom\r\n")
  const report = await f.run(scanLocalSkillInventory({ roots: [local.skills] }))
  expect(report.entities[0]?.git.dirty).toBe(true)
  expect(report.entities[0]?.findings.some((finding) => finding.code === "GIT_DIRTY")).toBe(true)
  expect(await readFile(join(local.repository, ".git", "index"))).toEqual(index)
  expect(report.entities[0]?.git.head).toMatch(/^[a-f0-9]{40}$/u)
})

test("equal native bytes with unknown remote mode require review and equal unbound trees acquire no authority", async () => {
  const f = await auditFixture(1),
    local = await localFixture()
  const root = join(local.root, "same-bytes"),
    managed = join(root, "managed"),
    unbound = join(root, "unbound")
  await mkdir(managed, { recursive: true })
  await mkdir(unbound)
  await writeFile(join(managed, "SKILL.md"), "# Native main\n")
  await writeFile(join(unbound, "SKILL.md"), "# Native main\n")
  const provenance = join(local.repository, ".ak", "identity.json")
  await writeFile(
    provenance,
    JSON.stringify({
      version: 1,
      kind: "ntn_skill_inventory_identity",
      entries: [{ path: managed, identity: { page_id: skillPage } }],
    }),
  )
  const audit = await f.run(
    runSharedAudit({
      entry: library.skills.database_id,
      selector: { kind: "library" },
      depth: "content",
    }),
  )
  const remote = await f.run(prepareSharedBaselineInventory(audit.run_id))
  expect(remote.resources[0]?.files[0]?.current_mode).toBeNull()
  expect(remote.coverage).toBe("partial")
  expect(remote.visible_registered_census?.coverage).toBe("full")
  f.clearLedger()
  const scanned = await f.run(
    scanLocalSkillInventory({ roots: [root], provenance_files: [provenance] }),
  )
  const result = await f.run(
    reconcileSkillInventories({
      remote_inventory_id: remote.inventory_id,
      local_inventory_id: scanned.inventory_id,
    }),
  )
  const exact = result.matches.find((match) => match.real_root === managed)
  expect(exact?.classification).toBe("managed_review_required")
  expect(exact?.reasons).toContain("remote_mode_unestablished")
  expect(property(exact?.files[0]).comparison).toBe("bytes_equal_mode_unestablished")
  const similar = result.matches.find((match) => match.real_root === unbound)
  expect(similar?.authority).toBe("unestablished")
  expect(similar?.remote_page_id).toBeNull()
  expect(similar?.candidates).toContainEqual({
    page_id: skillPage,
    reason: "same_bytes_do_not_establish_authority",
  })
  expect(f.ledger).toHaveLength(0)
})

test("configured view origins remain separate owners and canonical collisions stay blocked", async () => {
  const f = await auditFixture(1),
    local = await localFixture()
  const assets = join(local.repository, ".ak", "assets.yaml")
  const view = join(local.repository, ".ak", "state", "views", "default", "skills", "sample")
  await mkdir(join(view, "scripts"), { recursive: true })
  await writeFile(join(view, "SKILL.md"), await readFile(join(local.skill, "SKILL.md")))
  await writeFile(
    join(view, "scripts", "tool.bin"),
    await readFile(join(local.skill, "scripts", "tool.bin")),
  )
  await chmod(join(view, "scripts", "tool.bin"), 0o755)
  await writeFile(
    assets,
    JSON.stringify({
      version: 1,
      assets: {
        skills: {
          name: "auto",
          path: "skills/group",
          layout: "skill-dir",
          roots: [{ name: "manual", path: "skills/manual", layout: "skill-dir" }],
        },
      },
    }),
  )
  const first = await f.run(
    scanLocalSkillInventory({ roots: [local.skills, view], provenance_files: [assets] }),
  )
  expect(first.entities).toHaveLength(2)
  const derived = first.entities.find((entity) => entity.real_root === view)
  expect(derived?.classification).toBe("derived_projection")
  expect(derived?.derived_origin?.body_comparison).toBe("exact")
  expect(derived?.derived_origin?.candidate_entity_ids).toHaveLength(1)
  expect(derived?.identities).toEqual([])
  expect(
    derived?.findings.some((finding) => finding.code === "DERIVED_VIEW_AUTHORITY_UNESTABLISHED"),
  ).toBe(true)
  await mkdir(join(local.skills, "manual", "sample"), { recursive: true })
  await writeFile(join(local.skills, "manual", "sample", "SKILL.md"), "Another physical owner\n")
  const conflicting = await f.run(
    scanLocalSkillInventory({ roots: [local.skills, view], provenance_files: [assets] }),
  )
  expect(conflicting.entities).toHaveLength(3)
  expect(conflicting.coverage).toBe("partial")
  expect(
    conflicting.findings.filter((finding) => finding.code === "CANONICAL_NAME_CONFLICT"),
  ).toHaveLength(2)
  expect(
    conflicting.entities.find((entity) => entity.real_root === view)?.derived_origin
      ?.body_comparison,
  ).toBe("unobserved")
  expect(f.ledger).toHaveLength(0)
})

test("known native mode permits complete current equality while an uninspected census member stays partial", async () => {
  const f = await auditFixture(1)
  const envelope = [...f.records.values()]
    .map((row) => property(JSON.parse(text(property(property(row.properties).payload).rich_text))))
    .find((row) => property(row.payload).kind === "adopted")
  if (envelope === undefined) throw new Error("Expected native adoption fixture")
  const prior = property(envelope.payload)
  f.seedFact(
    {
      ...prior,
      event_id: "adopted-explicit-mode",
      parents: [prior.event_id],
      content: { ...property(prior.content), mode: "100644" },
    },
    "file_event",
    "file-main",
    "adopted-explicit-mode",
  )
  const complete = await f.run(
    runSharedAudit({
      entry: library.skills.database_id,
      selector: { kind: "skill", page_id: skillPage },
      depth: "content",
    }),
  )
  const initial = await f.run(prepareSharedBaselineInventory(complete.run_id))
  expect(initial.coverage).toBe("full")
  expect(initial.resources[0]?.files[0]?.current_mode).toBe("100644")
  expect(initial.resources[0]?.classification).toBe("custom")
  expect(initial.resources[0]?.automatic_candidate).toBe(false)
  const second = {
    ...structuredClone(f.main),
    id: id(90),
    properties: { ...property(f.main.properties), skill_id: rich("skill_id", "uninspected-skill") },
  }
  f.intercept((path) =>
    path.startsWith(`v1/data_sources/${library.skills.data_source_id}/query?`)
      ? Effect.succeed({
          object: "list",
          results: [f.main, second],
          has_more: false,
          next_cursor: null,
        })
      : undefined,
  )
  const target = await f.run(
    runSharedAudit({
      entry: library.skills.database_id,
      selector: { kind: "skill", page_id: skillPage },
      depth: "content",
    }),
  )
  expect(target.coverage).toBe("full")
  const broader = await f.run(prepareSharedBaselineInventory(target.run_id))
  expect(broader.resources).toHaveLength(1)
  expect(broader.inspection_scope).toBe("reachable_target")
  expect(broader.coverage).toBe("full")
  expect(broader.visible_registered_census?.coverage).toBe("partial")
  expect(broader.visible_registered_census?.required_tables).toEqual(["skills", "files", "records"])
  expect(broader.visible_registered_census?.reasons).toContain("initial_census_incomplete")
  expect(broader.resources.some((resource) => resource.page_id === id(90))).toBe(false)
  const census = await f.run(
    runSharedAudit({ entry: library.skills.database_id, selector: { kind: "census" } }),
  )
  const all = await f.run(prepareSharedBaselineInventory(census.run_id))
  expect(all.inspection_scope).toBe("registered_table_census")
  expect(all.resources).toHaveLength(2)
  expect(all.coverage).toBe("partial")
  expect(all.visible_registered_census?.coverage).toBe("full")
  expect(all.resources.find((resource) => resource.page_id === id(90))?.reasons).toContain(
    "resource_coverage_incomplete",
  )
})

test("declared provenance follows only observed parent aliases and revalidation freezes their targets", async () => {
  const f = await auditFixture(1),
    local = await localFixture()
  const alias = join(local.root, "logical-repository")
  await symlink(local.repository, alias)
  const declared = join(alias, "skills", "group", "sample")
  const provenance = join(local.repository, ".ak", "identity.json")
  await writeFile(
    provenance,
    JSON.stringify({
      version: 1,
      kind: "ntn_skill_inventory_identity",
      entries: [
        {
          path: declared,
          identity: {
            repository: "https://github.com/example/original",
            commit: "a".repeat(40),
            source_path: "skills/sample",
          },
        },
      ],
    }),
  )
  const first = await f.run(
    scanLocalSkillInventory({ roots: [join(alias, "skills")], provenance_files: [provenance] }),
  )
  expect(first.coverage).toBe("full")
  const entity = first.entities[0]!
  expect(entity.real_root).toBe(local.skill)
  expect(entity.aliases).toContain(declared)
  expect(entity.identities[0]).toMatchObject({
    repository: "https://github.com/example/original",
    commit: "a".repeat(40),
    declared_path: declared,
    evidence_file: provenance,
  })
  const checked = await f.run(revalidateLocalInventoryEntity(first.inventory_id, entity.entity_id))
  expect(checked.entity.identities).toEqual(entity.identities)
  const outside = join(local.root, "outside")
  await mkdir(join(outside, "skills", "group", "sample"), { recursive: true })
  await writeFile(join(outside, "skills", "group", "sample", "SKILL.md"), "Outside frozen target\n")
  await unlink(alias)
  await symlink(outside, alias)
  const stale = await f.run(
    revalidateLocalInventoryEntity(first.inventory_id, entity.entity_id).pipe(Effect.flip),
  )
  expect(stale.code).toBe("INVENTORY_REVIEW_STALE")
  expect(f.ledger).toHaveLength(0)
})

test("an explicit unobserved provenance declaration remains blocked instead of authorizing a native import", async () => {
  const f = await auditFixture(1),
    local = await localFixture()
  const provenance = join(local.repository, ".ak", "identity.json")
  await writeFile(
    provenance,
    JSON.stringify({
      version: 1,
      kind: "ntn_skill_inventory_identity",
      entries: [
        {
          path: join(local.root, "unobserved"),
          identity: { repository: "https://github.com/example/source", commit: "b".repeat(40) },
        },
      ],
    }),
  )
  const report = await f.run(
    scanLocalSkillInventory({ roots: [local.skills], provenance_files: [provenance] }),
  )
  expect(report.coverage).toBe("partial")
  expect(report.findings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: "PROVENANCE_PATH_UNESTABLISHED", severity: "blocked" }),
    ]),
  )
  expect(report.entities[0]?.identities).toEqual([])
  expect(f.ledger).toHaveLength(0)
})

test("metadata census proof rejects changed or unfinished final pages and missing endpoint proof", async () => {
  const f = await auditFixture(1)
  const report = await f.run(
    runSharedAudit({
      entry: library.skills.database_id,
      selector: { kind: "library" },
      depth: "metadata",
    }),
  )
  const original = await f.run(readAuditRun(report.run_id))
  const full = await f.run(prepareSharedBaselineInventory(report.run_id))
  expect(full.coverage).toBe("partial")
  expect(full.visible_registered_census).toMatchObject({
    coverage: "full",
    initial_complete: true,
    final_complete: true,
    stable: true,
    relations_complete: true,
    metadata_complete: true,
  })
  f.clearLedger()
  await f.run(
    saveAuditRun({
      ...original,
      census: {
        ...original.census,
        complete: original.census.complete.filter((table) => table !== "records"),
      },
    }),
  )
  const unfinished = await f.run(prepareSharedBaselineInventory(report.run_id))
  expect(unfinished.visible_registered_census).toMatchObject({
    coverage: "partial",
    final_complete: false,
    final_semantic_sha256: null,
    stable: false,
  })
  await f.run(saveAuditRun({ ...original, census: { ...original.census, skills: [] } }))
  const changed = await f.run(prepareSharedBaselineInventory(report.run_id))
  expect(changed.visible_registered_census).toMatchObject({
    coverage: "partial",
    initial_complete: true,
    final_complete: true,
    stable: false,
  })
  expect(changed.visible_registered_census?.reasons).toContain("census_not_stable")
  const withoutTags = original.inventory.skills.map((raw) => {
    const properties = { ...property(property(raw).properties) }
    delete properties.tags
    return { ...property(raw), properties }
  })
  await f.run(
    saveAuditRun({
      ...original,
      inventory: { ...original.inventory, skills: withoutTags },
      census: { ...original.census, skills: withoutTags },
    }),
  )
  const incompleteMetadata = await f.run(prepareSharedBaselineInventory(report.run_id))
  expect(incompleteMetadata.visible_registered_census).toMatchObject({
    coverage: "partial",
    metadata_complete: false,
    stable: true,
  })
  const { endpoint_scope, ...historical } = original
  expect(endpoint_scope).toBeDefined()
  await f.run(saveAuditRun(historical))
  const unbound = await f.run(prepareSharedBaselineInventory(report.run_id))
  expect(unbound.visible_registered_census).toMatchObject({
    coverage: "partial",
    endpoint_scope: null,
  })
  expect(unbound.visible_registered_census?.reasons).toContain("endpoint_identity_unestablished")
  expect(f.ledger).toHaveLength(0)
})
