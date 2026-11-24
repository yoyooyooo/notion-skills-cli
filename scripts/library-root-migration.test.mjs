import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
import {
  OLD_MARKER,
  NEW_MARKER,
  ROLES,
  canonical,
  digest,
  rich,
  richText,
  decodeLegacy,
  admissionId,
  preparePlan,
  rewriteReference,
  migrateConfig,
  migratePortableManifest,
  migrateFileLinks,
  applyPlan,
  referenceTokens,
  verifyInventoryClosure,
} from "./library-root-migration.mjs"

const id = (n) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0")
const old = "library-original"
const fields = {
  skills: {
    "Skill ID": "sid",
    Projection: "projection",
    Origin: "origin",
    "Source Member": "member",
    Operation: "op",
    Content: "content",
    Description: "description",
    References: "references",
  },
  files: { "File ID": "fid", Path: "path", Content: "content", Skill: "skill" },
  records: {
    "Record ID": "rid",
    Kind: "kind",
    "Entity ID": "entity",
    Hash: "hash",
    Payload: "payload",
    Skill: "skill",
    Origin: "origin",
  },
  sources: {
    "Source ID": "sid",
    Contributions: "contributions",
    Operation: "op",
    Content: "content",
  },
}
const text = (property, value) => ({ id: property, type: "rich_text", rich_text: rich(value) })
const relation = (property, ids) => ({
  id: property,
  type: "relation",
  relation: ids.map((value) => ({ id: value })),
  has_more: false,
})
const row = (page, parent, properties) => ({
  object: "page",
  id: page,
  parent: { type: "data_source_id", data_source_id: parent },
  properties,
})
function fixture() {
  const root = id(1),
    sourcePage = id(20),
    skillPage = id(21)
  const legacy = {
    version: 1,
    library_id: old,
    operation_id: "library-provenance",
    parent_page_id: root,
  }
  const tables = {}
  for (const [index, role] of ROLES.entries()) {
    legacy[role] = {
      database_id: id(2 + index * 2),
      data_source_id: id(3 + index * 2),
      property_ids: fields[role],
    }
    tables[role] = {
      database: {
        object: "database",
        id: legacy[role].database_id,
        parent: { type: "page_id", page_id: root },
        data_sources: [{ id: legacy[role].data_source_id }],
        description: [],
      },
      data_source: {
        id: legacy[role].data_source_id,
        parent: { database_id: legacy[role].database_id },
        properties: Object.fromEntries(
          Object.entries(fields[role]).map(([name, property]) => [name, { id: property }]),
        ),
      },
      rows: [],
      complete: true,
    }
  }
  tables.skills.database.description = rich(OLD_MARKER + canonical(legacy))
  const skillId = admissionId(old, sourcePage, "skills/poteto-mode")
  tables.skills.rows.push(
    row(skillPage, legacy.skills.data_source_id, {
      sid: text("sid", skillId),
      projection: text("projection", "git-only/v1"),
      origin: relation("origin", [sourcePage]),
      member: text("member", "skills/poteto-mode"),
      op: text("op", ""),
      content: text("content", ""),
      description: text("description", "skill://" + skillId),
      references: text("references", ""),
    }),
  )
  tables.sources.rows.push(
    row(sourcePage, legacy.sources.data_source_id, {
      sid: text("sid", "source-one"),
      contributions: text(
        "contributions",
        canonical([
          {
            member_key: "skills/poteto-mode",
            skill_id: skillId,
            mount_path: "",
            mapping: {},
            exclude: [],
          },
        ]),
      ),
      op: text("op", ""),
      content: text("content", ""),
    }),
  )
  const payload = { version: 2, library_id: old, profile_id: "daily", name: "Daily", enabled: true }
  const envelope = { version: 1, operation_id: "set-profile-original", payload }
  tables.records.rows.push(
    row(id(22), legacy.records.data_source_id, {
      rid: text("rid", "profile-current-" + digest([old, "daily"])),
      kind: { id: "kind", type: "select", select: { name: "profile" } },
      entity: text("entity", "daily"),
      hash: text("hash", digest(envelope)),
      payload: text("payload", canonical(envelope)),
      skill: relation("skill", []),
      origin: relation("origin", []),
    }),
  )
  const native = {
    id: id(23),
    type: "paragraph",
    paragraph: {
      rich_text: [
        {
          type: "text",
          text: {
            content: "Poteto",
            link: { url: "skill://" + skillId + "/SKILL.md?library=" + old },
          },
          annotations: { bold: false, italic: false, code: false, color: "default" },
        },
      ],
    },
  }
  const inventory = {
    version: 1,
    kind: "library-root-migration-inventory",
    root: { object: "page", id: root },
    root_children_complete: true,
    root_database_ids: ROLES.map((role) => legacy[role].database_id),
    other_descriptors: [],
    tables,
    stores: [{ path: "/owned/original-store", dispatch: [], snapshots: 2 }],
    native_bodies_complete: true,
    native_blocks: [native],
    required_content: [],
    content_audit: [],
  }
  return { inventory, legacy, root, skillId, sourcePage, skillPage }
}
test("dedicated parent promotes in place with descriptor last, exact admission and profile hashes", () => {
  const f = fixture(),
    plan = preparePlan(f.inventory)
  assert.equal(plan.status, "ready")
  assert.equal(plan.descriptor.version, 2)
  assert.equal(plan.descriptor.library_id, f.root)
  assert.equal(plan.descriptor.operation_id, f.legacy.operation_id)
  assert.equal("parent_page_id" in plan.descriptor, false)
  assert.equal(plan.patches.at(-1).kind, "database")
  assert.equal(plan.counts.renamed_skills, 1)
  assert.equal(plan.counts.writes, 5)
  for (const role of ROLES) assert.deepEqual(plan.descriptor[role], f.legacy[role])
  assert.equal(
    plan.mapping.skills[0].after,
    admissionId(f.root, f.sourcePage, "skills/poteto-mode"),
  )
  assert.equal(plan.mapping.skills[0].page_id, f.skillPage)
  const profile = plan.patches.find((patch) => patch.id === id(22))
  const envelope = JSON.parse(profile.after.properties.payload.rich_text[0].text.content)
  assert.equal(envelope.payload.library_id, f.root)
  assert.equal(profile.after.properties.hash.rich_text[0].text.content, digest(envelope))
  assert.equal(
    profile.after.properties.rid.rich_text[0].text.content,
    "profile-current-" + digest([f.root, "daily"]),
  )
  const source = plan.patches.find((patch) => patch.id === f.sourcePage)
  assert.equal(
    JSON.parse(source.after.properties.contributions.rich_text[0].text.content)[0].skill_id,
    plan.mapping.skills[0].after,
  )
  assert.ok(plan.patches.at(-1).after.description[0].text.content.startsWith(NEW_MARKER))
})
test("legacy structured file links preserve author paths and exact external URLs while rebinding proven identities", () => {
  const f = fixture()
  const target =
    "skill://" +
    encodeURIComponent("shared_skill:" + old + ":" + f.skillId) +
    "/references/guide.md"
  const external =
    "https://github.com/example/repo/blob/" + "a".repeat(40) + "/skills/example/SKILL.md"
  const index = {
    version: 1,
    kind: "file_links",
    links: [
      { from: "SKILL.md", href: "../poteto/references/guide.md", target },
      { from: "SKILL.md", href: "../external/SKILL.md", target: external },
    ],
  }
  f.inventory.tables.skills.rows[0].properties.references = text("references", canonical(index))
  const plan = preparePlan(f.inventory)
  assert.equal(plan.status, "ready")
  const patch = plan.patches.find((item) => item.id === f.skillPage)
  const mapped = JSON.parse(
    patch.after.properties.references.rich_text.map((item) => item.text.content).join(""),
  )
  assert.deepEqual(mapped.links[0], {
    ...index.links[0],
    target: "skill://" + plan.mapping.skills[0].after + "/references/guide.md?library=" + f.root,
  })
  assert.deepEqual(mapped.links[1], index.links[1])
  assert.ok(patch.reasons.includes("legacy_file_links"))
  assert.throws(
    () => migrateFileLinks({ ...index, links: [index.links[0], index.links[0]] }, plan.mapping),
    { code: "FILE_LINKS_AMBIGUOUS" },
  )
  assert.throws(() => migrateFileLinks({ ...index, extra: true }, plan.mapping), {
    code: "FILE_LINKS_INVALID",
  })
  assert.throws(
    () =>
      rewriteReference(
        "skill://" + encodeURIComponent("shared_skill:other:" + f.skillId),
        plan.mapping,
        old,
      ),
    { code: "LEGACY_REFERENCE_OWNER_UNMAPPED" },
  )
  assert.throws(() => rewriteReference(target + "?library=" + id(99), plan.mapping, old), {
    code: "REFERENCE_OWNER_CONFLICT",
  })
  assert.throws(
    () => rewriteReference("skill://" + f.skillId + "?library=library-unmapped", plan.mapping, old),
    { code: "REFERENCE_OWNER_UNMAPPED" },
  )
})
test("legacy page references require an exact current row and never rewrite source bytes", () => {
  const f = fixture(),
    { mapping } = preparePlan(f.inventory)
  assert.equal(
    rewriteReference("skill://" + f.skillPage + "/SKILL.md", mapping, old),
    "skill://" + mapping.skills[0].after + "/SKILL.md",
  )
  assert.throws(() => rewriteReference("skill://" + id(999) + "/SKILL.md", mapping, old), {
    code: "UNRESOLVED_REFERENCE_TARGET",
  })
  const bytes = new TextEncoder().encode("[old](skill://" + f.skillPage + "/SKILL.md)")
  f.inventory.required_content = [
    { page_id: f.skillPage, sha256: digest(bytes), bytes: bytes.length },
  ]
  f.inventory.content_audit = [
    {
      sha256: digest(bytes),
      bytes: bytes.length,
      references: ["skill://" + f.skillPage + "/SKILL.md"],
    },
  ]
  const plan = preparePlan(f.inventory)
  assert.equal(plan.status, "blocked")
  assert.ok(
    plan.blockers.some(
      (item) => item.code === "IMMUTABLE_CONTENT_REFERENCE_REQUIRES_AUTHOR_UPDATE",
    ),
  )
  assert.ok(plan.patches.every((item) => item.after.properties?.content === undefined))
  f.inventory.stores = []
  assert.ok(
    preparePlan(f.inventory).blockers.some((item) => item.code === "ORIGINAL_STORE_REQUIRED"),
  )
})
test("same names and IDs in another library do not authorize rebinding; pins never become latest", () => {
  const f = fixture(),
    { mapping } = preparePlan(f.inventory)
  assert.equal(
    rewriteReference("skill://" + f.skillId + "?library=" + id(99), mapping, old),
    "skill://" + f.skillId + "?library=" + id(99),
  )
  assert.equal(rewriteReference("skill://" + f.skillId, mapping, id(99)), "skill://" + f.skillId)
  assert.throws(
    () =>
      rewriteReference(
        "skill://" + f.skillId + "?library=" + old + "&snapshot=s_" + "a".repeat(64),
        mapping,
        old,
      ),
    { code: "PINNED_OWNER_REQUIRES_EXPLICIT_REACQUISITION" },
  )
  assert.throws(() => rewriteReference("skill://missing?library=" + old, mapping, old), {
    code: "UNRESOLVED_REFERENCE_TARGET",
  })
  assert.throws(
    () => rewriteReference("skill://" + f.skillId + "/%2e%2e/secret?library=" + old, mapping, old),
    { code: "REFERENCE_INVALID" },
  )
  assert.throws(
    () =>
      rewriteReference(
        "skill://" + f.skillId + "?library=" + old + "&library=" + id(99),
        mapping,
        old,
      ),
    { code: "REFERENCE_INVALID" },
  )
})
test("borrowed table, incomplete enumeration, shared parent and forged Git-only origin cannot produce a plan", () => {
  const changes = [
    [
      (f) => {
        f.inventory.tables.files.database.parent.page_id = id(99)
      },
      "TABLE_REPARENT_REQUIRED",
    ],
    [
      (f) => {
        f.inventory.tables.files.data_source.parent.database_id = id(99)
      },
      "DATA_SOURCE_OWNER_MISMATCH",
    ],
    [
      (f) => {
        f.inventory.tables.sources.complete = false
      },
      "TABLE_ENUMERATION_INCOMPLETE",
    ],
    [
      (f) => {
        f.inventory.other_descriptors.push(id(99))
      },
      "SHARED_PARENT_REQUIRES_SEPARATE_ROOT",
    ],
    [
      (f) => {
        f.inventory.tables.skills.rows[0].properties.origin.relation[0].id = id(99)
      },
      "GIT_ONLY_ADMISSION_UNPROVEN",
    ],
    [
      (f) => {
        f.inventory.root.in_trash = true
      },
      "ROOT_UNAVAILABLE",
    ],
  ]
  for (const [change, code] of changes) {
    const f = fixture()
    change(f)
    assert.throws(() => preparePlan(f.inventory), { code })
  }
})
test("local pending, remote operations and owner pointers all block, including an old Store without v2 keys", () => {
  const f = fixture()
  f.inventory.stores[0].dispatch.push({ key: "operations/current-source-sync/old/pending.json" })
  f.inventory.tables.skills.rows[0].properties.op = text("op", "original-child")
  f.inventory.tables.sources.rows[0].properties.op = text("op", "original-source")
  f.inventory.tables.records.rows.push(
    row(id(30), f.legacy.records.data_source_id, {
      rid: text("rid", "operation-current-" + "a".repeat(64)),
      kind: { id: "kind", type: "select", select: { name: "operation" } },
    }),
  )
  const plan = preparePlan(f.inventory)
  assert.equal(plan.status, "blocked")
  assert.deepEqual(
    new Set(plan.blockers.map((item) => item.code)),
    new Set([
      "LOCAL_OPERATION_PENDING",
      "REMOTE_OPERATION_PENDING",
      "SKILL_OPERATION_PENDING",
      "SOURCE_OPERATION_PENDING",
    ]),
  )
})
test("missing immutable bytes or affected source-owned references block; snapshots/history remain untouched", () => {
  const f = fixture(),
    sha = "a".repeat(64)
  f.inventory.required_content.push({ page_id: f.skillPage, sha256: sha, bytes: 20 })
  assert.ok(
    preparePlan(f.inventory).blockers.some((item) => item.code === "CONTENT_COVERAGE_MISSING"),
  )
  f.inventory.content_audit.push({ sha256: sha, bytes: 20, references: ["skill://" + f.skillId] })
  assert.ok(
    preparePlan(f.inventory).blockers.some(
      (item) => item.code === "IMMUTABLE_CONTENT_REFERENCE_REQUIRES_AUTHOR_UPDATE",
    ),
  )
  const history = row(id(40), f.legacy.records.data_source_id, {
    kind: { id: "kind", type: "select", select: { name: "snapshot" } },
    rid: text("rid", "old-snapshot"),
    payload: text("payload", '{"library_id":"' + old + '"}'),
  })
  f.inventory.tables.records.rows.push(history)
  const before = canonical(history),
    plan = preparePlan(f.inventory)
  assert.equal(canonical(history), before)
  assert.equal(
    plan.patches.some((patch) => patch.id === history.id),
    false,
  )
})
test("config uses observed remote bindings, retains secrets and physical IDs, and removes old selectors", () => {
  const f = fixture(),
    plan = preparePlan(f.inventory)
  const cached = structuredClone(f.legacy)
  delete cached.skills.property_ids.Description
  const config = {
    token: "fake-private-value",
    default_database: f.legacy.skills.database_id,
    sources: [
      {
        alias: "skills",
        database_id: f.legacy.skills.database_id,
        data_source_ids: [f.legacy.skills.data_source_id],
        shared_library: cached,
      },
    ],
    shared_profile: { library_entry: f.legacy.skills.database_id, profile_id: "daily" },
  }
  const result = migrateConfig(config, plan.mapping, plan.descriptor)
  assert.equal(result.token, config.token)
  assert.equal(result.default_library, f.root)
  assert.equal("default_database" in result, false)
  assert.equal(result.sources[0].database_id, config.sources[0].database_id)
  assert.equal(result.sources[0].shared_library.skills.property_ids.Description, "description")
  assert.deepEqual(result.shared_profile, { library_id: f.root, profile_id: "daily" })
  assert.equal(config.default_database, f.legacy.skills.database_id)
  assert.throws(
    () => migrateConfig({ ...config, default_database: id(99) }, plan.mapping, plan.descriptor),
    { code: "CONFIG_DEFAULT_MAPPING_UNPROVEN" },
  )
})
test("portable origin and explicit Members/Requires change only by exact mapping", () => {
  const f = fixture(),
    plan = preparePlan(f.inventory)
  const portable = {
    format: "ntn-skills",
    version: 2,
    kind: "skill",
    name: "poteto-mode",
    relations: {
      version: 1,
      ownership: "notion",
      library_id: old,
      members: ["skill://" + f.skillId + "?library=" + old],
      requires: [],
    },
  }
  const result = migratePortableManifest(portable, plan.mapping)
  assert.equal(result.relations.library_id, f.root)
  assert.equal(
    result.relations.members[0],
    "skill://" + plan.mapping.skills[0].after + "?library=" + f.root,
  )
  assert.deepEqual(result.relations.requires, [])
  assert.equal(portable.relations.library_id, old)
})
test("every lost PATCH acknowledgement resumes by observing original target; descriptor never commits early", async () => {
  const { inventory } = fixture(),
    plan = preparePlan(inventory)
  for (let failAt = 0; failAt < plan.patches.length; failAt++) {
    const state = new Map(plan.patches.map((patch) => [patch.id, structuredClone(patch.before)]))
    const writes = [],
      events = []
    let fail = true
    const io = {
      preflight: async () => {},
      read: async (patch) => state.get(patch.id),
      record: async (event) => {
        events.push(event)
      },
      patch: async (patch) => {
        writes.push(patch.sequence)
        state.set(patch.id, structuredClone(patch.after))
        if (fail && patch.sequence === failAt) {
          fail = false
          throw new Error("lost response")
        }
      },
    }
    await assert.rejects(applyPlan(plan, io), { code: "WRITE_OUTCOME_UNKNOWN" })
    if (failAt < plan.patches.length - 1)
      assert.deepEqual(state.get(plan.patches.at(-1).id), plan.patches.at(-1).before)
    const result = await applyPlan(plan, io)
    assert.equal(result.status, "complete")
    assert.equal(writes.filter((sequence) => sequence === failAt).length, 1)
    assert.ok(events.every((event) => ["dispatching", "verified"].includes(event.status)))
    for (const patch of plan.patches) assert.deepEqual(state.get(patch.id), patch.after)
  }
})
test("pending at preflight, edited plans and unrelated drift dispatch no writes", async () => {
  const plan = preparePlan(fixture().inventory)
  let writes = 0
  const io = {
    preflight: async () => {
      throw Object.assign(new Error("pending"), { code: "LOCAL_OPERATION_PENDING" })
    },
    read: async () => ({}),
    record: async () => {},
    patch: async () => {
      writes++
    },
  }
  await assert.rejects(applyPlan(plan, io), { code: "LOCAL_OPERATION_PENDING" })
  await assert.rejects(applyPlan({ ...plan, status: "changed" }, io), { code: "PLAN_CHANGED" })
  await assert.rejects(applyPlan(plan, { ...io, preflight: async () => {} }), {
    code: "REMOTE_DRIFT",
  })
  assert.equal(writes, 0)
})
test("normalization of Notion default annotations makes readback stable without dropping formatting", () => {
  const f = fixture(),
    plan = preparePlan(f.inventory)
  const patch = plan.patches.find((item) => item.kind === "block")
  assert.equal(patch.before.paragraph.rich_text[0].annotations, undefined)
  f.inventory.native_blocks[0].paragraph.rich_text[0].annotations.bold = true
  assert.equal(
    preparePlan(f.inventory).patches.find((item) => item.kind === "block").after.paragraph
      .rich_text[0].annotations.bold,
    true,
  )
})

