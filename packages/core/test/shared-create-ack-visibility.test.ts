import { expect, test } from "bun:test"
import { Effect } from "effect"
import { fail, property, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { executeSharedCreate, prepareSharedCreate } from "../src/shared-create.ts"
import { sharedCreateFixture } from "./shared-create-fixture.ts"
import { encode, id } from "./shared-snapshot-fixture.ts"

async function fixture() {
  const f = sharedCreateFixture()
  const plan = await f.run(
    prepareSharedCreate(f.library, {
      portable: {
        kind: "skill",
        name: "ack-visibility",
        description: "Confirmed native allocation",
        main: "SKILL.md",
        files: [
          {
            path: "SKILL.md",
            bytes: encode("# Main\n\n[Guide](references/guide.md)\n"),
            mode: "100644",
          },
          {
            path: "references/guide.md",
            bytes: encode("# Guide\n\nKeep the instructions.\n"),
            mode: "100644",
          },
        ],
      },
      completeResources: true,
      markdownImport: true,
    }),
  )
  let missingQueries = 0
  const execute = (interruptReadback = false, foreignCandidate = false) =>
    f.run(
      Effect.gen(function* () {
        const api = yield* Notion
        return yield* executeSharedCreate(f.library, { plan, mode: "create" }).pipe(
          Effect.provideService(Notion, {
            ...api,
            request: (path, body, options) =>
              Effect.suspend(() => {
                const query = property(property(body).filter)
                const exact =
                  (path.startsWith(`v1/data_sources/${f.library.skills.data_source_id}/query`) &&
                    query.property === f.library.skills.property_ids["Skill ID"]) ||
                  (path.startsWith(`v1/data_sources/${f.library.files.data_source_id}/query`) &&
                    query.property === f.library.files.property_ids["File ID"])
                if (exact && property(query.rich_text).equals !== undefined) {
                  missingQueries++
                  return Effect.succeed({
                    object: "list",
                    has_more: false,
                    next_cursor: null,
                    results: foreignCandidate ? [{ id: id(99001) }] : [],
                  })
                }
                if (
                  interruptReadback &&
                  [...f.skills.values()].some(
                    (row) =>
                      path === `v1/pages/${row.id}` &&
                      text(property(property(row.properties).skill_id).rich_text) === plan.skill_id,
                  )
                )
                  return Effect.fail(
                    fail("READ_INTERRUPTED", "The original creation is already acknowledged."),
                  )
                return api.request(path, body, options)
              }),
          }),
        )
      }),
    )
  return { ...f, plan, execute, missingQueries: () => missingQueries }
}

test("acknowledged Skills and Files finish while exact identity queries have no visible rows", async () => {
  const f = await fixture()
  const result = await f.execute()
  expect(result.verified).toBe(true)
  expect(f.missingQueries()).toBeGreaterThanOrEqual(2)
  expect(f.nativeCreates()).toHaveLength(2)
  const before = f.writes().length
  expect((await f.execute()).reused).toBe(true)
  expect(f.writes()).toHaveLength(before)
})

test("an interrupted exact ACK read resumes without another native POST", async () => {
  const f = await fixture()
  await expect(f.execute(true)).rejects.toMatchObject({ code: "READ_INTERRUPTED" })
  expect(f.nativeCreates()).toHaveLength(1)
  const main = [...f.skills.values()].find(
    (row) => text(property(property(row.properties).skill_id).rich_text) === f.plan.skill_id,
  )
  if (typeof main?.id !== "string") throw new Error("Expected the acknowledged original page")
  const completed = await f.execute()
  expect(completed.skill_page_id).toBe(main.id)
  expect(completed.verified).toBe(true)
  expect(f.nativeCreates()).toHaveLength(2)
})

test("an identity query pointing elsewhere cannot replace the acknowledged page", async () => {
  const f = await fixture()
  await expect(f.execute(false, true)).rejects.toMatchObject({ code: "SHARED_CREATE_SCOPE" })
  expect(f.nativeCreates()).toHaveLength(1)
})

test("unknown creation outcomes still cannot use index visibility as a substitute for an ACK", async () => {
  const f = await fixture()
  f.unknown("skill", true)
  await expect(f.execute()).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
  await expect(f.execute()).rejects.toThrow()
  expect(f.nativeCreates()).toHaveLength(1)
})
