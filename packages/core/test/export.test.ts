import { convertPortable } from "../../portable-converter/src/converter.ts"
import { integrityRepositoryFixture, upstreamRepositoryFixture } from "./fixtures.ts"
import { expect, test } from "bun:test"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, Layer } from "effect"
import {
  exportSkill,
  portableIdentity,
  snapshotAuthoredPortable,
  snapshotPortable,
} from "../src/export.ts"
import { readImportZip } from "../src/import.ts"
import { fromNotionMarkdown, samePublishedMarkdown } from "../src/markdown.ts"
import { decode, fail, SnapshotSchema, type Snapshot } from "../src/model.ts"
import {
  authoredPortable,
  bodyIdentity,
  BUNDLE,
  canonicalMain,
  fileOrder,
  portableFiles,
  portableZip,
  readPortable,
  type PortableSkill,
} from "../src/portable.ts"
import { sha256, Store } from "../src/store.ts"
import { rewritePageLinks } from "../src/references.ts"

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
  expect(portableFiles(skill).some((file) => file.path === BUNDLE)).toBe(false)
})

async function fixture(
  source?: PortableSkill,
  readback?: { readonly body: string; readonly projectionBody: string },
) {
  const objects = new Map<string, Uint8Array>()
  const output = new Map<string, Uint8Array>()
  const body = readback?.body ?? "# Steps\nRead references/guide.md."
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
                  body: readback?.projectionBody ?? bodyIdentity(body),
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
    snapshot_id: `s_${await runPure(sha256(JSON.stringify(["test", "notion_page:12345678-1234-1234-1234-123456789abc", "revision"])))}`,
    scope: "test",
    version_id: "revision",
    created_at: 123,
    entrypoint: "SKILL.md",
    record: {
      id: "notion_page:12345678-1234-1234-1234-123456789abc",
      kind: "skill",
      entrypoint: "SKILL.md",
      locator: {
        type: "notion_page",
        page_id: "12345678-1234-1234-1234-123456789abc",
        database_id: "db",
        data_source_id: "ds",
      },
      name: original.name,
      alias: "http-workflow",
      description: original.description,
      default_context: false,
      ref: "skill://12345678-1234-1234-1234-123456789abc/SKILL.md",
    },
    files: entries,
  }
  const store = Layer.succeed(Store, {
    integrity: integrityRepositoryFixture(),
    upstream: upstreamRepositoryFixture(),
    registerBindingWithBase: () => Effect.die(new Error("Unexpected binding transaction")),
    advanceBaseAndReceipt: () => Effect.die(new Error("Unexpected baseline transaction")),
    backup: () => Effect.die(new Error("Unexpected backup")),
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
  expect(restored.files).toEqual([...original.files].sort(fileOrder))
  const renamed = {
    ...snapshot,
    record: { ...snapshot.record, name: "HTTP Revised", alias: "http-revised" },
  }
  const edited = await run(snapshotPortable(renamed))
  const main = edited.files.find((file) => file.path === original.main)!
  const text = new TextDecoder().decode(main.bytes)
  expect(text).toContain('"name": "HTTP Revised"')
  expect(text).toContain('"compatibility": "Bun"')
  expect(text).toContain('"allowed-tools": ["Read","Bash"]')
  expect(text).not.toContain("notion_page_id")
  expect(edited.files.find((file) => file.path === "assets/data.bin")!.bytes).toEqual(
    original.files[2]!.bytes,
  )
})

