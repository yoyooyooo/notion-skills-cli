import { expect, test } from "bun:test"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, Layer } from "effect"
import { exportSkill, portableIdentity, snapshotPortable } from "../src/export.ts"
import { readImportZip } from "../src/import.ts"
import { decode, fail, SnapshotSchema, type Snapshot } from "../src/model.ts"
import {
  bodyIdentity,
  BUNDLE,
  canonicalMain,
  portableFiles,
  portableZip,
  readPortable,
  type PortableSkill,
} from "../src/portable.ts"
import { sha256, Store } from "../src/store.ts"

const encode = (value: string) => new TextEncoder().encode(value)
const original: PortableSkill = {
  name: "HTTP Workflow",
  description: "Use for HTTP requests: 安全处理。",
  main: "说明.md",
  files: [
    {
      path: "说明.md",
      bytes: encode(
        "---\r\nname: http-workflow\r\ndescription: Original description\r\ncompatibility: Bun\r\nallowed-tools: [Read, Bash]\r\n---\r\n\r\n# Steps\r\n\r\nRead references/guide.md.\r\n",
      ),
    },
    { path: "references/guide.md", bytes: encode("Guide\n\nWith original spacing.\n") },
    { path: "assets/data.bin", bytes: new Uint8Array([0, 255, 7]) },
  ],
}
const runPure = <A, E>(operation: Effect.Effect<A, E, NodeServices.NodeServices>) =>
  Effect.runPromise(operation.pipe(Effect.provide(NodeServices.layer)))

test("portable ZIP preserves source bytes, metadata, main filename and nested paths across multiple cycles", async () => {
  let skill = original
  const first = portableZip(skill)
  for (let cycle = 0; cycle < 4; cycle++) {
    skill = readPortable(readImportZip(portableZip(skill)))!
    expect(skill.name).toBe("HTTP Workflow")
    expect(skill.main).toBe("说明.md")
    expect(skill.files).toEqual([...original.files].sort((a, b) => a.path.localeCompare(b.path)))
    expect(portableZip(skill)).toEqual(first)
    expect(await runPure(portableIdentity(skill))).toBe(await runPure(portableIdentity(original)))
  }
  expect(portableFiles(skill).some((file) => file.path === BUNDLE)).toBe(false)
})

async function fixture(source?: PortableSkill) {
  const objects = new Map<string, Uint8Array>()
  const output = new Map<string, Uint8Array>()
  const body = "# Steps\nRead references/guide.md."
  const remoteFiles = [
    {
      path: "SKILL.md",
      bytes: encode(
        `---\nname: http-workflow\ndescription: 'Use for HTTP requests: 安全处理。'\nnotion_page_id: 12345678-1234-1234-1234-123456789abc\n---\n\n${body}\n`,
      ),
    },
    ...(source
      ? [
          {
            path: BUNDLE,
            bytes: portableZip(
              {
                ...source,
                projection: {
                  name: source.name,
                  description: source.description,
                  body: bodyIdentity(body),
                },
              },
              true,
            ),
          },
        ]
      : original.files.filter((file) => file.path !== original.main)),
  ]
  const entries = []
  for (const file of remoteFiles) {
    const hash = await runPure(sha256(file.bytes))
    objects.set(`objects/${hash}`, file.bytes)
    entries.push({ path: file.path, bytes: file.bytes.length, sha256: hash })
  }
  const snapshot: Snapshot = {
    snapshot_id: "s_" + "a".repeat(64),
    scope: "test",
    version_id: "revision",
    created_at: 123,
    skill_name: "http-workflow",
    skill: {
      id: "12345678-1234-1234-1234-123456789abc",
      name: original.name,
      alias: "http-workflow",
      description: original.description,
      database_id: "db",
      data_source_id: "ds",
      ref: "skill://12345678-1234-1234-1234-123456789abc/SKILL.md",
    },
    files: entries,
  }
  const store = Layer.succeed(Store, {
    root: "/memory",
    configRoot: "/memory",
    cacheRoot: "/memory",
    reserveCacheGeneration: (() => {
      let generation = 0
      return () => Effect.sync(() => ++generation)
    })(),
    listKeys: () => Effect.succeed([]),
    retireKeys: () => Effect.succeed([]),
    readJson: (key, schema) =>
      Effect.succeed(key.startsWith("snapshots/") ? decode(schema, snapshot) : undefined),
    writeJson: () => Effect.void,
    readBytes: (key) =>
      objects.has(key)
        ? Effect.succeed(objects.get(key)!)
        : Effect.fail(fail("SNAPSHOT_MISSING", "missing")),
    writeBytes: () => Effect.void,
    output: (path, bytes) =>
      Effect.sync(() => {
        output.set(path, bytes)
        return { output: path, reused: false }
      }),
  })
  const live = Layer.mergeAll(NodeServices.layer, store)
  const run = <A, E>(operation: Effect.Effect<A, E, any>) =>
    Effect.runPromise(operation.pipe(Effect.provide(live)) as Effect.Effect<A, E>)
  return { snapshot, objects, output, run }
}

