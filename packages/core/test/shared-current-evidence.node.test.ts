import * as NodeServices from "@effect/platform-node/NodeServices"
import { ConfigProvider, Crypto, Effect, Layer, Schema } from "effect"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, test } from "vitest"
import {
  assertCurrentEvidence,
  currentPageFact,
  withNotionChangeEvidence,
} from "../src/current-evidence.ts"
import { trashPath } from "../src/local-locks.ts"
import { loadSnapshotManifest, openFixedSnapshotFiles } from "../src/fixed-snapshot-files.ts"
import { property, SnapshotSchema } from "../src/model.ts"
import { validateCachedSharedCurrentTree } from "../src/cache.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import { Notion } from "../src/notion.ts"
import { parseTarget } from "../src/ref.ts"
import { resolveCurrentSkillConsumption } from "../src/shared-current-consumption.ts"
import {
  currentFileMetadata,
  currentFilesFact,
  queryCurrentFilesForSkills,
  queryCurrentSkillIndex,
} from "../src/shared-current-index.ts"
import { completeSharedSkillRelationIds } from "../src/shared-router-members.ts"
import { openSharedSnapshot, type OpenSharedSnapshotInput } from "../src/shared-snapshot.ts"
import { Store, StoreLive } from "../src/store.ts"
import { targetSnapshot } from "../src/snapshot.ts"
import {
  currentBytes,
  currentDigest,
  currentId,
  currentLibrary,
  currentRich,
  currentScope,
  currentSnapshotFixture,
} from "./shared-current-fixture.ts"
import { currentSourceConsumerFixture } from "./shared-current-source-consumer-fixture.ts"

type Fixture = Pick<
  ReturnType<typeof currentSnapshotFixture>,
  | "run"
  | "main"
  | "files"
  | "bodies"
  | "calls"
  | "clearCalls"
  | "bodyCalls"
  | "alterResponses"
  | "semanticWrites"
>
type OpenOptions = Partial<
  Omit<OpenSharedSnapshotInput, "library" | "target" | "scope" | "startedAt">
>
type EvidenceFixture = {
  readonly store: Store["Service"]
  readonly run: Fixture["run"]
  readonly open: (
    options?: OpenOptions,
  ) => Promise<Effect.Success<ReturnType<typeof openSharedSnapshot>>>
}

/** The ordinary fixture transport feeds the production evidence hook and real SQLite. */
async function withRealEvidence<A>(
  base: Fixture,
  use: (fixture: EvidenceFixture) => Promise<A>,
  hook = true,
  directory?: string,
) {
  const root = directory ?? (await mkdtemp(join(tmpdir(), "shared-current-evidence-")))
  const environment = {
    NTN_SKILLS_HOME: join(root, "state"),
    NTN_SKILLS_CONFIG_HOME: join(root, "config"),
    NTN_SKILLS_CACHE_HOME: join(root, "cache"),
  }
  try {
    return await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* Store
          const crypto = yield* Crypto.Crypto
          const api = yield* Effect.promise(() => base.run(Notion))
          const notion: Notion["Service"] = {
            ...api,
            request: (path, body, options) =>
              (hook
                ? withNotionChangeEvidence(
                    "current-fixture",
                    "https://api.notion.com",
                    path,
                    api.request(path, body, options),
                  )
                : api.request(path, body, options)
              ).pipe(
                Effect.provideService(Store, store),
                Effect.provideService(Crypto.Crypto, crypto),
              ),
          }
          const run: Fixture["run"] = (effect) =>
            base.run(
              effect.pipe(
                Effect.provideService(Store, store),
                Effect.provideService(Notion, notion),
              ),
            )
          const identity = currentDigest(
            JSON.stringify(["current-fixture", "", "https://api.notion.com"]),
          )
          yield* store.writeJson(`cache/identities/${identity}.json`, { scope: currentScope })
          const open = (options: OpenOptions = {}) =>
            run(
              openSharedSnapshot({
                library: currentLibrary,
                target: base.main.id,
                scope: currentScope,
                startedAt: Date.now(),
                ...options,
              }),
            )
          return yield* Effect.promise(() => use({ store, run, open }))
        }).pipe(
          Effect.provide(StoreLive.pipe(Layer.provideMerge(NodeServices.layer))),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(environment))),
        ),
      ),
    )
  } finally {
    if (directory === undefined && process.platform === "darwin")
      await Effect.runPromise(trashPath(root))
  }
}

