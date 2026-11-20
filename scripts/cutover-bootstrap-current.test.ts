import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Cause, Effect, Exit } from "effect"
import { fail, property, text } from "../packages/core/src/model.ts"
import { Notion } from "../packages/core/src/notion.ts"
import { fileRef } from "../packages/core/src/ref.ts"
import { sharedRecordFromPage, sharedSkillId } from "../packages/core/src/shared-content.ts"
import { queryCurrentSkillIndex } from "../packages/core/src/shared-current-index.ts"
import { nativeNotionPageId } from "../packages/core/src/shared-native-file-content.ts"
import { compileSharedNativeReferences } from "../packages/core/src/shared-native-references.ts"
import { canonicalSharedJson } from "../packages/core/src/shared-records.ts"
import { LIBRARY_MARKER } from "../packages/core/src/shared-library-model.ts"
import {
  currentWriteFixture,
  id,
  library,
} from "../packages/core/test/shared-current-write-fixture.ts"
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

async function changesFixture() {
  const f = await fixture(1),
    original = f.selected[0]!,
    href = "../reference-target/SKILL.md",
    before = `# Native bootstrap\n\nSee [Reference target](${href}).\n\nKeep \`[example](${href})\` byte exact.\n`,
    targetFrontmatter = "---\nname: Reference target\ndescription: Exact current body\n---\n\n",
    targetBody = "# Reference target\n\nAlready converted.\n",
    targetContent = { kind: "native", mode: "100644", frontmatter: targetFrontmatter }
  const setup = await f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      const source = String(
        property(
          yield* api.request(
            "v1/pages",
            {
              parent: { type: "data_source_id", data_source_id: library.sources.data_source_id },
              properties: {
                title: { title: rich("Retained source") },
                enabled: { checkbox: true },
              },
            },
            { method: "POST" },
          ),
        ).id,
      )
      const targetPage = String(
        property(
          yield* api.request(
            "v1/pages",
            {
              parent: { type: "data_source_id", data_source_id: library.skills.data_source_id },
              properties: {
                title: { title: rich("Reference target") },
                description: { rich_text: rich("Exact current body") },
                kind: { select: { name: "skill" } },
                enabled: { checkbox: true },
                "default-context": { checkbox: false },
                "skill-id": { rich_text: rich("reference-target") },
                "main-file-id": { rich_text: rich("reference-target-main") },
                content: { rich_text: rich(canonicalSharedJson(targetContent)) },
                "current-state": { select: { name: "ready" } },
                operation: { rich_text: [] },
              },
            },
            { method: "POST" },
          ),
        ).id,
      )
      for (const [page, body] of [
        [f.owner, before],
        [targetPage, targetBody],
      ])
        yield* api.request(
          `v1/pages/${page}/markdown`,
          {
            markdown_version: "v2",
            type: "replace_content",
            replace_content: { new_str: body },
          },
          { method: "PATCH" },
        )
      yield* api.request(
        `v1/pages/${f.owner}`,
        {
          properties: { origin: { relation: [{ id: source }] } },
        },
        { method: "PATCH" },
      )
      return { source, targetPage }
    }),
  )
  const targetHref = `https://app.notion.com/p/${setup.targetPage.replaceAll("-", "")}`,
    typedReference = fileRef(sharedSkillId(library.library_id, "reference-target"), "SKILL.md"),
    wanted = before.replace(`](${href}).`, `](${targetHref}).`)
  const originalBytes = original.content_candidate.frontmatter + before
  writeFileSync(original.local_bytes_path, originalBytes)
  writeFileSync(original.native.body.local_path, before)
  const changed = {
    ...original,
    sha256: digest(originalBytes),
    bytes: Buffer.byteLength(originalBytes),
    native: {
      body: { ...original.native.body, sha256: digest(before), bytes: Buffer.byteLength(before) },
    },
  }
  const targetLocal = original.local_bytes_path + ".target",
    targetBodyLocal = original.native.body.local_path + ".target"
  writeFileSync(targetLocal, targetFrontmatter + targetBody)
  writeFileSync(targetBodyLocal, targetBody)
  const targetFile = {
    ...original,
    sha256: digest(targetFrontmatter + targetBody),
    bytes: Buffer.byteLength(targetFrontmatter + targetBody),
    local_bytes_path: targetLocal,
    binding: { kind: "existing", page_id: setup.targetPage, file_id: "reference-target-main" },
    native: {
      body: {
        page_id: setup.targetPage,
        local_path: targetBodyLocal,
        sha256: digest(targetBody),
        bytes: Buffer.byteLength(targetBody),
      },
    },
    content_candidate: targetContent,
  }
  const tree = {
    ...f.tree,
    owners: [
      {
        ...f.tree.owners[0]!,
        relations: { origin: [setup.source], members: [], requires: [] },
        files: [changed],
      },
      {
        ...f.tree.owners[0]!,
        owner_page_id: setup.targetPage,
        skill_id: "reference-target",
        name: "Reference target",
        files: [targetFile],
      },
    ],
  }
  const treeSha = digest(canonicalSharedJson(tree)),
    changes = {
      version: 1,
      kind: "ah513-native-changes",
      tree_sha256: treeSha,
      library_id: library.library_id,
      owners: [
        {
          owner_page_id: f.owner,
          origin: { before: [setup.source], after: [] },
          body_changes: [
            {
              path: changed.path,
              page_id: f.owner,
              file_id: changed.binding.file_id,
              before_body_sha256: digest(before),
              after_body_sha256: digest(wanted),
              replacements: [
                {
                  href,
                  replacement_href: targetHref,
                  typed_reference: typedReference,
                  target_owner_page_id: setup.targetPage,
                  target_file_id: targetFile.binding.file_id,
                  target_path: targetFile.path,
                  occurrences: 1,
                },
              ],
            },
          ],
        },
      ],
    }
  const prepare = (selected: unknown = changes) =>
    f.run(
      prepareBootstrapInput({
        tree,
        tree_sha256: treeSha,
        library,
        owner_page_id: f.owner,
        changes: selected,
        changes_sha256: digest(canonicalSharedJson(selected)),
      }),
    )
  const input = await prepare()
  f.clearCalls()
  return {
    ...f,
    input,
    tree,
    changes,
    prepare,
    before,
    wanted,
    targetHref,
    typedReference,
    ...setup,
  }
}

