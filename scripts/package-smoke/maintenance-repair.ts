import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { property, text } from "../../packages/core/src/model.ts"
import { canonicalSharedJson } from "../../packages/core/src/shared-records.ts"
import type { sharedCreateFixture } from "../../packages/core/test/shared-create-fixture.ts"
import { id, rich } from "../../packages/core/test/shared-snapshot-fixture.ts"
import type { AuthoringContinuation } from "./authoring.ts"

const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const string = (value: unknown, label: string) => {
  assert.equal(typeof value, "string", label)
  assert.ok(String(value).length > 0, label)
  return String(value)
}

type RepairTargets = {
  readonly mainPage: string
  readonly filePage: string
  readonly path: string
}

/** Seed only native service rows. No consumer state, operation, ACK or snapshot is supplied. */
export function seedMaintenanceRepairFixture(
  fixture: ReturnType<typeof sharedCreateFixture>,
): RepairTargets {
  const mainPage = id(91_001),
    filePage = id(91_002),
    path = "notes/hand.md",
    user = id(42)
  assert.equal(fixture.skills.has(mainPage), false)
  assert.equal(fixture.files.has(filePage), false)
  const row = fixture.seedSkill(
    mainPage,
    "skill-installed-historical",
    "Installed historical partial",
    "skill",
    true,
  )
  row.url = `https://www.notion.so/${mainPage.replaceAll("-", "")}`
  row.created_time = row.last_edited_time
  row.created_by = { object: "user", id: user }
  row.last_edited_by = { object: "user", id: user }
  const fields = property(row.properties)
  fields.main_file_id = rich("main_file_id", "")
  fields.acceptance_note = rich("acceptance_note", "Keep this hand-maintained property")
  fixture.base.bodies.set(mainPage, "0123456789abcdef0123456789abcdef")
  fixture.files.set(filePage, {
    object: "page",
    id: filePage,
    url: `https://www.notion.so/${filePage.replaceAll("-", "")}`,
    created_time: row.created_time,
    last_edited_time: row.last_edited_time,
    created_by: row.created_by,
    last_edited_by: row.last_edited_by,
    parent: {
      type: "data_source_id",
      data_source_id: fixture.library.files.data_source_id,
      database_id: fixture.library.files.database_id,
    },
    properties: {
      title: { id: "title", type: "title", title: [{ plain_text: "Hand note" }] },
      file_id: rich("file_id", ""),
      path: rich("path", path),
      projection: rich("projection", ""),
      status: { id: "status", type: "select", select: { name: "custom" } },
      skill: { id: "skill", type: "relation", relation: [{ id: mainPage }], has_more: false },
      acceptance_note: rich("acceptance_note", "Keep this supporting property"),
    },
  })
  fixture.base.bodies.set(filePage, "Hand note\n")
  return { mainPage, filePage, path }
}

/** Use the existing authoring server and the independently installed Node bin.
 * Source state is a separate oracle; every product action crosses public HTTP. */
