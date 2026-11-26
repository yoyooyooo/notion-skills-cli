import { afterAll, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { trashPath } from "../src/local-locks.ts"
import { fail, property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { queryCurrentSkillIndex } from "../src/shared-current-index.ts"
import { createCurrentNotionSkill, updateCurrentNotionSkill } from "../src/shared-current-skill.ts"
import {
  prepareCurrentSkillWrite,
  type CurrentSkillWriteInput,
} from "../src/shared-current-write-input.ts"
import { currentWriteFixture, id, library, testBytes } from "./shared-current-write-fixture.ts"

const parent = mkdtempSync(join(tmpdir(), "ntn-current-skill-management-"))
afterAll(async () => {
  if (process.platform === "darwin") await Effect.runPromise(trashPath(parent))
})
type Fixture = ReturnType<typeof currentWriteFixture>
function input(overrides: Partial<CurrentSkillWriteInput> = {}): CurrentSkillWriteInput {
  return {
    skill_id: "native-managed",
    kind: "skill",
    name: "Native managed",
    description: "Authoring wrapper acceptance",
    files: [
      {
        path: "SKILL.md",
        file_id: "managed-main",
        bytes: testBytes(
          "---\nname: native-managed\ndescription: Authoring wrapper acceptance\n---\n# Main\n",
        ),
        authority: { kind: "native" },
      },
      {
        path: "references/note.md",
        file_id: "managed-note",
        bytes: testBytes("# Supporting note\n"),
        authority: { kind: "native" },
      },
      {
        path: "assets/data.bin",
        file_id: "managed-data",
        bytes: new Uint8Array([0, 255, 4, 1, 128]),
      },
    ],
    ...overrides,
  }
}
function pending(f: Fixture) {
  return [...f.json.keys()].filter((key) => key.startsWith("operations/current-write-pending/"))
}
async function body(f: Fixture, page: string) {
  return property(
    await f.run(Effect.flatMap(Notion, (api) => api.request(`v1/pages/${page}/markdown`))),
  ).markdown
}
async function editBody(f: Fixture, page: string, markdown: string) {
  await f.run(
    Effect.flatMap(Notion, (api) =>
      api.request(
        `v1/pages/${page}/markdown`,
        {
          type: "replace_content",
          replace_content: { new_str: markdown },
          markdown_version: "v2",
        },
        { method: "PATCH" },
      ),
    ),
  )
}
async function create(f: Fixture) {
  const plan = await f.run(prepareCurrentSkillWrite(input()))
  const result = createdResult(await f.run(createCurrentNotionSkill(library, { plan })))
  return { plan, result }
}
function createdResult(result: Effect.Success<ReturnType<typeof createCurrentNotionSkill>>) {
  if (!("status" in result) || result.status !== "created")
    throw new Error("Expected an applied creation.")
  return result
}

test("create verifies the whole native/resource tree and an equal repeat writes nothing", async () => {
  const f = currentWriteFixture(parent),
    plan = await f.run(prepareCurrentSkillWrite(input()))
  const dry = await f.run(createCurrentNotionSkill(library, { plan, dry_run: true }))
  expect(dry).toMatchObject({ dry_run: true })
  expect(f.mutations()).toHaveLength(0)
  const created = createdResult(await f.run(createCurrentNotionSkill(library, { plan })))
  expect(created).toMatchObject({
    action: "create",
    status: "created",
    state: "ready",
    skill_id: "native-managed",
  })
  expect(pending(f)).toEqual([])
  const before = await f.run(queryCurrentSkillIndex(library, created.page_id))
  expect(before.files.map((file) => file.path).sort()).toEqual([
    "assets/data.bin",
    "references/note.md",
  ])
  expect(before.main.content.kind).toBe("native")
  expect(before.files.find((file) => file.path === "assets/data.bin")?.content.kind).toBe(
    "resource",
  )
  f.clearCalls()
  const repeated = await f.run(createCurrentNotionSkill(library, { plan }))
  expect(repeated).toMatchObject({
    action: "create",
    status: "unchanged",
    remote_writes: 0,
    page_id: created.page_id,
  })
  expect(f.mutations()).toHaveLength(0)
  const after = await f.run(queryCurrentSkillIndex(library, created.page_id))
  expect(after).toEqual(before)
})

test("native create freezes authored bytes while sending equivalent soft wraps and checking paragraph readback", async () => {
  const f = currentWriteFixture(parent)
  const header =
    "---\r\nname: native-managed\r\ndescription: Authoring wrapper acceptance\r\n---\r\n"
  const markdown =
    "# Main\r\n\r\nRead `list --view VIEW_ID --library\r\nENTRY` and [release\r\nchecks](https://example.com).\r\n\r\n1. Run\r\n   now.\r\n\r\n   ```sh\r\n   printf 'keep\\n'\r\n   ```\r\n\r\n   Keep\r\n   this paragraph.\r\n"
  const wire =
    "# Main\n\nRead `list --view VIEW_ID --library ENTRY` and [release checks](https://example.com).\n\n1. Run now.\n\n   ```sh\n   printf 'keep\\n'\n   ```\n\n   Keep this paragraph.\n"
  const bytes = testBytes(header + markdown)
  const plan = await f.run(
    prepareCurrentSkillWrite(
      input({
        files: [{ path: "SKILL.md", bytes, mode: "100755", authority: { kind: "native" } }],
      }),
    ),
  )
  expect(plan.files[0]).toMatchObject({
    kind: "native",
    markdown,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    content: { frontmatter: header, mode: "100755" },
  })
  const frozen = structuredClone(plan)
  f.rewrite((path, response) => {
    if (!path.includes("/markdown") || typeof response.markdown !== "string") return response
    return {
      ...response,
      markdown: response.markdown
        .replace(
          "`list --view VIEW_ID --library ENTRY`",
          "<code>list --view VIEW_ID --library ENTRY</code>",
        )
        .replace("\n   ```sh\n", "\n   ```bash\n")
        .replace("   Keep this paragraph.", "   <p>\n   Keep this paragraph.\n   </p>"),
    }
  })
  const created = createdResult(await f.run(createCurrentNotionSkill(library, { plan })))
  expect(created).toMatchObject({
    state: "ready",
    native: { verified: 1, normalized_paths: ["SKILL.md"] },
  })
  const writes = f.mutations().filter((call) => call.path.includes("/markdown"))
  expect(writes).toHaveLength(1)
  expect(writes[0]?.body).toEqual({
    markdown_version: "v2",
    type: "replace_content",
    replace_content: { new_str: wire },
  })
  expect(plan).toEqual(frozen)
  f.clearCalls()
  expect(await f.run(createCurrentNotionSkill(library, { plan }))).toMatchObject({
    status: "unchanged",
    remote_writes: 0,
  })
  expect(f.mutations()).toEqual([])
})

test.each([
  {
    difference: "a literal br inside code",
    markdown: "Read `list --library\nENTRY`.\n",
    wire: "`list --library ENTRY`",
    observed: "<code>list --library<br>ENTRY</code>",
  },
  {
    difference: "an unexpected filename link",
    markdown: "A new Skill requires root SKILL.md.\n",
    wire: "SKILL.md",
    observed: "[SKILL.md](http://SKILL.md)",
  },
])(
  "native create keeps $difference unfinished after full readback",
  async ({ markdown, wire, observed }) => {
    const f = currentWriteFixture(parent)
    const plan = await f.run(
      prepareCurrentSkillWrite(
        input({
          files: [
            {
              path: "SKILL.md",
              bytes: testBytes(markdown),
              authority: { kind: "native" },
            },
          ],
        }),
      ),
    )
    f.rewrite((path, response) =>
      path.includes("/markdown") && typeof response.markdown === "string"
        ? {
            ...response,
            markdown: response.markdown.replace(wire, observed),
          }
        : response,
    )
    await expect(f.run(createCurrentNotionSkill(library, { plan }))).rejects.toMatchObject({
      code: "WRITE_OUTCOME_UNKNOWN",
      details: { cause_code: "CURRENT_NATIVE_ROUNDTRIP" },
    })
    expect(pending(f)).toHaveLength(1)
    expect(f.mutations().filter((call) => call.path.includes("/markdown"))).toHaveLength(1)
  },
)

for (const difference of ["metadata", "support-body", "file-count"] as const)
  test(`create refuses an existing different ${difference} without replacement writes`, async () => {
    const f = currentWriteFixture(parent),
      { plan, result } = await create(f)
    const index = await f.run(queryCurrentSkillIndex(library, result.page_id))
    let candidate = plan
    if (difference === "metadata")
      candidate = await f.run(
        prepareCurrentSkillWrite(input({ description: "A different author intention" })),
      )
    if (difference === "support-body")
      await editBody(
        f,
        index.files.find((file) => file.path === "references/note.md")!.page_id,
        "# Human changed the supporting file\n",
      )
    if (difference === "file-count")
      candidate = await f.run(
        prepareCurrentSkillWrite(
          input({ files: input().files.filter((file) => file.path !== "assets/data.bin") }),
        ),
      )
    const pages = structuredClone(f.pages)
    f.clearCalls()
    await expect(
      f.run(createCurrentNotionSkill(library, { plan: candidate })),
    ).rejects.toMatchObject({ code: "CURRENT_SKILL_EXISTS" })
    expect(f.mutations()).toHaveLength(0)
    expect(f.pages).toEqual(pages)
    expect(pending(f)).toEqual([])
  })

function automaticLinkWriter(loseCorrection: boolean, dropSkillLinks = false) {
  const f = currentWriteFixture(parent)
  const blockId = id(9999)
  let rejectCorrection = false
  let owner: string | undefined, block: Record<string, unknown> | undefined
  const rich = (content: string, link: { url: string } | null) => ({
    type: "text",
    text: { content, link },
    plain_text: content,
    href: link?.url ?? null,
    annotations: {
      bold: false,
      italic: false,
      strikethrough: false,
      underline: false,
      code: false,
      color: "default",
    },
  })
  const run: Fixture["run"] = (effect) =>
    f.run(
      Effect.flatMap(Notion, (api) => {
        const request: Notion["Service"]["request"] = (path, body, options) =>
          Effect.gen(function* () {
            const method = options?.method ?? "GET"
            if (path === `v1/blocks/${blockId}`) {
              f.calls.push({ path, body: structuredClone(body), method })
              if (!block)
                return yield* Effect.fail(fail("NOT_FOUND", "The exact authored block is absent."))
              if (method === "PATCH") {
                if (rejectCorrection) {
                  rejectCorrection = false
                  return yield* Effect.fail(
                    fail("NOTION_REQUEST_FAILED", "Invalid URL for link.", {
                      phase: "definitive_rejection",
                      http_status: 400,
                    }),
                  )
                }
                const spans = property(property(body).paragraph).rich_text
                if (!Array.isArray(spans))
                  return yield* Effect.fail(
                    fail("TEST_UNEXPECTED", "Expected one complete rich_text replacement."),
                  )
                block = {
                  ...block,
                  paragraph: {
                    rich_text: spans.map((span) => {
                      const text = property(property(span).text)
                      return {
                        ...property(span),
                        plain_text: text.content,
                        href: property(text.link).url ?? null,
                      }
                    }),
                  },
                }
                if (loseCorrection) {
                  loseCorrection = false
                  return yield* Effect.fail(
                    fail(
                      "WRITE_OUTCOME_UNKNOWN",
                      "The correction was accepted but its response was lost.",
                    ),
                  )
                }
              }
              return structuredClone(block)
            }
            const response = property(yield* api.request(path, body, options))
            const match = /^v1\/pages\/([^/]+)\/markdown$/u.exec(path.split("?")[0]!)
            if (match && method === "PATCH") {
              owner = match[1]!
              const source = String(property(property(body).replace_content).new_str)
              block = {
                object: "block",
                id: blockId,
                type: "paragraph",
                has_children: false,
                in_trash: false,
                parent: { type: "page_id", page_id: owner },
                paragraph: {
                  rich_text: dropSkillLinks
                    ? [rich(source.replace(/\[([^\]]+)\]\(skill:\/\/[^)]+\)/gu, "$1"), null)]
                    : source
                        .split(/(SKILL\.md|options\.storage)/gu)
                        .filter(Boolean)
                        .map((part) =>
                          rich(
                            part,
                            /^(?:SKILL\.md|options\.storage)$/u.test(part)
                              ? { url: new URL("http://" + part).href }
                              : null,
                          ),
                        ),
                },
              }
            }
            if (owner && path.startsWith(`v1/blocks/${owner}/children`) && block)
              return {
                object: "list",
                results: [structuredClone(block)],
                has_more: false,
                next_cursor: null,
              }
            if (match?.[1] === owner && block) {
              const spans = property(block.paragraph).rich_text
              if (!Array.isArray(spans)) throw new Error("Expected fixture rich_text")
              return {
                ...response,
                markdown: spans
                  .map((span) => {
                    const value = property(property(span).text),
                      link = property(value.link)
                    return typeof link.url === "string"
                      ? `[${value.content}](${link.url})`
                      : String(value.content)
                  })
                  .join(""),
              }
            }
            return response
          })
        return effect.pipe(Effect.provideService(Notion, { ...api, request }))
      }),
    )
  return {
    ...f,
    run,
    blockId,
    rejectCorrectionOnce: () => {
      rejectCorrection = true
    },
  }
}

