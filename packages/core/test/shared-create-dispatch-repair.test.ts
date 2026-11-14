import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { fail, property, SkillsError, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { sharedCreateDispatch } from "../src/shared-create-dispatch.ts"
import { id, library, rich, sharedSnapshotFixture, skillPage } from "./shared-snapshot-fixture.ts"

function errorOf(result: { readonly _tag: string; readonly failure?: unknown }) {
  if (result._tag !== "Failure" || !(result.failure instanceof SkillsError))
    throw new Error("Expected SkillsError")
  return result.failure
}

function dispatchFixture() {
  const base = sharedSnapshotFixture({ fileCount: 1 })
  const fields = property(base.main.properties)
  const user = id(42)
  base.main.url = `https://www.notion.so/${skillPage.replaceAll("-", "")}`
  base.main.created_time = base.main.last_edited_time
  base.main.created_by = { object: "user", id: user }
  base.main.last_edited_by = { object: "user", id: user }
  fields.skill_id = rich("skill_id", "skill-historical")
  fields.main_file_id = rich("main_file_id", "")
  let losePatch = false
  const run = <A, E>(effect: Effect.Effect<A, E, any>) =>
    base.run(
      Effect.gen(function* () {
        const original = yield* Notion
        return yield* effect.pipe(
          Effect.provideService(Notion, {
            ...original,
            request: (path, body, options) => {
              const method = options?.method ?? (body === undefined ? "GET" : "POST")
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
    patches: () => base.calls.filter((call) => call.method === "PATCH"),
  }
}

const operationId = `skill-repair-main-${"ab".repeat(32)}`
const fileId = `file-${"cd".repeat(32)}`

describe("sharedCreateDispatch repair binding", () => {
  test("creation still rejects a Main File ID patch", async () => {
    const fixture = dispatchFixture()
    const error = errorOf(
      await fixture.run(
        Effect.gen(function* () {
          const dispatch = yield* sharedCreateDispatch(library, {
            operation_id: `skill-create-${"ab".repeat(32)}`,
            skill_id: "skill-historical",
          })
          return yield* dispatch.api.request(
            `v1/pages/${skillPage}`,
            {
              properties: {
                [library.skills.property_ids["Main File ID"]!]: {
                  rich_text: [{ type: "text", text: { content: fileId } }],
                },
              },
            },
            { method: "PATCH" },
          )
        }).pipe(Effect.result),
      ),
    )
    expect(error.code).toBe("SHARED_CREATE_SCOPE")
    expect(fixture.patches()).toHaveLength(0)
    expect([...fixture.json.keys()].some((key) => key.includes("source-op-"))).toBe(false)
    expect(text(property(fixture.fields.main_file_id).rich_text)).toBe("")
  })

  test("repair binding does not create a page", async () => {
    const fixture = dispatchFixture()
    const error = errorOf(
      await fixture.run(
        Effect.gen(function* () {
          const dispatch = yield* sharedCreateDispatch(library, {
            operation_id: operationId,
            skill_id: "skill-historical",
            repair_binding: {
              kind: "historical_missing_main",
              skill_page_id: skillPage,
              file_id: fileId,
            },
          })
          return yield* dispatch.api.request(
            "v1/pages",
            {
              parent: { type: "data_source_id", data_source_id: library.skills.data_source_id },
              properties: {},
            },
            { method: "POST" },
          )
        }).pipe(Effect.result),
      ),
    )
    expect(error.code).toBe("SHARED_CREATE_SCOPE")
    expect(error.message).toContain("does not create a page")
    expect(fixture.calls.filter((call) => call.path === "v1/pages")).toHaveLength(0)
    expect(fixture.patches()).toHaveLength(0)
  })

  test("a matching current Main File ID does not acknowledge a lost PATCH", async () => {
    const fixture = dispatchFixture()
    const patch = {
      properties: {
        [library.skills.property_ids["Main File ID"]!]: {
          rich_text: [{ type: "text", text: { content: fileId } }],
        },
      },
    }
    const send = Effect.gen(function* () {
      const dispatch = yield* sharedCreateDispatch(library, {
        operation_id: operationId,
        skill_id: "skill-historical",
        repair_binding: {
          kind: "historical_missing_main",
          skill_page_id: skillPage,
          file_id: fileId,
        },
      })
      return yield* dispatch.api.request(`v1/pages/${skillPage}`, patch, { method: "PATCH" })
    })
    fixture.armLostPatch()
    const lost = errorOf(await fixture.run(send.pipe(Effect.result)))
    expect(lost.code).toBe("WRITE_OUTCOME_UNKNOWN")
    expect(text(property(fixture.fields.main_file_id).rich_text)).toBe(fileId)
    const again = errorOf(await fixture.run(send.pipe(Effect.result)))
    expect(again.code).toBe("SHARED_CREATE_DISPATCH_UNKNOWN")
    expect(property(again.details).operation_id).toBe(operationId)
    expect(fixture.patches()).toHaveLength(1)
  })
})
