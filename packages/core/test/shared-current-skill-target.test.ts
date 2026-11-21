import { afterAll, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { trashPath } from "../src/local-locks.ts"
import { Notion } from "../src/notion.ts"
import { assertNoCurrentSourceContribution } from "../src/shared-current-skill-target.ts"
import { createCurrentNotionSkill } from "../src/shared-current-skill.ts"
import { prepareCurrentSkillWrite } from "../src/shared-current-write.ts"
import { currentWriteFixture, library, testBytes } from "./shared-current-write-fixture.ts"

const root = mkdtempSync(join(tmpdir(), "ntn-native-source-guard-"))
afterAll(async () => {
  if (process.platform === "darwin") await Effect.runPromise(trashPath(root))
})
const rich = (value: string) => ({
  rich_text: value ? [{ type: "text", text: { content: value } }] : [],
})
async function source(f: ReturnType<typeof currentWriteFixture>, encoded: string) {
  const fields = library.sources.property_ids
  await f.run(
    Effect.flatMap(Notion, (api) =>
      api.request(
        "v1/pages",
        {
          parent: { type: "data_source_id", data_source_id: library.sources.data_source_id },
          properties: {
            [fields.Name!]: { title: [{ type: "text", text: { content: "Unrelated Source" } }] },
            [fields["Source ID"]!]: rich("unrelated-" + f.table("sources").length),
            [fields.Status!]: { select: { name: "ready" } },
            [fields.Contributions!]: rich(encoded),
          },
        },
        { method: "POST" },
      ),
    ),
  )
  f.clearCalls()
}

test("empty unrelated Source contributions do not make native creation a library migration", async () => {
  const f = currentWriteFixture(root)
  await source(f, "")
  await source(f, "[]")
  const plan = await f.run(
    prepareCurrentSkillWrite({
      skill_id: "new-native",
      kind: "skill",
      name: "New native",
      description: "Author native content",
      files: [
        { path: "SKILL.md", bytes: testBytes("# New native\n"), authority: { kind: "native" } },
      ],
    }),
  )
  const result = await f.run(createCurrentNotionSkill(library, { plan }))
  expect(result).toMatchObject({ state: "ready" })
  expect(f.table("sources")).toHaveLength(2)
  expect(
    f.calls
      .filter((call) => call.path.includes(library.sources.data_source_id + "/query"))
      .every(
        (call) =>
          new URL(call.path, "https://api.notion.com").searchParams
            .getAll("filter_properties")
            .join() === library.sources.property_ids.Contributions,
      ),
  ).toBe(true)
  f.clearCalls()
  await f.run(createCurrentNotionSkill(library, { plan }))
  expect(f.mutations()).toEqual([])
})

test("a current Source declaration still protects its target when all reading rows are absent", async () => {
  const f = currentWriteFixture(root)
  await source(
    f,
    JSON.stringify([
      { member_key: "skills/target", skill_id: "target", mount_path: "", mapping: {}, exclude: [] },
    ]),
  )
  await expect(f.run(assertNoCurrentSourceContribution(library, "target"))).rejects.toMatchObject({
    code: "CURRENT_SOURCE_MANAGEMENT_REQUIRED",
  })
  expect(f.mutations()).toEqual([])
  await f.run(assertNoCurrentSourceContribution(library, "different"))
  expect(f.mutations()).toEqual([])
})

test("nonempty malformed declarations never become a false negative authority observation", async () => {
  const f = currentWriteFixture(root)
  await source(f, '{"skill_id":')
  await expect(f.run(assertNoCurrentSourceContribution(library, "target"))).rejects.toMatchObject({
    code: "CURRENT_SKILL_MANAGEMENT_CONFLICT",
  })
  expect(f.mutations()).toEqual([])
})
