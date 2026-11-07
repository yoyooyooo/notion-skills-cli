import { describe, expect, test } from "bun:test"
import { Crypto, Effect, FileSystem, Path } from "effect"
import { HttpClient } from "effect/http"
import { fail, property, SkillsError, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { Store } from "../src/store.ts"
import { fileRef, parseTarget } from "../src/ref.ts"
import { updateSkill } from "../src/command-operations.ts"
import { readSkill } from "../src/snapshot.ts"
import { querySharedOperationIndex } from "../src/shared-operation-index.ts"
import {
  executeSharedMetadataWrite,
  executeSharedMetadataWriteWithJournal,
  loadPendingSharedMetadataWrites,
  prepareSharedMetadataWrite,
  reconcileSharedMetadataWrite,
  validateSharedMetadataWritePlan,
  type SharedMetadataWritePlan,
} from "../src/shared-metadata-write.ts"
import { sharedSnapshotFixture, library, skillPage, rich, id } from "./shared-snapshot-fixture.ts"

type Fixture = ReturnType<typeof sharedSnapshotFixture>
const changes = [
  { field: "Name", value: "Updated display name" },
  { field: "Default Context", value: true },
] as const
const prepare = (
  selected:
    | typeof changes
    | readonly [{ readonly field: "Source"; readonly value: string }] = changes,
) => prepareSharedMetadataWrite({ library, skillPageId: skillPage, changes: selected })
const patches = (f: Fixture) => f.calls.filter((call) => call.method === "PATCH")
function failure<A>(
  result:
    | { readonly _tag: "Success"; readonly success: A }
    | { readonly _tag: "Failure"; readonly failure: unknown },
): SkillsError {
  if (result._tag !== "Failure" || !(result.failure instanceof SkillsError))
    throw new Error("Expected a typed SkillsError")
  return result.failure
}
function field(f: Fixture, propertyId: string) {
  const found = Object.values(property(f.main.properties))
    .map(property)
    .find((value) => value.id === propertyId)
  if (found === undefined) throw new Error("Missing property")
  return found
}
function withWriter<A, E>(
  f: Fixture,
  action: Effect.Effect<
    A,
    E,
    Notion | Store | Crypto.Crypto | HttpClient.HttpClient | FileSystem.FileSystem | Path.Path
  >,
  options: {
    readonly unknownPatch?: boolean
    readonly unknownOutcome?: boolean
    readonly patchFailure?: SkillsError
    readonly beforePatch?: () => void
    readonly afterPatch?: () => void
    readonly afterPlan?: () => void
    readonly members?: readonly Record<string, unknown>[]
  } = {},
) {
  return Effect.gen(function* () {
    const original = yield* Notion
    const api: Notion["Service"] = {
      ...original,
      request: (path, body, requestOptions) => {
        if (
          options.members !== undefined &&
          path.startsWith(`v1/data_sources/${library.skills.data_source_id}/query`)
        ) {
          f.calls.push({ path, method: requestOptions?.method ?? "POST", body })
          return Effect.succeed({
            object: "list",
            results: [structuredClone(f.main), ...structuredClone(options.members)],
            has_more: false,
            next_cursor: null,
          })
        }
        if (path === "v1/pages") {
          const recordId = text(property(property(property(body).properties).record).rich_text)
          const result = original.request(path, body, requestOptions)
          if (recordId.startsWith("metadata-write-"))
            return result.pipe(Effect.tap(() => Effect.sync(() => options.afterPlan?.())))
          if (recordId.startsWith("outcome-metadata-write-") && options.unknownOutcome)
            return result.pipe(
              Effect.flatMap(() =>
                Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "Original completion response lost.")),
              ),
            )
          return result
        }
        if (path !== `v1/pages/${skillPage}` || requestOptions?.method !== "PATCH")
          return original.request(path, body, requestOptions)
        return Effect.suspend((): Effect.Effect<unknown, SkillsError> => {
          f.calls.push({ path, body, method: "PATCH" })
          options.beforePatch?.()
          if (options.patchFailure !== undefined) return Effect.fail(options.patchFailure)
          const properties = property(f.main.properties)
          for (const [propertyId, value] of Object.entries(property(property(body).properties))) {
            const originalKey = Object.entries(properties).find(
              ([key, raw]) => key === propertyId || property(raw).id === propertyId,
            )?.[0]
            if (originalKey === undefined)
              return Effect.fail(fail("FIXTURE_ERROR", "Unknown native property"))
            properties[originalKey] = { ...property(properties[originalKey]), ...property(value) }
          }
          f.main.last_edited_time = new Date(Date.now() + 1).toISOString()
          options.afterPatch?.()
          return options.unknownPatch
            ? Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "Original property response lost."))
            : Effect.succeed(structuredClone(f.main))
        })
      },
    }
    return yield* action.pipe(Effect.provideService(Notion, api))
  })
}

