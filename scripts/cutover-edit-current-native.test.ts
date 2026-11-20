import { afterAll, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { fail, property, text } from "../packages/core/src/model.ts"
import { Notion } from "../packages/core/src/notion.ts"
import { queryCurrentSkillIndex } from "../packages/core/src/shared-current-index.ts"
import {
  prepareCurrentSkillWrite,
  writeCurrentSkill,
} from "../packages/core/src/shared-current-write.ts"
import { LIBRARY_MARKER } from "../packages/core/src/shared-library-model.ts"
import { canonicalSharedJson } from "../packages/core/src/shared-records.ts"
import { currentWriteFixture, library } from "../packages/core/test/shared-current-write-fixture.ts"
import {
  editCurrentNative,
  inspectCurrentNativeEdit,
  parseNativeEditArguments,
  prepareNativeEditInput,
} from "./cutover-edit-current-native.ts"

const parent = mkdtempSync(join(tmpdir(), "ah513-ready-native-edit-"))
afterAll(() => rmSync(parent, { recursive: true, force: true }))
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const rich = (value: string) => [{ type: "text", text: { content: value } }]
const header = (description: string, compatibility: string) =>
  "---\nname: finite-native-guide\ndescription: " +
  JSON.stringify(description) +
  "\ncompatibility: " +
  JSON.stringify(compatibility) +
  "\nmetadata:\n  publisher: kept-publisher\n  builtin-id: kept-historical-label\n---\n\n"
async function fixture() {
  const f = currentWriteFixture(parent),
    directory = mkdtempSync(join(parent, "input-")),
    beforeHeader = header("Before description", "Before compatibility"),
    afterHeader = header("Current description", "Current compatibility"),
    selected = [
      {
        path: "SKILL.md",
        file_id: "native-guide-main",
        name: "finite-native-guide",
        beforeHeader,
        afterHeader,
        beforeBody: "# Old guide\n\nRead [operations](references/operations.md).\n",
        afterBody: "# Current guide\n\nRead [operations](references/operations.md).\n",
      },
      {
        path: "references/operations.md",
        file_id: "native-guide-support",
        name: "references/operations.md",
        beforeHeader: "",
        afterHeader: "",
        beforeBody: "# Old operations\n\nPrevious authored instructions.\n",
        afterBody: "# Current operations\n\nExplicit current authored instructions.\n",
      },
    ]
  const plan = await f.run(
    prepareCurrentSkillWrite({
      skill_id: "finite-native-guide",
      kind: "skill",
      name: "finite-native-guide",
      description: "Before description",
      enabled: true,
      default_context: false,
      files: selected.map((file) => ({
        path: file.path,
        file_id: file.file_id,
        bytes: Buffer.from(file.beforeHeader + file.beforeBody),
        authority: { kind: "native" },
      })),
    }),
  )
  const written = await f.run(writeCurrentSkill(library, { plan, operation_id: "initial-guide" })),
    owner = written.page_id,
    index = await f.run(queryCurrentSkillIndex(library, owner)),
    bindings = [index.main, ...index.files]
  const files = selected.map((file, offset) => {
    const binding = bindings.find((entry) => entry.file_id === file.file_id)!
    const beforePath = join(directory, offset + ".before.md"),
      afterPath = join(directory, offset + ".after.md"),
      after = file.afterHeader + file.afterBody
    writeFileSync(beforePath, file.beforeBody)
    writeFileSync(afterPath, after)
    return {
      page_id: binding.page_id,
      file_id: file.file_id,
      path: file.path,
      name: file.name,
      before: {
        content: { kind: "native", mode: "100644", frontmatter: file.beforeHeader },
        body: {
          local_path: beforePath,
          sha256: digest(file.beforeBody),
          bytes: Buffer.byteLength(file.beforeBody),
        },
      },
      after: {
        local_bytes_path: afterPath,
        sha256: digest(after),
        bytes: Buffer.byteLength(after),
        content: { kind: "native", mode: "100644", frontmatter: file.afterHeader },
      },
    }
  })
  const document = {
    version: 1,
    kind: "ah513-ready-native-edit",
    library,
    owner: {
      page_id: owner,
      skill_id: "finite-native-guide",
      before: {
        name: "finite-native-guide",
        description: "Before description",
        compatibility: "Before compatibility",
        kind: "skill",
        enabled: true,
        default_context: false,
        main_file_id: "native-guide-main",
        current_state: "ready",
        operation: "",
        relations: { origin: [], members: [], requires: [] },
      },
      after: { description: "Current description", compatibility: "Current compatibility" },
    },
    files,
  }
  const prepare = (value: unknown = document) => {
    const bytes = Buffer.from(JSON.stringify(value))
    return f.run(prepareNativeEditInput({ bytes, sha256: digest(bytes) }))
  }
  const input = await prepare()
  f.clearCalls()
  return { ...f, input, document, owner, prepare, baselineJson: new Map(f.json) }
}
const markdownPatches = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.mutations().filter((call) => call.method === "PATCH" && call.path.includes("/markdown"))
const state = (f: Awaited<ReturnType<typeof fixture>>) =>
  property(property(property(f.pages.get(f.owner)).properties)["current-state"]).select

test("dry-run proves the additive schema and exact ready tree without local or remote writes", async () => {
  const f = await fixture(),
    previous = structuredClone(library)
  delete previous.skills.property_ids.Content
  delete previous.skills.property_ids["Current State"]
  delete previous.skills.property_ids.Operation
  delete previous.files.property_ids.Content
  f.rewrite((path, response) =>
    path === "v1/databases/" + library.skills.database_id
      ? { ...response, description: [{ plain_text: LIBRARY_MARKER + JSON.stringify(previous) }] }
      : response,
  )
  const result = await f.run(inspectCurrentNativeEdit(f.input, "guide-edit"))
  expect(result.registration).toBe("additive_descriptor_pending")
  expect(result.remote_writes).toBe(0)
  expect(f.mutations()).toHaveLength(0)
  expect(f.json).toEqual(f.baselineJson)
})

test("the existing operation owns two bodies and paired owner metadata, with a zero-write completed resume", async () => {
  const f = await fixture(),
    beforePages = [...f.pages.keys()]
  const result = await f.run(editCurrentNative(f.input, "guide-edit", "apply"))
  expect(result.state).toBe("ready")
  expect(result.acknowledged_body_patches).toBe(2)
  expect(result.acknowledged_metadata_patches).toBe(1)
  expect(markdownPatches(f)).toHaveLength(2)
  const mutations = f.mutations(),
    create = mutations.findIndex((call) => call.method === "POST" && call.path === "v1/pages"),
    applying = mutations.findIndex(
      (call) =>
        call.path === "v1/pages/" + f.owner &&
        property(property(property(call.body).properties)["current-state"]).select !== undefined,
    ),
    firstBody = mutations.findIndex((call) => call.path.includes("/markdown"))
  expect(create).toBeGreaterThanOrEqual(0)
  expect(applying).toBeGreaterThan(create)
  expect(firstBody).toBeGreaterThan(applying)
  expect(f.table("skills")).toHaveLength(1)
  expect(f.table("files")).toHaveLength(1)
  expect(f.table("records")).toHaveLength(0)
  expect(f.json).toEqual(f.baselineJson)
  expect(f.table("sources")).toHaveLength(0)
  expect(
    mutations.some(
      (call) => call.path.includes("/databases/") || call.path.includes("/data_sources/"),
    ),
  ).toBe(false)
  for (const page of beforePages) expect(f.pages.has(page)).toBe(true)
  const index = await f.run(queryCurrentSkillIndex(library, f.owner))
  expect(index.state.state).toBe("ready")
  expect(index.description).toBe("Current description")
  expect(index.main.content).toEqual(f.input.main.prepared.content)
  expect(index.files[0]?.content).toEqual(f.input.selected.files[1]!.before.content)
  f.clearCalls()
  const resumed = await f.run(editCurrentNative(f.input, "guide-edit", "resume"))
  expect(resumed.state).toBe("ready")
  expect(resumed.acknowledged_body_patches).toBe(0)
  expect(resumed.acknowledged_metadata_patches).toBe(0)
  expect(f.mutations()).toHaveLength(0)
  expect(f.json).toEqual(f.baselineJson)
})

test("an unknown body PATCH that actually landed is observed and never repeated", async () => {
  const f = await fixture(),
    first = f.input.files[0]!
  f.failNext({ kind: "native-body", outcome: "accepted" })
  const failed = await f.run(
    editCurrentNative(f.input, "guide-unknown", "apply").pipe(Effect.result),
  )
  expect(failed._tag).toBe("Failure")
  expect(markdownPatches(f).map((call) => call.path)).toEqual([
    "v1/pages/" + first.selected.page_id + "/markdown",
  ])
  expect(property(state(f)).name).toBe("applying")
  expect(f.json.size).toBe(f.baselineJson.size + 1)
  f.clearCalls()
  expect((await f.run(editCurrentNative(f.input, "guide-unknown", "resume"))).state).toBe("ready")
  expect(markdownPatches(f)).toHaveLength(1)
  expect(markdownPatches(f)[0]?.path).not.toBe("v1/pages/" + first.selected.page_id + "/markdown")
  expect(f.json).toEqual(f.baselineJson)
})

test("third-party body drift after an unknown write remains pending without an overwrite", async () => {
  const f = await fixture(),
    first = f.input.files[0]!
  f.failNext({ kind: "native-body", outcome: "accepted" })
  await f.run(editCurrentNative(f.input, "guide-body-drift", "apply").pipe(Effect.result))
  await f.run(
    Effect.gen(function* () {
      yield* (yield* Notion).request(
        "v1/pages/" + first.selected.page_id + "/markdown",
        {
          markdown_version: "v2",
          type: "replace_content",
          replace_content: { new_str: "Human edit\n" },
        },
        { method: "PATCH" },
      )
    }),
  )
  f.clearCalls()
  const result = await f.run(
    editCurrentNative(f.input, "guide-body-drift", "resume").pipe(Effect.result),
  )
  expect(result._tag).toBe("Failure")
  if (result._tag === "Failure") expect(result.failure.code).toBe("CUTOVER_NATIVE_CHANGED")
  expect(f.mutations()).toHaveLength(0)
  expect(property(state(f)).name).toBe("applying")
  expect(f.json.size).toBe(f.baselineJson.size + 1)
})

test("third-party Description drift after an unknown write is never overwritten", async () => {
  const f = await fixture()
  f.failNext({ kind: "native-body", outcome: "accepted" })
  await f.run(editCurrentNative(f.input, "guide-metadata-drift", "apply").pipe(Effect.result))
  await f.run(
    Effect.gen(function* () {
      yield* (yield* Notion).request(
        "v1/pages/" + f.owner,
        { properties: { description: { rich_text: rich("Human description") } } },
        { method: "PATCH" },
      )
    }),
  )
  f.clearCalls()
  const result = await f.run(
    editCurrentNative(f.input, "guide-metadata-drift", "resume").pipe(Effect.result),
  )
  expect(result._tag).toBe("Failure")
  if (result._tag === "Failure") expect(result.failure.code).toBe("CUTOVER_NATIVE_EDIT_INVALID")
  expect(f.mutations()).toHaveLength(0)
  expect(property(state(f)).name).toBe("applying")
  expect(f.json.size).toBe(f.baselineJson.size + 1)
})

test("an acknowledged owner-property write with a lost response reconciles without rewriting it", async () => {
  const f = await fixture()
  const interrupted = await f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      let once = false
      const wrapped: Notion["Service"] = {
        ...api,
        request: (path, body, options) =>
          api.request(path, body, options).pipe(
            Effect.flatMap((response) => {
              if (
                !once &&
                path === "v1/pages/" + f.owner &&
                options?.method === "PATCH" &&
                "description" in property(property(body).properties)
              ) {
                once = true
                return Effect.fail(fail("NETWORK_ERROR", "The exact PATCH response was lost."))
              }
              return Effect.succeed(response)
            }),
          ),
      }
      return yield* editCurrentNative(f.input, "guide-metadata-unknown", "apply").pipe(
        Effect.provideService(Notion, wrapped),
        Effect.result,
      )
    }),
  )
  expect(interrupted._tag).toBe("Failure")
  expect(property(state(f)).name).toBe("applying")
  f.clearCalls()
  expect((await f.run(editCurrentNative(f.input, "guide-metadata-unknown", "resume"))).state).toBe(
    "ready",
  )
  expect(markdownPatches(f)).toHaveLength(0)
  expect(
    f.mutations().filter((call) => "description" in property(property(call.body).properties)),
  ).toHaveLength(0)
})

