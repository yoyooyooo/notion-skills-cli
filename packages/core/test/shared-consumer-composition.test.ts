import { expect, test } from "bun:test"
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { Notion } from "../src/notion.ts"
import { openFixedSnapshotFiles } from "../src/fixed-snapshot-files.ts"
import { gitBlobOid } from "../src/shared-github-source.ts"
import { registerSourceBinding } from "../src/shared-source-binding.ts"
import { cacheVerifiedFixedGithubFiles } from "../src/shared-source-materialization.ts"
import { HttpClient, HttpClientResponse } from "effect/http"
import { markLocalContentRestriction } from "../src/content-restrictions.ts"
import { decode, property, text } from "../src/model.ts"
import { openSharedConsumer } from "../src/shared-consumer.ts"
import { FileEventSchema } from "../src/shared-file-state.ts"
import { assertSharedFileReferences } from "../src/shared-file-references.ts"
import { readSkill, targetSnapshot } from "../src/snapshot.ts"
import { parseYaml } from "../src/yaml.ts"
import { bindSharedLocalResource, configureSharedHttpOrigins } from "../src/shared-source-config.ts"
import { registerSourcePlanBinding } from "../src/shared-source-plan-binding.ts"
import type { SharedSourcePlan } from "../src/shared-source-plan.ts"
import {
  digest,
  encode,
  library,
  rich,
  sharedSnapshotFixture,
  skillPage,
} from "./shared-snapshot-fixture.ts"

const origin = "https://resources.example.com"
const binary = new Uint8Array([255, 0, 128, 13, 10, 0])
function httpPlan(bytes: Uint8Array): SharedSourcePlan {
  return {
    version: 1,
    kind: "composition",
    base: null,
    mounts: [
      {
        mount_path: "assets",
        resource: {
          kind: "http",
          manifest: {
            version: 1,
            files: [{ path: "icon.bin", sha256: digest(bytes), bytes: bytes.byteLength }],
          },
          locations: [{ sha256: digest(bytes), url: `${origin}/fixed/icon` }],
        },
      },
    ],
  }
}

function projectedFiles(f: ReturnType<typeof sharedSnapshotFixture>) {
  return [
    { file_id: "file-main", page_id: skillPage, path: "SKILL.md" },
    ...f.files.map((file) => ({
      file_id: text(property(property(file.properties).file_id).rich_text),
      page_id: file.id,
      path: text(property(property(file.properties).path).rich_text),
    })),
  ].map((binding) => {
    const markdown = f.bodies.get(binding.page_id)
    if (markdown === undefined) throw new Error("Expected authentic initial projected page bytes")
    return { ...binding, markdown, bytes: encode(markdown) }
  })
}
function seedProjected(
  f: ReturnType<typeof sharedSnapshotFixture>,
  revision: string,
  files = projectedFiles(f),
) {
  for (const file of files) {
    const eventId = `initial-${file.file_id}`
    f.seedFact(
      {
        event_id: eventId,
        file_id: file.file_id,
        parents: [],
        kind: "projected",
        source_revision: revision,
        projection: { normalization_version: 1, sha256: digest(file.markdown) },
      },
      "file_event",
      file.file_id,
      eventId,
    )
  }
}

function coldConsumer(f: ReturnType<typeof sharedSnapshotFixture>, client: HttpClient.HttpClient) {
  return Effect.gen(function* () {
    const remote = yield* Notion
    const cold = sharedSnapshotFixture({ httpClient: client })
    const run: typeof f.run = (effect) =>
      cold.run(effect.pipe(Effect.provideService(Notion, remote)))
    return { cold, run }
  })
}