test("inline-code identities and table cells migrate without treating code formatting as an exemption", () => {
  const f = fixture()
  const reference = "skill://" + f.skillPage + "/SKILL.md"
  f.inventory.native_blocks.push({
    id: id(30),
    type: "table_row",
    table_row: { cells: [rich("label"), [{ ...rich(reference)[0], annotations: { code: true } }]] },
  })
  const plan = preparePlan(f.inventory)
  assert.equal(plan.status, "ready")
  const patch = plan.patches.find((item) => item.id === id(30))
  assert.equal(
    patch.after.table_row.cells[1][0].text.content,
    "skill://" + plan.mapping.skills[0].after + "/SKILL.md",
  )
  assert.equal(patch.after.table_row.cells[1][0].annotations.code, true)
  assert.deepEqual(patch.before.table_row.cells[0], patch.after.table_row.cells[0])
})

test("embedded and fenced identities stay reviewed while exact placeholders carry no identity", () => {
  const f = fixture(),
    reference = "skill://" + f.skillPage + "/SKILL.md"
  f.inventory.native_blocks.push(
    { id: id(30), type: "code", code: { rich_text: rich(reference), language: "plain text" } },
    {
      id: id(31),
      type: "paragraph",
      paragraph: {
        rich_text: [
          { ...rich("[owner](" + reference + ")")[0], annotations: { code: true } },
          ...rich("DB入口：skill://" + id(999) + "/"),
        ],
      },
    },
    { id: id(32), type: "paragraph", paragraph: { rich_text: rich("Read skill://...") } },
  )
  const plan = preparePlan(f.inventory)
  assert.equal(plan.status, "blocked")
  assert.ok(plan.blockers.some((item) => item.code === "CODE_REFERENCE_REQUIRES_REVIEW"))
  assert.ok(plan.blockers.some((item) => item.code === "EMBEDDED_REFERENCE_REQUIRES_REVIEW"))
  assert.ok(plan.blockers.some((item) => item.code === "UNRESOLVED_REFERENCE_TARGET"))
  assert.ok(plan.patches.every((item) => ![id(30), id(31), id(32)].includes(item.id)))
  assert.deepEqual(referenceTokens("`Read skill://...`\n```text\n" + reference + "\n```"), [
    reference,
  ])
  assert.deepEqual(referenceTokens("skill://.../SKILL.md skill://" + id(999)), [
    "skill://.../SKILL.md",
    "skill://" + id(999),
  ])
})

