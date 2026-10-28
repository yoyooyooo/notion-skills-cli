import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect } from "effect"
import { fail, type Snapshot } from "../src/model.ts"
import { Store } from "../src/store.ts"
import {
  BUNDLE,
  bodyIdentity,
  canonicalMain,
  portableZip,
  type PortableSkill,
} from "../src/portable.ts"
import { fromNotionMarkdown, projectNotionBlocks } from "../src/markdown.ts"
import { portableIdentity, snapshotAuthoredPortable } from "../src/export.ts"
import { integrityRepositoryFixture, upstreamRepositoryFixture } from "./fixtures.ts"

const page = "11111111-1111-4111-8111-111111111111"
const name = "Retained source proof",
  description = "Use complete live page evidence to preserve source files."
const target =
  "Read HTML-REPORT.md and [report](HTML-REPORT.md).\n\nA short status.\n\n---\n\n## Next\n\nReady."
const encoder = new TextEncoder(),
  hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const rich = (content: string, url: string | null = null) => ({
  type: "text",
  text: { content, link: url === null ? null : { url } },
  annotations: {
    bold: false,
    italic: false,
    strikethrough: false,
    underline: false,
    code: false,
    color: "default",
  },
})
const block = (id: string, type: string, spans: ReturnType<typeof rich>[] = []) => ({
  id,
  type,
  has_children: false,
  parent: { type: "page_id", page_id: page },
  [type]: { rich_text: spans },
})
function fixture(
  options: {
    source?: string
    url?: string
    extraLive?: boolean
    projectionName?: string
    projectionBody?: string
    corruptSidecar?: boolean
  } = {},
) {
  const url = options.url ?? "http://HTML-REPORT.md",
    sourceBody = options.source ?? target
  const actual =
    `Read [HTML-REPORT.md](${url}) and [report](${url}).\nA short status.\n---\n## Next\nReady.` +
    (options.extraLive ? "\n\nUnsubmitted instruction." : "")
  const roots = [
    block("intro", "paragraph", [
      rich("Read "),
      rich("HTML-REPORT.md", url),
      rich(" and "),
      rich("report", url),
      rich("."),
    ]),
    block("status", "paragraph", [rich("A short status.")]),
    block("divider", "divider"),
    block("next", "heading_2", [rich("Next")]),
    block("ready", "paragraph", [rich("Ready.")]),
    ...(options.extraLive ? [block("extra", "paragraph", [rich("Unsubmitted instruction.")])] : []),
  ]
  const blocks = projectNotionBlocks(roots)
  if (!blocks) throw new Error("Complete test block evidence required")
  const portable: PortableSkill = {
    kind: "skill",
    name,
    description,
    main: "SKILL.md",
    files: [
      {
        path: "SKILL.md",
        bytes: encoder.encode(
          `---\nname: ${name}\ndescription: ${description}\nallowed-tools: Bash\n---\n\n${sourceBody}\n`,
        ),
      },
      {
        path: "HTML-REPORT.md",
        bytes: encoder.encode("# Original retained report\n\nKeep these bytes.\n"),
      },
      {
        path: "agents/openai.yaml",
        bytes: encoder.encode("interface:\n  display_name: Original source\n"),
      },
    ],
  }
  const liveBody = fromNotionMarkdown(actual, blocks)
  const storedSource: PortableSkill = {
    ...portable,
    files: options.corruptSidecar
      ? portable.files.map((file) =>
          file.path === "agents/openai.yaml"
            ? { ...file, bytes: encoder.encode("interface:\n  display_name: Changed source\n") }
            : file,
        )
      : portable.files,
    projection: {
      name: options.projectionName ?? name,
      description,
      body: options.projectionBody ?? bodyIdentity(liveBody),
      references: {},
    },
  }
  const files = [
    canonicalMain(name, description, liveBody, { path: "SKILL.md", bytes: new Uint8Array() }),
    { path: BUNDLE, bytes: portableZip(storedSource, true) },
    ...storedSource.files.filter((file) => file.path !== portable.main),
  ]
  const objects = new Map(files.map((file) => ["objects/" + hash(file.bytes), file.bytes]))
  let writes = 0
  const denied = () => {
    writes++
    return Effect.fail(fail("TEST_WRITE_FORBIDDEN", "Source export must not mutate the store."))
  }
  const store: Store["Service"] = {
    root: "/unused",
    cacheRoot: "/unused",
    configRoot: "/unused",
    upstream: upstreamRepositoryFixture(),
    integrity: integrityRepositoryFixture(),
    readJson: () => Effect.succeed(undefined),
    readBytes: (key) =>
      objects.has(key)
        ? Effect.succeed(new Uint8Array(objects.get(key)!))
        : Effect.fail(fail("STATE_CORRUPT", "Missing test bytes.")),
    writeJson: denied,
    writeBytes: denied,
    reserveCacheGeneration: denied,
    listKeys: denied,
    retireKeys: denied,
    registerBindingWithBase: denied,
    advanceBaseAndReceipt: denied,
    backup: denied,
    output: denied,
  }
  const snapshot: Snapshot = {
    snapshot_id: "source-export",
    scope: "test",
    version_id: "test",
    created_at: 0,
    entrypoint: "SKILL.md",
    record: {
      id: `notion_page:${page}`,
      kind: "skill",
      locator: { type: "notion_page", page_id: page, database_id: "db", data_source_id: "ds" },
      name,
      alias: "retained-source-proof",
      description,
      default_context: false,
      entrypoint: "SKILL.md",
      ref: `skill://${page}/SKILL.md`,
    },
    files: files.map((file) => ({
      path: file.path,
      sha256: hash(file.bytes),
      bytes: file.bytes.length,
    })),
    references: [{ id: page, path: "SKILL.md", markdown: actual, blocks }],
  }
  return { portable, snapshot, store, roots, objects, writes: () => writes }
}
const run = <A, E>(
  effect: Effect.Effect<A, E, NodeServices.NodeServices | Store>,
  store: Store["Service"],
) =>
  Effect.runPromise(
    effect.pipe(Effect.provideService(Store, store), Effect.provide(NodeServices.layer)),
  )
