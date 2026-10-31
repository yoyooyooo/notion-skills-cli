import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import {
  hasLocalContentRestriction,
  localContentRestrictedHashes,
  markLocalContentRestriction,
} from "../src/content-restrictions.ts"
import { fail, SkillsError } from "../src/model.ts"
import { Store } from "../src/store.ts"
import { integrityRepositoryFixture, upstreamRepositoryFixture } from "./fixtures.ts"

const hash = "a".repeat(64)
const secondHash = "b".repeat(64)
const key = (value: string) => `content-restrictions/local/${value}.json`
const record = (value = hash) => ({ version: 1, sha256: value, reason: "local_resource" })

function fixture() {
  const records = new Map<string, unknown>()
  const reads: string[] = []
  const writes: string[] = []
  const unexpected = () => Effect.die(new Error("Unexpected Store operation."))
  const store: Store["Service"] = {
    root: "/controlled",
    configRoot: "/controlled/config",
    cacheRoot: "/controlled/cache",
    upstream: upstreamRepositoryFixture(),
    integrity: integrityRepositoryFixture(),
    reserveCacheGeneration: unexpected,
    listKeys: unexpected,
    retireKeys: unexpected,
    registerBindingWithBase: unexpected,
    advanceBaseAndReceipt: unexpected,
    backup: unexpected,
    output: unexpected,
    readBytes: unexpected,
    writeBytes: unexpected,
    readJson: (key, schema) =>
      Effect.try({
        try: () => {
          reads.push(key)
          return records.has(key) ? Schema.decodeUnknownSync(schema)(records.get(key)) : undefined
        },
        catch: () => fail("STATE_CORRUPT", "Controlled malformed restriction."),
      }),
    writeJson: (key, value) =>
      Effect.sync(() => {
        records.set(key, structuredClone(value))
        writes.push(key)
      }),
  }
  const run = <A, E>(effect: Effect.Effect<A, E, Store>, service = store) =>
    Effect.runPromise(effect.pipe(Effect.provideService(Store, service)))
  return { records, reads, writes, store, run }
}

test("local-content restrictions are durable semantic records and repeated marking only validates", async () => {
  const f = fixture()
  expect(await f.run(hasLocalContentRestriction(hash))).toBe(false)
  await f.run(markLocalContentRestriction(hash))
  expect(f.records.get(key(hash))).toEqual(record())
  expect(await f.run(hasLocalContentRestriction(hash))).toBe(true)
  await f.run(markLocalContentRestriction(hash))
  expect(f.writes).toEqual([key(hash)])
  expect(f.writes.every((address) => !address.startsWith("cache/"))).toBe(true)
  await f.run(markLocalContentRestriction(secondHash))
  expect(
    await f.run(localContentRestrictedHashes([secondHash, hash, secondHash, "c".repeat(64)])),
  ).toEqual([hash, secondHash])
})

test.each(["", "A".repeat(64), "a".repeat(63), "../secret"])(
  "invalid object identity performs no restriction I/O: %j",
  async (input) => {
    const f = fixture()
    expect((await f.run(Effect.flip(markLocalContentRestriction(input)))).code).toBe(
      "INVALID_CONTENT_RESTRICTION",
    )
    expect(f.reads).toHaveLength(0)
    expect(f.writes).toHaveLength(0)
  },
)

const malformed: readonly unknown[] = [
  null,
  {},
  { ...record(), version: 2 },
  { ...record(), sha256: secondHash },
  { ...record(), reason: "public" },
  { ...record(), absolute_root: "/private" },
]
test.each(malformed)(
  "malformed or mismatched restrictions fail closed and cannot be overwritten",
  async (value) => {
    const f = fixture()
    f.records.set(key(hash), value)
    const read = await f.run(Effect.flip(hasLocalContentRestriction(hash)))
    const mark = await f.run(Effect.flip(markLocalContentRestriction(hash)))
    expect(read.code).toBe("CONTENT_RESTRICTION_CORRUPT")
    expect(mark.code).toBe("CONTENT_RESTRICTION_CORRUPT")
    expect(JSON.stringify(read)).not.toContain("/private")
    expect(f.writes).toHaveLength(0)
  },
)

test("unreadable restriction state is not treated as permission to archive", async () => {
  const f = fixture()
  const service: Store["Service"] = {
    ...f.store,
    readJson: () => Effect.fail(fail("STORAGE_ERROR", "Controlled unavailable restriction state.")),
  }
  const error = await f.run(Effect.flip(hasLocalContentRestriction(hash)), service)
  expect(error).toBeInstanceOf(SkillsError)
  expect(error.code).toBe("STORAGE_ERROR")
})