test("descriptor commit requires every earlier patch and never accepts a partially reverted commit", () => {
  const f = fixture(),
    plan = preparePlan(f.inventory)
  assert.throws(() => verifyInventoryClosure(f.inventory, f.inventory, plan, "descriptor_commit"), {
    code: "MIGRATION_PATCH_INCOMPLETE",
  })
  const committed = structuredClone(f.inventory)
  committed.tables.skills.database.description = structuredClone(
    plan.patches.at(-1).after.description,
  )
  assert.throws(() => verifyInventoryClosure(f.inventory, committed, plan), {
    code: "DESCRIPTOR_COMMIT_INCOMPLETE",
  })
})

test("actual CLI inventory, plan and guarded apply preserve existing rows through a fake ntn boundary", () => {
  const f = fixture()
  f.inventory.tables.skills.data_source.description = structuredClone(
    f.inventory.tables.skills.database.description,
  )
  Object.assign(f.inventory.tables.skills.data_source.properties.Origin, {
    type: "relation",
    relation: {
      database_id: f.legacy.sources.database_id,
      data_source_id: f.legacy.sources.data_source_id,
    },
  })
  f.inventory.tables.skills.rows[0].properties.content = text(
    "content",
    canonical({ kind: "native" }),
  )
  f.inventory.native_blocks[0].parent = { page_id: f.skillPage }
  f.inventory.native_blocks.push(
    {
      id: id(30),
      type: "table",
      parent: { page_id: f.skillPage },
      has_children: true,
      table: { table_width: 1 },
    },
    {
      id: id(31),
      type: "table_row",
      parent: { block_id: id(30) },
      table_row: { cells: [rich("skill://" + f.skillPage + "/SKILL.md")] },
    },
    {
      id: id(33),
      type: "paragraph",
      parent: { page_id: f.skillPage },
      paragraph: { rich_text: rich("Unchanged author note.") },
    },
  )
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "library-root-migration-")))
  const bin = join(directory, "bin"),
    store = join(directory, "store"),
    supplementalObjects = join(directory, "supplemental-objects")
  mkdirSync(bin)
  mkdirSync(store)
  mkdirSync(supplementalObjects)
  const supplementalBytes = Buffer.from("Verified supplemental content without skill references.\n")
  const supplementalHash = digest(supplementalBytes)
  writeFileSync(join(supplementalObjects, supplementalHash), supplementalBytes, { mode: 0o600 })
  f.inventory.tables.files.rows.push(
    row(id(32), f.legacy.files.data_source_id, {
      fid: text("fid", "supplemental-file"),
      path: text("path", "references/supplemental.md"),
      content: text(
        "content",
        canonical({ kind: "resource", sha256: supplementalHash, bytes: supplementalBytes.length }),
      ),
      skill: relation("skill", [f.skillPage]),
    }),
  )
  const state = join(directory, "remote.json"),
    calls = join(directory, "calls.jsonl")
  writeFileSync(state, JSON.stringify(f.inventory), { mode: 0o600 })
  const fixtureSource =
    "#!" +
    process.execPath +
    "\n" +
    'const fs=require("node:fs");const state=' +
    JSON.stringify(state) +
    ", calls=" +
    JSON.stringify(calls) +
    ";\n" +
    'const db=JSON.parse(fs.readFileSync(state,"utf8")),a=process.argv.slice(2),path=a[1].split("?")[0],method=a[a.indexOf("--method")+1];\n' +
    'const input=a.includes("--data")?JSON.parse(fs.readFileSync(0,"utf8")):undefined;fs.appendFileSync(calls,JSON.stringify({path,method})+"\\n");\n' +
    'const list=results=>({object:"list",results,has_more:false,next_cursor:null});const rows=Object.values(db.tables).flatMap(t=>t.rows);let result;\n' +
    'const value=(r,p)=>Object.values(r.properties).find(x=>x.id===p);const matches=(r,f)=>!f?true:f.and?f.and.every(x=>matches(r,x)):f.or?f.or.some(x=>matches(r,x)):f.select?value(r,f.property)?.select?.name===f.select.equals:f.rich_text?.is_not_empty?Boolean((value(r,f.property)?.rich_text??[]).length):f.rich_text?.starts_with?(value(r,f.property)?.rich_text??[]).map(x=>x.text.content).join("").startsWith(f.rich_text.starts_with):false;\n' +
    'if(path==="/v1/pages/"+db.root.id)result=db.root;else if(path==="/v1/blocks/"+db.root.id+"/children")result=list(db.root_database_ids.map(id=>({id,type:"child_database"})));\n' +
    'for(const t of Object.values(db.tables)){if(path==="/v1/databases/"+t.database.id)result=t.database;if(path==="/v1/data_sources/"+t.data_source.id)result=t.data_source;if(path==="/v1/data_sources/"+t.data_source.id+"/query")result=list(t.rows.filter(r=>matches(r,input.filter)));}\n' +
    'const r=rows.find(r=>path==="/v1/pages/"+r.id);if(r)result=r;\n' +
    'for(const b of db.native_blocks){if(path==="/v1/blocks/"+b.id)result=b;}const children=/^\\/v1\\/blocks\\/([^/]+)\\/children$/.exec(path);if(children&&children[1]!==db.root.id)result=list(db.native_blocks.filter(b=>Object.values(b.parent??{}).includes(children[1])));\n' +
    'if(method==="PATCH"){if(input.description){result.description=input.description;const table=Object.values(db.tables).find(t=>t.database.id===result.id);if(table)table.data_source.description=input.description;}if(input.properties)for(const [id,p]of Object.entries(input.properties)){const target=value(result,id);Object.assign(target,p);}if(result.type&&input[result.type])Object.assign(result[result.type],input[result.type]);result.last_edited_time="2027-01-01T00:00:00.000Z";if(db.late_native){const target=db.native_blocks.find(b=>b.id===db.late_native.id);target.paragraph.rich_text=db.late_native.rich_text;delete db.late_native;}fs.writeFileSync(state,JSON.stringify(db));}\n' +
    "if(!result)process.exit(2);console.log(JSON.stringify(result));\n"
  writeFileSync(join(bin, "ntn"), fixtureSource, { mode: 0o700 })
  execFileSync("python3", [
    "-c",
    'import sqlite3,sys\nc=sqlite3.connect(sys.argv[1]);c.execute("create table shared_local_records(key text,category text,payload text,retired integer)");c.execute("create table snapshots(id text)");c.commit()',
    join(store, "state.sqlite"),
  ])
  const env = {
    PATH: bin + ":" + process.env.PATH,
    HOME: directory,
    NOTION_API_TOKEN: "fake-never-live",
  }
  const entry = resolve("scripts/library-root-migrate.mjs")
  const invoke = (args) =>
    spawnSync(process.execPath, [entry, ...args], { env, encoding: "utf8", timeout: 20_000 })
  const inventoryPath = join(directory, "inventory.json"),
    planPath = join(directory, "plan.json")
  let result = invoke([
    "inspect",
    "--entry",
    f.legacy.skills.database_id,
    "--root",
    f.root,
    "--store",
    store,
    "--objects-root",
    supplementalObjects,
    "--output",
    inventoryPath,
  ])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.includes("fake-never-live"), false)
  const inspected = JSON.parse(readFileSync(inventoryPath, "utf8"))
  assert.deepEqual(inspected.content_audit, [
    {
      sha256: supplementalHash,
      bytes: supplementalBytes.length,
      references: [],
      location: join(supplementalObjects, supplementalHash),
    },
  ])
  result = invoke(["plan", "--inventory", inventoryPath, "--output", planPath])
  assert.equal(result.status, 0, result.stderr)
  const plan = JSON.parse(readFileSync(planPath, "utf8"))
  assert.equal(plan.status, "ready")
  const baseArgs = [
    "apply",
    "--inventory",
    inventoryPath,
    "--plan",
    planPath,
    "--journal",
    join(directory, "journal"),
    "--writers-quiesced",
  ]
  result = invoke([...baseArgs, "--ack-plan", "wrong"])
  assert.equal(result.status, 1)
  assert.equal(readFileSync(calls, "utf8").includes('"PATCH"'), false)
  execFileSync("python3", [
    "-c",
    'import sqlite3,sys\nc=sqlite3.connect(sys.argv[1]);c.execute("insert into shared_local_records values(?,?,?,0)",("operations/shared-profile-pending/original/profile/pending.json","cache","{}"));c.commit()',
    join(store, "state.sqlite"),
  ])
  result = invoke([...baseArgs, "--ack-plan", plan.plan_sha256])
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stderr, /LOCAL_OPERATION_PENDING/u)
  assert.equal(readFileSync(calls, "utf8").includes('"PATCH"'), false)
  execFileSync("python3", [
    "-c",
    'import sqlite3,sys\nc=sqlite3.connect(sys.argv[1]);c.execute("update shared_local_records set retired=1");c.commit()',
    join(store, "state.sqlite"),
  ])
  const pristine = JSON.parse(readFileSync(state, "utf8"))
  const lateSkill = structuredClone(pristine)
  const lateSourcePage = id(40),
    lateSkillPage = id(41),
    lateMember = "skills/late-author-entry",
    lateSkillId = admissionId(old, lateSourcePage, lateMember)
  const source = structuredClone(lateSkill.tables.sources.rows[0])
  source.id = lateSourcePage
  source.properties.sid = text("sid", "late-source")
  source.properties.contributions = text(
    "contributions",
    canonical([
      { member_key: lateMember, skill_id: lateSkillId, mount_path: "", mapping: {}, exclude: [] },
    ]),
  )
  const skill = structuredClone(lateSkill.tables.skills.rows[0])
  skill.id = lateSkillPage
  skill.properties.sid = text("sid", lateSkillId)
  skill.properties.origin = relation("origin", [lateSourcePage])
  skill.properties.member = text("member", lateMember)
  skill.properties.content = text("content", "")
  skill.properties.description = text("description", "")
  lateSkill.tables.sources.rows.push(source)
  lateSkill.tables.skills.rows.push(skill)
  const lateNative = structuredClone(pristine)
  lateNative.native_blocks.find((block) => block.id === id(33)).paragraph.rich_text = rich(
    "skill://" + f.skillId,
  )
  const lateSchema = structuredClone(pristine)
  lateSchema.tables.skills.data_source.properties.Origin.relation.data_source_id = id(500)
  const lateOwner = structuredClone(pristine)
  lateOwner.tables.files.rows[0].parent.data_source_id = id(501)
  const earlyMirror = structuredClone(pristine)
  earlyMirror.tables.skills.data_source.description = structuredClone(
    plan.patches.at(-1).after.description,
  )
  for (const { changed, code } of [
    { changed: lateSkill, code: "INVENTORY_DRIFT" },
    { changed: lateNative, code: "INVENTORY_DRIFT" },
    { changed: lateSchema, code: "INVENTORY_DRIFT" },
    { changed: lateOwner, code: "ROW_OWNER_MISMATCH" },
    { changed: earlyMirror, code: "INVENTORY_DRIFT" },
  ]) {
    writeFileSync(state, JSON.stringify(changed))
    result = invoke([...baseArgs, "--ack-plan", plan.plan_sha256])
    assert.equal(result.status, 1, result.stdout)
    assert.equal(JSON.parse(result.stderr).error.code, code)
    assert.equal(readFileSync(calls, "utf8").includes('"PATCH"'), false)
  }
  writeFileSync(
    state,
    JSON.stringify({
      ...pristine,
      late_native: { id: id(33), rich_text: rich("skill://" + f.skillId) },
    }),
  )
  result = invoke([...baseArgs, "--ack-plan", plan.plan_sha256])
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stderr, /INVENTORY_DRIFT/u)
  const interrupted = JSON.parse(readFileSync(state, "utf8"))
  assert.equal(
    richText(interrupted.tables.skills.database.description).startsWith(OLD_MARKER),
    true,
  )
  interrupted.native_blocks.find((block) => block.id === id(33)).paragraph.rich_text =
    rich("Unchanged author note.")
  writeFileSync(state, JSON.stringify(interrupted))
  result = invoke([...baseArgs, "--ack-plan", plan.plan_sha256])
  assert.equal(result.status, 0, result.stderr)
  const actual = JSON.parse(readFileSync(state, "utf8"))
  const migrated = JSON.parse(
    actual.tables.skills.database.description[0].text.content.slice(NEW_MARKER.length),
  )
  assert.equal(migrated.library_id, f.root)
  assert.equal(actual.tables.skills.rows[0].id, f.skillPage)
  assert.equal(
    actual.native_blocks.find((block) => block.id === id(31)).table_row.cells[0][0].text.content,
    "skill://" + plan.mapping.skills[0].after + "/SKILL.md",
  )
  assert.deepEqual(
    actual.tables.skills.rows[0].properties.origin,
    f.inventory.tables.skills.rows[0].properties.origin,
  )
  const writes = readFileSync(calls, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((item) => item.method === "PATCH")
  assert.equal(writes.at(-1).path, "/v1/databases/" + f.legacy.skills.database_id)
  const count = writes.length
  const unrelatedMirror = structuredClone(actual)
  unrelatedMirror.tables.skills.data_source.description = rich("An unreviewed description edit.")
  writeFileSync(state, JSON.stringify(unrelatedMirror))
  result = invoke([...baseArgs, "--ack-plan", plan.plan_sha256])
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stderr, /INVENTORY_DRIFT/u)
  writeFileSync(state, JSON.stringify(actual))
  result = invoke([...baseArgs, "--ack-plan", plan.plan_sha256])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(
    readFileSync(calls, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((item) => item.method === "PATCH").length,
    count,
  )
})
