import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Cause, Effect, Exit } from "effect"
import { fail, property, text } from "../packages/core/src/model.ts"
import { Notion } from "../packages/core/src/notion.ts"
import { queryCurrentSkillIndex } from "../packages/core/src/shared-current-index.ts"
import { canonicalSharedJson } from "../packages/core/src/shared-records.ts"
import { LIBRARY_MARKER } from "../packages/core/src/shared-library-model.ts"
import { currentWriteFixture, library } from "../packages/core/test/shared-current-write-fixture.ts"
import {
  bootstrapCurrent,
  inspectBootstrapCurrent,
  prepareBootstrapInput,
} from "./cutover-bootstrap-current.ts"

const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")
const rich = (content: string) => [{ type: "text", text: { content } }]
const parent = mkdtempSync(join(tmpdir(), "ah513-bootstrap-"))
async function fixture(files = 3) {
  const f = currentWriteFixture(parent),
    directory = mkdtempSync(join(parent, "input-"))
  const ownerPage = await f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      return yield* api.request(
        "v1/pages",
        {
          parent: { type: "data_source_id", data_source_id: library.skills.data_source_id },
          properties: {
            title: { title: rich("Native bootstrap") },
            description: { rich_text: rich("Exact current body") },
            kind: { select: { name: "skill" } },
            enabled: { checkbox: true },
            "default-context": { checkbox: false },
            "skill-id": { rich_text: rich("native-bootstrap") },
            "main-file-id": { rich_text: rich("native-main") },
            content: { rich_text: [] },
            "current-state": { select: null },
            operation: { rich_text: [] },
          },
        },
        { method: "POST" },
      )
    }),
  )
  const owner = String(property(ownerPage).id),
    selected = []
  for (let i = 0; i < files; i++) {
    const path = i === 0 ? "SKILL.md" : `references/guide-${i}.md`,
      file_id = i === 0 ? "native-main" : `native-guide-${i}`
    const page =
      i === 0
        ? owner
        : String(
            property(
              await f.run(
                Effect.gen(function* () {
                  return yield* (yield* Notion).request(
                    "v1/pages",
                    {
                      parent: {
                        type: "data_source_id",
                        data_source_id: library.files.data_source_id,
                      },
                      properties: {
                        title: { title: rich(path) },
                        "file-id": { rich_text: rich(file_id) },
                        path: { rich_text: rich(path) },
                        content: { rich_text: [] },
                        skill: { relation: [{ id: owner }] },
                      },
                    },
                    { method: "POST" },
                  )
                }),
              ),
            ).id,
          )
    const body =
      i === 0
        ? "# Native bootstrap\n\nKeep this current author body.\n"
        : `# Guide ${i}\n\nExact current text.\n`
    const frontmatter =
      i === 0 ? "---\nname: Native bootstrap\ndescription: Exact current body\n---\n\n" : ""
    await f.run(
      Effect.gen(function* () {
        yield* (yield* Notion).request(
          `v1/pages/${page}/markdown`,
          { markdown_version: "v2", type: "replace_content", replace_content: { new_str: body } },
          { method: "PATCH" },
        )
      }),
    )
    const local = join(directory, `${i}.bytes`),
      localBody = join(directory, `${i}.body`),
      bytes = Buffer.from(frontmatter + body)
    writeFileSync(local, bytes)
    writeFileSync(localBody, body)
    selected.push({
      path,
      authority: "native",
      sha256: digest(bytes),
      bytes: bytes.length,
      mode: "100644",
      local_bytes_path: local,
      binding: { kind: "existing", page_id: page, file_id },
      native: {
        body: {
          page_id: page,
          local_path: localBody,
          sha256: digest(body),
          bytes: Buffer.byteLength(body),
        },
      },
      content_candidate: { kind: "native", mode: "100644", frontmatter },
    })
  }
  const tree = {
    version: 1,
    composition_complete: true,
    library_id: library.library_id,
    owners: [
      {
        owner_page_id: owner,
        skill_id: "native-bootstrap",
        name: "Native bootstrap",
        description: "Exact current body",
        kind: "skill",
        entrypoint: "SKILL.md",
        enabled: true,
        default_context: false,
        relations: { origin: [], members: [], requires: [] },
        files: selected,
      },
    ],
  }
  const input = await f.run(
    prepareBootstrapInput({
      tree,
      tree_sha256: digest(canonicalSharedJson(tree)),
      library,
      owner_page_id: owner,
    }),
  )
  f.clearCalls()
  return { ...f, input, tree, owner, selected }
}

