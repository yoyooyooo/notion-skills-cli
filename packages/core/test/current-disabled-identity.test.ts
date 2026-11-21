import { expect, test } from "bun:test"
import { Effect } from "effect"
import { catalog } from "../src/catalog.ts"
import { consume } from "../src/consumer.ts"
import { SkillsError } from "../src/model.ts"
import { parseTarget } from "../src/ref.ts"
import { targetSnapshot } from "../src/snapshot.ts"
import { currentSnapshotFixture, currentLibrary as library } from "./shared-current-fixture.ts"

function disabledFixture() {
  const f = currentSnapshotFixture()
  f.main.properties.Enabled.checkbox = false
  return f
}
const id = `shared_skill:${library.library_id}:demo`
const ref = "skill://" + encodeURIComponent(id) + "/SKILL.md"

test("a cold exact shared identity reports disabled instead of confusing directory omission with absence", async () => {
  const f = disabledFixture()
  const directory = await f.run(catalog({ database: library.skills.database_id, refresh: true }))
  expect(directory.records.some((record) => record.id === id)).toBe(false)
  f.clearCalls()
  const result = await f.run(
    consume(
      { version: 1, targets: [ref], purpose: "inspect", freshness: { policy: "refresh" } },
      { database: library.skills.database_id },
    ),
  )
  expect(result.status).toBe("failed")
  if (result.status !== "failed") throw new Error("Expected current rejection")
  expect(result.error.code).toBe("CONTENT_DISABLED")
  expect(f.bodyCalls().length).toBe(0)
  expect(f.semanticWrites().length).toBe(0)
  expect(
    f.calls.filter((call) =>
      call.path.startsWith(`v1/data_sources/${library.skills.data_source_id}/query`),
    ),
  ).toHaveLength(1)
})

test("scalar current read uses the same exact identity while ordinary name discovery stays hidden", async () => {
  const f = disabledFixture()
  const exact = await f.run(
    targetSnapshot(parseTarget(ref), { database: library.skills.database_id, refresh: true }).pipe(
      Effect.result,
    ),
  )
  expect(exact._tag).toBe("Failure")
  if (exact._tag !== "Failure") throw new Error("Expected rejection")
  expect(exact.failure).toBeInstanceOf(SkillsError)
  expect(exact.failure.code).toBe("CONTENT_DISABLED")
  expect(f.bodyCalls().length).toBe(0)
  expect(f.semanticWrites().length).toBe(0)
  const name = await f.run(
    targetSnapshot(
      { selector: "Current demo" },
      { database: library.skills.database_id, refresh: true },
    ).pipe(Effect.result),
  )
  expect(name._tag).toBe("Failure")
  if (name._tag === "Failure") expect(name.failure.code).toBe("SKILL_NOT_FOUND")
})
