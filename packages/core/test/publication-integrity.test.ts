import { createHash } from "node:crypto"
import { expect, test } from "bun:test"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, Layer } from "effect"
import { decode, fail, property, text, type Snapshot } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import type { PortableSkill } from "../src/portable.ts"
import {
  commitPublicationIntegrity,
  preparePublicationIntegrity,
  reconcilePublicationIntegrity,
  startPublicationIntegrity,
  verifyPublicationRead,
} from "../src/publication-integrity.ts"
import { Store } from "../src/store.ts"
import { integrityRepositoryFixture, upstreamRepositoryFixture } from "./fixtures.ts"

const root = "11111111-1111-4111-8111-111111111111"
const reference = "22222222-2222-4222-8222-222222222222"
const database = "33333333-3333-4333-8333-333333333333"
const operation = "publish-exact-remote-revision"
const encoder = new TextEncoder()
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const rich = (value: string) => ({
  type: "rich_text",
  rich_text: value ? [{ type: "text", plain_text: value, text: { content: value } }] : [],
})
const intended: PortableSkill = {
  kind: "skill",
  name: "Sample Skill",
  description: "Use for publication integrity.",
  main: "SKILL.md",
  files: [
    { path: "SKILL.md", bytes: encoder.encode("# Sample\n\nRead references/guide.md.\n") },
    {
      path: "references/guide.md",
      bytes: encoder.encode("# Guide\n\nExact remote bytes: 中文.\n"),
    },
    { path: "assets/data.bin", bytes: new Uint8Array([0, 255, 1, 128]) },
  ],
}

interface Machine {
  readonly store: Layer.Layer<Store>
  readonly persisted: Map<string, unknown>
  readonly objects: Map<string, Uint8Array>
}
interface Remote {
  readonly api: Layer.Layer<Notion>
  readonly row: () => unknown
  readonly marker: () => Record<string, unknown>
  readonly properties: Record<string, unknown>
  readonly markdown: Map<string, string>
  readonly mutations: number
  readonly setAsset: (bytes: Uint8Array) => void
  readonly loseCommit: () => void
  readonly onNextPageRead: (hook: () => void) => void
}

function machine(name: string, persisted = new Map<string, unknown>()) {
  const objects = new Map<string, Uint8Array>()
  let generation = 0
  const unused = () => Effect.die(new Error("Unexpected fixture operation"))
  const store = Layer.succeed(Store, {
    root: `/machines/${name}`,
    configRoot: `/machines/${name}/config`,
    cacheRoot: `/machines/${name}/cache`,
    integrity: integrityRepositoryFixture(persisted),
    upstream: upstreamRepositoryFixture(persisted),
    registerBindingWithBase: unused,
    advanceBaseAndReceipt: unused,
    backup: unused,
    reserveCacheGeneration: () => Effect.sync(() => ++generation),
    listKeys: (prefix) =>
      Effect.sync(() => [...persisted.keys()].filter((key) => key.startsWith(`${prefix}/`))),
    retireKeys: (keys) =>
      Effect.sync(() => {
        for (const key of keys) persisted.delete(key)
        return keys.map((key) => ({ key, retention_path: "fixture_trash" }))
      }),
    readJson: (key, schema) =>
      Effect.sync(() =>
        persisted.has(key) ? decode(schema, structuredClone(persisted.get(key))) : undefined,
      ),
    writeJson: (key, value) =>
      Effect.sync(() => {
        persisted.set(key, structuredClone(value))
      }),
    readBytes: (key) =>
      Effect.suspend(() =>
        objects.has(key)
          ? Effect.succeed(objects.get(key)!.slice())
          : Effect.fail(fail("SNAPSHOT_MISSING", "Missing local object")),
      ),
    writeBytes: (key, bytes) =>
      Effect.sync(() => {
        objects.set(key, bytes.slice())
      }),
    output: unused,
  })
  return { store, persisted, objects }
}