test("cold HTTP resource selection keeps one full manifest and downloads only requested bytes before full completion", async () => {
  const requests: string[] = []
  const large = Uint8Array.from({ length: 131_077 }, (_, index) => index % 251)
  const data = new Map([
    [`${origin}/a`, binary],
    [`${origin}/b`, large],
  ])
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      requests.push(url.toString())
      const bytes = data.get(url.toString())
      return HttpClientResponse.fromWeb(
        request,
        bytes === undefined
          ? new Response(null, { status: 404 })
          : new Response(bytes.slice(), { headers: { "content-length": String(bytes.length) } }),
      )
    }),
  )
  const f = sharedSnapshotFixture({ httpClient: client })
  await f.open()
  const plan: SharedSourcePlan = {
    version: 1,
    kind: "composition",
    base: null,
    mounts: [
      {
        mount_path: "assets",
        resource: {
          kind: "http",
          manifest: {
            version: 1,
            files: [
              { path: "a.bin", sha256: digest(binary), bytes: binary.length, mode: "100644" },
              { path: "b.bin", sha256: digest(large), bytes: large.length, mode: "100755" },
            ],
          },
          locations: [
            { sha256: digest(binary), url: `${origin}/a` },
            { sha256: digest(large), url: `${origin}/b` },
          ],
        },
      },
    ],
  }
  const registered = await f.run(
    registerSourcePlanBinding(library, { skillPageId: skillPage, mode: "create", plan }),
  )
  property(f.main.properties).source = rich("source", registered.binding.source_plan_id)
  const { cold, run } = await f.run(coldConsumer(f, client))
  await run(configureSharedHttpOrigins([origin]))
  expect(cold.objects.size).toBe(0)
  const directory = await run(
    targetSnapshot({ selector: skillPage }, { refresh: true }, "generated", "manifest"),
  )
  expect(directory.files).toHaveLength(5)
  expect(requests).toEqual([])
  expect(cold.objects.has(`objects/${digest(binary)}`)).toBe(false)
  expect(cold.objects.has(`objects/${digest(large)}`)).toBe(false)
  const a = await run(
    targetSnapshot({ selector: skillPage, path: "assets/a.bin" }, {}, "generated", "target"),
  )
  expect(a.snapshot_id).toBe(directory.snapshot_id)
  expect(requests).toEqual([`${origin}/a`])
  expect(cold.objects.get(`objects/${digest(binary)}`)).toEqual(binary)
  expect(cold.objects.has(`objects/${digest(large)}`)).toBe(false)
  const full = await run(targetSnapshot({ selector: skillPage }, {}, "generated", "all"))
  expect(full.snapshot_id).toBe(directory.snapshot_id)
  expect(requests).toEqual([`${origin}/a`, `${origin}/b`])
  expect(cold.objects.get(`objects/${digest(large)}`)).toEqual(large)
  expect(full.files.find((file) => file.path === "assets/b.bin")?.mode).toBe("100755")
  await run(
    targetSnapshot(
      { selector: skillPage, path: "assets/a.bin" },
      { maxAge: 0 },
      "generated",
      "target",
    ),
  )
  expect(requests).toEqual([`${origin}/a`, `${origin}/b`])
  const author = await f.run(coldConsumer(f, client))
  await author.run(configureSharedHttpOrigins([origin]))
  await author.run(readSkill(skillPage, { authoring: true }))
  expect(requests.slice(2).sort()).toEqual([`${origin}/a`, `${origin}/b`])
  expect(author.cold.objects.get(`objects/${digest(binary)}`)).toEqual(binary)
  expect(author.cold.objects.get(`objects/${digest(large)}`)).toEqual(large)
})