const filesQuery = () =>
  queryCurrentFilesForSkills({
    dataSourceId: currentLibrary.files.data_source_id,
    skillPageIds: [currentId(1)],
    propertyIds: currentLibrary.files.property_ids,
  })
const NativeTimesSchema = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      file_id: Schema.String,
      body_verified_at: Schema.Number,
    }),
  ),
})
async function nativeTimes(h: EvidenceFixture) {
  const [key] = await h.run(h.store.listKeys("cache/current-native-bodies"))
  if (key === undefined) throw new Error("Missing current native observation")
  return (await h.run(h.store.readJson(key, NativeTimesSchema)))?.files
}
function addFile(f: Fixture) {
  const row = structuredClone(f.files[0]!)
  row.id = currentId(999)
  row.properties["File ID"] = currentRich("file-id", "new-support")
  row.properties.Path = currentRich("path", "references/new.md")
  f.files.push(row)
  f.bodies.set(row.id, "# Newly added supporting file\n")
}

test("concurrent native selections bind both tree proofs to the actual immutable SQLite winner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shared-native-first-writer-"))
  const f = currentSnapshotFixture({ fileCount: 1 })
  const resource = await f.resource(
    0,
    "scripts/lazy.sh",
    currentBytes("#!/bin/sh\necho lazy\n"),
    "100755",
  )
  await withRealEvidence(
    f,
    async (h) => {
      const missing = [
        Promise.withResolvers<{ key: string; at: number }>(),
        Promise.withResolvers<{ key: string; at: number }>(),
      ]
      const release = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
      const candidates: unknown[] = []
      const pending: Array<Promise<Effect.Success<ReturnType<typeof openSharedSnapshot>>>> = []
      const controlled = (actor: number): Store["Service"] => {
        let stopped = false
        return {
          ...h.store,
          readJson: (key, schema) =>
            Effect.gen(function* () {
              const value = yield* h.store.readJson(key, schema)
              if (!stopped && key.startsWith("snapshots/") && value === undefined) {
                stopped = true
                missing[actor]!.resolve({ key, at: Date.now() })
                yield* Effect.promise(() => release[actor]!.promise)
              }
              return value
            }),
          writeJson: (key, value, options) =>
            Effect.gen(function* () {
              if (key.startsWith("snapshots/")) candidates[actor] = structuredClone(value)
              return yield* h.store.writeJson(key, value, options)
            }),
        }
      }
      const start = (actor: number) => {
        const producer = h.run(
          openSharedSnapshot({
            library: currentLibrary,
            target: f.main.id,
            scope: currentScope,
            startedAt: Date.now(),
            forceFull: true,
            requestedPaths: ["SKILL.md"],
          }).pipe(Effect.provideService(Store, controlled(actor))),
        )
        void producer.catch(() => undefined)
        pending.push(producer)
        return producer
      }
      const reached = async (actor: number, producer: (typeof pending)[number]) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          return await Promise.race([
            missing[actor]!.promise,
            producer.then(() => {
              throw new Error("Producer completed before the snapshot-missing barrier")
            }),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new Error("Snapshot-missing barrier timed out")),
                10_000,
              )
            }),
          ])
        } finally {
          clearTimeout(timer)
        }
      }
      try {
        const first = start(0),
          a = await reached(0, first)
        // Use the real clock: the second producer begins only after the first has
        // already constructed its candidate and observed the immutable slot empty.
        while (Date.now() <= a.at) await new Promise((resolve) => setTimeout(resolve, 1))
        const second = start(1),
          b = await reached(1, second)
        expect(b.key).toBe(a.key)
        release[0]!.resolve()
        const winner = await first
        const winnerBytes = await readFile(join(h.store.root, a.key))
        release[1]!.resolve()
        const follower = await second
        const stored = await h.run(h.store.readJson(a.key, SnapshotSchema))
        if (stored === undefined) throw new Error("The immutable winner was not persisted")
        const proof = property(
          await h.run(
            h.store.readJson(
              `cache/shared-current-tree-validation/${currentScope}/${stored.snapshot_id}.json`,
              Schema.Unknown,
            ),
          ),
        )
        await writeFile(
          join(directory, "first-writer.json"),
          JSON.stringify(
            { barriers: [a, b], candidates, winner, follower, stored, proof },
            null,
            2,
          ),
        )
        expect(property(candidates[1]).created_at).toBeGreaterThan(
          Number(property(candidates[0]).created_at),
        )
        expect(stored.created_at).toBe(winner.created_at)
        // Fresh observations keep their own acquisition/metadata. Only the proof
        // is bound to the actual persisted immutable selection.
        expect(follower.created_at).toBe(property(candidates[1]).created_at)
        expect(await readFile(join(h.store.root, a.key))).toEqual(winnerBytes)
        expect(proof.manifest_sha256).toBe(currentDigest(canonicalSharedJson(stored)))
        expect(proof.verified_paths).toEqual(["SKILL.md"])
        await expect(h.run(validateCachedSharedCurrentTree(stored))).resolves.toMatchObject({
          snapshot_id: stored.snapshot_id,
        })
        const omitted = stored.files.find((file) => file.path === "scripts/lazy.sh")
        expect(omitted?.sha256).toBe(resource.sha256)
        if (omitted === undefined)
          throw new Error("The complete immutable directory lost the lazy resource")
        await expect(h.run(h.store.readBytes(`objects/${omitted.sha256}`))).rejects.toMatchObject({
          code: "SNAPSHOT_MISSING",
        })
        expect(f.semanticWrites()).toEqual([])
      } finally {
        for (const gate of release) gate.resolve()
        await Promise.allSettled(pending)
      }
    },
    true,
    directory,
  )
  console.info(JSON.stringify({ sharedNativeFirstWriterEvidence: directory }))
})

