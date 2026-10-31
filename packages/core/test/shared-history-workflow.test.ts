import { describe, expect, test } from "bun:test"
import { Crypto, Effect } from "effect"
import { authScope } from "../src/catalog.ts"
import {
  hasLocalContentRestriction,
  markLocalContentRestriction,
} from "../src/content-restrictions.ts"
import { decode, fail, property, SnapshotSchema, text, type Snapshot } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { parseTarget } from "../src/ref.ts"
import { archiveSharedHistory, restoreSharedHistory } from "../src/shared-history-workflow.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import { Store } from "../src/store.ts"
import {
  sharedSnapshotFixture,
  library,
  skillPage,
  digest,
  rich,
} from "./shared-snapshot-fixture.ts"

type Fixture = ReturnType<typeof sharedSnapshotFixture>
const historyPrefix = "operations/shared-snapshot-history/"

/** Reuse the common memory Store, adding only the newly introduced dispatch domain. */
function runHistory<A, E>(f: Fixture, effect: Effect.Effect<A, E, Store | Notion | Crypto.Crypto>) {
  return f.run(
    Effect.gen(function* () {
      const original = yield* Store
      const controlled: Store["Service"] = {
        ...original,
        retireKeys: (keys) =>
          keys.every((key) => key.startsWith(historyPrefix))
            ? Effect.sync(() =>
                keys.map((key) => {
                  f.json.delete(key)
                  return { key, retention_path: `retired/${key}` }
                }),
              )
            : original.retireKeys(keys),
      }
      return yield* effect.pipe(Effect.provideService(Store, controlled))
    }),
  )
}

async function historyFixture(binary = false) {
  const f = sharedSnapshotFixture({ fileCount: 1 })
  let snapshot: Snapshot = decode(
    SnapshotSchema,
    await f.target(parseTarget(skillPage), { database: library.skills.database_id }),
  )
  if (binary) {
    const bytes = new Uint8Array(70 * 1024)
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251
    f.objects.set(`objects/${digest(bytes)}`, bytes.slice())
    const files = [
      ...snapshot.files,
      { path: "assets/exact.bin", bytes: bytes.byteLength, sha256: digest(bytes) },
    ]
    const version = digest(canonicalSharedJson({ record: snapshot.record, files }))
    snapshot = {
      ...snapshot,
      files,
      version_id: version,
      snapshot_id: `s_${digest(JSON.stringify([snapshot.scope, snapshot.record.id, version]))}`,
    }
    f.json.set(`snapshots/${snapshot.snapshot_id}.json`, structuredClone(snapshot))
  }
  const expected = new Map(
    snapshot.files.map((file) => {
      const bytes = f.objects.get(`objects/${file.sha256}`)
      if (bytes === undefined) throw new Error("Missing fixture snapshot bytes")
      return [file.path, bytes.slice()] as const
    }),
  )
  f.clearCalls()
  return { f, snapshot, expected }
}

const pending = (f: Fixture) =>
  [...f.json.entries()].filter(([key]) => key.startsWith(historyPrefix))
const caches = (f: Fixture) =>
  structuredClone([...f.json.entries()].filter(([key]) => key.startsWith("cache/")))
const kind = (row: Record<string, unknown>) =>
  property(property(property(row.properties).kind).select).name

