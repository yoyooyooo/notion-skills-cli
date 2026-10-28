import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import { property } from "../src/model.ts"
import { BUNDLE, bodyIdentity, readPortable, type PortableSkill } from "../src/portable.ts"
import { readImportZip } from "../src/import.ts"
import {
  contentAdoptionSourceAttachmentBody,
  contentAdoptionSourceField,
  prepareContentAdoptionSourceInstallation,
} from "../src/publication-content-adoption-source.ts"

const encoder = new TextEncoder()
const source: PortableSkill = {
  kind: "skill",
  name: "bounded-skill",
  description: "Use bounded source installation.",
  main: "SKILL.md",
  files: [
    {
      path: "SKILL.md",
      bytes: encoder.encode(
        "---\nname: bounded-skill\ndescription: Use bounded source installation.\nlicense: MIT\n---\n\n# Original\n\nRetain authored text.\n",
      ),
    },
    { path: "README.md", bytes: encoder.encode("# Extra text\n\nTrailing spaces stay.  \n") },
    { path: "tests/cases.json", bytes: encoder.encode('{"text":"原始内容"}\n') },
  ],
}
const root = {
  id: "11111111-1111-4111-8111-111111111111",
  properties: {
    Files: { id: "notion%3A%2F%2Fskills%2Ffiles_property", type: "files", files: [] },
  },
}
const fingerprint = (source: PortableSkill) =>
  source.files
    .map((file) => ({ path: file.path, bytes: Array.from(file.bytes) }))
    .sort((a, b) => a.path.localeCompare(b.path))

test("source archive retains every original path and byte, extra frontmatter and text sidecars", async () => {
  const before = fingerprint(source)
  const prepared = await Effect.runPromise(prepareContentAdoptionSourceInstallation(source, root))
  const archived = readPortable(readImportZip(prepared.bytes))
  expect(archived).toBeDefined()
  expect(fingerprint(archived!)).toEqual(before)
  expect(fingerprint(source)).toEqual(before)
  expect(prepared.installation.filename).toBe(BUNDLE)
  expect(prepared.installation.sha256).toBe(
    createHash("sha256").update(prepared.bytes).digest("hex"),
  )
  expect(prepared.installation.byte_length).toBe(prepared.bytes.length)
  expect(prepared.installation.property_id).toBe(root.properties.Files.id)
  expect(
    contentAdoptionSourceAttachmentBody(
      prepared.installation,
      "3ff5636c-236e-819c-9f08-00b26fde053a",
    ),
  ).toEqual({
    properties: {
      [root.properties.Files.id]: {
        files: [
          {
            name: BUNDLE,
            type: "file_upload",
            file_upload: { id: "3ff5636c-236e-819c-9f08-00b26fde053a" },
          },
        ],
      },
    },
  })
})

test("source archive binds both reference projections while retaining every original reference byte", async () => {
  const references = [
    {
      path: "references/guide.md",
      bytes: encoder.encode("# Guide\r\n\r\nKeep authored spacing.  \r\n\r\n"),
    },
    { path: "references/policy.md", bytes: encoder.encode("# Policy\n\n原始规则。\n") },
  ]
  const original = { ...source, files: [...source.files, ...references] }
  const before = fingerprint(original)
  const prepared = await Effect.runPromise(prepareContentAdoptionSourceInstallation(original, root))
  const archived = readPortable(readImportZip(prepared.bytes))
  expect(archived).toBeDefined()
  expect(fingerprint(archived!)).toEqual(before)
  expect(fingerprint(original)).toEqual(before)
  expect(archived!.projection?.references).toEqual(
    Object.fromEntries(
      original.files
        .filter((file) => file.path !== original.main && /\.md$/i.test(file.path))
        .map((file) => [file.path, bodyIdentity(new TextDecoder().decode(file.bytes))]),
    ),
  )
})