test("Description drift during the metadata action body reads is preserved without a target metadata PATCH", async () => {
  const f = await fixture()
  let injected = false
  const result = await f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      let completedBodyPatches = 0,
        metadataObservedAfterBodies = false
      const wrapped: Notion["Service"] = {
        ...api,
        request: (path, body, options) =>
          api.request(path, body, options).pipe(
            Effect.flatMap((response) =>
              Effect.gen(function* () {
                if (options?.method === "PATCH" && path.endsWith("/markdown"))
                  completedBodyPatches += 1
                if (
                  completedBodyPatches === 2 &&
                  path.startsWith("v1/data_sources/" + library.files.data_source_id + "/query")
                )
                  metadataObservedAfterBodies = true
                if (
                  !injected &&
                  metadataObservedAfterBodies &&
                  path.includes("/markdown?") &&
                  options?.method !== "PATCH"
                ) {
                  injected = true
                  yield* api.request(
                    "v1/pages/" + f.owner,
                    {
                      properties: {
                        description: { rich_text: rich("Human edit during body verification") },
                      },
                    },
                    { method: "PATCH" },
                  )
                }
                return response
              }),
            ),
          ),
      }
      return yield* editCurrentNative(f.input, "guide-metadata-body-window", "apply").pipe(
        Effect.provideService(Notion, wrapped),
        Effect.result,
      )
    }),
  )
  expect(injected).toBe(true)
  expect(result._tag).toBe("Failure")
  if (result._tag === "Failure") expect(result.failure.code).toBe("CUTOVER_NATIVE_EDIT_INVALID")
  expect(markdownPatches(f)).toHaveLength(2)
  expect(
    f.mutations().filter((call) => {
      const fields = property(property(call.body).properties)
      return (
        call.method === "PATCH" &&
        call.path === "v1/pages/" + f.owner &&
        ("content" in fields ||
          text(property(fields.description).rich_text) === f.input.selected.owner.after.description)
      )
    }),
  ).toHaveLength(0)
  expect(text(property(property(f.pages.get(f.owner)?.properties).description).rich_text)).toBe(
    "Human edit during body verification",
  )
  expect(property(state(f)).name).toBe("attention")
  expect(f.table("records")).toHaveLength(1)
  expect(f.json.size).toBe(f.baselineJson.size + 1)
})

