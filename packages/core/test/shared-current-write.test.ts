import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { trashPath } from "../src/local-locks.ts"
import { exportPortable, snapshotPortable } from "../src/export.ts"
import { fail, property, text } from "../src/model.ts"
import { queryCurrentSkillIndex } from "../src/shared-current-index.ts"
import { loadCurrentSharedResourceContent } from "../src/shared-current-resource.ts"
import {
  currentSharedSourceRevision,
  validateCurrentSharedSourceContent,
} from "../src/shared-current-source.ts"
import {
  authorizeCoordinatedSkillWrite,
  inspectCoordinatedSkillWrite,
  prepareCoordinatedSkillWrite,
  writeCoordinatedSkill,
  inspectCurrentSkillWrite,
  prepareCurrentSkillWrite,
  writeCurrentSkill,
  type CurrentSkillWriteInput,
} from "../src/shared-current-write.ts"
import { withCurrentOperation } from "../src/shared-current-operation.ts"
import { Notion } from "../src/notion.ts"
import { openSharedSnapshot } from "../src/shared-snapshot.ts"
import { sha256 } from "../src/store.ts"
import { currentWriteFixture, id, library, testBytes } from "./shared-current-write-fixture.ts"

const parent = mkdtempSync(join(tmpdir(), "ntn-current-write-"))
afterAll(async () => {
  if (process.platform === "darwin") await Effect.runPromise(trashPath(parent))
})
const main = testBytes(
  "---\r\nname: Example\r\ndescription: Current writer integration\r\n---\r\n# Example\r\n\r\nRead [guide](references/guide.md).\r\n",
)
const guide = testBytes("# Guide\n\nComplete child document.\n")
function input(
  files: CurrentSkillWriteInput["files"] = [
    { path: "SKILL.md", bytes: main },
    { path: "references/guide.md", bytes: guide },
  ],
): CurrentSkillWriteInput {
  return {
    skill_id: "example",
    kind: "skill",
    name: "Example",
    description: "Current writer integration",
    files,
  }
}

const sourcePage = id(90)

test("same-root table replacement cannot hide an unfinished owner behind a new pending address", async () => {
  const f = currentWriteFixture(parent)
  const plan = await f.run(prepareCurrentSkillWrite(input()))
  f.failNext({ kind: "skill-create", outcome: "absent" })
  await expect(f.run(writeCurrentSkill(library, { plan, operation_id: "binding-frozen" }))).rejects.toBeDefined()
  const retained = structuredClone([...f.json.entries()].filter(([key]) => key.startsWith("operations/current-write-pending/")))
  expect(retained).toHaveLength(1)
  const intent = { operation_id: "binding-frozen", input_sha256: plan.input_sha256, owner: { kind: "skill" as const, id: "example" } }
  for (const changed of [
    { ...library, skills: { ...library.skills, data_source_id: id(8000) } },
    { ...library, files: { ...library.files, database_id: id(8001) } },
    { ...library, sources: { ...library.sources, property_ids: { ...library.sources.property_ids, Contributions: "replaced" } } },
  ]) {
    f.clearCalls()
    await expect(f.run(withCurrentOperation(changed, {
      intent, ownerPageId: null, mode: "resume",
      run: () => Effect.die("A changed Library must not enter the writer"),
      verify: () => Effect.void,
    }))).rejects.toMatchObject({ code: "CURRENT_OPERATION_PENDING" })
    expect(f.calls).toEqual([])
    expect([...f.json.entries()].filter(([key]) => key.startsWith("operations/current-write-pending/"))).toEqual(retained)
  }
})
const sourceFiles = [
  { path: "SKILL.md", file_id: "source-main", bytes: testBytes("# Source main\n") },
  {
    path: "references/source.md",
    file_id: "source-child",
    bytes: testBytes("# Source child\n"),
  },
] satisfies CurrentSkillWriteInput["files"]
async function sourceInput(
  f: ReturnType<typeof currentWriteFixture>,
  files: CurrentSkillWriteInput["files"] = sourceFiles,
) {
  const manifest = await f.run(
    Effect.forEach(files, (file) =>
      sha256(file.bytes).pipe(
        Effect.map((hash) => ({
          path: `upstream/${file.path}`,
          sha256: hash,
          bytes: file.bytes.byteLength,
          mode: file.mode ?? "100644",
        })),
      ),
    ),
  )
  const content = validateCurrentSharedSourceContent({
    version: 1,
    plan: {
      version: 1,
      kind: "composition",
      mounts: [],
      base: {
        kind: "http",
        manifest: { version: 1, files: manifest },
        locations: manifest.map((file) => ({
          sha256: file.sha256,
          url: `https://raw.githubusercontent.com/example/skills/${"a".repeat(40)}/${file.path}`,
        })),
      },
    },
  })
  const revision = await f.run(currentSharedSourceRevision(content)),
    fields = library.sources.property_ids,
    rich = (key: string, value: string) => ({
      id: key,
      type: "rich_text",
      rich_text: [{ type: "text", text: { content: value } }],
      has_more: false,
    })
  f.pages.set(sourcePage, {
    object: "page",
    id: sourcePage,
    parent: {
      type: "data_source_id",
      data_source_id: library.sources.data_source_id,
      database_id: library.sources.database_id,
    },
    properties: {
      [fields["Source ID"]!]: rich(fields["Source ID"]!, "provider"),
      [fields.Content!]: rich(fields.Content!, JSON.stringify(content)),
      [fields["Last Revision"]!]: rich(fields["Last Revision"]!, revision),
      [fields.Enabled!]: { id: fields.Enabled, type: "checkbox", checkbox: true },
      [fields.Status!]: { id: fields.Status, type: "select", select: { name: "ready" } },
      [fields.Operation!]: rich(fields.Operation!, ""),
    },
  })
  return input([
    ...files.map((file): CurrentSkillWriteInput["files"][number] => ({
      ...file,
      authority: {
        kind: "source",
        source_id: "provider",
        revision,
        source_path: `upstream/${file.path}`,
      },
    })),
    { path: "references/local.md", file_id: "local-child", bytes: testBytes("# Local note\n") },
  ])
}

