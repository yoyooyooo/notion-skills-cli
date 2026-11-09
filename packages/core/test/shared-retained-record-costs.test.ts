import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Notion } from "../src/notion.ts"
import { property, text } from "../src/model.ts"
import { prepareSharedBodyWrite, executeSharedBodyWrite } from "../src/shared-body-write.ts"
import { bodyWriteObservationId, bodyWriteOutcomeId } from "../src/shared-body-write-model.ts"
import { reviewSharedBodyWrite } from "../src/shared-body-write-review.ts"
import { assertRequestBudget } from "../src/request-metrics.ts"
import { digest, library, sharedSnapshotFixture, skillPage } from "./shared-snapshot-fixture.ts"

const observed = "# Observed instructions\nOne server-merged paragraph.\n"
const recordId = (row: Record<string, unknown>) =>
  text(property(property(row.properties).record).rich_text)

async function reviewedFixture() {
  const f = sharedSnapshotFixture({ fileCount: 2 })
  await f.open()
  const plan = await f.run(
    prepareSharedBodyWrite({
      library,
      skillPageId: skillPage,
      fileId: "file-main",
      action: "write",
      candidateMarkdown: "# Authored instructions\n\nTwo distinct paragraphs.\n",
    }),
  )
  const attempted = await f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      return yield* executeSharedBodyWrite(library, { plan, mode: "create" }).pipe(
        Effect.provideService(Notion, {
          ...api,
          request: (path, body, options) => {
            if (options?.method === "PATCH" && path === `v1/pages/${skillPage}/markdown`) {
              f.bodies.set(skillPage, observed)
              f.main.last_edited_time = new Date(
                Date.parse(String(f.main.last_edited_time)) + 1,
              ).toISOString()
            }
            return api.request(path, body, options)
          },
        }),
        Effect.result,
      )
    }),
  )
  expect(attempted._tag).toBe("Failure")
  const outcome = [...f.records.values()].find(
    (row) => recordId(row) === bodyWriteOutcomeId(plan.operation_id),
  )
  expect(outcome).toBeDefined()
  const encodedOutcome = text(property(property(property(outcome).properties).payload).rich_text)
  expect(property(property(JSON.parse(encodedOutcome)).payload).status).toBe("needs_review")
  const accepted = await f.run(
    reviewSharedBodyWrite({
      library,
      skillPageId: skillPage,
      originalOperationId: plan.operation_id,
      acceptedObservedSha256: digest(observed),
      scope: digest("shared-fixture-scope"),
      mode: "create",
      dryRun: false,
    }),
  )
  expect(accepted.status).toBe("reviewed")
  return { f, plan, accepted }
}

describe("retained Records on an expired shared consumer read", () => {
  test("a fully reviewed write retains its original facts without downloading them on every unchanged read", async () => {
    const { f, plan } = await reviewedFixture()
    const first = await f.open()
    const originalRows = [...f.records.values()].map((row) => JSON.stringify(row)).sort()
    f.clearCalls()
    const unchanged = await f.open()
    expect(unchanged.snapshot_id).toBe(first.snapshot_id)
    expect(f.requestMetrics().body_requests).toEqual({
      current_body: 0,
      retained_body: 0,
      unclassified_body: 0,
    })
    expect(f.requestMetrics().requests).toEqual({
      notion_metadata: 16,
      notion_body: 0,
      notion_write: 0,
      provider: 0,
    })
    // P=3 metadata pages plus one Skill row. This single reviewed history adds
    // exactly 12 queries: pending outcome/plan (2), original facts (5),
    // retained review version (1), review (4).
    expect(() =>
      assertRequestBudget(f.requestMetrics(), {
        scenario: "ttl_expired",
        fileCount: 2,
        metadataPages: 3,
        metadataConstant: 13,
      }),
    ).not.toThrow()
    expect(f.writeCount()).toBe(0)
    expect([...f.records.values()].map((row) => JSON.stringify(row)).sort()).toEqual(originalRows)
    expect(
      [...f.records.values()].some(
        (row) => recordId(row) === bodyWriteObservationId(plan.operation_id),
      ),
    ).toBe(true)
  })
})