for (const [label, actual, authored] of [
  [
    "an explicit filename URL changes scheme",
    "Read [SKILL.md](https://SKILL.md).\n",
    "Read [SKILL.md](http://SKILL.md).\n",
  ],
  [
    "an explicit host URL becomes plain text",
    "Read example.com.\n",
    "Read [example.com](https://example.com).\n",
  ],
] satisfies Array<[string, string, string]>) {
  test(`source export cannot reuse a lossy projection when ${label}`, async () => {
    const source: PortableSkill = {
      ...original,
      main: "SKILL.md",
      files: [
        canonicalMain(original.name, original.description, authored, {
          path: "SKILL.md",
          bytes: new Uint8Array(),
        }),
      ],
    }
    const local = (body: string) => rewritePageLinks(body, "SKILL.md", [], "local")
    expect(local(actual)).toBe(local(authored))
    const f = await fixture(source, {
      body: local(actual),
      projectionBody: local(authored),
    })
    const result = await f.run(
      snapshotAuthoredPortable({
        ...f.snapshot,
        references: [
          {
            id: "12345678-1234-1234-1234-123456789abc",
            path: "SKILL.md",
            markdown: actual,
          },
        ],
      }),
    )
    expect(result.files.find((file) => file.path === source.main)!.bytes).not.toEqual(
      source.files[0]!.bytes,
    )
  })
}

test("a historical snapshot cannot recover original source from a lossy projection alone", async () => {
  const authored = "Introduction.\n\n    keep code literal\n"
  const live = "Introduction.\n    keep code literal\n"
  expect(bodyIdentity(live)).toBe(bodyIdentity(authored))
  expect(samePublishedMarkdown(live, authored)).toBe(false)
  const source: PortableSkill = {
    ...original,
    main: "SKILL.md",
    files: [
      canonicalMain(original.name, original.description, authored, {
        path: "SKILL.md",
        bytes: new Uint8Array(),
      }),
    ],
  }
  const f = await fixture(source, {
    body: live,
    projectionBody: bodyIdentity(authored),
  })
  const changed = await f.run(snapshotAuthoredPortable(f.snapshot))
  expect(changed.files.find((file) => file.path === source.main)!.bytes).not.toEqual(
    source.files[0]!.bytes,
  )
  const changedWithRaw = await f.run(
    snapshotAuthoredPortable({
      ...f.snapshot,
      references: [
        {
          id: "12345678-1234-1234-1234-123456789abc",
          path: "SKILL.md",
          markdown: live,
        },
      ],
    }),
  )
  expect(changedWithRaw.files.find((file) => file.path === source.main)!.bytes).not.toEqual(
    source.files[0]!.bytes,
  )
  const unchanged = await f.run(
    snapshotAuthoredPortable({
      ...f.snapshot,
      references: [
        {
          id: "12345678-1234-1234-1234-123456789abc",
          path: "SKILL.md",
          markdown: authored,
        },
      ],
    }),
  )
  expect(unchanged.files.find((file) => file.path === source.main)!.bytes).toEqual(
    source.files[0]!.bytes,
  )
})

test("source export retains exact bytes for filename autolinks mixed with a known reference", async () => {
  const referenceId = "22222222-2222-4222-8222-222222222222"
  const authored = "Read SKILL.md and EXTEND.md, then [guide](./references/guide.md).\n"
  const actual = `Read [SKILL.md](http://SKILL.md) and [EXTEND.md](http://EXTEND.md), then [guide](https://app.notion.com/p/${referenceId.replaceAll("-", "")}).\n`
  const source: PortableSkill = {
    ...original,
    main: "SKILL.md",
    files: [
      canonicalMain(original.name, original.description, authored, {
        path: "SKILL.md",
        bytes: new Uint8Array(),
      }),
      { path: "references/guide.md", bytes: encode("# Guide\n") },
    ],
  }
  const references = [
    {
      id: "12345678-1234-1234-1234-123456789abc",
      path: "SKILL.md",
      markdown: actual,
    },
    { id: referenceId, path: "references/guide.md", markdown: "# Guide\n" },
  ]
  const local = rewritePageLinks(actual, "SKILL.md", references, "local")
  const f = await fixture(source, {
    body: local,
    projectionBody: bodyIdentity(authored),
  })
  const restored = await f.run(snapshotAuthoredPortable({ ...f.snapshot, references }))
  expect(restored.files).toEqual([...source.files].sort(fileOrder))
  expect(portableZip(restored)).toEqual(portableZip(source))

  const explicit: PortableSkill = {
    ...source,
    files: source.files.map((file) =>
      file.path === source.main
        ? canonicalMain(
            source.name,
            source.description,
            authored.replace("SKILL.md", "[SKILL.md](https://SKILL.md)"),
            file,
          )
        : file,
    ),
  }
  const g = await fixture(explicit, {
    body: local,
    projectionBody: bodyIdentity(authored),
  })
  const changed = await g.run(snapshotAuthoredPortable({ ...g.snapshot, references }))
  expect(changed.files.find((file) => file.path === source.main)!.bytes).not.toEqual(
    explicit.files[0]!.bytes,
  )
})

