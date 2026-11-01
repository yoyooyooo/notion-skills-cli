import { expect, test } from "bun:test"
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { property, text } from "../src/model.ts"
import { assertSharedFileReferences } from "../src/shared-file-references.ts"
import { targetSnapshot } from "../src/snapshot.ts"
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
  const registration = await f.run(
    registerSourcePlanBinding(library, {
      skillPageId: skillPage,
      mode: "create",
      plan: httpPlan(binary),
    }),
  )
  property(f.main.properties).source = rich("source", registration.binding.source_plan_id)
  f.clearCalls()
  await expect(f.target({ selector: skillPage })).rejects.toThrow()
  expect(attempts).toBe(1)
  expect(f.readBodyCount()).toBe(0)
  expect(f.writeCount()).toBe(0)
  expect([...f.json.keys()].some((key) => key.startsWith("snapshots/"))).toBe(false)
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
  await f.target({ selector: skillPage })
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
  return { f, requests, select }
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