function remote() {
  let revision = 0
  const properties: Record<string, unknown> = {
    Name: { type: "title", title: [{ plain_text: intended.name }] },
    Description: rich(intended.description),
    Publication: rich(""),
    Upstream: { type: "relation", relation: [{ id: database }], has_more: false },
    "Sync Mode": { type: "select", select: { name: "tracked" } },
    "Upstream Key": rich("skills/sample"),
    "Upstream Revision": rich("upstream-revision-a"),
    "Published Hash": rich("published-content-a"),
    "Fork Baseline": rich(""),
    "Default Context": { type: "checkbox", checkbox: false },
  }
  const markdown = new Map([
    [root, "Old content."],
    [reference, "Old reference."],
  ])
  let asset = new Uint8Array([9])
  let loseCommitResponse = false
  let pageReadHook: (() => void) | undefined
  let mutations = 0
  const row = () =>
    structuredClone({
      id: root,
      parent: { database_id: database, data_source_id: "ds" },
      last_edited_time: `revision-${revision}`,
      archived: false,
      in_trash: false,
      properties,
    })
  const marker = () => JSON.parse(text(property(properties.Publication).rich_text))
  const api = Layer.succeed(Notion, {
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.succeed("independent-machine-credential"),
    request: (path, payload, options) =>
      Effect.gen(function* () {
        if (path === `v1/pages/${root}`) {
          if (options?.method === "PATCH") {
            mutations++
            for (const [name, value] of Object.entries(property(property(payload).properties))) {
              const field = property(value)
              // Notion persists normalized properties; GET returns a fresh remote row.
              properties[name] = Array.isArray(field.rich_text)
                ? rich(text(field.rich_text))
                : structuredClone(value)
            }
            revision++
            if (loseCommitResponse && marker().state === "committed") {
              loseCommitResponse = false
              return yield* Effect.fail(
                fail("WRITE_OUTCOME_UNKNOWN", "Commit applied; response lost"),
              )
            }
            return { object: "acknowledgement" }
          }
          const hook = pageReadHook
          pageReadHook = undefined
          hook?.()
          return row()
        }
        for (const id of [root, reference]) {
          if (path !== `v1/pages/${id}/markdown`) continue
          if (options?.method === "PATCH") {
            mutations++
            markdown.set(id, String(property(payload).markdown))
            if (id === root) revision++
            return { object: "acknowledgement" }
          }
          return { markdown: markdown.get(id), truncated: false, unknown_block_ids: [] }
        }
        if (path === "fixture/assets/data.bin") return { bytes: Array.from(asset) }
        return yield* Effect.fail(fail("UNEXPECTED", `Unexpected request: ${path}`))
      }),
  })
  return {
    api,
    row,
    marker,
    properties,
    markdown,
    get mutations() {
      return mutations
    },
    setAsset: (bytes: Uint8Array) => {
      asset = bytes.slice()
    },
    loseCommit: () => {
      loseCommitResponse = true
    },
    onNextPageRead: (hook: () => void) => {
      pageReadHook = hook
    },
  }
}

function run<A, E>(
  host: Machine,
  notion: Remote,
  effect: Effect.Effect<A, E, NodeServices.NodeServices | Store | Notion>,
) {
  return Effect.runPromise(
    effect.pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, host.store, notion.api))),
  )
}

// This consumer reads remote pages and hashes their actual UTF-8/binary bytes.
// No snapshot or verification result comes from a submitted PATCH response.
const observe = Effect.gen(function* () {
  const api = yield* Notion
  const store = yield* Store
  const before = yield* api.request(`v1/pages/${root}`)
  const fields = property(property(before).properties)
  const main = String(property(yield* api.request(`v1/pages/${root}/markdown`)).markdown)
  const guide = String(property(yield* api.request(`v1/pages/${reference}/markdown`)).markdown)
  const binary = new Uint8Array(
    property(yield* api.request("fixture/assets/data.bin")).bytes as number[],
  )
  const bytes = [
    ["SKILL.md", encoder.encode(main)],
    ["references/guide.md", encoder.encode(guide)],
    ["assets/data.bin", binary],
  ] as const
  const files: Snapshot["files"][number][] = []
  for (const [path, value] of bytes) {
    const sha256 = digest(value)
    yield* store.writeBytes(`objects/${sha256}`, value)
    files.push({ path, bytes: value.length, sha256 })
  }
  const snapshot: Snapshot = {
    snapshot_id: `s_${digest(JSON.stringify(files))}`,
    scope: "fixture",
    version_id: "remote",
    created_at: 1,
    record: {
      id: root,
      kind: "skill",
      name: text(property(fields.Name).title),
      alias: "sample-skill",
      description: text(property(fields.Description).rich_text),
      default_context: false,
      entrypoint: "SKILL.md",
      ref: `notion:${root}`,
      locator: { type: "notion_page", page_id: root, database_id: database, data_source_id: "ds" },
    },
    entrypoint: "SKILL.md",
    files,
    references: [
      { id: root, path: "SKILL.md", markdown: main },
      { id: reference, path: "references/guide.md", markdown: guide },
    ],
  }
  return { before, snapshot }
})
const consume = Effect.gen(function* () {
  const { before, snapshot } = yield* observe
  return { state: yield* verifyPublicationRead(before, snapshot, "current"), snapshot }
})

