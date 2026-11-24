import { createHash } from "node:crypto"
import { mkdtemp, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ConfigProvider, Effect } from "effect"
import { expect, test } from "vitest"
import { consume, decodeConsumeResult, readResources, readSkill } from "../../cli/src/sdk.ts"
import { nodeRuntime } from "../../cli/src/runtime.ts"
import { cacheStatus, clearCache } from "../src/cache.ts"
import { property } from "../src/model.ts"
import { fileRef } from "../src/ref.ts"
import { skillIdentity } from "../src/shared-content.ts"
import { librarySchemaResponse } from "./library-schema-fixture.ts"
import { Store } from "../src/store.ts"
import { nativeGraphFixture } from "./graph-prepare-live-fixture.ts"
import { currentRich } from "./shared-current-fixture.ts"

const { startSdkSourceFixture } = await import(
  new URL("../../../scripts/sdk-source-fixture.mjs", import.meta.url).href
)

async function controlled(width: number) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "sdk-bounded-metadata-"))
  const f = nativeGraphFixture({ width })
  const library = f.descriptor
  const source = await startSdkSourceFixture(
    {
      notion: {
        library,
        root: librarySchemaResponse("v1/pages/" + library.library_id, library),
        root_children: property(librarySchemaResponse("v1/blocks/" + library.library_id + "/children", library)).results,
        databases: (["skills", "files", "records", "sources"] as const).map((role) =>
          librarySchemaResponse("v1/databases/" + library[role].database_id, library),
        ),
        data_sources: (["skills", "files", "records", "sources"] as const).map((role) =>
          librarySchemaResponse("v1/data_sources/" + library[role].data_source_id, library),
        ),
        main: structuredClone(f.pages[0]),
        skills: structuredClone(f.pages),
        files: structuredClone(f.files),
        records: [],
        sources: [],
        bodies: Object.fromEntries(f.bodies),
      },
    },
    join(root, "requests.jsonl"),
  )
  const options = {
    env: {
      NOTION_API_TOKEN: "bounded-controlled-token",
      NOTION_API_BASE_URL: source.origin,
      NTN_SKILLS_HOME: join(root, "state"),
      NTN_SKILLS_CONFIG_HOME: join(root, "config"),
      NTN_SKILLS_CACHE_HOME: join(root, "cache"),
      NTN_SKILLS_SCHEDULER_ROOT: join(root, "scheduler"),
      NTN_SKILLS_NOTION_INTERVAL_MS: "100",
    },
    library: library.library_id,
  }
  const stable = (id: string) => fileRef(skillIdentity(library.library_id, id), "SKILL.md")
  return { f, library, source, options, stable, root }
}

async function finish(c: Awaited<ReturnType<typeof controlled>>) {
  await c.source.close()
  expect(c.source.unexpected).toEqual([])
  expect(
    c.source.requests.filter(
      (row: { method: string; path: string }) =>
        row.method !== "GET" && !row.path.endsWith("/query"),
    ),
  ).toEqual([])
  console.info(JSON.stringify({ boundedSdkEvidence: c.root }))
}

test("public Broker-shaped stable consume queries only the selected claims in a large library", async () => {
  const c = await controlled(201)
  try {
    for (const row of [c.source.notion.main, c.source.notion.skills[0]])
      property(row.properties).requires = {
        id: "requires",
        type: "relation",
        relation: [],
        has_more: false,
      }
    const result = await consume(
      { version: 1, targets: [c.stable("a")], purpose: "use" },
      c.options,
    )
    expect(result.status, JSON.stringify(result)).toBe("ready")
    if (result.status !== "ready") throw new Error("Controlled selected consume failed")
    expect(await decodeConsumeResult(result)).toEqual(result)
    expect(result.preparation.usage.prepared_nodes).toBe(1)
    const claims = c.source.requests.filter(
      (row: { path: string }) =>
        row.path === `/v1/data_sources/${c.library.skills.data_source_id}/query`,
    )
    expect(claims).toHaveLength(1)
    expect(claims[0].page_ids).toEqual([c.f.pageIds[0]])
    expect(
      c.source.requests.filter((row: { path: string }) => row.path.endsWith("/markdown")),
    ).toHaveLength(1)
  } finally {
    await finish(c)
  }
})

test("public exact stable consume rejects a disabled duplicate before reading any body", async () => {
  const c = await controlled(1)
  try {
    const duplicate = structuredClone(c.source.notion.skills[0])
    duplicate.id = c.f.pageIds[1]
    property(duplicate.properties).enabled = { id: "enabled", type: "checkbox", checkbox: false }
    c.source.notion.skills[1] = duplicate
    const result = await consume(
      { version: 1, targets: [c.stable("a")], purpose: "use" },
      c.options,
    )
    expect(result).toMatchObject({ status: "failed", error: { code: "SHARED_SKILL_ID_CONFLICT" } })
    expect(
      c.source.requests.filter((row: { path: string }) => row.path.endsWith("/markdown")),
    ).toEqual([])
  } finally {
    await finish(c)
  }
})

