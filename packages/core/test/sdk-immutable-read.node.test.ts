import { createHash } from "node:crypto"
import { mkdtemp, readFile, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, vi } from "vitest"
import { readSkill, listSkill, readResources } from "../../cli/src/sdk.ts"
import { LIBRARY_MARKER } from "../src/shared-library-model.ts"
import {
  executeSharedResourceAuthoring,
  prepareSharedResourceAuthoring,
} from "../src/shared-resource-authoring.ts"
import { resourceAuthoringFixture } from "./shared-resource-authoring-fixture.ts"
import { library, skillPage } from "./shared-snapshot-fixture.ts"

const { startSdkSourceFixture } = await import(
  new URL("../../../scripts/sdk-source-fixture.mjs", import.meta.url).href
)
type Source = Awaited<ReturnType<typeof startSdkSourceFixture>>
const raw = new TextEncoder().encode("#!/bin/sh\nprintf 'immutable bytes only\\n'\n")
const hash = createHash("sha256").update(raw).digest("hex")
const recordsPath = `/v1/data_sources/${library.records.data_source_id}/query`

async function sample() {
  const f = await resourceAuthoringFixture()
  await f.open(false)
  const plan = await f.run(
    prepareSharedResourceAuthoring({
      library,
      snapshot: await f.open(),
      action: "add",
      path: "scripts/read-only.sh",
      bytes: raw,
      mode: "100755",
    }),
  )
  await f.run(executeSharedResourceAuthoring(library, { plan, mode: "create" }))
  return {
    notion: {
      library,
      database: {
        object: "database",
        id: library.skills.database_id,
        database_type: null,
        title: [{ plain_text: "Immutable read fixture" }],
        description: [{ plain_text: LIBRARY_MARKER + JSON.stringify(library) }],
        data_sources: [{ id: library.skills.data_source_id, name: "Skills" }],
      },
      main: structuredClone(f.base.main),
      skills: [structuredClone(f.base.main)],
      files: structuredClone(f.files),
      records: structuredClone([...f.base.records.values()]),
      bodies: Object.fromEntries(f.base.bodies),
    },
  }
}

async function idle(source: Source) {
  await vi.waitFor(() => {
    for (const row of source.requests) expect(row.closed_monotonic_ns).not.toBeNull()
  })
}

async function setup(
  use: (input: {
    source: Source
    root: string
    options: Awaited<ReturnType<typeof bootstrap>>["options"]
    input: Awaited<ReturnType<typeof bootstrap>>["input"]
    other: (name: string) => ReturnType<typeof bootstrap>
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "sdk-immutable-read-"))
  const source = await startSdkSourceFixture(await sample(), join(root, "requests.jsonl"))
  const other = (name: string) => bootstrap(source, root, name)
  try {
    const first = await other("first")
    await idle(source)
    source.setPhase("read")
    await use({ source, root, ...first, other })
    expect(source.unexpected).toEqual([])
  } finally {
    await source.close()
    console.info(JSON.stringify({ immutableSdkEvidence: root }))
  }
}

async function bootstrap(source: Source, root: string, name: string) {
  const directory = join(root, name)
  const env = {
    NOTION_API_TOKEN: "immutable-controlled-token",
    NOTION_WORKSPACE_ID: "",
    NOTION_API_BASE_URL: source.origin,
    NTN_SKILLS_HOME: join(directory, "state"),
    NTN_SKILLS_CONFIG_HOME: join(directory, "config"),
    NTN_SKILLS_CACHE_HOME: join(directory, "cache"),
    NTN_SKILLS_SCHEDULER_ROOT: join(root, "scheduler"),
    NTN_SKILLS_NOTION_INTERVAL_MS: "100",
    NTN_SKILLS_REQUEST_TRACE_LIMIT: "10000",
  }
  const options = { env, database: library.skills.database_id, readOnly: true, metrics: true }
  const main = await readSkill(skillPage, options)
  const directoryRef = new URL(main.ref)
  directoryRef.pathname = "/"
  directoryRef.searchParams.delete("file_id")
  const listing = await listSkill(directoryRef.toString(), options)
  const selected = listing.files.find((file) => file.path === "scripts/read-only.sh")
  expect(selected?.sha256).toBe(hash)
  if (selected === undefined) throw new Error("The public inventory lost its exact resource")
  await expect(readFile(join(env.NTN_SKILLS_HOME, "objects", hash))).rejects.toMatchObject({
    code: "ENOENT",
  })
  return {
    options,
    input: {
      version: 1 as const,
      refs: [selected.ref],
      budget: { maxFiles: 1, maxBytes: 1024, timeBudgetMs: 30000 },
    },
  }
}