async function stage(host: Machine, notion: Remote) {
  await run(host, notion, preparePublicationIntegrity(operation, intended))
  await run(host, notion, startPublicationIntegrity(operation, root))
  await run(
    host,
    notion,
    Effect.gen(function* () {
      const api = yield* Notion
      yield* api.request(
        `v1/pages/${root}/markdown`,
        { markdown: new TextDecoder().decode(intended.files[0]!.bytes) },
        { method: "PATCH" },
      )
      yield* api.request(
        `v1/pages/${reference}/markdown`,
        { markdown: new TextDecoder().decode(intended.files[1]!.bytes) },
        { method: "PATCH" },
      )
    }),
  )
  notion.setAsset(intended.files[2]!.bytes)
  return (await run(host, notion, observe)).snapshot
}
async function committed() {
  const publisher = machine("publisher")
  const consumer = machine("consumer")
  const notion = remote()
  const snapshot = await stage(publisher, notion)
  const marker = await run(publisher, notion, commitPublicationIntegrity(operation, snapshot))
  return { publisher, consumer, notion, snapshot, marker }
}

// Capture typed failures without matching Effect's formatted FiberFailure strings.
const outcome = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.match({ onFailure: (error) => ({ error }), onSuccess: (value) => ({ value }) }),
  )

test("two independent machines reject the staged publication and verify the committed remote byte manifest", async () => {
  const publisher = machine("publisher")
  const consumer = machine("consumer")
  const notion = remote()
  const snapshot = await stage(publisher, notion)
  expect(notion.marker().version).toBe(2)
  expect(notion.marker().state).toBe("writing")
  expect(notion.markdown.get(root)).toBe("# Sample\n\nRead references/guide.md.\n")
  for (const host of [publisher, consumer]) {
    expect(await run(host, notion, outcome(consume))).toMatchObject({
      error: { code: "PUBLICATION_INCOMPLETE" },
    })
  }
  expect(consumer.persisted.size).toBe(0)
  const marker = await run(publisher, notion, commitPublicationIntegrity(operation, snapshot))
  const expectedFiles = intended.files
    .map(({ path, bytes }) => [path, bytes.length, digest(bytes)])
    .sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1))
  const manifestHash = digest(
    JSON.stringify({
      description: "Use for publication integrity.",
      entrypoint: "SKILL.md",
      files: expectedFiles,
      kind: "skill",
      name: "Sample Skill",
    }),
  )
  const ownershipHash = digest(
    JSON.stringify({
      default_context: false,
      members: [],
      ownership: {
        baseline: "",
        hash: "published-content-a",
        key: "skills/sample",
        mode: "tracked",
        revision: "upstream-revision-a",
        upstream: [database],
      },
    }),
  )
  expect(marker).toMatchObject({
    version: 2,
    state: "committed",
    manifest_hash: manifestHash,
    ownership_hash: ownershipHash,
  })
  expect(marker.revision).toBe(
    digest(JSON.stringify([operation, marker.intended_hash, manifestHash, ownershipHash])),
  )
  expect(notion.marker()).toEqual(marker)
  for (const host of [publisher, consumer]) {
    const observed = await run(host, notion, consume)
    expect(observed.state).toBe("committed")
    expect(
      observed.snapshot.files.map(({ path, bytes, sha256 }) => [path, bytes, sha256]).sort(),
    ).toEqual(expectedFiles)
    for (const file of intended.files)
      expect(host.objects.get(`objects/${digest(file.bytes)}`)).toEqual(file.bytes)
  }
})