test("public stable claim success still observes exact owner HTTP 403 before any body", async () => {
  const c = await controlled(0)
  try {
    c.source.setPhase("owner-denied", { denyCurrent: true })
    const result = await consume(
      { version: 1, targets: [c.stable("a")], purpose: "use" },
      c.options,
    )
    expect(result).toMatchObject({ status: "failed", error: { code: "ACCESS_DENIED" } })
    const claims = c.source.requests.filter(
      (row: { path: string }) =>
        row.path === `/v1/data_sources/${c.library.skills.data_source_id}/query`,
    )
    expect(claims).toHaveLength(1)
    expect(claims[0].page_ids).toEqual([c.f.pageIds[0]])
    expect(c.source.requests.filter((row: { status: number }) => row.status === 403)).toMatchObject(
      [{ method: "GET", path: `/v1/pages/${c.f.pageIds[0]}`, status: 403 }],
    )
    expect(
      c.source.requests.filter((row: { path: string }) => row.path.endsWith("/markdown")),
    ).toEqual([])
  } finally {
    await finish(c)
  }
})

test.each([false, true])(
  "public child rejection survives physical alias retirement=%s and all-clear, then a fresh grant recovers",
  async (retireAlias) => {
    const c = await controlled(1)
    try {
      const before = await consume(
        { version: 1, targets: [c.stable("a")], purpose: "use" },
        c.options,
      )
      if (before.status !== "ready") throw new Error(JSON.stringify(before))
      const root = before.preparation.nodes.find(
        (node) => node.state === "prepared" && node.roles.includes("root"),
      )!
      const child = before.preparation.nodes.find(
        (node) => node.state === "prepared" && node.roles.includes("required"),
      )!
      if (root.state !== "prepared" || child.state !== "prepared")
        throw new Error("Missing complete cached graph")
      const otherOptions = {
        ...c.options,
        env: { ...c.options.env, NOTION_API_TOKEN: "another-controlled-token" },
      }
      const other = await readSkill(c.stable("leaf-0"), otherOptions)
      expect(other.snapshot_id).not.toBe(child.binding.snapshot_id)
      if (retireAlias) {
        const key = `cache/shared-page-identities/${before.preparation.scope}/${c.f.pageIds[1]}.json`
        const retired = await Effect.runPromise(
          Effect.gen(function* () {
            return yield* (yield* Store).retireKeys([key])
          }).pipe(
            Effect.provide(nodeRuntime(process.cwd()).live),
            Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(c.options.env))),
            Effect.scoped,
          ),
        )
        expect(retired.map((row) => row.key)).toEqual([key])
      }
      c.source.notion.main = c.source.notion.skills[1]
      c.source.setPhase("child-denied", { denyCurrent: true })
      const failed = await consume(
        { version: 1, targets: [c.stable("a")], purpose: "use", freshness: { policy: "refresh" } },
        c.options,
      )
      expect(failed).toMatchObject({
        status: "failed",
        error: { code: "SHARED_ROUTER_MEMBER_UNAVAILABLE" },
      })
      if (failed.status !== "failed") throw new Error("Child denial was not observed")
      expect(await decodeConsumeResult(failed)).toEqual(failed)
      const details = property(property(failed.error.details).preparation)
      const denied = (details.nodes as Record<string, unknown>[]).filter(
        (node) => property(node.error).code === "ACCESS_DENIED",
      )
      expect(denied).toMatchObject([
        {
          id: c.f.pageIds[1],
          ref: `https://www.notion.so/${c.f.pageIds[1]!.replaceAll("-", "")}`,
          roles: ["required"],
          error: { details: { page_id: c.f.pageIds[1] } },
        },
      ])
      const start = c.source.requests.length
      for (const ref of [child.ref, c.stable("leaf-0")])
        await expect(readSkill(ref, { ...c.options, offline: true })).rejects.toMatchObject({
          code: "ACCESS_DENIED",
        })
      const batch = await readResources(
        { version: 1, refs: [child.ref] },
        { ...c.options, offline: true },
      )
      expect(batch).toMatchObject({ status: "failed", error: { code: "ACCESS_DENIED" } })
      expect("files" in batch).toBe(false)
      expect(await readSkill(root.ref, { ...c.options, offline: true })).toMatchObject({
        content: "# a instruction\n",
      })
      expect(await readSkill(other.ref, { ...otherOptions, offline: true })).toMatchObject({
        content: "# leaf-0 instruction\n",
      })
      expect(c.source.requests).toHaveLength(start)
      await Effect.runPromise(
        clearCache(undefined, { all: true }).pipe(
          Effect.provide(nodeRuntime(process.cwd()).live),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(c.options.env))),
          Effect.scoped,
        ),
      )
      await expect(readSkill(child.ref, { ...c.options, offline: true })).rejects.toMatchObject({
        code: "ACCESS_DENIED",
      })
      expect(await readSkill(root.ref, { ...c.options, offline: true })).toMatchObject({
        content: "# a instruction\n",
      })
      expect(await readSkill(other.ref, { ...otherOptions, offline: true })).toMatchObject({
        content: "# leaf-0 instruction\n",
      })
      expect(c.source.requests).toHaveLength(start)
      c.source.setPhase("permission-restored", { denyCurrent: false })
      expect(await readSkill(c.stable("leaf-0"), { ...c.options, refresh: true })).toMatchObject({
        content: "# leaf-0 instruction\n",
      })
      const restored = c.source.requests.length
      expect(await readSkill(child.ref, { ...c.options, offline: true })).toMatchObject({
        content: "# leaf-0 instruction\n",
      })
      expect(c.source.requests).toHaveLength(restored)
    } finally {
      await finish(c)
    }
  },
)