for (const knownSha of [true, false])
  test(`cold fixed Git admission known SHA=${knownSha} preserves the declared compatibility path`, async () => {
    const requests: string[] = []
    const blobs = new Map<string, Uint8Array>()
    const client = HttpClient.make((request, url) =>
      Effect.sync(() => {
        expect(url.hostname).toBe("raw.githubusercontent.com")
        requests.push(url.toString())
        const bytes = blobs.get(url.pathname.split("/").slice(4).join("/"))
        return HttpClientResponse.fromWeb(
          request,
          bytes === undefined
            ? new Response(null, { status: 404 })
            : new Response(bytes.slice(), { headers: { "content-length": String(bytes.length) } }),
        )
      }),
    )
    const f = sharedSnapshotFixture({ httpClient: client })
    const projected = projectedFiles(f)
    const inputs = [
      ...projected.map(({ path, bytes }) => ({ path, bytes, mode: "100644" as const })),
      { path: "assets/a.bin", bytes: binary, mode: "100644" as const },
      { path: "scripts/b.sh", bytes: encode("#!/bin/sh\r\nexit 9\r\n"), mode: "100755" as const },
    ]
    for (const file of inputs) blobs.set(file.path, file.bytes)
    const fixed = {
      url: "https://github.com/acme/skills",
      commit: "a".repeat(40),
      root: "",
      tree: "b".repeat(40),
      files: await Promise.all(
        inputs.map(async (file) => ({
          path: file.path,
          source_path: file.path,
          git_oid: await f.run(gitBlobOid(file.bytes)),
          bytes: file.bytes.length,
          mode: file.mode,
          ...(knownSha ? { sha256: digest(file.bytes) } : {}),
        })),
      ),
    }
    await f.run(cacheVerifiedFixedGithubFiles(fixed, inputs))
    const registered = await f.run(
      registerSourceBinding(library, {
        skillPageId: skillPage,
        mode: "create",
        fixedSource: fixed,
      }),
    )
    seedProjected(f, fixed.commit, projected)
    property(f.main.properties).source = rich("source", registered.binding.source_id)
    const { cold, run } = await f.run(coldConsumer(f, client))
    expect(cold.objects.size).toBe(0)
    const current = await run(
      targetSnapshot({ selector: skillPage }, { refresh: true }, "generated", "entrypoint"),
    )
    expect(current.files).toHaveLength(inputs.length)
    expect(requests.length).toBe(knownSha ? projected.length : inputs.length)
    expect(cold.objects.has(`objects/${digest(binary)}`)).toBe(!knownSha)
    if (knownSha) {
      const before = requests.length
      const selected = await run(openFixedSnapshotFiles(current, () => ["assets/a.bin"]))
      expect(selected.files).toEqual([{ path: "assets/a.bin", bytes: binary }])
      expect(requests.length).toBe(before + 1)
      expect(requests.at(-1)).toContain(`/${fixed.commit}/assets/a.bin`)
      expect(cold.objects.has(`objects/${digest(inputs.at(-1)!.bytes)}`)).toBe(false)
    }
  })

test("the standard target consumer composes a fixed HTTP mount with native Notion files and warm cached reads", async () => {
  const requests: string[] = [],
    bodies = new Map<string, Uint8Array>([[`${origin}/fixed/icon`, binary]])
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      requests.push(url.toString())
      const bytes = bodies.get(url.toString())
      return HttpClientResponse.fromWeb(
        request,
        bytes === undefined
          ? new Response(null, { status: 404 })
          : new Response(bytes.slice(), {
              headers: { "content-length": String(bytes.byteLength) },
            }),
      )
    }),
  )
  const f = sharedSnapshotFixture({ httpClient: client })
  await f.run(configureSharedHttpOrigins([origin]))
  const projected = projectedFiles(f)
  const plan: SharedSourcePlan = {
    ...httpPlan(binary),
    base: {
      kind: "http",
      manifest: {
        version: 1,
        files: projected.map((file) => ({
          path: file.path,
          sha256: digest(file.bytes),
          bytes: file.bytes.byteLength,
        })),
      },
      locations: projected.map((file) => ({
        sha256: digest(file.bytes),
        url: `${origin}/source/${file.path}`,
      })),
    },
  }
  for (const file of projected) bodies.set(`${origin}/source/${file.path}`, file.bytes)
  const registration = await f.run(
    registerSourcePlanBinding(library, { skillPageId: skillPage, mode: "create", plan }),
  )
  seedProjected(f, registration.binding.source_plan_id, projected)
  property(f.main.properties).source = rich("source", registration.binding.source_plan_id)
  // This edit follows a retained actual projection, so the observer can establish whole-file takeover.
  f.bodies.set(skillPage, "# Edited directly in Notion\n")
  f.main.last_edited_time = new Date().toISOString()
  const snapshot = await f.target({ selector: skillPage })
  expect(snapshot.files.map((file) => file.path)).toEqual([
    "SKILL.md",
    "assets/icon.bin",
    "references/1.md",
    "references/2.md",
  ])
  const asset = snapshot.files.find((file) => file.path === "assets/icon.bin")
  if (!asset) throw new Error("Expected complete composed binary mount")
  expect(f.objects.get(`objects/${asset.sha256}`)).toEqual(binary)
  const main = snapshot.files.find((file) => file.path === "SKILL.md")
  if (!main) throw new Error("Expected canonical main")
  expect(new TextDecoder().decode(f.objects.get(`objects/${main.sha256}`))).toContain(
    "# Edited directly in Notion",
  )
  expect(requests).toHaveLength(4)
  f.clearCalls()
  const warm = await f.target({ selector: skillPage })
  expect(warm.snapshot_id).toBe(snapshot.snapshot_id)
  expect(f.readBodyCount()).toBe(0)
  expect(f.calls).toHaveLength(0)
  expect(f.requestMetrics().provider_requests.http ?? 0).toBe(0)
  expect(requests).toHaveLength(4)
})

