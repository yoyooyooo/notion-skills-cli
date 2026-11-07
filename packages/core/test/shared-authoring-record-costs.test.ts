import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { property, SkillsError, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { prepareSharedBodyWrite, executeSharedBodyWrite } from "../src/shared-body-write.ts"
import { bodyWriteOutcomesEntity } from "../src/shared-body-write-model.ts"
import { prepareSharedMetadataWrite } from "../src/shared-metadata-write.ts"
import {
  makeSharedMetadataWritePlan,
  sharedMetadataEntity,
  sharedMetadataOutcomeId,
} from "../src/shared-metadata-write-model.ts"
import { appendSharedRecord, canonicalSharedJson } from "../src/shared-records.ts"
import { openSharedSnapshot } from "../src/shared-snapshot.ts"
import {
  sharedSnapshotFixture,
  library,
  skillPage,
  digest,
  id,
  rich,
} from "./shared-snapshot-fixture.ts"

const families = [bodyWriteOutcomesEntity, sharedMetadataEntity].sort()

function entityFilters(value: unknown): readonly string[] {
  const filter = property(value)
  if (Array.isArray(filter.and)) return filter.and.flatMap(entityFilters)
  if (Array.isArray(filter.or)) return filter.or.flatMap(entityFilters)
  return filter.property === "entity" && typeof property(filter.rich_text).equals === "string"
    ? [String(property(filter.rich_text).equals)]
    : []
}

/** Produce valid immutable histories through the existing writer and Records boundary. */
async function completedHistory(metadataCount: number) {
  const f = sharedSnapshotFixture({ fileCount: 1 })
  await f.open()
  const plan = await f.run(
    prepareSharedBodyWrite({
      library,
      skillPageId: skillPage,
      fileId: "file-main",
      action: "write",
      candidateMarkdown: "# Updated native instructions\n\nRetain every author fact.\n",
    }),
  )
  const written = await f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      return yield* executeSharedBodyWrite(library, { plan, mode: "create" }).pipe(
        Effect.provideService(Notion, {
          ...api,
          request: (path, body, options) => {
            if (path === `v1/pages/${skillPage}/markdown` && options?.method === "PATCH") {
              f.bodies.set(skillPage, plan.candidate.markdown)
              f.main.last_edited_time = new Date(
                Date.parse(String(f.main.last_edited_time)) + 1,
              ).toISOString()
            }
            return api.request(path, body, options)
          },
        }),
      )
    }),
  )
  expect(written.status).toBe("applied")
  const prepared = await f.run(
    prepareSharedMetadataWrite({
      library,
      skillPageId: skillPage,
      changes: [{ field: "Description", value: "Historical description" }],
    }),
  )
  const { version: _version, kind: _kind, operation_id: _operationId, ...description } = prepared
  for (let index = 0; index < metadataCount; index++) {
    const original = await f.run(
      makeSharedMetadataWritePlan({ ...description, observed_at: prepared.observed_at + index }),
    )
    for (const [recordId, payload] of [
      [original.operation_id, original],
      [
        sharedMetadataOutcomeId(original.operation_id),
        {
          version: 1,
          kind: "metadata_write_outcome",
          operation_id: original.operation_id,
          status: "applied",
          reason_code: "EXACT_PROPERTY_RESPONSE_AND_READBACK_VERIFIED",
          observed: original.changes.map((change) => ({
            field: change.field,
            value: change.after,
          })),
        },
      ],
    ] as const)
      await f.run(
        appendSharedRecord(library, {
          mode: "create",
          recordId,
          operationId: original.operation_id,
          skillPageId: skillPage,
          kind: "operation",
          entityId: sharedMetadataEntity,
          payload,
        }),
      )
  }
  f.clearCalls()
  return f
}

function historyReads(f: ReturnType<typeof sharedSnapshotFixture>) {
  return f.calls.filter(
    (call) =>
      call.path.startsWith(`v1/data_sources/${library.records.data_source_id}/query`) &&
      new URL(call.path, "https://notion.test").searchParams
        .getAll("filter_properties")
        .includes("payload") &&
      entityFilters(property(call.body).filter).some((entity) => families.includes(entity)),
  )
}

const recordId = (row: unknown) =>
  text(property(property(property(row).properties).record).rich_text)

async function rejectedObservation(
  f: ReturnType<typeof sharedSnapshotFixture>,
  change: (response: Record<string, unknown>, rows: readonly unknown[]) => unknown,
) {
  const result = await f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      return yield* openSharedSnapshot({
        library,
        target: skillPage,
        scope: digest("shared-fixture-scope"),
        startedAt: Date.now(),
      }).pipe(
        Effect.provideService(Notion, {
          ...api,
          request: (path, body, options) =>
            api.request(path, body, options).pipe(
              Effect.map((raw) => {
                if (
                  canonicalSharedJson([...entityFilters(property(body).filter)].sort()) !==
                  canonicalSharedJson(families)
                )
                  return raw
                const response = property(raw)
                if (!Array.isArray(response.results))
                  throw new Error("Expected complete fixture rows")
                return change(response, response.results)
              }),
            ),
        }),
      )
    }).pipe(Effect.result),
  )
  if (result._tag !== "Failure" || !(result.failure instanceof SkillsError))
    throw new Error("Expected a typed original-history refusal")
  expect(f.writeCount()).toBe(0)
  return result.failure
}

