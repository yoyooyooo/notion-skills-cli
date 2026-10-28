import { afterAll, expect, test } from "bun:test"
import { Effect } from "effect"
import { createPortable, replaceSkill, resumePublication } from "../src/mutation.ts"
import { listSkill, openSkill, readSkill } from "../src/snapshot.ts"
import { snapshotAuthoredPortable } from "../src/export.ts"
import { fail, property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { MARKDOWN_FILES_MARKER } from "../src/markdown-files.ts"
import {
  closeFixtureServers,
  database,
  root,
  encoder,
  fixture,
} from "./reference-import.fixture.ts"
import { reconcilePublication } from "../src/publication-reconcile.ts"

afterAll(closeFixtureServers)
for (const hasFiles of [false, true]) {
  test(`explicit native replacement converts literal source on the same page ${hasFiles ? "with binary resources" : "without Files"}`, async () => {
    const f = fixture(undefined, hasFiles, undefined, false, false, false, true)
    if (hasFiles) {
      const source = new TextDecoder().decode(f.input.get("SKILL.md")!)
      f.input.set(
        "SKILL.md",
        encoder.encode(
          source.replace(
            "description: Use for recovery.\n",
            "description: Use for recovery.\ncustom_frontmatter:\n  keep: exact-source\n",
          ),
        ),
      )
    }
    f.seedLiteral()
    const baseline = await f.run(openSkill(root, { database, refresh: true }))
    expect(baseline.markdown_files).toBeDefined()
    const unchanged = await f.run(replaceSkill("/input", { target: baseline, dryRun: true }))
    expect(unchanged).toMatchObject({ storage: "markdown_files", reused: true })
    if (hasFiles) f.input.set("assets/data.bin", new Uint8Array([0, 255, 7]))
    const result = await f.run(
      replaceSkill("/input", { target: baseline, storage: "notion_blocks" }),
    )
    expect(result).toMatchObject({
      verified: true,
      reused: false,
      action: "update",
      record: { id: `notion_page:${root}` },
    })
    const snapshot = await f.run(openSkill(root, { database, refresh: true }))
    expect(snapshot.markdown_files).toBeUndefined()
    expect(snapshot.references?.map((page) => page.path).sort()).toEqual([
      "SKILL.md",
      "references/guide.md",
      "references/policy.md",
    ])
    expect(snapshot.references?.find((page) => page.path === "SKILL.md")?.markdown).toContain(
      "# Sample",
    )
    expect(snapshot.references?.some((page) => page.markdown.includes(MARKDOWN_FILES_MARKER))).toBe(
      false,
    )
    expect(f.children.map((child) => child.title).sort()).toEqual(["guide.md", "policy.md"])
    const roots = await f.run(
      Effect.flatMap(Notion, (api) => api.request(`v1/blocks/${root}/children?page_size=100`)),
    )
    const blocks = property(roots).results as Array<Record<string, unknown>>
    expect(blocks.some((block) => block.type === "heading_1")).toBe(true)
    expect(blocks.some((block) => block.type === "toggle" || block.type === "code")).toBe(false)
    expect(property(f.properties()).defaultcontext).toEqual({
      id: "defaultcontext",
      type: "rich_text",
      rich_text: [
        {
          type: "text",
          text: { content: "Preserve this context" },
          plain_text: "Preserve this context",
        },
      ],
    })
    const main = await f.run(readSkill(snapshot.snapshot_id))
    expect("content" in main && main.content).toContain("# Sample")
    const guide = await f.run(readSkill(snapshot.snapshot_id, { path: "references/guide.md" }))
    expect("content" in guide && guide.content).toContain("[policy](./policy.md)")
    const exported = await f.run(snapshotAuthoredPortable(snapshot))
    expect(exported.files.map((file) => file.path).sort()).toEqual([...f.input.keys()].sort())
    if (hasFiles)
      for (const file of exported.files) expect(file.bytes).toEqual(f.input.get(file.path)!)
    if (hasFiles) {
      const listing = await f.run(listSkill(snapshot.snapshot_id))
      expect(listing.files.some((file) => file.path === "assets/data.bin")).toBe(true)
      await f.run(
        readSkill(snapshot.snapshot_id, { path: "assets/data.bin", output: "/output/data.bin" }),
      )
      expect(f.outputs.get("/output/data.bin")).toEqual(new Uint8Array([0, 255, 7]))
    }
    if (hasFiles) {
      expect(snapshot.files.some((file) => file.path === "assets/data.bin")).toBe(true)
      expect(exported.files.find((file) => file.path === "assets/data.bin")?.bytes).toEqual(
        new Uint8Array([0, 255, 7]),
      )
      expect(property(property(f.properties()).Files).files).toHaveLength(1)
    }
    const before = f.mutations()
    const reused = await f.run(
      replaceSkill("/input", { target: snapshot, storage: "notion_blocks" }),
    )
    expect(reused.action).toBe("reuse")
    expect(f.mutations()).toBe(before)
  })
}

for (const failure of ["body", "root_body"] as const) {
  test(`unknown literal conversion after ${failure} resumes its original operation without repeating the root write`, async () => {
    const f = fixture(failure, true, undefined, false, false, false, true)
    f.seedLiteral()
    f.input.set("assets/tool.sh", encoder.encode("#!/bin/sh\nprintf 'resource\\n'\n"))
    const stopped = await f.run(
      replaceSkill("/input", { database, target: root, storage: "notion_blocks" }).pipe(
        Effect.result,
      ),
    )
    if (stopped._tag !== "Failure")
      throw new Error("Expected response loss after converted reference write")
    expect(stopped.failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
    const operationId = String(property(stopped.failure.details).operation_id)
    const rootWrites = () =>
      f.receipt(operationId).intents.filter((intent) => intent.path === `v1/pages/${root}/markdown`)
    expect(rootWrites()).toHaveLength(1)
    const fresh = await f.run(
      replaceSkill("/input", { database, target: root, storage: "notion_blocks" }).pipe(
        Effect.result,
      ),
    )
    expect(fresh._tag === "Failure" && fresh.failure.code).toBe("PUBLICATION_INCOMPLETE")
    const resumed = await f.run(resumePublication(operationId))
    expect(resumed).toMatchObject({ verified: true, operation_id: operationId, resumed: true })
    expect(rootWrites()).toHaveLength(1)
    const snapshot = await f.run(openSkill(root, { refresh: true }))
    expect(snapshot.markdown_files).toBeUndefined()
    expect(
      (await f.run(snapshotAuthoredPortable(snapshot))).files.map((file) => file.path).sort(),
    ).toEqual([...f.input.keys()].sort())
  })
}
test("arbitrary source Markdown becomes clickable reference pages without moving paths", async () => {
  const f = fixture(undefined, true, undefined, false, false, false, true)
  const main =
    "---\nname: sample-skill\ndescription: Use for recovery.\n---\n\n# Sample\n\nRead [mocking](mocking.md) and [tests](tests.md) and [nested](docs/nested.md).\n"
  f.input.clear()
  f.input.set("SKILL.md", encoder.encode(main))
  f.input.set("mocking.md", encoder.encode("# Mocking\n\nKeep the exact mocking source.\n"))
  f.input.set("tests.md", encoder.encode("# Tests\n\nKeep the exact tests source.\n"))
  f.input.set("docs/nested.md", encoder.encode("# Nested\n\nKeep the exact nested source.\n"))
  f.input.set("scripts/setup.sh", encoder.encode("#!/bin/sh\nprintf 'keep\\n'\n"))
  f.seedLiteral()
  const result = await f.run(
    replaceSkill("/input", { database, target: root, storage: "notion_blocks" }),
  )
  expect(result).toMatchObject({ verified: true, record: { id: `notion_page:${root}` } })
  expect(f.children.map((child) => child.title).sort()).toEqual([
    "docs/nested.md",
    "mocking.md",
    "tests.md",
  ])
  const snapshot = await f.run(openSkill(root, { refresh: true }))
  expect(snapshot.references?.map((page) => page.path).sort()).toEqual([
    "SKILL.md",
    "docs/nested.md",
    "mocking.md",
    "tests.md",
  ])
  const exported = await f.run(snapshotAuthoredPortable(snapshot))
  expect(exported.files.map((file) => file.path).sort()).toEqual([...f.input.keys()].sort())
  for (const file of exported.files) expect(file.bytes).toEqual(f.input.get(file.path)!)
  const page = snapshot.references?.find((page) => page.path === "SKILL.md")!
  for (const path of ["mocking.md", "tests.md", "docs/nested.md"]) {
    const reference = snapshot.references!.find((reference) => reference.path === path)!
    expect(page.markdown).toContain(`https://www.notion.so/${reference.id.replaceAll("-", "")}`)
    const readback = await f.run(readSkill(snapshot.snapshot_id, { path }))
    expect(readback.path).toBe(path)
    expect("content" in readback && readback.content).toBe(
      new TextDecoder().decode(f.input.get(path)!),
    )
  }
})
test("reconcile and resume keep native nested reference paths and refuse external path drift", async () => {
  const f = fixture(undefined, false, undefined, false, false, false, true)
  const paths = ["README.md", "docs/nested.md", "elements/connectors.md"] as const
  const main =
    "---\nname: sample-skill\ndescription: Use for recovery.\n---\n\n# Sample\n\nRead [readme](README.md), [nested](docs/nested.md), and [connectors](elements/connectors.md).\n"
  f.input.clear()
  f.input.set("SKILL.md", encoder.encode(main))
  for (const path of paths) f.input.set(path, encoder.encode(`# ${path}\n\nKeep ${path}.\n`))
  f.seedLiteral()
  const created = await f.run(
    replaceSkill("/input", { database, target: root, storage: "notion_blocks" }),
  )
  const operationId = created.operation_id
  expect(f.children.map((child) => child.title).sort()).toEqual([...paths].sort())
  const writes = f.mutations()
  const reconciled = await f.run(reconcilePublication(operationId))
  expect(reconciled.outcome).toBe("success")
  expect(f.mutations()).toBe(writes)
  const resumed = await f.run(resumePublication(operationId))
  expect(resumed).toMatchObject({ verified: true, operation_id: operationId })
  expect(f.mutations()).toBe(writes)
  const snapshot = await f.run(openSkill(root, { refresh: true }))
  expect(snapshot.references?.map((page) => page.path).sort()).toEqual(
    ["SKILL.md", ...paths].sort(),
  )
  const exported = await f.run(snapshotAuthoredPortable(snapshot))
  expect(exported.files.map((file) => file.path).sort()).toEqual([...f.input.keys()].sort())
  const page = snapshot.references?.find((reference) => reference.path === "SKILL.md")!
  for (const path of paths) {
    const reference = snapshot.references!.find((item) => item.path === path)!
    expect(page.markdown).toContain(`https://www.notion.so/${reference.id.replaceAll("-", "")}`)
    expect(page.markdown).not.toContain(`references/${path}`)
    const readback = await f.run(readSkill(snapshot.snapshot_id, { path }))
    expect(readback.path).toBe(path)
  }
  const retained = f.children.find((child) => child.title === "docs/nested.md")!.title
  f.children.find((child) => child.title === "docs/nested.md")!.title = "other.md"
  const refused = await f.run(reconcilePublication(operationId))
  expect(refused.outcome).toBe("conflict")
  f.children.find((child) => child.title === "other.md")!.title = retained
})
test("nonblock allocation detects external nested code while block repair retains its inventory", async () => {
  const f = fixture(undefined, true, undefined, false, false, false, true)
  f.seedLiteral()
  const block = [...f.blocks.values()].find((block) => block.type === "code")!
  const changed = await f.run(
    replaceSkill("/input", {
      database,
      target: root,
      storage: "notion_blocks",
      onProgress: (event) =>
        Effect.sync(() => {
          if (event.stage.startsWith("create_reference:") && event.status === "started") {
            const code = property(block.code)
            code.rich_text = [
              {
                type: "text",
                text: { content: "externally changed nested code" },
                plain_text: "externally changed nested code",
              },
            ]
          }
        }),
    }).pipe(Effect.result),
  )
  expect(changed._tag === "Failure" && changed.failure.code).toBe("WRITE_CONFLICT")
  expect(f.blocks.has(String(block.id))).toBe(true)
})
test("alternate main colliding with the canonical entrypoint writes nothing", async () => {
  const f = fixture()
  const result = await f.run(
    createPortable(
      {
        kind: "skill",
        name: "sample-skill",
        description: "Use for recovery.",
        main: "docs/main.md",
        files: [
          { path: "docs/main.md", bytes: encoder.encode("# Sample\n") },
          { path: "SKILL.md", bytes: encoder.encode("# Existing source\n") },
        ],
      },
      { database },
    ).pipe(Effect.result),
  )
  expect(result._tag === "Failure" && result.failure.code).toBe("INVALID_CONTENT_SOURCE")
  expect(f.mutations()).toBe(0)
})
test("unknown applied root Markdown child resumes without another create", async () => {
  const f = fixture("child_create", true, undefined, false, false, false, true)
  f.input.clear()
  f.input.set(
    "SKILL.md",
    encoder.encode(
      "---\nname: sample-skill\ndescription: Use for recovery.\n---\n\n# Sample\n\nRead [mocking](mocking.md).\n",
    ),
  )
  f.input.set("mocking.md", encoder.encode("# Mocking\n\nExact source bytes.\n"))
  f.input.set("docs/nested.md", encoder.encode("# Nested\n\nExact nested bytes.\n"))
  f.seedLiteral()
  const stopped = await f.run(
    replaceSkill("/input", { database, target: root, storage: "notion_blocks" }).pipe(
      Effect.result,
    ),
  )
  if (stopped._tag !== "Failure") throw new Error("Expected applied child response loss")
  expect(stopped.failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
  const operationId = String(property(stopped.failure.details).operation_id)
  const creates = () =>
    f
      .receipt(operationId)
      .intents.filter((intent) => intent.method === "POST" && intent.path === "v1/pages").length
  const before = creates()
  const resumed = await f.run(resumePublication(operationId))
  expect(resumed).toMatchObject({ verified: true, operation_id: operationId, resumed: true })
  expect(creates()).toBe(before)
  const snapshot = await f.run(openSkill(root, { refresh: true }))
  const exported = await f.run(snapshotAuthoredPortable(snapshot))
  for (const file of exported.files) expect(file.bytes).toEqual(f.input.get(file.path)!)
})
test("child allocation crossing 100 raw blocks keeps the normalized roster and resumes an acknowledged create once", async () => {
  const f = fixture(undefined, true, undefined, false, false, false, true)
  const files = [
    "SKILL.md",
    ...Array.from(
      { length: 50 },
      (_, index) => `references/page-${String(index + 1).padStart(3, "0")}.md`,
    ),
  ]
  f.input.clear()
  f.input.set(
    "SKILL.md",
    encoder.encode("---\nname: sample-skill\ndescription: Use for recovery.\n---\n\n# Sample\n"),
  )
  for (const path of files.slice(1)) f.input.set(path, encoder.encode(`# ${path}\n`))
  f.seedLiteral()
  const stopped = await f.run(
    replaceSkill("/input", {
      database,
      target: root,
      storage: "notion_blocks",
      onProgress: (event) =>
        Effect.sync(() => {
          if (
            event.stage === "register_reference:references/page-050.md" &&
            event.status === "started"
          )
            f.failNextRead()
        }),
    }).pipe(Effect.result),
  )
  if (stopped._tag !== "Failure") throw new Error("Expected the acknowledged child read to stop")
  expect(stopped.failure.code).toBe("WRITE_PARTIAL")
  expect(property(stopped.failure.details).cause_code).toBe("ACCESS_DENIED")
  const operationId = String(property(stopped.failure.details).operation_id)
  const posts = () =>
    f
      .receipt(operationId)
      .intents.filter((intent) => intent.method === "POST" && intent.path === "v1/pages")
  expect(posts().at(-1)?.status).toBe("completed")
  expect(property(posts().at(-1)?.response).id).toBe(f.children.at(-1)?.id)
  const base = `v1/blocks/${root}/children?page_size=100`
  const guards = f.receipt(operationId).guards
  const chain = Object.keys(guards)
    .filter((path) => path === base || path.startsWith(`${base}&start_cursor=`))
    .sort()
  expect(chain.length).toBeGreaterThan(1)
  expect(
    chain.flatMap((path) =>
      (property(guards[path]).results as Array<{ id: string }>).map((child) => child.id),
    ),
  ).toEqual(f.children.map((child) => child.id))
  expect(property(guards[chain.at(-1)!])).toMatchObject({ has_more: false, next_cursor: null })
  const before = posts().length
  f.retainSyntheticChildren(operationId)
  const acknowledged = structuredClone(f.receipt(operationId).intents)
  const retainedTitle = f.children[0]!.title
  f.children[0]!.title = "external.md"
  const refused = await f.run(reconcilePublication(operationId))
  expect(refused.outcome).toBe("conflict")
  expect(f.receipt(operationId).conflict).toBe(true)
  expect(f.receipt(operationId).conflict_history).toBeUndefined()
  f.children[0]!.title = retainedTitle
  const reconciled = await f.run(reconcilePublication(operationId))
  expect(reconciled.outcome).toBe("success")
  expect(f.receipt(operationId).conflict).toBeUndefined()
  expect(f.receipt(operationId).intents).toEqual(acknowledged)
  expect(f.receipt(operationId).conflict_history).toHaveLength(1)
  const resumed = await f.run(resumePublication(operationId))
  expect(resumed).toMatchObject({ verified: true, operation_id: operationId, resumed: true })
  expect(posts()).toHaveLength(before)
  const snapshot = await f.run(openSkill(root, { refresh: true }))
  const exported = await f.run(snapshotAuthoredPortable(snapshot))
  expect(exported.files.map((file) => file.path).sort()).toEqual([...files].sort())
}, 30000)
for (const drift of ["extra", "missing"] as const) {
  test(`child inventory ${drift} around an acknowledged create is rejected`, async () => {
    const f = fixture(undefined, true, undefined, false, false, false, true)
    f.input.clear()
    f.input.set(
      "SKILL.md",
      encoder.encode("---\nname: sample-skill\ndescription: Use for recovery.\n---\n\n# Sample\n"),
    )
    f.input.set("references/a.md", encoder.encode("# A\n"))
    f.input.set("references/b.md", encoder.encode("# B\n"))
    f.seedLiteral()
    const stopped = await f.run(
      replaceSkill("/input", {
        database,
        target: root,
        storage: "notion_blocks",
        onProgress: (event) =>
          Effect.sync(() => {
            if (event.stage !== "create_reference:references/b.md" || event.status !== "started")
              return
            if (drift === "extra")
              f.children.push({
                id: "22222222-2222-4222-8222-000000000099",
                title: "extra.md",
                body: "",
              })
            else f.children.splice(0, 1)
          }),
      }).pipe(Effect.result),
    )
    if (stopped._tag !== "Failure") throw new Error("Expected child inventory drift to fail")
    expect(stopped.failure.code).toBe("WRITE_PARTIAL")
    expect(property(stopped.failure.details).cause_code).toBe("WRITE_CONFLICT")
  })
}
test("an unproved child title edit is rejected", async () => {
  const f = fixture(undefined, true, undefined, false, false, false, true)
  f.input.clear()
  f.input.set(
    "SKILL.md",
    encoder.encode("---\nname: sample-skill\ndescription: Use for recovery.\n---\n\n# Sample\n"),
  )
  f.input.set("references/a.md", encoder.encode("# A\n"))
  f.input.set("references/b.md", encoder.encode("# B\n"))
  f.seedLiteral()
  const stopped = await f.run(
    replaceSkill("/input", {
      database,
      target: root,
      storage: "notion_blocks",
      onProgress: (event) =>
        Effect.sync(() => {
          if (event.stage === "create_reference:references/b.md" && event.status === "started")
            f.children[0]!.title = "renamed.md"
        }),
    }).pipe(Effect.result),
  )
  if (stopped._tag !== "Failure") throw new Error("Expected child title drift to fail")
  expect(stopped.failure.code).toBe("WRITE_PARTIAL")
  expect(property(stopped.failure.details).cause_code).toBe("WRITE_CONFLICT")
})

for (const field of ["Publication", "references"] as const) {
  test(`native conversion resumes an unapplied ${field} assignment without recreating acknowledged children`, async () => {
    const f = fixture(undefined, true, undefined, false, false, false, true)
    f.seedLiteral()
    let interrupted = false
    const stopped = await f.run(
      Effect.gen(function* () {
        const api = yield* Notion
        const transport: Notion["Service"] = {
          ...api,
          request: (path, body, options) => {
            if (
              !interrupted &&
              path === `v1/pages/${root}` &&
              options?.method === "PATCH" &&
              Object.hasOwn(property(property(body).properties), field)
            ) {
              interrupted = true
              return Effect.fail(
                fail("WRITE_OUTCOME_UNKNOWN", "Property response lost before application"),
              )
            }
            return api.request(path, body, options)
          },
        }
        return yield* replaceSkill("/input", {
          database,
          target: root,
          storage: "notion_blocks",
        }).pipe(Effect.provideService(Notion, transport), Effect.result)
      }),
    )
    if (stopped._tag !== "Failure") throw new Error("Expected unapplied property response loss")
    const operationId = String(property(stopped.failure.details).operation_id)
    const original = f.receipt(operationId)
    const prior = structuredClone(original.intents.at(-1)!)
    const children = original.intents
      .filter((intent) => intent.path === "v1/pages")
      .map((intent) => property(intent.response).id)
    const resumed = await f.run(resumePublication(operationId))
    expect(resumed).toMatchObject({
      verified: true,
      resumed: true,
      record: { id: `notion_page:${root}` },
    })
    const final = f.receipt(operationId)
    expect(final.intents[original.intents.length - 1]).toMatchObject({
      path: prior.path,
      body: prior.body,
      status: "failed",
      response: { prior_status: "unknown", recovery: "known_not_applied" },
    })
    const finalChildren = final.intents
      .filter((intent) => intent.path === "v1/pages")
      .map((intent) => property(intent.response).id)
    expect(finalChildren.slice(0, children.length)).toEqual(children)
    expect(new Set(finalChildren).size).toBe(2)
    const snapshot = await f.run(openSkill(root, { database, refresh: true }))
    expect(snapshot.markdown_files).toBeUndefined()
    const exported = await f.run(snapshotAuthoredPortable(snapshot))
    for (const file of exported.files) expect(file.bytes).toEqual(f.input.get(file.path)!)
  })
}

for (const drift of ["source", "metadata"] as const) {
  test(`unapplied native property recovery refuses ${drift} drift before any new PATCH`, async () => {
    const f = fixture(undefined, true, undefined, false, false, false, true)
    f.seedLiteral()
    const stopped = await f.run(
      Effect.gen(function* () {
        const api = yield* Notion
        let interrupted = false
        const transport: Notion["Service"] = {
          ...api,
          request: (path, body, options) => {
            if (
              !interrupted &&
              path === `v1/pages/${root}` &&
              options?.method === "PATCH" &&
              Object.hasOwn(property(property(body).properties), "Publication")
            ) {
              interrupted = true
              return Effect.fail(
                fail("WRITE_OUTCOME_UNKNOWN", "Property response lost before application"),
              )
            }
            return api.request(path, body, options)
          },
        }
        return yield* replaceSkill("/input", {
          database,
          target: root,
          storage: "notion_blocks",
        }).pipe(Effect.provideService(Notion, transport), Effect.result)
      }),
    )
    if (stopped._tag !== "Failure") throw new Error("Expected unapplied marker")
    const operationId = String(property(stopped.failure.details).operation_id)
    if (drift === "source") f.changeFrozenBytes(operationId)
    else f.changeDescription()
    const before = f.mutations()
    const refused = await f.run(resumePublication(operationId).pipe(Effect.result))
    if (refused._tag !== "Failure")
      throw new Error("Expected source or metadata drift to reject recovery")
    expect(f.mutations()).toBe(before)
  })
}
