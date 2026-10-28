import { afterAll, expect, test } from "bun:test"
import { Effect } from "effect"
import { configureCachePolicy } from "../src/cache.ts"
import { exportSkill } from "../src/export.ts"
import { readImportZip } from "../src/import.ts"
import { fail, property } from "../src/model.ts"
import { createSkill } from "../src/mutation.ts"
import { Notion } from "../src/notion.ts"
import { readPortable } from "../src/portable.ts"
import { readSkill } from "../src/snapshot.ts"
import {
  closeFixtureServers,
  database,
  encoder,
  fixture,
  root,
} from "./reference-import.fixture.ts"

afterAll(closeFixtureServers)
const changedTime = "2026-10-28T01:00:00.000Z"
const script = "print('complete source resource')\n"
const policy = { database }
const content = (value: Effect.Success<ReturnType<typeof readSkill>>) => {
  if (!("content" in value)) throw new Error("Expected a text read, not a file output")
  return value.content
}

async function published() {
  const f = fixture(undefined, true, undefined, false, true)
  f.input.set("scripts/check.py", encoder.encode(script))
  await f.run(createSkill("/input", policy))
  await f.run(configureCachePolicy({ readMaxAge: 0 }))
  // The first consumer validates the full published body/file graph; it cannot borrow a receipt.
  const first = await f.run(readSkill(root, policy))
  expect([...f.reads.keys()].some((path) => path.endsWith("/markdown"))).toBe(true)
  f.reads.clear()
  return { f, first }
}
const bodyReads = (reads: Map<string, number>) =>
  [...reads.keys()].filter((path) => path.endsWith("/markdown") || path.startsWith("v1/blocks/"))

async function editMain(f: ReturnType<typeof fixture>) {
  await f.run(
    Effect.gen(function* () {
      yield* (yield* Notion).request(
        `v1/pages/${root}/markdown`,
        {
          type: "replace_content",
          replace_content: {
            new_str: "# Changed instructions\n\nKeep this independent manual edit.\n",
          },
        },
        { method: "PATCH" },
      )
    }),
  )
}

test("ordinary native consumption reuses aligned complete files after metadata checks, including source export", async () => {
  const { f, first } = await published()
  const fast = await f.run(readSkill(root, policy))
  expect(fast.snapshot_id).toBe(first.snapshot_id)
  expect(content(fast)).toBe(content(first))
  expect(fast.freshness?.validation).toBe("metadata")
  expect(bodyReads(f.reads)).toEqual([])
  const resource = await f.run(readSkill(fast.snapshot_id, { ...policy, path: "scripts/check.py" }))
  expect(content(resource)).toBe(script)
  const exported = await f.run(exportSkill(root, { ...policy, output: "/export/source.zip" }))
  expect(exported.freshness?.validation).toBe("metadata")
  const portable = readPortable(readImportZip(f.outputs.get("/export/source.zip")!))!
  expect(portable.files.map((file) => file.path).sort()).toEqual([...f.input.keys()].sort())
  for (const file of portable.files) expect(file.bytes).toEqual(f.input.get(file.path)!)
  expect(bodyReads(f.reads)).toEqual([])
})

for (const page of ["main", "reference"] as const) {
  test(`ordinary reads observe a stable ${page}-only edit and preserve the previous pin`, async () => {
    const { f, first } = await published()
    const path = page === "main" ? first.entrypoint : "references/guide.md"
    const previous = await f.run(readSkill(first.snapshot_id, { ...policy, path }))
    if (page === "main") await editMain(f)
    else f.children[0]!.body += "\nIndependent reference edit.\n"
    f.pageRevision(page === "main" ? root : f.children[0]!.id, changedTime)
    const mutations = f.mutations()
    const current = await f.run(readSkill(root, policy))
    expect(current.snapshot_id).not.toBe(first.snapshot_id)
    expect(current.freshness?.validation).not.toBe("metadata")
    const changed = await f.run(readSkill(current.snapshot_id, { ...policy, path }))
    expect(content(changed)).toContain(
      page === "main" ? "Keep this independent manual edit." : "Independent reference edit.",
    )
    expect(content(await f.run(readSkill(first.snapshot_id, { ...policy, path })))).toBe(
      content(previous),
    )
    expect(
      content(await f.run(readSkill(current.snapshot_id, { ...policy, path: "scripts/check.py" }))),
    ).toBe(script)
    expect(f.mutations()).toBe(mutations)
    expect([...f.reads.keys()].some((path) => path.endsWith("/markdown"))).toBe(true)
  })
}