test("a local main's archive restriction survives canonical frontmatter changing the final object hash", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ntn-consumer-local-main-"))
  {
    const f = sharedSnapshotFixture({ fileCount: 1 }),
      markdown = "# Local private instructions\n\nDo not execute the bundled bytes.\n"
    const local = encode(
      "---\nname: Source name\ndescription: Source description\n---\n\n" + markdown,
    )
    writeFileSync(join(root, "SKILL.md"), local)
    await f.run(
      bindSharedLocalResource({
        bindingKey: "private-main",
        machineScope: "machine-private",
        workspaceScope: "current-workspace",
        workspaceRoot: process.cwd(),
        root,
      }),
    )
    const plan: SharedSourcePlan = {
      version: 1,
      kind: "composition",
      base: {
        kind: "local",
        binding_key: "private-main",
        machine_scope: "machine-private",
        workspace_scope: "current-workspace",
        manifest: {
          version: 1,
          files: [{ path: "SKILL.md", sha256: digest(local), bytes: local.byteLength }],
        },
      },
      mounts: [],
    }
    const registration = await f.run(
      registerSourcePlanBinding(library, { skillPageId: skillPage, mode: "create", plan }),
    )
    property(f.main.properties).source = rich("source", registration.binding.source_plan_id)
    f.bodies.set(skillPage, markdown)
    seedProjected(f, registration.binding.source_plan_id)
    const snapshot = await f.target({ selector: skillPage })
    const main = snapshot.files.find((file) => file.path === snapshot.entrypoint)
    if (main === undefined) throw new Error("Expected canonical main")
    expect(main.sha256).not.toBe(digest(local))
    const bytes = f.objects.get(`objects/${main.sha256}`)
    if (bytes === undefined) throw new Error("Expected complete main bytes")
    expect(new TextDecoder().decode(bytes)).toContain("# Local private instructions")
    expect(f.json.get(`content-restrictions/local/${main.sha256}.json`)).toEqual({
      version: 1,
      sha256: main.sha256,
      reason: "local_resource",
    })
    expect(JSON.stringify([...f.records.values()])).not.toContain(root)
    expect(JSON.stringify(snapshot)).not.toContain(root)
  }
})