test.each([false, true])(
  "native authoring corrects plain links through the same intent, including accepted response loss: %s",
  async (loseCorrection) => {
    const f = automaticLinkWriter(loseCorrection)
    const markdown = "A new Skill requires root SKILL.md. Source options.storage are rejected."
    const plan = await f.run(
      prepareCurrentSkillWrite(
        input({
          files: [{ path: "SKILL.md", bytes: testBytes(markdown), authority: { kind: "native" } }],
        }),
      ),
    )
    const frozen = structuredClone(plan)
    let operation: string | undefined
    if (loseCorrection) {
      await expect(f.run(createCurrentNotionSkill(library, { plan }))).rejects.toMatchObject({
        code: "WRITE_OUTCOME_UNKNOWN",
      })
      expect(pending(f)).toHaveLength(1)
      const value = property(property(f.json.get(pending(f)[0]!)).intent).operation_id
      if (typeof value !== "string") throw new Error("Expected the original pending operation")
      operation = value
    }
    const created = createdResult(await f.run(createCurrentNotionSkill(library, { plan })))
    expect(created).toMatchObject({ state: "ready", native: { verified: 1 } })
    if (operation !== undefined) expect(created.operation_id).toBe(operation)
    expect(pending(f)).toEqual([])
    expect(await body(f, created.page_id)).toBe(markdown)
    expect(f.mutations().filter((call) => call.path.includes("/markdown"))).toHaveLength(1)
    const corrections = f.mutations().filter((call) => call.path === `v1/blocks/${f.blockId}`)
    expect(corrections).toHaveLength(1)
    expect(property(property(corrections[0]!.body).paragraph).rich_text).toMatchObject([
      { text: { content: markdown, link: null } },
    ])
    expect(plan).toEqual(frozen)
    f.clearCalls()
    expect(await f.run(createCurrentNotionSkill(library, { plan }))).toMatchObject({
      status: "unchanged",
      remote_writes: 0,
    })
    expect(f.mutations()).toEqual([])
    const updated = "Updated: " + markdown
    expect(
      await f.run(
        updateCurrentNotionSkill(library, {
          target: "native-managed",
          main: { bytes: testBytes(updated) },
        }),
      ),
    ).toMatchObject({ state: "ready", page_id: created.page_id })
    expect(await body(f, created.page_id)).toBe(updated)
    expect(f.mutations().filter((call) => call.path === `v1/blocks/${f.blockId}`)).toHaveLength(1)
    expect(pending(f)).toEqual([])
  },
)