test("the finite input rejects changed author identity and changed captured bytes", async () => {
  const f = await fixture(),
    changed = structuredClone(f.document)
  changed.files[0]!.after.content.frontmatter = changed.files[0]!.after.content.frontmatter.replace(
    "kept-publisher",
    "new-publisher",
  )
  await expect(f.prepare(changed)).rejects.toThrow()
  expect(f.mutations()).toHaveLength(0)
  writeFileSync(f.document.files[0]!.before.body.local_path, "Modified local capture\n")
  await expect(f.prepare()).rejects.toThrow()
  expect(f.mutations()).toHaveLength(0)
})

test("completed resume detects body drift without reopening an operation", async () => {
  const f = await fixture(),
    page = f.input.main.selected.page_id
  await f.run(editCurrentNative(f.input, "guide-completed", "apply"))
  f.rewrite((path, response) =>
    path.startsWith("v1/pages/" + page + "/markdown")
      ? { ...response, markdown: "Human edit after completion\n" }
      : response,
  )
  f.clearCalls()
  const result = await f.run(
    editCurrentNative(f.input, "guide-completed", "resume").pipe(Effect.result),
  )
  expect(result._tag).toBe("Failure")
  expect(f.mutations()).toHaveLength(0)
  expect(f.json).toEqual(f.baselineJson)
  expect(property(state(f)).name).toBe("ready")
})