test("an incomplete fixed provider read prevents the standard consumer from publishing a snapshot or adopting current bodies", async () => {
  let attempts = 0
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      attempts++
      return HttpClientResponse.fromWeb(request, new Response(null, { status: 503 }))
    }),
  )
  const f = sharedSnapshotFixture({ httpClient: client })
  await f.run(configureSharedHttpOrigins([origin]))
  await f.target({ selector: skillPage })
  const snapshots = [...f.json.entries()].filter(([key]) => key.startsWith("snapshots/"))
  const registration = await f.run(
    registerSourcePlanBinding(library, {
      skillPageId: skillPage,
      mode: "create",
      plan: httpPlan(binary),
    }),
  )
  property(f.main.properties).source = rich("source", registration.binding.source_plan_id)
  f.bodies.set(skillPage, "# A new user edit awaiting observation\n")
  f.main.last_edited_time = new Date(Date.parse(String(f.main.last_edited_time)) + 1).toISOString()
  f.clearCalls()
  await expect(f.target({ selector: skillPage }, { refresh: true })).rejects.toThrow()
  expect(attempts).toBe(1)
  expect(f.readBodyCount()).toBe(0)
  expect(f.writeCount()).toBe(0)
  expect([...f.json.entries()].filter(([key]) => key.startsWith("snapshots/"))).toEqual(snapshots)
})

// Matches the real N07 failure shape without retaining any private source bytes.
const missingHttpTargets = [
  "skills/docx",
  "skills/pdf",
  "skills/pptx",
  "skills/xlsx",
  "skills",
  "spec",
  "template",
]
const inheritedHttpReadme = missingHttpTargets.map((path) => `[Resource](./${path})`).join("\n")

async function referenceCompositionFixture() {
  const requests: string[] = []
  const objects = new Map<string, Uint8Array>()
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      requests.push(url.toString())
      const bytes = objects.get(url.toString())
      return HttpClientResponse.fromWeb(
        request,
        bytes === undefined
          ? new Response(null, { status: 404 })
          : new Response(bytes.slice(), {
              headers: { "content-length": String(bytes.byteLength) },
            }),
      )
    }),
  )
  const f = sharedSnapshotFixture({ httpClient: client })
  await f.run(configureSharedHttpOrigins([origin]))
  const initial = await f.target({ selector: skillPage })
  const select = async (
    files: readonly { readonly path: string; readonly bytes: Uint8Array }[],
    mountPath: string | null,
  ) => {
    const resource = {
      kind: "http" as const,
      manifest: {
        version: 1 as const,
        files: files.map((file) => ({
          path: file.path,
          sha256: digest(file.bytes),
          bytes: file.bytes.byteLength,
        })),
      },
      locations: files.map((file) => ({
        sha256: digest(file.bytes),
        url: `${origin}/fixed/${digest(file.bytes)}`,
      })),
    }
    for (const file of files) objects.set(`${origin}/fixed/${digest(file.bytes)}`, file.bytes)
    const plan: SharedSourcePlan = {
      version: 1,
      kind: "composition",
      base: mountPath === null ? resource : null,
      mounts: mountPath === null ? [] : [{ mount_path: mountPath, resource }],
    }
    const registered = await f.run(
      registerSourcePlanBinding(library, { skillPageId: skillPage, mode: "create", plan }),
    )
    property(f.main.properties).source = rich("source", registered.binding.source_plan_id)
    f.main.last_edited_time = new Date(
      Date.parse(String(f.main.last_edited_time)) + 1,
    ).toISOString()
    return registered.binding.source_plan_id
  }
  return { f, requests, select, initial }
}

test("seven inherited HTTP Markdown targets prevent publishing a current complete snapshot", async () => {
  const { f, requests, select } = await referenceCompositionFixture()
  const before = [...f.json.entries()].filter(([key]) => key.startsWith("snapshots/"))
  await select([{ path: "README.md", bytes: encode(inheritedHttpReadme) }], "acceptance/http")
  f.clearCalls()
  const error = await f.run(Effect.flip(targetSnapshot({ selector: skillPage }, { refresh: true })))
  expect(error.code).toBe("SHARED_REFERENCE_BROKEN")
  expect(property(error.details).references).toEqual(
    missingHttpTargets.map((path, index) => ({
      from: "acceptance/http/README.md",
      target: `acceptance/http/${path}`,
      href: `./${path}`,
      line: index + 1,
      kind: "link",
    })),
  )
  expect(requests).toHaveLength(1)
  expect(f.writeCount()).toBe(0)
  expect([...f.json.entries()].filter(([key]) => key.startsWith("snapshots/"))).toEqual(before)
  // Lifecycle validation remains strict even when the proposed addition has no references.
  expect(() =>
    assertSharedFileReferences([
      { path: "SKILL.md", bytes: encode("Main") },
      { path: "acceptance/http/README.md", bytes: encode(inheritedHttpReadme) },
      { path: "references/lifecycle.md", bytes: encode("Independent owned marker") },
    ]),
  ).toThrow("unresolved local Markdown")
})

