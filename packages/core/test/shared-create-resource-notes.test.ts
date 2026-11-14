import { expect, test } from "bun:test"
import { Effect } from "effect"
import { authScope } from "../src/catalog.ts"
import { property, text } from "../src/model.ts"
import { equivalentResourceNote } from "../src/shared-create-resources.ts"
import {
  executeSharedCreate,
  prepareSharedCreate,
  reconcileSharedCreate,
} from "../src/shared-create.ts"
import { openSharedConsumer } from "../src/shared-consumer.ts"
import { canonicalSharedJson, querySharedRecords } from "../src/shared-records.ts"
import { createLibrary, sharedCreateFixture } from "./shared-create-fixture.ts"
import { encode } from "./shared-snapshot-fixture.ts"

const portable = {
  kind: "skill" as const,
  name: "resource-notes",
  description: "Exact resources",
  main: "SKILL.md",
  files: [
    {
      path: "SKILL.md",
      bytes: encode("---\nname: resource-notes\ndescription: Exact resources\n---\n\n# Main\n"),
    },
    {
      path: "tests/a.sh",
      bytes: encode("#!/bin/sh\necho do-not-execute\n"),
      mode: "100755" as const,
    },
    { path: "tests/b.bin", bytes: new Uint8Array([0, 255, 1]) },
  ],
}
const readback = (wire: string) =>
  wire
    .replace(/^<h1>([^\n]*)<\/h1>/u, "# $1")
    .replace(/^# tests\/a.sh/u, "# tests/[a.sh](http://a.sh)")

test("only exact automatic resource-note heading links are presentation, not arbitrary edits", () => {
  const expected = "# tests/a.sh\n\nSHA-256: exact\nBytes: 12\nMode: 100755"
  expect(equivalentResourceNote(expected.replace("a.sh", "[a.sh](http://a.sh)"), expected)).toBe(
    true,
  )
  for (const changed of [
    expected.replace("a.sh", "[a.sh](https://evil.test)"),
    expected.replace("exact", "changed"),
    expected + "\nextra",
  ])
    expect(equivalentResourceNote(changed, expected)).toBe(false)
})

test("public complete create tolerates generated resource autolinks while retaining exact bytes", async () => {
  const f = sharedCreateFixture({ readback })
  const plan = await f.run(
    prepareSharedCreate(createLibrary, { portable, completeResources: true }),
  )
  const result = await f.run(executeSharedCreate(createLibrary, { plan, mode: "create" }))
  expect(result.verified).toBe(true)
  expect(f.nativeCreates()).toHaveLength(3)
  expect((await f.run(reconcileSharedCreate(createLibrary, plan))).verified).toBe(true)
})

test("a known resource-note failure resumes the original ACK prefix without rewriting its old failure", async () => {
  const f = sharedCreateFixture({ readback })
  const plan = await f.run(
    prepareSharedCreate(createLibrary, { portable, completeResources: true }),
  )
  f.onCreate((row, kind) => {
    if (kind === "file" && text(property(property(row.properties).path).rich_text) === "tests/a.sh")
      f.base.bodies.set(
        String(row.id),
        f.base.bodies.get(String(row.id)) + "\nUnreviewed extra text",
      )
  })
  const failed = await f.run(
    Effect.flip(executeSharedCreate(createLibrary, { plan, mode: "create" })),
  )
  expect(failed.code).toBe("SHARED_CREATE_BODY_MISMATCH")
  const main = String(property(failed.details).skill_page_id)
  const outcomes = () =>
    f.run(
      querySharedRecords(createLibrary, {
        skillPageId: main,
        kind: "operation",
        recordId: "outcome-" + plan.operation_id,
      }),
    )
  const before = canonicalSharedJson(await outcomes()),
    created = f.nativeCreates().length
  expect(created).toBe(2)
  // Author restores the same generated note; source bytes, old result and ACKs
  // remain original. An unknown original create has no such authority.
  for (const [page, body] of f.base.bodies)
    if (body.endsWith("\nUnreviewed extra text"))
      f.base.bodies.set(page, body.replace(/\nUnreviewed extra text$/u, ""))
  f.onCreate(() => {})
  const result = await f.run(executeSharedCreate(createLibrary, { plan, mode: "create" }))
  expect(result.skill_page_id).toBe(main)
  expect(f.nativeCreates()).toHaveLength(3)
  expect(canonicalSharedJson(await outcomes())).toBe(before)
  f.base.json.clear()
  f.base.objects.clear()
  f.clear()
  f.credential("cold-resource-note-reader")
  const current = await f.run(
    Effect.gen(function* () {
      return yield* openSharedConsumer({
        library: createLibrary,
        target: main,
        scope: yield* authScope,
        startedAt: Date.now(),
        readOnly: true,
        forceFull: true,
      })
    }),
  )
  expect(current.files.map((file) => file.path).sort()).toEqual([
    "SKILL.md",
    "tests/a.sh",
    "tests/b.bin",
  ])
  expect(current.files.find((file) => file.path === "tests/a.sh")?.mode).toBe("100755")
  expect(f.writes()).toHaveLength(0)
}, 30000)