test("real SQLite captures the complete native read set without extra requests or renewed body times", async () => {
  const f = currentSnapshotFixture()
  await withRealEvidence(f, async (h) => {
    const first = await h.open()
    expect(first.current_evidence?.facts.map((fact) => fact.identity).sort()).toEqual(
      [
        `page:${f.main.id}`,
        ...f.files.map((file) => `page:${file.id}`),
        `files:${currentLibrary.files.data_source_id}:${f.main.id}`,
        `sources:${currentLibrary.sources.data_source_id}:demo`,
        `relations:${f.main.id}:${currentLibrary.skills.property_ids.Members}`,
        `relations:${f.main.id}:${currentLibrary.skills.property_ids.Requires}`,
      ].sort(),
    )
    expect(f.calls).toHaveLength(9)
    expect(f.bodyCalls()).toHaveLength(3)
    const initialBodyTimes = await nativeTimes(h)
    f.clearCalls()
    const warm = await h.open()
    expect(warm.current_evidence?.facts).toEqual(first.current_evidence?.facts)
    expect(warm.snapshot_id).toBe(first.snapshot_id)
    expect(await nativeTimes(h)).toEqual(initialBodyTimes)
    expect(f.calls).toHaveLength(6)
    expect(f.bodyCalls()).toHaveLength(0)
    expect(f.semanticWrites()).toHaveLength(0)
  })
})

test("complete Files additions and removals invalidate a warm snapshot while the owner timestamp stays unchanged", async () => {
  const f = currentSnapshotFixture({ fileCount: 1 })
  await withRealEvidence(f, async (h) => {
    const first = await h.open()
    const rootTime = f.main.last_edited_time
    addFile(f)
    await h.run(filesQuery())
    await expect(h.run(assertCurrentEvidence(first.current_evidence))).rejects.toMatchObject({
      code: "CACHE_INVALIDATED",
    })
    f.clearCalls()
    const added = await h.open()
    expect(added.files.some((file) => file.path === "references/new.md")).toBe(true)
    expect(f.main.last_edited_time).toBe(rootTime)
    expect(f.bodyCalls()).toHaveLength(1)
    f.files.pop()
    await h.run(filesQuery())
    await expect(h.run(assertCurrentEvidence(added.current_evidence))).rejects.toMatchObject({
      code: "CACHE_INVALIDATED",
    })
    expect(f.main.last_edited_time).toBe(rootTime)
  })
})

test("partial Files pagination cannot publish empty membership or replace the previous complete fact", async () => {
  const f = currentSnapshotFixture()
  await withRealEvidence(f, async (h) => {
    const first = await h.open()
    let pages = 0
    f.alterResponses((call, response) => {
      if (!call.path.includes(currentLibrary.files.data_source_id)) return response
      pages++
      return pages === 1
        ? { object: "list", results: [], has_more: true, next_cursor: "offset-100" }
        : {
            object: "list",
            results: [],
            has_more: false,
            next_cursor: null,
            request_status: { type: "incomplete", incomplete_reason: "query_result_limit_reached" },
          }
    })
    const result = await h.run(filesQuery().pipe(Effect.result))
    expect(result._tag).toBe("Failure")
    expect(result._tag === "Failure" && result.failure.code).toBe("CURRENT_INDEX_INVALID")
    expect(pages).toBe(2)
    await h.run(assertCurrentEvidence(first.current_evidence))
    const empty = await h.run(currentFilesFact(currentLibrary.files.data_source_id, f.main.id, []))
    await expect(
      h.run(h.store.currentEvidence!.capture(currentScope, [empty])),
    ).rejects.toMatchObject({ code: "CACHE_INVALIDATED" })
  })
})