test("a native custom resource may complete a provider reference in the final effective tree", async () => {
  const { f, select } = await referenceCompositionFixture()
  const readme = encode("[Native guide](../../references/1.md)")
  expect(() =>
    assertSharedFileReferences([{ path: "acceptance/http/README.md", bytes: readme }]),
  ).toThrow()
  await select([{ path: "README.md", bytes: readme }], "acceptance/http")
  const snapshot = await f.target({ selector: skillPage }, { refresh: true })
  expect(snapshot.files.map((file) => file.path)).toEqual([
    "SKILL.md",
    "acceptance/http/README.md",
    "references/1.md",
    "references/2.md",
  ])
  const retained = snapshot.files.find((file) => file.path === "references/1.md")
  expect(retained?.sha256).toBe(digest("Reference one\n"))
})

test("a whole-file native custom body may replace a provider body containing broken links", async () => {
  const { f, select } = await referenceCompositionFixture()
  const source = { path: "SKILL.md", bytes: encode("[Upstream missing](absent.md)") }
  expect(() => assertSharedFileReferences([source])).toThrow()
  await select([source], null)
  const snapshot = await f.target({ selector: skillPage }, { refresh: true })
  const main = snapshot.files.find((file) => file.path === "SKILL.md")
  if (main === undefined) throw new Error("Missing final custom main")
  const bytes = f.objects.get(`objects/${main.sha256}`)
  if (bytes === undefined) throw new Error("Missing verified custom bytes")
  expect(new TextDecoder().decode(bytes)).toContain("# Native main")
  expect(new TextDecoder().decode(bytes)).not.toContain("absent.md")
})

test("a fixed upstream path change cannot publish a custom main with a now-missing script reference", async () => {
  const { f, select } = await referenceCompositionFixture()
  await select([{ path: "scripts/old.ts", bytes: encode("old script bytes") }], null)
  f.bodies.set(skillPage, "[Required script](scripts/old.ts)\n")
  f.main.last_edited_time = new Date(Date.parse(String(f.main.last_edited_time)) + 1).toISOString()
  const before = await f.target({ selector: skillPage }, { refresh: true })
  const snapshots = [...f.json.entries()].filter(([key]) => key.startsWith("snapshots/"))
  await select([{ path: "scripts/new.ts", bytes: encode("new script bytes") }], null)
  f.clearCalls()
  const error = await f.run(Effect.flip(targetSnapshot({ selector: skillPage }, { refresh: true })))
  expect(error.code).toBe("SHARED_REFERENCE_BROKEN")
  expect(property(error.details).references).toEqual([
    expect.objectContaining({
      from: "SKILL.md",
      target: "scripts/old.ts",
      href: "scripts/old.ts",
      kind: "link",
    }),
  ])
  expect(f.writeCount()).toBe(0)
  expect([...f.json.entries()].filter(([key]) => key.startsWith("snapshots/"))).toEqual(snapshots)
  f.clearCalls()
  const pin = await f.target(
    { selector: skillPage, snapshot: before.snapshot_id },
    { offline: true },
  )
  expect(pin.files).toEqual(before.files)
  expect(f.calls).toHaveLength(0)
})

function initialFileEvent(f: ReturnType<typeof sharedSnapshotFixture>, fileId: string) {
  const row = [...f.records.values()].find(
    (candidate) =>
      text(property(property(candidate.properties).entity).rich_text) === fileId &&
      property(property(property(candidate.properties).kind).select).name === "file_event",
  )
  if (row === undefined) throw new Error("Missing actual initial file event")
  return decode(
    FileEventSchema,
    property(JSON.parse(text(property(property(row.properties).payload).rich_text))).payload,
  )
}

