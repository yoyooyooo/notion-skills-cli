import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Layer, Schema } from "effect"
import { live } from "../../../../packages/cli/src/runtime.ts"
import { Notion } from "../../../../packages/core/src/notion.ts"
import { withReadOnlyNotion } from "../../../../packages/core/src/notion-readonly.ts"
import { property, SkillsError } from "../../../../packages/core/src/model.ts"
import { pageId } from "../../../../packages/core/src/ref.ts"
import { parseTarget } from "../../../../packages/core/src/ref.ts"
import {
  SharedLibrarySchema,
  type SharedLibrary,
} from "../../../../packages/core/src/shared-library-model.ts"

const parentFields = { version: Schema.Literal(1), run_id: Schema.String, container: Schema.String }
const State = Schema.Union([
  Schema.Struct({ ...parentFields, kind: Schema.Literal("parent_requested") }),
  Schema.Struct({ ...parentFields, kind: Schema.Literal("parent_ready"), parent: Schema.String }),
  Schema.Struct({
    ...parentFields,
    kind: Schema.Literal("library_ready"),
    parent: Schema.String,
    library: SharedLibrarySchema,
  }),
])
type Drive = (argv: string[]) => Promise<{ output: unknown; exit: number; record: string }>
const roles = ["skills", "files", "records", "sources"] as const
const ListResponse = Schema.Struct({
  results: Schema.Array(Schema.Unknown),
  has_more: Schema.Boolean,
  next_cursor: Schema.NullOr(Schema.String),
})

export function requireTestEntry(actual: string, expected: string) {
  assert.equal(
    pageId(actual),
    pageId(expected),
    "The command entry must be this run's exact library, not a global alias",
  )
  assert.ok(pageId(expected), "The retained library entry must be a UUID")
}

export function requireTestCommand(
  args: readonly string[],
  library: Pick<SharedLibrary, "library_id" | "skills">,
) {
  const isScopeFlag = (value: string) => value === "--database" || value === "--entry"
  const flags = args.filter(isScopeFlag)
  assert.equal(
    flags.length,
    1,
    "An EMPTY management/content action must explicitly select its one exact test entry",
  )
  const index = args.findIndex(isScopeFlag)
  requireTestEntry(args[index + 1] ?? "", library.skills.database_id)
  for (const value of args) {
    if (!value.startsWith("skill://")) continue
    const selector = parseTarget(value).selector
    assert.ok(
      selector.startsWith("skill://") &&
        selector.endsWith(`?library=${encodeURIComponent(library.library_id)}`),
      "A fixed ref belongs to its original library; a test --database cannot retarget a production pin",
    )
  }
}

export function normalizedMetadata(raw: unknown) {
  const row = property(raw)
  assert.equal(row.object, "page")
  assert.equal(typeof row.id, "string")
  const fields: Record<string, unknown> = {}
  for (const value of Object.values(property(row.properties))) {
    const field = property(value)
    assert.equal(typeof field.id, "string")
    assert.notEqual(
      field.has_more,
      true,
      "A truncated property cannot establish a complete table delta",
    )
    const id = String(field.id),
      type = String(field.type)
    assert.equal(Object.hasOwn(fields, id), false, "Repeated stable property identity")
    if (
      type === "last_edited_time" ||
      type === "created_time" ||
      type === "last_edited_by" ||
      type === "created_by"
    )
      continue
    const body = field[type]
    if (type === "relation") {
      assert.ok(Array.isArray(body))
      fields[id] = {
        type,
        ids: body
          .map((item) => {
            const target = property(item).id
            assert.equal(typeof target, "string")
            return String(target)
          })
          .sort(),
      }
    } else if (type === "title" || type === "rich_text") {
      assert.ok(Array.isArray(body))
      fields[id] = {
        type,
        text: body
          .map((item) => {
            const part = property(item),
              value = part.plain_text ?? property(part.text).content
            assert.equal(typeof value, "string")
            return String(value)
          })
          .join(""),
      }
    } else fields[id] = { type, value: body }
  }
  return { id: String(row.id), parent: row.parent, in_trash: row.in_trash === true, fields }
}