describe("author history queries within one fresh snapshot", () => {
  test.each([0, 1, 50, 101])(
    "complete outcome and metadata families share actual pages at H=%i",
    async (history) => {
      const f = await completedHistory(history)
      const records = canonicalSharedJson([...f.records.values()])
      const snapshot = await f.open()
      expect(snapshot.files).toHaveLength(1)
      const main = snapshot.files.find((file) => file.path === snapshot.entrypoint)
      expect(main).toBeDefined()
      expect(new TextDecoder().decode(f.objects.get(`objects/${main!.sha256}`))).toContain(
        "Retain every author fact.",
      )
      const reads = historyReads(f)
      expect(reads).toHaveLength(Math.ceil((1 + history * 2) / 100))
      const selectedFamilies = history === 0 ? [bodyWriteOutcomesEntity] : families
      expect(
        reads.every(
          (call) =>
            canonicalSharedJson([...entityFilters(property(call.body).filter)].sort()) ===
            canonicalSharedJson(selectedFamilies),
        ),
      ).toBe(true)
      expect(f.writeCount()).toBe(0)
      expect(canonicalSharedJson([...f.records.values()])).toBe(records)

      f.clearCalls()
      const again = await f.open()
      expect(again.snapshot_id).toBe(snapshot.snapshot_id)
      expect(again.files).toEqual(snapshot.files)
      expect(historyReads(f)).toHaveLength(Math.ceil((1 + history * 2) / 100))
      expect(f.writeCount()).toBe(0)
    },
  )

  test.each([
    ["body outcome", "outcome-body-write-", "SHARED_BODY_WRITE_UNRESOLVED"],
    ["metadata plan", "metadata-write-", "SHARED_METADATA_WRITE_UNRESOLVED"],
    ["metadata outcome", "outcome-metadata-write-", "SHARED_METADATA_WRITE_UNRESOLVED"],
  ])(
    "a missing indexed %s never becomes absence of pending intent",
    async (_label, prefix, code) => {
      const f = await completedHistory(1)
      const before = canonicalSharedJson([...f.records.values()])
      const rejected = await rejectedObservation(f, (response, rows) => ({
        ...response,
        results: rows.filter((row) => !recordId(row).startsWith(prefix!)),
      }))
      expect(rejected.code).toBe(code!)
      expect(canonicalSharedJson([...f.records.values()])).toBe(before)
    },
  )

  test("a conflicting same-ID fact in either family still rejects the complete observation", async () => {
    const f = await completedHistory(1)
    const rejected = await rejectedObservation(f, (response, rows) => {
      const original = rows.find((row) => recordId(row).startsWith("outcome-body-write-"))
      if (original === undefined) throw new Error("Missing original outcome fixture")
      const duplicate = structuredClone(property(original))
      duplicate.id = id(88_888)
      const fields = property(duplicate.properties)
      const envelope = property(JSON.parse(text(property(fields.payload).rich_text)))
      property(envelope.payload).reason_code = "DIFFERENT_ORIGINAL_FACT"
      const canonical = canonicalSharedJson(envelope)
      fields.payload = rich("payload", canonical)
      fields.hash = rich("hash", digest(canonical))
      return { ...response, results: [...rows, duplicate] }
    })
    expect(rejected.code).toBe("SHARED_RECORD_CONFLICT")
  })

  test("a foreign owner cannot enter a shared outcome/metadata batch", async () => {
    const f = await completedHistory(1)
    const rejected = await rejectedObservation(f, (response, rows) => {
      const changed = structuredClone(property(rows[0]))
      property(changed.properties).skill = {
        id: "skill",
        type: "relation",
        relation: [{ id: id(88_889) }],
        has_more: false,
      }
      return { ...response, results: [changed, ...rows.slice(1)] }
    })
    expect(rejected.code).toBe("INVALID_SHARED_RECORD")
  })

  test("an incomplete combined response is never accepted as complete history", async () => {
    const f = await completedHistory(1)
    const rejected = await rejectedObservation(f, (response) => ({
      ...response,
      request_status: { type: "incomplete" },
    }))
    expect(rejected.code).toBe("INVALID_SHARED_RECORD")
  })

  test("repeated cursors in the combined query fail without replaying an operation", async () => {
    const f = await completedHistory(1)
    const rejected = await rejectedObservation(f, (response) => ({
      ...response,
      has_more: true,
      next_cursor: "offset-100",
    }))
    expect(rejected.code).toBe("INVALID_SHARED_RECORD")
    expect(historyReads(f)).toHaveLength(2)
  })
})