test("known custom resources skip large source bytes while main YAML, privacy and metadata refresh remain complete", async () => {
  const { f, requests, select } = await referenceCompositionFixture()
  const overridden = new Uint8Array(2 * 1024 * 1024).fill(97)
  const absent = new Uint8Array(2 * 1024 * 1024).fill(98)
  const excludedHashes = [digest(overridden), digest(absent)]
  const mainSource = encode(
    "---\nname: Original\ndescription: Original\nlicense: MIT\nx-source: retained\n---\n\n# Unused source body\n",
  )
  await select(
    [
      { path: "SKILL.md", bytes: mainSource },
      { path: "references/1.md", bytes: overridden },
      { path: "references/2.md", bytes: absent },
      { path: "assets/selected.bin", bytes: binary },
    ],
    null,
  )
  const corruptBytes = encode("corrupt unselected source")
  f.objects.set(`objects/${digest(overridden)}`, corruptBytes)
  f.objects.set(`objects/${digest(binary)}`, binary)
  await f.run(markLocalContentRestriction(digest(overridden)))
  f.clearCalls()
  requests.length = 0
  const snapshot = await f.target({ selector: skillPage }, { refresh: true })
  expect(requests).toEqual([`${origin}/fixed/${digest(mainSource)}`])
  expect(snapshot.files.map((file) => file.path)).toEqual([
    "SKILL.md",
    "assets/selected.bin",
    "references/1.md",
    "references/2.md",
  ])
  const main = snapshot.files.find((file) => file.path === "SKILL.md")!
  const rendered = new TextDecoder().decode(f.objects.get(`objects/${main.sha256}`))
  const frontmatter = property(parseYaml(/^---\n([\s\S]*?)\n---/u.exec(rendered)![1]!))
  expect(frontmatter.license).toBe("MIT")
  expect(frontmatter["x-source"]).toBe("retained")
  expect(rendered).toContain("# Native main")
  expect(rendered).not.toContain("Unused source body")
  expect(snapshot.files.find((file) => file.path === "references/1.md")?.sha256).toBe(
    digest("Reference one\n"),
  )
  expect(f.json.get(`content-restrictions/local/${digest("Reference one\n")}.json`)).toEqual({
    version: 1,
    sha256: digest("Reference one\n"),
    reason: "local_resource",
  })
  expect(
    f.objectReads.filter((read) => excludedHashes.some((hash) => read.key === `objects/${hash}`)),
  ).toEqual([])
  expect(
    f.objectReads.some(
      (read) =>
        read.key === `objects/${digest(binary)}` &&
        read.bytes === binary.byteLength &&
        read.sha256 === digest(binary),
    ),
  ).toBe(true)
  expect(f.objects.get(`objects/${digest(overridden)}`)).toEqual(corruptBytes)
  expect(f.objects.has(`objects/${digest(absent)}`)).toBe(false)
  expect(f.writeCount()).toBe(0)

  property(f.main.properties).description = rich("description", "Updated managed description")
  f.main.last_edited_time = new Date(Date.parse(String(f.main.last_edited_time)) + 1).toISOString()
  f.clearCalls()
  requests.length = 0
  const refreshed = await f.run(
    openSharedConsumer({
      library,
      target: skillPage,
      scope: snapshot.scope,
      startedAt: Date.now(),
    }),
  )
  const refreshedMain = refreshed.files.find((file) => file.path === "SKILL.md")!
  const refreshedText = new TextDecoder().decode(f.objects.get(`objects/${refreshedMain.sha256}`))
  expect(property(parseYaml(/^---\n([\s\S]*?)\n---/u.exec(refreshedText)![1]!)).description).toBe(
    "Updated managed description",
  )
  expect(requests).toEqual([])
  expect(f.readBodyCount()).toBe(1)
  expect(f.writeCount()).toBe(0)
  expect(
    f.objectReads.filter((read) => excludedHashes.some((hash) => read.key === `objects/${hash}`)),
  ).toEqual([])
})

