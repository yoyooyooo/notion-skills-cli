import { afterAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { property } from "../src/model.ts"
import { trashPath } from "../src/local-locks.ts"
import { sourceRich } from "../src/shared-source-definitions.ts"
import { discoverRegisteredSourceMembers } from "../src/shared-source-member-discovery.ts"
import { invalidateMaterializationFacts } from "../src/shared-source-materialization-management.ts"
import {
  sourceMemberCacheKey,
  SourceMemberCacheSchema,
} from "../src/shared-source-materialization-state.ts"
import { Store } from "../src/store.ts"
import { library, materializationFixture } from "./shared-source-materialization-fixture.ts"

const root = mkdtempSync(join(tmpdir(), "materialization-invalidation-unit-"))
afterAll(async () => {
  if (process.platform === "darwin") await Effect.runPromise(trashPath(root))
})

test("a rejected stale registration retires its target candidate and permits fresh discovery", async () => {
  const f = await materializationFixture(root)
  const old = await f.run(discoverRegisteredSourceMembers(library, { query: "legacy-root" }))
  await f.run(discoverRegisteredSourceMembers(library, { query: "legacy-required" }))
  const request = await f.request()
  const key = sourceMemberCacheKey(old.scope, library.library_id)
  const view = `cache/views/${old.scope}/old-catalog.json`
  f.json.set(view, {})
  property(
    property(f.pages.get(f.sourcePage)!.properties)[library.sources.property_ids.Name!],
  ).title = sourceRich("Changed registered name")
  const blocked = await f.materialize(request)
  expect(blocked).toMatchObject({
    status: "blocked",
    reason: "SOURCE_REGISTRATION_CHANGED",
    affected_skill_ids: [],
    effects: { remote_writes: "none" },
  })
  f.clearCalls()
  await f.run(invalidateMaterializationFacts(library, blocked))
  expect(f.calls).toEqual([])
  expect(f.json.has(view)).toBe(false)
  const cached = await f.run(
    Effect.flatMap(Store, (store) => store.readJson(key, SourceMemberCacheSchema)),
  )
  expect(cached?.candidates.map((candidate) => candidate.expected_skill_id)).toEqual([
    "legacy-required",
  ])
  const fresh = await f.run(discoverRegisteredSourceMembers(library, { query: "legacy-root" }))
  expect(fresh.coverage).toBe("complete")
  expect(fresh.candidates[0]!.registration_digest).not.toBe(old.candidates[0]!.registration_digest)
  const retried = await f.materialize({
    ...request,
    request_id: "fresh-explicit-selection",
    target: {
      ...request.target,
      registration_digest: fresh.candidates[0]!.registration_digest,
    },
  })
  expect(retried).toMatchObject({
    status: "ready",
    effects: { remote_writes: "management", projection: "none" },
  })
})