test.each(
  [
    ["skill://cycle-two", "skill://cycle-two/entrypoint.md/.."],
    [
      "skill://cycle-two?library=00000000-0000-4000-8000-000000000113",
      "skill://cycle-two/entrypoint.md/..?library=00000000-0000-4000-8000-000000000113",
    ],
    [
      "skill://cycle-two/SKILL.md?library=00000000-0000-4000-8000-000000000113",
      "skill://cycle-two/entrypoint.md/../SKILL.md?library=00000000-0000-4000-8000-000000000113",
    ],
    [
      "skill://cycle-two/references/config?library=00000000-0000-4000-8000-000000000113&snapshot=s_" +
        "a".repeat(64),
      "skill://cycle-two/entrypoint.md/../references/config?library=00000000-0000-4000-8000-000000000113&snapshot=s_" +
        "a".repeat(64),
    ],
    [
      "skill://cycle-two/entrypoint.md/../entrypoint.md/..",
      "skill://cycle-two/entrypoint.md/../entrypoint.md/..",
    ],
  ].flatMap(([href, wire]) =>
    [false, true].map((loseCorrection) => ({ href: href!, wire: wire!, loseCorrection })),
  ),
)(
  "native authoring restores $href in the same intent, including response loss: $loseCorrection",
  async ({ href, wire, loseCorrection }) => {
    const f = automaticLinkWriter(loseCorrection, true)
    const markdown = `[Two](${href})`
    const plan = await f.run(
      prepareCurrentSkillWrite(
        input({
          files: [{ path: "SKILL.md", bytes: testBytes(markdown), authority: { kind: "native" } }],
        }),
      ),
    )
    const frozen = structuredClone(plan)
    let operation: string | undefined
    if (loseCorrection) {
      await expect(f.run(createCurrentNotionSkill(library, { plan }))).rejects.toMatchObject({
        code: "WRITE_OUTCOME_UNKNOWN",
      })
      expect(pending(f)).toHaveLength(1)
      const value = property(property(f.json.get(pending(f)[0]!)).intent).operation_id
      if (typeof value !== "string") throw new Error("Expected the original pending operation")
      operation = value
    }
    const created = createdResult(await f.run(createCurrentNotionSkill(library, { plan })))
    expect(created).toMatchObject({ state: "ready", native: { verified: 1 } })
    if (operation !== undefined) expect(created.operation_id).toBe(operation)
    expect(pending(f)).toEqual([])
    expect(await body(f, created.page_id)).toBe(`[Two](${wire})`)
    const markdownWrites = f.mutations().filter((call) => call.path.includes("/markdown"))
    expect(markdownWrites).toHaveLength(1)
    expect(property(markdownWrites[0]!.body).replace_content).toEqual({ new_str: markdown })
    const corrections = f.mutations().filter((call) => call.path === `v1/blocks/${f.blockId}`)
    expect(corrections).toHaveLength(1)
    expect(property(property(corrections[0]!.body).paragraph).rich_text).toMatchObject([
      { text: { content: "Two", link: { url: wire } } },
    ])
    expect(plan).toEqual(frozen)
    f.clearCalls()
    expect(await f.run(createCurrentNotionSkill(library, { plan }))).toMatchObject({
      status: "unchanged",
      remote_writes: 0,
    })
    expect(f.mutations()).toEqual([])
  },
)

