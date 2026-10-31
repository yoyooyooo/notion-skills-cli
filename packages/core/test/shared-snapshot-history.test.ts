import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { fail, property, text, type Snapshot } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import {
  prepareSharedSnapshotHistory,
  retainSharedSnapshotHistory,
  restoreSharedSnapshotHistory,
  validateSharedSnapshotHistoryPlan,
  SHARED_HISTORY_CHUNK_BYTES,
  type SharedSnapshotHistoryPlan,
} from "../src/shared-snapshot-history.ts"
import {
  sharedSnapshotFixture,
  library,
  skillPage,
  id,
  digest,
  encode,
  rich,
} from "./shared-snapshot-fixture.ts"

type Fixture = ReturnType<typeof sharedSnapshotFixture>
function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing fixture value: ${label}`)
  return value
}
function reidentify(
  snapshot: Snapshot,
  version = snapshot.version_id,
  scope = snapshot.scope,
): Snapshot {
  return {
    ...snapshot,
    scope,
    version_id: version,
    snapshot_id: `s_${digest(JSON.stringify([scope, snapshot.record.id, version]))}`,
  }
}

async function archiveFixture() {
  const f = sharedSnapshotFixture()
  const original = await f.open()
  const large = new Uint8Array(SHARED_HISTORY_CHUNK_BYTES * 2 + 7).fill(7)
  large[large.length - 1] = 255
  const extras = [
    { path: "assets/icon.bin", bytes: large },
    { path: "empty.dat", bytes: new Uint8Array() },
    { path: "scripts/check.sh", bytes: encode("#!/bin/sh\r\nexit 91\r\n") },
  ]
  for (const file of extras) f.objects.set(`objects/${digest(file.bytes)}`, file.bytes.slice())
  const files = [
    ...original.files,
    ...extras.map((file) => ({
      path: file.path,
      bytes: file.bytes.length,
      sha256: digest(file.bytes),
    })),
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const snapshot = reidentify(
    { ...original, files },
    digest(canonicalSharedJson({ files, record: original.record })),
  )
  const expected = new Map(
    snapshot.files.map((file) => [
      file.path,
      required(f.objects.get(`objects/${file.sha256}`), file.path).slice(),
    ]),
  )
  f.clearCalls()
  return { f, snapshot, expected, large }
}

function kind(row: Record<string, unknown>): string {
  return String(property(property(property(row.properties).kind).select).name)
}

function rewritePayload(
  row: Record<string, unknown>,
  transform: (value: Record<string, unknown>) => unknown,
) {
  const props = property(row.properties)
  const envelope = property(JSON.parse(text(property(props.payload).rich_text)))
  const changed = { ...envelope, payload: transform(property(envelope.payload)) }
  const encoded = canonicalSharedJson(changed)
  props.payload = rich("payload", encoded)
  props.hash = rich("hash", digest(encoded))
}

function retainWithLostManifestReply(f: Fixture, plan: SharedSnapshotHistoryPlan) {
  return f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      let lost = false
      const controlled: Notion["Service"] = {
        ...api,
        request: (path, body, options) =>
          api.request(path, body, options).pipe(
            Effect.flatMap((value) => {
              const selectedKind = property(property(property(body).properties).kind).select
              if (!lost && path === "v1/pages" && property(selectedKind).name === "snapshot") {
                lost = true
                return Effect.fail(
                  fail("WRITE_OUTCOME_UNKNOWN", "Controlled lost manifest response."),
                )
              }
              return Effect.succeed(value)
            }),
          ),
      }
      return yield* retainSharedSnapshotHistory(library, { plan, mode: "create" }).pipe(
        Effect.provideService(Notion, controlled),
      )
    }),
  )
}

describe("shared snapshot history primitives", () => {
  test("prepares a scope-independent pin and freezes the complete exact byte plan without network access", async () => {
    const { f, snapshot } = await archiveFixture()
    const plan = await f.run(prepareSharedSnapshotHistory(library, snapshot))
    const otherScope = reidentify(
      { ...snapshot, created_at: snapshot.created_at + 1000 },
      snapshot.version_id,
      "different-credential-scope",
    )
    const same = await f.run(prepareSharedSnapshotHistory(library, otherScope))
    expect(same.pin_id).toBe(plan.pin_id)
    expect(plan.pin_id).toBe(`snapshot-${digest(canonicalSharedJson(plan.manifest))}`)
    expect(Object.hasOwn(plan.manifest, "scope")).toBe(false)
    expect(Object.hasOwn(plan.manifest, "snapshot_id")).toBe(false)
    expect(canonicalSharedJson(plan.manifest)).not.toContain(snapshot.scope)
    expect(plan.manifest.materialization_rule).toEqual({ version: 1 })
    const large = required(
      plan.manifest.files.find((file) => file.path === "assets/icon.bin"),
      "large file",
    )
    expect(large.chunks.map((chunk) => chunk.bytes)).toEqual([
      SHARED_HISTORY_CHUNK_BYTES,
      SHARED_HISTORY_CHUNK_BYTES,
      7,
    ])
    expect(large.chunks[0]?.object_id).toBe(large.chunks[1]?.object_id)
    expect(
      required(
        plan.manifest.files.find((file) => file.path === "empty.dat"),
        "empty file",
      ).chunks,
    ).toEqual([])
    expect(new Set(plan.objects.map((object) => object.object_id)).size).toBe(plan.objects.length)
    property(snapshot.record).description = "Changed after prepare"
    expect(plan.manifest.record.description).toBe("Managed description")
    expect(f.calls).toHaveLength(0)
  })

  test("publishes exact-byte objects before one complete manifest and reuses a completed archive", async () => {
    const { f, snapshot } = await archiveFixture()
    const plan = await f.run(prepareSharedSnapshotHistory(library, snapshot))
    const result = await f.run(retainSharedSnapshotHistory(library, { plan, mode: "create" }))
    expect(result.pin_id).toBe(plan.pin_id)
    expect(result.verification).toBe("objects_and_manifest")
    expect(f.writeCount()).toBe(plan.objects.length + 1)
    const creates = f.calls.filter((call) => call.path === "v1/pages" && call.method === "POST")
    const last = required(creates.at(-1), "manifest create")
    expect(property(property(property(last.body).properties).kind).select).toEqual({
      name: "snapshot",
    })
    expect(f.readBodyCount()).toBe(0)
    for (const object of plan.objects) {
      expect(
        new TextEncoder().encode(
          canonicalSharedJson({
            version: 1,
            operation_id: `retain-${object.object_id}`,
            payload: object.payload,
          }),
        ).length,
      ).toBeLessThan(64 * 1024)
    }
    f.clearCalls()
    expect(
      (await f.run(retainSharedSnapshotHistory(library, { plan, mode: "create" }))).pin_id,
    ).toBe(plan.pin_id)
    expect(f.calls).toHaveLength(1)
    expect(f.writeCount()).toBe(0)
    expect(f.requestMetrics().requests.notion_body).toBe(0)
  })

  test("an existing completion record does not claim a fresh check of archived byte availability", async () => {
    const { f, snapshot } = await archiveFixture()
    const plan = await f.run(prepareSharedSnapshotHistory(library, snapshot))
    await f.run(retainSharedSnapshotHistory(library, { plan, mode: "create" }))
    const missing = required(plan.objects[0], "chunk").object_id
    for (const [page, row] of f.records)
      if (text(property(property(row.properties).record).rich_text) === missing)
        f.records.delete(page)
    f.clearCalls()
    const committed = await f.run(retainSharedSnapshotHistory(library, { plan, mode: "reconcile" }))
    expect(committed.verification).toBe("manifest")
    expect(f.calls).toHaveLength(1)
    expect(f.writeCount()).toBe(0)
    const unavailable = await f.run(
      Effect.flip(
        restoreSharedSnapshotHistory(library, { skillPageId: skillPage, pinId: plan.pin_id }),
      ),
    )
    expect(unavailable.code).toBe("SHARED_HISTORY_MISSING")
    expect(f.readBodyCount()).toBe(0)
  })

  test("restores exact historical binary, CRLF script and final main bytes without local or current-body substitution", async () => {
    const { f, snapshot, expected } = await archiveFixture()
    const plan = await f.run(prepareSharedSnapshotHistory(library, snapshot))
    await f.run(retainSharedSnapshotHistory(library, { plan, mode: "create" }))
    f.objects.clear()
    f.json.clear()
    f.bodies.set(skillPage, "A completely different current Notion body.\n")
    f.clearCalls()
    const restored = await f.run(
      restoreSharedSnapshotHistory(library, { skillPageId: skillPage, pinId: plan.pin_id }),
    )
    expect(restored.manifest).toEqual(plan.manifest)
    expect(restored.files.map((file) => file.path)).toEqual(snapshot.files.map((file) => file.path))
    for (const file of restored.files)
      expect(file.bytes).toEqual(required(expected.get(file.path), file.path))
    expect(f.calls).toHaveLength(plan.objects.length + 1)
    expect(
      f.calls.every((call) =>
        call.path.includes(`/data_sources/${library.records.data_source_id}/query`),
      ),
    ).toBe(true)
    expect(f.readBodyCount()).toBe(0)
    expect(f.writeCount()).toBe(0)
    expect(f.objects.size).toBe(0)
    expect(f.json.size).toBe(0)
    expect(f.requestMetrics().requests.notion_body).toBe(plan.objects.length)
  })

  test("a distinct frozen version reuses exact existing chunks and only creates its new manifest", async () => {
    const { f, snapshot } = await archiveFixture()
    const first = await f.run(prepareSharedSnapshotHistory(library, snapshot))
    await f.run(retainSharedSnapshotHistory(library, { plan: first, mode: "create" }))
    const next = await f.run(
      prepareSharedSnapshotHistory(
        library,
        reidentify(snapshot, digest("different fixed ownership revision")),
      ),
    )
    expect(next.pin_id).not.toBe(first.pin_id)
    expect(next.objects).toEqual(first.objects)
    f.clearCalls()
    await f.run(retainSharedSnapshotHistory(library, { plan: next, mode: "create" }))
    expect(f.writeCount()).toBe(1)
    expect(f.readBodyCount()).toBe(0)
  })

  test("an accepted manifest with a lost response reconciles its original IDs without another create", async () => {
    const { f, snapshot } = await archiveFixture()
    const plan = await f.run(prepareSharedSnapshotHistory(library, snapshot))
    await expect(retainWithLostManifestReply(f, plan)).rejects.toThrow(
      "Controlled lost manifest response",
    )
    const manifestCount = [...f.records.values()].filter((row) => kind(row) === "snapshot").length
    expect(manifestCount).toBe(1)
    f.clearCalls()
    const found = await f.run(retainSharedSnapshotHistory(library, { plan, mode: "reconcile" }))
    expect(found.pin_id).toBe(plan.pin_id)
    expect(f.calls).toHaveLength(1)
    expect(f.writeCount()).toBe(0)
  })

  test("an unknown object write cannot publish a partial manifest or replay on reconcile", async () => {
    const { f, snapshot } = await archiveFixture()
    const plan = await f.run(prepareSharedSnapshotHistory(library, snapshot))
    f.unknownRecord("object", true)
    const failed = await f.run(
      Effect.flip(retainSharedSnapshotHistory(library, { plan, mode: "create" })),
    )
    expect(failed.code).toBe("WRITE_OUTCOME_UNKNOWN")
    expect([...f.records.values()].filter((row) => kind(row) === "snapshot")).toHaveLength(0)
    f.bodies.set(skillPage, "A later edit must not replace the original archive plan.")
    f.objects.clear()
    f.clearCalls()
    const unresolved = await f.run(
      Effect.flip(retainSharedSnapshotHistory(library, { plan, mode: "reconcile" })),
    )
    expect(unresolved.code).toBe("SHARED_RECORD_UNRESOLVED")
    expect(f.writeCount()).toBe(0)
    expect(f.readBodyCount()).toBe(0)
  })

  test("missing archived chunks fail despite available current page bodies", async () => {
    const { f, snapshot } = await archiveFixture()
    const plan = await f.run(prepareSharedSnapshotHistory(library, snapshot))
    await f.run(retainSharedSnapshotHistory(library, { plan, mode: "create" }))
    const objectId = required(plan.objects[0], "chunk").object_id
    for (const [page, row] of f.records)
      if (text(property(property(row.properties).record).rich_text) === objectId)
        f.records.delete(page)
    f.clearCalls()
    const error = await f.run(
      Effect.flip(
        restoreSharedSnapshotHistory(library, { skillPageId: skillPage, pinId: plan.pin_id }),
      ),
    )
    expect(error.code).toBe("SHARED_HISTORY_MISSING")
    expect(f.readBodyCount()).toBe(0)
    expect(f.writeCount()).toBe(0)
  })

  test("a manifest with a recomputed record Hash still cannot change the pinned content", async () => {
    const { f, snapshot } = await archiveFixture()
    const plan = await f.run(prepareSharedSnapshotHistory(library, snapshot))
    await f.run(retainSharedSnapshotHistory(library, { plan, mode: "create" }))
    const row = required(
      [...f.records.values()].find((row) => kind(row) === "snapshot"),
      "manifest row",
    )
    rewritePayload(row, (payload) => ({
      ...payload,
      record: { ...property(payload.record), description: "Tampered frozen description" },
    }))
    f.clearCalls()
    const error = await f.run(
      Effect.flip(
        restoreSharedSnapshotHistory(library, { skillPageId: skillPage, pinId: plan.pin_id }),
      ),
    )
    expect(error.code).toBe("SHARED_HISTORY_INVALID")
    expect(f.calls).toHaveLength(1)
    expect(f.requestMetrics().requests.notion_body).toBe(0)
  })

  test("a valid record envelope cannot hide a byte chunk checksum mismatch", async () => {
    const { f, snapshot } = await archiveFixture()
    const plan = await f.run(prepareSharedSnapshotHistory(library, snapshot))
    await f.run(retainSharedSnapshotHistory(library, { plan, mode: "create" }))
    const row = required(
      [...f.records.values()].find(
        (row) =>
          kind(row) === "object" &&
          text(property(property(row.properties).record).rich_text).startsWith("chunk-"),
      ),
      "exact byte object",
    )
    rewritePayload(row, (payload) => ({
      ...payload,
      data:
        typeof payload.data === "string"
          ? `${payload.data[0] === "A" ? "B" : "A"}${payload.data.slice(1)}`
          : "",
    }))
    const error = await f.run(
      Effect.flip(
        restoreSharedSnapshotHistory(library, { skillPageId: skillPage, pinId: plan.pin_id }),
      ),
    )
    expect(error.code).toBe("SHARED_HISTORY_INVALID")
  })

  test("identical concurrent chunk facts deduplicate while conflicting facts fail closed", async () => {
    const { f, snapshot } = await archiveFixture()
    const plan = await f.run(prepareSharedSnapshotHistory(library, snapshot))
    await f.run(retainSharedSnapshotHistory(library, { plan, mode: "create" }))
    const row = required(
      [...f.records.values()].find(
        (row) =>
          kind(row) === "object" &&
          text(property(property(row.properties).record).rich_text).startsWith("chunk-"),
      ),
      "exact byte object",
    )
    const duplicate = { ...structuredClone(row), id: id(999) }
    f.records.set(id(999), duplicate)
    expect(
      (
        await f.run(
          restoreSharedSnapshotHistory(library, { skillPageId: skillPage, pinId: plan.pin_id }),
        )
      ).pin_id,
    ).toBe(plan.pin_id)
    rewritePayload(duplicate, (payload) => ({ ...payload, bytes: 1 }))
    const error = await f.run(
      Effect.flip(
        restoreSharedSnapshotHistory(library, { skillPageId: skillPage, pinId: plan.pin_id }),
      ),
    )
    expect(error.code).toBe("SHARED_RECORD_CONFLICT")
  })

  test("preflight rejects altered or incomplete plans before any remote request", async () => {
    const { f, snapshot } = await archiveFixture()
    const plan = await f.run(prepareSharedSnapshotHistory(library, snapshot))
    const invalid = { ...plan, objects: plan.objects.slice(1) }
    expect(
      (await f.run(Effect.flip(validateSharedSnapshotHistoryPlan(library, invalid)))).code,
    ).toBe("SHARED_HISTORY_INVALID")
    const error = await f.run(
      Effect.flip(retainSharedSnapshotHistory(library, { plan: invalid, mode: "create" })),
    )
    expect(error.code).toBe("SHARED_HISTORY_INVALID")
    expect(f.calls).toHaveLength(0)
  })

  test("an oversized complete manifest fails preflight rather than truncating files or creating partial history", async () => {
    const { f, snapshot } = await archiveFixture()
    const exemplar = required(
      snapshot.files.find((file) => file.path === "empty.dat"),
      "empty file",
    )
    const files = [
      ...snapshot.files,
      ...Array.from({ length: 1000 }, (_, index) => ({
        ...exemplar,
        path: `extra/${String(index).padStart(4, "0")}.dat`,
      })),
    ]
    const huge = reidentify({ ...snapshot, files }, digest("oversized complete manifest"))
    const error = await f.run(Effect.flip(prepareSharedSnapshotHistory(library, huge)))
    expect(error.code).toBe("SHARED_HISTORY_TOO_LARGE")
    expect(f.calls).toHaveLength(0)
  })

  test("historical restoration rejects another Skill and an invalid pin before using current content", async () => {
    const { f, snapshot } = await archiveFixture()
    const plan = await f.run(prepareSharedSnapshotHistory(library, snapshot))
    await f.run(retainSharedSnapshotHistory(library, { plan, mode: "create" }))
    f.clearCalls()
    const invalidPin = await f.run(
      Effect.flip(
        restoreSharedSnapshotHistory(library, {
          skillPageId: skillPage,
          pinId: snapshot.snapshot_id,
        }),
      ),
    )
    expect(invalidPin.code).toBe("SHARED_HISTORY_INVALID")
    expect(f.calls).toHaveLength(0)
    const wrongSkill = await f.run(
      Effect.flip(
        restoreSharedSnapshotHistory(library, { skillPageId: id(998), pinId: plan.pin_id }),
      ),
    )
    expect(wrongSkill.code).toBe("SHARED_HISTORY_MISSING")
    expect(f.readBodyCount()).toBe(0)
  })

  test("a changed stable Skill identity fails before downloading any archived chunks", async () => {
    const { f, snapshot } = await archiveFixture()
    const plan = await f.run(prepareSharedSnapshotHistory(library, snapshot))
    await f.run(retainSharedSnapshotHistory(library, { plan, mode: "create" }))
    f.clearCalls()
    const error = await f.run(
      Effect.flip(
        restoreSharedSnapshotHistory(library, {
          skillPageId: skillPage,
          pinId: plan.pin_id,
          expectedSkillId: "different-stable-skill",
        }),
      ),
    )
    expect(error.code).toBe("SHARED_HISTORY_SCOPE")
    expect(f.calls).toHaveLength(1)
    expect(f.requestMetrics().requests.notion_body).toBe(0)
    expect(f.writeCount()).toBe(0)
  })
})