test("reusing an older producer response cannot give its complete Files collection a newer generation", async () => {
  const f = currentSnapshotFixture({ fileCount: 1 })
  await withRealEvidence(f, async (h) => {
    const api = await h.run(Notion)
    const endpoint = `v1/data_sources/${currentLibrary.files.data_source_id}/query`
    const older = await h.run(
      api.request(
        endpoint,
        {
          page_size: 100,
          filter: {
            property: currentLibrary.files.property_ids.Skill,
            relation: { contains: f.main.id },
          },
        },
        { method: "POST" },
      ),
    )
    const rows = property(older).results
    if (!Array.isArray(rows)) throw new Error("Expected an older complete Files response")
    const oldFact = await h.run(
      currentFilesFact(
        currentLibrary.files.data_source_id,
        f.main.id,
        rows.map((row) => currentFileMetadata(row, currentLibrary)),
      ),
    )
    addFile(f)
    const current = (await h.run(filesQuery())).get(f.main.id)
    if (current === undefined) throw new Error("Missing newer complete Files response")
    const newFact = await h.run(
      currentFilesFact(currentLibrary.files.data_source_id, f.main.id, current),
    )
    const accepted = await h.run(h.store.currentEvidence!.capture(currentScope, [newFact]))
    const replay: Notion["Service"] = {
      ...api,
      request: (path, body, options) =>
        path.startsWith(endpoint) ? Effect.succeed(older) : api.request(path, body, options),
    }
    const late = await h.run(filesQuery().pipe(Effect.provideService(Notion, replay)))
    expect(late.get(f.main.id)).toHaveLength(1)
    await h.run(assertCurrentEvidence(accepted))
    await expect(
      h.run(h.store.currentEvidence!.capture(currentScope, [oldFact])),
    ).rejects.toMatchObject({ code: "CACHE_INVALIDATED" })
  })
})

test("complete Source contributions invalidate empty and changed selections without consulting Git HEAD", async () => {
  const f = await currentSourceConsumerFixture()
  await f.select(
    [{ path: "references/remote.md", bytes: currentBytes("# Fixed remote\n"), mode: "100644" }],
    "git",
  )
  f.source.last_edited_time = "2026-11-18T00:00:00.000Z"
  f.visible(false)
  await withRealEvidence(f, async (h) => {
    const first = await h.open({ requestedPaths: [] })
    f.visible(true)
    const index = await h.run(queryCurrentSkillIndex(currentLibrary, f.main.id))
    const consumption = await h.run(
      resolveCurrentSkillConsumption(currentLibrary, index, { sourceOptions: {} }),
    )
    expect(
      consumption.current_facts?.some((fact) => fact.identity === `page:${currentId(22)}`),
    ).toBe(true)
    await expect(h.run(assertCurrentEvidence(first.current_evidence))).rejects.toMatchObject({
      code: "CACHE_INVALIDATED",
    })
    const selected = await h.open({ requestedPaths: [] })
    expect(selected.files.some((file) => file.path === "references/remote.md")).toBe(true)
    f.contribute([
      { member_key: ".", skill_id: "demo", mount_path: "upstream", mapping: {}, exclude: [] },
    ])
    await h.run(resolveCurrentSkillConsumption(currentLibrary, index, { sourceOptions: {} }))
    await expect(h.run(assertCurrentEvidence(selected.current_evidence))).rejects.toMatchObject({
      code: "CACHE_INVALIDATED",
    })
    expect(f.requests).toHaveLength(0)
    expect(f.semanticWrites()).toHaveLength(0)
  })
})

