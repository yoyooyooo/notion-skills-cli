import { parseTarget } from "../src/ref.ts"
import { convertPortable } from "../../portable-converter/src/converter.ts"
import { expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect } from "effect"
import { exportSkill, portableIdentity, snapshotPortable } from "../src/export.ts"
import { readImportZip } from "../src/import.ts"
import {
  canonicalMain,
  fileOrder,
  MANIFEST,
  portableFiles,
  portableZip,
  readPortable,
  type PortableSkill,
} from "../src/portable.ts"
import { sha256, Store } from "../src/store.ts"
import { currentBytes, currentSkillPage, currentSnapshotFixture } from "./shared-current-fixture.ts"

const encode = (value: string) => new TextEncoder().encode(value)
const original: PortableSkill = {
  kind: "skill",
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
    {
      path: "references/guide.md",
      bytes: encode("Guide\n\nWith original spacing.\n"),
    },
    { path: "assets/data.bin", bytes: new Uint8Array([0, 255, 7]) },
  ],
}
const runPure = <A, E>(operation: Effect.Effect<A, E, NodeServices.NodeServices>) =>
  Effect.runPromise(operation.pipe(Effect.provide(NodeServices.layer)))

test("local ZIP backups preserve resources larger than the direct-upload limit", async () => {
  const bytes = new Uint8Array(randomBytes(21 * 1024 * 1024))
  const skill: PortableSkill = {
    kind: "skill",
    name: "Current large resource",
    description: "Export complete current bytes locally.",
    main: "SKILL.md",
    files: [
      { path: "SKILL.md", bytes: encode("# Current content\n"), mode: "100644" },
      { path: "assets/large.bin", bytes, mode: "100755" },
    ],
  }
  const archive = portableZip(skill)
  expect(archive.length).toBeGreaterThan(20 * 1024 * 1024)
  const restored = readPortable(readImportZip(archive))!
  const resource = restored.files.find((file) => file.path === "assets/large.bin")!
  expect(resource.mode).toBe("100755")
  expect(await runPure(sha256(resource.bytes))).toBe(await runPure(sha256(bytes)))
})

test("portable ZIP preserves source bytes, metadata, main filename and nested paths across multiple cycles", async () => {
  let skill = original
  const first = portableZip(skill)
  for (let cycle = 0; cycle < 4; cycle++) {
    skill = readPortable(readImportZip(portableZip(skill)))!
    expect(skill.name).toBe("HTTP Workflow")
    expect(skill.main).toBe("说明.md")
    expect(skill.files).toEqual([...original.files].sort(fileOrder))
    expect(portableZip(skill)).toEqual(first)
    expect(await runPure(portableIdentity(skill))).toBe(await runPure(portableIdentity(original)))
  }
})

test("current export preserves each selected file byte and mode without recovering retained projections", async () => {
  const f = currentSnapshotFixture({ fileCount: 3 })
  const exact = currentBytes(
    "\uFEFFRead SKILL.md, [HTTPS](https://Example.com:443/path?q=1#part), [HTTP](http://example.com), and [guide](../references/0.md).\r\n",
  )
  await f.resource(1, "assets/original.txt", exact)
  await f.resource(2, "scripts/run.sh", currentBytes("#!/bin/sh\nexit 0\n"), "100755")
  const snapshot = await f.target(parseTarget(currentSkillPage))
  const portable = await f.run(snapshotPortable(snapshot))
  expect(portable.files.map((file) => file.path).sort()).toEqual(
    ["SKILL.md", "references/0.md", "assets/original.txt", "scripts/run.sh"].sort(),
  )
  expect(portable.files.find((file) => file.path === "assets/original.txt")?.bytes).toEqual(exact)
  expect(portable.files.find((file) => file.path === "scripts/run.sh")?.mode).toBe("100755")
  expect(
    new TextDecoder().decode(portable.files.find((file) => file.path === "references/0.md")!.bytes),
  ).toContain("Complete supporting text 0.")
  expect(portable).not.toHaveProperty("projection")
  const output = new Map<string, Uint8Array>()
  const receipt = await f.run(
    Effect.gen(function* () {
      const store = yield* Store
      return yield* exportSkill(snapshot.snapshot_id, {
        output: "/current.zip",
        offline: true,
      }).pipe(
        Effect.provideService(Store, {
          ...store,
          output: (path, bytes) =>
            Effect.sync(() => {
              output.set(path, bytes)
              return { output: path, reused: false }
            }),
        }),
      )
    }),
  )
  expect(receipt.projection).toBe("snapshot")
  expect(receipt.files.map((file) => file.path).sort()).toEqual(
    [...snapshot.files.map((file) => file.path), MANIFEST].sort(),
  )
  const restored = readPortable(readImportZip(output.get("/current.zip")!))!
  expect(restored.files).toEqual([...portable.files].sort(fileOrder))
  for (const file of snapshot.files) {
    expect(receipt.files.find((entry) => entry.path === file.path)).toMatchObject({
      path: file.path,
      bytes: file.bytes,
      hash: file.sha256,
      role: file.path === snapshot.entrypoint ? "entrypoint" : "resource",
    })
  }
  expect(f.semanticWrites()).toEqual([])
})

