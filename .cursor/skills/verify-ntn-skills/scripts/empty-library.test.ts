import { expect, test } from "bun:test"
import { normalizedMetadata, requireTestEntry, requireTestCommand } from "./empty-library.ts"

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

test("repair entry is a supported operation kind, not the database selector", () => {
  const library = {
    library_id: "library-owned",
    skills: {
      database_id: "11111111-1111-4111-8111-111111111111",
      data_source_id: "owned",
      property_ids: {},
    },
  }
  expect(() =>
    requireTestCommand(
      [
        "ctl",
        "repair",
        "plan",
        "22222222-2222-4222-8222-222222222222",
        "--entry",
        "managed-file",
        "--database",
        library.skills.database_id,
        "--dry-run",
      ],
      library,
    ),
  ).not.toThrow()
  expect(() =>
    requireTestCommand(["ctl", "repair", "plan", "page", "--entry", "managed-file"], library),
  ).toThrow("explicitly")
  expect(() =>
    requireTestCommand(
      [
        "ctl",
        "repair",
        "plan",
        "page",
        "--entry",
        "managed-file",
        "--database",
        "33333333-3333-4333-8333-333333333333",
      ],
      library,
    ),
  ).toThrow("exact library")
})