test("public SQLite alias retirement cannot rebind a physical page to a different stable identity", async () => {
  const c = await controlled(0)
  try {
    const original = await readSkill(c.stable("a"), c.options)
    const alias = `cache/shared-page-identities/${original.scope}/${c.f.pageIds[0]}.json`
    await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Store).retireKeys([alias])
      }).pipe(
        Effect.provide(nodeRuntime(process.cwd()).live),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(c.options.env))),
        Effect.scoped,
      ),
    )
    for (const page of [c.source.notion.main, c.source.notion.skills[0]])
      property(page.properties).skill_id = currentRich("skill_id", "changed-identity")
    await expect(
      readSkill(c.stable("changed-identity"), { ...c.options, refresh: true }),
    ).rejects.toMatchObject({ code: "STATE_CONFLICT", details: { key: alias } })
    const observed = c.source.requests.length
    expect(await readSkill(original.ref, { ...c.options, offline: true })).toMatchObject({
      ref: original.ref,
      snapshot_id: original.snapshot_id,
      content: "# a instruction\n",
    })
    expect(c.source.requests).toHaveLength(observed)
  } finally {
    await finish(c)
  }
})

test("a physical child denial covers two retained content versions without replacing either", async () => {
  const c = await controlled(1)
  try {
    const before = await consume(
      { version: 1, targets: [c.stable("a")], purpose: "use" },
      c.options,
    )
    if (before.status !== "ready") throw new Error(JSON.stringify(before))
    const child = before.preparation.nodes.find(
      (node) => node.state === "prepared" && node.roles.includes("required"),
    )!
    const root = before.preparation.nodes.find(
      (node) => node.state === "prepared" && node.roles.includes("root"),
    )!
    if (child.state !== "prepared" || root.state !== "prepared")
      throw new Error("Missing original cached graph")
    const original = {
      ref: child.ref,
      snapshot_id: child.binding.snapshot_id,
      content: "# leaf-0 instruction\n",
      sha256: child.body_sha256,
    }
    const changedPage = c.source.notion.skills[1]
    changedPage.last_edited_time = "2026-11-21T00:00:00.000Z"
    const changedContent = "# Changed child version B\n"
    c.source.notion.bodies[c.f.pageIds[1]!] = changedContent
    const current = await readSkill(c.stable("leaf-0"), { ...c.options, refresh: true })
    expect(current.record.id).toBe(child.id)
    expect(current.record.locator).toMatchObject({ page_id: c.f.pageIds[1] })
    expect(current).toMatchObject({ content: changedContent })
    const changed = {
      ref: current.ref,
      snapshot_id: current.snapshot_id,
      content: changedContent,
      sha256: createHash("sha256").update(changedContent).digest("hex"),
    }
    expect(changed.sha256).not.toBe(original.sha256)
    expect(await readSkill(original.ref, { ...c.options, offline: true })).toMatchObject({
      snapshot_id: original.snapshot_id,
      content: original.content,
    })
    c.source.notion.main = changedPage
    c.source.setPhase("changed-content-denied", { denyCurrent: true })
    const denied = await consume(
      { version: 1, targets: [c.stable("a")], purpose: "use", freshness: { policy: "refresh" } },
      c.options,
    )
    expect(denied).toMatchObject({
      status: "failed",
      error: { code: "SHARED_ROUTER_MEMBER_UNAVAILABLE" },
    })
    const start = c.source.requests.length
    for (const ref of [original.ref, changed.ref, c.stable("leaf-0")])
      await expect(readSkill(ref, { ...c.options, offline: true })).rejects.toMatchObject({
        code: "ACCESS_DENIED",
      })
    for (const ref of [original.ref, changed.ref])
      expect(
        await readResources({ version: 1, refs: [ref] }, { ...c.options, offline: true }),
      ).toMatchObject({ status: "failed", error: { code: "ACCESS_DENIED" } })
    expect(await readSkill(root.ref, { ...c.options, offline: true })).toMatchObject({
      content: "# a instruction\n",
    })
    expect(c.source.requests).toHaveLength(start)
    await Effect.runPromise(
      clearCache(undefined, { all: true }).pipe(
        Effect.provide(nodeRuntime(process.cwd()).live),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(c.options.env))),
        Effect.scoped,
      ),
    )
    for (const ref of [original.ref, changed.ref])
      await expect(readSkill(ref, { ...c.options, offline: true })).rejects.toMatchObject({
        code: "ACCESS_DENIED",
      })
    expect(c.source.requests).toHaveLength(start)
    c.source.setPhase("changed-content-restored", { denyCurrent: false })
    expect(await readSkill(c.stable("leaf-0"), { ...c.options, refresh: true })).toMatchObject({
      snapshot_id: changed.snapshot_id,
      content: changed.content,
    })
    const restored = c.source.requests.length
    for (const pin of [original, changed]) {
      const read = await readSkill(pin.ref, { ...c.options, offline: true })
      expect(read).toMatchObject({
        snapshot_id: pin.snapshot_id,
        ref: pin.ref,
        content: pin.content,
      })
      if (!("content" in read)) throw new Error("Expected complete immutable text")
      expect(createHash("sha256").update(read.content).digest("hex")).toBe(pin.sha256)
    }
    const status = await Effect.runPromise(
      cacheStatus().pipe(
        Effect.provide(nodeRuntime(process.cwd()).live),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(c.options.env))),
        Effect.scoped,
      ),
    )
    expect(status.observations).toHaveLength(1)
    expect(status.observations).toMatchObject([
      { page_id: current.record.id, snapshot_id: changed.snapshot_id },
    ])
    expect(c.source.requests).toHaveLength(restored)
    console.info(
      JSON.stringify({
        immutableStablePins: [original, changed].map(({ content, ...pin }) => pin),
      }),
    )
  } finally {
    await finish(c)
  }
})

