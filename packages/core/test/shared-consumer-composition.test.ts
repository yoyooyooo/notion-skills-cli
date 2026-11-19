import { expect, test } from "bun:test"
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { property } from "../src/model.ts"
import { trashPath } from "../src/local-locks.ts"
import { fileRef } from "../src/ref.ts"
import { readSkill } from "../src/snapshot.ts"
import { bindSharedLocalResource } from "../src/shared-source-config.ts"
import {
  currentBytes as bytes,
  currentDigest as digest,
  currentRich as rich,
} from "./shared-current-fixture.ts"
import {
  currentSourceConsumerFixture,
  sourceLibrary,
  type SourceFile,
} from "./shared-current-source-consumer-fixture.ts"

const binary = new Uint8Array([255, 0, 128, 13, 10, 0])

test("a mixed current tree lists every File and downloads only selected Source bytes", async () => {
  const f = await currentSourceConsumerFixture()
  const large = Uint8Array.from({ length: 131_077 }, (_, n) => n % 251)
  const unbound = bytes("Provider content without a current File must not enter this Skill.\n")
  const files: readonly SourceFile[] = [
    { path: "a.bin", bytes: binary, mode: "100644" },
    { path: "b.bin", bytes: large, mode: "100755" },
    { path: "unbound.md", bytes: unbound, mode: "100644" },
  ]
  await f.select(files)
  f.native("SKILL.md", "# Mixed current author\n")
  f.native("references/guide.md", "# Native guide\n")
  f.bind("assets/a.bin", "a.bin")
  f.bind("assets/b.bin", "b.bin")
  const directory = await f.target({}, "manifest")
  expect(directory.files.map((file) => file.path)).toEqual([
    "SKILL.md",
    "assets/a.bin",
    "assets/b.bin",
    "references/guide.md",
  ])
  expect(f.requests).toEqual([])
  const selected = await f.target({}, "target", "assets/a.bin")
  expect(selected.snapshot_id).toBe(directory.snapshot_id)
  expect(f.bytes(selected, "assets/a.bin")).toEqual(binary)
  expect(f.requests).toHaveLength(1)
  expect(f.objects.has(`objects/${digest(large)}`)).toBe(false)
  f.clearCalls()
  const all = await f.target({}, "all")
  expect(all.snapshot_id).toBe(directory.snapshot_id)
  expect(f.bytes(all, "assets/b.bin")).toEqual(large)
  expect(all.files.find((file) => file.path === "assets/b.bin")?.mode).toBe("100755")
  expect(f.requests).toHaveLength(2)
  expect(f.objects.has(`objects/${digest(unbound)}`)).toBe(false)
  expect(f.bodyCalls()).toHaveLength(0)
  expect(f.semanticWrites()).toHaveLength(0)
})

test("a partial provider response cannot publish a complete current snapshot or change Notion", async () => {
  const f = await currentSourceConsumerFixture()
  await f.select([{ path: "a.bin", bytes: binary, mode: "100644" }])
  f.bind("assets/a.bin", "a.bin")
  f.response(
    (_url, value) =>
      new Response(value!.slice(0, 2), { headers: { "content-length": String(binary.length) } }),
  )
  const source = structuredClone(f.source)
  f.clearCalls()
  await expect(f.target()).rejects.toMatchObject({ code: "FIXED_RESOURCE_SIZE_MISMATCH" })
  expect(f.requests).toHaveLength(1)
  expect(f.semanticWrites()).toHaveLength(0)
  expect([...f.json.keys()].some((key) => key.startsWith("snapshots/"))).toBe(false)
  expect(f.source).toEqual(source)
  expect(f.objects.has(`objects/${digest(binary)}`)).toBe(false)
})

test("selected Source references validate against the complete explicit native and Source directory", async () => {
  const f = await currentSourceConsumerFixture()
  const missing = [
    "skills/docx",
    "skills/pdf",
    "skills/pptx",
    "skills/xlsx",
    "skills",
    "spec",
    "template",
  ]
  const invalid = bytes(missing.map((path) => `[Resource](./${path})`).join("\n"))
  await f.select([{ path: "README.md", bytes: invalid, mode: "100644" }])
  f.bind("mounted/http/README.md", "README.md")
  f.native("references/independent.md", "Independent authored resource.\n")
  const error = await f.target().then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(property(error).code).toBe("SHARED_REFERENCE_BROKEN")
  expect(property(property(error).details).references).toEqual(
    missing.map((path, n) => ({
      from: "mounted/http/README.md",
      target: `mounted/http/${path}`,
      href: `./${path}`,
      line: n + 1,
      kind: "link",
    })),
  )
  expect([...f.json.keys()].some((key) => key.startsWith("snapshots/"))).toBe(false)
  expect(f.semanticWrites()).toHaveLength(0)
  const valid = bytes("[Native guide](../../references/guide.md)\n")
  await f.select([{ path: "README.md", bytes: valid, mode: "100644" }])
  f.bind("mounted/http/README.md", "README.md")
  f.native("references/guide.md", "# Exact native guide\n")
  const complete = await f.target({ refresh: true })
  expect(f.bytes(complete, "mounted/http/README.md")).toEqual(valid)
  expect(new TextDecoder().decode(f.bytes(complete, "references/guide.md"))).toBe(
    "# Exact native guide\n",
  )
  expect(f.semanticWrites()).toHaveLength(0)
})