test("a Source main file still rejects Requires changes during the final owner check", async () => {
  const f = await currentSourceConsumerFixture()
  const bytes = currentBytes("# Fixed Source main\n")
  await f.select([{ path: "SKILL.md", bytes, mode: "100644" }], "git")
  f.bind("SKILL.md")
  f.source.last_edited_time = "2026-11-18T00:00:00.000Z"
  await withRealEvidence(f, async (h) => {
    await h.run(h.store.writeBytes(`objects/${currentDigest(bytes)}`, bytes))
    let rootReads = 0
    f.alterResponses((call, response) => {
      if (call.path !== `v1/pages/${f.main.id}` || ++rootReads !== 2) return response
      f.main.last_edited_time = "2026-11-18T00:01:00.000Z"
      f.main.properties.requires.relation = [{ id: currentId(901) }]
      return structuredClone(f.main)
    })
    await expect(h.open()).rejects.toMatchObject({ code: "CURRENT_TREE_CHANGED" })
    expect(await h.run(h.store.listKeys("snapshots"))).toHaveLength(0)
    expect(f.requests).toHaveLength(0)
  })
})

test("a full relation observed by another caller invalidates a snapshot even when the root timestamp is unchanged", async () => {
  const f = currentSnapshotFixture({ fileCount: 0 })
  await withRealEvidence(f, async (h) => {
    const first = await h.open()
    if (first.record.locator.type !== "shared_skill" || first.record.enabled === undefined)
      throw new Error("Expected a shared Skill fixture")
    const record = { ...first.record, locator: first.record.locator, enabled: first.record.enabled }
    const raw = structuredClone(f.main)
    raw.properties.requires.has_more = true
    raw.properties.requires.relation = [{ id: currentId(901) }]
    const api = await h.run(Notion)
    let queries = 0
    const notion: Notion["Service"] = {
      ...api,
      request: (path, body, options) => {
        if (!path.startsWith(`v1/pages/${f.main.id}/properties/requires?`))
          return api.request(path, body, options)
        return Effect.sync(() => {
          queries++
          const more = queries === 1
          return {
            object: "list",
            type: "property_item",
            has_more: more,
            next_cursor: more ? "next-relation-page" : null,
            property_item: {
              id: "requires",
              type: "relation",
              next_url: more ? "https://api.notion.com/next" : null,
            },
            results: [
              {
                object: "property_item",
                id: "requires",
                type: "relation",
                relation: { id: currentId(more ? 901 : 902) },
              },
            ],
          }
        })
      },
    }
    const ids = await h.run(
      completeSharedSkillRelationIds(currentLibrary, record, raw, "Requires").pipe(
        Effect.provideService(Notion, notion),
      ),
    )
    expect(ids).toEqual([currentId(901), currentId(902)])
    expect(queries).toBe(2)
    const rootFact = await h.run(currentPageFact(f.main))
    expect(rootFact?.fingerprint).toBe(
      first.current_evidence?.facts.find((fact) => fact.identity === `page:${f.main.id}`)
        ?.fingerprint,
    )
    await expect(h.run(assertCurrentEvidence(first.current_evidence))).rejects.toMatchObject({
      code: "CACHE_INVALIDATED",
    })
  })
})

test("one stable Source ID and revision cannot hide a changed physical owner between metadata queries", async () => {
  const f = await currentSourceConsumerFixture()
  await f.select(
    [{ path: "references/remote.md", bytes: currentBytes("# Fixed remote\n"), mode: "100644" }],
    "git",
  )
  f.source.last_edited_time = "2026-11-18T00:00:00.000Z"
  f.alterResponses((call, response) => {
    if (!call.path.startsWith(`v1/data_sources/${currentLibrary.sources.data_source_id}/query?`))
      return response
    const envelope = property(response)
    if (!Array.isArray(envelope.results)) throw new Error("Expected a current Source list")
    return {
      ...envelope,
      results: envelope.results.map((row) => ({ ...property(row), id: currentId(2200) })),
    }
  })
  await withRealEvidence(f, async (h) => {
    const index = await h.run(queryCurrentSkillIndex(currentLibrary, f.main.id))
    await expect(
      h.run(resolveCurrentSkillConsumption(currentLibrary, index, { sourceOptions: {} })),
    ).rejects.toMatchObject({ code: "CURRENT_SOURCE_CONFLICT" })
    expect(f.requests).toHaveLength(0)
  })
})

test("production storage cannot publish a candidate when the transport supplied no page evidence", async () => {
  const f = currentSnapshotFixture({ fileCount: 0 })
  await withRealEvidence(
    f,
    async (h) => {
      await expect(h.open()).rejects.toMatchObject({ code: "CACHE_INVALIDATED" })
      expect(await h.run(h.store.listKeys("snapshots"))).toHaveLength(0)
    },
    false,
  )
})