test("Notion spelling of an unchanged skill stays byte-identical across export", async () => {
  const markdown = [
    "> **来源**",
    "> 官方博客 > 转载",
    "",
    "| A | B |",
    "| --- | --- |",
    "| 1 | 2 |",
    "",
    "```",
    "keep",
    "```",
    "",
  ].join("\n")
  const skill: PortableSkill = {
    kind: "skill",
    name: original.name,
    description: original.description,
    main: "SKILL.md",
    files: [
      {
        path: "SKILL.md",
        bytes: encode(
          `---\nname: notion-spelling\ndescription: ${JSON.stringify(original.description)}\n---\n\n${markdown}`,
        ),
      },
    ],
  }
  const live = fromNotionMarkdown(
    [
      "> **来源**<br>官方博客 \\> 转载",
      '<table header-row="true">',
      "<tr><td>A</td><td>B</td></tr>",
      "<tr><td>1</td><td>2</td></tr>",
      "</table>",
      "```javascript",
      "keep",
      "```",
    ].join("\n"),
  )
  const { snapshot, run } = await fixture(skill, {
    body: live,
    projectionBody: bodyIdentity(markdown),
  })
  const restored = await run(snapshotPortable(snapshot))
  const authored = await run(snapshotAuthoredPortable(snapshot))
  expect(restored.files).toEqual(skill.files)
  expect(authored.files).toEqual(skill.files)
  expect(portableZip(restored)).toEqual(portableZip(skill))
  const changed = live.replace("转载", "改写")
  const diverged = await fixture(skill, {
    body: changed,
    projectionBody: bodyIdentity(markdown),
  })
  const rewritten = await diverged.run(snapshotPortable(diverged.snapshot))
  expect(rewritten.files).not.toEqual(skill.files)
})

test("native export excludes server identities and remains stable when reimported", async () => {
  const native = await fixture()
  const portable = await native.run(snapshotPortable(native.snapshot))
  const main = portable.files.find((file) => file.path === "SKILL.md")!
  expect(new TextDecoder().decode(main.bytes)).not.toContain("notion_page_id")
  expect(new TextDecoder().decode(main.bytes)).toContain('"name": "HTTP Workflow"')
  const imported = await fixture(portable)
  expect(portableZip(await imported.run(snapshotPortable(imported.snapshot)))).toEqual(
    portableZip(portable),
  )
  const otherIdentity = {
    ...native.snapshot,
    record: { ...native.snapshot.record, id: "notion_page:other-page" },
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
    exportSkill(fixtureData.snapshot.snapshot_id, {
      output: "/portable.zip",
    }).pipe(Effect.result),
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
      {
        path: ".ntn-skills.json",
        bytes: encode('{"format":"ntn-skills","version":2}'),
      },
    ]),
  ).toThrow(expect.objectContaining({ code: "INVALID_ARCHIVE" }))
  const once = canonicalMain(original.name, original.description, "# Content\n", {
    path: original.main,
    bytes: new Uint8Array(),
  })
  expect(new TextDecoder().decode(once.bytes)).not.toContain("notion_page_id")
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