test("snapshot export restores byte-exact source and reflects live body and title edits", async () => {
  const { snapshot, run } = await fixture(original)
  const restored = await run(snapshotPortable(snapshot))
  expect(restored.files).toEqual([...original.files].sort((a, b) => a.path.localeCompare(b.path)))
  const renamed = {
    ...snapshot,
    skill: { ...snapshot.skill, name: "HTTP Revised", alias: "http-revised" },
  }
  const edited = await run(snapshotPortable(renamed))
  const main = edited.files.find((file) => file.path === original.main)!
  const text = new TextDecoder().decode(main.bytes)
  expect(text).toContain('"name": "http-revised"')
  expect(text).toContain('"compatibility": "Bun"')
  expect(text).toContain('"allowed-tools": ["Read","Bash"]')
  expect(text).not.toContain("notion_page_id")
  expect(edited.files.find((file) => file.path === "assets/data.bin")!.bytes).toEqual(
    original.files[2]!.bytes,
  )
})

test("native export excludes server identities and remains stable when reimported", async () => {
  const native = await fixture()
  const portable = await native.run(snapshotPortable(native.snapshot))
  const main = portable.files.find((file) => file.path === "SKILL.md")!
  expect(new TextDecoder().decode(main.bytes)).not.toContain("notion_page_id")
  expect(new TextDecoder().decode(main.bytes)).toContain('"name": "http-workflow"')
  const imported = await fixture(portable)
  expect(portableZip(await imported.run(snapshotPortable(imported.snapshot)))).toEqual(
    portableZip(portable),
  )
  const otherIdentity = {
    ...native.snapshot,
    skill: { ...native.snapshot.skill, id: "other-page" },
    version_id: "other-version",
  }
  expect(portableZip(await native.run(snapshotPortable(otherIdentity)))).toEqual(
    portableZip(portable),
  )
})

test("export validates every cached object before producing output", async () => {
  const fixtureData = await fixture(original)
  const entry = fixtureData.snapshot.files.find((file) => file.path === BUNDLE)!
  fixtureData.objects.set(`objects/${entry.sha256}`, encode("corrupted"))
  const result = await fixtureData.run(
    exportSkill(fixtureData.snapshot.snapshot_id, { output: "/portable.zip" }).pipe(Effect.result),
  )
  expect(result._tag === "Failure" && result.failure.code).toBe("STATE_CORRUPT")
  expect(fixtureData.output.size).toBe(0)
})

test("portable manifests reject unsupported versions, missing main and reserved collisions", () => {
  const entries = portableFiles(original)
  expect(() => readPortable(entries.filter((file) => file.path !== original.main))).toThrow(
    expect.objectContaining({ code: "INVALID_ARCHIVE" }),
  )
  expect(() =>
    portableZip({
      ...original,
      files: [...original.files, { path: BUNDLE, bytes: encode("collision") }],
    }),
  ).toThrow(expect.objectContaining({ code: "INVALID_ARCHIVE" }))
  expect(() =>
    readPortable([
      { path: ".ntn-skills.json", bytes: encode('{"format":"ntn-skills","version":2}') },
    ]),
  ).toThrow(expect.objectContaining({ code: "INVALID_ARCHIVE" }))
  const once = canonicalMain(original.name, original.description, "# Content\n")
  expect(new TextDecoder().decode(once.bytes)).not.toContain("notion_page_id")
})

test("body comparison handles endpoint formatting without hiding literal code edits", () => {
  const page = "# Heading\nParagraph.\n```plain text\nfirst\n\nsecond\n```"
  const exported = "# Heading\n\nParagraph.\n\n```txt\nfirst\n\nsecond\n```\n"
  expect(bodyIdentity(page)).toBe(bodyIdentity(exported))
  expect(bodyIdentity(page.replace("first\n\nsecond", "first\nsecond"))).not.toBe(
    bodyIdentity(exported),
  )
  expect(bodyIdentity("~~~text\n\nfirst\n\n~~~")).not.toBe(bodyIdentity("~~~text\nfirst\n~~~"))
  expect(bodyIdentity("```js\nfirst\n```")).not.toBe(bodyIdentity("```txt\nfirst\n```"))
})

test("portable directory and ZIP limits include their generated manifest", () => {
  const skill = {
    ...original,
    files: [
      original.files[0]!,
      ...Array.from({ length: 9_999 }, (_, index) => ({
        path: `references/${index}.md`,
        bytes: encode("Guide"),
      })),
    ],
  }
  expect(() => portableFiles(skill)).toThrow(expect.objectContaining({ code: "ARCHIVE_TOO_LARGE" }))
  expect(() => portableZip(skill)).toThrow(expect.objectContaining({ code: "ARCHIVE_TOO_LARGE" }))
})