test("a definitive native URL rejection resumes the original input, owner and operation", async () => {
  const f = automaticLinkWriter(false, true)
  const markdown = "[Run](skill://router)"
  const plan = await f.run(
    prepareCurrentSkillWrite(
      input({
        files: [{ path: "SKILL.md", bytes: testBytes(markdown), authority: { kind: "native" } }],
      }),
    ),
  )
  const frozen = structuredClone(plan)
  f.rejectCorrectionOnce()
  await expect(f.run(createCurrentNotionSkill(library, { plan }))).rejects.toMatchObject({
    code: "NOTION_REQUEST_FAILED",
  })
  expect(pending(f)).toHaveLength(1)
  const original = property(f.json.get(pending(f)[0]!))
  const created = createdResult(await f.run(createCurrentNotionSkill(library, { plan })))
  expect(created).toMatchObject({
    state: "ready",
    page_id: original.owner_page_id,
    operation_id: property(original.intent).operation_id,
    native: { verified: 1 },
  })
  expect(plan).toEqual(frozen)
  expect(pending(f)).toEqual([])
  expect(f.table("skills")).toHaveLength(1)
  expect(f.mutations().filter((call) => call.path.includes("/markdown"))).toHaveLength(1)
  expect(f.mutations().filter((call) => call.path === `v1/blocks/${f.blockId}`)).toHaveLength(2)
  expect(await body(f, created.page_id)).toBe("[Run](skill://router/entrypoint.md/..)")
})

