import { expect, test } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Effect } from "effect"
import type { initializeSharedLibrary } from "../../../../packages/core/src/shared-library.ts"
import { currentLibrary } from "../../../../packages/core/test/shared-current-fixture.ts"
import {
  normalizedMetadata,
  requireTestLibrary,
  requireTestCommand,
  runEmptyLibrary,
  verifyLibraryPlacement,
} from "./empty-library.ts"

async function emptyInitializationFixture(sourceAppears = false) {
  const root = await mkdtemp(join(tmpdir(), "ntn-empty-library-current-"))
  const container = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  const parent = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
  const library = currentLibrary
  const roles = ["skills", "files", "records", "sources"] as const
  const physical = {
    root: { object: "page", id: library.library_id, parent: { type: "page_id", page_id: parent } },
    databases: Object.fromEntries(
      roles.map((role) => [
        library[role].database_id,
        {
          object: "database",
          id: library[role].database_id,
          parent: { type: "page_id", page_id: library.library_id },
          data_sources: [{ id: library[role].data_source_id }],
        },
      ]),
    ),
    sources: Object.fromEntries(
      roles.map((role) => [
        library[role].data_source_id,
        {
          object: "data_source",
          id: library[role].data_source_id,
          parent: { type: "database_id", database_id: library[role].database_id },
        },
      ]),
    ),
  }
  const commands: string[][] = []
  let initialized = false,
    censuses = 0
  const drive: Parameters<typeof runEmptyLibrary>[0]["drive"] = async (argv) => {
    commands.push(argv)
    const record = `controlled-command-${commands.length}`
    if (argv.join(" ") === `ctl library init --parent ${parent}`) {
      expect(initialized).toBe(false)
      const reused = false
      initialized = true
      const initializedLibrary = { library, reused } satisfies Effect.Success<
        ReturnType<typeof initializeSharedLibrary>
      >
      return {
        exit: 0,
        output: {
          ok: true,
          ...initializedLibrary,
          root_url: "https://www.notion.so/" + library.library_id.replaceAll("-", ""),
        },
        record,
      }
    }
    if (argv.join(" ") === `ctl library init --library ${library.library_id}`)
      return { exit: 0, output: { ok: true, library, reused: true }, record }
    if (argv.join(" ") === `ctl library inspect --library ${library.library_id}`)
      return { exit: 0, output: { ok: true, library }, record }
    if (argv.join(" ") === `list --library ${library.library_id} --refresh --json`)
      return {
        exit: 0,
        output: {
          ok: true,
          library_id: library.library_id,
          total_count: 0,
          has_more: false,
          coverage: { method: "explicit_library", exhaustive: true },
        },
        record,
      }
    return { exit: 2, output: { ok: false, error: "Unknown current public command" }, record }
  }
  const probe: Parameters<typeof runEmptyLibrary>[0]["probe"] = async (request) => {
    if (request.kind === "page")
      return request.id === container
        ? { object: "page", id: container, in_trash: false }
        : physical.root
    if (request.kind === "database") return physical.databases[request.id]!
    if (request.kind === "data-source") return physical.sources[request.id]!
    if (request.kind === "parent")
      return { object: "page", id: parent, parent: { type: "page_id", page_id: container } }
    if (request.kind === "children")
      return {
        results: initialized
          ? request.id === parent
            ? [{ id: library.library_id, type: "child_page" }]
            : [library.skills, library.files, library.records, library.sources].map((table) => ({
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
    parent,
    physical,
    probe,
    drive,
    commands,
    run: () => runEmptyLibrary({ root, stage: "init", container, drive, probe }),
  }
}

test("empty-library commands keep the exact test root rather than a production alias", () => {
  const expected = "11111111-1111-4111-8111-111111111111"
  expect(() => requireTestLibrary(expected.replaceAll("-", ""), expected)).not.toThrow()
  expect(() => requireTestLibrary("skills", expected)).toThrow()
  expect(() => requireTestLibrary("22222222-2222-4222-8222-222222222222", expected)).toThrow()
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

test("test Library does not retarget a foreign pinned ref", () => {
  const library = {
    library_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    skills: {
      database_id: "11111111-1111-4111-8111-111111111111",
      data_source_id: "owned",
      property_ids: {},
    },
  }
  const own =
    "skill://skill-owned/SKILL.md?library=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&snapshot=s_" +
    "a".repeat(64)
  expect(() =>
    requireTestCommand(["read", own, "--library", library.library_id], library),
  ).not.toThrow()
  expect(() =>
    requireTestCommand(
      [
        "read",
        own.replace("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
        "--library",
        library.library_id,
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
    library_id: fixture.library.library_id,
    repeated_without_business_rows: true,
  })
  expect(fixture.commands.map((argv) => argv.slice(0, 3).join(" "))).toEqual([
    "ctl library init",
    "ctl library init",
    "ctl library inspect",
    `list --library ${fixture.library.library_id}`,
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

test("initialization readback rejects independent root, DB and DS placement drift", async () => {
  for (const mutate of [
    (f: Awaited<ReturnType<typeof emptyInitializationFixture>>) => {
      f.physical.root.parent.page_id = f.library.library_id
    },
    (f: Awaited<ReturnType<typeof emptyInitializationFixture>>) => {
      f.physical.databases[f.library.skills.database_id]!.parent.page_id = f.parent
    },
    (f: Awaited<ReturnType<typeof emptyInitializationFixture>>) => {
      f.physical.sources[f.library.skills.data_source_id]!.parent.database_id =
        f.library.files.database_id
    },
  ]) {
    const fixture = await emptyInitializationFixture()
    mutate(fixture)
    await expect(fixture.run()).rejects.toThrow()
    expect(fixture.commands).toHaveLength(1)
  }
})

test("placement fully paginates root children and permits ordinary root documents", async () => {
  const fixture = await emptyInitializationFixture()
  const tables = [
    fixture.library.skills,
    fixture.library.files,
    fixture.library.records,
    fixture.library.sources,
  ].map((table) => ({ id: table.database_id, type: "child_database" }))
  const cursors: Array<string | undefined> = []
  const result = await verifyLibraryPlacement({
    library: fixture.library,
    parent: fixture.parent,
    probe: async (request) => {
      if (request.kind !== "children") return fixture.probe(request)
      cursors.push(request.cursor)
      return request.cursor === undefined
        ? {
            results: [{ id: "instructions", type: "paragraph" }, ...tables.slice(0, 2)],
            has_more: true,
            next_cursor: "second",
          }
        : { results: tables.slice(2), has_more: false, next_cursor: null }
    },
  })
  expect(result.complete).toBe(true)
  expect(result.children).toHaveLength(5)
  expect(cursors).toEqual([undefined, "second"])
})

test("lost initialization acknowledgement retains the original attempt and cannot create another root", async () => {
  const fixture = await emptyInitializationFixture()
  await expect(
    runEmptyLibrary({
      root: fixture.root,
      stage: "init",
      container: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      probe: fixture.probe,
      drive: async (argv) => {
        const receipt = await fixture.drive(argv)
        return { ...receipt, exit: 1, output: { ok: false, error: "acknowledgement lost" } }
      },
    }),
  ).rejects.toThrow("Public command failed")
  await expect(fixture.run()).rejects.toThrow("does not retry an incomplete init")
  expect(fixture.commands).toHaveLength(1)
})
