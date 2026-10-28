import { expect, test } from "bun:test"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, Layer, Schema } from "effect"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { portableFiles } from "../src/portable.ts"
import { PlanItemSchema } from "../src/upstream-model.ts"
import {
  discoverSource,
  SourceSnapshotSchema,
  type DiscoverSourceInput,
} from "../src/upstream-source.ts"

const services = Layer.merge(NodeServices.layer, NodeHttpClient.layerFetch)
const utf8 = new TextEncoder()
const key = "skills/alpha"
const skill =
  "---\nname: alpha\ndescription: Use when exercising contained Git links\n---\n\nRead workbench/demosrc/example.txt.\n"
const binary = new Uint8Array([0, 255, 128, 1, 13, 10, 0])

function git(directory: string, args: readonly string[]) {
  return execFileSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Source Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "Source Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.test",
    },
  }).trim()
}
async function repository(operation: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "ntn-contained-links-test-"))
  try {
    git(directory, ["init", "-b", "main"])
    await put(directory, `${key}/SKILL.md`, skill)
    await operation(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
async function put(directory: string, path: string, contents: string | Uint8Array) {
  await mkdir(join(directory, path, ".."), { recursive: true })
  await writeFile(join(directory, path), contents)
}
async function link(directory: string, path: string, target: string) {
  await mkdir(join(directory, path, ".."), { recursive: true })
  await symlink(target, join(directory, path))
}
function commit(directory: string) {
  git(directory, ["add", "."])
  git(directory, ["commit", "--no-gpg-sign", "-m", "controlled contained links"])
  return git(directory, ["rev-parse", "HEAD"])
}
function input(
  directory: string,
  overrides: Partial<DiscoverSourceInput> = {},
): DiscoverSourceInput {
  return {
    source: { type: "git", url: directory, ref: "main" },
    roots: [key],
    include: [],
    exclude: [],
    mapping: {},
    ...overrides,
  }
}
function discover(input: DiscoverSourceInput) {
  return Effect.runPromise(discoverSource(input).pipe(Effect.provide(services)))
}
function result(input: DiscoverSourceInput) {
  return Effect.runPromise(discoverSource(input).pipe(Effect.result, Effect.provide(services)))
}
function hash(bytes: string | Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}
function hashFiles(files: readonly { path: string; bytes: Uint8Array }[]) {
  const entries = [...files]
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    .map((file) => [file.path, file.bytes.length, hash(file.bytes)])
  return hash(JSON.stringify(entries))
}
function files(entries: Readonly<Record<string, string | Uint8Array>>) {
  return Object.entries(entries)
    .map(([path, bytes]) => ({
      path,
      bytes: typeof bytes === "string" ? utf8.encode(bytes) : bytes,
    }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
}
function oid(directory: string, revision: string, path: string) {
  return git(directory, ["rev-parse", `${revision}:${key}/${path}`])
}

async function containedFixture(directory: string) {
  await put(directory, `${key}/payload.txt`, "accepted payload\n")
  await put(directory, `${key}/demos/example.txt`, "accepted example\n")
  await put(directory, `${key}/demos/assets/data.bin`, binary)
  await put(directory, `${key}/shared/note.txt`, "nested contained bytes\n")
  await link(directory, `${key}/demos/nested`, "../shared")
  await link(directory, `${key}/workbench/demosrc`, "../demos")
  await link(directory, `${key}/workbench/file.txt`, "../payload.txt")
  return commit(directory)
}

const rawFiles = files({
  "SKILL.md": skill,
  "payload.txt": "accepted payload\n",
  "demos/example.txt": "accepted example\n",
  "demos/assets/data.bin": binary,
  "shared/note.txt": "nested contained bytes\n",
  "demos/nested": "../shared",
  "workbench/demosrc": "../demos",
  "workbench/file.txt": "../payload.txt",
})
const materializedFiles = files({
  "SKILL.md": skill,
  "payload.txt": "accepted payload\n",
  "demos/example.txt": "accepted example\n",
  "demos/assets/data.bin": binary,
  "shared/note.txt": "nested contained bytes\n",
  "demos/nested/note.txt": "nested contained bytes\n",
  "workbench/demosrc/example.txt": "accepted example\n",
  "workbench/demosrc/assets/data.bin": binary,
  "workbench/demosrc/nested/note.txt": "nested contained bytes\n",
  "workbench/file.txt": "accepted payload\n",
})

test("contained directory, file and nested Git links retain raw identity and materialize exportable bytes", async () => {
  await repository(async (directory) => {
    const revision = await containedFixture(directory)
    const snapshot = await discover(input(directory))
    expect(snapshot.revision).toBe(revision)
    expect(snapshot.members).toHaveLength(1)
    const member = snapshot.members[0]!
    expect(member.portable.files).toEqual(materializedFiles)
    expect(member.upstream_hash).toBe(hashFiles(rawFiles))
    expect(member.git_materialization).toBeDefined()
    const materialization = member.git_materialization!
    const decodedSnapshot = Schema.decodeUnknownSync(SourceSnapshotSchema)(
      structuredClone(snapshot),
    )
    expect(decodedSnapshot.members[0]!.git_materialization).toEqual(materialization)
    const decodedPlanItem = Schema.decodeUnknownSync(PlanItemSchema)(
      JSON.parse(
        JSON.stringify({
          member_key: key,
          target_key: "alpha",
          action: "create",
          reason: "source",
          generation: 0,
          upstream_hash: member.upstream_hash,
          git_materialization: materialization,
          deltas: [],
        }),
      ),
    )
    expect(decodedPlanItem.git_materialization).toEqual(materialization)
    expect(materialization.source_hash).toBe(member.upstream_hash)
    expect(materialization.derived_hash).toBe(hashFiles(materializedFiles))
    expect(materialization.derived_hash).not.toBe(member.upstream_hash)
    expect(materialization.links).toHaveLength(3)
    for (const [path, target, resolved] of [
      ["demos/nested", "../shared", "shared"],
      ["workbench/demosrc", "../demos", "demos"],
      ["workbench/file.txt", "../payload.txt", "payload.txt"],
    ] as const) {
      expect(materialization.links.find((entry) => entry.path === path)).toEqual({
        path,
        target,
        resolved_path: `${key}/${resolved}`,
        declared_git_oid: oid(directory, revision, path),
        source_hash: hash(target),
      })
    }
    expect(materialization.files).toHaveLength(materializedFiles.length)
    for (const [path, declared, source, bytes] of [
      ["SKILL.md", "SKILL.md", "SKILL.md", skill],
      ["payload.txt", "payload.txt", "payload.txt", "accepted payload\n"],
      ["demos/example.txt", "demos/example.txt", "demos/example.txt", "accepted example\n"],
      ["demos/assets/data.bin", "demos/assets/data.bin", "demos/assets/data.bin", binary],
      ["shared/note.txt", "shared/note.txt", "shared/note.txt", "nested contained bytes\n"],
      ["demos/nested/note.txt", "demos/nested", "shared/note.txt", "nested contained bytes\n"],
      ["workbench/demosrc/assets/data.bin", "workbench/demosrc", "demos/assets/data.bin", binary],
      [
        "workbench/demosrc/nested/note.txt",
        "workbench/demosrc",
        "shared/note.txt",
        "nested contained bytes\n",
      ],
      [
        "workbench/demosrc/example.txt",
        "workbench/demosrc",
        "demos/example.txt",
        "accepted example\n",
      ],
      ["workbench/file.txt", "workbench/file.txt", "payload.txt", "accepted payload\n"],
    ] as const) {
      expect(materialization.files.find((entry) => entry.path === path)).toEqual({
        path,
        declared_git_oid: oid(directory, revision, declared),
        source_path: `${key}/${source}`,
        source_git_oid: oid(directory, revision, source),
        materialized_file_hash: hash(bytes),
      })
    }
    const exported = await mkdtemp(join(tmpdir(), "ntn-contained-links-export-"))
    try {
      // Export only the portable bytes; never execute an upstream business script.
      for (const file of portableFiles(member.portable)) await put(exported, file.path, file.bytes)
      expect((await lstat(join(exported, "workbench/demosrc"))).isDirectory()).toBe(true)
      expect((await lstat(join(exported, "workbench/demosrc/example.txt"))).isFile()).toBe(true)
      expect((await lstat(join(exported, "workbench/file.txt"))).isSymbolicLink()).toBe(false)
      const output = execFileSync(
        "node",
        [
          "--input-type=module",
          "-e",
          'import { readFileSync } from "node:fs"; process.stdout.write(readFileSync("workbench/demosrc/example.txt"));',
        ],
        { cwd: exported, encoding: "utf8" },
      )
      expect(output).toBe("accepted example\n")
    } finally {
      await rm(exported, { recursive: true, force: true })
    }
  })
})

test("accepted_ref fixes contained link bytes and provenance despite a newer commit and dirty local files", async () => {
  await repository(async (directory) => {
    const accepted = await containedFixture(directory)
    const before = await discover(input(directory, { accepted_ref: accepted }))
    await put(directory, `${key}/payload.txt`, "new committed payload\n")
    await put(directory, `${key}/demos/example.txt`, "new committed example\n")
    await put(directory, `${key}/demos/new.txt`, "new committed file\n")
    const newer = commit(directory)
    await put(directory, `${key}/SKILL.md`, "dirty invalid metadata")
    await put(directory, `${key}/payload.txt`, "dirty tracked payload")
    await put(directory, `${key}/demos/untracked.txt`, "untracked local bytes")
    await rm(join(directory, key, "workbench/demosrc"))
    await put(directory, `${key}/workbench/demosrc/example.txt`, "dirty replacement directory")
    const fixed = await discover(input(directory, { accepted_ref: accepted }))
    const latest = await discover(input(directory))
    expect(fixed.revision).toBe(accepted)
    expect(fixed.members).toEqual(before.members)
    expect(fixed.members[0]!.portable.files).toEqual(materializedFiles)
    expect(fixed.members[0]!.upstream_hash).toBe(hashFiles(rawFiles))
    expect(latest.revision).toBe(newer)
    expect(latest.members[0]!.upstream_hash).not.toBe(fixed.members[0]!.upstream_hash)
    expect(
      latest.members[0]!.portable.files.find(
        (file) => file.path === "workbench/demosrc/example.txt",
      )?.bytes,
    ).toEqual(utf8.encode("new committed example\n"))
    expect(
      latest.members[0]!.portable.files.some((file) => file.path.endsWith("untracked.txt")),
    ).toBe(false)
  })
})

test("contained Git link chains resolve intermediate links from pinned blobs", async () => {
  await repository(async (directory) => {
    await put(directory, `${key}/demos/example.txt`, "terminal pinned bytes\n")
    await link(directory, `${key}/workbench/demosrc`, "../demos")
    await link(directory, `${key}/workbench/alias`, "demosrc")
    await link(directory, `${key}/file-alias`, "workbench/alias/example.txt")
    commit(directory)
    const member = (await discover(input(directory))).members[0]!
    for (const path of [
      "workbench/demosrc/example.txt",
      "workbench/alias/example.txt",
      "file-alias",
    ])
      expect(member.portable.files.find((file) => file.path === path)?.bytes).toEqual(
        utf8.encode("terminal pinned bytes\n"),
      )
    expect(member.git_materialization!.links).toHaveLength(3)
  })
})

for (const fixture of [
  {
    name: "escape into an existing sibling member",
    path: "leak",
    target: "../outside/secret.txt",
    code: "GIT_LINK_ESCAPE",
  },
  { name: "absolute target", path: "leak", target: "/etc/passwd", code: "GIT_LINK_ABSOLUTE" },
  {
    name: "directory link to its ancestor",
    path: "workbench/demosrc",
    target: "..",
    code: "GIT_LINK_OVERLAP",
  },
  {
    name: "directory link to its own parent",
    path: "workbench/demosrc",
    target: ".",
    code: "GIT_LINK_OVERLAP",
  },
  { name: "link to itself", path: "self", target: "self", code: "GIT_LINK_OVERLAP" },
]) {
  test(`Git materialization rejects ${fixture.name} with a typed failure`, async () => {
    await repository(async (directory) => {
      await put(directory, "skills/outside/secret.txt", "outside the selected member\n")
      await link(directory, `${key}/${fixture.path}`, fixture.target)
      commit(directory)
      expect(await result(input(directory))).toMatchObject({
        _tag: "Failure",
        failure: { code: `UPSTREAM_${fixture.code}` },
      })
    })
  })
}

test("Git materialization rejects repeated links in a chain as a cycle", async () => {
  await repository(async (directory) => {
    await link(directory, `${key}/first`, "second")
    await link(directory, `${key}/second`, "first")
    commit(directory)
    expect(await result(input(directory))).toMatchObject({
      _tag: "Failure",
      failure: { code: "UPSTREAM_GIT_LINK_CYCLE" },
    })
  })
})

test("Git materialization rejects a real gitlink without traversing a submodule", async () => {
  await repository(async (directory) => {
    const revision = commit(directory)
    git(directory, ["update-index", "--add", "--cacheinfo", `160000,${revision},${key}/vendor`])
    git(directory, ["commit", "--no-gpg-sign", "-m", "controlled gitlink"])
    expect(git(directory, ["ls-tree", "HEAD", `${key}/vendor`])).toBe(
      `160000 commit ${revision}\t${key}/vendor`,
    )
    expect(await result(input(directory))).toMatchObject({
      _tag: "Failure",
      failure: { code: "UPSTREAM_GIT_LINK_SUBMODULE" },
    })
  })
})

test("Git materialization rejects a contained link chain deeper than 64", async () => {
  await repository(async (directory) => {
    await put(directory, `${key}/terminal.txt`, "terminal bytes\n")
    for (let index = 0; index < 65; index++) {
      const path = `link-${String(index).padStart(2, "0")}`
      const target = index === 64 ? "terminal.txt" : `link-${String(index + 1).padStart(2, "0")}`
      await link(directory, `${key}/${path}`, target)
    }
    commit(directory)
    expect(await result(input(directory))).toMatchObject({
      _tag: "Failure",
      failure: { code: "UPSTREAM_GIT_LINK_DEPTH" },
    })
  })
})
