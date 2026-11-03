import { describe, expect, test } from "bun:test"
import { Crypto, Effect } from "effect"
import { HttpClient } from "effect/http"
import { authScope } from "../src/catalog.ts"
import { decode, fail, property, SkillsError, SnapshotSchema, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { sharedSnapshotVersion } from "../src/shared-snapshot-identity.ts"
import { openSharedSnapshot, type FixedSharedSource } from "../src/shared-snapshot.ts"
import {
  executeSharedFileManagement,
  loadPendingSharedFileManagement,
  prepareSharedFileManagement,
  reconcileSharedFileManagement,
} from "../src/shared-file-management.ts"
import { FileEventSchema, resolveFileState } from "../src/shared-file-state.ts"
import { validateSharedFileManagementPlan } from "../src/shared-file-management-model.ts"
import { projectSharedNotionMarkdown } from "../src/shared-notion-projection.ts"
import { canonicalSharedJson, querySharedRecords } from "../src/shared-records.ts"
import { Store } from "../src/store.ts"
import {
  sharedSnapshotFixture,
  library,
  skillPage,
  id,
  encode,
  digest,
} from "./shared-snapshot-fixture.ts"

function field(key: string, input: unknown) {
  const value = property(input)
  if (Array.isArray(value.rich_text))
    return { ...value, id: key, type: "rich_text", has_more: false }
  if (Array.isArray(value.title)) return { ...value, id: key, type: "title" }
  if (Array.isArray(value.relation)) return { ...value, id: key, type: "relation", has_more: false }
  if (value.select !== undefined) return { ...value, id: key, type: "select" }
  throw new Error("Unexpected lifecycle fixture field")
}
function fixture(fixtureOptions: { readonly readback?: (wire: string) => string } = {}) {
  const base = sharedSnapshotFixture()
  const files: Record<string, unknown>[] = structuredClone(base.files)
  const retired = new Map<string, unknown>()
  const calls: Array<{ path: string; body: unknown; method: string; content?: string }> = []
  const pendingPrefix = "operations/shared-observation-pending/"
  let nextPage = 50_000
  let credential = "file-management-credential"
  let createUnknown: "visible" | "absent" | undefined
  let patchUnknown: "visible" | "absent" | undefined
  let outcomeUnknown: "visible" | "absent" | undefined
  let onPlan: (() => void) | undefined
  let onFileCreate: ((row: Record<string, unknown>) => void) | undefined
  let fixedSource: FixedSharedSource | undefined
  const run = <A, E>(
    effect: Effect.Effect<A, E, Store | Notion | Crypto.Crypto | HttpClient.HttpClient>,
  ) =>
    base.run(
      Effect.gen(function* () {
        const api = yield* Notion,
          store = yield* Store
        const controlledStore: Store["Service"] = {
          ...store,
          writeJson: (key, value) =>
            Effect.gen(function* () {
              if (key.startsWith(pendingPrefix)) {
                if (retired.has(key))
                  return yield* Effect.fail(
                    fail("STATE_CONFLICT", "A retired original lifecycle dispatch cannot reopen"),
                  )
                const previous = base.json.get(key)
                if (
                  previous !== undefined &&
                  canonicalSharedJson(previous) !== canonicalSharedJson(value)
                )
                  return yield* Effect.fail(
                    fail("STATE_CONFLICT", "Frozen lifecycle dispatch cannot change"),
                  )
              }
              yield* store.writeJson(key, value)
            }),
          retireKeys: (keys) =>
            Effect.sync(() =>
              keys.map((key) => {
                if (key.startsWith(pendingPrefix) && base.json.has(key))
                  retired.set(key, base.json.get(key))
                base.json.delete(key)
                return { key, retention_path: `retired/${key}` }
              }),
            ),
        }
        const controlled: Notion["Service"] = {
          ...api,
          credentialIdentity: Effect.sync(() => credential),
          request: (path, body, options) =>
            Effect.suspend((): Effect.Effect<unknown, SkillsError> => {
              const method = options?.method ?? (body === undefined ? "GET" : "POST")
              calls.push({
                path,
                body,
                method,
                ...(options?.content === undefined ? {} : { content: options.content }),
              })
              const url = new URL(path, "https://api.notion.com/")
              if (url.pathname === `/v1/data_sources/${library.files.data_source_id}/query`) {
                const offset =
                  property(body).start_cursor === undefined
                    ? 0
                    : Number(property(body).start_cursor)
                const results = files.slice(offset, offset + 100)
                const more = offset + results.length < files.length
                return Effect.succeed({
                  object: "list",
                  results: structuredClone(results),
                  has_more: more,
                  next_cursor: more ? String(offset + 100) : null,
                })
              }
              if (
                url.pathname === "/v1/pages" &&
                property(property(body).parent).data_source_id === library.files.data_source_id
              ) {
                if (![...base.json.keys()].some((key) => key.startsWith(pendingPrefix)))
                  return Effect.fail(
                    fail(
                      "TEST_DISPATCH_ORDER",
                      "Creation reached Notion before the original local plan was durable",
                    ),
                  )
                const outcome = createUnknown
                createUnknown = undefined
                let created: Record<string, unknown> | undefined
                if (outcome !== "absent") {
                  const raw = property(body),
                    page = id(nextPage++)
                  created = {
                    object: "page",
                    id: page,
                    last_edited_time: new Date().toISOString(),
                    parent: {
                      type: "data_source_id",
                      data_source_id: library.files.data_source_id,
                      database_id: library.files.database_id,
                    },
                    properties: Object.fromEntries(
                      Object.entries(property(raw.properties)).map(([key, value]) => [
                        key,
                        field(key, value),
                      ]),
                    ),
                  }
                  files.push(created)
                  if (typeof raw.markdown !== "string" || raw.markdown_version !== "v2")
                    return Effect.fail(
                      fail(
                        "TEST_CREATE_BODY",
                        "Creation did not freeze one complete v2 Markdown body",
                      ),
                    )
                  base.bodies.set(
                    page,
                    fixtureOptions.readback === undefined
                      ? raw.markdown.replace(/^<h1>([^\n]*)<\/h1>(?=\n|$)/u, "# $1")
                      : fixtureOptions.readback(raw.markdown),
                  )
                  onFileCreate?.(created)
                }
                if (outcome !== undefined)
                  return Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "Lost original create response"))
                return Effect.succeed(structuredClone(created))
              }
              const selected = files.find((file) => url.pathname === `/v1/pages/${String(file.id)}`)
              if (selected !== undefined) {
                if (method === "PATCH") {
                  const outcome = patchUnknown
                  patchUnknown = undefined
                  if (outcome !== "absent") {
                    for (const [key, value] of Object.entries(property(property(body).properties)))
                      property(selected.properties)[key] = field(key, value)
                    selected.last_edited_time = new Date().toISOString()
                  }
                  if (outcome !== undefined)
                    return Effect.fail(
                      fail("WRITE_OUTCOME_UNKNOWN", "Lost original Path PATCH response"),
                    )
                }
                return Effect.succeed(structuredClone(selected))
              }
              const markdown = /^\/v1\/pages\/([^/]+)\/markdown$/u.exec(url.pathname)
              if (markdown !== null && base.bodies.has(markdown[1] ?? "")) {
                if (method !== "GET")
                  return Effect.fail(
                    fail(
                      "TEST_BODY_OVERWRITE",
                      "File lifecycle attempted to overwrite an existing body",
                    ),
                  )
                return Effect.succeed({
                  id: markdown[1],
                  markdown: base.bodies.get(markdown[1] ?? ""),
                  truncated: false,
                  unknown_block_ids: [],
                })
              }
              if (url.pathname === "/v1/pages" && method === "POST") {
                const payload = text(
                  property(
                    property(property(body).properties)[
                      library.records.property_ids.Payload ?? "payload"
                    ],
                  ).rich_text,
                )
                const envelope = payload === "" ? {} : property(JSON.parse(payload))
                const data = property(envelope.payload)
                if (
                  data.kind === "file_management_outcome" &&
                  data.status === "applied" &&
                  outcomeUnknown !== undefined
                ) {
                  const outcome = outcomeUnknown
                  outcomeUnknown = undefined
                  return (
                    outcome === "visible"
                      ? api.request(path, body, options)
                      : Effect.succeed(undefined)
                  ).pipe(
                    Effect.flatMap(() =>
                      Effect.fail(
                        fail("WRITE_OUTCOME_UNKNOWN", "Lost original applied outcome response"),
                      ),
                    ),
                  )
                }
                if (data.kind === "file_management" && onPlan !== undefined)
                  return api.request(path, body, options).pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        const action = onPlan
                        onPlan = undefined
                        action?.()
                      }),
                    ),
                  )
              }
              return api.request(path, body, options)
            }),
        }
        return yield* effect.pipe(
          Effect.provideService(Notion, controlled),
          Effect.provideService(Store, controlledStore),
        )
      }),
    )
  const open = (readOnly: boolean) =>
    run(
      Effect.gen(function* () {
        const scope = yield* authScope
        return yield* openSharedSnapshot({
          library,
          target: skillPage,
          scope,
          startedAt: Date.now(),
          forceFull: true,
          readOnly,
          ...(fixedSource === undefined ? {} : { fixedSource }),
        })
      }),
    )
  const baseline = async () => {
    await open(false)
    return open(true)
  }
  const events = () =>
    run(
      querySharedRecords(library, { skillPageId: skillPage, kind: "file_event" }).pipe(
        Effect.map((facts) => facts.map((fact) => decode(FileEventSchema, fact.payload))),
      ),
    )
  return {
    base,
    files,
    calls,
    retired,
    run,
    baseline,
    open,
    events,
    clear: () => {
      calls.length = 0
      base.clearCalls()
    },
    createUnknown: (value: "visible" | "absent") => {
      createUnknown = value
    },
    patchUnknown: (value: "visible" | "absent") => {
      patchUnknown = value
    },
    outcomeUnknown: (value: "visible" | "absent") => {
      outcomeUnknown = value
    },
    onPlan: (value: () => void) => {
      onPlan = value
    },
    onFileCreate: (value: (row: Record<string, unknown>) => void) => {
      onFileCreate = value
    },
    credential: (value: string) => {
      credential = value
    },
    pending: () => [...base.json.keys()].filter((key) => key.startsWith(pendingPrefix)),
    fileCreates: () =>
      calls.filter(
        (call) =>
          call.path === "v1/pages" &&
          property(property(call.body).parent).data_source_id === library.files.data_source_id,
      ),
    pathPatches: () => calls.filter((call) => call.method === "PATCH"),
    bodyReads: () => calls.filter((call) => call.path.includes("/markdown")),
    source: (value: FixedSharedSource) => {
      fixedSource = value
      property(base.main.properties).source = {
        id: "source",
        type: "rich_text",
        rich_text: [{ plain_text: value.source_id }],
      }
    },
  }
}

