import { expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { authScope } from "../src/catalog.ts"
import { applySkill } from "../src/mutation.ts"
import { property, text } from "../src/model.ts"
import { snapshotPortable } from "../src/export.ts"
import {
  portableFiles,
  portableZip,
  readPortable,
  portableRelationSelection,
} from "../src/portable.ts"
import { readImportZip } from "../src/import.ts"
import {
  applySourceRefresh,
  prepareRetainedSourceRefresh as prepareSourceRefresh,
  validateSourceRefresh,
} from "../src/shared-source-refresh.ts"
import { resolveSelectedSharedSource } from "../src/shared-selected-source.ts"
import { openSharedSnapshot } from "../src/shared-snapshot.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import {
  library,
  sourceRefreshFixture,
  relatedSkill,
  relation,
} from "./shared-source-refresh-fixture.ts"
import { digest, encode, id, rich, skillPage } from "./shared-snapshot-fixture.ts"

type Fixture = Awaited<ReturnType<typeof sourceRefreshFixture>>
async function current(f: Fixture) {
  const pin = text(property(property(f.main.properties).source).rich_text)
  const source = pin ? await f.run(resolveSelectedSharedSource(library, skillPage, pin)) : undefined
  return f.run(
    Effect.gen(function* () {
      return yield* openSharedSnapshot({
        library,
        target: skillPage,
        scope: yield* authScope,
        startedAt: Date.now(),
        forceFull: true,
        readOnly: true,
        ...(source
          ? {
              fixedSource: {
                source_id: source.source_id,
                revision: source.revision,
                files: source.files,
              },
            }
          : {}),
      })
    }),
  )
}
function propertiesExceptPin(f: Fixture) {
  return structuredClone(
    Object.fromEntries(
      Object.entries(property(f.main.properties)).filter(([key]) => key !== "source"),
    ),
  )
}
function evidence(name: string, value: unknown) {
  const root = process.env.NTN_NG07_EVIDENCE_DIR
  if (!root) return
  mkdirSync(root, { recursive: true, mode: 0o700 })
  writeFileSync(join(root, name + ".json"), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
}
function candidate(f: Fixture, key: string, name: string) {
  return {
    ...structuredClone(f.snapshot.members[0]!),
    member_key: key,
    source_path: key,
    portable: { ...structuredClone(f.snapshot.members[0]!.portable), name },
  }
}
function advance(f: Fixture, version: string, members: ReturnType<typeof candidate>[]) {
  Object.assign(f.snapshot, { revision: version.repeat(40), members })
  const root = f.snapshot.members.find((item) => item.member_key === "skills/demo")!
  Object.assign(root.portable, {
    files: root.portable.files.map((file) =>
      file.path === "assets/file.bin"
        ? { ...file, bytes: encode("upstream " + version) }
        : file.path === "SKILL.md"
          ? {
              ...file,
              bytes: encode(
                "---\nname: upstream\ndescription: upstream\nlicense: upstream-" +
                  version +
                  "\nupstream_version: " +
                  version +
                  "\n---\n\nChanged upstream main " +
                  version +
                  "\n",
              ),
            }
          : file,
    ),
  })
}

test("A to B to C keeps authored relation sets, metadata, custom files and exact old pins while reviewing source inventory", async () => {
  const f = await sourceRefreshFixture({
    nativeMain: "---\nlicense: LOCAL\naudience: Internal\n---\n\n# Custom owner body\n",
  })
  const p = property(f.main.properties)
  relatedSkill(f, id(91), "member-a", "A", "skills/a")
  relatedSkill(f, id(92), "member-b", "B", "skills/b")
  relatedSkill(f, id(93), "manual-member", "Manual member")
  relatedSkill(f, id(94), "required-old", "Existing required")
  relatedSkill(f, id(95), "required-new", "Manual required")
  p.members = relation("members", [id(91), id(92)])
  p.requires = relation("requires", [id(94)])
  p.tags = {
    id: "tags",
    type: "multi_select",
    multi_select: [{ id: "tag1", name: "Keep", color: "blue" }],
  }
  p["human-extra"] = rich("human-extra", "Only the author owns this")
  const sourceA = candidate(f, "skills/demo", "Managed Name")
  advance(f, "a", [sourceA, candidate(f, "skills/a", "A"), candidate(f, "skills/b", "B")])
  const planA = await f.run(prepareSourceRefresh(library, id(82), skillPage, f.acquire))
  expect(await f.run(applySourceRefresh(library, planA))).toMatchObject({
    status: "applied",
    verified: true,
  })
  const snapshotA = await current(f)
  const oldSnapshotBytes = canonicalSharedJson(
    f.json.get("snapshots/" + snapshotA.snapshot_id + ".json"),
  )
  p.members = relation("members", [id(92), id(93)])
  p.requires = relation("requires", [id(94), id(95)])
  const protectedProperties = propertiesExceptPin(f),
    bodies = new Map(f.bodies)
  const traces: unknown[] = []
  const plans = []
  for (const version of ["b", "c"]) {
    advance(f, version, [
      candidate(f, "skills/demo", "Upstream renamed " + version),
      candidate(f, "skills/a", "A"),
      candidate(f, "skills/new-" + version, "Candidate " + version),
    ])
    const plan = await f.run(prepareSourceRefresh(library, id(82), skillPage, f.acquire))
    expect(plan.member_review).toMatchObject({
      comparison: "current_origin_bindings",
      relation_ownership: "notion",
      relation_writes: false,
      added: [{ member_key: "skills/new-" + version }],
      missing: [{ member_key: "skills/b", page_id: id(92) }],
      renamed: [
        { member_key: "skills/demo", before: "Managed Name", after: "Upstream renamed " + version },
      ],
    })
    f.clearCalls()
    const result = await f.run(applySourceRefresh(library, plan))
    expect(result).toMatchObject({ status: "applied", verified: true, body_writes: 0 })
    expect(propertiesExceptPin(f)).toEqual(protectedProperties)
    expect(f.bodies).toEqual(bodies)
    const patches = f.calls
      .filter((call) => call.method === "PATCH")
      .map((call) => ({
        path: call.path,
        property_ids: Object.keys(property(property(call.body).properties)).sort(),
      }))
    expect(patches.filter((call) => call.path === "v1/pages/" + skillPage)).toEqual([
      { path: "v1/pages/" + skillPage, property_ids: ["source"] },
    ])
    expect(
      f.calls.some(
        (call) =>
          call.method === "PATCH" && /markdown|views|data_sources|databases/.test(call.path),
      ),
    ).toBe(false)
    const now = await current(f)
    const main = now.files.find((file) => file.path === "SKILL.md")!
    const markdown = new TextDecoder().decode(f.objects.get("objects/" + main.sha256))
    expect(markdown).toContain('"license": "LOCAL"')
    expect(markdown).toContain('"audience": "Internal"')
    expect(markdown).toContain("# Custom owner body")
    expect(markdown).toContain("Manual member")
    expect(markdown).not.toContain("member-a")
    const asset = now.files.find((file) => file.path === "assets/file.bin")!
    expect(asset.sha256).toBe(digest(encode("upstream " + version)))
    expect(canonicalSharedJson(f.json.get("snapshots/" + snapshotA.snapshot_id + ".json"))).toBe(
      oldSnapshotBytes,
    )
    const oldSource = await f.run(resolveSelectedSharedSource(library, skillPage, planA.bundle_id))
    expect(digest(oldSource.files.find((file) => file.path === "assets/file.bin")!.bytes)).toBe(
      digest(encode("upstream a")),
    )
    traces.push({
      version,
      patches,
      property_id_to_value: propertiesExceptPin(f),
      files: now.files,
      snapshot_id: now.snapshot_id,
      old_pin: planA.bundle_id,
      old_pin_files: oldSource.files.map((file) => ({
        path: file.path,
        sha256: digest(file.bytes),
      })),
    })
    plans.push({ plan_id: plan.plan_id, source_pin: plan.bundle_id, review: plan.member_review })
  }
  evidence("two-refresh-protection", {
    kind: "controlled_core",
    before: protectedProperties,
    plans,
    traces,
    native_body_hashes: [...bodies].map(([page, body]) => ({ page, sha256: digest(body) })),
  })
})

test("a relation edit concurrent with the Source-only PATCH survives without compare-and-swap claims", async () => {
  const f = await sourceRefreshFixture()
  relatedSkill(f, id(91), "manual-required", "Manual required")
  const plan = await f.run(prepareSourceRefresh(library, id(82), skillPage, f.acquire))
  f.hooks.beforeTargetPatch = () => {
    property(f.main.properties).requires = relation("requires", [id(91)])
  }
  f.clearCalls()
  expect(await f.run(applySourceRefresh(library, plan))).toMatchObject({ verified: true })
  expect(property(f.main.properties).requires).toEqual(relation("requires", [id(91)]))
  expect(
    f.calls
      .filter((call) => call.method === "PATCH" && call.path === "v1/pages/" + skillPage)
      .map((call) => Object.keys(property(property(call.body).properties))),
  ).toEqual([["source"]])
})

test("a missing exact required target fails without selecting a same-name substitute or clearing the relation", async () => {
  const f = await sourceRefreshFixture()
  relatedSkill(f, id(92), "different-skill", "Same display name")
  property(f.main.properties).requires = relation("requires", [id(91)])
  f.clearCalls()
  await expect(f.run(prepareSourceRefresh(library, id(82), skillPage, f.acquire))).rejects.toThrow(
    "missing",
  )
  expect(property(f.main.properties).requires).toEqual(relation("requires", [id(91)]))
  expect(f.calls.some((call) => call.method === "PATCH" || call.path === "v1/pages")).toBe(false)
})

test("portable backup and explicit same-library reimport retain empty relation selections and custom ownership", async () => {
  const f = await sourceRefreshFixture()
  relatedSkill(f, id(91), "required-after-backup", "Later relation")
  const plan = await f.run(prepareSourceRefresh(library, id(82), skillPage, f.acquire))
  await f.run(applySourceRefresh(library, plan))
  const exported = await f.run(snapshotPortable(await current(f)))
  expect(exported.relations).toEqual({
    version: 1,
    ownership: "notion",
    library_id: library.library_id,
    members: [],
    requires: [],
  })
  const backup = portableZip(exported)
  const restored = readPortable(readImportZip(backup))!
  expect(restored.relations).toEqual(exported.relations)
  expect(restored.files).toEqual(exported.files)
  expect(() => portableRelationSelection(restored.relations, "another-library")).toThrow(
    "original shared library",
  )
  expect(() =>
    portableRelationSelection(restored.relations, library.library_id, {
      members: ["shared_skill:library-snapshot:other"],
    }),
  ).toThrow("differ")
  const directory = mkdtempSync(join(tmpdir(), "ng07-portable-"))
  for (const file of portableFiles(restored)) {
    const path = join(directory, file.path)
    mkdirSync(join(path, ".."), { recursive: true })
    writeFileSync(path, file.bytes)
  }
  property(f.main.properties).requires = relation("requires", [id(91)])
  property(f.main.properties).members = relation("members", [id(91)])
  const selected = await current(f)
  f.clearCalls()
  const result = await f.run(
    applySkill(selected.snapshot_id, { input: directory, database: library.skills.database_id }),
  )
  expect(result).toMatchObject({ verified: true })
  expect(property(f.main.properties).members).toEqual(relation("members", []))
  expect(property(f.main.properties).requires).toEqual(relation("requires", []))
  expect(f.calls.some((call) => call.method === "PATCH" && call.path.endsWith("/markdown"))).toBe(
    false,
  )
  const after = await current(f)
  expect(after.files).toEqual(
    exported.files.map((file) => ({
      path: file.path,
      bytes: file.bytes.length,
      sha256: digest(file.bytes),
    })),
  )
  evidence("portable-reimport", {
    kind: "controlled_public_core_apply",
    archive_sha256: digest(backup),
    relations: restored.relations,
    before_files: selected.files,
    after_files: after.files,
    patches: f.calls.filter((call) => call.method === "PATCH"),
    source_pin: text(property(property(f.main.properties).source).rich_text),
  })
})

test("saved v2 approvals remain valid without manufacturing an inventory baseline", async () => {
  const f = await sourceRefreshFixture()
  const plan = await f.run(prepareSourceRefresh(library, id(82), skillPage, f.acquire))
  const { member_review: _, plan_id: __, ...base } = plan
  const legacy = { ...base, version: 2 as const }
  const old = { ...legacy, plan_id: "source-refresh-" + digest(canonicalSharedJson(legacy)) }
  expect((await f.run(validateSourceRefresh(library, old))).plan).toEqual(old)
  expect(await f.run(applySourceRefresh(library, old))).toMatchObject({ verified: true })
})

test("portable reimport restores an exact nonempty Members set without rewriting its generated index into the authored body", async () => {
  const f = await sourceRefreshFixture()
  relatedSkill(f, id(91), "member-a", "Original member")
  relatedSkill(f, id(92), "member-b", "Later member")
  property(f.main.properties).members = relation("members", [id(91)])
  const original = await current(f)
  const portable = await f.run(snapshotPortable(original))
  const directory = mkdtempSync(join(tmpdir(), "ng07-members-import-"))
  for (const file of portableFiles(portable)) {
    const path = join(directory, file.path)
    mkdirSync(join(path, ".."), { recursive: true })
    writeFileSync(path, file.bytes)
  }
  const main = portable.files.find((file) => file.path === "SKILL.md")!
  writeFileSync(
    join(directory, "SKILL.md"),
    new TextDecoder().decode(main.bytes).replace("member-a", "different-id"),
  )
  property(f.main.properties).members = relation("members", [id(92)])
  const selected = await current(f)
  f.clearCalls()
  await expect(
    f.run(
      applySkill(selected.snapshot_id, { input: directory, database: library.skills.database_id }),
    ),
  ).rejects.toThrow("index differs")
  expect(f.calls.some((call) => call.method === "PATCH" || call.path === "v1/pages")).toBe(false)
  writeFileSync(join(directory, "SKILL.md"), main.bytes)
  expect(
    await f.run(
      applySkill(selected.snapshot_id, { input: directory, database: library.skills.database_id }),
    ),
  ).toMatchObject({ verified: true })
  expect(property(f.main.properties).members).toEqual(relation("members", [id(91)]))
  expect(f.calls.some((call) => call.method === "PATCH" && call.path.endsWith("/markdown"))).toBe(
    false,
  )
  expect((await current(f)).files).toEqual(original.files)
})

test("upstream portable relation payload cannot authorize changing the author-owned sets", async () => {
  const f = await sourceRefreshFixture()
  relatedSkill(f, id(91), "keep", "Keep")
  property(f.main.properties).requires = relation("requires", [id(91)])
  Object.assign(f.snapshot.members[0]!.portable, {
    relations: {
      version: 1,
      ownership: "notion",
      library_id: library.library_id,
      members: [],
      requires: [],
    },
  })
  const plan = await f.run(prepareSourceRefresh(library, id(82), skillPage, f.acquire))
  expect(plan.selection?.changes.map((change) => change.field)).toEqual(["Source"])
  expect(await f.run(applySourceRefresh(library, plan))).toMatchObject({ verified: true })
  expect(property(f.main.properties).requires).toEqual(relation("requires", [id(91)]))
})

test("portable archives without relation intent keep the original v2 manifest bytes", () => {
  const portable = {
    kind: "skill" as const,
    name: "Legacy",
    description: "Original",
    main: "SKILL.md",
    files: [{ path: "SKILL.md", bytes: encode("Legacy body\n") }],
  }
  const files = portableFiles(portable)
  expect(
    new TextDecoder().decode(files.find((file) => file.path === ".ntn-skills.json")!.bytes),
  ).toBe(
    '{"format":"ntn-skills","version":2,"kind":"skill","name":"Legacy","description":"Original","main":"SKILL.md"}\n',
  )
  expect(readPortable(files)?.relations).toBeUndefined()
})
