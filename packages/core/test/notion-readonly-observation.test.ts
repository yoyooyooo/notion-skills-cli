import { expect, test } from "bun:test"
import { Effect } from "effect"
import { decode, property } from "../src/model.ts"
import { withReadOnlyNotion } from "../src/notion-readonly.ts"
import { observeSharedFile } from "../src/shared-file-observer.ts"
import { SharedObservationPlanSchema } from "../src/shared-observation-operation.ts"
import { library, sharedSnapshotFixture, skillPage } from "./shared-snapshot-fixture.ts"

const input = {
  library,
  skillPageId: skillPage,
  fileId: "file-main",
  pageId: skillPage,
  events: [],
  plans: [],
  bodyWrites: [],
  initialNative: true,
} as const

test("an auto-adopting consumer cannot retain or create facts under a read-only capability", async () => {
  const fixture = sharedSnapshotFixture()
  const before = [...fixture.bodies]
  const denied = await fixture.run(withReadOnlyNotion(observeSharedFile(input)).pipe(Effect.result))
  expect(denied._tag).toBe("Failure")
  if (denied._tag !== "Failure") throw new Error("Expected the capability to stop adoption")
  expect(denied.failure.code).toBe("NOTION_READ_ONLY")
  expect(fixture.writeCount()).toBe(0)
  expect(fixture.records.size).toBe(0)
  expect([...fixture.bodies]).toEqual(before)

  const ordinary = await fixture.run(observeSharedFile(input))
  expect(ordinary.changed).toBe(true)
  expect(ordinary.state.ownership.kind).toBe("custom")
  expect(fixture.writeCount()).toBe(3)
  expect(fixture.records.size).toBe(3)
})

test.each([false, true])(
  "pending adoption recovery remains read-only when the original event acceptance is %s",
  async (accepted) => {
    const fixture = sharedSnapshotFixture()
    fixture.unknownRecord("file_event", accepted)
    const first = await fixture.run(observeSharedFile(input).pipe(Effect.result))
    expect(first._tag).toBe("Failure")
    if (first._tag !== "Failure") throw new Error("Expected the original unknown write")
    expect(first.failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
    const plan = decode(
      SharedObservationPlanSchema,
      property(property(first.failure.details).recovery).plan,
    )
    const originalRecords = structuredClone([...fixture.records])
    fixture.clearCalls()
    const recovered = await fixture.run(
      withReadOnlyNotion(observeSharedFile({ ...input, plans: [plan] })).pipe(Effect.result),
    )
    expect(recovered._tag).toBe("Failure")
    if (recovered._tag !== "Failure") throw new Error("Recovery must require a new current read")
    expect(recovered.failure.code).toBe(
      accepted ? "SHARED_OBSERVATION_RECONCILED" : "SHARED_RECORD_UNRESOLVED",
    )
    expect(fixture.writeCount()).toBe(0)
    expect([...fixture.records]).toEqual(originalRecords)
    expect(fixture.calls.some((call) => call.path.includes("/query"))).toBe(true)
  },
)