test("dry-run reads the exact existing native tree and performs zero local or remote mutations", async () => {
  const f = await fixture()
  expect(f.input.input_sha256).toBe(
    digest(
      canonicalSharedJson({
        kind: "ah513-existing-native-bootstrap",
        version: 1,
        tree_sha256: f.input.tree_sha256,
        library,
        owner_page_id: f.owner,
        prepared_input_sha256: f.input.plan.input_sha256,
        files: f.input.files.map((file) => ({
          page_id: file.page_id,
          file_id: file.prepared.file_id,
          path: file.prepared.path,
        })),
      }),
    ),
  )
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

test("one finite changes intent clears only captured Origin and edits only proven native hrefs before ready", async () => {
  const f = await changesFixture()
  expect(f.input.files[0]!.prepared.markdown).toBe(f.wanted)
  expect(nativeNotionPageId(f.targetHref)).toBe(f.targetPage)
  expect((await f.run(inspectBootstrapCurrent(f.input, "bootstrap-changes"))).remote_writes).toBe(0)
  expect(f.mutations()).toHaveLength(0)
  const report = await f.run(bootstrapCurrent(f.input, "bootstrap-changes", "apply"))
  expect(report.authored_body_writes).toBe(1)
  const writes = f.mutations(),
    create = writes.findIndex((call) => call.path === "v1/pages"),
    applying = writes.findIndex(
      (call) =>
        property(property(property(call.body).properties)["current-state"]).select !== undefined,
    ),
    origin = writes.findIndex(
      (call) =>
        call.path === `v1/pages/${f.owner}` &&
        property(property(call.body).properties).origin !== undefined,
    ),
    body = writes.findIndex((call) => call.path === `v1/pages/${f.owner}/markdown`),
    content = writes.findIndex(
      (call) =>
        call.path === `v1/pages/${f.owner}` &&
        property(property(call.body).properties).content !== undefined,
    )
  expect(create).toBeGreaterThanOrEqual(0)
  expect(applying).toBeGreaterThan(create)
  expect(origin).toBeGreaterThan(applying)
  expect(body).toBeGreaterThan(origin)
  expect(content).toBeGreaterThan(body)
  expect(writes.some((call) => call.path === `v1/pages/${f.source}`)).toBe(false)
  expect(f.table("sources").map((row) => row.id)).toEqual([f.source])
  expect(property(property(f.pages.get(f.owner)?.properties).origin).relation).toEqual([])
  expect(f.table("records")).toHaveLength(0)
  expect(f.json.size).toBe(0)
  const compiled = await f.run(
    Effect.gen(function* () {
      const api = yield* Notion,
        raw = yield* api.request(`v1/pages/${f.owner}`),
        target = yield* api.request(`v1/pages/${f.targetPage}`),
        index = yield* queryCurrentSkillIndex(library, f.owner, raw)
      return yield* compileSharedNativeReferences({
        library,
        record: sharedRecordFromPage(
          raw,
          {
            alias: library.library_id,
            title: "",
            role: "content",
            database_id: library.skills.database_id,
            data_source_ids: [library.skills.data_source_id],
            shared_library: library,
          },
          library.skills.data_source_id,
        ),
        bindings: [index.main],
        files: [
          { path: "SKILL.md", page_id: f.owner, markdown: f.wanted, body_sha256: digest(f.wanted) },
        ],
        relations: { members: [], required: [] },
        inventory: {
          skills: {
            data_source_id: library.skills.data_source_id,
            complete: true,
            pages: [raw, target],
          },
          files: { data_source_id: library.files.data_source_id, complete: true, pages: [] },
        },
      })
    }),
  )
  expect(compiled.index?.unresolved).toHaveLength(0)
  expect(compiled.links).toEqual([
    { from: "SKILL.md", href: f.targetHref, target: f.typedReference },
  ])
  f.clearCalls()
  expect(
    (await f.run(bootstrapCurrent(f.input, "bootstrap-changes", "resume"))).authored_body_writes,
  ).toBe(0)
  expect(f.mutations()).toHaveLength(0)
})

test("changes admission rejects duplicate, unproven or differently bound edits without changing authority", async () => {
  const f = await changesFixture()
  const cases = [
    (input: typeof f.changes) => {
      input.owners.push(structuredClone(input.owners[0]!))
    },
    (input: typeof f.changes) => {
      input.owners[0]!.origin.before = [id(990)]
    },
    (input: typeof f.changes) => {
      input.owners[0]!.body_changes[0]!.after_body_sha256 = "0".repeat(64)
    },
    (input: typeof f.changes) => {
      const edits = input.owners[0]!.body_changes[0]!.replacements
      edits.push(structuredClone(edits[0]!))
    },
    (input: typeof f.changes) => {
      input.owners[0]!.body_changes[0]!.replacements[0]!.target_file_id = "other-file"
    },
    (input: typeof f.changes) => {
      input.owners[0]!.body_changes[0]!.replacements[0]!.replacement_href = f.typedReference
    },
    (input: typeof f.changes) => {
      input.owners[0]!.body_changes[0]!.replacements[0]!.typed_reference = "skill://wrong/SKILL.md"
    },
  ]
  for (const change of cases) {
    const input = structuredClone(f.changes)
    change(input)
    await expect(f.prepare(input)).rejects.toThrow()
  }
  expect(f.mutations()).toHaveLength(0)
  expect(f.input.files.every((file) => file.prepared.kind === "native")).toBe(true)
})

test("unknown body outcomes are reconciled by exact readback before any same-input retry", async () => {
  for (const outcome of ["accepted", "absent"] as const) {
    const f = await changesFixture()
    f.failNext({ kind: "native-body", outcome })
    const stopped = await f.run(
      bootstrapCurrent(f.input, "bootstrap-body-unknown", "apply").pipe(Effect.result),
    )
    expect(stopped._tag).toBe("Failure")
    if (stopped._tag === "Failure") expect(stopped.failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
    expect(property(property(f.pages.get(f.owner)?.properties)["current-state"]).select).toEqual({
      name: "applying",
    })
    expect(f.table("records")).toHaveLength(1)
    f.clearCalls()
    const resumed = await f.run(bootstrapCurrent(f.input, "bootstrap-body-unknown", "resume"))
    expect(resumed.authored_body_writes).toBe(outcome === "accepted" ? 0 : 1)
    expect(
      f.calls.filter(
        (call) => call.path === `v1/pages/${f.owner}/markdown` && call.method === "PATCH",
      ),
    ).toHaveLength(outcome === "accepted" ? 0 : 1)
    f.clearCalls()
    await f.run(bootstrapCurrent(f.input, "bootstrap-body-unknown", "resume"))
    expect(f.mutations()).toHaveLength(0)
  }
})

test("unknown Origin clearing is observed within the same intent and never touches its Source page", async () => {
  for (const accepted of [true, false]) {
    const f = await changesFixture()
    const stopped = await f.run(
      Effect.gen(function* () {
        const api = yield* Notion
        let once = false
        return yield* bootstrapCurrent(f.input, "bootstrap-origin-unknown", "apply").pipe(
          Effect.provideService(Notion, {
            ...api,
            request: (path, body, options) => {
              if (
                !once &&
                path === `v1/pages/${f.owner}` &&
                property(property(body).properties).origin !== undefined
              ) {
                once = true
                const lost = Effect.fail(
                  fail("WRITE_OUTCOME_UNKNOWN", "Lost exact Origin acknowledgement.", {
                    phase: "outcome_unknown",
                  }),
                )
                return accepted
                  ? api.request(path, body, options).pipe(Effect.flatMap(() => lost))
                  : lost
              }
              return api.request(path, body, options)
            },
          }),
          Effect.result,
        )
      }),
    )
    expect(stopped._tag).toBe("Failure")
    f.clearCalls()
    await f.run(bootstrapCurrent(f.input, "bootstrap-origin-unknown", "resume"))
    expect(
      f.calls.filter(
        (call) =>
          call.path === `v1/pages/${f.owner}` &&
          property(property(call.body).properties).origin !== undefined,
      ),
    ).toHaveLength(accepted ? 0 : 1)
    expect(f.mutations().some((call) => call.path === `v1/pages/${f.source}`)).toBe(false)
  }
})

test("a third-party body or Origin stops conversion, and an unknown body intent is never cleared over drift", async () => {
  for (const pending of [false, true]) {
    const f = await changesFixture()
    if (pending) {
      f.failNext({ kind: "native-body", outcome: "accepted" })
      await f.run(bootstrapCurrent(f.input, "bootstrap-drift", "apply").pipe(Effect.result))
    }
    await f.run(
      Effect.gen(function* () {
        yield* (yield* Notion).request(
          `v1/pages/${f.owner}/markdown`,
          {
            markdown_version: "v2",
            type: "replace_content",
            replace_content: { new_str: "Author changed the page.\n" },
          },
          { method: "PATCH" },
        )
      }),
    )
    f.clearCalls()
    const stopped = await f.run(
      bootstrapCurrent(f.input, "bootstrap-drift", pending ? "resume" : "apply").pipe(
        Effect.result,
      ),
    )
    expect(stopped._tag).toBe("Failure")
    if (stopped._tag === "Failure") expect(stopped.failure.code).toBe("CUTOVER_NATIVE_CHANGED")
    expect(f.mutations()).toHaveLength(0)
    expect(f.table("records")).toHaveLength(pending ? 1 : 0)
    expect(property(property(f.pages.get(f.owner)?.properties)["current-state"]).select).toEqual(
      pending ? { name: "applying" } : null,
    )
  }
  const f = await changesFixture()
  await f.run(
    Effect.gen(function* () {
      yield* (yield* Notion).request(
        `v1/pages/${f.owner}`,
        {
          properties: { origin: { relation: [{ id: id(991) }] } },
        },
        { method: "PATCH" },
      )
    }),
  )
  f.clearCalls()
  expect(
    (await f.run(bootstrapCurrent(f.input, "bootstrap-origin-drift", "apply").pipe(Effect.result)))
      ._tag,
  ).toBe("Failure")
  expect(f.mutations()).toHaveLength(0)
})

test("exact href targets must be ready before apply and child content prevents body replacement", async () => {
  const f = await changesFixture()
  await f.run(
    Effect.gen(function* () {
      yield* (yield* Notion).request(
        `v1/pages/${f.targetPage}`,
        {
          properties: { "current-state": { select: null }, content: { rich_text: [] } },
        },
        { method: "PATCH" },
      )
    }),
  )
  f.clearCalls()
  expect((await f.run(inspectBootstrapCurrent(f.input, "bootstrap-target"))).remote_writes).toBe(0)
  const unavailable = await f.run(
    bootstrapCurrent(f.input, "bootstrap-target", "apply").pipe(Effect.result),
  )
  expect(unavailable._tag).toBe("Failure")
  expect(f.mutations()).toHaveLength(0)

  const g = await changesFixture()
  g.blocks.set(g.owner, [
    {
      id: id(992),
      object: "block",
      type: "child_page",
      parent: { type: "page_id", page_id: g.owner },
      has_children: false,
      child_page: { title: "Keep child content" },
    },
  ])
  const protectedBody = await g.run(
    bootstrapCurrent(g.input, "bootstrap-child", "apply").pipe(Effect.result),
  )
  expect(protectedBody._tag).toBe("Failure")
  if (protectedBody._tag === "Failure")
    expect(protectedBody.failure.code).toBe("CURRENT_PROJECTION_CHILD_CONTENT")
  expect(
    g.calls.filter((call) => call.method === "PATCH" && call.path.endsWith("/markdown")),
  ).toHaveLength(0)
  expect(g.table("records")).toHaveLength(1)
  expect(property(property(g.pages.get(g.owner)?.properties)["current-state"]).select).toEqual({
    name: "attention",
  })
})

test("an author edit after a settled Origin change is retained and the current intent stops at attention", async () => {
  const f = await changesFixture(),
    edited = "Author changed the page during conversion.\n"
  const stopped = await f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      let once = false
      return yield* bootstrapCurrent(f.input, "bootstrap-settled-drift", "apply").pipe(
        Effect.provideService(Notion, {
          ...api,
          request: (path, body, options) => {
            const response = api.request(path, body, options)
            if (
              !once &&
              path === `v1/pages/${f.owner}` &&
              property(property(body).properties).origin !== undefined
            ) {
              once = true
              return response.pipe(
                Effect.flatMap((saved) =>
                  api
                    .request(
                      `v1/pages/${f.owner}/markdown`,
                      {
                        markdown_version: "v2",
                        type: "replace_content",
                        replace_content: { new_str: edited },
                      },
                      { method: "PATCH" },
                    )
                    .pipe(Effect.as(saved)),
                ),
              )
            }
            return response
          },
        }),
        Effect.result,
      )
    }),
  )
  expect(stopped._tag).toBe("Failure")
  if (stopped._tag === "Failure") expect(stopped.failure.code).toBe("CUTOVER_NATIVE_CHANGED")
  expect(
    f.calls
      .filter((call) => call.path.endsWith("/markdown") && call.method === "PATCH")
      .map((call) => property(property(call.body).replace_content).new_str),
  ).toEqual([edited])
  expect(property(property(f.pages.get(f.owner)?.properties)["current-state"]).select).toEqual({
    name: "attention",
  })
  expect(f.table("records")).toHaveLength(1)
  expect(text(property(property(f.pages.get(f.owner)?.properties).operation).rich_text)).toBe(
    "bootstrap-settled-drift",
  )
})

