import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { property, type Snapshot } from "../src/model.ts"
import { openSharedConsumer } from "../src/shared-consumer.ts"
import type { FixedGithubSource } from "../src/shared-github-source.ts"
import { registerSourceBinding } from "../src/shared-source-binding.ts"
import {
  sharedSnapshotFixture,
  skillPage,
  library,
  id,
  rich,
  digest,
  encode,
} from "./shared-snapshot-fixture.ts"

const commitA = "1".repeat(40)
const commitB = "2".repeat(40)
const repository = "https://github.com/example/skills"
const sourceRoot = "skills/example"
const gitOid = (bytes: Uint8Array) =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")
type Fixture = ReturnType<typeof sharedSnapshotFixture>

function fixedSource(commit: string, files: ReadonlyMap<string, Uint8Array>): FixedGithubSource {
  return {
    url: repository,
    commit,
    tree: commit === commitA ? "a".repeat(40) : "b".repeat(40),
    root: sourceRoot,
    files: [...files].map(([path, bytes]) => ({
      path,
      source_path: `${sourceRoot}/${path}`,
      git_oid: gitOid(bytes),
      bytes: bytes.length,
    })),
  }
}

function outputBytes(fixture: Fixture, snapshot: Snapshot, path: string): Uint8Array {
  const file = snapshot.files.find((file) => file.path === path)
  if (file === undefined) throw new Error(`Missing snapshot file: ${path}`)
  const bytes = fixture.objects.get(`objects/${file.sha256}`)
  if (bytes === undefined) throw new Error(`Missing snapshot bytes: ${path}`)
  return bytes
}

function requiredBytes(files: ReadonlyMap<string, Uint8Array>, path: string): Uint8Array {
  const bytes = files.get(path)
  if (bytes === undefined) throw new Error(`Missing source fixture bytes: ${path}`)
  return bytes
}

function providerFixture() {
  const requests: string[] = []
  const bodies = new Map<string, Uint8Array>()
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      requests.push(url.toString())
      if (url.origin !== "https://raw.githubusercontent.com")
        throw new Error("Fixed consumption attempted provider discovery.")
      const bytes = bodies.get(url.toString())
      if (bytes === undefined)
        throw new Error("Consumption requested an unregistered source revision or path.")
      return HttpClientResponse.fromWeb(
        request,
        new Response(bytes.slice(), { headers: { "content-length": String(bytes.length) } }),
      )
    }),
  )
  const f = sharedSnapshotFixture({ httpClient: client })
  const sourceBytes = new Map<string, Uint8Array>([
    [
      "SKILL.md",
      encode(
        "---\nname: Upstream name\ndescription: Upstream description\n---\n\n# Git version A\n",
      ),
    ],
    ["references/1.md", encode("Git reference A one\n")],
    ["references/2.md", encode("Git reference A two\n")],
    ["scripts/check.sh", encode("#!/bin/sh\r\nexit 91\r\n")],
    ["assets/icon.bin", new Uint8Array([0, 255, 10, 13, 0, 128])],
  ])
  const retainProviderBodies = (commit: string, files: ReadonlyMap<string, Uint8Array>) => {
    for (const [path, bytes] of files) {
      const encoded = `${sourceRoot}/${path}`.split("/").map(encodeURIComponent).join("/")
      bodies.set(`https://raw.githubusercontent.com/example/skills/${commit}/${encoded}`, bytes)
    }
  }
  const register = async (commit: string, files: ReadonlyMap<string, Uint8Array>) => {
    retainProviderBodies(commit, files)
    return (
      await f.run(
        registerSourceBinding(library, {
          skillPageId: skillPage,
          mode: "create",
          fixedSource: fixedSource(commit, files),
        }),
      )
    ).binding
  }
  const select = (sourceId: string) => {
    property(f.main.properties).source = rich("source", sourceId)
  }
  const projectInitialPages = () => {
    const bindings = [
      { file_id: "file-main", page: skillPage },
      { file_id: "file-1", page: id(11) },
      { file_id: "file-2", page: id(12) },
    ]
    for (const binding of bindings) {
      const body = f.bodies.get(binding.page)
      if (body === undefined) throw new Error("Missing projection fixture body.")
      const eventId = `initial-${binding.file_id}`
      f.seedFact(
        {
          event_id: eventId,
          file_id: binding.file_id,
          parents: [],
          kind: "projected",
          source_revision: commitA,
          projection: { normalization_version: 1, sha256: digest(body) },
        },
        "file_event",
        binding.file_id,
        eventId,
      )
    }
  }
  const open = (scope: string) =>
    f.run(
      openSharedConsumer({
        library,
        target: skillPage,
        scope,
        startedAt: Date.now(),
      }),
    )
  return { f, requests, bodies, sourceBytes, register, select, projectInitialPages, open }
}

