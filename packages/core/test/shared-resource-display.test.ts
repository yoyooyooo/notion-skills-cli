import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { fail, property, text, type SkillsError } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { inspectSharedResourceState } from "../src/shared-resource-state.ts"
import {
  describeSharedResourceDisplay,
  syncSharedResourceDisplay,
} from "../src/shared-resource-display.ts"
import {
  resourceFileDisplaySchema,
  resourceSkillDisplaySchema,
  resourceDisplaySchema,
} from "../src/shared-resource-display-schema.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import {
  sharedSnapshotFixture,
  library as base,
  skillPage,
  rich,
  digest,
} from "./shared-snapshot-fixture.ts"

const displayIds = Object.fromEntries(
  Object.keys(resourceSkillDisplaySchema).map((name, index) => [name, `display-${index}`]),
)
const library = {
  ...base,
  skills: { ...base.skills, property_ids: { ...base.skills.property_ids, ...displayIds } },
  files: { ...base.files, property_ids: { ...base.files.property_ids, ...displayIds } },
}
function fixture() {
  const f = sharedSnapshotFixture({ fileCount: 2 })
  for (const row of [f.main, ...f.files]) {
    const main = row.id === skillPage,
      fields = property(row.properties)
    for (const [name, shape] of Object.entries(
      main ? resourceSkillDisplaySchema : resourceFileDisplaySchema,
    )) {
      const key = displayIds[name]!,
        type = Object.keys(shape)[0]!
      fields[key] = {
        id: key,
        type,
        ...(type === "rich_text"
          ? { rich_text: [] }
          : type === "date"
            ? { date: null }
            : { select: null }),
      }
    }
    fields["unrelated-user-note"] = rich("unrelated-user-note", "Keep this note")
  }
  for (const [fileId, page] of [
    ["file-main", skillPage],
    ["file-1", f.files[0]!.id],
  ]) {
    const body = f.bodies.get(page!)!
    f.seedFact(
      {
        event_id: `project-${fileId}`,
        file_id: fileId,
        parents: [],
        kind: "projected",
        source_revision: "1".repeat(40),
        projection: { normalization_version: 1, sha256: digest(body) },
      },
      "file_event",
      fileId!,
      `project-${fileId}`,
    )
  }
  const custom = "Native custom content",
    content = {
      object_id: `body-${digest(custom)}`,
      sha256: digest(custom),
      bytes: new TextEncoder().encode(custom).length,
    }
  const adopted = { file_id: "file-1", parents: ["project-file-1"], content }
  const event = `adopt-${digest(canonicalSharedJson({ version: 1, ...adopted }))}`
  f.seedFact({ ...adopted, event_id: event, kind: "adopted" }, "file_event", "file-1", event)
  f.bodies.set(f.files[0]!.id, custom)
  const faults: {
    failPatch?: boolean
    concurrentOnMainRead?: number
    dateReadback: "same_minute" | "next_minute"
    mainReads: number
  } = {
    dateReadback: "same_minute",
    mainReads: 0,
  }
  const run: typeof f.run = (effect) =>
    f.run(
      Effect.gen(function* () {
        const original = yield* Notion
        const api: Notion["Service"] = {
          ...original,
          request: (path, body, options) =>
            Effect.suspend((): Effect.Effect<unknown, SkillsError> => {
              const method = options?.method ?? (body === undefined ? "GET" : "POST")
              const row = [f.main, ...f.files].find(
                (candidate) => path === `v1/pages/${candidate.id}`,
              )
              if (row && method === "GET" && row.id === skillPage) {
                faults.mainReads++
                if (faults.mainReads === faults.concurrentOnMainRead)
                  property(row.properties)[displayIds["Displayed Revision"]!] = rich(
                    displayIds["Displayed Revision"]!,
                    "Concurrent field edit",
                  )
              }
              if (row && method === "PATCH") {
                f.calls.push({ path, method, body })
                if (faults.failPatch) {
                  faults.failPatch = false
                  return Effect.fail(
                    fail("WRITE_OUTCOME_UNKNOWN", "Injected display response loss"),
                  )
                }
                for (const [id, value] of Object.entries(property(property(body).properties))) {
                  expect(id.startsWith("display-")).toBe(true)
                  const field = property(value),
                    type = Object.keys(field)[0]!
                  const start = property(field.date).start
                  const nativeDate =
                    type === "date" && typeof start === "string"
                      ? {
                          date: {
                            start: new Date(
                              Math.floor(Date.parse(start) / 60_000) * 60_000 +
                                (faults.dateReadback === "next_minute" ? 60_000 : 0),
                            ).toISOString(),
                          },
                        }
                      : {}
                  property(row.properties)[id] = {
                    id,
                    type,
                    ...field,
                    ...nativeDate,
                    ...(type === "rich_text" ? { has_more: false } : {}),
                  }
                }
                row.last_edited_time = new Date().toISOString()
                return Effect.succeed(structuredClone(row))
              }
              return original.request(path, body, options)
            }),
        }
        return yield* effect.pipe(Effect.provideService(Notion, api))
      }),
    )
  return {
    ...f,
    run,
    faults,
    async state(observedAt?: number) {
      const state = await run(
        inspectSharedResourceState(library, { target: skillPage, observe: true }),
      )
      if (observedAt === undefined) return state
      return {
        ...state,
        observed_at: observedAt,
        files: state.files.map((file) => {
          const observation = file.display.observation
          return {
            ...file,
            display: {
              ...file.display,
              observation:
                observation.kind === "observed" || observation.kind === "resource_verified"
                  ? { ...observation, observed_at: observedAt }
                  : observation,
            },
          }
        }),
      }
    },
  }
}