async function routerFixture(preserveSource = true) {
  const f = await fixture()
  const authored =
    "# Route requests\n\nRead [guide](references/guide.md).\n\n## Members\n\nThis heading is authored prose.\n"
  const reference = original.files[1]!
  const asset = original.files[2]!
  const source: PortableSkill = {
    ...original,
    kind: "router",
    main: "路由.md",
    files: [
      {
        path: "路由.md",
        bytes: encode(
          `---\r\nname: http-workflow\r\ndescription: Original source metadata\r\ncompatibility: Bun\r\n---\r\n\r\n${authored.replace(/\n/g, "\r\n")}`,
        ),
      },
      reference,
      asset,
    ],
    projection: {
      name: original.name,
      description: original.description,
      body: bodyIdentity(authored),
      references: {
        [reference.path]: bodyIdentity(new TextDecoder().decode(reference.bytes)),
      },
    },
  }
  const snapshotFor = async (members: readonly string[], body = authored) => {
    const generated = `${body}\n## Members\n\n${members.map((member, index) => `- [Member ${index + 1}](skill://22222222-2222-4222-8222-22222222222${index}/SKILL.md) — ${member}`).join("\n")}\n`
    const files = [
      canonicalMain(original.name, original.description, generated, {
        path: "ROUTER.md",
        bytes: new Uint8Array(),
      }),
      {
        ...reference,
        bytes: encode(new TextDecoder().decode(reference.bytes).replace(/\n\n/g, "\n")),
      },
      asset,
      ...(preserveSource ? [{ path: BUNDLE, bytes: portableZip(source, true) }] : []),
    ]
    const entries = []
    for (const file of files) {
      const hash = await f.run(sha256(file.bytes))
      f.objects.set(`objects/${hash}`, file.bytes)
      entries.push({ path: file.path, bytes: file.bytes.length, sha256: hash })
    }
    return {
      ...f.snapshot,
      entrypoint: "ROUTER.md",
      record: {
        ...f.snapshot.record,
        kind: "router",
        entrypoint: "ROUTER.md",
        ref: "skill://12345678-1234-1234-1234-123456789abc/ROUTER.md",
      },
      files: entries,
      references: [
        {
          id: "12345678-1234-1234-1234-123456789abc",
          path: "ROUTER.md",
          markdown: body,
        },
        {
          id: "33333333-3333-4333-8333-333333333333",
          path: reference.path,
          markdown: new TextDecoder().decode(reference.bytes),
        },
      ],
    } satisfies Snapshot
  }
  return { ...f, authored, source, reference, asset, snapshotFor }
}

test("Router empty and two-member exports keep a dynamic index separate from byte-exact authored source", async () => {
  const f = await routerFixture()
  const empty = await f.snapshotFor([])
  const populated = await f.snapshotFor(["First member", "Second member"])
  const emptyExport = await f.run(snapshotPortable(empty))
  const populatedExport = await f.run(snapshotPortable(populated))
  expect(
    new TextDecoder().decode(
      emptyExport.files.find((file) => file.path === emptyExport.main)!.bytes,
    ),
  ).toContain("## Members\n")
  const generated = new TextDecoder().decode(
    populatedExport.files.find((file) => file.path === populatedExport.main)!.bytes,
  )
  expect(generated).toContain("First member")
  expect(generated).toContain("Second member")
  expect(empty.files.find((file) => file.path === empty.entrypoint)!.sha256).not.toBe(
    populated.files.find((file) => file.path === populated.entrypoint)!.sha256,
  )
  for (const snapshot of [empty, populated]) {
    const authored = await f.run(snapshotAuthoredPortable(snapshot))
    expect(authored.main).toBe(f.source.main)
    expect(authored.files).toEqual([...f.source.files].sort(fileOrder))
  }
  const identity = await f.run(portableIdentity(f.source))
  expect(await f.run(portableIdentity(emptyExport))).toBe(identity)
  expect(await f.run(portableIdentity(populatedExport))).toBe(identity)
  const restored = readPortable(readImportZip(portableZip(populatedExport)))!
  expect(
    new TextDecoder().decode(restored.files.find((file) => file.path === restored.main)!.bytes),
  ).toContain("Second member")
  expect(authoredPortable(restored).files).toEqual([...f.source.files].sort(fileOrder))
  expect(await f.run(portableIdentity(restored))).toBe(identity)
})

test("Router member metadata changes preserve authored source and its own references and assets", async () => {
  const f = await routerFixture()
  const first = await f.run(
    snapshotPortable(await f.snapshotFor(["Original metadata", "Second member"])),
  )
  const changed = await f.run(
    snapshotPortable(await f.snapshotFor(["Updated metadata", "Renamed member"])),
  )
  expect(first.files.find((file) => file.path === first.main)!.bytes).not.toEqual(
    changed.files.find((file) => file.path === changed.main)!.bytes,
  )
  expect(authoredPortable(first).files).toEqual([...f.source.files].sort(fileOrder))
  expect(authoredPortable(changed).files).toEqual([...f.source.files].sort(fileOrder))
  expect(await f.run(portableIdentity(changed))).toBe(await f.run(portableIdentity(first)))
  for (const resource of [f.reference, f.asset]) {
    const edited = {
      ...changed,
      files: changed.files.map((file) =>
        file.path === resource.path ? { ...file, bytes: encode("changed own resource") } : file,
      ),
    }
    expect(await f.run(portableIdentity(edited))).not.toBe(await f.run(portableIdentity(first)))
  }
})

test("Router authored body edits and replacement main bytes change identity despite saved projection metadata", async () => {
  const f = await routerFixture()
  const before = await f.run(snapshotPortable(await f.snapshotFor([])))
  const edited = await f.run(
    snapshotPortable(await f.snapshotFor([], "# Revised routing\n\nRead references/guide.md.\n")),
  )
  const identity = await f.run(portableIdentity(before))
  expect(await f.run(portableIdentity(edited))).not.toBe(identity)
  expect(
    new TextDecoder().decode(
      authoredPortable(edited).files.find((file) => file.path === edited.main)!.bytes,
    ),
  ).toContain("# Revised routing")
  const replacement = {
    path: before.main,
    bytes: encode("# Replacement routing\n"),
  }
  const replaced = {
    ...before,
    files: before.files.map((file) => (file.path === before.main ? replacement : file)),
  }
  expect(
    authoredPortable(replaced).files.find((file) => file.path === replaced.main)!.bytes,
  ).toEqual(replacement.bytes)
  expect(authoredPortable(replaced).projection!.body).toBe("# Replacement routing\n")
  expect(await f.run(portableIdentity(replaced))).not.toBe(identity)
  const restored = authoredPortable(readPortable(readImportZip(portableZip(replaced)))!)
  expect(restored.files.find((file) => file.path === restored.main)!.bytes).toEqual(
    replacement.bytes,
  )
})

test("native Router authored export excludes only its generated index and preserves own resources", async () => {
  const f = await routerFixture(false)
  const snapshot = await f.snapshotFor(["First member", "Second member"])
  const authored = await f.run(snapshotAuthoredPortable(snapshot))
  const generated = await f.run(snapshotPortable(snapshot))
  expect(authored.main).toBe(snapshot.entrypoint)
  const body = new TextDecoder().decode(
    authored.files.find((file) => file.path === authored.main)!.bytes,
  )
  expect(body).toContain("This heading is authored prose.")
  expect(body).not.toContain("First member")
  expect(body).not.toContain("Second member")
  expect(authored.files.find((file) => file.path === f.asset.path)!.bytes).toEqual(f.asset.bytes)
  expect(authored.files.some((file) => file.path === f.reference.path)).toBe(true)
  expect(await f.run(portableIdentity(generated))).toBe(await f.run(portableIdentity(authored)))
})

for (const path of ["references/guide.md", "assets/data.bin"]) {
  test(`Router own resource corruption fails before authored or generated export: ${path}`, async () => {
    const f = await routerFixture()
    const snapshot = await f.snapshotFor([])
    const resource = snapshot.files.find((file) => file.path === path)!
    f.objects.set(`objects/${resource.sha256}`, encode("corrupt cached own resource"))
    for (const operation of [snapshotAuthoredPortable(snapshot), snapshotPortable(snapshot)]) {
      const result = await f.run(operation.pipe(Effect.result))
      expect(result._tag === "Failure" && result.failure.code).toBe("STATE_CORRUPT")
    }
  })
}

test("portable materialization rejects non-Router hooks and malformed source text", () => {
  const source = {
    ...original,
    projection: {
      name: original.name,
      description: original.description,
      body: "# Authored",
      materialization: { authored: "# Authored", generated: "# Generated" },
    },
  }
  expect(() => readPortable(portableFiles(source, true))).toThrow("Invalid portable projection")
  const router = { ...source, kind: "router" as const }
  const files = portableFiles(router, true)
  const manifest = files.find((file) => file.path === ".ntn-skills.json")!
  const metadata = JSON.parse(new TextDecoder().decode(manifest.bytes))
  metadata.projection.materialization.authored = 42
  expect(() =>
    readPortable(
      files.map((file) =>
        file === manifest ? { ...file, bytes: encode(JSON.stringify(metadata)) } : file,
      ),
    ),
  ).toThrow("Invalid portable projection")
})

test("snapshot export preserves exact Router read bytes and every resource with verified inventory roles", async () => {
  const f = await routerFixture()
  const snapshot = await f.snapshotFor(["First member", "Second member"])
  Object.assign(f.snapshot, snapshot)
  const receipt = await f.run(
    exportSkill(snapshot.snapshot_id, {
      output: "/router-snapshot.zip",
      projection: "snapshot",
    }),
  )
  expect(receipt.projection).toBe("snapshot")
  expect(receipt.entrypoint).toBe(snapshot.entrypoint)
  expect(receipt.main_path).toBe(snapshot.entrypoint)
  expect(receipt.snapshot_id).toBe(snapshot.snapshot_id)
  const files = readImportZip(f.output.get("/router-snapshot.zip")!)
  expect(files.map((file) => file.path).sort()).toEqual(
    [...snapshot.files.map((file) => file.path), ".ntn-skills.json"].sort(),
  )
  for (const entry of snapshot.files) {
    const file = files.find((file) => file.path === entry.path)!
    expect(file.bytes).toEqual(f.objects.get(`objects/${entry.sha256}`)!)
    expect(receipt.files.find((file) => file.path === entry.path)).toEqual({
      path: entry.path,
      bytes: entry.bytes,
      hash: entry.sha256,
      role:
        entry.path === snapshot.entrypoint
          ? "entrypoint"
          : entry.path === BUNDLE
            ? "source_bundle"
            : "resource",
    })
  }
  const main = files.find((file) => file.path === snapshot.entrypoint)!
  expect(new TextDecoder().decode(main.bytes)).toContain("First member")
  expect(new TextDecoder().decode(main.bytes)).toContain("Second member")
  const manifest = files.find((file) => file.path === ".ntn-skills.json")!
  expect(JSON.parse(new TextDecoder().decode(manifest.bytes))).toMatchObject({
    version: 2,
    kind: "router",
    name: snapshot.record.name,
    description: snapshot.record.description,
    main: snapshot.entrypoint,
  })
  expect(receipt.files.find((file) => file.path === manifest.path)).toEqual({
    path: manifest.path,
    bytes: manifest.bytes.length,
    hash: await f.run(sha256(manifest.bytes)),
    role: "manifest",
  })
})

test("default source export restores original authored files without absorbing the generated index", async () => {
  const f = await routerFixture()
  const snapshot = await f.snapshotFor(["First member", "Second member"])
  Object.assign(f.snapshot, snapshot)
  const receipt = await f.run(exportSkill(snapshot.snapshot_id, { output: "/router-source.zip" }))
  const restored = readPortable(readImportZip(f.output.get("/router-source.zip")!))!
  expect(receipt.projection).toBe("source")
  expect(receipt.main_path).toBe(f.source.main)
  expect(restored.files).toEqual([...f.source.files].sort(fileOrder))
  expect(receipt.content_id).toBe(await f.run(portableIdentity(f.source)))
})

for (const [kind, main] of [
  ["skill", "SKILL.md"],
  ["prompt", "PROMPT.md"],
] as const) {
  test(`${kind} snapshot export uses its dynamic entrypoint and exact cached bytes`, async () => {
    const f = await fixture()
    const entry = f.snapshot.files.find((file) => file.path === f.snapshot.entrypoint)!
    Object.assign(f.snapshot, {
      entrypoint: main,
      record: { ...f.snapshot.record, kind, entrypoint: main },
      files: f.snapshot.files.map((file) => (file === entry ? { ...file, path: main } : file)),
    })
    const receipt = await f.run(
      exportSkill(f.snapshot.snapshot_id, {
        output: `/snapshot-${kind}.zip`,
        projection: "snapshot",
      }),
    )
    const files = readImportZip(f.output.get(`/snapshot-${kind}.zip`)!)
    expect(files.find((file) => file.path === main)!.bytes).toEqual(
      f.objects.get(`objects/${entry.sha256}`)!,
    )
    expect(receipt.main_path).toBe(main)
    expect(receipt.files.find((file) => file.role === "entrypoint")!.path).toBe(main)
  })
}

test("snapshot export rejects corrupted own resources before writing an archive", async () => {
  const f = await routerFixture()
  const snapshot = await f.snapshotFor([])
  Object.assign(f.snapshot, snapshot)
  const resource = snapshot.files.find((file) => file.path === f.asset.path)!
  f.objects.set(`objects/${resource.sha256}`, new Uint8Array([0, 255, 8]))
  const result = await f.run(
    exportSkill(snapshot.snapshot_id, {
      output: "/corrupted-router.zip",
      projection: "snapshot",
    }).pipe(Effect.result),
  )
  expect(result._tag === "Failure" && result.failure.code).toBe("STATE_CORRUPT")
  expect(f.output.size).toBe(0)
})

test("Router source export requires an authored root instead of accepting the generated index as source", async () => {
  const f = await routerFixture()
  const snapshot = await f.snapshotFor(["First member", "Second member"])
  const result = await f.run(
    snapshotAuthoredPortable({ ...snapshot, references: [] }).pipe(Effect.result),
  )
  expect(result._tag === "Failure" && result.failure.code).toBe("INVALID_CONTENT_SOURCE")
})

async function projectedFixture() {
  const source: PortableSkill = {
    ...original,
    files: original.files.map((file) =>
      file.path === "references/guide.md"
        ? {
            ...file,
            bytes: encode("Read [peer](../../peer/references/detail.md).\n"),
          }
        : file,
    ),
  }
  const f = await fixture(source)
  const sourceFiles = [...f.snapshot.files]
  const files = [...sourceFiles]
  const projected = []
  for (const file of [
    {
      path: "SKILL.md",
      bytes: canonicalMain(
        source.name,
        source.description,
        "Read [peer](skill://22222222-2222-4222-8222-222222222222/SKILL.md).\n",
        { path: "SKILL.md", bytes: new Uint8Array() },
      ).bytes,
    },
    {
      path: "references/guide.md",
      bytes: encode(
        "Read [peer](skill://22222222-2222-4222-8222-222222222222/references/detail.md).\n",
      ),
    },
  ]) {
    const digest = await f.run(sha256(file.bytes))
    f.objects.set(`objects/${digest}`, file.bytes)
    const prior = sourceFiles.find((entry) => entry.path === file.path)
    const originalFile = source.files.find((entry) => entry.path === file.path)
    const sourceHash = prior?.sha256 ?? (await f.run(sha256(originalFile!.bytes)))
    if (!prior) {
      f.objects.set(`objects/${sourceHash}`, originalFile!.bytes)
      sourceFiles.push({
        path: file.path,
        bytes: originalFile!.bytes.length,
        sha256: sourceHash,
      })
    }
    const entry = { path: file.path, bytes: file.bytes.length, sha256: digest }
    const index = files.findIndex((value) => value.path === file.path)
    if (index < 0) files.push(entry)
    else files[index] = entry
    projected.push({
      path: file.path,
      source_hash: sourceHash,
      derived_hash: digest,
    })
  }
  Object.assign(f.snapshot, {
    files,
    source_files: sourceFiles,
    source_projection: {
      source_id: "source",
      revision: "commit",
      manifest_hash: "manifest",
      files: projected,
    },
  })
  return { ...f, source }
}

test("member source projection preserves the exact portable source while generated exports use derived files", async () => {
  const f = await projectedFixture()
  const restored = await f.run(snapshotAuthoredPortable(f.snapshot))
  expect(restored.files).toEqual([...f.source.files].sort(fileOrder))
  expect(portableZip(restored)).toEqual(portableZip(f.source))
  const projected = await f.run(snapshotPortable(f.snapshot))
  expect(projected.main).toBe(f.snapshot.entrypoint)
  expect(projected.files.map((file) => file.path)).toEqual(
    f.snapshot.files.map((file) => file.path),
  )
  for (const file of projected.files)
    expect(file.bytes).toEqual(
      f.objects.get(
        `objects/${f.snapshot.files.find((entry) => entry.path === file.path)!.sha256}`,
      )!,
    )
  expect(
    new TextDecoder().decode(
      projected.files.find((file) => file.path === "references/guide.md")!.bytes,
    ),
  ).toContain("skill://22222222")
  expect(projected.files.find((file) => file.path === BUNDLE)!.bytes).toEqual(
    f.objects.get(
      `objects/${f.snapshot.source_files!.find((file) => file.path === BUNDLE)!.sha256}`,
    )!,
  )
})

test("source and snapshot ZIP export select original and derived member bytes independently", async () => {
  const f = await projectedFixture()
  await f.run(exportSkill(f.snapshot.snapshot_id, { output: "/member-source.zip" }))
  const source = readPortable(readImportZip(f.output.get("/member-source.zip")!))!
  expect(source.files).toEqual([...f.source.files].sort(fileOrder))
  await f.run(
    exportSkill(f.snapshot.snapshot_id, {
      output: "/member-snapshot.zip",
      projection: "snapshot",
    }),
  )
  const derived = readImportZip(f.output.get("/member-snapshot.zip")!)
  for (const file of f.snapshot.files)
    expect(derived.find((entry) => entry.path === file.path)!.bytes).toEqual(
      f.objects.get(`objects/${file.sha256}`)!,
    )
})

test("source export checks the original objects retained alongside a member projection", async () => {
  const f = await projectedFixture()
  const originalMain = f.snapshot.source_files!.find((file) => file.path === "SKILL.md")!
  f.objects.set(`objects/${originalMain.sha256}`, encode("tampered original"))
  const result = await f.run(snapshotAuthoredPortable(f.snapshot).pipe(Effect.result))
  expect(result._tag === "Failure" && result.failure.code).toBe("STATE_CORRUPT")
  const derived = await f.run(snapshotPortable(f.snapshot))
  expect(
    new TextDecoder().decode(derived.files.find((file) => file.path === "SKILL.md")!.bytes),
  ).toContain("skill://22222222")
})
