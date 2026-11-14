import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { fail, property, SkillsError, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { nativeFileIdentity } from "../src/shared-native-adoption-model.ts"
import { applyRepair, planRepair, recognizeRepairOperation } from "../src/shared-native-repair.ts"
import { nativeRepairEntity } from "../src/shared-native-repair-model.ts"
import { openSharedSnapshot } from "../src/shared-snapshot.ts"
import { id, library, rich, sharedSnapshotFixture, skillPage } from "./shared-snapshot-fixture.ts"

function errorOf(result: { readonly _tag: string; readonly failure?: unknown }) {
  if (result._tag !== "Failure" || !(result.failure instanceof SkillsError))
    throw new Error("Expected SkillsError")
  return result.failure
}

const filePage = id(50)
const childPage = id(77)

function managedFixture() {
  const base = sharedSnapshotFixture({ fileCount: 1 })
  const user = id(42)
  const stamp = base.main.last_edited_time
  for (const page of [base.main]) {
    page.url = `https://www.notion.so/${String(page.id).replaceAll("-", "")}`
    page.created_time = String(stamp)
    page.created_by = { object: "user", id: user }
    page.last_edited_by = { object: "user", id: user }
  }
  const file = {
    object: "page",
    id: filePage,
    url: `https://www.notion.so/${filePage.replaceAll("-", "")}`,
    created_time: String(stamp),
    last_edited_time: String(stamp),
    created_by: { object: "user", id: user },
    last_edited_by: { object: "user", id: user },
    parent: {
      type: "data_source_id",
      data_source_id: library.files.data_source_id,
      database_id: library.files.database_id,
    },
    properties: {
      title: { id: "title", type: "title", title: [{ plain_text: "Hand note" }] },
      file_id: rich("file_id", ""),
      path: rich("path", "notes/hand.md"),
      projection: rich("projection", ""),
      status: { id: "status", type: "select", select: { name: "custom" } },
      skill: { id: "skill", type: "relation", relation: [{ id: skillPage }], has_more: false },
    },
  }
  base.files.push(file)
  base.bodies.set(filePage, "Hand authored note\n")
  const child = {
    object: "page",
    id: childPage,
    url: `https://www.notion.so/${childPage.replaceAll("-", "")}`,
    created_time: stamp,
    last_edited_time: stamp,
    created_by: { object: "user", id: user },
    last_edited_by: { object: "user", id: user },
    parent: { type: "page_id", page_id: skillPage },
    properties: {},
  }
  base.bodies.set(childPage, "# Child\n")
  const run = <A, E>(effect: Effect.Effect<A, E, any>) =>
    base.run(
      Effect.gen(function* () {
        const original = yield* Notion
        return yield* effect.pipe(
          Effect.provideService(Notion, {
            ...original,
            request: (path, body, options) => {
              const method = options?.method ?? (body === undefined ? "GET" : "POST")
              if (path === `v1/pages/${childPage}` && method === "GET")
                return Effect.succeed(structuredClone(child))
              if (path === `v1/pages/${filePage}` && method === "PATCH")
                return Effect.sync(() => {
                  base.calls.push({ path, method: "PATCH", body })
                  const fields = property(file.properties)
                  for (const [key, value] of Object.entries(property(property(body).properties)))
                    fields[key] = { ...property(fields[key]), ...property(value) }
                  return structuredClone(file)
                })
              return original.request(path, body, options)
            },
          }),
        )
      }),
    )
  return {
    ...base,
    file,
    child,
    run,
    writes: () => base.calls.filter((call) => call.method === "PATCH" || call.path === "v1/pages"),
  }
}

const managedOptions = {
  entry: "managed-file",
  database: library.skills.database_id,
  path: "notes/hand.md",
  owner: skillPage,
  dryRun: true,
}

describe("structural file adoption", () => {
  test("dry-run assigns a deterministic file identity without copying the body", async () => {
    const fixture = managedFixture()
    const before = fixture.bodies.get(filePage)
    const result = await fixture.run(planRepair(filePage, managedOptions))
    if (result.plan.kind !== "managed_file_adoption") throw new Error("Expected file plan")
    expect(result.plan.file_id).toBe(
      await fixture.run(nativeFileIdentity("stable-skill", "notes/hand.md")),
    )
    expect(result.plan.facts.file_id).toBe("")
    expect(result.plan.expected.page_recreated).toBe(false)
    expect(result.next.argv[0]).toBe("ntn-skills")
    expect(result.next.argv).not.toEqual(expect.arrayContaining(["repair-all"]))
    expect(fixture.bodies.get(filePage)).toBe(before)
    expect(fixture.writes()).toHaveLength(0)
    expect([...fixture.json.keys()].some((key) => key.startsWith("operations/"))).toBe(false)
    expect(recognizeRepairOperation(result.operation_id)?.entry).toBe("managed-file")
  })

  test("apply patches only the blank File ID on the same row", async () => {
    const fixture = managedFixture()
    const skillBefore = structuredClone(fixture.main)
    const planned = await fixture.run(planRepair(filePage, managedOptions))
    const applied = await fixture.run(
      applyRepair(planned.plan, {
        database: library.skills.database_id,
        operationId: planned.operation_id,
      }),
    )
    expect(applied.verified).toBe(true)
    expect(applied.file_page_id).toBe(filePage)
    expect(applied.page_recreated).toBe(false)
    expect(text(property(property(fixture.file.properties).file_id).rich_text)).toBe(
      planned.plan.file_id,
    )
    expect(fixture.bodies.get(filePage)).toBe("Hand authored note\n")
    expect(fixture.main).toEqual(skillBefore)
    const patches = fixture.writes().filter((call) => call.method === "PATCH")
    expect(patches).toHaveLength(1)
    expect(patches[0]?.path).toBe(`v1/pages/${filePage}`)
    expect(Object.keys(property(property(patches[0]?.body).properties))).toEqual(["file_id"])
    expect(fixture.files).toHaveLength(1)
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
  })

  test("foreign ids, multiple owners, entrypoint paths and ordinary child pages are not repaired destructively", async () => {
    const foreign = managedFixture()
    foreign.file.properties.file_id = rich("file_id", "file-foreign")
    const foreignError = errorOf(
      await foreign.run(planRepair(filePage, managedOptions).pipe(Effect.result)),
    )
    expect(foreignError.code).toBe("REPAIR_FOREIGN_ID")
    expect(property(foreignError.details).file_id).toBe("file-foreign")
    expect(text(property(foreign.file.properties.file_id).rich_text)).toBe("file-foreign")
    expect(foreign.writes()).toHaveLength(0)

    const owners = managedFixture()
    property(owners.file.properties.skill).relation = [{ id: skillPage }, { id: id(51) }]
    expect(
      errorOf(await owners.run(planRepair(filePage, managedOptions).pipe(Effect.result))).code,
    ).toBe("REPAIR_MULTIOWNER")
    expect(owners.writes()).toHaveLength(0)

    const entry = managedFixture()
    entry.file.properties.path = rich("path", "SKILL.md")
    expect(
      errorOf(
        await entry.run(
          planRepair(filePage, { ...managedOptions, path: "SKILL.md" }).pipe(Effect.result),
        ),
      ).code,
    ).toBe("REPAIR_CONFLICT")
    expect(entry.writes()).toHaveLength(0)

    const child = managedFixture()
    const paths: string[] = []
    const result = await child.run(
      Effect.gen(function* () {
        const original = yield* Notion
        return yield* planRepair(childPage, {
          entry: "ordinary-child",
          database: library.skills.database_id,
          dryRun: true,
        }).pipe(
          Effect.provideService(Notion, {
            ...original,
            request: (path, body, options) => {
              paths.push(path)
              return original.request(path, body, options)
            },
          }),
          Effect.result,
        )
      }),
    )
    const error = errorOf(result)
    expect(error.code).toBe("REPAIR_UNSUPPORTED")
    expect(property(error.details).branch).toBe("ordinary_child_page_same_page_placement")
    expect(property(error.details).descendants).toBe("not_crawled")
    expect(property(error.details).writes).toBe(0)
    expect(paths.some((path) => path.includes("/children") || path.includes("/blocks"))).toBe(false)
    expect(child.writes()).toHaveLength(0)
  })

  test("a File ID patch is not current-ready until its outcome exists", async () => {
    const fixture = managedFixture()
    const planned = await fixture.run(planRepair(filePage, managedOptions))
    fixture.seedFact(
      { plan: true },
      "operation",
      nativeRepairEntity,
      planned.operation_id,
      planned.operation_id,
    )
    property(property(fixture.file.properties).file_id).rich_text = [
      { type: "text", plain_text: planned.plan.file_id, text: { content: planned.plan.file_id } },
    ]
    const consumed = errorOf(
      await fixture.run(
        openSharedSnapshot({
          library,
          target: skillPage,
          scope: "file-adoption-consumer",
          startedAt: 1,
        }).pipe(Effect.result),
      ),
    )
    expect(consumed.code).toBe("SHARED_REPAIR_PENDING")
    expect(property(consumed.details).skill_page_id).toBe(skillPage)
    expect(fixture.writes()).toHaveLength(0)
  })
})
