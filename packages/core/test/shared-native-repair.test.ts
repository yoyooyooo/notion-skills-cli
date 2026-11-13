import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { fail, property, SkillsError, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { adoptSharedNative } from "../src/shared-native-adoption.ts"
import { nativeFileIdentity } from "../src/shared-native-adoption-model.ts"
import { openSharedSnapshot } from "../src/shared-snapshot.ts"
import {
  applyRepair,
  applyRepairByOperation,
  loadPendingSharedRepairs,
  planRepair,
  recognizeRepairOperation,
  reconcileRepair,
  repairApplyArgv,
  showRepair,
} from "../src/shared-native-repair.ts"
import { nativeRepairEntity } from "../src/shared-native-repair-model.ts"
import { querySharedSkillIndex } from "../src/shared-skill-index.ts"
import { querySharedOperationIndex } from "../src/shared-operation-index.ts"
import { id, library, rich, sharedSnapshotFixture, skillPage } from "./shared-snapshot-fixture.ts"

function errorOf(result: { readonly _tag: string; readonly failure?: unknown }) {
  if (result._tag !== "Failure" || !(result.failure instanceof SkillsError))
    throw new Error("Expected SkillsError")
  return result.failure
}

function historicalFixture() {
  const base = sharedSnapshotFixture({ fileCount: 1 })
  const fields = property(base.main.properties)
  const user = id(42)
  base.main.url = `https://www.notion.so/${skillPage.replaceAll("-", "")}`
  base.main.created_time = base.main.last_edited_time
  base.main.created_by = { object: "user", id: user }
  base.main.last_edited_by = { object: "user", id: user }
  fields.skill_id = rich("skill_id", "skill-historical")
  fields.main_file_id = rich("main_file_id", "")
  property(fields.enabled).checkbox = true
  let losePatch = false
  let loseOutcome = false
  let extraSkills: unknown[] | undefined
  let denyFiles = false
  const run = <A, E>(effect: Effect.Effect<A, E, any>) =>
    base.run(
      Effect.gen(function* () {
        const original = yield* Notion
        return yield* effect.pipe(
          Effect.provideService(Notion, {
            ...original,
            request: (path, body, options) => {
              const method = options?.method ?? (body === undefined ? "GET" : "POST")
              if (
                denyFiles &&
                path.startsWith(`v1/data_sources/${library.files.data_source_id}/query`)
              )
                return Effect.fail(fail("ACCESS_DENIED", "Files history is not permitted"))
              if (
                extraSkills !== undefined &&
                path.startsWith(`v1/data_sources/${library.skills.data_source_id}/query`)
              )
                return Effect.succeed({
                  object: "list",
                  results: structuredClone(extraSkills),
                  has_more: false,
                  next_cursor: null,
                })
              if (loseOutcome && path === "v1/pages" && method === "POST") {
                const recordId = text(
                  property(property(property(body).properties).record).rich_text,
                )
                if (recordId.startsWith("outcome-"))
                  return Effect.fail(
                    fail("WRITE_OUTCOME_UNKNOWN", "Original outcome response lost"),
                  )
              }
              if (path === `v1/pages/${skillPage}` && method === "PATCH")
                return Effect.suspend(() => {
                  base.calls.push({ path, method: "PATCH", body })
                  for (const [key, value] of Object.entries(property(property(body).properties)))
                    fields[key] = { ...property(fields[key]), ...property(value) }
                  if (losePatch) {
                    losePatch = false
                    return Effect.fail(
                      fail("WRITE_OUTCOME_UNKNOWN", "Original identity PATCH response lost"),
                    )
                  }
                  return Effect.succeed(structuredClone(base.main))
                })
              return original.request(path, body, options)
            },
          }),
        )
      }),
    )
  return {
    ...base,
    fields,
    run,
    armLostPatch: () => {
      losePatch = true
    },
    loseOutcome() {
      loseOutcome = true
    },
    setSkills(pages: unknown[]) {
      extraSkills = pages
    },
    denyFiles() {
      denyFiles = true
    },
    writes: () => base.calls.filter((call) => call.method === "PATCH" || call.path === "v1/pages"),
  }
}

const planOptions = {
  entry: "historical-missing-main",
  database: library.skills.database_id,
  dryRun: true,
}

describe("historical missing-main repair", () => {
  test("a concurrent custom-property edit at the identity PATCH is preserved and prevents completion", async () => {
    const fixture = historicalFixture()
    fixture.fields.owner_note = rich("owner_note", "Keep this exact author note")
    const planned = await fixture.run(planRepair(skillPage, planOptions))
    let changed = false
    const result = await fixture.run(
      Effect.gen(function* () {
        const api = yield* Notion
        return yield* applyRepair(planned.plan, {
          database: library.skills.database_id,
          operationId: planned.operation_id,
        }).pipe(
          Effect.provideService(Notion, {
            ...api,
            request: (path, body, options) => {
              if (!changed && path === `v1/pages/${skillPage}` && options?.method === "PATCH") {
                changed = true
                fixture.fields.owner_note = rich("owner_note", "Later human note must survive")
              }
              return api.request(path, body, options)
            },
          }),
        )
      }).pipe(Effect.result),
    )
    expect(result).toMatchObject({ _tag: "Failure", failure: { code: "WRITE_CONFLICT" } })
    expect(text(property(fixture.fields.owner_note).rich_text)).toBe(
      "Later human note must survive",
    )
    expect(recordIds(fixture)).not.toContain(`outcome-${planned.operation_id}`)
    expect(fixture.bodies.get(skillPage)).toBe("# Native main\n")
  })
  test("a complete-looking header cannot validate a conflicting original outcome", async () => {
    const fixture = historicalFixture()
    const planned = await fixture.run(planRepair(skillPage, planOptions))
    await fixture.run(
      applyRepair(planned.plan, {
        database: library.skills.database_id,
        operationId: planned.operation_id,
      }),
    )
    const outcome = [...fixture.records.values()].find(
      (row) =>
        text(property(property(row.properties).record).rich_text) ===
        `outcome-${planned.operation_id}`,
    )
    if (!outcome) throw new Error("Expected the actual original completion")
    const envelope = JSON.parse(text(property(property(outcome.properties).payload).rich_text))
    fixture.records.delete(String(outcome.id))
    fixture.seedFact(
      { ...property(envelope.payload), file_id: "foreign-file" },
      "operation",
      nativeRepairEntity,
      `outcome-${planned.operation_id}`,
      planned.operation_id,
    )
    fixture.clearCalls()
    const shown = await fixture.run(showRepair(planned.operation_id).pipe(Effect.result))
    expect(shown).toMatchObject({ _tag: "Failure", failure: { code: "REPAIR_CONFLICT" } })
    const headers = await fixture.run(querySharedOperationIndex(library, skillPage))
    const consumption = await fixture.run(
      loadPendingSharedRepairs(library, { skillPageId: skillPage, headers }).pipe(Effect.result),
    )
    expect(consumption).toMatchObject({ _tag: "Failure", failure: { code: "REPAIR_CONFLICT" } })
    expect(fixture.writes()).toHaveLength(0)
  })

  test("a damaged local acknowledgement is not accepted merely because its key exists", async () => {
    const fixture = historicalFixture()
    const planned = await fixture.run(planRepair(skillPage, planOptions))
    await fixture.run(
      applyRepair(planned.plan, {
        database: library.skills.database_id,
        operationId: planned.operation_id,
      }),
    )
    const ack = [...fixture.json].find(
      ([key, value]) =>
        key.includes("/source-ack-") && property(property(value).response).id === skillPage,
    )
    if (!ack) throw new Error("Expected the actual durable original acknowledgement")
    fixture.json.set(ack[0], { ...property(ack[1]), request_hash: "0".repeat(64) })
    fixture.clearCalls()
    const result = await fixture.run(showRepair(planned.operation_id).pipe(Effect.result))
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { code: "SOURCE_OPERATION_CONFLICT" },
    })
    expect(fixture.writes()).toHaveLength(0)
  })
  test("dry-run freezes the original page and writes nothing", async () => {
    const fixture = historicalFixture()
    const before = structuredClone(fixture.main)
    const body = fixture.bodies.get(skillPage)
    const result = await fixture.run(planRepair(skillPage, planOptions))
    expect(result.state).toBe("planned")
    expect(result.dry_run).toBe(true)
    expect(result.writes).toBe(0)
    expect(result.plan.skill_id).toBe("skill-historical")
    expect(result.plan.file_id).toBe(
      await fixture.run(nativeFileIdentity("skill-historical", "SKILL.md")),
    )
    expect(result.plan.preimage.body_sha256).toMatch(/^[a-f0-9]{64}$/u)
    if (result.plan.kind !== "historical_missing_main") throw new Error("Expected historical plan")
    expect(result.plan.facts.enabled).toBe(true)
    expect(result.plan.expected.notion_cas).toBe(false)
    expect(result.scopes).toEqual([
      "skill_page",
      "skill_inventory",
      "files",
      "records",
      "operations",
      "body",
    ])
    expect(result.next.argv).toEqual(
      repairApplyArgv({
        databaseId: library.skills.database_id,
        operationId: result.operation_id,
        page: skillPage,
        entry: "historical-missing-main",
      }),
    )
    expect(fixture.main).toEqual(before)
    expect(fixture.bodies.get(skillPage)).toBe(body)
    expect(fixture.writes()).toHaveLength(0)
    expect([...fixture.json.keys()].some((key) => key.startsWith("operations/"))).toBe(false)
    expect(recognizeRepairOperation(result.operation_id)).toEqual({
      family: "maintenance-repair",
      entry: "historical-missing-main",
      operation_id: result.operation_id,
    })
  })

  test("apply binds only the blank main file and preserves legal identity, body, URL, authors and enabled", async () => {
    const fixture = historicalFixture()
    const beforeFields = structuredClone(fixture.fields)
    const beforeBody = fixture.bodies.get(skillPage)
    const blocked = errorOf(
      await fixture.run(querySharedSkillIndex(library, skillPage).pipe(Effect.result)),
    )
    expect(blocked.code).toBe("SHARED_FILE_IDENTITY_MISSING")
    const planned = await fixture.run(planRepair(skillPage, planOptions))
    const applied = await fixture.run(
      applyRepair(planned.plan, {
        database: library.skills.database_id,
        operationId: planned.operation_id,
      }),
    )
    expect(applied.state).toBe("applied")
    expect(applied.verified).toBe(true)
    expect(applied.skill_id).toBe("skill-historical")
    expect(applied.enabled).toBe(true)
    expect(applied.enabled_unchanged).toBe(true)
    expect(applied.page_recreated).toBe(false)
    expect(text(property(fixture.fields.skill_id).rich_text)).toBe("skill-historical")
    expect(text(property(fixture.fields.main_file_id).rich_text)).toBe(planned.plan.file_id)
    expect(property(fixture.fields.enabled).checkbox).toBe(true)
    expect(fixture.main.url).toBe(`https://www.notion.so/${skillPage.replaceAll("-", "")}`)
    expect(fixture.main.created_by).toEqual({ object: "user", id: id(42) })
    expect(fixture.bodies.get(skillPage)).toBe(beforeBody)
    for (const [key, value] of Object.entries(beforeFields))
      if (key !== "main_file_id") expect(fixture.fields[key]).toEqual(value)
    const patches = fixture.writes().filter((call) => call.method === "PATCH")
    expect(patches).toHaveLength(1)
    expect(Object.keys(property(property(patches[0]?.body).properties))).toEqual(["main_file_id"])
    expect(
      fixture
        .writes()
        .filter((call) => call.path === "v1/pages")
        .every(
          (call) =>
            property(property(call.body).parent).data_source_id === library.records.data_source_id,
        ),
    ).toBe(true)
    const indexed = await fixture.run(querySharedSkillIndex(library, skillPage))
    expect(indexed.enabled).toBe(true)
    expect(indexed.main.file_id).toBe(planned.plan.file_id)
    const records = fixture.records.size
    fixture.clearCalls()
    const repeated = await fixture.run(
      applyRepair(planned.plan, {
        database: library.skills.database_id,
        operationId: planned.operation_id,
      }),
    )
    expect(repeated.state).toBe("reconciled")
    expect(fixture.records.size).toBe(records)
    expect(fixture.writes()).toHaveLength(0)
    const shown = await fixture.run(showRepair(planned.operation_id))
    expect(shown.verified).toBe(true)
    expect(shown.manufactured_ack).toBe(false)
    fixture.clearCalls()
    const reconciled = await fixture.run(reconcileRepair(planned.operation_id))
    expect(reconciled.state).toBe("reconciled")
    expect(fixture.writes()).toHaveLength(0)
  })

  test("blank disabled drafts stay on adopt and partial pages are not cleared", async () => {
    const fixture = historicalFixture()
    const refused = errorOf(
      await fixture.run(
        adoptSharedNative(skillPage, { database: library.skills.database_id }).pipe(Effect.result),
      ),
    )
    expect(refused.code).toBe("SHARED_ADOPTION_SCOPE")
    expect(text(property(fixture.fields.skill_id).rich_text)).toBe("skill-historical")
    expect(fixture.writes()).toHaveLength(0)
    fieldsBlank(fixture)
    const draft = errorOf(await fixture.run(planRepair(skillPage, planOptions).pipe(Effect.result)))
    expect(draft.code).toBe("REPAIR_ENTRY")
    expect(text(property(fixture.fields.skill_id).rich_text)).toBe("")
    expect(fixture.readBodyCount()).toBe(0)
    expect(fixture.writes()).toHaveLength(0)
  })

  test("partial metadata, archive, wrong scope, nonempty binding, clone, permission, files and unknown operations reject before writes", async () => {
    const partial = historicalFixture()
    delete partial.main.created_by
    expect(
      errorOf(await partial.run(planRepair(skillPage, planOptions).pipe(Effect.result))).code,
    ).toBe("REPAIR_PARTIAL")
    expect(partial.readBodyCount()).toBe(0)
    expect(partial.writes()).toHaveLength(0)

    const archived = historicalFixture()
    archived.main.in_trash = true
    expect(
      errorOf(await archived.run(planRepair(skillPage, planOptions).pipe(Effect.result))).code,
    ).toBe("REPAIR_ARCHIVED")
    expect(archived.readBodyCount()).toBe(0)

    const scope = historicalFixture()
    property(scope.main.parent).data_source_id = library.files.data_source_id
    expect(
      errorOf(await scope.run(planRepair(skillPage, planOptions).pipe(Effect.result))).code,
    ).toBe("REPAIR_SCOPE")

    const bound = historicalFixture()
    bound.fields.main_file_id = rich("main_file_id", "file-already")
    expect(
      errorOf(await bound.run(planRepair(skillPage, planOptions).pipe(Effect.result))).code,
    ).toBe("REPAIR_BOUND")
    expect(text(property(bound.fields.main_file_id).rich_text)).toBe("file-already")
    expect(bound.writes()).toHaveLength(0)

    const clone = historicalFixture()
    const other = structuredClone(clone.main)
    other.id = id(99)
    clone.setSkills([clone.main, other])
    const cloneError = errorOf(
      await clone.run(planRepair(skillPage, planOptions).pipe(Effect.result)),
    )
    expect(cloneError.code).toBe("REPAIR_CLONE")
    expect(property(cloneError.details).pages).toEqual([skillPage, id(99)])
    expect(text(property(clone.fields.skill_id).rich_text)).toBe("skill-historical")
    expect(clone.writes()).toHaveLength(0)

    const denied = historicalFixture()
    denied.denyFiles()
    const permission = errorOf(
      await denied.run(planRepair(skillPage, planOptions).pipe(Effect.result)),
    )
    expect(permission.code).toBe("REPAIR_PERMISSION")
    expect(property(permission.details).cause_code).toBe("ACCESS_DENIED")
    expect(property(permission.details).scope).toBe("files")
    expect(denied.writes()).toHaveLength(0)

    const files = historicalFixture()
    files.files.push({
      object: "page",
      id: id(50),
      last_edited_time: String(files.main.last_edited_time),
      parent: {
        type: "data_source_id",
        data_source_id: library.files.data_source_id,
        database_id: library.files.database_id,
      },
      properties: {
        title: { id: "title", type: "title", title: [{ plain_text: "Main copy" }] },
        file_id: rich("file_id", "file-other"),
        path: rich("path", "SKILL.md"),
        projection: rich("projection", ""),
        status: { id: "status", type: "select", select: { name: "custom" } },
        skill: { id: "skill", type: "relation", relation: [{ id: skillPage }], has_more: false },
      },
    })
    expect(
      errorOf(await files.run(planRepair(skillPage, planOptions).pipe(Effect.result))).code,
    ).toBe("REPAIR_CONFLICT")
    expect(files.writes()).toHaveLength(0)

    const records = historicalFixture()
    records.seedFact(
      { original: true },
      "operation",
      "native-adoptions-v1",
      `skill-adopt-${"ab".repeat(32)}`,
    )
    const unknown = errorOf(
      await records.run(planRepair(skillPage, planOptions).pipe(Effect.result)),
    )
    expect(unknown.code).toBe("REPAIR_UNKNOWN_OPERATION")
    expect(property(unknown.details).record_id).toBe(`skill-adopt-${"ab".repeat(32)}`)
    expect(records.writes()).toHaveLength(0)
  })

  test("changed body or frontier rejects before writes", async () => {
    const body = historicalFixture()
    const planned = await body.run(planRepair(skillPage, planOptions))
    body.bodies.set(skillPage, "# Changed\n")
    const changed = errorOf(
      await body.run(
        applyRepair(planned.plan, {
          database: library.skills.database_id,
          operationId: planned.operation_id,
        }).pipe(Effect.result),
      ),
    )
    expect(changed.code).toBe("WRITE_CONFLICT")
    expect(body.writes()).toHaveLength(0)
    expect(text(property(body.fields.main_file_id).rich_text)).toBe("")

    const frontier = historicalFixture()
    const frozen = await frontier.run(planRepair(skillPage, planOptions))
    frontier.main.last_edited_time = new Date(Date.now() + 60_000).toISOString()
    expect(
      errorOf(
        await frontier.run(
          applyRepair(frozen.plan, {
            database: library.skills.database_id,
            operationId: frozen.operation_id,
          }).pipe(Effect.result),
        ),
      ).code,
    ).toBe("WRITE_CONFLICT")
    expect(frontier.writes()).toHaveLength(0)
  })

  test("a lost PATCH is not redispatched and current equality cannot manufacture an ACK", async () => {
    const fixture = historicalFixture()
    const planned = await fixture.run(planRepair(skillPage, planOptions))
    fixture.armLostPatch()
    const lost = errorOf(
      await fixture.run(
        applyRepair(planned.plan, {
          database: library.skills.database_id,
          operationId: planned.operation_id,
        }).pipe(Effect.result),
      ),
    )
    expect(lost.code).toBe("WRITE_OUTCOME_UNKNOWN")
    expect(property(lost.details).manufactured_ack).toBe(false)
    expect(fixture.writes().filter((call) => call.method === "PATCH")).toHaveLength(1)
    expect(text(property(fixture.fields.main_file_id).rich_text)).toBe(planned.plan.file_id)
    expect(fixture.bodies.get(skillPage)).toBe("# Native main\n")
    const patches = fixture.writes().filter((call) => call.method === "PATCH").length
    const posts = fixture.writes().filter((call) => call.path === "v1/pages").length
    const again = errorOf(
      await fixture.run(
        applyRepair(planned.plan, {
          database: library.skills.database_id,
          operationId: planned.operation_id,
        }).pipe(Effect.result),
      ),
    )
    expect(again.code).toBe("SHARED_CREATE_DISPATCH_UNKNOWN")
    expect(property(again.details).manufactured_ack).toBe(false)
    const againDetails = property(again.details)
    expect(againDetails.next && property(againDetails.next).argv).toEqual([
      "ntn-skills",
      "ctl",
      "repair",
      "reconcile",
      planned.operation_id,
      "--database",
      library.skills.database_id,
      "--page",
      skillPage,
    ])
    expect(fixture.writes().filter((call) => call.method === "PATCH")).toHaveLength(patches)
    expect(fixture.writes().filter((call) => call.path === "v1/pages")).toHaveLength(posts)
    expect(
      [...fixture.records.values()].some((row) =>
        text(property(property(row.properties).record).rich_text).startsWith("outcome-"),
      ),
    ).toBe(false)
    fixture.clearCalls()
    const reconciled = errorOf(
      await fixture.run(reconcileRepair(planned.operation_id).pipe(Effect.result)),
    )
    expect(reconciled.code).toBe("SHARED_CREATE_DISPATCH_UNKNOWN")
    expect(fixture.writes()).toHaveLength(0)
  })

  test("a lost record POST is not sent again from a later execution", async () => {
    const fixture = historicalFixture()
    const planned = await fixture.run(planRepair(skillPage, planOptions))
    fixture.unknownRecord("operation", false)
    const lost = errorOf(
      await fixture.run(
        applyRepair(planned.plan, {
          database: library.skills.database_id,
          operationId: planned.operation_id,
        }).pipe(Effect.result),
      ),
    )
    expect(lost.code).toBe("WRITE_OUTCOME_UNKNOWN")
    expect(fixture.writes().filter((call) => call.path === "v1/pages")).toHaveLength(1)
    expect(fixture.writes().filter((call) => call.method === "PATCH")).toHaveLength(0)
    const again = errorOf(
      await fixture.run(
        applyRepair(planned.plan, {
          database: library.skills.database_id,
          operationId: planned.operation_id,
        }).pipe(Effect.result),
      ),
    )
    expect(again.code).toBe("REPAIR_RECORD_UNKNOWN")
    expect(fixture.writes().filter((call) => call.path === "v1/pages")).toHaveLength(1)
    expect(text(property(fixture.fields.main_file_id).rich_text)).toBe("")
  })

  test("repair-all and a different operation id are refused", async () => {
    const fixture = historicalFixture()
    expect(
      errorOf(await fixture.run(planRepair("all", planOptions).pipe(Effect.result))).code,
    ).toBe("INVALID_ARGUMENT")
    const planned = await fixture.run(planRepair(skillPage, planOptions))
    const wrong = errorOf(
      await fixture.run(
        applyRepair(planned.plan, {
          database: library.skills.database_id,
          operationId: `skill-repair-main-${"cd".repeat(32)}`,
        }).pipe(Effect.result),
      ),
    )
    expect(wrong.code).toBe("REPAIR_PARTIAL")
    expect(fixture.writes()).toHaveLength(0)
    expect(recognizeRepairOperation(`skill-adopt-${"ab".repeat(32)}`)).toBeUndefined()
  })

  test("a 32-byte body and a 32-byte empty main binding keep the page, metadata, enabled state and original history", async () => {
    const fixture = historicalFixture()
    const body = "0123456789abcdef0123456789abcdef"
    expect(new TextEncoder().encode(body).byteLength).toBe(32)
    fixture.bodies.set(skillPage, body)
    fixture.fields.main_file_id = rich("main_file_id", "\u0000".repeat(32))
    const historyPlan = `skill-adopt-${"ab".repeat(32)}`
    const historyOutcome = `outcome-${historyPlan}`
    fixture.seedFact(
      { kept: true },
      "operation",
      "native-adoptions-v1",
      historyOutcome,
      historyPlan,
    )
    fixture.seedFact({ kept: true }, "operation", "native-adoptions-v1", historyPlan, historyPlan)
    const beforeIds = recordIds(fixture)
    const planned = await fixture.run(planRepair(skillPage, planOptions))
    const applied = await fixture.run(
      applyRepairByOperation({
        page: skillPage,
        entry: "historical-missing-main",
        operationId: planned.operation_id,
        database: library.skills.database_id,
      }),
    )
    expect(applied.verified).toBe(true)
    expect(applied.skill_page_id).toBe(skillPage)
    expect(fixture.bodies.get(skillPage)).toBe(body)
    expect(text(property(fixture.fields.skill_id).rich_text)).toBe("skill-historical")
    expect(property(fixture.fields.enabled).checkbox).toBe(true)
    expect(fixture.main.created_by).toEqual({ object: "user", id: id(42) })
    expect(recordIds(fixture)).toEqual(
      [
        ...beforeIds,
        `body-${planned.plan.preimage.body_sha256}`,
        planned.operation_id,
        `outcome-${planned.operation_id}`,
      ].sort(),
    )
  })

  test("an accepted plan response that was lost is not posted again", async () => {
    const fixture = historicalFixture()
    const planned = await fixture.run(planRepair(skillPage, planOptions))
    fixture.unknownRecord("operation", true)
    const lost = errorOf(
      await fixture.run(
        applyRepairByOperation({
          page: skillPage,
          entry: "historical-missing-main",
          operationId: planned.operation_id,
          database: library.skills.database_id,
        }).pipe(Effect.result),
      ),
    )
    expect(lost.code).toBe("WRITE_OUTCOME_UNKNOWN")
    const posts = fixture.writes().filter((call) => call.path === "v1/pages").length
    const continued = await fixture.run(
      applyRepairByOperation({
        page: skillPage,
        entry: "historical-missing-main",
        operationId: planned.operation_id,
        database: library.skills.database_id,
      }),
    )
    expect(continued.verified).toBe(true)
    const later = fixture
      .writes()
      .filter((call) => call.path === "v1/pages")
      .slice(posts)
    expect(
      later
        .map((call) => text(property(property(property(call.body).properties).record).rich_text))
        .sort(),
    ).toEqual(
      [`body-${planned.plan.preimage.body_sha256}`, `outcome-${planned.operation_id}`].sort(),
    )
    expect(recordIds(fixture).filter((id) => id === planned.operation_id)).toHaveLength(1)
  })

  test("a lost outcome leaves the skill unconsumed and blocks only that owner", async () => {
    const fixture = historicalFixture()
    const planned = await fixture.run(planRepair(skillPage, planOptions))
    fixture.loseOutcome()
    const lost = errorOf(
      await fixture.run(
        applyRepair(planned.plan, {
          database: library.skills.database_id,
          operationId: planned.operation_id,
        }).pipe(Effect.result),
      ),
    )
    expect(lost.code).toBe("WRITE_OUTCOME_UNKNOWN")
    expect(text(property(fixture.fields.main_file_id).rich_text)).toBe(planned.plan.file_id)
    const writes = fixture.writes().length
    const consumed = errorOf(
      await fixture.run(
        openSharedSnapshot({
          library,
          target: skillPage,
          scope: "repair-consumer",
          startedAt: 1,
        }).pipe(Effect.result),
      ),
    )
    expect(consumed.code).toBe("SHARED_REPAIR_PENDING")
    expect(property(consumed.details).skill_page_id).toBe(skillPage)
    expect(fixture.writes()).toHaveLength(writes)
    const keys = [...fixture.json.keys()]
    const shown = await fixture.run(
      showRepair(planned.operation_id, {
        database: library.skills.database_id,
        page: skillPage,
      }),
    )
    expect(shown.verified).toBe(false)
    expect(shown.outcome_retained).toBe(false)
    expect([...fixture.json.keys()]).toEqual(keys)
    const other = await fixture.run(
      loadPendingSharedRepairs(library, { skillPageId: id(80), headers: [] }),
    )
    expect(other).toEqual([])
    fixture.records.set(id(81), {
      object: "page",
      id: id(81),
      parent: {
        type: "data_source_id",
        data_source_id: library.records.data_source_id,
        database_id: library.records.database_id,
      },
      properties: {
        record: rich("record", `skill-adopt-${"cd".repeat(32)}`),
        kind: { id: "kind", type: "select", select: { name: "operation" } },
        entity: rich("entity", "native-adoptions-v1"),
        hash: rich("hash", "ab".repeat(32)),
        skill: {
          id: "skill",
          type: "relation",
          relation: [{ id: id(80) }],
          has_more: false,
        },
      },
    })
    const pending = await fixture.run(
      loadPendingSharedRepairs(library, { skillPageId: skillPage, headers: [] }),
    )
    expect(pending).toEqual([])
  })

  test("plan and reconcile do not write", async () => {
    const fixture = historicalFixture()
    const keys = [...fixture.json.keys()]
    const planned = await fixture.run(planRepair(skillPage, planOptions))
    expect([...fixture.json.keys()]).toEqual(keys)
    expect(fixture.writes()).toHaveLength(0)
    await fixture.run(
      applyRepairByOperation({
        page: skillPage,
        entry: "historical-missing-main",
        operationId: planned.operation_id,
        database: library.skills.database_id,
      }),
    )
    const after = [...fixture.json.keys()]
    fixture.clearCalls()
    await fixture.run(reconcileRepair(planned.operation_id))
    expect(fixture.writes()).toHaveLength(0)
    expect([...fixture.json.keys()]).toEqual(after)
  })
})

function recordIds(fixture: { records: Map<string, Record<string, unknown>> }) {
  return [...fixture.records.values()]
    .map((row) => text(property(property(row.properties).record).rich_text))
    .sort()
}

function fieldsBlank(fixture: ReturnType<typeof historicalFixture>) {
  fixture.fields.skill_id = rich("skill_id", "")
  property(fixture.fields.enabled).checkbox = false
}