for (const edit of [
  "main",
  "reference",
  "binary",
  "name",
  "description",
  "ownership",
  "members",
  "default_context",
] as const) {
  test(`a stable ${edit} edit is readable without accepting it as the original publication`, async () => {
    const { consumer, notion } = await committed()
    if (edit === "main") notion.markdown.set(root, "A direct main edit.")
    if (edit === "reference") notion.markdown.set(reference, "A direct reference edit.")
    if (edit === "binary") notion.setAsset(new Uint8Array([0, 255, 1, 129]))
    if (edit === "name")
      notion.properties.Name = { type: "title", title: [{ plain_text: "Renamed" }] }
    if (edit === "description") notion.properties.Description = rich("Changed description")
    if (edit === "ownership")
      notion.properties["Upstream Revision"] = rich("different-owner-revision")
    if (edit === "members")
      notion.properties.Members = {
        type: "relation",
        relation: [{ id: reference }],
        has_more: false,
      }
    if (edit === "default_context")
      notion.properties["Default Context"] = { type: "checkbox", checkbox: true }
    const marker = notion.marker()
    const mutations = notion.mutations
    const observed = await run(consumer, notion, consume)
    expect(observed.state).toBe("current")
    const fresh = await run(consumer, notion, observe)
    expect(
      await run(consumer, notion, outcome(verifyPublicationRead(fresh.before, fresh.snapshot))),
    ).toMatchObject({ error: { code: "PUBLICATION_DIVERGED" } })
    expect(notion.marker()).toEqual(marker)
    expect(notion.mutations).toBe(mutations)
  })
}

test("current consumption rejects a committed pointer with an invalid revision", async () => {
  const { consumer, notion } = await committed()
  notion.properties.Publication = rich(
    JSON.stringify({ ...notion.marker(), manifest_hash: digest("unverified content") }),
  )
  expect(await run(consumer, notion, outcome(consume))).toMatchObject({
    error: { code: "PUBLICATION_INVALID" },
  })
})

test("reference changed after observation rejects the read even when the root pointer is unchanged", async () => {
  const { consumer, notion } = await committed()
  const { before, snapshot } = await run(consumer, notion, observe)
  const pointer = notion.marker()
  notion.markdown.set(reference, "Changed between the graph read and verification.")
  expect(
    await run(consumer, notion, outcome(verifyPublicationRead(before, snapshot))),
  ).toMatchObject({ error: { code: "PUBLICATION_CHANGED", details: { page_id: reference } } })
  expect(notion.marker()).toEqual(pointer)
})

test("reference boundary asterisks match the stripped snapshot markdown", async () => {
  const { consumer, notion } = await committed()
  const { before, snapshot } = await run(consumer, notion, observe)
  const pointer = notion.marker()
  const stripped = {
    ...snapshot,
    references: snapshot.references!.map((page, index) =>
      index === 1 ? { ...page, markdown: "**`extends` vs `implements`**" } : page,
    ),
  }
  notion.markdown.set(reference, "**`extends`**** vs ****`implements`**")
  expect(await run(consumer, notion, outcome(verifyPublicationRead(before, stripped)))).toEqual({
    value: "committed",
  })
  expect(notion.marker()).toEqual(pointer)
})

test("a completion pointer replaced during the read rejects the observed snapshot", async () => {
  const { consumer, notion } = await committed()
  const { before, snapshot } = await run(consumer, notion, observe)
  notion.onNextPageRead(() => {
    notion.properties.Publication = rich(
      JSON.stringify({ ...notion.marker(), operation_id: "another-publisher" }),
    )
  })
  expect(
    await run(consumer, notion, outcome(verifyPublicationRead(before, snapshot))),
  ).toMatchObject({ error: { code: "PUBLICATION_CHANGED" } })
})

test("managed ownership changed during a read rejects even without a marker or timestamp update", async () => {
  const { consumer, notion } = await committed()
  const { before, snapshot } = await run(consumer, notion, observe)
  notion.onNextPageRead(() => {
    notion.properties["Sync Mode"] = { type: "select", select: { name: "fork" } }
  })
  expect(
    await run(consumer, notion, outcome(verifyPublicationRead(before, snapshot))),
  ).toMatchObject({ error: { code: "PUBLICATION_CHANGED" } })
})