for (const kind of ["skill-create", "native-body"] as const)
  test(`create automatically resumes the same input after an accepted ${kind} response is lost`, async () => {
    const f = currentWriteFixture(parent),
      plan = await f.run(prepareCurrentSkillWrite(input()))
    f.failNext({ kind, outcome: "accepted" })
    await expect(f.run(createCurrentNotionSkill(library, { plan }))).rejects.toMatchObject({
      code: "WRITE_OUTCOME_UNKNOWN",
    })
    expect(pending(f)).toHaveLength(1)
    const original = property(property(f.json.get(pending(f)[0]!)).intent).operation_id
    const resumed = await f.run(createCurrentNotionSkill(library, { plan }))
    expect(resumed).toMatchObject({
      action: "create",
      status: "created",
      state: "ready",
      operation_id: original,
    })
    expect(f.table("skills")).toHaveLength(1)
    expect(pending(f)).toEqual([])
    f.clearCalls()
    expect(await f.run(createCurrentNotionSkill(library, { plan }))).toMatchObject({
      status: "unchanged",
    })
    expect(f.mutations()).toHaveLength(0)
  })

test("create preserves an unfinished creation and refuses changed input before any new write", async () => {
  const f = currentWriteFixture(parent),
    plan = await f.run(prepareCurrentSkillWrite(input()))
  f.failNext({ kind: "native-body", outcome: "accepted" })
  await expect(f.run(createCurrentNotionSkill(library, { plan }))).rejects.toMatchObject({
    code: "WRITE_OUTCOME_UNKNOWN",
  })
  const changed = await f.run(
    prepareCurrentSkillWrite(input({ description: "Changed while the original is pending" })),
  )
  f.clearCalls()
  await expect(f.run(createCurrentNotionSkill(library, { plan: changed }))).rejects.toMatchObject({
    code: "CURRENT_OPERATION_PENDING",
  })
  expect(f.mutations()).toHaveLength(0)
  expect(pending(f)).toHaveLength(1)
  await f.run(createCurrentNotionSkill(library, { plan }))
  expect(pending(f)).toEqual([])
})