test("a later complete Files query cannot be grafted onto an already prepared native candidate", async () => {
  const f = currentSnapshotFixture({ fileCount: 1 })
  await withRealEvidence(f, async (h) => {
    const first = await h.open()
    let injected = false
    const facts = h.store.currentEvidence!
    const controlled: Store["Service"] = {
      ...h.store,
      currentEvidence: {
        ...facts,
        capture: (scope, expected, records) =>
          Effect.gen(function* () {
            if (!injected) {
              injected = true
              addFile(f)
              yield* Effect.promise(() => h.run(filesQuery()))
            }
            return yield* facts.capture(scope, expected, records)
          }),
      },
    }
    await expect(
      h.run(
        openSharedSnapshot({
          library: currentLibrary,
          target: f.main.id,
          scope: currentScope,
          startedAt: Date.now(),
        }).pipe(Effect.provideService(Store, controlled)),
      ),
    ).rejects.toMatchObject({ code: "CACHE_INVALIDATED" })
    expect(injected).toBe(true)
    await expect(h.run(assertCurrentEvidence(first.current_evidence))).rejects.toMatchObject({
      code: "CACHE_INVALIDATED",
    })
    expect(
      property(await h.run(h.store.readJson(`snapshots/${first.snapshot_id}.json`, Schema.Unknown)))
        .snapshot_id,
    ).toBe(first.snapshot_id)
  })
})

test("a previous current-state database upgrades additively and revalidates old observations without discarding fixed bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shared-current-evidence-upgrade-"))
  const f = currentSnapshotFixture({ fileCount: 1 })
  try {
    const { retained, bytes } = await withRealEvidence(
      f,
      async (h) => {
        const first = await h.open()
        const entry = first.files.find((file) => file.path === first.entrypoint)
        if (entry === undefined) throw new Error("Missing initial entry")
        const bytes = await h.run(h.store.readBytes(`objects/${entry.sha256}`))
        let replaced = 0
        for (const key of await h.run(h.store.listKeys(`cache/latest/${currentScope}`))) {
          const latest = property(await h.run(h.store.readJson(key, Schema.Unknown)))
          if (latest.snapshot_id !== first.snapshot_id) continue
          const old = { ...latest }
          delete old.current_evidence
          const generation = await h.run(
            h.store.reserveCacheGeneration(currentScope, first.record.id),
          )
          await h.run(h.store.writeJson(key, { ...old, generation }))
          replaced++
        }
        expect(replaced).toBe(1)
        return { retained: first, bytes }
      },
      true,
      directory,
    )
    const previous = new DatabaseSync(join(directory, "state/state.sqlite"))
    try {
      previous.exec("DROP TABLE current_facts")
      expect(
        previous
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='current_facts'")
          .all(),
      ).toHaveLength(0)
    } finally {
      previous.close()
    }
    f.clearCalls()
    await withRealEvidence(
      f,
      async (h) => {
        const manifest = await h.run(loadSnapshotManifest(retained.snapshot_id))
        const pinned = await h.run(
          openFixedSnapshotFiles(manifest, () => [manifest.entrypoint], { offline: true }),
        )
        expect(pinned.files[0]?.bytes).toEqual(bytes)
        expect(f.calls).toHaveLength(0)
        const current = await h.run(
          targetSnapshot(parseTarget(retained.record.ref), { library: currentLibrary.library_id }),
        )
        expect(current.snapshot_id).toBe(retained.snapshot_id)
        expect(current.source).toBe("notion")
        expect(current.current_evidence).toBeDefined()
        expect(f.calls.length).toBeGreaterThan(0)
        expect(f.bodyCalls()).toHaveLength(0)
        f.clearCalls()
        const warm = await h.run(
          targetSnapshot(parseTarget(retained.record.ref), { library: currentLibrary.library_id }),
        )
        expect(warm.source).toBe("local_cache")
        expect(f.calls).toHaveLength(0)
        expect((await h.run(loadSnapshotManifest(retained.snapshot_id))).files).toEqual(
          retained.files,
        )
      },
      true,
      directory,
    )
    const upgraded = new DatabaseSync(join(directory, "state/state.sqlite"))
    try {
      const count = upgraded.prepare("SELECT COUNT(*) AS count FROM current_facts").get()
      expect(Number(count?.count)).toBeGreaterThan(0)
    } finally {
      upgraded.close()
    }
  } finally {
    if (process.platform === "darwin") await Effect.runPromise(trashPath(directory))
  }
})