export async function runEmptyLibrary(input: {
  readonly root: string
  readonly stage: string
  readonly container?: string
  readonly argv?: readonly string[]
  readonly drive: Drive
  readonly probe: (request: typeof Probe.Type) => Promise<Record<string, unknown>>
}) {
  const folder = join(input.root, "evidence", "empty-library")
  await mkdir(folder, { recursive: true, mode: 0o700 })
  const save = async (name: string, value: unknown) => {
    const path = join(folder, name)
    await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
    return path
  }
  const readState = async () => {
    try {
      return Schema.decodeUnknownSync(State)(
        JSON.parse(await readFile(join(folder, "state.json"), "utf8")),
      )
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        return undefined
      throw error
    }
  }
  const execute = async (label: string, argv: string[]) => {
    const result = await input.drive(argv)
    await save(`${label}-${randomUUID()}.json`, result)
    assert.equal(
      result.exit,
      0,
      `Public command failed; preserve the original result at ${result.record}`,
    )
    assert.equal(
      property(result.output).ok,
      true,
      `Public command has no success result: ${result.record}`,
    )
    return property(result.output)
  }
  const census = async (library: SharedLibrary, label: string) => {
    const observation = await input.probe({ kind: "census", library })
    await save(`${label}-${randomUUID()}.json`, observation)
    return observation
  }

  let state = await readState()
  if (input.stage === "command") {
    assert.equal(
      state?.kind,
      "library_ready",
      "The test library must be initialized before authoring",
    )
    if (state?.kind !== "library_ready") throw new Error("Library is not ready")
    const args = input.argv ?? []
    requireTestCommand(args, state.library)
    const result = await input.drive([...args])
    return { exit: result.exit, evidence: result.record, output: result.output }
  }
  if (input.stage === "census") {
    assert.equal(
      state?.kind,
      "library_ready",
      "Finish or inspect the original initialization first",
    )
    if (state?.kind !== "library_ready") throw new Error("No registered library")
    return await census(state.library, "census")
  }
  assert.equal(input.stage, "init", "Use stage init or census")
  const container = pageId(input.container ?? "")
  assert.ok(container, "Supply the exact authorized test container UUID or URL")
  if (state !== undefined)
    assert.equal(state.container, container, "This run is already scoped to a different container")
  if (state === undefined) {
    const containerPage = await input.probe({ kind: "page", id: container })
    assert.equal(containerPage.id, container)
    assert.notEqual(containerPage.in_trash, true)
    const original = {
      version: 1 as const,
      kind: "parent_requested" as const,
      run_id: randomUUID(),
      container,
    }
    await save("state.json", original)
    const body = {
      parent: { type: "page_id", page_id: container },
      properties: {
        title: {
          type: "title",
          title: [{ type: "text", text: { content: `AH1040 empty library ${original.run_id}` } }],
        },
      },
    }
    await save("parent-request.json", body)
    const raw = await input.probe({ kind: "parent", container, run_id: original.run_id })
    await save("parent-ack.json", raw)
    const receipt = property(raw),
      id = pageId(String(receipt.id))
    assert.ok(
      id && receipt.object === "page" && property(receipt.parent).page_id === container,
      "Original parent response has no valid allocated identity",
    )
    state = { version: 1, kind: "parent_ready", run_id: original.run_id, container, parent: id }
    await save("state.json", state)
  }
  assert.notEqual(
    state.kind,
    "parent_requested",
    "Parent creation has an unresolved original request; do not create a second parent",
  )
  if (state.kind === "parent_requested") throw new Error("Original parent request unresolved")
  if (state.kind === "parent_ready") {
    const parent = state.parent
    const first = Schema.decodeUnknownSync(ListResponse)(
      await input.probe({ kind: "children", id: parent }),
    )
    await save(`parent-observed-${randomUUID()}.json`, first)
    const alreadyAttempted = await readFile(join(folder, "init-attempt.json"), "utf8").catch(
      (error) => {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
          return undefined
        throw error
      },
    )
    if (alreadyAttempted !== undefined)
      throw new Error(
        "Inspect the retained original init result before continuing; this stage does not retry an incomplete init",
      )
    assert.equal(first.has_more, false)
    assert.equal(first.results.length, 0, "New parent was not empty")
    await save("init-attempt.json", { parent: state.parent, at: new Date().toISOString() })
    const created = await execute("init", ["ctl", "library", "init", "--parent", state.parent])
    const library = Schema.decodeUnknownSync(SharedLibrarySchema)(created.library)
    assert.equal(library.parent_page_id, state.parent)
    state = { ...state, kind: "library_ready", library }
    await save("state.json", state)
  }
  const ready = state
  assert.equal(ready.kind, "library_ready")
  if (ready.kind !== "library_ready") throw new Error("Library not ready")
  const before = await census(ready.library, "empty-before-repeat")
  for (const role of roles)
    assert.equal(
      property(property(before.tables)[role]).count,
      0,
      "First slice must precede any business content",
    )
  const repeat = await execute("init-repeat", ["ctl", "library", "init", "--parent", ready.parent])
  assert.equal(repeat.reused, true)
  assert.deepEqual(repeat.library, ready.library)
  const attached = await execute("attach", [
    "ctl",
    "library",
    "init",
    "--entry",
    ready.library.skills.database_id,
  ])
  assert.deepEqual(attached.library, ready.library)
  const listed = await execute("empty-list", [
    "list",
    "--database",
    ready.library.skills.database_id,
    "--refresh",
    "--json",
  ])
  assert.equal(listed.total_count, 0)
  assert.equal(listed.has_more, false)
  const after = await census(ready.library, "empty-after-repeat")
  assert.deepEqual(after.tables, before.tables)
  const children = Schema.decodeUnknownSync(ListResponse)(
    await input.probe({ kind: "children", id: ready.parent }),
  )
  assert.equal(children.has_more, false)
  assert.deepEqual(
    children.results
      .map((row) => {
        assert.equal(property(row).type, "child_database")
        return property(row).id
      })
      .sort(),
    roles.map((role) => ready.library[role]?.database_id).sort(),
    "Repeating initialization must leave exactly the same four tables",
  )
  await save("registered-table-children.json", children)
  const result = {
    stage: "EMPTY01",
    status: "passed_empty_initialization",
    parent: ready.parent,
    entry: ready.library.skills.database_id,
    library: ready.library,
    repeated_without_business_rows: true,
    boundary:
      "real public CLI and real Notion; parent creation is separately recorded test setup, not a product initializer claim",
  }
  await save("initialization-result.json", result)
  return result
}

