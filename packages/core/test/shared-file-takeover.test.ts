import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import {
  executeSharedFileTakeover,
  prepareSharedFileTakeover,
} from "../src/shared-file-takeover.ts"
import { readSharedFileIntentContext } from "../src/shared-file-intent.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import {
  sharedSnapshotFixture,
  library,
  skillPage,
  id,
  digest,
  rich,
} from "./shared-snapshot-fixture.ts"
import {
  sourceRefreshFixture,
  library as sourceLibrary,
  sourceIds,
  relation,
} from "./shared-source-refresh-fixture.ts"

const path = "references/1.md"
function followingFixture() {
  const f = sharedSnapshotFixture()
  f.seedFact(
    {
      kind: "projected",
      file_id: "file-1",
      event_id: "projected-C1",
      parents: [],
      source_revision: "commit-C1",
      projection: { normalization_version: 1, sha256: digest(f.bodies.get(id(11))!) },
    },
    "file_event",
    "file-1",
    "projected-C1",
  )
  property(f.main.properties).source = rich("source", "bundle-selected-C2")
  const prepare = () => f.run(prepareSharedFileTakeover({ library, skillPageId: skillPage, path }))
  return { ...f, prepare }
}

describe("explicit whole-file takeover", () => {
  test("unchanged C1 display becomes custom even when C2 is selected; Status is not authority", async () => {
    const f = followingFixture(),
      original = f.bodies.get(id(11)),
      other = f.bodies.get(id(12))
    const before = await f.run(
      readSharedFileIntentContext({ library, skillPageId: skillPage, path }),
    )
    expect(before.state?.ownership.kind).toBe("following")
    expect(property(property(f.files[0]!.properties).status).select).toEqual({ name: "custom" })
    const prepared = await f.prepare()
    expect(prepared.plan.source_context.selected_version).toBe("bundle-selected-C2")
    expect(prepared.plan.observation.event.parents).toEqual(["projected-C1"])
    expect(f.writeCount()).toBe(0)
    f.clearCalls()
    const applied = await f.run(
      executeSharedFileTakeover({ library, plan: prepared.plan, mode: "create" }),
    )
    expect(applied.status).toBe("verified_applied")
    expect(applied.state.ownership.kind).toBe("custom")
    expect(applied.body_writes).toBe(0)
    expect(f.bodies.get(id(11))).toBe(original)
    expect(f.bodies.get(id(12))).toBe(other)
    expect(f.calls.some((call) => call.method === "PATCH")).toBe(false)
    const accepted = await f.run(
      readSharedFileIntentContext({ library, skillPageId: skillPage, path }),
    )
    expect(accepted.events.find((event) => event.kind === "adopted")?.parents).toEqual([
      "projected-C1",
    ])
    expect(JSON.stringify([...f.records.values()])).toContain("Reference one")
    const recordCount = f.records.size
    f.clearCalls()
    expect(
      (await f.run(executeSharedFileTakeover({ library, plan: prepared.plan, mode: "reconcile" })))
        .status,
    ).toBe("verified_applied")
    const again = await f.prepare()
    expect(
      (await f.run(executeSharedFileTakeover({ library, plan: again.plan, mode: "create" })))
        .status,
    ).toBe("unchanged")
    expect(f.records.size).toBe(recordCount)
    expect(f.writeCount()).toBe(0)
  })

  test.each(["body", "selected", "frontier"] as const)(
    "a changed %s invalidates the frozen plan before any write",
    async (change) => {
      const f = followingFixture(),
        prepared = await f.prepare()
      if (change === "body") f.bodies.set(id(11), "Late human edit\n")
      if (change === "selected")
        property(f.main.properties).source = rich("source", "bundle-selected-C3")
      if (change === "frontier")
        f.seedFact(
          {
            kind: "adopted",
            file_id: "file-1",
            event_id: "other-adoption",
            parents: ["projected-C1"],
            content: { object_id: "other-body", sha256: digest("Reference one\n"), bytes: 14 },
          },
          "file_event",
          "file-1",
          "other-adoption",
        )
      f.clearCalls()
      await expect(
        f.run(executeSharedFileTakeover({ library, plan: prepared.plan, mode: "create" })),
      ).rejects.toMatchObject({ code: "SHARED_FILE_INTENT_STALE" })
      expect(f.writeCount()).toBe(0)
      expect(f.calls.some((call) => call.method === "PATCH")).toBe(false)
    },
  )

  test.each(["configuration", "origin", "member"] as const)(
    "the same native page cannot hide a changed live Source %s",
    async (change) => {
      const f = await sourceRefreshFixture()
      const prepared = await f.run(
        prepareSharedFileTakeover({ library: sourceLibrary, skillPageId: skillPage, path }),
      )
      expect(prepared.plan.source_context.definition?.source_id).toBe("refresh-source")
      expect(prepared.plan.source_context.definition?.member).toBe("skills/demo")
      if (change === "configuration")
        property(f.source.properties)[sourceIds.Description!] = rich(
          sourceIds.Description!,
          "Changed live definition",
        )
      if (change === "origin") {
        property(f.main.properties).origin = relation("origin", [])
        property(f.main.properties).source_member = rich("source_member", "")
      }
      if (change === "member")
        property(f.main.properties).source_member = rich("source_member", "skills/other")
      f.clearCalls()
      await expect(
        f.run(
          executeSharedFileTakeover({
            library: sourceLibrary,
            plan: prepared.plan,
            mode: "create",
          }),
        ),
      ).rejects.toMatchObject({ code: "SHARED_FILE_INTENT_STALE" })
      expect(f.writeCount()).toBe(0)
    },
  )

  test("an unknown accepted event only reconciles its original facts; a new plan cannot replay", async () => {
    const f = followingFixture(),
      prepared = await f.prepare()
    f.unknownEvent()
    await expect(
      f.run(executeSharedFileTakeover({ library, plan: prepared.plan, mode: "create" })),
    ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
    const count = f.records.size
    await expect(f.prepare()).rejects.toMatchObject({ code: "SHARED_FILE_INTENT_PENDING" })
    f.clearCalls()
    const result = await f.run(
      executeSharedFileTakeover({ library, plan: prepared.plan, mode: "reconcile" }),
    )
    expect(result.status).toBe("verified_applied")
    expect(f.writeCount()).toBe(0)
    expect(f.records.size).toBe(count)
  })

  test.each(["operation", "object", "file_event"] as const)(
    "unknown unaccepted %s remains pending and cannot be replaced",
    async (stage) => {
      const f = followingFixture(),
        prepared = await f.prepare()
      f.unknownRecord(stage, false)
      await expect(
        f.run(executeSharedFileTakeover({ library, plan: prepared.plan, mode: "create" })),
      ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
      await expect(f.prepare()).rejects.toMatchObject({ code: "SHARED_FILE_INTENT_PENDING" })
      f.clearCalls()
      await expect(
        f.run(executeSharedFileTakeover({ library, plan: prepared.plan, mode: "reconcile" })),
      ).rejects.toMatchObject({ code: "SHARED_RECORD_UNRESOLVED" })
      expect(f.writeCount()).toBe(0)
    },
  )

  test("a late edit after full-body retention prevents the ownership event and preserves original recovery", async () => {
    const f = followingFixture(),
      prepared = await f.prepare()
    let changed = false
    const action = Effect.gen(function* () {
      const api = yield* Notion
      const controlled: Notion["Service"] = {
        ...api,
        request: (requestPath, body, options) =>
          api.request(requestPath, body, options).pipe(
            Effect.tap(() => {
              const kind = property(property(property(body).properties).kind).select
              if (!changed && requestPath === "v1/pages" && property(kind).name === "object") {
                changed = true
                f.bodies.set(id(11), "New edit during retention\n")
              }
              return Effect.void
            }),
          ),
      }
      return yield* executeSharedFileTakeover({
        library,
        plan: prepared.plan,
        mode: "create",
      }).pipe(Effect.provideService(Notion, controlled))
    })
    await expect(f.run(action)).rejects.toMatchObject({ code: "SHARED_FILE_INTENT_STALE" })
    expect(changed).toBe(true)
    expect(f.bodies.get(id(11))).toBe("New edit during retention\n")
    const context = await f.run(
      readSharedFileIntentContext({ library, skillPageId: skillPage, path }),
    )
    expect(context.state?.ownership.kind).toBe("following")
    expect(context.events.some((event) => event.kind === "adopted")).toBe(false)
    expect(canonicalSharedJson([...f.json.values()])).toContain(
      prepared.plan.observation.operation_id,
    )
    f.clearCalls()
    await expect(
      f.run(executeSharedFileTakeover({ library, plan: prepared.plan, mode: "reconcile" })),
    ).rejects.toMatchObject({ code: "SHARED_RECORD_UNRESOLVED" })
    expect(f.writeCount()).toBe(0)
  })

  test("main takeover uses Main File ID, and a tampered plan never reaches a writer", async () => {
    const f = sharedSnapshotFixture()
    const prepared = await f.run(
      prepareSharedFileTakeover({ library, skillPageId: skillPage, path: "SKILL.md" }),
    )
    expect(prepared.plan.observation.file_id).toBe("file-main")
    const bad = { ...prepared.plan, path: "references/1.md" }
    await expect(
      f.run(executeSharedFileTakeover({ library, plan: bad, mode: "create" })),
    ).rejects.toMatchObject({ code: "SHARED_FILE_INTENT_INVALID" })
    expect(f.writeCount()).toBe(0)
    const applied = await f.run(
      executeSharedFileTakeover({ library, plan: prepared.plan, mode: "create" }),
    )
    expect(applied.file_id).toBe("file-main")
    expect(applied.state.ownership.kind).toBe("custom")
  })
})