const bodyCalls = (source: Source) =>
  source.requests.filter(
    (row: { phase: string; path: string }) => row.phase === "read" && row.path === recordsPath,
  )
async function joinedEligibility(source: Source) {
  await vi.waitFor(() =>
    expect(
      source.requests.filter(
        (row: { phase: string; path: string; terminal: string }) =>
          row.phase === "read" &&
          row.path === `/v1/pages/${skillPage}` &&
          row.terminal === "finished",
      ),
    ).toHaveLength(2),
  )
  // The server observes eligibility completion, while joining is local work.
  await new Promise((resolve) => setTimeout(resolve, 50))
}
function ready(result: Awaited<ReturnType<typeof readResources>>) {
  expect(result.status).toBe("ready")
  if (result.status !== "ready") throw new Error(JSON.stringify(result))
  expect(result.files).toHaveLength(1)
  expect(result.files[0]?.sha256).toBe(hash)
  expect(result.files[0]?.content).toBe(new TextDecoder().decode(raw))
  expect(result.effects?.remote_writes).toBe("none")
}

test("two public SDK runtimes share only exact immutable bytes, and creator cancellation preserves the survivor", async () => {
  await setup(async ({ source, input, options }) => {
    const hold = source.holdNext({ method: "POST", path: recordsPath })
    const creator = new AbortController()
    const first = readResources(input, { ...options, signal: creator.signal })
    await hold.reached
    const second = readResources(input, options)
    await joinedEligibility(source)
    creator.abort()
    expect((await first).status).toBe("cancelled")
    expect(bodyCalls(source)).toHaveLength(1)
    expect(bodyCalls(source)[0].closed_monotonic_ns).toBeNull()
    hold.release()
    ready(await second)
    await idle(source)
    expect(bodyCalls(source)).toHaveLength(2)
    expect(
      bodyCalls(source).every((row: { terminal: string }) => row.terminal === "finished"),
    ).toBe(true)
  })
})

test("last public waiter cancellation closes its transport and the same pin can retry", async () => {
  await setup(async ({ source, input, options }) => {
    const hold = source.holdNext({ method: "POST", path: recordsPath, afterHeaders: true })
    const controllers = [new AbortController(), new AbortController()]
    const first = readResources(input, { ...options, signal: controllers[0]!.signal })
    await hold.reached
    const second = readResources(input, { ...options, signal: controllers[1]!.signal })
    await joinedEligibility(source)
    controllers.forEach((controller) => controller.abort())
    expect((await Promise.all([first, second])).map((result) => result.status)).toEqual([
      "cancelled",
      "cancelled",
    ])
    const closed = await hold.closed
    expect(closed.terminal).toBe("aborted")
    ready(await readResources(input, options))
    await idle(source)
    expect(bodyCalls(source)).toHaveLength(3)
  })
})

test.each(["budget", "store"] as const)(
  "public consumers with another %s never join the pending producer",
  async (kind) => {
    await setup(async ({ source, input, options, other }) => {
      source.setPhase("setup-second")
      const separate =
        kind === "store"
          ? await other("second")
          : { input: { ...input, budget: { ...input.budget, maxBytes: 1025 } }, options }
      await idle(source)
      source.setPhase("read")
      const hold = source.holdNext({ method: "POST", path: recordsPath })
      const first = readResources(input, options)
      await hold.reached
      ready(await readResources(separate.input, separate.options))
      expect(bodyCalls(source)).toHaveLength(3)
      hold.release()
      ready(await first)
      await idle(source)
      expect(bodyCalls(source)).toHaveLength(4)
    })
  },
)

test("another credential cannot borrow the authorized pin's pending bytes", async () => {
  await setup(async ({ source, input, options }) => {
    const hold = source.holdNext({ method: "POST", path: recordsPath })
    const first = readResources(input, options)
    await hold.reached
    const denied = await readResources(input, {
      ...options,
      env: { ...options.env, NOTION_API_TOKEN: "other-controlled-credential" },
    })
    expect(denied.status).toBe("failed")
    expect(bodyCalls(source)).toHaveLength(1)
    hold.release()
    ready(await first)
    await idle(source)
    expect(bodyCalls(source)).toHaveLength(2)
  })
})