export async function checkInstalledMaintenanceRepair(
  input: AuthoringContinuation,
  targets: RepairTargets,
) {
  const { database, invoke, noWrites, observe, root } = input
  const initial = observe()
  const source = (value: ReturnType<typeof observe>) => ({
    skills: value.skills,
    files: value.files,
    records: value.records,
    bodies: value.bodies,
  })
  const digest = () => hash(canonicalSharedJson(source(observe())))
  const reports: unknown[] = []
  for (const selected of [
    {
      label: "managed-file",
      page: targets.filePage,
      entry: "managed-file",
      identity: "file_id",
      flags: ["--path", targets.path, "--owner", targets.mainPage],
    },
    {
      label: "historical-main",
      page: targets.mainPage,
      entry: "historical-missing-main",
      identity: "main_file_id",
      flags: [],
    },
  ]) {
    const before = observe()
    const row = [...before.skills, ...before.files]
      .map(property)
      .find((item) => item.id === selected.page)
    assert.ok(row)
    const originalBody = before.bodies.find(([page]) => page === selected.page)?.[1]
    assert.equal(typeof originalBody, "string")
    const beforePreview = digest()
    const planned = property(
      await noWrites(`repair-${selected.label}-plan`, [
        "ctl",
        "repair",
        "plan",
        selected.page,
        "--entry",
        selected.entry,
        "--database",
        database,
        ...selected.flags,
        "--dry-run",
      ]),
    )
    assert.equal(planned.dry_run, true)
    assert.equal(planned.writes, 0)
    assert.equal(digest(), beforePreview)
    const operation = string(planned.operation_id, "Public repair operation ID")
    const next = property(planned.next).argv
    assert.ok(Array.isArray(next) && next.every((value) => typeof value === "string"))
    assert.equal(next[0], "ntn-skills")
    assert.deepEqual(next.slice(1, 4), ["ctl", "repair", "apply"])
    const applyArgv: string[] = next.slice(1)
    const applied = property(await invoke(`repair-${selected.label}-apply`, applyArgv))
    assert.equal(applied.state, "applied")
    assert.equal(applied.verified, true)
    assert.equal(applied.operation_id, operation)
    assert.equal(applied.file_page_id, selected.page)
    assert.equal(applied.page_recreated, false)
    const after = observe()
    const current = [...after.skills, ...after.files]
      .map(property)
      .find((item) => item.id === selected.page)
    assert.ok(current)
    assert.equal(after.skills.length, before.skills.length)
    assert.equal(after.files.length, before.files.length)
    assert.deepEqual(after.bodies, before.bodies)
    for (const key of ["id", "url", "parent", "created_time", "created_by", "last_edited_by"])
      assert.deepEqual(current[key], row[key], `Original ${key} remains on ${selected.page}`)
    const untouched = (value: unknown) =>
      Object.fromEntries(
        Object.entries(property(property(value).properties)).filter(
          ([key]) => key !== selected.identity,
        ),
      )
    assert.deepEqual(untouched(current), untouched(row))
    assert.equal(
      text(property(property(current.properties)[selected.identity]).rich_text),
      string(property(planned.plan).file_id, "Planned stable File identity"),
    )
    for (const original of before.records) {
      const retained = after.records.map(property).find((item) => item.id === property(original).id)
      assert.deepEqual(retained, original, "Existing history must remain byte-for-byte unchanged")
    }
    const dispatch = after.calls.slice(before.calls.length)
    assert.deepEqual(
      dispatch.filter((call) => call.method === "PATCH").map((call) => call.path),
      [`v1/pages/${selected.page}`],
      "Only the selected blank identity is patched; no native body or unrelated page is written",
    )
    const settled = digest()
    const shown = property(
      await noWrites(`repair-${selected.label}-show`, [
        "ctl",
        "repair",
        "show",
        operation,
        "--database",
        database,
        "--page",
        selected.page,
      ]),
    )
    assert.equal(shown.operation_id, operation)
    const reconciled = property(
      await noWrites(`repair-${selected.label}-reconcile`, [
        "ctl",
        "repair",
        "reconcile",
        operation,
        "--database",
        database,
        "--page",
        selected.page,
      ]),
    )
    assert.equal(reconciled.operation_id, operation)
    assert.equal(reconciled.verified, true)
    const repeated = property(await noWrites(`repair-${selected.label}-repeat`, applyArgv))
    assert.equal(repeated.operation_id, operation)
    assert.equal(repeated.verified, true)
    assert.equal(
      digest(),
      settled,
      "Show, reconcile and repeat must not grow source rows or change bytes",
    )
    reports.push({
      entry: selected.entry,
      operation_id: operation,
      page_id: selected.page,
      file_id: applied.file_id,
      body_sha256: hash(String(originalBody)),
      original_page_and_metadata_preserved: true,
      native_pages_created: 0,
      identity_patches: 1,
      body_writes: 0,
      repeated_source_sha256: settled,
      repeated_remote_writes: 0,
      separate_cli_processes: true,
    })
  }
  const refused = property(
    await noWrites(
      "repair-ordinary-child-refused",
      [
        "ctl",
        "repair",
        "plan",
        targets.mainPage,
        "--entry",
        "ordinary-child",
        "--database",
        database,
        "--dry-run",
      ],
      1,
    ),
  )
  assert.equal(property(refused.error).code, "REPAIR_ENTRY")
  const evidence = {
    proof: "independent_installed_node_with_controlled_notion",
    installed_package: true,
    live_notion: false,
    public_cli_wired: true,
    results: reports,
    ordinary_child: "REPAIR_ENTRY",
    actual_http_requests: observe().calls.length - initial.calls.length,
    native_pages_created: 0,
    source_before_sha256: hash(canonicalSharedJson(source(initial))),
    source_after_sha256: digest(),
    receipt: join(root, "maintenance-repair.json"),
  }
  await writeFile(
    evidence.receipt,
    JSON.stringify(
      { ...evidence, raw_source_before: source(initial), raw_source_after: source(observe()) },
      null,
      2,
    ) + "\n",
  )
  return evidence
}