describe("shared file lifecycle operations", () => {
  test("add freezes the original plan before one create and preserves all existing files", async () => {
    const f = fixture(),
      snapshot = await f.baseline()
    const existing = [...f.base.bodies.entries()]
    const plan = await f.run(
      prepareSharedFileManagement({
        library,
        snapshot,
        action: "add",
        path: "notes/new.md",
        markdown: "# New\n",
      }),
    )
    f.clear()
    const result = await f.run(executeSharedFileManagement(library, { plan, mode: "create" }))
    expect(result.status).toBe("applied")
    expect(result.page_id).not.toBeNull()
    expect(f.fileCreates()).toHaveLength(1)
    expect(f.pathPatches()).toHaveLength(0)
    expect(f.pending()).toHaveLength(0)
    expect(f.files).toHaveLength(3)
    for (const [page, body] of existing) expect(f.base.bodies.get(page)).toBe(body)
    expect(f.base.bodies.get(result.page_id ?? "")).toBe("# New")
    expect(plan.creation_projection?.input_markdown).toBe("# New\n")
    expect(plan.creation_projection?.removed_terminal_lfs).toBe(1)
    expect(property(f.fileCreates()[0]?.body).markdown).toBe("<h1>New</h1>")
    expect(
      resolveFileState(
        plan.file_id,
        (await f.events()).filter((event) => event.file_id === plan.file_id),
      ).ownership.kind,
    ).toBe("custom")
  })

  test("file add sends its creation wire and retains the complete native rich-text candidate", async () => {
    const input = "# Added\n\n**bold `code` bold**.\n"
    const wire = "<h1>Added</h1>\n\n**bold `code` bold**."
    const observed = "# Added\n\n<b>bold </b><b><code>code</code></b><b> bold</b>."
    const f = fixture({
      readback: (actual) => {
        expect(actual).toBe(wire)
        return observed
      },
    })
    const snapshot = await f.baseline()
    const plan = await f.run(
      prepareSharedFileManagement({
        library,
        snapshot,
        action: "add",
        path: "notes/rich.md",
        markdown: input,
      }),
    )
    expect(plan.creation_projection?.version).toBe(8)
    expect(plan.creation_projection?.input_markdown).toBe(input)
    expect(plan.content.markdown).toBe(observed)
    expect(plan.content.retained.sha256).toBe(digest(observed))
    const wrongPurpose = { ...plan, creation_projection: projectSharedNotionMarkdown(input) }
    expect((await f.run(Effect.flip(validateSharedFileManagementPlan(wrongPurpose)))).code).toBe(
      "SHARED_FILE_MANAGEMENT_INVALID",
    )
    f.clear()
    const result = await f.run(executeSharedFileManagement(library, { plan, mode: "create" }))
    expect(result.status).toBe("applied")
    expect(f.base.bodies.get(result.page_id ?? "")).toBe(observed)
    expect(f.fileCreates()).toHaveLength(1)
    expect(property(f.fileCreates()[0]?.body).markdown).toBe(wire)
    expect(f.pathPatches()).toHaveLength(0)
  })

  test("delete publishes a retained tombstone while leaving the body page and old snapshot intact", async () => {
    const f = fixture(),
      snapshot = await f.baseline()
    const original = f.base.bodies.get(id(11)),
      immutable = canonicalSharedJson(f.base.json.get(`snapshots/${snapshot.snapshot_id}.json`))
    const plan = await f.run(
      prepareSharedFileManagement({ library, snapshot, action: "delete", fileId: "file-1" }),
    )
    f.clear()
    const result = await f.run(executeSharedFileManagement(library, { plan, mode: "create" }))
    expect(result.status).toBe("applied")
    expect(f.files.find((file) => file.id === id(11))).toBeDefined()
    expect(f.base.bodies.get(id(11))).toBe(original)
    expect(f.pathPatches()).toHaveLength(0)
    expect(f.fileCreates()).toHaveLength(0)
    const state = resolveFileState(
      "file-1",
      (await f.events()).filter((event) => event.file_id === "file-1"),
    )
    expect(state.ownership).toEqual({ kind: "tombstone", retained: plan.content.retained })
    expect(canonicalSharedJson(f.base.json.get(`snapshots/${snapshot.snapshot_id}.json`))).toBe(
      immutable,
    )
  })

  test("add projects before freezing while exact postcondition rejects an unplanned trailing newline", async () => {
    const f = fixture(),
      snapshot = await f.baseline()
    const original = "# New\r\n\r\n"
    const plan = await f.run(
      prepareSharedFileManagement({
        library,
        snapshot,
        action: "add",
        path: "notes/new.md",
        markdown: original,
      }),
    )
    expect(plan.creation_projection?.input_markdown).toBe(original)
    expect(plan.content.markdown).toBe("# New")
    f.onFileCreate((row) => f.base.bodies.set(String(row.id), "# New\n"))
    const error = await f.run(
      Effect.flip(executeSharedFileManagement(library, { plan, mode: "create" })),
    )
    expect(error.code).toBe("SHARED_FILE_MANAGEMENT_REVIEW_REQUIRED")
    expect(f.fileCreates()).toHaveLength(1)
    expect(f.pending()).toHaveLength(1)
    expect((await f.events()).some((event) => event.file_id === plan.file_id)).toBe(false)
  })

  test("move uses one Path-only PATCH and keeps the stable File ID, body page and exact bytes", async () => {
    const f = fixture(),
      snapshot = await f.baseline(),
      original = f.base.bodies.get(id(11))
    const plan = await f.run(
      prepareSharedFileManagement({
        library,
        snapshot,
        action: "move",
        fileId: "file-1",
        destinationPath: "notes/one.md",
      }),
    )
    f.clear()
    const result = await f.run(executeSharedFileManagement(library, { plan, mode: "create" }))
    expect(result.page_id).toBe(id(11))
    expect(f.pathPatches()).toHaveLength(1)
    expect(Object.keys(property(property(f.pathPatches()[0]?.body).properties))).toEqual([
      library.files.property_ids.Path!,
    ])
    expect(f.base.bodies.get(id(11))).toBe(original)
    expect(
      text(
        property(property(f.files.find((file) => file.id === id(11))?.properties).file_id)
          .rich_text,
      ),
    ).toBe("file-1")
    const state = resolveFileState(
      "file-1",
      (await f.events()).filter((event) => event.file_id === "file-1"),
    )
    expect(state.ownership.kind).toBe("custom")
    expect(state.placement).toEqual({
      path: "notes/one.md",
      source_path: null,
      suppressed_paths: ["references/1.md"],
    })
  })

  test("following move retains its original source path independently from the Path property", async () => {
    const f = fixture()
    const fixed = {
      source_id: "source-fixture",
      revision: "commit-fixture",
      files: [
        { path: "SKILL.md", bytes: encode("# Upstream\n") },
        { path: "references/1.md", bytes: encode("Upstream bytes\n") },
        { path: "references/2.md", bytes: encode("Second\n") },
      ],
    }
    f.source(fixed)
    for (const [fileId, page] of [
      ["file-main", skillPage],
      ["file-1", id(11)],
      ["file-2", id(12)],
    ] as const) {
      const event = {
        kind: "projected",
        event_id: `projected-${fileId}`,
        file_id: fileId,
        parents: [],
        source_revision: fixed.revision,
        projection: { normalization_version: 1, sha256: digest(f.base.bodies.get(page) ?? "") },
      }
      f.base.seedFact(event, "file_event", fileId, event.event_id)
    }
    const snapshot = await f.open(true)
    const plan = await f.run(
      prepareSharedFileManagement({
        library,
        snapshot,
        action: "move",
        fileId: "file-1",
        destinationPath: "guides/one.md",
      }),
    )
    expect(plan.event.kind).toBe("moved")
    if (plan.event.kind !== "moved") throw new Error("Missing move event")
    expect(plan.event.source_path).toBe("references/1.md")
    await f.run(executeSharedFileManagement(library, { plan, mode: "create" }))
    const state = resolveFileState(
      "file-1",
      (await f.events()).filter((event) => event.file_id === "file-1"),
    )
    expect(state.ownership.kind).toBe("following")
    expect(state.placement?.source_path).toBe("references/1.md")
    expect(f.base.bodies.get(id(11))).toBe("Reference one\n")
  })

  test("main changes, stale observed mtimes and persisted pins fail before lifecycle writes", async () => {
    const f = fixture(),
      snapshot = await f.baseline()
    for (const action of [
      { action: "delete" as const, fileId: "file-main" },
      { action: "move" as const, fileId: "file-1", destinationPath: "SKILL.md" },
    ])
      expect(
        (await f.run(Effect.flip(prepareSharedFileManagement({ library, snapshot, ...action }))))
          .code,
      ).toBe("SHARED_MAIN_FILE_PROTECTED")
    const pinned = decode(SnapshotSchema, f.base.json.get(`snapshots/${snapshot.snapshot_id}.json`))
    expect(
      (
        await f.run(
          Effect.flip(
            prepareSharedFileManagement({
              library,
              snapshot: pinned,
              action: "delete",
              fileId: "file-1",
            }),
          ),
        )
      ).code,
    ).toBe("SHARED_FILE_MANAGEMENT_INVALID")
    const selected = f.files.find((file) => file.id === id(12))
    if (selected === undefined) throw new Error("Missing fixture file")
    selected.last_edited_time = new Date().toISOString()
    f.clear()
    expect(
      (
        await f.run(
          Effect.flip(
            prepareSharedFileManagement({ library, snapshot, action: "delete", fileId: "file-1" }),
          ),
        )
      ).code,
    ).toBe("SHARED_FILE_MANAGEMENT_STALE")
    expect(f.bodyReads()).toHaveLength(0)
    expect(f.pending()).toHaveLength(0)
    expect(f.fileCreates()).toHaveLength(0)
    expect(f.pathPatches()).toHaveLength(0)
  })

  test("broken incoming or moved-relative references refuse deletion/move without silent rewrites", async () => {
    const inbound = fixture()
    inbound.base.bodies.set(skillPage, "[Reference](references/1.md)\n")
    const snapshot = await inbound.baseline()
    inbound.clear()
    expect(
      (
        await inbound.run(
          Effect.flip(
            prepareSharedFileManagement({ library, snapshot, action: "delete", fileId: "file-1" }),
          ),
        )
      ).code,
    ).toBe("SHARED_REFERENCE_BROKEN")
    expect(inbound.pending()).toHaveLength(0)
    expect(inbound.pathPatches()).toHaveLength(0)
    const outbound = fixture()
    outbound.base.bodies.set(id(11), "[Other](../references/2.md)\n")
    const other = await outbound.baseline()
    expect(
      (
        await outbound.run(
          Effect.flip(
            prepareSharedFileManagement({
              library,
              snapshot: other,
              action: "move",
              fileId: "file-1",
              destinationPath: "deep/notes/one.md",
            }),
          ),
        )
      ).code,
    ).toBe("SHARED_REFERENCE_BROKEN")
    expect(outbound.pending()).toHaveLength(0)
  })

  test("unknown create retains the original plan and a current matching page cannot cause replay", async () => {
    const f = fixture(),
      snapshot = await f.baseline()
    const plan = await f.run(
      prepareSharedFileManagement({
        library,
        snapshot,
        action: "add",
        path: "notes/new.md",
        markdown: "# New\n",
      }),
    )
    f.createUnknown("visible")
    expect(
      (await f.run(Effect.flip(executeSharedFileManagement(library, { plan, mode: "create" }))))
        .code,
    ).toBe("WRITE_OUTCOME_UNKNOWN")
    expect(f.fileCreates()).toHaveLength(1)
    expect(f.pending()).toHaveLength(1)
    f.clear()
    const error = await f.run(
      Effect.flip(executeSharedFileManagement(library, { plan, mode: "create" })),
    )
    expect(error.code).toBe("SHARED_FILE_MANAGEMENT_UNRESOLVED")
    expect(f.fileCreates()).toHaveLength(0)
    expect(f.pathPatches()).toHaveLength(0)
    expect(f.bodyReads()).toHaveLength(0)
    const pending = await f.run(
      loadPendingSharedFileManagement(library, {
        skillPageId: skillPage,
        events: await f.events(),
      }),
    )
    expect(pending.map((value) => value.operation_id)).toContain(plan.operation_id)
    expect(
      f.files.filter(
        (file) => text(property(property(file.properties).file_id).rich_text) === plan.file_id,
      ),
    ).toHaveLength(1)
  })

  test("unknown Path PATCH never repeats or treats a matching current path as the original terminal", async () => {
    const f = fixture(),
      snapshot = await f.baseline()
    const plan = await f.run(
      prepareSharedFileManagement({
        library,
        snapshot,
        action: "move",
        fileId: "file-1",
        destinationPath: "notes/one.md",
      }),
    )
    f.patchUnknown("visible")
    expect(
      (await f.run(Effect.flip(executeSharedFileManagement(library, { plan, mode: "create" }))))
        .code,
    ).toBe("WRITE_OUTCOME_UNKNOWN")
    expect(f.pathPatches()).toHaveLength(1)
    f.clear()
    expect(
      (await f.run(Effect.flip(executeSharedFileManagement(library, { plan, mode: "create" }))))
        .code,
    ).toBe("SHARED_FILE_MANAGEMENT_UNRESOLVED")
    expect(f.pathPatches()).toHaveLength(0)
    expect(f.bodyReads()).toHaveLength(0)
    expect(
      text(
        property(property(f.files.find((file) => file.id === id(11))?.properties).path).rich_text,
      ),
    ).toBe("notes/one.md")
    expect((await f.events()).some((event) => event.event_id === plan.event.event_id)).toBe(false)
  })

  test("an event alone cannot settle unknown terminal publication; exact visible outcome can", async () => {
    for (const visibility of ["absent", "visible"] as const) {
      const f = fixture(),
        snapshot = await f.baseline()
      const plan = await f.run(
        prepareSharedFileManagement({ library, snapshot, action: "delete", fileId: "file-1" }),
      )
      f.outcomeUnknown(visibility)
      expect(
        (await f.run(Effect.flip(executeSharedFileManagement(library, { plan, mode: "create" }))))
          .code,
      ).toBe("WRITE_OUTCOME_UNKNOWN")
      expect((await f.events()).some((event) => event.event_id === plan.event.event_id)).toBe(true)
      f.clear()
      if (visibility === "absent") {
        expect((await f.run(Effect.flip(reconcileSharedFileManagement(library, plan)))).code).toBe(
          "SHARED_FILE_MANAGEMENT_UNRESOLVED",
        )
        expect(f.pending()).toHaveLength(1)
      } else {
        expect((await f.run(reconcileSharedFileManagement(library, plan))).status).toBe("applied")
        expect(f.pending()).toHaveLength(0)
      }
      expect(f.calls.some((call) => call.path === "v1/pages" || call.method === "PATCH")).toBe(
        false,
      )
      expect(f.bodyReads()).toHaveLength(0)
    }
  })

  test("a new credential can read original shared completion but cannot create from another scope's frozen snapshot", async () => {
    const f = fixture(),
      snapshot = await f.baseline()
    const plan = await f.run(
      prepareSharedFileManagement({ library, snapshot, action: "delete", fileId: "file-1" }),
    )
    await f.run(executeSharedFileManagement(library, { plan, mode: "create" }))
    f.credential("second-authorized-fixture-credential")
    f.clear()
    expect(
      (await f.run(Effect.flip(executeSharedFileManagement(library, { plan, mode: "create" }))))
        .code,
    ).toBe("SHARED_FILE_MANAGEMENT_SCOPE")
    expect((await f.run(reconcileSharedFileManagement(library, plan))).verified).toBe(true)
    expect(f.fileCreates()).toHaveLength(0)
    expect(f.pathPatches()).toHaveLength(0)
    expect(f.bodyReads()).toHaveLength(0)
  })

  test("a concurrent target edit after plan retention aborts before Path PATCH and preserves the new native bytes", async () => {
    const f = fixture(),
      snapshot = await f.baseline()
    const plan = await f.run(
      prepareSharedFileManagement({
        library,
        snapshot,
        action: "move",
        fileId: "file-1",
        destinationPath: "notes/one.md",
      }),
    )
    f.onPlan(() => {
      f.base.bodies.set(id(11), "New user edit\n")
    })
    f.clear()
    expect(
      (await f.run(Effect.flip(executeSharedFileManagement(library, { plan, mode: "create" }))))
        .code,
    ).toBe("SHARED_FILE_MANAGEMENT_STALE")
    expect(f.pathPatches()).toHaveLength(0)
    expect(f.base.bodies.get(id(11))).toBe("New user edit\n")
    expect((await f.run(reconcileSharedFileManagement(library, plan))).status).toBe("not_applied")
    expect(f.pending()).toHaveLength(0)
  })

  test("the extracted immutable version function preserves the existing pinned identity exactly", async () => {
    const f = fixture(),
      snapshot = await f.baseline(),
      events = await f.events()
    const evidence = property(property(snapshot).shared_authoring)
    const observedFiles = evidence.files
    if (!Array.isArray(observedFiles)) throw new Error("Missing fresh authoring evidence")
    const ownership = observedFiles.map((value) => {
      const file = property(value)
      if (typeof file.file_id !== "string" || typeof file.path !== "string")
        throw new Error("Invalid fixture evidence")
      return {
        file_id: file.file_id,
        path: file.path,
        state: resolveFileState(
          file.file_id,
          events.filter((event) => event.file_id === file.file_id),
        ),
      }
    })
    expect(
      await f.run(
        sharedSnapshotVersion({
          record: snapshot.record,
          files: snapshot.files,
          file_bindings: snapshot.file_bindings,
          native_references: snapshot.native_references,
          source: null,
          ownership,
        }),
      ),
    ).toBe(snapshot.version_id)
    expect(snapshot.snapshot_id).toBe(
      `s_${digest(JSON.stringify([snapshot.scope, snapshot.record.id, snapshot.version_id]))}`,
    )
  })
})