test("known custom moves and tombstones suppress source acquisition without losing the old fixed snapshot", async () => {
  const { f, requests, select, initial } = await referenceCompositionFixture()
  const first = initialFileEvent(f, "file-1"),
    second = initialFileEvent(f, "file-2")
  if (first.kind !== "adopted" || second.kind !== "adopted")
    throw new Error("Expected actual native adoption")
  f.seedFact(
    {
      kind: "moved",
      event_id: "move-custom",
      file_id: "file-1",
      parents: [first.event_id],
      retained: first.content,
      from_path: "references/1.md",
      to_path: "notes/moved.md",
      source_path: "references/1.md",
      suppressed_paths: ["references/1.md"],
    },
    "file_event",
    "file-1",
    "move-custom",
  )
  property(f.files[0]!.properties).path = rich("path", "notes/moved.md")
  f.seedFact(
    {
      kind: "deleted",
      event_id: "delete-resource",
      file_id: "file-2",
      parents: [second.event_id],
      retained: second.content,
    },
    "file_event",
    "file-2",
    "delete-resource",
  )
  const movedSource = new Uint8Array(2 * 1024 * 1024).fill(99)
  const deletedSource = new Uint8Array(2 * 1024 * 1024).fill(100)
  await select(
    [
      { path: "references/1.md", bytes: movedSource },
      { path: "references/2.md", bytes: deletedSource },
      { path: "assets/selected.bin", bytes: binary },
    ],
    null,
  )
  f.clearCalls()
  requests.length = 0
  const current = await f.target({ selector: skillPage }, { refresh: true })
  expect(requests).toEqual([`${origin}/fixed/${digest(binary)}`])
  expect(current.files.map((file) => file.path)).toEqual([
    "SKILL.md",
    "assets/selected.bin",
    "notes/moved.md",
  ])
  expect(current.file_bindings?.find((file) => file.file_id === "file-1")?.path).toBe(
    "notes/moved.md",
  )
  expect(current.files.find((file) => file.path === "notes/moved.md")?.sha256).toBe(
    first.content.sha256,
  )
  expect(
    f.calls.some(
      (call) => call.path.includes(String(f.files[1]!.id)) && call.path.includes("/markdown"),
    ),
  ).toBe(false)
  expect(
    f.objectReads.filter((read) =>
      [digest(movedSource), digest(deletedSource)].some((hash) => read.key === `objects/${hash}`),
    ),
  ).toEqual([])
  expect(f.objects.has(`objects/${digest(movedSource)}`)).toBe(false)
  expect(f.objects.has(`objects/${digest(deletedSource)}`)).toBe(false)
  expect(f.writeCount()).toBe(0)
  f.clearCalls()
  const old = await f.target(
    { selector: skillPage, snapshot: initial.snapshot_id },
    { offline: true },
  )
  expect(old.files).toEqual(initial.files)
  expect(f.calls).toEqual([])
})

test("an orphan ownership fact rejects source consumption before any provider or object acquisition", async () => {
  const { f, requests, select } = await referenceCompositionFixture()
  await select([{ path: "assets/required.bin", bytes: binary }], null)
  const initial = initialFileEvent(f, "file-main")
  if (initial.kind !== "adopted") throw new Error("Expected native main adoption")
  f.seedFact(
    {
      kind: "adopted",
      event_id: "orphan-event",
      file_id: "unbound",
      parents: [],
      content: initial.content,
    },
    "file_event",
    "unbound",
    "orphan-event",
  )
  f.clearCalls()
  requests.length = 0
  const error = await f.run(Effect.flip(targetSnapshot({ selector: skillPage }, { refresh: true })))
  expect(error.code).toBe("UNBOUND_FILE_STATE")
  expect(requests).toEqual([])
  expect(f.objectReads).toEqual([])
  expect(f.readBodyCount()).toBe(0)
  expect(f.writeCount()).toBe(0)
})