test("current display metadata changes never rewrite the selected entrypoint bytes", async () => {
  const f = currentSnapshotFixture()
  const snapshot = await f.target(parseTarget(currentSkillPage))
  const original = await f.run(snapshotPortable(snapshot))
  const renamed = await f.run(
    snapshotPortable({
      ...snapshot,
      record: {
        ...snapshot.record,
        name: "Renamed catalog label",
        description: "Updated discovery text",
      },
    }),
  )
  expect(renamed.name).toBe("Renamed catalog label")
  expect(renamed.files).toEqual(original.files)
  expect(await f.run(portableIdentity(renamed))).not.toBe(await f.run(portableIdentity(original)))
  expect(f.semanticWrites()).toEqual([])
})

test("current readback exports the new body after an explicit refresh", async () => {
  const f = currentSnapshotFixture()
  const before = await f.target(parseTarget(currentSkillPage))
  f.main.last_edited_time = "2026-11-18T01:00:00.000Z"
  f.bodies.set(currentSkillPage, "# Updated current body\n")
  const after = await f.target(parseTarget(currentSkillPage), { refresh: true })
  const portable = await f.run(snapshotPortable(after))
  expect(after.snapshot_id).not.toBe(before.snapshot_id)
  expect(
    new TextDecoder().decode(portable.files.find((file) => file.path === "SKILL.md")!.bytes),
  ).toContain("# Updated current body")
  expect(f.semanticWrites()).toEqual([])
})

test("export rejects a corrupt current object before creating any output", async () => {
  const f = currentSnapshotFixture()
  const snapshot = await f.target(parseTarget(currentSkillPage))
  const file = snapshot.files.find((file) => file.path === "references/0.md")!
  f.objects.set(`objects/${file.sha256}`, currentBytes("Corrupt current bytes"))
  let writes = 0
  const result = await f.run(
    Effect.gen(function* () {
      const store = yield* Store
      return yield* exportSkill(snapshot.snapshot_id, {
        output: "/corrupt.zip",
        offline: true,
      }).pipe(
        Effect.provideService(Store, {
          ...store,
          output: (path) =>
            Effect.sync(() => {
              writes++
              return { output: path, reused: false }
            }),
        }),
        Effect.result,
      )
    }),
  )
  expect(result._tag === "Failure" && result.failure.code).toBe("STATE_CORRUPT")
  expect(writes).toBe(0)
})

test("portable content identity includes kind, exact body bytes, execution mode and explicit relations", async () => {
  const originalIdentity = await runPure(portableIdentity(original))
  for (const changed of [
    { ...original, kind: "router" as const },
    {
      ...original,
      files: original.files.map((file, index) =>
        index === 0
          ? {
              ...file,
              bytes: encode(new TextDecoder().decode(file.bytes).replaceAll("\r\n", "\n")),
            }
          : file,
      ),
    },
    {
      ...original,
      files: original.files.map((file, index) =>
        index === 1 ? { ...file, mode: "100755" as const } : file,
      ),
    },
    {
      ...original,
      relations: {
        version: 1 as const,
        ownership: "notion" as const,
        library_id: "library-current",
        members: [],
      },
    },
  ])
    expect(await runPure(portableIdentity(changed))).not.toBe(originalIdentity)
  expect(
    await runPure(portableIdentity({ ...original, files: [...original.files].reverse() })),
  ).toBe(originalIdentity)
})

