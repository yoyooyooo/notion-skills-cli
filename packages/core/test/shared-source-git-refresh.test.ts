import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { property, text } from "../src/model.ts"
import {
  applySourceRefresh,
  prepareSourceRefresh,
  reconcileSourceRefresh,
  validateSourceRefresh,
} from "../src/shared-source-refresh.ts"
import { planSelectedSharedSource } from "../src/shared-selected-source.ts"
import { sourceRefreshFixture, definition, library } from "./shared-source-refresh-fixture.ts"
import { id, skillPage } from "./shared-snapshot-fixture.ts"

const blobId = (bytes: Uint8Array) =>
  createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex")

async function fixture(lfs = false) {
  const paths = new Map<string, Uint8Array>()
  const requests: string[] = []
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      requests.push(url.toString())
      const path = decodeURIComponent(url.pathname.split("/").slice(4).join("/"))
      const bytes = paths.get(path)
      return HttpClientResponse.fromWeb(
        request,
        bytes === undefined
          ? new Response(null, { status: 404 })
          : new Response(bytes.slice(), { headers: { "content-length": String(bytes.length) } }),
      )
    }),
  )
  const f = await sourceRefreshFixture({
    httpClient: client,
    definition: {
      ...definition,
      adapter: { type: "git", url: "https://github.com/example/skills", ref: "main" },
    },
  })
  const member = f.snapshot.members[0]!
  const root = member.source_path
  const files = member.portable.files.map((file) =>
    lfs && file.path === "assets/file.bin"
      ? {
          ...file,
          bytes: new TextEncoder().encode(
            `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 2048\n`,
          ),
        }
      : file,
  )
  for (const file of files) paths.set(`${root}/${file.path}`, file.bytes)
  f.replaceSnapshot({
    ...f.snapshot,
    provenance: {
      provider: "git",
      git_url: "https://github.com/example/skills",
      tree_hash: "b".repeat(40),
    },
    members: [
      {
        ...member,
        portable: { ...member.portable, files },
        git_manifest: {
          commit: f.snapshot.revision,
          tree: "b".repeat(40),
          root,
          files: files.map((file) => ({
            path: file.path,
            source_path: `${root}/${file.path}`,
            git_oid: blobId(file.bytes),
            bytes: file.bytes.length,
          })),
        },
      },
    ],
  })
  f.clearCalls()
  return { ...f, paths, requests }
}

test("default Git candidate selects the fixed manifest without retaining upstream ZIP or bodies", async () => {
  const f = await fixture()
  const plan = await f.run(prepareSourceRefresh(library, id(82), skillPage, f.acquire))
  if (plan.version !== 4) throw new Error("Expected a fixed Git candidate")
  expect(plan.fixed_source.source_id).toBe(plan.source_pin)
  expect(plan.source_files).toHaveLength(3)
  expect(JSON.stringify(plan)).not.toContain("archive_base64")
  expect(f.requests).toHaveLength(1)
  expect(f.requests[0]).toContain(`/${plan.provider_revision}/skills/demo/SKILL.md`)
  f.clearCalls()
  expect(await f.run(applySourceRefresh(library, plan))).toMatchObject({
    verified: true,
    source_pin: plan.source_pin,
    body_writes: 0,
  })
  expect(f.requests).toHaveLength(1)
  expect(
    f.calls.filter(
      (call) =>
        call.path === "v1/pages" &&
        property(property(property(property(call.body).properties).kind).select).name === "object",
    ),
  ).toHaveLength(0)
  const selected = await f.run(planSelectedSharedSource(library, skillPage, plan.source_pin))
  expect((await f.run(selected.materialize(["assets/file.bin"]))).files).toEqual([
    { path: "assets/file.bin", bytes: new Uint8Array([0, 255, 3, 128]) },
  ])
  expect(f.requests).toHaveLength(1)
  f.clearCalls()
  expect(await f.run(reconcileSourceRefresh(library, plan))).toMatchObject({ remote_writes: 0 })
  expect(f.calls.some((call) => call.path === "v1/pages" || call.method === "PATCH")).toBe(false)
})

test("cold apply uses the frozen commit and a missing resource prevents selection", async () => {
  const f = await fixture()
  const plan = await f.run(prepareSourceRefresh(library, id(82), skillPage, f.acquire))
  if (plan.version !== 4) throw new Error("Expected fixed Git")
  for (const entry of plan.fixed_source.files)
    f.json.delete(`cache/shared-github-blobs/${entry.git_oid}.json`)
  for (const file of plan.source_files) f.objects.delete(`objects/${file.sha256}`)
  f.paths.delete("skills/demo/assets/file.bin")
  f.clearCalls()
  await expect(f.run(applySourceRefresh(library, plan))).rejects.toThrow()
  expect(f.requests.every((url) => url.includes(`/${plan.provider_revision}/`))).toBe(true)
  expect(text(property(property(f.main.properties).source).rich_text)).toBe("")
  expect(f.writeCount()).toBe(0)
})

test("an unknown fixed registration is never created twice", async () => {
  const f = await fixture()
  const plan = await f.run(prepareSourceRefresh(library, id(82), skillPage, f.acquire))
  f.clearCalls()
  f.unknownRecord("source", false)
  await expect(f.run(applySourceRefresh(library, plan))).rejects.toThrow()
  const writes = f.writeCount()
  await expect(f.run(applySourceRefresh(library, plan))).rejects.toThrow()
  expect(f.writeCount()).toBe(writes)
  expect(text(property(property(f.main.properties).source).rich_text)).toBe("")
})

test("public transport, original Git hashes and LFS payload requirements gate candidate publication", async () => {
  const unavailable = await fixture()
  unavailable.paths.clear()
  await expect(
    unavailable.run(prepareSourceRefresh(library, id(82), skillPage, unavailable.acquire)),
  ).rejects.toThrow()
  expect(unavailable.writeCount()).toBe(0)
  const corrupt = await fixture()
  const member = corrupt.snapshot.members[0]!
  corrupt.replaceSnapshot({
    ...corrupt.snapshot,
    members: [
      {
        ...member,
        portable: {
          ...member.portable,
          files: member.portable.files.map((file) =>
            file.path === "assets/file.bin"
              ? { ...file, bytes: new Uint8Array([1, 2, 3, 4]) }
              : file,
          ),
        },
      },
    ],
  })
  await expect(
    corrupt.run(prepareSourceRefresh(library, id(82), skillPage, corrupt.acquire)),
  ).rejects.toThrow("original fixed Git tree")
  expect(corrupt.writeCount()).toBe(0)
  const pointer = await fixture(true)
  await expect(
    pointer.run(prepareSourceRefresh(library, id(82), skillPage, pointer.acquire)),
  ).rejects.toThrow("LFS pointer")
  expect(pointer.writeCount()).toBe(0)
})

test("explicit retained policy and metadata-only fixed inspection preserve their transport boundaries", async () => {
  const f = await fixture()
  expect(
    (await f.run(prepareSourceRefresh(library, id(82), skillPage, f.acquire, "retained"))).version,
  ).toBe(3)
  expect(f.requests).toHaveLength(0)
  const fixed = await f.run(prepareSourceRefresh(library, id(82), skillPage, f.acquire))
  const count = f.requests.length
  expect((await f.run(validateSourceRefresh(library, fixed))).kind).toBe("git")
  expect(f.requests).toHaveLength(count)
})