test("dry-run reads the exact existing native tree and performs zero local or remote mutations", async () => {
  const f = await fixture()
  const report = await f.run(inspectBootstrapCurrent(f.input, "bootstrap-1"))
  expect(report.files).toHaveLength(3)
  expect(report.remote_writes).toBe(0)
  expect(f.mutations()).toHaveLength(0)
  expect(f.json.size).toBe(0)
  expect(property(property(f.pages.get(f.owner)?.properties)["current-state"]).select).toBeNull()
})
test("an explicit additive descriptor is verified before the library marker is published", async () => {
  const f = await fixture(1),
    previous = structuredClone(library)
  delete previous.skills.property_ids.Content
  delete previous.skills.property_ids["Current State"]
  delete previous.skills.property_ids.Operation
  delete previous.files.property_ids.Content
  f.rewrite((path, response) =>
    path === `v1/databases/${library.skills.database_id}`
      ? { ...response, description: [{ plain_text: LIBRARY_MARKER + JSON.stringify(previous) }] }
      : response,
  )
  expect((await f.run(inspectBootstrapCurrent(f.input, "bootstrap-additive"))).registration).toBe(
    "additive_descriptor_pending",
  )
  expect(f.mutations()).toHaveLength(0)
  expect((await f.run(bootstrapCurrent(f.input, "bootstrap-additive", "apply"))).registration).toBe(
    "additive_descriptor_pending",
  )
  expect(
    f.calls.some(
      (call) =>
        call.method === "PATCH" &&
        (call.path.includes("/databases/") || call.path.includes("/data_sources/")),
    ),
  ).toBe(false)
})
test("one finite bootstrap preserves all physical identities and body bytes, then publishes a valid current index", async () => {
  for (const count of [1, 3]) {
    const f = await fixture(count),
      originalPages = [...f.pages.keys()]
    const report = await f.run(bootstrapCurrent(f.input, "bootstrap-2", "apply"))
    expect(report.state).toBe("ready")
    expect(report.authored_body_writes).toBe(0)
    expect(
      f.calls.filter((call) => call.method === "PATCH" && call.path.includes("/markdown")),
    ).toHaveLength(0)
    expect(f.table("skills").map((row) => row.id)).toEqual([f.owner])
    expect(f.table("files").map((row) => row.id)).toEqual(
      originalPages.filter((page) => page !== f.owner),
    )
    const index = await f.run(queryCurrentSkillIndex(library, f.owner))
    expect(index.state.state).toBe("ready")
    expect(index.files).toHaveLength(count - 1)
    expect(f.table("records")).toHaveLength(0)
    expect(f.json.size).toBe(0)
    f.clearCalls()
    expect((await f.run(bootstrapCurrent(f.input, "bootstrap-2", "resume"))).state).toBe("ready")
    expect(f.mutations()).toHaveLength(0)
  }
})
test("budget exhaustion during an exact Content PATCH keeps applying and resumes only remaining work", async () => {
  const f = await fixture()
  const stopped = await f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      let once = false
      const limited: Notion["Service"] = {
        ...api,
        request: (path, body, options) => {
          if (
            !once &&
            options?.method === "PATCH" &&
            path === `v1/pages/${f.selected[1]!.binding.page_id}` &&
            property(body).properties !== undefined
          ) {
            once = true
            return Effect.fail(
              fail("REQUEST_BUDGET_EXHAUSTED", "Fixture budget exhausted before dispatch.", {
                phase: "input_rejected",
              }),
            )
          }
          return api.request(path, body, options)
        },
      }
      return yield* bootstrapCurrent(f.input, "bootstrap-budget", "apply").pipe(
        Effect.provideService(Notion, limited),
        Effect.result,
      )
    }),
  )
  expect(stopped._tag).toBe("Failure")
  if (stopped._tag === "Failure") expect(stopped.failure.code).toBe("REQUEST_BUDGET_EXHAUSTED")
  expect(property(property(f.pages.get(f.owner)?.properties)["current-state"]).select).toEqual({
    name: "applying",
  })
  expect(f.table("records")).toHaveLength(1)
  expect(text(property(property(f.pages.get(f.owner)?.properties).content).rich_text)).not.toBe("")
  f.clearCalls()
  expect((await f.run(bootstrapCurrent(f.input, "bootstrap-budget", "resume"))).state).toBe("ready")
  expect(
    f.calls.filter(
      (call) =>
        call.path === `v1/pages/${f.owner}` &&
        property(property(call.body).properties).content !== undefined,
    ),
  ).toHaveLength(0)
})
test("an accepted or invisible unknown intent CREATE is never replayed from absence", async () => {
  for (const accepted of [true, false]) {
    const f = await fixture(1)
    const stopped = await f.run(
      Effect.gen(function* () {
        const api = yield* Notion
        let once = false
        const losing: Notion["Service"] = {
          ...api,
          request: (path, body, options) => {
            if (
              !once &&
              path === "v1/pages" &&
              property(property(body).parent).data_source_id === library.records.data_source_id
            ) {
              once = true
              const lost = Effect.fail(
                fail("WRITE_OUTCOME_UNKNOWN", "Fixture lost CREATE response.", {
                  phase: "outcome_unknown",
                }),
              )
              return accepted
                ? api.request(path, body, options).pipe(Effect.flatMap(() => lost))
                : lost
            }
            return api.request(path, body, options)
          },
        }
        return yield* bootstrapCurrent(f.input, "bootstrap-create", "apply").pipe(
          Effect.provideService(Notion, losing),
          Effect.result,
        )
      }),
    )
    expect(stopped._tag).toBe("Failure")
    expect(property(property(f.pages.get(f.owner)?.properties)["current-state"]).select).toBeNull()
    f.clearCalls()
    const resumed = await f.run(
      bootstrapCurrent(f.input, "bootstrap-create", "resume").pipe(Effect.result),
    )
    if (accepted) expect(resumed._tag).toBe("Success")
    else {
      expect(resumed._tag).toBe("Failure")
      if (resumed._tag === "Failure")
        expect(resumed.failure.code).toBe("CURRENT_OPERATION_UNRESOLVED")
    }
    expect(
      f.calls.filter((call) => call.path === "v1/pages" && call.method === "POST"),
    ).toHaveLength(0)
  }
})
test("interruption preserves the exact applying intent for explicit same-input resume", async () => {
  const f = await fixture(1)
  const stopped = await f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      const interrupting: Notion["Service"] = {
        ...api,
        request: (path, body, options) =>
          path === `v1/pages/${f.owner}` &&
          options?.method === "PATCH" &&
          property(property(body).properties).content !== undefined
            ? Effect.interrupt
            : api.request(path, body, options),
      }
      return yield* bootstrapCurrent(f.input, "bootstrap-interrupted", "apply").pipe(
        Effect.provideService(Notion, interrupting),
        Effect.exit,
      )
    }),
  )
  expect(Exit.isFailure(stopped) && Cause.hasInterruptsOnly(stopped.cause)).toBe(true)
  expect(property(property(f.pages.get(f.owner)?.properties)["current-state"]).select).toEqual({
    name: "applying",
  })
  expect(f.table("records")).toHaveLength(1)
  expect((await f.run(bootstrapCurrent(f.input, "bootstrap-interrupted", "resume"))).state).toBe(
    "ready",
  )
})
test("changed author text and extra physical Files fail before any bootstrap mutation", async () => {
  const f = await fixture()
  await f.run(
    Effect.gen(function* () {
      yield* (yield* Notion).request(
        `v1/pages/${f.owner}/markdown`,
        { type: "replace_content", replace_content: { new_str: "Author edited after capture.\n" } },
        { method: "PATCH" },
      )
    }),
  )
  f.clearCalls()
  const changed = await f.run(
    bootstrapCurrent(f.input, "bootstrap-body", "apply").pipe(Effect.result),
  )
  expect(changed._tag).toBe("Failure")
  if (changed._tag === "Failure") expect(changed.failure.code).toBe("CUTOVER_NATIVE_CHANGED")
  expect(f.mutations()).toHaveLength(0)

  const g = await fixture(1)
  await g.run(
    Effect.gen(function* () {
      yield* (yield* Notion).request(
        "v1/pages",
        {
          parent: { type: "data_source_id", data_source_id: library.files.data_source_id },
          properties: {
            title: { title: rich("extra") },
            "file-id": { rich_text: rich("extra") },
            path: { rich_text: rich("extra.md") },
            content: { rich_text: [] },
            skill: { relation: [{ id: g.owner }] },
          },
        },
        { method: "POST" },
      )
    }),
  )
  g.clearCalls()
  expect(
    (await g.run(bootstrapCurrent(g.input, "bootstrap-extra", "apply").pipe(Effect.result)))._tag,
  ).toBe("Failure")
  expect(g.mutations()).toHaveLength(0)
})
test("preparation preserves actual current-reference failures and rejects unsupported authority", async () => {
  const f = await fixture(1),
    selected = f.selected[0]!
  const body = "[Missing](missing.md)\n",
    bytes = selected.content_candidate.frontmatter + body
  writeFileSync(selected.local_bytes_path, bytes)
  writeFileSync(selected.native.body.local_path, body)
  selected.sha256 = digest(bytes)
  selected.bytes = Buffer.byteLength(bytes)
  selected.native.body.sha256 = digest(body)
  selected.native.body.bytes = Buffer.byteLength(body)
  const result = await f.run(
    prepareBootstrapInput({
      tree: f.tree,
      tree_sha256: digest(canonicalSharedJson(f.tree)),
      library,
      owner_page_id: f.owner,
    }).pipe(Effect.result),
  )
  expect(result._tag).toBe("Failure")
  if (result._tag === "Failure") expect(result.failure.code).toBe("SHARED_REFERENCE_BROKEN")
  selected.authority = "source"
  expect(
    (
      await f.run(
        prepareBootstrapInput({
          tree: f.tree,
          tree_sha256: digest(canonicalSharedJson(f.tree)),
          library,
          owner_page_id: f.owner,
        }).pipe(Effect.result),
      )
    )._tag,
  ).toBe("Failure")
  expect(f.mutations()).toHaveLength(0)
})
