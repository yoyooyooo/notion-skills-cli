import { expect, test } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { PortableSkill } from "../src/portable.ts"
import { preparePublicationIntegrity } from "../src/publication-integrity.ts"
import type {
  BaselineIntent,
  CommittedMarker,
  IntegrityIntent,
} from "../src/publication-integrity-state.ts"
import { PublicationReceiptSchema } from "../src/publication-model.ts"
import { Store, StoreLive } from "../src/store.ts"

const operation = "p_real-integrity-store"
const hash = "a".repeat(64)
const otherHash = "b".repeat(64)
const prepared: IntegrityIntent = {
  version: 1,
  operation_id: operation,
  intended_hash: hash,
  marker: { version: 2, operation_id: operation, intended_hash: hash, state: "writing" },
}
const committed: CommittedMarker = {
  ...prepared.marker,
  state: "committed",
  revision: "c".repeat(64),
  manifest_hash: "d".repeat(64),
  ownership_hash: "e".repeat(64),
}
const baseline: BaselineIntent = {
  version: 1,
  operation_id: "baseline-real-store",
  parent_page_id: "parent-page",
  hash,
  payload: '{"files":["SKILL.md"],"content":"中文 baseline"}',
  state: "prepared",
}

interface StoreClient {
  <A, E>(effect: Effect.Effect<A, E, Store | NodeServices.NodeServices>): Promise<A>
}

