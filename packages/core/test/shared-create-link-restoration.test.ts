import { expect, test } from "bun:test"
import { Effect } from "effect"
import { authScope } from "../src/catalog.ts"
import {
  applySharedCreateRestoration,
  reconcileSharedCreateRestoration,
} from "../src/shared-create-restoration.ts"
import { openSharedConsumer } from "../src/shared-consumer.ts"
import { sharedCreateOutcomeId } from "../src/shared-create-outcome.ts"
import { canonicalSharedJson, querySharedRecords } from "../src/shared-records.ts"
import { failedLinkedOriginal } from "./shared-create-link-restoration-fixture.ts"

test.each([14, 15] as const)(
  "v3 repairs the complete original cyclic owner with policy %s and preserves the failure",
  async (policy) => {
    const x = await failedLinkedOriginal(policy),
      { f } = x
    const dry = await f.run(applySharedCreateRestoration({ ...x.apply, dryRun: true }))
    expect(dry).toMatchObject({
      status: "planned",
      write_plan: { maximum_native_page_creates: 5, existing_body_patches: 3 },
    })
    expect(f.writes()).toHaveLength(0)
    const result = await f.run(applySharedCreateRestoration(x.apply))
    expect(result).toMatchObject({
      verified: true,
      operation_id: x.plan.operation_id,
      skill_page_id: x.page,
    })
    expect(f.nativeCreates()).toHaveLength(5)
    expect(
      f
        .writes()
        .filter((request) => request.method === "PATCH" && request.path.endsWith("/markdown")),
    ).toHaveLength(3)
    expect(f.enablePatches().filter((request) => !request.path.endsWith("/markdown"))).toHaveLength(
      1,
    )
    const original = await f.run(
      querySharedRecords(f.library, {
        skillPageId: x.page,
        kind: "operation",
        recordId: sharedCreateOutcomeId(x.plan.operation_id),
      }),
    )
    expect(canonicalSharedJson(original[0])).toBe(x.originalFailure)
    f.clear()
    expect(await f.run(applySharedCreateRestoration(x.apply))).toMatchObject({
      verified: true,
      reused: true,
    })
    expect(f.writes()).toHaveLength(0)
    f.base.json.clear()
    f.base.objects.clear()
    f.credential("independent-linked-reader")
    expect(await f.run(reconcileSharedCreateRestoration(x.selected))).toMatchObject({
      verified: true,
    })
    const snapshot = await f.run(
      Effect.gen(function* () {
        return yield* openSharedConsumer({
          library: f.library,
          target: x.page,
          scope: yield* authScope,
          startedAt: Date.now(),
          forceFull: true,
          readOnly: true,
        })
      }),
    )
    expect(snapshot.files.map((file) => file.path).sort()).toEqual(
      [...x.plan.files, ...(x.plan.resources ?? [])].map((file) => file.path).sort(),
    )
    expect(f.writes()).toHaveLength(0)
  },
)