const Probe = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("page"), id: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("children"), id: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("parent"),
    container: Schema.String,
    run_id: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("census"), library: SharedLibrarySchema }),
  Schema.Struct({
    kind: Schema.Literal("native-draft"),
    library: SharedLibrarySchema,
    name: Schema.String,
    description: Schema.String,
    markdown: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("native-body-edit"),
    library: SharedLibrarySchema,
    owner: Schema.String,
    target: Schema.String,
    expected_markdown: Schema.String,
    markdown: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("native-unregistered-file"),
    library: SharedLibrarySchema,
    owner: Schema.String,
    path: Schema.String,
    markdown: Schema.String,
  }),
])
export async function probeEmptyLibrary(value: unknown) {
  const request = Schema.decodeUnknownSync(Probe)(value, { onExcessProperty: "error" })
  const run = <A>(effect: Effect.Effect<A, SkillsError, Layer.Success<typeof live>>) =>
    Effect.runPromise(effect.pipe(Effect.provide(live), Effect.scoped))
  if (request.kind === "parent") {
    assert.ok(
      pageId(request.container) === request.container && /^[0-9a-f-]{36}$/u.test(request.run_id),
    )
    return await run(
      Effect.gen(function* () {
        return yield* (yield* Notion).request("v1/pages", {
          parent: { type: "page_id", page_id: request.container },
          properties: {
            title: {
              type: "title",
              title: [
                { type: "text", text: { content: `AH1040 empty library ${request.run_id}` } },
              ],
            },
          },
        })
      }),
    )
  }
  if (
    request.kind === "native-draft" ||
    request.kind === "native-body-edit" ||
    request.kind === "native-unregistered-file"
  ) {
    return await run(
      Effect.gen(function* () {
        const api = yield* Notion,
          library = request.library
        // These are explicitly labeled test simulations of native authoring, not
        // product schema/identity repair. Never populate managed IDs or Records.
        if (request.kind === "native-draft") {
          assert.ok(request.name.startsWith("empty-") && request.description.length > 0)
          const fields = library.skills.property_ids
          return yield* api.request("v1/pages", {
            parent: { type: "data_source_id", data_source_id: library.skills.data_source_id },
            properties: {
              [fields.Name!]: { title: [{ type: "text", text: { content: request.name } }] },
              [fields.Description!]: {
                rich_text: [{ type: "text", text: { content: request.description } }],
              },
              [fields.Kind!]: { select: { name: "skill" } },
              [fields.Enabled!]: { checkbox: false },
            },
            markdown: request.markdown,
            markdown_version: "v2",
          })
        }
        assert.equal(pageId(request.owner), request.owner)
        const owner = property(yield* api.request(`v1/pages/${request.owner}`))
        assert.equal(property(owner.parent).data_source_id, library.skills.data_source_id)
        assert.notEqual(owner.in_trash, true)
        if (request.kind === "native-unregistered-file") {
          assert.ok(
            request.path.startsWith("references/empty-") &&
              request.path.endsWith(".md") &&
              !request.path.includes(".."),
          )
          const fields = library.files.property_ids
          return yield* api.request("v1/pages", {
            parent: { type: "data_source_id", data_source_id: library.files.data_source_id },
            properties: {
              [fields.Name!]: {
                title: [{ type: "text", text: { content: request.path.split("/").at(-1)! } }],
              },
              [fields.Path!]: { rich_text: [{ type: "text", text: { content: request.path } }] },
              [fields.Skill!]: { relation: [{ id: request.owner }] },
              [fields.Status!]: { select: { name: "custom" } },
            },
            markdown: request.markdown,
            markdown_version: "v2",
          })
        }
        assert.equal(pageId(request.target), request.target)
        const target =
          request.target === request.owner
            ? owner
            : property(yield* api.request(`v1/pages/${request.target}`))
        if (request.target !== request.owner) {
          assert.equal(property(target.parent).data_source_id, library.files.data_source_id)
          const field = Object.values(property(target.properties))
            .map(property)
            .find((item) => item.id === library.files.property_ids.Skill)
          assert.ok(field && field.has_more !== true && Array.isArray(field.relation))
          assert.deepEqual(
            field.relation.map((item) => property(item).id),
            [request.owner],
          )
        }
        const before = property(
          yield* api.request(`v1/pages/${request.target}/markdown?markdown_version=v2`),
        )
        assert.equal(before.truncated, false)
        assert.deepEqual(before.unknown_block_ids, [])
        assert.equal(
          before.markdown,
          request.expected_markdown,
          "The native edit uses the exact observed test page, not a guessed body",
        )
        return yield* api.request(
          `v1/pages/${request.target}/markdown`,
          {
            type: "update_content",
            markdown_version: "v2",
            update_content: {
              content_updates: [{ old_str: request.expected_markdown, new_str: request.markdown }],
            },
          },
          { method: "PATCH" },
        )
      }),
    )
  }
  return await run(
    Effect.gen(function* () {
      if (request.kind === "page" || request.kind === "children") {
        assert.equal(pageId(request.id), request.id)
        return yield* (yield* Notion).request(
          request.kind === "page"
            ? `v1/pages/${request.id}`
            : `v1/blocks/${request.id}/children?page_size=100`,
        )
      }
      const library = request.library
      const api = yield* Notion,
        tables: Record<string, unknown> = {}
      for (const role of roles) {
        const table = library[role]
        assert.ok(table, `The current initializer must establish ${role}`)
        const query = new URLSearchParams()
        for (const [name, id] of Object.entries(table.property_ids)) {
          // These tables have no body payload; include their generated reverse
          // relations (for example Supporting Files), not just registered fields.
          if (role === "skills" || role === "files") continue
          if (role === "records" && name === "Payload") continue
          if (role === "sources" && ["Skills", "Records"].includes(name)) continue
          query.append("filter_properties", id)
        }
        const rows: unknown[] = [],
          ids = new Set<string>(),
          seen = new Set<string>()
        let cursor: string | undefined
        do {
          const raw: unknown = yield* api.request(
            `v1/data_sources/${table.data_source_id}/query?${query}`,
            {
              page_size: 100,
              ...(cursor ? { start_cursor: cursor } : {}),
            },
          )
          const response = Schema.decodeUnknownSync(ListResponse)(raw)
          const status: unknown = property(property(raw).request_status).type
          assert.ok(
            status === undefined || status === "complete",
            "Server returned an incomplete query",
          )
          for (const item of response.results) {
            const row = normalizedMetadata(item)
            assert.equal(property(row.parent).data_source_id, table.data_source_id)
            assert.equal(row.in_trash, false)
            assert.equal(ids.has(row.id), false, "Repeated page while paginating")
            ids.add(row.id)
            rows.push(row)
          }
          if (response.has_more) {
            assert.ok(
              response.next_cursor && !seen.has(response.next_cursor),
              "Missing or repeated cursor",
            )
            cursor = response.next_cursor
            seen.add(cursor)
          } else {
            assert.equal(response.next_cursor, null)
            cursor = undefined
          }
        } while (cursor)
        tables[role] = {
          database_id: table.database_id,
          data_source_id: table.data_source_id,
          complete: true,
          count: rows.length,
          rows: rows.sort((a, b) => String(property(a).id).localeCompare(String(property(b).id))),
        }
      }
      return {
        library_id: library.library_id,
        entry: library.skills.database_id,
        tables,
        request_metrics: api.requestMetrics?.(),
        observer: "metadata_only_read_only_capability",
      }
    }).pipe(withReadOnlyNotion),
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "--probe") {
  const path = process.argv[3]
  assert.ok(path, "Probe requires its original input file")
  console.log(JSON.stringify(await probeEmptyLibrary(JSON.parse(await readFile(path, "utf8")))))
}