test("update changes selected main and metadata while preserving unselected author body and exact resource; repeat writes nothing", async () => {
  const f = currentWriteFixture(parent),
    { result } = await create(f)
  const before = await f.run(queryCurrentSkillIndex(library, result.page_id))
  const note = before.files.find((file) => file.path === "references/note.md")!
  const data = before.files.find((file) => file.path === "assets/data.bin")!
  const authored = "# Independently authored supporting note\n\nKeep **this** text and `code`.\n"
  await editBody(f, note.page_id, authored)
  const selected = {
    target: "native-managed",
    main: { bytes: testBytes("# Updated main\n") },
    metadata: { description: "Updated metadata" },
  }
  f.clearCalls()
  const updated = await f.run(updateCurrentNotionSkill(library, selected))
  expect(updated).toMatchObject({ action: "update", state: "ready", page_id: result.page_id })
  const after = await f.run(queryCurrentSkillIndex(library, result.page_id))
  expect(after.description).toBe("Updated metadata")
  expect(after.main.file_id).toBe(before.main.file_id)
  expect(after.files.find((file) => file.path === "references/note.md")?.page_id).toBe(note.page_id)
  expect(after.files.find((file) => file.path === "assets/data.bin")).toEqual(data)
  expect(await body(f, note.page_id)).toBe(authored)
  expect(await body(f, result.page_id)).toBe("# Updated main\n")
  expect(f.mutations().some((call) => call.path === `v1/pages/${note.page_id}/markdown`)).toBe(
    false,
  )
  expect(f.mutations().some((call) => call.path === `v1/pages/${data.page_id}`)).toBe(false)
  expect(pending(f)).toEqual([])
  f.clearCalls()
  const repeated = await f.run(updateCurrentNotionSkill(library, selected))
  expect(repeated).toMatchObject({ status: "unchanged" })
  expect(f.mutations()).toHaveLength(0)
  expect(await body(f, note.page_id)).toBe(authored)
})