describe("standard shared source consumer", () => {
  test("a selected source without its immutable record fails before body or provider access", async () => {
    const p = providerFixture()
    p.select(`source-${"a".repeat(64)}`)
    await expect(p.f.target({ selector: skillPage })).rejects.toThrow(
      "exact selected source record",
    )
    expect(p.requests).toHaveLength(0)
    expect(p.f.requestMetrics().provider_requests.github ?? 0).toBe(0)
    expect(p.f.readBodyCount()).toBe(0)
    expect(p.f.writeCount()).toBe(0)
    expect([...p.f.json.keys()].some((key) => key.startsWith("snapshots/"))).toBe(false)
  })

  test("standard target dispatch copies fixed binary and script bytes while canonicalizing only main metadata", async () => {
    const p = providerFixture()
    const binding = await p.register(commitA, p.sourceBytes)
    p.select(binding.source_id)
    p.projectInitialPages()
    p.f.clearCalls()
    const snapshot = await p.f.target({ selector: skillPage })
    expect(snapshot.record.locator.type).toBe("shared_skill")
    expect(snapshot.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "assets/icon.bin",
      "references/1.md",
      "references/2.md",
      "scripts/check.sh",
    ])
    expect(outputBytes(p.f, snapshot, "assets/icon.bin")).toEqual(
      requiredBytes(p.sourceBytes, "assets/icon.bin"),
    )
    expect(outputBytes(p.f, snapshot, "scripts/check.sh")).toEqual(
      requiredBytes(p.sourceBytes, "scripts/check.sh"),
    )
    const main = new TextDecoder().decode(outputBytes(p.f, snapshot, "SKILL.md"))
    expect(main).toContain('"name": "Managed Name"')
    expect(main).toContain('"description": "Managed description"')
    expect(main).toContain("# Git version A")
    expect(main).not.toContain("Upstream name")
    expect(p.requests).toHaveLength(5)
    expect(p.f.requestMetrics().provider_requests.github).toBe(5)
    expect(
      p.requests.every((url) => url.includes(`/example/skills/${commitA}/${sourceRoot}/`)),
    ).toBe(true)
    expect(p.f.readBodyCount()).toBe(3)
    expect(p.f.writeCount()).toBe(0)
  })

  test("warm metadata revalidation uses no GitHub requests and no Notion body reads", async () => {
    const p = providerFixture()
    const binding = await p.register(commitA, p.sourceBytes)
    p.select(binding.source_id)
    p.projectInitialPages()
    const cold = await p.f.target({ selector: skillPage })
    p.requests.length = 0
    p.f.clearCalls()
    const warm = await p.open(cold.scope)
    expect(warm.snapshot_id).toBe(cold.snapshot_id)
    expect(warm.freshness?.validation).toBe("metadata")
    expect(p.requests).toHaveLength(0)
    expect(p.f.requestMetrics()).toMatchObject({
      total_requests: 5,
      requests: { notion_metadata: 5, notion_body: 0, notion_write: 0, provider: 0 },
      in_flight: 0,
    })
    expect(p.f.readBodyCount()).toBe(0)
    expect(p.f.writeCount()).toBe(0)
    expect(p.f.calls).toHaveLength(5)
    expect(
      p.f.calls.filter((call) =>
        call.path.includes(`/data_sources/${library.records.data_source_id}/query`),
      ),
    ).toHaveLength(3)
  })

  test("loss of the selected source record does not reuse a stale successful cache", async () => {
    const p = providerFixture()
    const binding = await p.register(commitA, p.sourceBytes)
    p.select(binding.source_id)
    p.projectInitialPages()
    const first = await p.f.target({ selector: skillPage })
    for (const [pageId, record] of p.f.records) {
      if (property(property(property(record.properties).kind).select).name === "source")
        p.f.records.delete(pageId)
    }
    p.requests.length = 0
    p.f.clearCalls()
    await expect(p.open(first.scope)).rejects.toThrow("exact selected source record")
    expect(p.requests).toHaveLength(0)
    expect(p.f.readBodyCount()).toBe(0)
    expect(p.f.writeCount()).toBe(0)
  })

  test("a registered newer commit remains unused until Notion explicitly selects its source identity", async () => {
    const p = providerFixture()
    const initial = await p.register(commitA, p.sourceBytes)
    p.select(initial.source_id)
    p.projectInitialPages()
    const first = await p.f.target({ selector: skillPage })
    const advancedBytes = new Map(p.sourceBytes)
    advancedBytes.set("references/2.md", encode("Git reference B two\n"))
    const advanced = await p.register(commitB, advancedBytes)
    expect(advanced.source_id).not.toBe(initial.source_id)
    p.requests.length = 0
    p.f.clearCalls()
    const stillSelected = await p.open(first.scope)
    expect(stillSelected.snapshot_id).toBe(first.snapshot_id)
    expect(outputBytes(p.f, stillSelected, "references/2.md")).toEqual(
      requiredBytes(p.sourceBytes, "references/2.md"),
    )
    expect(p.requests).toHaveLength(0)
    p.select(advanced.source_id)
    const next = await p.open(first.scope)
    expect(next.snapshot_id).not.toBe(first.snapshot_id)
    expect(outputBytes(p.f, next, "references/2.md")).toEqual(
      requiredBytes(advancedBytes, "references/2.md"),
    )
    expect(p.requests).toEqual([
      `https://raw.githubusercontent.com/example/skills/${commitB}/${sourceRoot}/references/2.md`,
    ])
    expect(p.f.requestMetrics()).toMatchObject({
      provider_requests: { github: 1 },
      in_flight: 0,
      unknown_response_bytes: 0,
    })
    expect(p.f.writeCount()).toBe(0)
  })

  test("a Notion whole-file edit survives an explicitly selected Git source advance", async () => {
    const p = providerFixture()
    const initial = await p.register(commitA, p.sourceBytes)
    p.select(initial.source_id)
    p.projectInitialPages()
    const first = await p.f.target({ selector: skillPage })
    const userBytes = encode("# Entire user replacement\nNo generated sections remain.\n")
    p.f.bodies.set(id(11), new TextDecoder().decode(userBytes))
    const edited = p.f.files[0]
    if (edited === undefined) throw new Error("Missing editable reference fixture.")
    edited.last_edited_time = new Date().toISOString()
    p.f.clearCalls()
    const customized = await p.open(first.scope)
    expect(outputBytes(p.f, customized, "references/1.md")).toEqual(userBytes)
    expect(p.f.readBodyCount()).toBe(1)
    const advancedBytes = new Map(p.sourceBytes)
    advancedBytes.set("references/1.md", encode("Upstream changed the same whole file.\n"))
    advancedBytes.set("references/2.md", encode("Untouched file follows Git version B.\n"))
    const advanced = await p.register(commitB, advancedBytes)
    p.select(advanced.source_id)
    const next = await p.open(first.scope)
    expect(outputBytes(p.f, next, "references/1.md")).toEqual(userBytes)
    expect(outputBytes(p.f, next, "references/2.md")).toEqual(
      requiredBytes(advancedBytes, "references/2.md"),
    )
    expect(outputBytes(p.f, next, "assets/icon.bin")).toEqual(
      requiredBytes(p.sourceBytes, "assets/icon.bin"),
    )
  })
})