test("an applied unknown commit reconciles the persisted exact intent against fresh remote state without writing", async () => {
  const publisher = machine("publisher")
  const notion = remote()
  const snapshot = await stage(publisher, notion)
  notion.loseCommit()
  expect(
    await run(publisher, notion, outcome(commitPublicationIntegrity(operation, snapshot))),
  ).toMatchObject({ error: { code: "WRITE_OUTCOME_UNKNOWN" } })
  const persisted = publisher.persisted.get(`integrity/operations/${operation}`)
  expect(persisted).toMatchObject({ page_id: root, marker: notion.marker() })
  expect(notion.marker().state).toBe("committed")
  const restarted = machine("restarted-publisher", new Map(publisher.persisted))
  const mutations = notion.mutations
  const fresh = await run(restarted, notion, observe)
  expect(
    await run(restarted, notion, reconcilePublicationIntegrity(operation, fresh.snapshot)),
  ).toEqual(notion.marker())
  expect(notion.mutations).toBe(mutations)
  // Persisted intent is evidence of the attempted commit, not evidence of remote content.
  notion.markdown.set(root, "Direct edit after the lost response.")
  const changed = await run(restarted, notion, observe)
  expect(
    await run(
      restarted,
      notion,
      outcome(reconcilePublicationIntegrity(operation, changed.snapshot)),
    ),
  ).toMatchObject({ error: { code: "PUBLICATION_DIVERGED" } })
  expect(notion.mutations).toBe(mutations)
})

test("reconciliation requires the exact persisted pointer and target page", async () => {
  const { publisher, notion, snapshot, marker } = await committed()
  notion.properties.Publication = rich(JSON.stringify({ ...marker, operation_id: "replacement" }))
  expect(
    await run(publisher, notion, reconcilePublicationIntegrity(operation, snapshot)),
  ).toBeUndefined()
  const other: Snapshot = {
    ...snapshot,
    record: {
      ...snapshot.record,
      locator: {
        type: "notion_page",
        page_id: reference,
        database_id: database,
        data_source_id: "ds",
      },
    },
  }
  expect(
    await run(publisher, notion, outcome(reconcilePublicationIntegrity(operation, other))),
  ).toMatchObject({ error: { code: "PUBLICATION_INTENT_CONFLICT" } })
})

for (const marker of [
  {
    version: 1,
    state: "writing",
    operation_id: operation,
    intended_hash: "a".repeat(64),
  },
  {
    version: 1,
    state: "committed",
    operation_id: operation,
    intended_hash: "a".repeat(64),
    revision: "b".repeat(64),
    manifest_hash: "c".repeat(64),
    ownership_hash: "d".repeat(64),
  },
  { version: 1, state: "malformed" },
] as const) {
  test(`version 1 ${marker.state} proof requires upgrade when consumed`, async () => {
    const host = machine("reader")
    const notion = remote()
    notion.properties.Publication = rich(JSON.stringify(marker))
    const properties = structuredClone(notion.properties)
    expect(await run(host, notion, outcome(consume))).toMatchObject({
      error: {
        code: "PUBLICATION_UPGRADE_REQUIRED",
        details: { page_id: root, proof_version: 1, required_proof_version: 2 },
      },
    })
    expect(notion.mutations).toBe(0)
    expect(notion.properties).toEqual(properties)
    expect(host.persisted.size).toBe(0)
  })

  test(`version 1 ${marker.state} proof rejects publication start before writes`, async () => {
    const host = machine("publisher")
    const notion = remote()
    await run(host, notion, preparePublicationIntegrity(operation, intended))
    notion.properties.Publication = rich(JSON.stringify(marker))
    const properties = structuredClone(notion.properties)
    const persisted = structuredClone([...host.persisted])
    expect(
      await run(host, notion, outcome(startPublicationIntegrity(operation, root))),
    ).toMatchObject({
      error: {
        code: "PUBLICATION_UPGRADE_REQUIRED",
        details: { page_id: root, proof_version: 1, required_proof_version: 2 },
      },
    })
    expect(notion.mutations).toBe(0)
    expect(notion.properties).toEqual(properties)
    expect([...host.persisted]).toEqual(persisted)
  })
}

for (const marker of ["missing", "empty", "bad-json", "bad-shape", "wrong-type"] as const) {
  test(`${marker} publication property is ${marker === "missing" || marker === "empty" ? "unmanaged" : "invalid"}`, async () => {
    const host = machine("reader")
    const notion = remote()
    if (marker === "missing") delete notion.properties.Publication
    if (marker === "bad-json") notion.properties.Publication = rich("{incomplete")
    if (marker === "bad-shape")
      notion.properties.Publication = rich('{"version":2,"state":"committed"}')
    if (marker === "wrong-type") notion.properties.Publication = { type: "select", select: null }
    const result = await run(host, notion, outcome(consume))
    expect(result).toMatchObject(
      marker === "missing" || marker === "empty"
        ? { value: { state: "unmanaged" } }
        : { error: { code: "PUBLICATION_INVALID" } },
    )
  })
}