test("metadata-only update preserves every current body and File identity", async () => {
  const f = currentWriteFixture(parent),
    { result } = await create(f)
  const before = await f.run(queryCurrentSkillIndex(library, result.page_id))
  await editBody(f, result.page_id, "# Current author main\n\nUnselected content survives.\n")
  f.clearCalls()
  const updated = await f.run(
    updateCurrentNotionSkill(library, {
      target: result.page_id,
      metadata: { name: "Renamed native skill", enabled: false, default_context: true },
    }),
  )
  expect(updated.state).toBe("ready")
  const after = await f.run(queryCurrentSkillIndex(library, result.page_id))
  expect(after).toMatchObject({
    name: "Renamed native skill",
    enabled: false,
    default_context: true,
  })
  expect(after.main.file_id).toBe(before.main.file_id)
  expect(after.main.content).toEqual(before.main.content)
  expect(after.files).toEqual(before.files)
  expect(await body(f, result.page_id)).toBe(
    "# Current author main\n\nUnselected content survives.\n",
  )
  expect(
    f
      .mutations()
      .every((call) => !call.path.includes("/markdown") && !call.path.includes("/blocks/")),
  ).toBe(true)
})

test("update resumes the original selected input, rejects a changed pending input, and preserves the rest", async () => {
  const f = currentWriteFixture(parent),
    { result } = await create(f)
  const original = {
    target: result.page_id,
    main: { bytes: testBytes("# Original pending update\n") },
  }
  f.failNext({ kind: "native-body", outcome: "absent" })
  await expect(f.run(updateCurrentNotionSkill(library, original))).rejects.toMatchObject({
    code: "WRITE_OUTCOME_UNKNOWN",
  })
  expect(pending(f)).toHaveLength(1)
  const intent = property(property(f.json.get(pending(f)[0]!)).intent)
  expect(property(intent.skill_action).kind).toBe("update")
  f.clearCalls()
  await expect(
    f.run(
      updateCurrentNotionSkill(library, {
        ...original,
        main: { bytes: testBytes("# Different retry\n") },
      }),
    ),
  ).rejects.toMatchObject({ code: "CURRENT_OPERATION_PENDING" })
  expect(f.mutations()).toHaveLength(0)
  expect(pending(f)).toHaveLength(1)
  const resumed = await f.run(updateCurrentNotionSkill(library, original))
  expect(resumed).toMatchObject({
    action: "update",
    state: "ready",
    operation_id: intent.operation_id,
  })
  expect(await body(f, result.page_id)).toBe("# Original pending update\n")
  expect(pending(f)).toEqual([])
  f.clearCalls()
  expect(await f.run(updateCurrentNotionSkill(library, original))).toMatchObject({
    status: "unchanged",
  })
  expect(f.mutations()).toHaveLength(0)
})