test("metadata changed during beforeReplace is rechecked before any native body write", async () => {
  const f = await changesFixture()
  let changedDuringBeforeReplace = false
  const stopped = await f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      return yield* bootstrapCurrent(f.input, "bootstrap-metadata-window", "apply").pipe(
        Effect.provideService(Notion, {
          ...api,
          request: (path, body, options) => {
            const response = api.request(path, body, options)
            if (
              !changedDuringBeforeReplace &&
              path === `v1/data_sources/${library.skills.data_source_id}/query` &&
              property(property(property(body).filter).rich_text).equals === "reference-target" &&
              f.calls.some(
                (call) =>
                  call.method === "GET" && call.path.startsWith(`v1/blocks/${f.owner}/children`),
              )
            ) {
              changedDuringBeforeReplace = true
              return api
                .request(
                  `v1/pages/${f.owner}`,
                  {
                    properties: { "main-file-id": { rich_text: rich("third-party-main") } },
                  },
                  { method: "PATCH" },
                )
                .pipe(Effect.flatMap(() => response))
            }
            return response
          },
        }),
        Effect.result,
      )
    }),
  )
  expect(changedDuringBeforeReplace).toBe(true)
  expect(stopped._tag).toBe("Failure")
  if (stopped._tag === "Failure") expect(stopped.failure.code).toBe("CUTOVER_BOOTSTRAP_INVALID")
  expect(
    f.calls.filter((call) => call.method === "PATCH" && call.path.endsWith("/markdown")),
  ).toHaveLength(0)
  expect(text(property(property(f.pages.get(f.owner)?.properties)["main-file-id"]).rich_text)).toBe(
    "third-party-main",
  )
  expect(property(property(f.pages.get(f.owner)?.properties)["current-state"]).select).toEqual({
    name: "attention",
  })
  expect(f.table("records")).toHaveLength(1)
})