describe("shared explicit native metadata writes", () => {
  test("public update edits a disabled draft and enables only its completely observed tree", async () => {
    const f = sharedSnapshotFixture({ fileCount: 1 })
    field(f, "enabled").checkbox = false
    const body = f.bodies.get(skillPage)
    const edited = await f.run(
      withWriter(
        f,
        updateSkill(skillPage, {
          database: library.skills.database_id,
          description: "A reviewed disabled draft",
        }),
      ),
    )
    expect(property(property(edited).record).enabled).toBe(false)
    expect(field(f, "enabled").checkbox).toBe(false)
    expect(f.bodies.get(skillPage)).toBe(body)
    expect(
      patches(f).every(
        (call) => !Object.hasOwn(property(property(call.body).properties), "enabled"),
      ),
    ).toBe(true)
    f.clearCalls()
    const enabled = await f.run(
      withWriter(
        f,
        updateSkill(skillPage, {
          database: library.skills.database_id,
          enabled: true,
        }),
      ),
    )
    expect(property(property(enabled).record).enabled).toBe(true)
    expect(patches(f)).toHaveLength(1)
    expect(property(property(patches(f)[0]?.body).properties)).toEqual({
      enabled: { checkbox: true },
    })
    expect(f.bodies.get(skillPage)).toBe(body)
    expect(property(property(enabled).record).id).toBe(
      (await f.run(readSkill(skillPage, { database: library.skills.database_id }))).record.id,
    )
    await f.run(
      withWriter(
        f,
        updateSkill(skillPage, { database: library.skills.database_id, enabled: false }),
      ),
    )
    expect(
      failure(
        await f.run(
          readSkill(skillPage, { database: library.skills.database_id }).pipe(Effect.result),
        ),
      ).code,
    ).toBe("CONTENT_DISABLED")
  })

  test("enabling cannot hide an incomplete disabled tree or perform an early property PATCH", async () => {
    const f = sharedSnapshotFixture()
    field(f, "enabled").checkbox = false
    f.bodies.delete(String(f.files[0]?.id))
    const error = failure(
      await f.run(
        withWriter(
          f,
          updateSkill(skillPage, {
            database: library.skills.database_id,
            enabled: true,
          }),
        ).pipe(Effect.result),
      ),
    )
    expect(error.code).toBe("NOT_FOUND")
    expect(patches(f)).toHaveLength(0)
    expect(field(f, "enabled").checkbox).toBe(false)
  })

  test("public update routes a shared pin directly and regenerates the metadata projection without legacy publication", async () => {
    const f = sharedSnapshotFixture(),
      baseline = await f.target(parseTarget(skillPage), { database: library.skills.database_id })
    const original = structuredClone(f.json.get(`snapshots/${baseline.snapshot_id}.json`))
    f.json.set("config.json", {
      sources: [
        {
          alias: "unrelated-broken",
          database_id: id(5000),
          data_source_ids: [id(5001)],
          title: "Guizang",
          role: "content",
        },
      ],
    })
    f.clearCalls()
    const result = await f.run(
      withWriter(
        f,
        updateSkill(fileRef(baseline.record.id, baseline.entrypoint, baseline.snapshot_id), {
          name: "Updated display name",
          defaultContext: true,
        }),
      ),
    )
    expect(result.operation).toBe("update")
    expect(property(property(result).record).name).toBe("Updated display name")
    expect(property(property(result).record).default_context).toBe(true)
    expect(property(result).snapshot_id).not.toBe(baseline.snapshot_id)
    expect(f.json.get(`snapshots/${baseline.snapshot_id}.json`)).toEqual(original)
    expect(patches(f)).toHaveLength(1)
    expect(
      f.calls.some(
        (call) =>
          call.path.includes("/ai/skills") ||
          call.path.includes(id(5000)) ||
          call.path.includes(id(5001)) ||
          call.path.includes("/search"),
      ),
    ).toBe(false)
    expect([...f.json.keys()].some((key) => key.startsWith("publications/"))).toBe(false)
  })

  test("public update dry run is entirely free of Notion writes, including first body observation", async () => {
    const f = sharedSnapshotFixture()
    expect(
      failure(
        await f.run(updateSkill(skillPage, { name: "New name", dryRun: true }).pipe(Effect.result)),
      ).code,
    ).toBe("SHARED_OBSERVATION_REQUIRED")
    expect(f.writeCount()).toBe(0)
    expect(patches(f)).toHaveLength(0)
    const baseline = await f.target(parseTarget(skillPage), {
      database: library.skills.database_id,
    })
    f.clearCalls()
    const result = await f.run(
      updateSkill(fileRef(baseline.record.id, baseline.entrypoint, baseline.snapshot_id), {
        name: "New name",
        dryRun: true,
      }),
    )
    expect("dry_run" in result && result.dry_run).toBe(true)
    expect(f.writeCount()).toBe(0)
    expect(patches(f)).toHaveLength(0)
    expect(text(field(f, "title").title)).toBe("Managed Name")
  })

  test("one PATCH changes only requested stable IDs and reports native last-writer semantics", async () => {
    const f = sharedSnapshotFixture()
    const properties = property(f.main.properties)
    properties.RenamedTitle = properties.title
    delete properties.title
    const plan = await f.run(prepare())
    f.clearCalls()
    let retained: SharedMetadataWritePlan | undefined
    const result = await f.run(
      withWriter(
        f,
        executeSharedMetadataWrite(library, {
          plan,
          mode: "create",
          beforePlanWrite: (value) =>
            Effect.sync(() => {
              expect(f.writeCount()).toBe(0)
              retained = value
            }),
        }),
      ),
    )
    expect(result.status).toBe("applied")
    expect(result.protection.conditional).toBe(false)
    expect(retained).toEqual(plan)
    expect(patches(f)).toHaveLength(1)
    expect(Object.keys(property(property(patches(f)[0]?.body).properties)).sort()).toEqual([
      "default",
      "title",
    ])
    expect(text(field(f, "title").title)).toBe("Updated display name")
    expect(text(field(f, "description").rich_text)).toBe("Managed description")
    expect(text(field(f, "source").rich_text)).toBe("")
    expect(f.readBodyCount()).toBe(0)
    expect(f.writeCount()).toBe(2)
  })

  test("an unchanged native property sends no plan, outcome or PATCH", async () => {
    const f = sharedSnapshotFixture()
    const plan = await f.run(
      prepareSharedMetadataWrite({
        library,
        skillPageId: skillPage,
        changes: [{ field: "Name", value: "Managed Name" }],
      }),
    )
    let journalled = false
    const result = await f.run(
      withWriter(
        f,
        executeSharedMetadataWrite(library, {
          plan,
          mode: "create",
          beforePlanWrite: () =>
            Effect.sync(() => {
              journalled = true
            }),
        }),
      ),
    )
    expect(result.status).toBe("unchanged")
    expect(journalled).toBe(false)
    expect(f.writeCount()).toBe(0)
    expect(patches(f)).toHaveLength(0)
  })

  test("a stale requested property fails before any dispatch receipt or remote write", async () => {
    const f = sharedSnapshotFixture(),
      plan = await f.run(prepare())
    field(f, "title").title = [{ plain_text: "A later user name" }]
    const result = failure(
      await f.run(
        withWriter(f, executeSharedMetadataWrite(library, { plan, mode: "create" })).pipe(
          Effect.result,
        ),
      ),
    )
    expect(result.code).toBe("WRITE_CONFLICT")
    expect(f.writeCount()).toBe(0)
    expect(patches(f)).toHaveLength(0)
  })

  test("a change after retaining the plan records not_sent without touching native properties", async () => {
    const f = sharedSnapshotFixture(),
      plan = await f.run(prepare())
    const result = failure(
      await f.run(
        withWriter(f, executeSharedMetadataWrite(library, { plan, mode: "create" }), {
          afterPlan: () => {
            field(f, "title").title = [{ plain_text: "A newer user name" }]
          },
        }).pipe(Effect.result),
      ),
    )
    expect(result.code).toBe("WRITE_CONFLICT")
    expect(patches(f)).toHaveLength(0)
    const reconciled = await f.run(reconcileSharedMetadataWrite(library, plan))
    expect(reconciled.status).toBe("not_applied")
    expect(text(field(f, "title").title)).toBe("A newer user name")
  })

  test("unrequested fields survive a concurrent native edit while nominated fields use last-writer semantics", async () => {
    const f = sharedSnapshotFixture(),
      plan = await f.run(prepare())
    const result = await f.run(
      withWriter(f, executeSharedMetadataWrite(library, { plan, mode: "create" }), {
        beforePatch: () => {
          field(f, "title").title = [{ plain_text: "Concurrent nominated name" }]
          field(f, "description").rich_text = [{ plain_text: "Concurrent omitted description" }]
        },
      }),
    )
    expect(result.status).toBe("applied")
    expect(result.protection.concurrency).toBe("last_writer_on_requested_fields")
    expect(text(field(f, "title").title)).toBe("Updated display name")
    expect(text(field(f, "description").rich_text)).toBe("Concurrent omitted description")
  })

  test("only exact official definitive validation rejection is retained as not applied", async () => {
    for (const definitive of [true, false]) {
      const f = sharedSnapshotFixture(),
        plan = await f.run(prepare())
      const error = fail("NOTION_REQUEST_FAILED", "Controlled refusal", {
        http_status: 400,
        ...(definitive ? { phase: "definitive_rejection", notion_code: "validation_error" } : {}),
      })
      failure(
        await f.run(
          withWriter(f, executeSharedMetadataWrite(library, { plan, mode: "create" }), {
            patchFailure: error,
          }).pipe(Effect.result),
        ),
      )
      f.clearCalls()
      const result = await f.run(reconcileSharedMetadataWrite(library, plan).pipe(Effect.result))
      if (definitive) {
        expect(result._tag).toBe("Success")
        if (result._tag !== "Success") throw new Error("Expected definite outcome")
        expect(result.success.status).toBe("not_applied")
      } else expect(failure(result).code).toBe("SHARED_METADATA_WRITE_UNRESOLVED")
      expect(patches(f)).toHaveLength(0)
      expect(f.writeCount()).toBe(0)
    }
  })

  test("current values equal to the candidate cannot settle an unknown PATCH or authorize replay", async () => {
    const f = sharedSnapshotFixture(),
      plan = await f.run(prepare())
    expect(
      failure(
        await f.run(
          withWriter(f, executeSharedMetadataWrite(library, { plan, mode: "create" }), {
            unknownPatch: true,
          }).pipe(Effect.result),
        ),
      ).code,
    ).toBe("WRITE_OUTCOME_UNKNOWN")
    f.clearCalls()
    const result = failure(
      await f.run(
        executeSharedMetadataWrite(library, { plan, mode: "create" }).pipe(Effect.result),
      ),
    )
    expect(result.code).toBe("SHARED_METADATA_WRITE_UNRESOLVED")
    expect(property(result.details).current_matches_after).toBe(true)
    expect(patches(f)).toHaveLength(0)
    expect(f.writeCount()).toBe(0)
    expect(
      (await f.run(loadPendingSharedMetadataWrites(library, { skillPageId: skillPage })))[0],
    ).toEqual(plan)
  })

  test("unknown original completion reconciles from its exact shared outcome without undoing later changes", async () => {
    const f = sharedSnapshotFixture(),
      plan = await f.run(prepare())
    failure(
      await f.run(
        withWriter(f, executeSharedMetadataWrite(library, { plan, mode: "create" }), {
          unknownOutcome: true,
        }).pipe(Effect.result),
      ),
    )
    field(f, "title").title = [{ plain_text: "User name after operation completed" }]
    f.clearCalls()
    const result = await f.run(reconcileSharedMetadataWrite(library, plan))
    expect(result.status).toBe("applied")
    expect(text(field(f, "title").title)).toBe("User name after operation completed")
    expect(
      f.calls.some((call) => call.method === "PATCH" || call.path === `v1/pages/${skillPage}`),
    ).toBe(false)
    expect(f.writeCount()).toBe(0)
  })

  test("nonmatching readback stays in needs_review and never rolls back", async () => {
    const f = sharedSnapshotFixture(),
      plan = await f.run(prepare())
    const result = failure(
      await f.run(
        withWriter(f, executeSharedMetadataWrite(library, { plan, mode: "create" }), {
          afterPatch: () => {
            field(f, "title").title = [{ plain_text: "Later concurrent winner" }]
          },
        }).pipe(Effect.result),
      ),
    )
    expect(result.code).toBe("SHARED_METADATA_REVIEW_REQUIRED")
    expect(patches(f)).toHaveLength(1)
    expect(text(field(f, "title").title)).toBe("Later concurrent winner")
    expect(
      await f.run(loadPendingSharedMetadataWrites(library, { skillPageId: skillPage })),
    ).toEqual([plan])
    expect(
      failure(await f.run(reconcileSharedMetadataWrite(library, plan).pipe(Effect.result))).code,
    ).toBe("SHARED_METADATA_REVIEW_REQUIRED")
  })

  test("Source semantic validation runs before dispatch, and never runs on original reconciliation", async () => {
    const f = sharedSnapshotFixture(),
      plan = await f.run(prepare([{ field: "Source", value: `source-${"a".repeat(64)}` }]))
    let attempts = 0
    const beforeDispatch = () =>
      Effect.sync(() => {
        attempts++
      })
    await f.run(
      withWriter(f, executeSharedMetadataWrite(library, { plan, mode: "create", beforeDispatch })),
    )
    expect(attempts).toBe(2)
    await f.run(
      executeSharedMetadataWrite(library, {
        plan,
        mode: "create",
        beforeDispatch: () =>
          Effect.fail(fail("HOOK_MUST_NOT_RUN", "No new semantic operation during reconcile")),
      }),
    )
    expect(attempts).toBe(2)
    expect(Object.keys(property(property(patches(f)[0]?.body).properties))).toEqual(["source"])
    expect(f.readBodyCount()).toBe(0)
  })

  test.each([1, 2])(
    "semantic validation failure at phase %s never sends metadata PATCH",
    async (phase) => {
      const f = sharedSnapshotFixture(),
        plan = await f.run(prepare([{ field: "Source", value: `source-plan-${"b".repeat(64)}` }]))
      let called = 0
      const result = failure(
        await f.run(
          executeSharedMetadataWrite(library, {
            plan,
            mode: "create",
            beforeDispatch: () =>
              Effect.suspend(() =>
                ++called === phase
                  ? Effect.fail(fail("SOURCE_UNAVAILABLE", "The exact fixed source is unavailable"))
                  : Effect.void,
              ),
          }).pipe(Effect.result),
        ),
      )
      expect(result.code).toBe("SOURCE_UNAVAILABLE")
      expect(patches(f)).toHaveLength(0)
      expect(f.writeCount()).toBe(phase === 1 ? 0 : 2)
      if (phase === 2)
        expect((await f.run(reconcileSharedMetadataWrite(library, plan))).status).toBe(
          "not_applied",
        )
    },
  )

  test("the original local metadata plan fences a previous current TTL when its first POST is invisible", async () => {
    const f = sharedSnapshotFixture()
    await f.target(parseTarget(skillPage), { database: library.skills.database_id })
    const plan = await f.run(prepare())
    f.unknownRecord("operation", false)
    expect(
      failure(
        await f.run(
          executeSharedMetadataWriteWithJournal({ library, plan, mode: "create" }).pipe(
            Effect.result,
          ),
        ),
      ).code,
    ).toBe("WRITE_OUTCOME_UNKNOWN")
    const pending = structuredClone(
      [...f.json.entries()].filter(([key]) => key.startsWith("operations/")),
    )
    expect(pending).toHaveLength(1)
    f.clearCalls()
    await expect(
      f.target(parseTarget(skillPage), { database: library.skills.database_id }),
    ).rejects.toThrow()
    expect(f.readBodyCount()).toBe(0)
    expect(f.writeCount()).toBe(0)
    expect(patches(f)).toHaveLength(0)
    expect([...f.json.entries()].filter(([key]) => key.startsWith("operations/"))).toEqual(pending)
  })

  test("completed metadata operations reuse a batch header scan and transfer no body history", async () => {
    const f = sharedSnapshotFixture(),
      plan = await f.run(prepare())
    await f.run(withWriter(f, executeSharedMetadataWrite(library, { plan, mode: "create" })))
    f.clearCalls()
    const headers = await f.run(querySharedOperationIndex(library, skillPage))
    expect(
      await f.run(loadPendingSharedMetadataWrites(library, { skillPageId: skillPage, headers })),
    ).toEqual([])
    expect(f.calls).toHaveLength(2)
    expect(f.readBodyCount()).toBe(0)
    expect(f.requestMetrics().requests.notion_body).toBe(0)
  })

  test("one fresh operation index checks original metadata intent and pending history", async () => {
    const f = sharedSnapshotFixture()
    const plan = await f.run(prepare())
    f.clearCalls()
    const written = await f.run(
      withWriter(f, executeSharedMetadataWrite(library, { plan, mode: "create" })),
    )
    expect(written.status).toBe("applied")
    const beforeProperties = f.calls.findIndex(
      (call) => call.path === `v1/pages/${skillPage}` && call.method === "GET",
    )
    expect(beforeProperties).toBeGreaterThan(0)
    const queries = f.calls
      .slice(0, beforeProperties)
      .filter((call) =>
        call.path.startsWith(`v1/data_sources/${library.records.data_source_id}/query`),
      )
    expect(queries).toHaveLength(1)
    expect(
      new URL(queries[0]!.path, "https://notion.test").searchParams
        .getAll("filter_properties")
        .includes("payload"),
    ).toBe(false)

    f.clearCalls()
    const recovered = await f.run(
      withWriter(f, executeSharedMetadataWrite(library, { plan, mode: "create" })),
    )
    expect(recovered.operation_id).toBe(plan.operation_id)
    expect(recovered.status).toBe("applied")
    expect(patches(f)).toHaveLength(0)
    expect(f.writeCount()).toBe(0)
  })

  test("frozen operation identities reject changed after-values, property IDs and observed time", async () => {
    const f = sharedSnapshotFixture(),
      plan = await f.run(prepare())
    for (const candidate of [
      { ...plan, observed_at: plan.observed_at + 1 },
      { ...plan, changes: plan.changes.map((change) => ({ ...change, property_id: "another" })) },
      { ...plan, page_id: id(900) },
    ])
      expect(
        failure(await f.run(validateSharedMetadataWritePlan(candidate).pipe(Effect.result))).code,
      ).toBe("SHARED_METADATA_WRITE_INVALID")
    expect(f.writeCount()).toBe(0)
  })

  test.each(["skill", "router"])(
    "%s Members and Requires validate current same-library targets without target body reads",
    async (kind) => {
      const f = sharedSnapshotFixture()
      const registered = {
        ...library,
        skills: {
          ...library.skills,
          property_ids: {
            ...library.skills.property_ids,
            Members: "members",
            Requires: "requires",
          },
        },
      }
      property(f.main.properties).kind = { id: "kind", type: "select", select: { name: kind } }
      property(f.main.properties).members = {
        id: "members",
        type: "relation",
        relation: [],
        has_more: false,
      }
      property(f.main.properties).requires = {
        id: "requires",
        type: "relation",
        relation: [],
        has_more: false,
      }
      const member = structuredClone(f.main)
      member.id = id(90)
      property(member.properties).kind = { id: "kind", type: "select", select: { name: "skill" } }
      property(member.properties).title = {
        id: "title",
        type: "title",
        title: [{ plain_text: "Member" }],
      }
      property(member.properties).skill_id = rich("skill_id", "member-skill")
      property(member.properties).main_file_id = rich("main_file_id", "member-main")
      const plan = await f.run(
        withWriter(
          f,
          prepareSharedMetadataWrite({
            library: registered,
            skillPageId: skillPage,
            changes: [
              { field: "Members", value: [id(90)] },
              { field: "Requires", value: [id(90)] },
            ],
          }),
          { members: [member] },
        ),
      )
      const result = await f.run(
        withWriter(f, executeSharedMetadataWrite(registered, { plan, mode: "create" }), {
          members: [member],
        }),
      )
      expect(result.status).toBe("applied")
      expect(property(property(patches(f)[0]?.body).properties).members).toEqual({
        relation: [{ id: id(90) }],
      })
      expect(property(property(patches(f)[0]?.body).properties).requires).toEqual({
        relation: [{ id: id(90) }],
      })
      expect(f.readBodyCount()).toBe(0)
    },
  )

  test("a complete relation over 100 targets is rejected before any write instead of destructive chunked replacement", async () => {
    const f = sharedSnapshotFixture()
    const registered = {
      ...library,
      skills: {
        ...library.skills,
        property_ids: { ...library.skills.property_ids, Requires: "requires" },
      },
    }
    property(f.main.properties).requires = {
      id: "requires",
      type: "relation",
      relation: [],
      has_more: false,
    }
    const result = await f.run(
      prepareSharedMetadataWrite({
        library: registered,
        skillPageId: skillPage,
        changes: [
          { field: "Requires", value: Array.from({ length: 101 }, (_, index) => id(1000 + index)) },
        ],
      }).pipe(Effect.result),
    )
    expect(failure(result).code).toBe("RELATION_WRITE_LIMIT")
    expect(patches(f)).toHaveLength(0)
    expect(f.writeCount()).toBe(0)
  })
})