for (const force of [{ refresh: true }, { maxAge: 0 }]) {
  test(`${JSON.stringify(force)} reads a stable same-timestamp reference edit instead of using its old ZIP`, async () => {
    const { f, first } = await published()
    const path = "references/guide.md"
    const previous = await f.run(readSkill(first.snapshot_id, { ...policy, path }))
    f.children[0]!.body += "\nChanged without a new reported timestamp.\n"
    const current = await f.run(readSkill(root, { ...policy, ...force }))
    expect(current.snapshot_id).not.toBe(first.snapshot_id)
    const changed = await f.run(readSkill(current.snapshot_id, { ...policy, path }))
    expect(content(changed)).toContain("Changed without a new reported timestamp.")
    expect(content(await f.run(readSkill(first.snapshot_id, { ...policy, path })))).toBe(
      content(previous),
    )
    expect([...f.reads.keys()].some((path) => path.endsWith("/markdown"))).toBe(true)
  })
}

test("ordinary metadata checks document the accepted same-timestamp limit while pinned history stays fixed", async () => {
  const { f, first } = await published()
  f.children[0]!.body += "\nA same-timestamp edit.\n"
  const cached = await f.run(readSkill(root, policy))
  expect(cached.freshness?.validation).toBe("metadata")
  expect(cached.snapshot_id).toBe(first.snapshot_id)
  expect(bodyReads(f.reads)).toEqual([])
  const strong = await f.run(readSkill(root, { ...policy, refresh: true }))
  expect(strong.snapshot_id).not.toBe(first.snapshot_id)
  expect(
    content(await f.run(readSkill(strong.snapshot_id, { ...policy, path: "references/guide.md" }))),
  ).toContain("A same-timestamp edit.")
  const history = await f.run(readSkill(first.snapshot_id, policy))
  expect(content(history)).toBe(content(first))
  expect(
    content(await f.run(readSkill(first.snapshot_id, { ...policy, path: "references/guide.md" }))),
  ).not.toContain("A same-timestamp edit.")
})

test("changed References inclusion defines the current files while the previous pin keeps its resources", async () => {
  const { f, first } = await published()
  const references = property(f.properties().References).rich_text as unknown[]
  const removed = property(references.pop())
  const path = String(property(removed.text).content)
  expect(path).toMatch(/^references\/.+\.md$/)
  const previous = await f.run(readSkill(first.snapshot_id, { ...policy, path }))
  const mutations = f.mutations()
  const current = await f.run(readSkill(root, policy))
  expect(current.snapshot_id).not.toBe(first.snapshot_id)
  const absent = await f.run(
    readSkill(current.snapshot_id, { ...policy, path }).pipe(Effect.result),
  )
  expect(absent._tag === "Failure" && absent.failure.code).toBe("FILE_NOT_FOUND")
  expect(content(await f.run(readSkill(first.snapshot_id, { ...policy, path })))).toBe(
    content(previous),
  )
  expect(
    content(await f.run(readSkill(current.snapshot_id, { ...policy, path: "scripts/check.py" }))),
  ).toBe(script)
  expect(f.mutations()).toBe(mutations)
  expect([...f.reads.keys()].some((path) => path.endsWith("/markdown"))).toBe(true)
})

test("signed attachment URL renewal reuses the validated package; replacement identity requires complete verification", async () => {
  const { f, first } = await published()
  f.rotateAttachmentUrl()
  const renewed = await f.run(readSkill(root, policy))
  expect(renewed.snapshot_id).toBe(first.snapshot_id)
  expect(renewed.freshness?.validation).toBe("metadata")
  expect(bodyReads(f.reads)).toEqual([])
  f.replaceAttachmentIdentity()
  f.reads.clear()
  const replacement = await f.run(readSkill(root, policy))
  expect(content(replacement)).toBe(content(first))
  expect(replacement.freshness?.validation).toBeUndefined()
  expect([...f.reads.keys()].some((path) => path.endsWith("/markdown"))).toBe(true)
})

test("a failed reference metadata read remains an error and does not return the old ZIP", async () => {
  const { f } = await published()
  const child = f.children[0]!.id
  const result = await f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      return yield* readSkill(root, policy).pipe(
        Effect.provideService(Notion, {
          ...api,
          request: (path, body, options) =>
            path === `v1/pages/${child}`
              ? Effect.fail(fail("ACCESS_DENIED", "Permission revoked"))
              : api.request(path, body, options),
        }),
        Effect.result,
      )
    }),
  )
  expect(result._tag === "Failure" && result.failure.code).toBe("ACCESS_DENIED")
  expect(bodyReads(f.reads)).toEqual([])
})