for (const [name, extra] of [
  ["binary NUL", { path: "asset.bin", bytes: Uint8Array.from([65, 0, 66]) }],
  ["invalid UTF-8", { path: "broken.txt", bytes: Uint8Array.from([0xc3, 0x28]) }],
  [
    "oversized single file",
    { path: "large.txt", bytes: encoder.encode("a".repeat(1024 * 1024 + 1)) },
  ],
] as const)
  test(`source installation refuses ${name} without producing an artifact`, async () => {
    const result = await Effect.runPromise(
      prepareContentAdoptionSourceInstallation(
        { ...source, files: [...source.files, extra] },
        root,
      ).pipe(Effect.result),
    )
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") throw new Error("Expected bounded source refusal")
    expect(result.failure.code).toBe("CONTENT_ADOPTION_REFUSED")
  })

test("source installation retains exact source bytes at the 5 MiB total and 1 MiB file boundaries", async () => {
  const fileLimit = 1024 * 1024
  const main = source.files[0]!
  const files = [
    main,
    ...Array.from({ length: 4 }, (_, index) => ({
      path: `sidecar-${index}.txt`,
      bytes: encoder.encode("a".repeat(fileLimit)),
    })),
    { path: "remaining.txt", bytes: encoder.encode("b".repeat(fileLimit - main.bytes.length)) },
  ]
  expect(files.reduce((sum, file) => sum + file.bytes.length, 0)).toBe(5 * fileLimit)
  const prepared = await Effect.runPromise(
    prepareContentAdoptionSourceInstallation({ ...source, files }, root),
  )
  const archived = readPortable(readImportZip(prepared.bytes))
  const identities = (values: PortableSkill["files"]) =>
    values
      .map((file) => [
        file.path,
        file.bytes.length,
        createHash("sha256").update(file.bytes).digest("hex"),
      ])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0])))
  expect(archived).toBeDefined()
  expect(identities(archived!.files)).toEqual(identities(files))
})

test("source installation refuses more than 5 MiB even when every file is within 1 MiB", async () => {
  const files = [
    source.files[0]!,
    ...Array.from({ length: 5 }, (_, index) => ({
      path: `sidecar-${index}.txt`,
      bytes: encoder.encode("a".repeat(1024 * 1024)),
    })),
  ]
  const result = await Effect.runPromise(
    prepareContentAdoptionSourceInstallation({ ...source, files }, root).pipe(Effect.result),
  )
  expect(result._tag).toBe("Failure")
  if (result._tag !== "Failure") throw new Error("Expected total source byte refusal")
  expect(result.failure.code).toBe("CONTENT_ADOPTION_REFUSED")
})

test("source installation refuses an excessive number of individually small files", async () => {
  const files = [
    ...source.files,
    ...Array.from({ length: 100 }, (_, index) => ({
      path: `small-${index}.txt`,
      bytes: encoder.encode("a"),
    })),
  ]
  const result = await Effect.runPromise(
    prepareContentAdoptionSourceInstallation({ ...source, files }, root).pipe(Effect.result),
  )
  expect(result._tag).toBe("Failure")
})

for (const [name, value] of [
  ["missing Files", { properties: {} }],
  ["retyped Files", { properties: { Files: { id: "files", type: "rich_text", rich_text: [] } } }],
  ["empty identity", { properties: { Files: { id: "", type: "files", files: [] } } }],
  [
    "additional property definition",
    { properties: { Files: { ...root.properties.Files, unknown_definition: true } } },
  ],
  [
    "second files field",
    {
      properties: { ...root.properties, Attachments: { id: "another", type: "files", files: [] } },
    },
  ],
] as const)
  test(`source installation refuses ${name}; it cannot redefine the original field`, () => {
    expect(() => contentAdoptionSourceField(value)).toThrow()
  })

test("source installation cannot replace a pre-existing attachment, even at the reserved filename", async () => {
  const before = {
    properties: {
      Files: {
        ...root.properties.Files,
        files: [{ name: BUNDLE, type: "file", file: { url: "https://example.com/existing.zip" } }],
      },
    },
  }
  const result = await Effect.runPromise(
    prepareContentAdoptionSourceInstallation(source, before).pipe(Effect.result),
  )
  expect(result._tag).toBe("Failure")
  expect(property(before.properties.Files).files).toHaveLength(1)
})