test("portable manifests reject missing entrypoints, reserved manifest collisions and retained fields", () => {
  const entries = portableFiles(original)
  expect(() => readPortable(entries.filter((file) => file.path !== original.main))).toThrow(
    expect.objectContaining({ code: "INVALID_ARCHIVE" }),
  )
  expect(() =>
    portableZip({
      ...original,
      files: [...original.files, { path: MANIFEST, bytes: encode("collision") }],
    }),
  ).toThrow(expect.objectContaining({ code: "INVALID_ARCHIVE" }))
  for (const extra of [
    { projection: { body: "old retained content" } },
    { future_unknown: true },
    { version: 99 },
  ]) {
    const changed = entries.map((file) =>
      file.path === MANIFEST
        ? {
            ...file,
            bytes: encode(
              JSON.stringify({ ...JSON.parse(new TextDecoder().decode(file.bytes)), ...extra }),
            ),
          }
        : file,
    )
    expect(() => readPortable(changed)).toThrow(
      expect.objectContaining({ code: "INVALID_ARCHIVE" }),
    )
  }
  expect(() =>
    portableFiles({ ...original, projection: { body: "old" } } as PortableSkill),
  ).toThrow(expect.objectContaining({ code: "INVALID_ARCHIVE" }))
})

test("a file with the former source-bundle name is opaque ordinary content", () => {
  const files = [
    ...original.files,
    { path: "ntn-skills-source.zip", bytes: new Uint8Array([9, 8, 7]) },
  ]
  const restored = readPortable(readImportZip(portableZip({ ...original, files })))!
  expect(restored.files).toEqual([...files].sort(fileOrder))
  expect(restored).not.toHaveProperty("projection")
})

test("portable metadata and canonical entrypoints retain exact display names", () => {
  for (const name of [
    "Tty7",
    "n8n-workflow",
    "React19",
    "中文",
    "Agent Workflow",
    "  Mixed Name  ",
  ]) {
    const main = canonicalMain(name, original.description, "# Original\n", {
      path: "SKILL.md",
      bytes: new Uint8Array(),
    })
    const skill = { ...original, name, main: main.path, files: [main] }
    const restored = readPortable(readImportZip(portableZip(skill)))!
    expect(restored.name).toBe(name)
    expect(new TextDecoder().decode(restored.files[0]!.bytes)).toContain(
      `"name": ${JSON.stringify(name)}`,
    )
  }
  for (const name of ["", "  ", "Agent\tSkill", "Agent\u200bSkill"]) {
    expect(() => portableFiles({ ...original, name })).toThrow(
      expect.objectContaining({ code: "INVALID_SKILL_NAME" }),
    )
    expect(() => canonicalMain(name, original.description, "Body", original.files[0]!)).toThrow(
      expect.objectContaining({ code: "INVALID_SKILL_NAME" }),
    )
    const files = portableFiles(original).map((file) => {
      if (file.path !== ".ntn-skills.json") return file
      const manifest = JSON.parse(new TextDecoder().decode(file.bytes))
      return { ...file, bytes: encode(JSON.stringify({ ...manifest, name })) }
    })
    expect(() => readPortable(files)).toThrow(
      expect.objectContaining({ code: "INVALID_SKILL_NAME" }),
    )
  }
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

for (const [kind, main] of [
  ["router", "ROUTER.md"],
  ["prompt", "PROMPT.md"],
] as const) {
  test(`portable v2 preserves ${kind} kind, entry and supporting bytes`, () => {
    const content: PortableSkill = {
      kind,
      name: "Portable Content",
      description: "Explicit content kind",
      main,
      files: [
        { path: main, bytes: encode("# Content\n") },
        { path: "assets/data.bin", bytes: new Uint8Array([0, 255]) },
      ],
    }
    const restored = readPortable(readImportZip(portableZip(content)))!
    expect(restored.kind).toBe(kind)
    expect(restored.main).toBe(main)
    expect(restored.files).toEqual([...content.files].sort(fileOrder))
  })
}

test("explicit portable v1 input converts to skill and writes v2", () => {
  const files = [
    {
      path: ".ntn-skills.json",
      bytes: encode(
        JSON.stringify({
          format: "ntn-skills",
          version: 1,
          name: "Legacy Input",
          description: "Explicit conversion",
          main: "workflow.md",
        }),
      ),
    },
    { path: "workflow.md", bytes: encode("# Original bytes\n") },
  ]
  expect(() => readPortable(files)).toThrow(
    expect.objectContaining({ code: "PORTABLE_UPGRADE_REQUIRED" }),
  )
  const converted = readPortable(convertPortable(files).files)!
  expect(converted.kind).toBe("skill")
  expect(converted.main).toBe("workflow.md")
  const manifest = portableFiles(converted).find((file) => file.path === ".ntn-skills.json")!
  expect(JSON.parse(new TextDecoder().decode(manifest.bytes))).toMatchObject({
    version: 2,
    kind: "skill",
    main: "workflow.md",
  })
  expect(converted.files[0]!.bytes).toEqual(files[1]!.bytes)
})