async function coordinatedFixture() {
  const f = currentWriteFixture(parent),
    original = await sourceInput(f)
  const prepared = await f.run(
    prepareCurrentSkillWrite({
      ...original,
      files: original.files.map((file) =>
        file.path === "references/local.md"
          ? { ...file, bytes: testBytes("# Local note"), authority: { kind: "native" as const } }
          : file,
      ),
    }),
  )
  const written = await f.run(
    writeCurrentSkill(library, { plan: prepared, operation_id: "seed-coordination" }),
  )
  const index = await f.run(queryCurrentSkillIndex(library, written.page_id))
  const files: Parameters<typeof prepareCoordinatedSkillWrite>[0]["files"][number][] = []
  const manifest = []
  let revision = ""
  for (const file of original.files) {
    if (file.authority?.kind !== "source") continue
    if (file.file_id === undefined) throw new Error("Expected stable Source file")
    files.push({
      kind: "write",
      file: { ...file, file_id: file.file_id, authority: file.authority },
    })
    revision = file.authority.revision
    manifest.push({
      path: file.authority.source_path,
      sha256: await f.run(sha256(file.bytes)),
      bytes: file.bytes.byteLength,
      mode: file.mode ?? ("100644" as const),
    })
  }
  const local = index.files.find((file) => file.file_id === "local-child")!
  const { file_id, page_id, skill_page_id, path, content } = local
  files.push({ kind: "preserve", binding: { file_id, page_id, skill_page_id, path, content } })
  const input = {
    skill_id: "example",
    kind: "skill" as const,
    source: { source_id: "provider", revision },
    consumption_paths: original.files.map((file) => file.path),
    consumption_sources: [{ source_id: "provider", revision }],
    create: { name: "New defaults only", description: "Do not replace existing metadata." },
    files,
  }
  const plan = await f.run(prepareCoordinatedSkillWrite(input))
  const source = { ...input.source, page_id: sourcePage, manifest }
  const intent = {
    operation_id: "parent-guard",
    owner: { kind: "source" as const, id: "provider" },
    input_sha256: "b".repeat(64),
    source_input: {
      kind: "declaration" as const,
      configuration_sha256: "c".repeat(64),
      resolved_commit: "a".repeat(40),
      affected_skill_ids: ["example"],
      retirements: [],
    },
  }
  const childOperation =
    "source-target-" + (await f.run(sha256(JSON.stringify([intent.operation_id, plan.skill_id]))))
  f.clearCalls()
  return { f, input, plan, source, intent, childOperation, index, local }
}

