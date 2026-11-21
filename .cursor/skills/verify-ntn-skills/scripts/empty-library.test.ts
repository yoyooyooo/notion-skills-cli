import { expect, test } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Effect } from "effect"
import type { initializeSharedLibrary } from "../../../../packages/core/src/shared-library.ts"
import { currentLibrary } from "../../../../packages/core/test/shared-current-fixture.ts"
import {
  normalizedMetadata,
  requireTestEntry,
  requireTestCommand,
  runEmptyLibrary,
} from "./empty-library.ts"

async function emptyInitializationFixture(sourceAppears = false) {
  const root = await mkdtemp(join(tmpdir(), "ntn-empty-library-current-"))
  const container = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  const library = currentLibrary
  const commands: string[][] = []
  let initialized = false,
    censuses = 0
  const drive: Parameters<typeof runEmptyLibrary>[0]["drive"] = async (argv) => {
    commands.push(argv)
    const record = `controlled-command-${commands.length}`
    if (argv.join(" ") === `ctl library init --parent ${library.parent_page_id}`) {
      const reused = initialized
      initialized = true
      const initializedLibrary = { library, reused } satisfies Effect.Success<
        ReturnType<typeof initializeSharedLibrary>
      >
      return { exit: 0, output: { ok: true, ...initializedLibrary }, record }
    }
    if (argv.join(" ") === `ctl library init --entry ${library.skills.database_id}`)
      return { exit: 0, output: { ok: true, library }, record }
    if (argv.join(" ") === `list --database ${library.skills.database_id} --refresh --json`)
      return { exit: 0, output: { ok: true, total_count: 0, has_more: false }, record }
    return { exit: 2, output: { ok: false, error: "Unknown current public command" }, record }
  }
  const probe: Parameters<typeof runEmptyLibrary>[0]["probe"] = async (request) => {
    if (request.kind === "page") return { id: container, in_trash: false }
    if (request.kind === "parent")
      return { object: "page", id: library.parent_page_id, parent: { page_id: container } }
    if (request.kind === "children")
      return {
        results: initialized
          ? [library.skills, library.files, library.records, library.sources].map((table) => ({
              id: table.database_id,
              type: "child_database",
            }))
          : [],
        has_more: false,
        next_cursor: null,
      }
    if (request.kind === "census") {
      censuses++
      return {
        tables: Object.fromEntries(
          ["skills", "files", "records", "sources"].map((role) => {
            const rows = sourceAppears && censuses === 2 && role === "sources" ? ["new-source"] : []
            return [role, { complete: true, count: rows.length, rows }]
          }),
        ),
      }
    }
    throw new Error(`Unexpected controlled probe: ${request.kind}`)
  }
  return {
    root,
    library,
    commands,
    run: () => runEmptyLibrary({ root, stage: "init", container, drive, probe }),
  }
}

test("empty-library commands keep the exact test entry rather than a production alias", () => {
  const expected = "11111111-1111-4111-8111-111111111111"
  expect(() => requireTestEntry(expected.replaceAll("-", ""), expected)).not.toThrow()
  expect(() => requireTestEntry("skills", expected)).toThrow()
  expect(() => requireTestEntry("22222222-2222-4222-8222-222222222222", expected)).toThrow()
})

test("table observations retain identities and meaningful values but exclude edit timestamps", () => {
  const page = {
    object: "page",
    id: "owned",
    parent: { data_source_id: "test-table" },
    in_trash: false,
    properties: {
      Label: { id: "title", type: "title", title: [{ plain_text: "File" }] },
      Owner: {
        id: "owner",
        type: "relation",
        relation: [{ id: "skill-b" }, { id: "skill-a" }],
        has_more: false,
      },
      Updated: { id: "edited", type: "last_edited_time", last_edited_time: "now" },
    },
  }
  expect(normalizedMetadata(page)).toEqual({
    id: "owned",
    parent: { data_source_id: "test-table" },
    in_trash: false,
    fields: {
      title: { type: "title", text: "File" },
      owner: { type: "relation", ids: ["skill-a", "skill-b"] },
    },
  })
  expect(() =>
    normalizedMetadata({
      ...page,
      properties: { ...page.properties, Owner: { ...page.properties.Owner, has_more: true } },
    }),
  ).toThrow("truncated")
})

test("test entry does not retarget a foreign pinned ref", () => {
  const library = {
    library_id: "library-owned",
    skills: {
      database_id: "11111111-1111-4111-8111-111111111111",
      data_source_id: "owned",
      property_ids: {},
    },
  }
  const own =
    "skill://shared_skill%3Alibrary-owned%3Askill-owned/SKILL.md?snapshot=s_" + "a".repeat(64)
  expect(() =>
    requireTestCommand(["read", own, "--database", library.skills.database_id], library),
  ).not.toThrow()
  expect(() =>
    requireTestCommand(
      [
        "read",
        own.replace("library-owned", "library-production"),
        "--database",
        library.skills.database_id,
      ],
      library,
    ),
  ).toThrow("original library")
  expect(() => requireTestCommand(["list"], library)).toThrow("explicitly")
})

test("empty initialization completes through current commands and its four-table census", async () => {
  const fixture = await emptyInitializationFixture()
  const result = await fixture.run()
  expect(result).toMatchObject({
    status: "passed_empty_initialization",
    entry: fixture.library.skills.database_id,
    repeated_without_business_rows: true,
  })
  expect(fixture.commands.map((argv) => argv.slice(0, 3).join(" "))).toEqual([
    "ctl library init",
    "ctl library init",
    "ctl library init",
    `list --database ${fixture.library.skills.database_id}`,
  ])
  const receipt = JSON.parse(
    await readFile(join(fixture.root, "evidence/empty-library/state.json"), "utf8"),
  )
  expect(receipt).toMatchObject({ kind: "library_ready", library: fixture.library })
})

test("a Source appearing after initialization cannot pass the empty-library census", async () => {
  const fixture = await emptyInitializationFixture(true)
  await expect(fixture.run()).rejects.toThrow("Expected values to be strictly deep-equal")
  expect(fixture.commands).toHaveLength(4)
})