test("third-party Origin added during its action body reads is preserved without a clearing PATCH", async () => {
  const f = await changesFixture()
  const otherSource = await f.run(
    Effect.gen(function* () {
      return String(
        property(
          yield* (yield* Notion).request(
            "v1/pages",
            {
              parent: { type: "data_source_id", data_source_id: library.sources.data_source_id },
              properties: { title: { title: rich("Another retained source") } },
            },
            { method: "POST" },
          ),
        ).id,
      )
    }),
  )
  f.clearCalls()
  let injected = false
  const stopped = await f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      return yield* bootstrapCurrent(f.input, "bootstrap-origin-window", "apply").pipe(
        Effect.provideService(Notion, {
          ...api,
          request: (path, body, options) =>
            api.request(path, body, options).pipe(
              Effect.flatMap((response) => {
                if (
                  !injected &&
                  path === `v1/pages/${f.owner}/markdown?markdown_version=v2` &&
                  options?.method !== "PATCH" &&
                  property(
                    property(property(f.pages.get(f.owner)?.properties)["current-state"]).select,
                  ).name === "applying"
                ) {
                  injected = true
                  return api
                    .request(
                      `v1/pages/${f.owner}`,
                      {
                        properties: { origin: { relation: [{ id: otherSource }] } },
                      },
                      { method: "PATCH" },
                    )
                    .pipe(Effect.as(response))
                }
                return Effect.succeed(response)
              }),
            ),
        }),
        Effect.result,
      )
    }),
  )
  expect(injected).toBe(true)
  expect(stopped._tag).toBe("Failure")
  if (stopped._tag === "Failure") expect(stopped.failure.code).toBe("CUTOVER_BOOTSTRAP_INVALID")
  expect(
    f.calls.filter((call) => {
      const relation = property(property(property(call.body).properties).origin).relation
      return (
        call.path === `v1/pages/${f.owner}` &&
        call.method === "PATCH" &&
        Array.isArray(relation) &&
        relation.length === 0
      )
    }),
  ).toHaveLength(0)
  expect(property(property(f.pages.get(f.owner)?.properties).origin).relation).toEqual([
    { id: otherSource },
  ])
  expect(property(property(f.pages.get(f.owner)?.properties)["current-state"]).select).toEqual({
    name: "attention",
  })
  expect(f.table("records")).toHaveLength(1)
  expect(text(property(property(f.pages.get(f.owner)?.properties).operation).rich_text)).toBe(
    "bootstrap-origin-window",
  )
})