describe("complete current Skill writer", () => {
  test("changed bytes after preparation are rejected before opening a current intent", async () => {
    const f = currentWriteFixture(parent),
      plan = await f.run(prepareCurrentSkillWrite(input()))
    const file = plan.files[0]!
    file.bytes[0] = (file.bytes[0] ?? 0) ^ 1
    await expect(
      f.run(writeCurrentSkill(library, { plan, operation_id: "changed-input" })),
    ).rejects.toBeDefined()
    expect(f.mutations()).toEqual([])
    expect(f.pages.size).toBe(0)
  })
  test("creates one current tree from exact resource bytes without generated reading pages", async () => {
    const f = currentWriteFixture(parent)
    const plan = await f.run(prepareCurrentSkillWrite(input()))
    const result = await f.run(writeCurrentSkill(library, { plan, operation_id: "write-first" }))
    expect(result).toMatchObject({ status: "applied", state: "ready", files: 2 })
    expect(f.table("skills")).toHaveLength(1)
    expect(f.table("files")).toHaveLength(1)
    expect(f.table("records")).toHaveLength(2)
    const index = await f.run(queryCurrentSkillIndex(library, result.page_id))
    expect(index.state).toEqual({ state: "ready" })
    expect([index.main.path, ...index.files.map((file) => file.path)]).toEqual([
      "SKILL.md",
      "references/guide.md",
    ])
    for (const file of [index.main, ...index.files]) {
      if (file.content.kind !== "resource") throw new Error("Expected resource authority")
      const original = await f.run(
        loadCurrentSharedResourceContent(library, {
          owner: { kind: "skill", page_id: result.page_id },
          content: file.content,
        }),
      )
      expect(original.bytes).toEqual(file.path === "SKILL.md" ? main : guide)
      expect(f.blocks.get(file.page_id) ?? []).toEqual([])
    }
    expect(
      [...f.json.keys()].filter((key) => key.startsWith("operations/current-write-pending/")),
    ).toEqual([])
    const snapshot = await f.run(
      openSharedSnapshot({
        library,
        target: result.page_id,
        scope: "a".repeat(64),
        startedAt: Date.now(),
        forceFull: true,
      }),
    )
    const portable = await f.run(snapshotPortable(snapshot))
    const directory = join(f.root, "exported")
    await f.run(exportPortable(portable, { output: directory, format: "directory" }))
    expect(new Uint8Array(readFileSync(join(directory, "SKILL.md")))).toEqual(main)
    expect(new Uint8Array(readFileSync(join(directory, "references/guide.md")))).toEqual(guide)
  })
  test("a new operation with unchanged complete input does no semantic writes", async () => {
    const f = currentWriteFixture(parent),
      plan = await f.run(prepareCurrentSkillWrite(input()))
    await f.run(writeCurrentSkill(library, { plan, operation_id: "initial" }))
    const pages = f.pages.size
    f.clearCalls()
    expect(
      await f.run(writeCurrentSkill(library, { plan, operation_id: "another-operation" })),
    ).toMatchObject({ status: "unchanged", state: "ready" })
    expect(f.mutations()).toEqual([])
    expect(f.pages.size).toBe(pages)
    await expect(
      f.run(
        writeCurrentSkill(library, { plan, operation_id: "another-operation", mode: "resume" }),
      ),
    ).rejects.toMatchObject({ code: "CURRENT_OPERATION_NOT_FOUND" })
    expect(f.mutations()).toEqual([])
  })
  test.each([
    ["main to resource", "SKILL.md", (file) => ({ ...file, authority: { kind: "resource" } })],
    [
      "main to native",
      "SKILL.md",
      (file) => ({ ...file, bytes: testBytes("# Source main"), authority: { kind: "native" } }),
    ],
    [
      "support to resource",
      "references/source.md",
      (file) => ({ ...file, authority: { kind: "resource" } }),
    ],
    [
      "support to native",
      "references/source.md",
      (file) => ({ ...file, bytes: testBytes("# Source child"), authority: { kind: "native" } }),
    ],
    ["omitted support", "references/source.md", () => undefined],
    ["new main identity", "SKILL.md", (file) => ({ ...file, file_id: "replacement-main" })],
    [
      "new support identity",
      "references/source.md",
      (file) => ({ ...file, file_id: "replacement-child" }),
    ],
    [
      "renamed support",
      "references/source.md",
      (file) => ({ ...file, path: "references/renamed.md" }),
    ],
    [
      "different Source",
      "references/source.md",
      (file) => {
        if (file.authority?.kind !== "source") throw new Error("Expected Source input")
        return { ...file, authority: { ...file.authority, source_id: "other-provider" } }
      },
    ],
    [
      "different source path",
      "references/source.md",
      (file) => {
        if (file.authority?.kind !== "source") throw new Error("Expected Source input")
        return { ...file, authority: { ...file.authority, source_path: "upstream/other.md" } }
      },
    ],
  ] satisfies readonly [
    string,
    string,
    (
      file: CurrentSkillWriteInput["files"][number],
    ) => CurrentSkillWriteInput["files"][number] | undefined,
  ][])("inspect and apply reject Source %s before any mutation", async (_name, path, change) => {
    const f = currentWriteFixture(parent),
      original = await sourceInput(f),
      initial = await f.run(prepareCurrentSkillWrite(original))
    const written = await f.run(
      writeCurrentSkill(library, { plan: initial, operation_id: "initial-source" }),
    )
    expect(property(property(f.pages.get(written.page_id)?.properties).origin).relation).toEqual([
      { id: sourcePage },
    ])
    const plan = await f.run(
      prepareCurrentSkillWrite({
        ...original,
        files: original.files.flatMap((file) => {
          const next = file.path === path ? change(file) : file
          return next === undefined ? [] : [next]
        }),
      }),
    )
    const before = structuredClone({ pages: f.pages, blocks: f.blocks, json: f.json })
    for (const run of [
      inspectCurrentSkillWrite(library, plan).pipe(Effect.map(() => undefined)),
      writeCurrentSkill(library, { plan, operation_id: "source-guard" }).pipe(
        Effect.map(() => undefined),
      ),
    ]) {
      f.clearCalls()
      await expect(f.run(run)).rejects.toMatchObject({
        code: "CURRENT_SOURCE_MANAGEMENT_REQUIRED",
        details: { skill_id: "example", path, source_id: "provider" },
      })
      expect(f.mutations()).toEqual([])
      expect(f.calls.map((call) => call.path.split("?")[0])).toEqual([
        `v1/data_sources/${library.skills.data_source_id}/query`,
        `v1/data_sources/${library.files.data_source_id}/query`,
      ])
      expect(f.downloads).toEqual([])
      expect({ pages: f.pages, blocks: f.blocks, json: f.json }).toEqual(before)
      expect(
        [...f.json.keys()].filter((key) => key.startsWith("operations/current-write-pending/")),
      ).toEqual([])
    }
  })
  test("the same complete Source bindings remain a zero-write no-op", async () => {
    const f = currentWriteFixture(parent),
      original = await sourceInput(f),
      plan = await f.run(prepareCurrentSkillWrite(original))
    await f.run(writeCurrentSkill(library, { plan, operation_id: "initial-source" }))
    f.clearCalls()
    await f.run(inspectCurrentSkillWrite(library, plan))
    expect(
      await f.run(writeCurrentSkill(library, { plan, operation_id: "same-source" })),
    ).toMatchObject({ status: "unchanged", state: "ready" })
    expect(f.mutations()).toEqual([])
  })
  test("retained Source files permit an independent Notion resource update", async () => {
    const f = currentWriteFixture(parent),
      original = await sourceInput(f),
      initial = await f.run(prepareCurrentSkillWrite(original))
    const written = await f.run(
      writeCurrentSkill(library, { plan: initial, operation_id: "initial-source" }),
    )
    const before = await f.run(queryCurrentSkillIndex(library, written.page_id)),
      sourceBefore = structuredClone(f.pages.get(sourcePage)),
      replacement = testBytes("# Local note\n\nUpdated in Notion.\n")
    const plan = await f.run(
      prepareCurrentSkillWrite({
        ...original,
        files: original.files.map((file) =>
          file.path === "references/local.md" ? { ...file, bytes: replacement } : file,
        ),
      }),
    )
    await f.run(inspectCurrentSkillWrite(library, plan))
    expect(
      await f.run(writeCurrentSkill(library, { plan, operation_id: "local-update" })),
    ).toMatchObject({ status: "applied", state: "ready" })
    const after = await f.run(queryCurrentSkillIndex(library, written.page_id))
    for (const old of [before.main, ...before.files].filter(
      (file) => file.content.kind === "source",
    ))
      expect(
        [after.main, ...after.files].find((file) => file.file_id === old.file_id),
      ).toMatchObject({
        file_id: old.file_id,
        page_id: old.page_id,
        path: old.path,
        content: old.content,
      })
    expect(f.pages.get(sourcePage)).toEqual(sourceBefore)
    expect(property(property(f.pages.get(written.page_id)?.properties).origin).relation).toEqual([
      { id: sourcePage },
    ])
    const local = after.files.find((file) => file.path === "references/local.md")
    if (local?.content.kind !== "resource") throw new Error("Expected current Notion resource")
    expect(
      (
        await f.run(
          loadCurrentSharedResourceContent(library, {
            owner: { kind: "skill", page_id: written.page_id },
            content: local.content,
          }),
        )
      ).bytes,
    ).toEqual(replacement)
  })
  test("the same Source binding accepts a current revision only with its exact manifest", async () => {
    const f = currentWriteFixture(parent),
      original = await sourceInput(f),
      initial = await f.run(prepareCurrentSkillWrite(original))
    const written = await f.run(
      writeCurrentSkill(library, { plan: initial, operation_id: "initial-source" }),
    )
    const updated = await sourceInput(
      f,
      sourceFiles.map((file) =>
        file.path === "references/source.md"
          ? {
              ...file,
              bytes: testBytes("# Changed upstream\n\nNew current bytes.\n"),
              mode: "100755",
            }
          : file,
      ),
    )
    const plan = await f.run(prepareCurrentSkillWrite(updated))
    await f.run(inspectCurrentSkillWrite(library, plan))
    expect(
      await f.run(writeCurrentSkill(library, { plan, operation_id: "selected-source-update" })),
    ).toMatchObject({ status: "applied", state: "ready" })
    const after = await f.run(queryCurrentSkillIndex(library, written.page_id))
    for (const file of plan.files.filter((file) => file.kind === "source"))
      expect(
        [after.main, ...after.files].find((row) => row.file_id === file.file_id)?.content,
      ).toEqual(file.content)
    const invalid = await f.run(
      prepareCurrentSkillWrite({
        ...updated,
        files: updated.files.map((file) =>
          file.path === "references/source.md"
            ? { ...file, bytes: testBytes("Not upstream\n") }
            : file,
        ),
      }),
    )
    f.clearCalls()
    await expect(
      f.run(writeCurrentSkill(library, { plan: invalid, operation_id: "wrong-source-bytes" })),
    ).rejects.toMatchObject({ code: "CURRENT_WRITE_CONFLICT" })
    expect(f.mutations()).toEqual([])
    expect(
      [...f.json.keys()].filter((key) => key.startsWith("operations/current-write-pending/")),
    ).toEqual([])
  })
  test("complete replacement removes old Files and unreferenced originals", async () => {
    const f = currentWriteFixture(parent),
      first = await f.run(prepareCurrentSkillWrite(input()))
    const written = await f.run(writeCurrentSkill(library, { plan: first, operation_id: "first" }))
    const oldFile = f.table("files")[0]!,
      oldResources = f.table("records").map((row) => String(row.id))
    const replacement = input([
      { path: "SKILL.md", bytes: testBytes("# New\n[run](scripts/run.ts)\n") },
      { path: "scripts/run.ts", bytes: testBytes("export const current = true\n"), mode: "100755" },
    ])
    const next = await f.run(prepareCurrentSkillWrite(replacement))
    expect(
      await f.run(writeCurrentSkill(library, { plan: next, operation_id: "replace" })),
    ).toMatchObject({ page_id: written.page_id, files: 2, status: "applied" })
    expect(f.pages.get(String(oldFile.id))?.in_trash).toBe(true)
    for (const page of oldResources) expect(f.pages.get(page)?.in_trash).toBe(true)
    const index = await f.run(queryCurrentSkillIndex(library, written.page_id))
    expect(index.files.map((file) => file.path)).toEqual(["scripts/run.ts"])
    expect(f.table("records")).toHaveLength(2)
    for (const file of [index.main, ...index.files]) {
      if (file.content.kind !== "resource") throw new Error("Expected resource")
      const result = await f.run(
        loadCurrentSharedResourceContent(library, {
          owner: { kind: "skill", page_id: index.page_id },
          content: file.content,
        }),
      )
      expect(result.bytes).toEqual(replacement.files.find((item) => item.path === file.path)!.bytes)
    }
  })
  test("omitted enabled and default-context fields preserve the current Notion choices", async () => {
    const f = currentWriteFixture(parent)
    const initial = await f.run(
      prepareCurrentSkillWrite({ ...input(), enabled: false, default_context: true }),
    )
    const first = await f.run(
      writeCurrentSkill(library, { plan: initial, operation_id: "explicit-flags" }),
    )
    const next = await f.run(
      prepareCurrentSkillWrite(
        input([{ path: "SKILL.md", bytes: testBytes("# Changed while disabled\n") }]),
      ),
    )
    await f.run(writeCurrentSkill(library, { plan: next, operation_id: "preserve-flags" }))
    const index = await f.run(queryCurrentSkillIndex(library, first.page_id))
    expect(index.enabled).toBe(false)
    expect(index.default_context).toBe(true)
    expect(index.state).toEqual({ state: "ready" })
    expect(index.files).toHaveLength(0)
  })
  test("stable File IDs survive a path swap and a rename without creating replacement rows", async () => {
    const f = currentWriteFixture(parent)
    const files = [
      { path: "SKILL.md", bytes: testBytes("# Main\n") },
      { path: "one.md", file_id: "file-one", bytes: testBytes("# One\n") },
      { path: "two.md", file_id: "file-two", bytes: testBytes("# Two\n") },
    ]
    const first = await f.run(prepareCurrentSkillWrite(input(files)))
    const result = await f.run(
      writeCurrentSkill(library, { plan: first, operation_id: "before-swap" }),
    )
    const before = await f.run(queryCurrentSkillIndex(library, result.page_id))
    const swapped = await f.run(
      prepareCurrentSkillWrite(
        input([files[0]!, { ...files[1]!, path: "two.md" }, { ...files[2]!, path: "one.md" }]),
      ),
    )
    await f.run(writeCurrentSkill(library, { plan: swapped, operation_id: "swap" }))
    const after = await f.run(queryCurrentSkillIndex(library, result.page_id))
    for (const file of before.files) {
      const current = after.files.find((item) => item.file_id === file.file_id)!
      expect(current.page_id).toBe(file.page_id)
      expect(current.path).toBe(file.path === "one.md" ? "two.md" : "one.md")
    }
    const renamed = await f.run(
      prepareCurrentSkillWrite(
        input([
          files[0]!,
          { ...files[1]!, path: "guides/renamed.md" },
          { ...files[2]!, path: "one.md" },
        ]),
      ),
    )
    await f.run(writeCurrentSkill(library, { plan: renamed, operation_id: "rename" }))
    const final = await f.run(queryCurrentSkillIndex(library, result.page_id))
    expect(final.files.find((file) => file.file_id === "file-one")?.page_id).toBe(
      before.files.find((file) => file.file_id === "file-one")?.page_id,
    )
    expect(final.files.map((file) => file.path).sort()).toEqual(["guides/renamed.md", "one.md"])
    expect(f.table("files", false)).toHaveLength(2)
    expect(f.table("records")).toHaveLength(3)
  })
  test.each(["file-create"] as const)(
    "accepted unknown %s resumes from current state without repeating the mutation",
    async (kind) => {
      const f = currentWriteFixture(parent),
        plan = await f.run(prepareCurrentSkillWrite(input()))
      f.failNext({ kind, outcome: "accepted" })
      await expect(
        f.run(writeCurrentSkill(library, { plan, operation_id: "interrupted" })),
      ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
      const original = f.calls.findLast(
        (call) =>
          call.path === "v1/pages" &&
          property(property(call.body).parent).data_source_id === library.files.data_source_id,
      )!
      const matching = () =>
        f.calls.filter(
          (call) =>
            call.path === original.path &&
            call.method === original.method &&
            JSON.stringify(call.body) === JSON.stringify(original.body),
        )
      expect(matching()).toHaveLength(1)
      const result = await f.run(
        writeCurrentSkill(library, { plan, operation_id: "interrupted", mode: "resume" }),
      )
      expect(result.state).toBe("ready")
      expect(matching()).toHaveLength(1)
      expect(f.table("skills")).toHaveLength(1)
      expect(f.table("files")).toHaveLength(1)
      expect(f.table("records")).toHaveLength(2)
    },
  )
  test.each(["retire-file", "retire-resource"] as const)(
    "accepted unknown %s is recovered even after it disappears from active queries",
    async (kind) => {
      const f = currentWriteFixture(parent),
        initial = await f.run(prepareCurrentSkillWrite(input()))
      await f.run(writeCurrentSkill(library, { plan: initial, operation_id: "initial" }))
      const plan = await f.run(
        prepareCurrentSkillWrite(
          input([{ path: "SKILL.md", bytes: testBytes("# Replacement\n") }]),
        ),
      )
      f.failNext({ kind, outcome: "accepted" })
      await expect(
        f.run(writeCurrentSkill(library, { plan, operation_id: "cleanup" })),
      ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
      const original = f.calls.findLast(
        (call) => call.method === "PATCH" && property(call.body).in_trash === true,
      )!
      expect(f.pages.get(original.path.replace("v1/pages/", ""))?.in_trash).toBe(true)
      await f.run(writeCurrentSkill(library, { plan, operation_id: "cleanup", mode: "resume" }))
      expect(
        f.calls.filter(
          (call) => call.path === original.path && property(call.body).in_trash === true,
        ),
      ).toHaveLength(1)
      expect(f.table("files")).toHaveLength(0)
      expect(f.table("records")).toHaveLength(1)
      expect(
        [...f.json.keys()].filter((key) => key.startsWith("operations/current-write-pending/")),
      ).toEqual([])
    },
  )
  test("incomplete pagination and a foreign owner fail before any semantic write", async () => {
    const f = currentWriteFixture(parent),
      plan = await f.run(prepareCurrentSkillWrite(input()))
    f.rewrite((path, row) =>
      path.includes(library.skills.data_source_id)
        ? { ...row, has_more: true, next_cursor: null }
        : row,
    )
    await expect(
      f.run(writeCurrentSkill(library, { plan, operation_id: "bad-page" })),
    ).rejects.toMatchObject({ code: "CURRENT_WRITE_CONFLICT" })
    expect(f.mutations()).toEqual([])
    f.rewrite()
    const result = await f.run(writeCurrentSkill(library, { plan, operation_id: "initial" }))
    const fields = property(f.pages.get(result.page_id)?.properties)
    property(fields["current-state"]).select = { name: "applying" }
    property(fields.operation).rich_text = [
      { type: "text", text: { content: "foreign-operation" } },
    ]
    f.clearCalls()
    await expect(
      f.run(writeCurrentSkill(library, { plan, operation_id: "wrong-owner" })),
    ).rejects.toMatchObject({ code: "CURRENT_OPERATION_CONFLICT" })
    expect(f.mutations()).toEqual([])
  })
  test("a generated-body append failure cannot block exact resource consumption", async () => {
    const f = currentWriteFixture(parent),
      plan = await f.run(prepareCurrentSkillWrite(input()))
    f.failNext({ kind: "append", outcome: "partial" })
    const result = await f.run(
      writeCurrentSkill(library, { plan, operation_id: "body-independent" }),
    )
    expect(result.state).toBe("ready")
    expect(
      f.calls.filter((call) => call.path.includes("/children") && call.method === "PATCH"),
    ).toEqual([])
    const snapshot = await f.run(
      openSharedSnapshot({
        library,
        target: result.page_id,
        scope: "c".repeat(64),
        startedAt: Date.now(),
        forceFull: true,
      }),
    )
    const portable = await f.run(snapshotPortable(snapshot))
    expect(portable.files.find((file) => file.path === "SKILL.md")?.bytes).toEqual(main)
    expect(portable.files.find((file) => file.path === "references/guide.md")?.bytes).toEqual(guide)
    expect(
      [...f.json.keys()].filter((key) => key.startsWith("operations/current-write-pending/")),
    ).toEqual([])
  })
  test("accepted unknown attachment Record resumes the same uploaded original without projection writes", async () => {
    const f = currentWriteFixture(parent),
      root = { path: "SKILL.md", bytes: testBytes("# Assets\n") }
    const initial = await f.run(prepareCurrentSkillWrite(input([root])))
    await f.run(writeCurrentSkill(library, { plan: initial, operation_id: "initial" }))
    const asset = { path: "assets/font.otf", bytes: new Uint8Array([0, 255, 17, 5, 0, 1, 13, 10]) }
    const plan = await f.run(prepareCurrentSkillWrite(input([root, asset])))
    f.failNext({ kind: "resource-create", outcome: "accepted" })
    await expect(
      f.run(writeCurrentSkill(library, { plan, operation_id: "attachment-resume" })),
    ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
    expect(f.uploads.size).toBe(1)
    const result = await f.run(
      writeCurrentSkill(library, { plan, operation_id: "attachment-resume", mode: "resume" }),
    )
    expect(f.uploads.size).toBe(1)
    expect(f.calls.filter((call) => call.path.endsWith("/send"))).toHaveLength(1)
    expect(
      f.calls.filter((call) => call.path.includes("/children") && call.method === "PATCH"),
    ).toHaveLength(0)
    expect(f.table("files")).toHaveLength(1)
    expect(f.table("records")).toHaveLength(2)
    const snapshot = await f.run(
      openSharedSnapshot({
        library,
        target: result.page_id,
        scope: "d".repeat(64),
        startedAt: Date.now(),
        forceFull: true,
      }),
    )
    const portable = await f.run(snapshotPortable(snapshot))
    expect(portable.files.find((file) => file.path === asset.path)?.bytes).toEqual(asset.bytes)
  })
  test("raw and one-file ZIP attachments retain exact bytes independently of reading bodies", async () => {
    const f = currentWriteFixture(parent)
    const png = new Uint8Array([137, 80, 78, 71, 0, 255, 13, 10]),
      font = new Uint8Array([0, 255, 10, 65, 12, 0, 13, 10])
    const originals = [
      { path: "SKILL.md", bytes: testBytes("# Assets\n") },
      { path: "assets/logo.png", bytes: png },
      { path: "assets/logo-copy.png", bytes: png },
      { path: "assets/font.otf", bytes: font },
    ]
    const plan = await f.run(prepareCurrentSkillWrite(input(originals)))
    const result = await f.run(writeCurrentSkill(library, { plan, operation_id: "attachments" }))
    expect(f.uploads.size).toBe(2)
    expect(f.calls.filter((call) => call.path.endsWith("/send"))).toHaveLength(2)
    expect(
      [...f.uploadedBytes.values()].some(
        (value) => value.length === png.length && value.every((byte, index) => byte === png[index]),
      ),
    ).toBe(true)
    expect([...f.uploadedBytes.values()].some((value) => value.length > font.length)).toBe(true)
    const snapshot = await f.run(
      openSharedSnapshot({
        library,
        target: result.page_id,
        scope: "b".repeat(64),
        startedAt: Date.now(),
        forceFull: true,
      }),
    )
    const portable = await f.run(snapshotPortable(snapshot))
    for (const file of originals)
      expect(portable.files.find((item) => item.path === file.path)?.bytes).toEqual(file.bytes)
    for (const file of (await f.run(queryCurrentSkillIndex(library, result.page_id))).files) {
      expect(f.blocks.get(file.page_id) ?? []).toEqual([])
    }
    f.clearCalls()
    await f.run(writeCurrentSkill(library, { plan, operation_id: "attachments-noop" }))
    expect(f.mutations()).toEqual([])
    expect(f.uploads.size).toBe(2)
    const index = await f.run(queryCurrentSkillIndex(library, result.page_id))
    const damaged = index.files.find((file) => file.path === "assets/logo.png")!
    f.blocks.set(damaged.page_id, [{ id: "management-only", type: "unsupported", unsupported: {} }])
    expect(
      await f.run(writeCurrentSkill(library, { plan, operation_id: "repair-attachment-reading" })),
    ).toMatchObject({ status: "unchanged", state: "ready" })
    expect(f.uploads.size).toBe(2)
    expect(f.mutations()).toEqual([])
    f.clearCalls()
    await f.run(writeCurrentSkill(library, { plan, operation_id: "repaired-noop" }))
    expect(f.mutations()).toEqual([])
    expect(f.uploads.size).toBe(2)
  })
  test.each(["native", "resource"] as const)(
    "retirement protects authored child content only for %s authority",
    async (kind) => {
      const f = currentWriteFixture(parent)
      const original = await f.run(
        prepareCurrentSkillWrite(
          input([
            { path: "SKILL.md", bytes: testBytes("# Main\n") },
            {
              path: "support.md",
              bytes: testBytes(kind === "native" ? "# Support" : "# Support\n"),
              authority: { kind },
            },
          ]),
        ),
      )
      const initial = await f.run(
        writeCurrentSkill(library, { plan: original, operation_id: "retirement-body-initial" }),
      )
      const index = await f.run(queryCurrentSkillIndex(library, initial.page_id))
      const file = index.files[0]!
      const body = [
        {
          object: "block",
          id: id(9910),
          parent: { type: "page_id", page_id: file.page_id },
          type: "child_page",
          has_children: false,
          child_page: { title: "Author child" },
        },
      ]
      f.blocks.set(file.page_id, body)
      const replacement = await f.run(
        prepareCurrentSkillWrite(input([{ path: "SKILL.md", bytes: testBytes("# Main\n") }])),
      )
      f.clearCalls()
      if (kind === "native") {
        await expect(
          f.run(
            writeCurrentSkill(library, {
              plan: replacement,
              operation_id: "retirement-body-update",
            }),
          ),
        ).rejects.toMatchObject({ code: "CURRENT_PROJECTION_CHILD_CONTENT" })
        expect(f.pages.get(file.page_id)?.in_trash).not.toBe(true)
        expect(f.blocks.get(file.page_id)).toEqual(body)
      } else {
        expect(
          await f.run(
            writeCurrentSkill(library, {
              plan: replacement,
              operation_id: "retirement-body-update",
            }),
          ),
        ).toMatchObject({ state: "ready" })
        expect(f.pages.get(file.page_id)?.in_trash).toBe(true)
        expect(f.calls.filter((call) => call.path.includes("/children") && !(call.method === "GET" && call.path.split("?")[0] === `v1/blocks/${library.library_id}/children`))).toEqual([])
      }
    },
  )
  test("a Source authorization binds its parent, target fingerprint and exact child operation", async () => {
    const { f, input, plan, source, intent, childOperation } = await coordinatedFixture()
    await f.run(
      withCurrentOperation(library, {
        intent,
        ownerPageId: sourcePage,
        run: (session) =>
          Effect.gen(function* () {
            const grant = yield* authorizeCoordinatedSkillWrite(session, {
              plan,
              source,
              assertSourceCurrent: () => Effect.void,
            })
            const changed = yield* prepareCoordinatedSkillWrite({
              ...input,
              create: { ...input.create, description: "Different selected input." },
            })
            for (const [selected, operation_id, authorization] of [
              [plan, "different-child-operation", grant],
              [changed, childOperation, grant],
              [
                plan,
                childOperation,
                { ...grant, source: { ...grant.source, source_id: "different-source" } },
              ],
            ] as const) {
              const result = yield* writeCoordinatedSkill(library, {
                plan: selected,
                operation_id,
                authorization,
              }).pipe(Effect.result)
              expect(result).toMatchObject({
                _tag: "Failure",
                failure: { code: "CURRENT_WRITE_CONFLICT" },
              })
            }
            const foreign = yield* authorizeCoordinatedSkillWrite(session, {
              plan,
              source: { ...source, source_id: "different-source" },
              assertSourceCurrent: () => Effect.void,
            }).pipe(Effect.result)
            expect(foreign).toMatchObject({
              _tag: "Failure",
              failure: { code: "CURRENT_WRITE_CONFLICT" },
            })
            const foreignPlan = yield* prepareCoordinatedSkillWrite({
              ...input,
              source: { ...input.source, source_id: "different-source" },
              consumption_sources: [{ ...input.source, source_id: "different-source" }],
              files: input.files.map((file) =>
                file.kind === "preserve"
                  ? file
                  : {
                      ...file,
                      file: {
                        ...file.file,
                        authority: { ...file.file.authority, source_id: "different-source" },
                      },
                    },
              ),
            })
            expect(
              yield* authorizeCoordinatedSkillWrite(session, {
                plan: foreignPlan,
                source,
                assertSourceCurrent: () => Effect.void,
              }).pipe(Effect.result),
            ).toMatchObject({
              _tag: "Failure",
              failure: { code: "CURRENT_WRITE_CONFLICT" },
            })
            yield* session.markSourceChildComplete(plan.skill_id)
          }),
        verify: () => Effect.void,
      }),
    )
    expect(f.mutations()).toEqual([])
    expect(
      [...f.json.keys()].filter((key) => key.startsWith("operations/current-write-pending/")),
    ).toEqual([])
  })

  test("an unresolved Source action cannot authorize or create a child intent", async () => {
    const { f, plan, source, intent } = await coordinatedFixture()
    f.failNext({ kind: "source-properties", outcome: "absent" })
    await expect(
      f.run(
        withCurrentOperation(library, {
          intent,
          ownerPageId: sourcePage,
          run: (session) =>
            Effect.gen(function* () {
              const original = yield* session
                .dispatch({
                  key: "source:change",
                  replay: "idempotent",
                  request: {
                    path: `v1/pages/${sourcePage}`,
                    body: {
                      properties: {
                        [library.sources.property_ids.Enabled!]: { checkbox: false },
                        [library.sources.property_ids.Content!]: {
                          rich_text: property(
                            property(f.pages.get(sourcePage)?.properties)[
                              library.sources.property_ids.Content!
                            ],
                          ).rich_text,
                        },
                      },
                    },
                    options: { method: "PATCH" },
                  },
                  observe: () => Effect.succeed({ status: "missing" as const }),
                  acknowledge: () => Effect.void,
                })
                .pipe(Effect.result)
              expect(original._tag).toBe("Failure")
              const before = f.calls.length
              const authorized = yield* authorizeCoordinatedSkillWrite(session, {
                plan,
                source,
                assertSourceCurrent: () => Effect.void,
              }).pipe(Effect.result)
              expect(authorized).toMatchObject({
                _tag: "Failure",
                failure: { code: "CURRENT_OPERATION_PENDING" },
              })
              expect(f.calls.length).toBe(before)
              if (original._tag === "Failure") return yield* Effect.fail(original.failure)
              return yield* Effect.fail(fail("TEST_UNEXPECTED", "Expected lost Source response."))
            }),
          verify: () => Effect.void,
        }),
      ),
    ).rejects.toMatchObject({
      code: "WRITE_OUTCOME_UNKNOWN",
      details: { operation_id: intent.operation_id, source_id: "provider" },
    })
    expect(
      f
        .table("records")
        .filter(
          (row) =>
            text(
              property(property(row.properties)[library.records.property_ids["Entity ID"]!])
                .rich_text,
            ) === "current-skill:example",
        ),
    ).toEqual([])
    expect(f.table("skills")[0]?.properties).toMatchObject({
      [library.skills.property_ids["Current State"]!]: { select: { name: "ready" } },
    })
  })

  test("a preserved descriptor changed between preflight and the Skill lock is rejected before activation", async () => {
    const { f, plan, source, intent, childOperation, local } = await coordinatedFixture()
    let fileReads = 0
    f.rewrite((path, response) => {
      if (
        path.startsWith(`v1/data_sources/${library.files.data_source_id}/query`) &&
        ++fileReads === 2
      ) {
        const row = f.pages.get(local.page_id)!
        const field = property(property(row.properties)[library.files.property_ids.Content!])
        field.rich_text = [
          { type: "text", text: { content: JSON.stringify({ ...local.content, mode: "100755" }) } },
        ]
      }
      return response
    })
    await expect(
      f.run(
        withCurrentOperation(library, {
          intent,
          ownerPageId: sourcePage,
          run: (session) =>
            Effect.gen(function* () {
              const authorization = yield* authorizeCoordinatedSkillWrite(session, {
                plan,
                source,
                assertSourceCurrent: () => Effect.void,
              })
              return yield* writeCoordinatedSkill(library, {
                plan,
                operation_id: childOperation,
                authorization,
              })
            }),
          verify: () => Effect.void,
        }),
      ),
    ).rejects.toMatchObject({ code: "CURRENT_WRITE_CONFLICT" })
    expect(fileReads).toBe(2)
    expect(f.mutations()).toEqual([])
    expect(
      [...f.json.keys()].filter((key) => key.startsWith("operations/current-write-pending/")),
    ).toEqual([])
  })

  test("Source inspection rejects relative and native references from a preserved author body to a removed File", async () => {
    const { f, input, source, local, index } = await coordinatedFixture()
    const removed = index.files.find((file) => file.file_id === "source-child")!
    const plan = await f.run(
      prepareCoordinatedSkillWrite({
        ...input,
        consumption_paths: input.consumption_paths.filter((path) => path !== removed.path),
        files: input.files.filter(
          (file) => file.kind !== "write" || file.file.file_id !== removed.file_id,
        ),
      }),
    )
    for (const link of [
      "[Source](source.md)",
      `<mention url="https://www.notion.so/${removed.page_id.replaceAll("-", "")}">Source</mention>`,
    ]) {
      const authored = `# Local author\n\n${link}\n`
      await f.run(
        Effect.gen(function* () {
          yield* (yield* Notion).request(
            `v1/pages/${local.page_id}/markdown`,
            {
              type: "replace_content",
              replace_content: { new_str: authored },
              markdown_version: "v2",
            },
            { method: "PATCH" },
          )
        }),
      )
      f.clearCalls()
      await expect(
        f.run(inspectCoordinatedSkillWrite(library, plan, source)),
      ).rejects.toMatchObject({ code: "SHARED_REFERENCE_BROKEN" })
      expect(f.mutations()).toEqual([])
      expect(f.pages.get(removed.page_id)?.in_trash).not.toBe(true)
    }
  })
})