test("a third existing File prevents any edit and no replacement directory is invented", async () => {
  const f = await fixture(),
    other = f.input.files.find((file) => file.selected.page_id !== f.owner)!
  await f.run(
    Effect.gen(function* () {
      yield* (yield* Notion).request(
        "v1/pages",
        {
          parent: { type: "data_source_id", data_source_id: library.files.data_source_id },
          properties: {
            title: { title: rich("New authored file") },
            "file-id": { rich_text: rich("another-file") },
            path: { rich_text: rich("references/new.md") },
            content: { rich_text: rich(canonicalSharedJson(other.prepared.content)) },
            skill: { relation: [{ id: f.owner }] },
          },
        },
        { method: "POST" },
      )
    }),
  )
  f.clearCalls()
  const result = await f.run(
    editCurrentNative(f.input, "guide-new-file", "apply").pipe(Effect.result),
  )
  expect(result._tag).toBe("Failure")
  expect(f.mutations()).toHaveLength(0)
  expect(f.json).toEqual(f.baselineJson)
  expect(text(property(property(f.pages.get(f.owner)?.properties).description).rich_text)).toBe(
    "Before description",
  )
})

test("an explicitly incomplete Files query cannot certify the complete edit scope", async () => {
  const f = await fixture()
  f.rewrite((path, response) =>
    path.startsWith("v1/data_sources/" + library.files.data_source_id + "/query")
      ? { ...response, request_status: { type: "incomplete" } }
      : response,
  )
  const result = await f.run(
    editCurrentNative(f.input, "guide-incomplete-directory", "apply").pipe(Effect.result),
  )
  expect(result._tag).toBe("Failure")
  expect(f.mutations()).toHaveLength(0)
  expect(f.json).toEqual(f.baselineJson)
  expect(property(state(f)).name).toBe("ready")
})

test("the finite CLI requires explicit absolute inputs, budgets and one operation", () => {
  const args = [
    "--input",
    join(parent, "input.json"),
    "--input-sha256",
    "a".repeat(64),
    "--operation",
    "guide-edit",
    "--mode",
    "dry-run",
    "--store",
    join(parent, "store"),
    "--max-requests",
    "200",
    "--max-bytes",
    "2000000",
    "--timeout",
    "45000",
  ]
  expect(parseNativeEditArguments(args).mode).toBe("dry-run")
  expect(() => parseNativeEditArguments([...args, "--mode", "apply"])).toThrow()
  expect(() =>
    parseNativeEditArguments(args.map((value) => (value === "200" ? "0" : value))),
  ).toThrow()
})