test("an older physical grant cannot erase a newer exact child denial", async () => {
  const c = await controlled(2)
  try {
    const before = await consume(
      { version: 1, targets: [c.stable("a")], purpose: "use" },
      c.options,
    )
    if (before.status !== "ready") throw new Error(JSON.stringify(before))
    const child = before.preparation.nodes.find(
      (node) => node.state === "prepared" && node.roles.includes("required"),
    )!
    if (child.state !== "prepared") throw new Error("Missing cached child")
    await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Store).retireKeys([
          `cache/shared-page-identities/${before.preparation.scope}/${c.f.pageIds[1]}.json`,
        ])
      }).pipe(
        Effect.provide(nodeRuntime(process.cwd()).live),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(c.options.env))),
        Effect.scoped,
      ),
    )
    // Keep one phase while a response is held. The source's declared main is
    // its exact denial target; other declared pages remain accessible.
    const otherPage = c.source.notion.skills[2]
    c.source.notion.main = otherPage
    c.source.setPhase("causal-denial", { denyCurrent: true })
    const hold = c.source.holdNext({
      method: "GET",
      path: `/v1/pages/${c.f.pageIds[1]}/markdown`,
      afterHeaders: true,
    })
    const older = readSkill(c.stable("leaf-0"), { ...c.options, refresh: true }).then(
      (result) => ({ result }),
      (error) => ({ error }),
    )
    await Promise.race([
      hold.reached,
      older.then((value) => {
        throw new Error(`Old read ended before its body barrier: ${JSON.stringify(value)}`)
      }),
    ])
    try {
      c.source.notion.main = c.source.notion.skills[1]
      const denied = await consume(
        { version: 1, targets: [c.stable("a")], purpose: "use", freshness: { policy: "refresh" } },
        c.options,
      )
      expect(denied).toMatchObject({
        status: "failed",
        error: { code: "SHARED_ROUTER_MEMBER_UNAVAILABLE" },
      })
    } finally {
      c.source.notion.main = otherPage
      hold.release()
    }
    expect(await older).toMatchObject({ error: { code: "ACCESS_DENIED" } })
    const start = c.source.requests.length
    await expect(readSkill(child.ref, { ...c.options, offline: true })).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    })
    await expect(
      readSkill(c.stable("leaf-0"), { ...c.options, offline: true }),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" })
    expect(c.source.requests).toHaveLength(start)
    await readSkill(c.stable("leaf-0"), { ...c.options, refresh: true })
    expect(await readSkill(child.ref, { ...c.options, offline: true })).toMatchObject({
      content: "# leaf-0 instruction\n",
    })
  } finally {
    await finish(c)
  }
})