async function withStore<A>(use: (run: StoreClient) => Promise<A>) {
  const directory = await mkdtemp(join(tmpdir(), "ntn-publication-integrity-"))
  try {
    return await use(client(directory))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function client(directory: string): StoreClient {
  const config = ConfigProvider.fromUnknown({
    NTN_SKILLS_HOME: join(directory, "state"),
    NTN_SKILLS_CONFIG_HOME: join(directory, "config"),
    NTN_SKILLS_CACHE_HOME: join(directory, "cache"),
  })
  // Every invocation builds and closes its own official Node SQL layer and scope.
  return <A, E>(effect: Effect.Effect<A, E, Store | NodeServices.NodeServices>) =>
    Effect.runPromise(
      Effect.scoped(
        effect.pipe(
          Effect.provide(StoreLive.pipe(Layer.provideMerge(NodeServices.layer))),
          Effect.provide(ConfigProvider.layer(config)),
        ),
      ),
    )
}

const outcome = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.match({
      onFailure: (error) => ({ error }),
      onSuccess: (value) => ({ value }),
    }),
  )

test("StoreLive prepares integrity before a publication receipt exists and reopens both by operation ID", async () => {
  await withStore(async (run) => {
    const portable: PortableSkill = {
      kind: "skill",
      name: "Durable publication",
      description: "Actual official SQL preparation without Notion",
      main: "SKILL.md",
      files: [
        { path: "references/guide.md", bytes: new TextEncoder().encode("# Guide 中文\n") },
        { path: "SKILL.md", bytes: new TextEncoder().encode("# Durable\n") },
      ],
    }
    const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex")
    const files = [...portable.files].sort((a, b) => (a.path < b.path ? -1 : 1))
    const intendedHash = digest(
      JSON.stringify([
        portable.kind,
        portable.name,
        portable.description,
        portable.main,
        files.map((file) => [file.path, file.bytes.length, digest(file.bytes)]),
      ]),
    )
    const marker = await run(
      Effect.gen(function* () {
        const store = yield* Store
        expect(yield* store.integrity.inspect(operation)).toBeUndefined()
        expect(
          yield* store.readJson(`publications/${operation}.json`, PublicationReceiptSchema),
        ).toBeUndefined()
        const marker = yield* preparePublicationIntegrity(operation, portable)
        expect(marker.version).toBe(2)
        expect(marker.intended_hash).toBe(intendedHash)
        expect(yield* store.integrity.inspect(operation)).toEqual({
          version: 1,
          operation_id: operation,
          intended_hash: intendedHash,
          marker,
        })
        expect(
          yield* store.readJson(`publications/${operation}.json`, PublicationReceiptSchema),
        ).toBeUndefined()
        return marker
      }),
    )
    await run(
      Effect.gen(function* () {
        const store = yield* Store
        expect((yield* store.integrity.inspect(operation))?.marker).toEqual(marker)
        expect(yield* preparePublicationIntegrity(operation, portable)).toEqual(marker)
        expect(
          yield* outcome(preparePublicationIntegrity(operation, { ...portable, name: "Changed" })),
        ).toMatchObject({ error: { code: "PUBLICATION_INTENT_CONFLICT" } })
        for (const file of portable.files)
          yield* store.writeBytes(`objects/${digest(file.bytes)}`, file.bytes)
        yield* store.writeJson(`publications/${operation}.json`, {
          format: 1,
          operation_id: operation,
          operation: "create",
          state: "prepared",
          portable: {
            kind: portable.kind,
            name: portable.name,
            description: portable.description,
            main: portable.main,
            files: portable.files.map((file) => ({ path: file.path, sha256: digest(file.bytes) })),
          },
          guards: {},
          intents: [],
          stages: [],
        })
      }),
    )
    await run(
      Effect.gen(function* () {
        const store = yield* Store
        const receipt = yield* store.readJson(
          `publications/${operation}.json`,
          PublicationReceiptSchema,
        )
        expect(receipt?.operation_id).toBe(marker.operation_id)
        expect((yield* store.integrity.inspect(receipt!.operation_id))?.marker).toEqual(marker)
      }),
    )
  })
})

test("StoreLive binds the exact writing target then durably records a committed marker", async () => {
  await withStore(async (run) => {
    await run(
      Effect.gen(function* () {
        const store = yield* Store
        yield* store.integrity.prepare(prepared)
        yield* store.integrity.prepare(prepared)
        expect(yield* store.integrity.inspect(operation)).toEqual(prepared)
      }),
    )
    const bound = { ...prepared, page_id: "exact-page" }
    await run(
      Effect.gen(function* () {
        const store = yield* Store
        expect(yield* store.integrity.inspect(operation)).toEqual(prepared)
        yield* store.integrity.update(bound)
      }),
    )
    await run(
      Effect.gen(function* () {
        const store = yield* Store
        expect(yield* store.integrity.inspect(operation)).toEqual(bound)
        yield* store.integrity.update({ ...bound, marker: committed })
      }),
    )
    await run(
      Effect.gen(function* () {
        const store = yield* Store
        expect(yield* store.integrity.inspect(operation)).toEqual({ ...bound, marker: committed })
      }),
    )
  })
})

test("StoreLive rejects retained version 1 proof before schema decoding without changing SQL state", async () => {
  await withStore(async (run) => {
    const root = await run(Effect.map(Store, (store) => store.root))
    const database = new DatabaseSync(join(root, "state.sqlite"))
    try {
      const legacy = {
        ...prepared,
        marker: { ...prepared.marker, version: 1 },
      }
      database
        .prepare(
          "INSERT INTO integrity_operations (operation_id, publication_operation_id, intended_hash, state, page_id, payload) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(operation, operation, hash, "writing", null, JSON.stringify(legacy))
      const before = database.prepare("SELECT * FROM integrity_operations").all()
      await run(
        Effect.gen(function* () {
          const store = yield* Store
          expect(yield* outcome(store.integrity.inspect(operation))).toMatchObject({
            error: { code: "PUBLICATION_UPGRADE_REQUIRED" },
          })
        }),
      )
      expect(database.prepare("SELECT * FROM integrity_operations").all()).toEqual(before)
    } finally {
      database.close()
    }
  })
})

test("StoreLive refuses changed operation hashes, marker identities, targets and committed downgrades", async () => {
  await withStore(async (run) => {
    const bound = { ...prepared, page_id: "exact-page" }
    await run(
      Effect.gen(function* () {
        const store = yield* Store
        yield* store.integrity.prepare(prepared)
        yield* store.integrity.update(bound)
        const changedHash = {
          ...bound,
          intended_hash: otherHash,
          marker: { ...bound.marker, intended_hash: otherHash },
        }
        for (const change of [
          store.integrity.prepare(changedHash),
          store.integrity.update(changedHash),
          store.integrity.update({ ...bound, operation_id: "p_other-operation" }),
          store.integrity.update({
            ...bound,
            marker: { ...bound.marker, operation_id: "p_other-operation" },
          }),
          store.integrity.update({ ...bound, page_id: "another-page" }),
          store.integrity.update(prepared),
        ]) {
          expect(yield* outcome(change)).toMatchObject({
            error: { code: "PUBLICATION_INTENT_CONFLICT" },
          })
          expect(yield* store.integrity.inspect(operation)).toEqual(bound)
        }
        const complete = { ...bound, marker: committed }
        yield* store.integrity.update(complete)
        for (const marker of [bound.marker, { ...committed, revision: otherHash }]) {
          expect(yield* outcome(store.integrity.update({ ...bound, marker }))).toMatchObject({
            error: { code: "PUBLICATION_INTENT_CONFLICT" },
          })
          expect(yield* store.integrity.inspect(operation)).toEqual(complete)
        }
      }),
    )
    await run(
      Effect.gen(function* () {
        const store = yield* Store
        expect(yield* store.integrity.inspect(operation)).toEqual({ ...bound, marker: committed })
        expect(yield* store.integrity.inspect("p_other-operation")).toBeUndefined()
      }),
    )
  })
})

test("StoreLive persists baseline payload and exact target through reopened clients", async () => {
  await withStore(async (run) => {
    await run(
      Effect.gen(function* () {
        const store = yield* Store
        expect(yield* store.integrity.baseline(baseline.operation_id)).toBeUndefined()
        yield* store.integrity.saveBaseline(baseline)
      }),
    )
    await run(
      Effect.gen(function* () {
        const store = yield* Store
        expect(yield* store.integrity.baseline(baseline.operation_id)).toEqual(baseline)
        yield* store.integrity.saveBaseline({ ...baseline, state: "unknown" })
        yield* store.integrity.saveBaseline({
          ...baseline,
          state: "created",
          page_id: "baseline-page",
        })
        yield* store.integrity.saveBaseline({
          ...baseline,
          state: "complete",
          page_id: "baseline-page",
        })
      }),
    )
    const complete: BaselineIntent = { ...baseline, state: "complete", page_id: "baseline-page" }
    await run(
      Effect.gen(function* () {
        const store = yield* Store
        expect(yield* store.integrity.baseline(baseline.operation_id)).toEqual(complete)
        for (const changed of [
          { ...complete, payload: "changed" },
          { ...complete, hash: otherHash },
          { ...complete, parent_page_id: "different-parent" },
          { ...complete, page_id: "different-target" },
          baseline,
        ]) {
          expect(yield* outcome(store.integrity.saveBaseline(changed))).toMatchObject({
            error: { code: "BASELINE_INTENT_CONFLICT" },
          })
          expect(yield* store.integrity.baseline(baseline.operation_id)).toEqual(complete)
        }
      }),
    )
  })
})

test("unknown JSON domains reject while cache retirement preserves typed integrity and baseline intents", async () => {
  await withStore(async (run) => {
    await run(
      Effect.gen(function* () {
        const store = yield* Store
        yield* store.integrity.prepare(prepared)
        yield* store.integrity.saveBaseline(baseline)
        for (const key of [
          `publication-integrity/${operation}.json`,
          `integrity_operations/${operation}.json`,
          `upstream_baselines/${baseline.operation_id}.json`,
          "unknown-domain/value.json",
        ]) {
          expect(yield* outcome(store.writeJson(key, prepared))).toMatchObject({
            error: { code: "INVALID_ARGUMENT" },
          })
          expect(yield* outcome(store.readJson(key, Schema.Unknown))).toMatchObject({
            error: { code: "INVALID_ARGUMENT" },
          })
        }
        const key = "cache/identities/disposable.json"
        yield* store.writeJson(key, { scope: "fixture" })
        expect(yield* store.readJson(key, Schema.Unknown)).toEqual({ scope: "fixture" })
        yield* store.retireKeys([key])
        expect(yield* store.readJson(key, Schema.Unknown)).toBeUndefined()
        expect(
          yield* outcome(store.retireKeys([`integrity_operations/${operation}.json`])),
        ).toMatchObject({ error: { code: "INVALID_ARGUMENT" } })
      }),
    )
    await run(
      Effect.gen(function* () {
        const store = yield* Store
        expect(
          yield* store.readJson("cache/identities/disposable.json", Schema.Unknown),
        ).toBeUndefined()
        expect(yield* store.integrity.inspect(operation)).toEqual(prepared)
        expect(yield* store.integrity.baseline(baseline.operation_id)).toEqual(baseline)
      }),
    )
  })
})