describe("shared history explicit save and restore workflows", () => {
  test("local bytes require explicit per-archive permission, which never removes their restriction", async () => {
    const { f, snapshot } = await historyFixture(true)
    const privateFile = snapshot.files.find((file) => file.path === "assets/exact.bin")!
    await runHistory(f, markLocalContentRestriction(privateFile.sha256))
    const refused = await runHistory(f, Effect.flip(archiveSharedHistory(library, snapshot)))
    expect(refused.code).toBe("LOCAL_RESOURCE_ARCHIVE_REQUIRED")
    expect(property(refused.details).paths).toEqual(["assets/exact.bin"])
    expect(f.writeCount()).toBe(0)
    expect(pending(f)).toHaveLength(0)
    const saved = await runHistory(
      f,
      archiveSharedHistory(library, snapshot, { allowLocalArchive: true }),
    )
    expect(saved.verification).toBe("objects_and_manifest")
    expect(await runHistory(f, hasLocalContentRestriction(privateFile.sha256))).toBe(true)
    f.clearCalls()
    const reconciled = await runHistory(
      f,
      archiveSharedHistory(library, snapshot, { mode: "reconcile" }),
    )
    expect(reconciled.shared_pin).toBe(saved.shared_pin)
    expect(f.writeCount()).toBe(0)
  })

  test("a corrupt local-content restriction blocks even an explicit archive before any POST", async () => {
    const { f, snapshot } = await historyFixture()
    const hash = snapshot.files[0]!.sha256
    f.json.set(`content-restrictions/local/${hash}.json`, {
      version: 1,
      sha256: hash,
      reason: "public",
    })
    const refused = await runHistory(
      f,
      Effect.flip(archiveSharedHistory(library, snapshot, { allowLocalArchive: true })),
    )
    expect(refused.code).toBe("CONTENT_RESTRICTION_CORRUPT")
    expect(f.writeCount()).toBe(0)
    expect(pending(f)).toHaveLength(0)
  })

  test("save validates current access and persists the frozen plan before any create", async () => {
    const { f, snapshot } = await historyFixture()
    const previousCaches = caches(f)
    const saved = await runHistory(
      f,
      Effect.gen(function* () {
        const api = yield* Notion
        const controlled: Notion["Service"] = {
          ...api,
          request: (path, body, options) =>
            Effect.gen(function* () {
              if (path === "v1/pages" && options?.method === "POST") {
                expect(pending(f)).toHaveLength(1)
                expect(property(pending(f)[0]?.[1]).snapshot_id).toBe(snapshot.snapshot_id)
              }
              return yield* api.request(path, body, options)
            }),
        }
        return yield* archiveSharedHistory(library, snapshot).pipe(
          Effect.provideService(Notion, controlled),
        )
      }),
    )
    expect(f.calls.slice(0, 3).map((call) => call.path)).toEqual([
      "v1/users/me",
      `v1/databases/${library.skills.database_id}`,
      `v1/pages/${skillPage}`,
    ])
    expect(saved.shared_pin).toMatch(/^snapshot-[a-f0-9]{64}$/u)
    expect(saved.snapshot_id).toBe(snapshot.snapshot_id)
    expect(saved.mode).toBe("create")
    expect(saved.verification).toBe("objects_and_manifest")
    expect(f.readBodyCount()).toBe(0)
    expect(pending(f)).toHaveLength(0)
    expect(caches(f)).toEqual(previousCaches)

    f.clearCalls()
    const repeated = await runHistory(f, archiveSharedHistory(library, snapshot))
    expect(repeated.shared_pin).toBe(saved.shared_pin)
    expect(repeated.mode).toBe("reconcile")
    expect(repeated.verification).toBe("manifest")
    expect(f.writeCount()).toBe(0)
    expect(f.readBodyCount()).toBe(0)
    expect(pending(f)).toHaveLength(0)
  })

  test("unknown chunk dispatch preserves the original plan even after local objects and current text change", async () => {
    const { f, snapshot } = await historyFixture()
    f.unknownRecord("object", true)
    const failed = await runHistory(f, Effect.flip(archiveSharedHistory(library, snapshot)))
    expect(failed.code).toBe("WRITE_OUTCOME_UNKNOWN")
    const original = structuredClone(pending(f))
    expect(original).toHaveLength(1)
    expect([...f.records.values()].filter((row) => kind(row) === "snapshot")).toHaveLength(0)
    f.objects.clear()
    f.bodies.set(skillPage, "A later body cannot replace the original history bytes")
    property(f.main.properties).description = rich("description", "Later management metadata")
    f.clearCalls()
    const repeated = await runHistory(
      f,
      Effect.flip(archiveSharedHistory(library, snapshot, { mode: "create" })),
    )
    expect(repeated.code).toBe("SHARED_RECORD_UNRESOLVED")
    expect(f.writeCount()).toBe(0)
    expect(f.readBodyCount()).toBe(0)
    expect(pending(f)).toEqual(original)
    expect(property(repeated.details).pending_journal).toBe(original[0]?.[0])

    const replacement = {
      ...snapshot,
      record: { ...snapshot.record, description: "Replacement under the same snapshot ID" },
    }
    const conflict = await runHistory(f, Effect.flip(archiveSharedHistory(library, replacement)))
    expect(conflict.code).toBe("SHARED_HISTORY_SCOPE")
    expect(pending(f)).toEqual(original)
    expect(f.writeCount()).toBe(0)
  })

  test("a lost manifest response reconciles its saved plan without rereading local objects", async () => {
    const { f, snapshot } = await historyFixture()
    const failed = await runHistory(
      f,
      Effect.gen(function* () {
        const api = yield* Notion
        let lost = false
        const controlled: Notion["Service"] = {
          ...api,
          request: (path, body, options) =>
            api.request(path, body, options).pipe(
              Effect.flatMap((value) => {
                if (
                  !lost &&
                  path === "v1/pages" &&
                  property(property(property(property(body).properties).kind).select).name ===
                    "snapshot"
                ) {
                  lost = true
                  return Effect.fail(
                    fail("WRITE_OUTCOME_UNKNOWN", "Controlled lost history manifest response"),
                  )
                }
                return Effect.succeed(value)
              }),
            ),
        }
        return yield* Effect.flip(
          archiveSharedHistory(library, snapshot).pipe(Effect.provideService(Notion, controlled)),
        )
      }),
    )
    expect(failed.code).toBe("WRITE_OUTCOME_UNKNOWN")
    expect(pending(f)).toHaveLength(1)
    f.objects.clear()
    f.bodies.set(skillPage, "Unrelated current text")
    f.clearCalls()
    const reconciled = await runHistory(f, archiveSharedHistory(library, snapshot))
    expect(reconciled.mode).toBe("reconcile")
    expect(reconciled.verification).toBe("manifest")
    const originalPin = property(failed.details).shared_pin
    if (typeof originalPin !== "string") throw new Error("Missing original history pin")
    expect(reconciled.shared_pin).toBe(originalPin)
    expect(pending(f)).toHaveLength(0)
    expect(f.writeCount()).toBe(0)
    expect(f.readBodyCount()).toBe(0)
  })

  test("an explicit reconcile with no prior dispatch never creates a journal or remote records", async () => {
    const { f, snapshot } = await historyFixture()
    const error = await runHistory(
      f,
      Effect.flip(archiveSharedHistory(library, snapshot, { mode: "reconcile" })),
    )
    expect(error.code).toBe("SHARED_RECORD_UNRESOLVED")
    expect(pending(f)).toHaveLength(0)
    expect(f.writeCount()).toBe(0)
    expect(f.readBodyCount()).toBe(0)
  })

  test("a retired dispatch cannot authorize recreating a temporarily missing shared manifest", async () => {
    const { f, snapshot } = await historyFixture()
    const saved = await runHistory(f, archiveSharedHistory(library, snapshot))
    for (const [page, row] of f.records) if (kind(row) === "snapshot") f.records.delete(page)
    f.clearCalls()
    const error = await runHistory(
      f,
      Effect.gen(function* () {
        const store = yield* Store
        return yield* Effect.flip(
          archiveSharedHistory(library, snapshot).pipe(
            Effect.provideService(Store, {
              ...store,
              writeJson: (key, value) =>
                key.startsWith(historyPrefix)
                  ? Effect.fail(
                      fail(
                        "STATE_CONFLICT",
                        "The original dispatch is retired and cannot be reopened",
                      ),
                    )
                  : store.writeJson(key, value),
            }),
          ),
        )
      }),
    )
    expect(error.code).toBe("STATE_CONFLICT")
    expect(property(error.details).shared_pin).toBe(saved.shared_pin)
    expect(property(error.details).next_mode).toBe("reconcile")
    expect(f.writeCount()).toBe(0)
    expect(f.readBodyCount()).toBe(0)
    expect(pending(f)).toHaveLength(0)
  })

  test("archive rejects another auth scope and a changed current Skill identity before writing history", async () => {
    const { f, snapshot } = await historyFixture()
    const foreign = {
      ...snapshot,
      scope: "different-scope",
      snapshot_id: `s_${digest(JSON.stringify(["different-scope", snapshot.record.id, snapshot.version_id]))}`,
    }
    const wrongScope = await runHistory(f, Effect.flip(archiveSharedHistory(library, foreign)))
    expect(wrongScope.code).toBe("SHARED_HISTORY_SCOPE")
    expect(f.calls.map((call) => call.path)).toEqual(["v1/users/me"])
    property(f.main.properties).skill_id = rich("skill_id", "replacement-skill")
    f.clearCalls()
    const wrongSkill = await runHistory(f, Effect.flip(archiveSharedHistory(library, snapshot)))
    expect(wrongSkill.code).toBe("SHARED_HISTORY_SCOPE")
    expect(f.writeCount()).toBe(0)
    expect(f.requestMetrics().requests.notion_body).toBe(0)
    expect(pending(f)).toHaveLength(0)
  })

  test("archive checks the registered library descriptor instead of trusting caller-supplied bindings", async () => {
    const { f, snapshot } = await historyFixture()
    const forged = { ...library, library_id: "library-other" }
    const error = await runHistory(f, Effect.flip(archiveSharedHistory(forged, snapshot)))
    expect(error.code).toBe("SHARED_HISTORY_SCOPE")
    expect(f.calls.map((call) => call.path)).toEqual([
      "v1/users/me",
      `v1/databases/${library.skills.database_id}`,
    ])
    expect(f.writeCount()).toBe(0)
  })

  test("restore under another current credential preserves exact bytes and frozen metadata without publishing current cache", async () => {
    const { f, snapshot, expected } = await historyFixture(true)
    const saved = await runHistory(f, archiveSharedHistory(library, snapshot))
    f.json.clear()
    f.objects.clear()
    f.bodies.clear()
    property(f.main.properties).description = rich("description", "New current description")
    property(f.main.properties).enabled = { id: "enabled", type: "checkbox", checkbox: false }
    f.clearCalls()
    const result = await runHistory(
      f,
      Effect.gen(function* () {
        const api = yield* Notion
        const different: Notion["Service"] = {
          ...api,
          credentialIdentity: Effect.succeed("different-current-credential"),
        }
        const scope = yield* authScope.pipe(Effect.provideService(Notion, different))
        const restored = yield* restoreSharedHistory(library, {
          skillPageId: skillPage,
          pinId: saved.shared_pin,
        }).pipe(Effect.provideService(Notion, different))
        return { scope, restored }
      }),
    )
    expect(result.scope).not.toBe(snapshot.scope)
    expect(result.restored.scope).toBe(result.scope)
    expect(result.restored.snapshot_id).toBe(
      `s_${digest(JSON.stringify([result.scope, snapshot.record.id, snapshot.version_id]))}`,
    )
    expect(result.restored.shared_pin).toBe(saved.shared_pin)
    expect(result.restored.record).toEqual(snapshot.record)
    expect(result.restored.source).toBe("local_snapshot")
    expect(result.restored.freshness).toEqual({ policy: "pinned" })
    expect(f.readBodyCount()).toBe(0)
    expect(f.writeCount()).toBe(0)
    expect([...f.json.keys()]).toEqual([`snapshots/${result.restored.snapshot_id}.json`])
    const restoredManifest = decode(
      SnapshotSchema,
      f.json.get(`snapshots/${result.restored.snapshot_id}.json`),
    )
    expect(restoredManifest.historical_snapshot_id).toBeUndefined()
    for (const file of restoredManifest.files)
      expect(f.objects.get(`objects/${file.sha256}`)).toEqual(expected.get(file.path))
  })

  test("restoring an existing local identity repairs missing objects but preserves its original immutable manifest", async () => {
    const { f, snapshot } = await historyFixture()
    const saved = await runHistory(f, archiveSharedHistory(library, snapshot))
    const key = `snapshots/${snapshot.snapshot_id}.json`
    const originalManifest = structuredClone(f.json.get(key))
    const previousCaches = caches(f)
    f.objects.clear()
    f.clearCalls()
    const restored = await runHistory(
      f,
      Effect.gen(function* () {
        const store = yield* Store
        return yield* restoreSharedHistory(library, {
          skillPageId: skillPage,
          pinId: saved.shared_pin,
        }).pipe(
          Effect.provideService(Store, {
            ...store,
            writeJson: (path, value) =>
              path === key
                ? Effect.fail(
                    fail(
                      "UNEXPECTED_MANIFEST_WRITE",
                      "Existing history must reuse its original manifest",
                    ),
                  )
                : store.writeJson(path, value),
          }),
        )
      }),
    )
    expect(restored.snapshot_id).toBe(snapshot.snapshot_id)
    expect(f.json.get(key)).toEqual(originalManifest)
    expect(caches(f)).toEqual(previousCaches)
    expect(f.readBodyCount()).toBe(0)
    expect(f.writeCount()).toBe(0)
    for (const file of snapshot.files)
      expect(digest(f.objects.get(`objects/${file.sha256}`) ?? new Uint8Array())).toBe(file.sha256)
  })

  test("a conflicting local manifest is preserved and cannot be overwritten by restoration", async () => {
    const { f, snapshot } = await historyFixture()
    const saved = await runHistory(f, archiveSharedHistory(library, snapshot))
    const key = `snapshots/${snapshot.snapshot_id}.json`
    const corrupt = {
      ...snapshot,
      record: { ...snapshot.record, description: "Conflicting immutable record" },
    }
    f.json.set(key, structuredClone(corrupt))
    f.objects.clear()
    const error = await runHistory(
      f,
      Effect.flip(
        restoreSharedHistory(library, { skillPageId: skillPage, pinId: saved.shared_pin }),
      ),
    )
    expect(error.code).toBe("STATE_CORRUPT")
    expect(f.json.get(key)).toEqual(corrupt)
    expect(f.objects.size).toBe(0)
  })

  test("a changed current stable Skill ID prevents retained byte downloads", async () => {
    const { f, snapshot } = await historyFixture()
    const saved = await runHistory(f, archiveSharedHistory(library, snapshot))
    property(f.main.properties).skill_id = rich("skill_id", "replacement-skill")
    f.clearCalls()
    const error = await runHistory(
      f,
      Effect.flip(
        restoreSharedHistory(library, { skillPageId: skillPage, pinId: saved.shared_pin }),
      ),
    )
    expect(error.code).toBe("SHARED_HISTORY_SCOPE")
    expect(f.requestMetrics().requests.notion_body).toBe(0)
    expect(f.writeCount()).toBe(0)
  })

  test("current metadata denial fails before querying archived records", async () => {
    const { f, snapshot } = await historyFixture()
    const saved = await runHistory(f, archiveSharedHistory(library, snapshot))
    f.main.in_trash = true
    f.clearCalls()
    await expect(
      runHistory(
        f,
        restoreSharedHistory(library, { skillPageId: skillPage, pinId: saved.shared_pin }),
      ),
    ).rejects.toThrow()
    expect(f.calls).toHaveLength(3)
    expect(
      f.calls.some((call) =>
        call.path.includes(`/data_sources/${library.records.data_source_id}/`),
      ),
    ).toBe(false)
    expect(f.requestMetrics().requests.notion_body).toBe(0)
    expect(f.writeCount()).toBe(0)
  })

  test("missing fixed chunks publish no local manifest and never fall back to current body", async () => {
    const { f, snapshot } = await historyFixture()
    const saved = await runHistory(f, archiveSharedHistory(library, snapshot))
    for (const [page, row] of f.records) {
      const recordId = text(property(property(row.properties).record).rich_text)
      if (recordId.startsWith("chunk-")) f.records.delete(page)
    }
    f.json.clear()
    f.objects.clear()
    f.clearCalls()
    const error = await runHistory(
      f,
      Effect.flip(
        restoreSharedHistory(library, { skillPageId: skillPage, pinId: saved.shared_pin }),
      ),
    )
    expect(error.code).toBe("SHARED_HISTORY_MISSING")
    expect(f.json.size).toBe(0)
    expect(f.objects.size).toBe(0)
    expect(f.readBodyCount()).toBe(0)
    expect(f.writeCount()).toBe(0)
  })
})