async function exported(f: ReturnType<typeof fixture>, snapshot = f.snapshot) {
  const value = await run(snapshotAuthoredPortable(snapshot), f.store)
  const same =
    (await run(portableIdentity(value), f.store)) ===
    (await run(portableIdentity(f.portable), f.store))
  expect(f.writes()).toBe(0)
  return { value, same }
}

test("fresh complete physical evidence preserves every original source file byte through the real ZIP reader", async () => {
  const f = fixture(),
    before = JSON.stringify({ portable: f.portable, snapshot: f.snapshot })
  const result = await exported(f)
  expect(result.same).toBe(true)
  expect(result.value.files.map((file) => file.path).sort()).toEqual(
    f.portable.files.map((file) => file.path).sort(),
  )
  for (const original of f.portable.files)
    expect(result.value.files.find((file) => file.path === original.path)?.bytes).toEqual(
      original.bytes,
    )
  expect(JSON.stringify({ portable: f.portable, snapshot: f.snapshot })).toBe(before)
})

test("projection body is only retained metadata and cannot stand in for fresh source body proof", async () => {
  expect((await exported(fixture({ projectionBody: "obsolete projection identity" }))).same).toBe(
    true,
  )
  expect(
    (
      await exported(
        fixture({
          source: target + "\n\nRequired omitted instruction.",
          projectionBody: bodyIdentity(target),
        }),
      )
    ).same,
  ).toBe(false)
  expect(
    (await exported(fixture({ extraLive: true, projectionBody: bodyIdentity(target) }))).same,
  ).toBe(false)
})

test("source bytes are not recovered without the current physical roots and their divider", async () => {
  const f = fixture(),
    page = f.snapshot.references![0]!
  expect(
    (await exported(f, { ...f.snapshot, references: [{ ...page, blocks: undefined }] })).same,
  ).toBe(false)
  expect((await exported(f, { ...f.snapshot, references: undefined })).same).toBe(false)
  expect(
    (
      await exported(f, {
        ...f.snapshot,
        references: [{ ...page, blocks: page.blocks!.filter((block) => block.type !== "divider") }],
      })
    ).same,
  ).toBe(false)
})

test("the existing relative filename policy cannot erase a port, path, query, fragment, credentials, or case", async () => {
  for (const url of [
    "http://HTML-REPORT.md:8080",
    "http://HTML-REPORT.md/other",
    "http://HTML-REPORT.md?x=1",
    "http://HTML-REPORT.md#part",
    "http://user@HTML-REPORT.md",
    "http://html-report.md",
  ]) {
    expect((await exported(fixture({ url }))).same).toBe(false)
  }
})

test("explicit original external URLs preserve their exact scheme and destination components", async () => {
  for (const url of [
    "https://HTML-REPORT.md",
    "http://HTML-REPORT.md/path",
    "http://HTML-REPORT.md?x=1",
    "http://HTML-REPORT.md#part",
  ]) {
    expect(
      (await exported(fixture({ source: target.replace("](HTML-REPORT.md)", `](${url})`) }))).same,
    ).toBe(false)
  }
})

test("unproven source metadata and altered sidecars remain distinct from the submitted source identity", async () => {
  expect((await exported(fixture({ projectionName: "Another skill" }))).same).toBe(false)
  expect((await exported(fixture({ corruptSidecar: true }))).same).toBe(false)
  const f = fixture()
  expect(
    (
      await exported(f, {
        ...f.snapshot,
        record: { ...f.snapshot.record, name: "Changed live title" },
      })
    ).same,
  ).toBe(false)
})

test("a source object checksum failure remains an export failure", async () => {
  const f = fixture(),
    bundle = f.snapshot.files.find((file) => file.path === BUNDLE)!
  const original = f.objects.get("objects/" + bundle.sha256)!
  f.objects.set("objects/" + bundle.sha256, new Uint8Array([...original, 0]))
  const result = await run(snapshotAuthoredPortable(f.snapshot).pipe(Effect.result), f.store)
  expect(result._tag).toBe("Failure")
  if (result._tag === "Failure")
    expect("code" in result.failure ? result.failure.code : undefined).toBe("STATE_CORRUPT")
  expect(f.writes()).toBe(0)
})
