import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { property, SkillsError, text } from "../../packages/core/src/model.ts"
import {
  applyRepairByOperation,
  planRepair,
  reconcileRepair,
} from "../../packages/core/src/shared-native-repair.ts"
import {
  createLibrary,
  sharedCreateFixture,
} from "../../packages/core/test/shared-create-fixture.ts"
import { id, rich } from "../../packages/core/test/shared-snapshot-fixture.ts"

const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const user = id(42)

function failure(result: { readonly _tag: string; readonly failure?: unknown }) {
  if (result._tag !== "Failure" || !(result.failure instanceof SkillsError))
    throw new Error("Expected a repair refusal")
  return result.failure
}

/**
 * Reuses the authoring HTTP fixture's request closure. The public CLI is not
 * wired to this command yet, so this is not an installed-package or live Notion pass.
 */
export async function checkMaintenanceRepairHttp() {
  const scratch = await mkdtemp(join(tmpdir(), "ntn-repair-http-"))
  const fixture = sharedCreateFixture()
  const page = id(91_001)
  const filePage = id(91_002)
  const body = "0123456789abcdef0123456789abcdef"
  const row = fixture.seedSkill(page, "skill-historical", "Historical partial", "skill", true)
  row.url = `https://www.notion.so/${page.replaceAll("-", "")}`
  row.created_time = row.last_edited_time
  row.created_by = { object: "user", id: user }
  row.last_edited_by = { object: "user", id: user }
  property(property(row.properties).main_file_id).rich_text = [
    { type: "text", plain_text: "", text: { content: "" } },
  ]
  fixture.base.bodies.set(page, body)
  const stamp = String(row.last_edited_time)
  fixture.files.set(filePage, {
    object: "page",
    id: filePage,
    url: `https://www.notion.so/${filePage.replaceAll("-", "")}`,
    created_time: stamp,
    last_edited_time: stamp,
    created_by: { object: "user", id: user },
    last_edited_by: { object: "user", id: user },
    parent: {
      type: "data_source_id",
      data_source_id: createLibrary.files.data_source_id,
      database_id: createLibrary.files.database_id,
    },
    properties: {
      title: { id: "title", type: "title", title: [{ plain_text: "Hand note" }] },
      file_id: rich("file_id", ""),
      path: rich("path", "notes/hand.md"),
      projection: rich("projection", ""),
      status: { id: "status", type: "select", select: { name: "custom" } },
      skill: { id: "skill", type: "relation", relation: [{ id: page }], has_more: false },
    },
  })
  fixture.base.bodies.set(filePage, "Hand note\n")
  const beforeUrl = row.url
  const beforeHash = hash(body)
  const filePlan = await fixture.run(
    planRepair(filePage, {
      entry: "managed-file",
      database: createLibrary.skills.database_id,
      path: "notes/hand.md",
      owner: page,
      dryRun: true,
    }),
  )
  const adopted = await fixture.run(
    applyRepairByOperation({
      page: filePage,
      entry: "managed-file",
      operationId: filePlan.operation_id,
      database: createLibrary.skills.database_id,
      path: "notes/hand.md",
      owner: page,
    }),
  )
  assert.equal(adopted.file_page_id, filePage)
  assert.equal(fixture.base.bodies.get(filePage), "Hand note\n")
  const planned = await fixture.run(
    planRepair(page, {
      entry: "historical-missing-main",
      database: createLibrary.skills.database_id,
      dryRun: true,
    }),
  )
  assert.equal(planned.writes, 0)
  const writesAtPlan = fixture.writes().length
  assert.equal(hash(fixture.base.bodies.get(page) ?? ""), beforeHash)
  const applied = await fixture.run(
    applyRepairByOperation({
      page,
      entry: "historical-missing-main",
      operationId: planned.operation_id,
      database: createLibrary.skills.database_id,
    }),
  )
  assert.equal(applied.verified, true)
  assert.equal(applied.skill_page_id, page)
  assert.equal(fixture.base.bodies.get(page), body)
  assert.equal(property(fixture.skills.get(page)!).url, beforeUrl)
  assert.equal(
    text(property(property(fixture.skills.get(page)!.properties).skill_id).rich_text),
    "skill-historical",
  )
  assert.equal(property(property(fixture.skills.get(page)!.properties).enabled).checkbox, true)
  const rows = [...fixture.base.records.values()].length
  const writes = fixture.writes().length
  await fixture.run(reconcileRepair(planned.operation_id))
  assert.equal(fixture.writes().length, writes)
  assert.equal([...fixture.base.records.values()].length, rows)
  assert.equal(fixture.nativeCreates().length, 0)
  const child = failure(
    await fixture.run(
      planRepair(page, {
        entry: "ordinary-child",
        database: createLibrary.skills.database_id,
        dryRun: true,
      }).pipe(Effect.result),
    ),
  )
  assert.equal(child.code, "REPAIR_ENTRY")
  const evidence = {
    proof: "source_functions_against_existing_authoring_fixture",
    installed_package: false,
    live_notion: false,
    public_cli_wired: false,
    operation_id: planned.operation_id,
    file_operation_id: filePlan.operation_id,
    body_sha256: beforeHash,
    native_creates: fixture.nativeCreates().length,
    ordinary_child: child.code,
    repeated_record_count: rows,
  }
  await writeFile(join(scratch, "evidence.json"), JSON.stringify(evidence, null, 2))
  return { ...evidence, scratch }
}