describe("readable resource display facts", () => {
  test("selected/check timestamps cannot hide an old displayed revision or a custom baseline", async () => {
    const f = fixture(),
      state = await f.state()
    const selected = {
      ...state,
      selected: {
        kind: "selected" as const,
        source_kind: "git" as const,
        source_id: "source-c2",
        revision: "2".repeat(40),
        paths: ["SKILL.md", "references/1.md"],
        provider_checked: false as const,
      },
    }
    const rows = describeSharedResourceDisplay(selected)
    expect(rows[0]?.values["Selected Revision"]).toEqual({ rich_text: "2".repeat(12) })
    expect(rows[0]?.values["Displayed Revision"]).toEqual({ rich_text: "1".repeat(12) })
    expect(rows[1]?.values["Custom Baseline"]).toEqual({ rich_text: "1".repeat(12) })
    expect(rows[1]?.values["Ownership"]).toEqual({ select: "custom" })
    expect(rows[0]?.values["Last Successful Check"]).toBeUndefined()
    expect(rows[0]?.values["Upstream Commit Time"]).toBeUndefined()
    expect(canonicalSharedJson(rows)).not.toContain("event_id")
  })

  test("publish only patches changed owned fields, preserves labels/body/history, and unchanged republish has zero body reads or writes", async () => {
    const f = fixture(),
      state = await f.state(),
      records = structuredClone([...f.records.values()]),
      bodies = new Map(f.bodies)
    f.clearCalls()
    const result = await f.run(syncSharedResourceDisplay(library, state))
    expect(result.display_status).toBe("complete")
    expect(f.calls.filter((call) => call.method === "PATCH")).toHaveLength(2)
    expect(f.readBodyCount()).toBe(0)
    expect(f.bodies).toEqual(bodies)
    expect([...f.records.values()]).toEqual(records)
    expect(text(property(property(f.main.properties)["unrelated-user-note"]).rich_text)).toBe(
      "Keep this note",
    )
    f.clearCalls()
    const newerObservation = { ...state, observed_at: state.observed_at + 1000 }
    expect((await f.run(syncSharedResourceDisplay(library, newerObservation))).display_status).toBe(
      "complete",
    )
    expect(f.writeCount()).toBe(0)
    expect(f.readBodyCount()).toBe(0)
  })

  test("non-minute observation dates publish at native minute precision without changing precise facts", async () => {
    const f = fixture(),
      state = await f.state(Date.parse("2026-11-09T06:58:19.013Z")),
      facts = structuredClone(state)
    f.clearCalls()
    const result = await f.run(syncSharedResourceDisplay(library, state))
    expect(result).toMatchObject({
      display_status: "complete",
      results: [{ display_status: "verified_applied" }, { display_status: "verified_applied" }],
    })
    const dates = f.calls.flatMap((call) =>
      call.method !== "PATCH"
        ? []
        : Object.values(property(property(call.body).properties)).flatMap((value) => {
            const start = property(property(value).date).start
            return typeof start === "string" ? [start] : []
          }),
    )
    expect(dates).toEqual(["2026-11-09T06:58:00.000Z", "2026-11-09T06:58:00.000Z"])
    expect(state).toEqual(facts)
    f.clearCalls()
    expect((await f.run(syncSharedResourceDisplay(library, state))).display_status).toBe("complete")
    expect(f.writeCount()).toBe(0)
    expect(f.readBodyCount()).toBe(0)
  })

  test("a different native date minute still fails display readback", async () => {
    const f = fixture(),
      state = await f.state(Date.parse("2026-11-09T06:58:00.000Z"))
    f.faults.dateReadback = "next_minute"
    f.clearCalls()
    const result = await f.run(syncSharedResourceDisplay(library, state))
    expect(result).toMatchObject({
      display_status: "incomplete",
      results: [
        { display_status: "failed", code: "SOURCE_WRITE_MISMATCH" },
        { display_status: "failed", code: "SOURCE_WRITE_MISMATCH" },
      ],
    })
    expect(f.calls.filter((call) => call.method === "PATCH")).toHaveLength(2)
    expect(f.readBodyCount()).toBe(0)
  })

  test("a concurrent display edit is preserved and reported independently from observed content", async () => {
    const f = fixture(),
      state = await f.state()
    f.clearCalls()
    f.faults.mainReads = 0
    f.faults.concurrentOnMainRead = 3
    const result = await f.run(syncSharedResourceDisplay(library, state))
    expect(result.display_status).toBe("incomplete")
    if (!("results" in result) || result.results === undefined) throw new Error("Missing results")
    expect(result.results[0]).toMatchObject({
      display_status: "failed",
      code: "RESOURCE_DISPLAY_STALE",
    })
    expect(
      text(property(property(f.main.properties)[displayIds["Displayed Revision"]!]).rich_text),
    ).toBe("Concurrent field edit")
    expect(
      f.calls.some((call) => call.path === `v1/pages/${skillPage}` && call.method === "PATCH"),
    ).toBe(false)
    expect(state.files[0]?.resolution).toHaveProperty("ownership.kind", "following")
  })

  test("lost display response cannot be inferred from content success or replayed", async () => {
    const f = fixture(),
      state = await f.state()
    f.clearCalls()
    f.faults.failPatch = true
    expect((await f.run(syncSharedResourceDisplay(library, state))).display_status).toBe(
      "incomplete",
    )
    f.clearCalls()
    expect((await f.run(syncSharedResourceDisplay(library, state))).display_status).toBe(
      "incomplete",
    )
    expect(f.writeCount()).toBe(0)
    expect(f.readBodyCount()).toBe(0)
  })

  test("Files rollups use exact existing relation IDs and plain Skills values; no aggregate is an authority input", async () => {
    const schema = resourceDisplaySchema(library, "files")
    expect(property(property(schema)["Selected Revision"]).rollup).toEqual({
      relation_property_id: "skill",
      rollup_property_id: displayIds["Selected Revision"],
      function: "show_original",
    })
    expect(resourceSkillDisplaySchema["Selected Revision"]).toEqual({ rich_text: {} })
    const f = fixture(),
      state = await f.state()
    property(f.files[0]!.properties)[displayIds["Selected Revision"]!] = {
      id: displayIds["Selected Revision"],
      type: "rollup",
      rollup: { type: "incomplete" },
    }
    expect((await f.run(syncSharedResourceDisplay(library, state))).display_status).toBe("complete")
  })
})