test("third-party Content added during its action body read is preserved without a target Content PATCH", async () => {
  const f = await fixture(1),
    third = canonicalSharedJson({
      kind: "native",
      mode: "100644",
      frontmatter: "---\nname: Third-party content\n---\n\n",
    }),
    target = canonicalSharedJson(f.input.files[0]!.prepared.content)
  let injected = false
  const stopped = await f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      return yield* bootstrapCurrent(f.input, "bootstrap-content-window", "apply").pipe(
        Effect.provideService(Notion, {
          ...api,
          request: (path, body, options) =>
            api.request(path, body, options).pipe(
              Effect.flatMap((response) => {
                if (
                  !injected &&
                  path === `v1/pages/${f.owner}/markdown?markdown_version=v2` &&
                  options?.method !== "PATCH" &&
                  property(
                    property(property(f.pages.get(f.owner)?.properties)["current-state"]).select,
                  ).name === "applying"
                ) {
                  injected = true
                  return api
                    .request(
                      `v1/pages/${f.owner}`,
                      {
                        properties: { content: { rich_text: rich(third) } },
                      },
                      { method: "PATCH" },
                    )
                    .pipe(Effect.as(response))
                }
                return Effect.succeed(response)
              }),
            ),
        }),
        Effect.result,
      )
    }),
  )
  expect(injected).toBe(true)
  expect(stopped._tag).toBe("Failure")
  if (stopped._tag === "Failure") expect(stopped.failure.code).toBe("CUTOVER_BOOTSTRAP_INVALID")
  expect(
    f.calls.filter(
      (call) =>
        call.path === `v1/pages/${f.owner}` &&
        call.method === "PATCH" &&
        text(property(property(property(call.body).properties).content).rich_text) === target,
    ),
  ).toHaveLength(0)
  expect(text(property(property(f.pages.get(f.owner)?.properties).content).rich_text)).toBe(third)
  expect(property(property(f.pages.get(f.owner)?.properties)["current-state"]).select).toEqual({
    name: "attention",
  })
  expect(f.table("records")).toHaveLength(1)
  expect(text(property(property(f.pages.get(f.owner)?.properties).operation).rich_text)).toBe(
    "bootstrap-content-window",
  )
})