test("an explicit current path move cannot silently break an authored reference or rewrite an earlier local selection", async () => {
  const f = await currentSourceConsumerFixture()
  const script = bytes("console.log('owned script')\n")
  await f.select([{ path: "tool.ts", bytes: script, mode: "100644" }])
  f.bind("scripts/tool.ts", "tool.ts")
  f.native("SKILL.md", "[Required script](scripts/tool.ts)\n")
  const first = await f.target()
  const snapshots = [...f.json.entries()].filter(([key]) => key.startsWith("snapshots/"))
  f.files[0]!.properties.Path = rich("path", "scripts/renamed.ts")
  f.clearCalls()
  f.requests.length = 0
  await expect(f.target({ refresh: true })).rejects.toMatchObject({
    code: "SHARED_REFERENCE_BROKEN",
  })
  expect([...f.json.entries()].filter(([key]) => key.startsWith("snapshots/"))).toEqual(snapshots)
  expect(f.semanticWrites()).toHaveLength(0)
  f.clearCalls()
  const selected = await f.run(
    readSkill(fileRef(first.record.id, "scripts/tool.ts", first.snapshot_id), { offline: true }),
  )
  expect("content" in selected && bytes(selected.content)).toEqual(script)
  expect(f.calls).toHaveLength(0)
})

test("an explicit native override does not acquire unused provider bytes or infer tombstones", async () => {
  const f = await currentSourceConsumerFixture()
  const unused = bytes("[Broken provider-only link](missing.md)\n")
  await f.select([
    { path: "SKILL.md", bytes: unused, mode: "100644" },
    { path: "unselected.bin", bytes: new Uint8Array(2 * 1024 * 1024), mode: "100644" },
  ])
  f.bind("SKILL.md")
  f.native("SKILL.md", "# Explicit native replacement\n")
  f.objects.set(`objects/${digest(unused)}`, bytes("damaged unselected source cache"))
  f.clearCalls()
  const snapshot = await f.target()
  expect(snapshot.files.map((file) => file.path)).toEqual(["SKILL.md"])
  expect(new TextDecoder().decode(f.bytes(snapshot, "SKILL.md"))).toBe(
    "# Explicit native replacement\n",
  )
  expect(f.requests).toEqual([])
  expect(
    f.calls.some((call) =>
      call.path.includes(`/data_sources/${sourceLibrary.sources.data_source_id}/`),
    ),
  ).toBe(false)
  expect(f.semanticWrites()).toHaveLength(0)
  expect(f.records.size).toBe(0)
})

test("a current local Source keeps its exact main bytes and local restriction without exposing machine paths", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ntn-current-local-source-"))
  try {
    const f = await currentSourceConsumerFixture()
    const main = bytes(
      "---\r\nname: Private source\r\nlicense: MIT\r\n---\r\n\r\n# Local private instructions\r\n",
    )
    writeFileSync(join(root, "SKILL.md"), main)
    const binding = await f.run(
      bindSharedLocalResource({
        bindingKey: "private-main",
        workspaceScope: "current-workspace",
        workspaceRoot: process.cwd(),
        root,
      }),
    )
    await f.install(
      {
        version: 1,
        kind: "composition",
        mounts: [],
        base: {
          kind: "local",
          binding_key: "private-main",
          machine_scope: binding.machine_scope,
          workspace_scope: "current-workspace",
          manifest: {
            version: 1,
            files: [{ path: "SKILL.md", sha256: digest(main), bytes: main.length, mode: "100644" }],
          },
        },
      },
      [{ path: "SKILL.md", bytes: main, mode: "100644" }],
    )
    f.bind("SKILL.md")
    const snapshot = await f.target()
    expect(f.bytes(snapshot, "SKILL.md")).toEqual(main)
    expect(f.json.get(`content-restrictions/local/${digest(main)}.json`)).toEqual({
      version: 1,
      sha256: digest(main),
      reason: "local_resource",
    })
    expect(JSON.stringify(snapshot)).not.toContain(root)
    expect(JSON.stringify(f.source)).not.toContain(root)
    expect(f.requests).toEqual([])
    expect(f.bodyCalls()).toHaveLength(0)
    expect(f.semanticWrites()).toHaveLength(0)
  } finally {
    if (process.platform === "darwin") await Effect.runPromise(trashPath(root))
  }
}, 30_000)
