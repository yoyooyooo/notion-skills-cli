import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { property } from "../src/model.ts"
import type { PortableSkill } from "../src/portable.ts"
import type { PublicationMarker } from "../src/publication-integrity-state.ts"
import { canonical } from "../src/publication-effect-proof.ts"
import {
  deriveContentAdoptionDescriptionMigration,
  contentAdoptionDescriptionComparison,
  contentAdoptionDescriptionMatches,
  contentAdoptionDescriptorBounds,
} from "../src/publication-content-adoption-description.ts"

const encoder = new TextEncoder()
const fingerprint = (portable: PortableSkill) =>
  createHash("sha256")
    .update(
      canonical([
        portable.kind,
        portable.name,
        portable.description,
        portable.main,
        [...portable.files]
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
          .map((file) => [
            file.path,
            file.bytes.length,
            createHash("sha256").update(file.bytes).digest("hex"),
          ]),
      ]),
    )
    .digest("hex")
function fixture(description = "Internal\n换行 stays.\n") {
  const portable: PortableSkill = {
    kind: "skill",
    name: "sample",
    description,
    main: "SKILL.md",
    files: [
      {
        path: "SKILL.md",
        bytes: encoder.encode(
          "---\nname: sample\ndescription: |\n  Internal\n  换行 stays.\n---\n\n# Original\n",
        ),
      },
      { path: "references/schema.json", bytes: encoder.encode('{"retain":"all bytes"}\r\n') },
    ],
  }
  const sourceHash = fingerprint(portable),
    legacy = description.slice(0, -1)
  const old: PublicationMarker = {
    version: 2,
    state: "writing",
    operation_id: "p_old",
    intended_hash: fingerprint({ ...portable, description: legacy }),
  }
  const raw = (value = legacy) => ({
    id: "page",
    last_edited_time: "2026-10-22T00:00:00.000Z",
    properties: {
      Description: {
        id: "original-description-id",
        type: "rich_text",
        rich_text: [
          {
            type: "text",
            text: { content: value, link: null },
            plain_text: value,
            href: null,
            annotations: {
              bold: false,
              italic: false,
              strikethrough: false,
              underline: false,
              code: false,
              color: "default",
            },
          },
        ],
      },
      Name: {
        id: "title",
        type: "title",
        title: [{ type: "text", text: { content: "sample" }, plain_text: "sample" }],
      },
    },
  })
  return { portable, sourceHash, old, raw }
}
test("the Description migration derives two distinct full-source hashes without editing a source byte or descriptor", () => {
  const f = fixture(),
    original = structuredClone(f.portable),
    before = f.raw()
  const migration = deriveContentAdoptionDescriptionMigration(
    f.portable,
    f.sourceHash,
    f.old,
    before,
  )
  expect(migration.legacy_description).toBe("Internal\n换行 stays.")
  expect(migration.source_description).toBe(f.portable.description)
  expect(migration.legacy_intended_hash).toBe(f.old.intended_hash)
  expect(migration.source_intended_hash).toBe(f.sourceHash)
  expect(migration.legacy_intended_hash).not.toBe(migration.source_intended_hash)
  expect(
    contentAdoptionDescriptorBounds(f.portable, f.sourceHash, migration).portable.description,
  ).toBe(migration.legacy_description)
  expect(contentAdoptionDescriptorBounds(f.portable, f.sourceHash, migration, true).portable).toBe(
    f.portable,
  )
  expect(contentAdoptionDescriptorBounds(f.portable, f.sourceHash).portable).toBe(f.portable)
  expect(f.portable).toEqual(original)
  expect(f.raw()).toEqual(before)
})
test("the migration rejects missing, repeated, CRLF and empty final-LF candidates without trimming", () => {
  for (const description of ["No LF", "Two\n\n", "CRLF\r\n", "\n", "Trailing space\n "]) {
    const f = fixture(description)
    expect(() =>
      deriveContentAdoptionDescriptionMigration(f.portable, f.sourceHash, f.old, f.raw()),
    ).toThrow()
  }
})
test("the legacy hash must bind the exact original name, description, main and every sidecar byte", () => {
  const f = fixture()
  for (const changed of [
    { ...f.portable, name: "other" },
    { ...f.portable, description: "Other\n" },
    { ...f.portable, main: "OTHER.md" },
    { ...f.portable, files: f.portable.files.slice(0, 1) },
    {
      ...f.portable,
      files: f.portable.files.map((file, index) =>
        index === 1 ? { ...file, bytes: encoder.encode("changed") } : file,
      ),
    },
  ])
    expect(() =>
      deriveContentAdoptionDescriptionMigration(
        changed,
        fingerprint(changed),
        f.old,
        f.raw(changed.description.slice(0, -1)),
      ),
    ).toThrow()
  expect(() =>
    deriveContentAdoptionDescriptionMigration(f.portable, "f".repeat(64), f.old, f.raw()),
  ).toThrow()
  expect(() =>
    deriveContentAdoptionDescriptionMigration(
      f.portable,
      f.sourceHash,
      { ...f.old, intended_hash: f.sourceHash },
      f.raw(),
    ),
  ).toThrow()
})
test("a migration requires one complete unformatted Description property with matching text and unique identity", () => {
  const f = fixture()
  const changes: Array<(raw: ReturnType<typeof f.raw>) => void> = [
    (raw) => {
      raw.properties.Description.rich_text.push(
        structuredClone(raw.properties.Description.rich_text[0]!),
      )
    },
    (raw) => {
      raw.properties.Description.rich_text[0]!.plain_text += "different"
    },
    (raw) => {
      raw.properties.Description.rich_text[0]!.annotations.bold = true
    },
    (raw) => {
      property(raw.properties.Description.rich_text[0]!.text).link = { url: "https://example.test" }
    },
    (raw) => {
      property(raw.properties.Description.rich_text[0]!).href = "https://example.test"
    },
    (raw) => {
      property(raw.properties.Description).has_more = true
    },
    (raw) => {
      raw.properties.Description.type = "title"
    },
    (raw) => {
      raw.properties.Description.id = "Name"
    },
    (raw) => {
      property(raw.properties).Alias = structuredClone(raw.properties.Description)
    },
  ]
  for (const change of changes) {
    const raw = f.raw()
    change(raw)
    expect(() =>
      deriveContentAdoptionDescriptionMigration(f.portable, f.sourceHash, f.old, raw),
    ).toThrow()
  }
  expect(() =>
    deriveContentAdoptionDescriptionMigration(
      f.portable,
      f.sourceHash,
      f.old,
      f.raw("Internal 换行 stays."),
    ),
  ).toThrow()
})
test("the declared before/after comparison preserves the raw evidence, field definition and every unrelated value", () => {
  const f = fixture(),
    before = f.raw(),
    after = f.raw(f.portable.description)
  const migration = deriveContentAdoptionDescriptionMigration(
    f.portable,
    f.sourceHash,
    f.old,
    before,
  )
  const legacy = { migration, restored: false },
    restored = { migration, restored: true }
  expect(contentAdoptionDescriptionMatches(before, legacy)).toBe(true)
  expect(contentAdoptionDescriptionMatches(after, restored)).toBe(true)
  expect(contentAdoptionDescriptionMatches(before, restored)).toBe(false)
  expect(contentAdoptionDescriptionMatches(after, legacy)).toBe(false)
  const frozenBefore = structuredClone(before),
    frozenAfter = structuredClone(after)
  expect(contentAdoptionDescriptionComparison(before, legacy)).toEqual(
    contentAdoptionDescriptionComparison(after, restored),
  )
  expect(before).toEqual(frozenBefore)
  expect(after).toEqual(frozenAfter)
  const other = f.raw(f.portable.description)
  other.properties.Name.title[0]!.text.content = "Changed"
  other.properties.Name.title[0]!.plain_text = "Changed"
  expect(contentAdoptionDescriptionComparison(other, restored)).not.toEqual(
    contentAdoptionDescriptionComparison(before, legacy),
  )
  const recreated = f.raw(f.portable.description)
  recreated.properties.Description.id = "recreated"
  expect(() => contentAdoptionDescriptionComparison(recreated, restored)).toThrow()
  expect(() => contentAdoptionDescriptionComparison(before, restored)).toThrow()
})
test("Description migration cannot reinterpret a retained creation identity", () => {
  const f = fixture()
  const old: PublicationMarker = {
    ...f.old,
    creation: {
      version: 1,
      operation_token: "11111111-1111-4111-8111-111111111111",
      operation_id: "p_old",
      intent_index: 0,
      scope: "scope",
      database_id: "database",
      data_source_id: "data-source",
      role: "content_root",
      path: "SKILL.md",
      parent_type: "data_source_id",
      parent_id: "data-source",
      intended_hash: f.old.intended_hash,
      source_sha256: "a".repeat(64),
    },
  }
  expect(() =>
    deriveContentAdoptionDescriptionMigration(f.portable, f.sourceHash, old, f.raw()),
  ).toThrow()
})
