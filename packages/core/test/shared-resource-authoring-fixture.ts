import { Effect } from "effect"
import { authScope } from "../src/catalog.ts"
import { fail, property, text, type SkillsError } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { openSharedSnapshot, type FixedSharedSource } from "../src/shared-snapshot.ts"
import {
  prepareSharedSnapshotHistory,
  retainSharedSnapshotHistory,
} from "../src/shared-snapshot-history.ts"
import {
  sharedSnapshotFixture,
  digest,
  id,
  library,
  rich,
  skillPage,
} from "./shared-snapshot-fixture.ts"

function field(key: string, input: unknown) {
  const value = property(input)
  if (Array.isArray(value.rich_text))
    return { ...value, id: key, type: "rich_text", has_more: false }
  if (Array.isArray(value.title)) return { ...value, id: key, type: "title" }
  if (Array.isArray(value.relation)) return { ...value, id: key, type: "relation", has_more: false }
  if (value.select !== undefined) return { ...value, id: key, type: "select" }
  throw new Error("Unexpected resource fixture property")
}

export async function resourceAuthoringFixture() {
  const base = sharedSnapshotFixture()
  const api = await base.run(Notion)
  const files: Record<string, unknown>[] = structuredClone(base.files)
  const blocks = new Map<string, Record<string, unknown>>()
  const children = new Map<string, string[]>()
  const calls: Array<{ path: string; method: string; body: unknown }> = []
  let nextId = 60000
  let fault: { kind: "create" | "append" | "move" | "outcome"; accepted: boolean } | undefined
  let fixedSource: FixedSharedSource | undefined
  let onCreate: ((row: Record<string, unknown>) => void) | undefined
  const activePlan = () =>
    [...base.json.entries()].find(
      ([key, value]) =>
        key.startsWith("operations/shared-observation-pending/") &&
        property(property(value).plan).kind === "resource_authoring",
    )
  const assertOriginal = () => {
    const entry = activePlan()
    if (entry === undefined)
      throw fail(
        "TEST_DISPATCH_ORDER",
        "Resource dispatch preceded its durable original local plan",
      )
    const plan = property(property(entry[1]).plan)
    const shared = [...base.records.values()].map((row) =>
      JSON.parse(text(property(property(row.properties).payload).rich_text)),
    )
    if (
      !shared.some((row) => property(row).operation_id === plan.operation_id) ||
      !shared.some((row) => property(property(row).payload).kind === "retained_resource") ||
      !shared.some((row) => property(property(row).payload).kind === "fixed_snapshot")
    )
      throw fail(
        "TEST_DISPATCH_ORDER",
        "Resource display preceded its original plan, exact bytes or previous snapshot retention",
      )
  }
  const addBlock = (page: string, input: unknown) => {
    const block = property(structuredClone(input))
    const blockId = id(nextId++)
    const row = {
      ...block,
      object: "block",
      id: blockId,
      parent: { type: "page_id", page_id: page },
      archived: false,
      in_trash: false,
    }
    blocks.set(blockId, row)
    children.set(page, [...(children.get(page) ?? []), blockId])
    return row
  }
  const remote: Notion["Service"] = {
    ...api,
    get metrics() {
      return api.metrics
    },
    request: (path, body, options) =>
      Effect.suspend((): Effect.Effect<unknown, SkillsError> => {
        const method = options?.method ?? (body === undefined ? "GET" : "POST")
        calls.push({ path, method, body })
        const pathname = new URL(path, "https://api.notion.com/").pathname
        if (pathname === `/v1/data_sources/${library.files.data_source_id}/query`)
          return Effect.succeed({
            object: "list",
            results: structuredClone(files),
            has_more: false,
            next_cursor: null,
          })
        const page = files.find((file) => pathname === `/v1/pages/${file.id}`)
        const raw = property(body)
        if (page !== undefined && method === "PATCH") {
          assertOriginal()
          if (
            Object.keys(raw).join() !== "properties" ||
            Object.keys(property(raw.properties)).join() !== "path"
          )
            return Effect.fail(fail("TEST_RESOURCE_BODY", "A resource move may update only Path"))
          const outcome = fault?.kind === "move" ? fault : undefined
          if (outcome !== undefined) fault = undefined
          if (outcome?.accepted !== false) {
            property(page.properties).path = field("path", property(raw.properties).path)
            page.last_edited_time = new Date().toISOString()
          }
          return outcome === undefined
            ? Effect.succeed(structuredClone(page))
            : Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "Lost original resource Path response"))
        }
        if (page !== undefined) return Effect.succeed(structuredClone(page))
        if (
          pathname === "/v1/pages" &&
          method === "POST" &&
          property(raw.parent).data_source_id === library.files.data_source_id
        ) {
          assertOriginal()
          const outcome = fault?.kind === "create" ? fault : undefined
          if (outcome !== undefined) fault = undefined
          let created: Record<string, unknown> | undefined
          if (outcome?.accepted !== false) {
            const pageId = id(nextId++)
            created = {
              object: "page",
              id: pageId,
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
            if (
              !Array.isArray(raw.children) ||
              raw.children.length !== 1 ||
              raw.markdown !== undefined
            )
              return Effect.fail(
                fail(
                  "TEST_RESOURCE_BODY",
                  "A resource must create one management entry without text conversion",
                ),
              )
            files.push(created)
            addBlock(pageId, raw.children[0])
            base.bodies.set(pageId, "MANAGEMENT NOTES ARE NOT THE RESOURCE BYTES")
            onCreate?.(created)
          }
          return outcome === undefined
            ? Effect.succeed(structuredClone(created))
            : Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "Lost original resource page response"))
        }
        const child = /^\/v1\/blocks\/([^/]+)\/children$/u.exec(pathname)
        if (child !== null) {
          const pageId = child[1]!
          if (method === "GET")
            return Effect.succeed({
              object: "list",
              results: (children.get(pageId) ?? []).map((block) =>
                structuredClone(blocks.get(block)),
              ),
              has_more: false,
              next_cursor: null,
            })
          if (method === "PATCH") {
            assertOriginal()
            const outcome = fault?.kind === "append" ? fault : undefined
            if (outcome !== undefined) fault = undefined
            if (!Array.isArray(raw.children) || raw.children.length !== 1)
              return Effect.fail(
                fail(
                  "TEST_RESOURCE_BODY",
                  "Resource replacement must append exactly one version entry",
                ),
              )
            const added = outcome?.accepted === false ? [] : [addBlock(pageId, raw.children[0])]
            const selected = files.find((file) => file.id === pageId)
            if (selected !== undefined) selected.last_edited_time = new Date().toISOString()
            return outcome === undefined
              ? Effect.succeed({
                  object: "list",
                  results: structuredClone(added),
                  has_more: false,
                  next_cursor: null,
                })
              : Effect.fail(
                  fail("WRITE_OUTCOME_UNKNOWN", "Lost original version-entry append response"),
                )
          }
        }
        const block = /^\/v1\/blocks\/([^/]+)$/u.exec(pathname)
        if (block !== null && blocks.has(block[1]!))
          return Effect.succeed(structuredClone(blocks.get(block[1]!)))
        if (pathname === "/v1/pages" && method === "POST" && fault?.kind === "outcome") {
          const payload = JSON.parse(text(property(property(raw.properties).payload).rich_text))
          if (property(property(payload).payload).kind === "resource_authoring_outcome") {
            const outcome = fault
            fault = undefined
            return (outcome.accepted ? api.request(path, body, options) : Effect.void).pipe(
              Effect.flatMap(() =>
                Effect.fail(
                  fail("WRITE_OUTCOME_UNKNOWN", "Lost original resource outcome response"),
                ),
              ),
            )
          }
        }
        if (method === "PATCH" && pathname.includes("/markdown"))
          return Effect.fail(
            fail("TEST_RESOURCE_BODY", "Resource authoring overwrote a native body"),
          )
        return api.request(path, body, options)
      }),
  }
  function consumer(state: ReturnType<typeof sharedSnapshotFixture>) {
    const run: typeof base.run = (effect) =>
      state.run(effect.pipe(Effect.provideService(Notion, remote)))
    const open = (readOnly = true) =>
      run(
        Effect.gen(function* () {
          return yield* openSharedSnapshot({
            library,
            target: skillPage,
            scope: yield* authScope,
            startedAt: Date.now(),
            forceFull: true,
            readOnly,
            ...(fixedSource === undefined ? {} : { fixedSource }),
          })
        }),
      )
    return { state, run, open }
  }
  const owner = consumer(base)
  return {
    ...owner,
    base,
    files,
    blocks,
    children,
    calls,
    cold: () => consumer(sharedSnapshotFixture()),
    clearCalls: () => {
      calls.length = 0
      base.clearCalls()
    },
    unknown: (kind: "create" | "append" | "move" | "outcome", accepted: boolean) => {
      fault = { kind, accepted }
    },
    onCreate: (handler: (row: Record<string, unknown>) => void) => {
      onCreate = handler
    },
    fixed: (source: FixedSharedSource) => {
      fixedSource = source
      property(base.main.properties).source = rich("source", source.source_id)
    },
    source: async (files: FixedSharedSource["files"]) => {
      const original = await owner.open()
      const entries = files.map((file) => {
        const hash = digest(file.bytes)
        base.objects.set(`objects/${hash}`, new Uint8Array(file.bytes))
        return {
          path: file.path,
          sha256: hash,
          bytes: file.bytes.length,
          ...(file.mode === undefined ? {} : { mode: file.mode }),
        }
      })
      const { file_bindings: _bindings, native_references: _references, ...plain } = original
      const version_id = digest(JSON.stringify(entries))
      const snapshot = {
        ...plain,
        files: entries,
        version_id,
        snapshot_id: `s_${digest(JSON.stringify([original.scope, original.record.id, version_id]))}`,
      }
      const plan = await owner.run(prepareSharedSnapshotHistory(library, snapshot))
      await owner.run(retainSharedSnapshotHistory(library, { plan, mode: "create" }))
      fixedSource = { source_id: plan.pin_id, revision: plan.pin_id, files }
      property(base.main.properties).source = rich("source", plan.pin_id)
      return plan.pin_id
    },
    writes: () =>
      calls.filter(
        (call) =>
          call.method === "PATCH" || (call.method === "POST" && !call.path.includes("/query")),
      ),
  }
}
