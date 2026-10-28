import { expect, test } from "vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import { Context, Effect, Layer } from "effect"
import type { HttpClient } from "effect/http/HttpClient"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { aliasFor, fail, property, type Snapshot } from "../../core/src/model.ts"
import { Notion } from "../../core/src/notion.ts"
import { BUNDLE, canonicalMain, portableZip } from "../../core/src/portable.ts"
import { publicationManifest } from "../../core/src/publication-integrity.ts"
import { applyPlan, canonical, makePlan, observe, PlanSchema, strict } from "../src/converter.ts"
import type { Plan, Target } from "../src/converter.ts"

const page = "11111111-1111-4111-8111-111111111111"
const database = "22222222-2222-4222-8222-222222222222"
const source = "33333333-3333-4333-8333-333333333333"
const reference = "44444444-4444-4444-8444-444444444444"
const member = "55555555-5555-4555-8555-555555555555"
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const rich = (value: string) => [{ type: "text", plain_text: value, text: { content: value } }]
const markdown = (value: string) => ({
  object: "page_markdown",
  markdown: value,
  truncated: false,
  unknown_block_ids: [],
})

type SourceFormat = Target["source_format"]
type MutableTarget = { -readonly [K in keyof Target]: Target[K] }
interface Fixture {
  directory: string
  target: MutableTarget
  properties: Record<string, unknown>
  raw: Record<string, unknown>
  calls: Array<{ path: string; method: string; body?: unknown }>
  plan: () => Promise<Plan>
  apply: (
    plan: Plan,
    mutate?: boolean,
  ) => Promise<{
    plan_hash: string
    results: Array<{ page_id: string; state: string; wrote: boolean; detail?: string }>
  }>
  run: <A, E>(
    effect: Effect.Effect<A, E, NodeServices.NodeServices | Notion | HttpClient>,
  ) => Promise<A>
  writes: () => number
  setRoot: (value: string) => void
  setRootBlocks: (value: unknown[]) => void
  setReference: (value: string) => void
  setAsset: () => void
  setBundle: () => void
  setUnknown: (value: "none" | "landed" | "unlanded", unavailable?: boolean) => void
  restoreReads: () => void
  close: () => Promise<void>
}
async function fixture<A>(
  format: SourceFormat,
  use: (value: Fixture) => Promise<A>,
  kind: "skill" | "prompt" | "router" = "skill",
) {
  const value = await setup(format, kind)
  try {
    return await use(value)
  } finally {
    await value.close()
  }
}
async function setup(format: SourceFormat, kind: "skill" | "prompt" | "router"): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "proof-converter-"))
  const audit = join(directory, "retained-old-page.json")
  let asset = Buffer.from([0, 1, 2, 255])
  const bundle = portableZip({
    kind,
    name: "Owned Fixture",
    description: "Independent proof fixture",
    main: kind === "router" ? "ROUTER.md" : kind === "prompt" ? "PROMPT.md" : "SKILL.md",
    files: [
      {
        path: kind === "router" ? "ROUTER.md" : kind === "prompt" ? "PROMPT.md" : "SKILL.md",
        bytes: new TextEncoder().encode(
          "---\nname: Owned Fixture\ndescription: Independent proof fixture\n---\n\n# Original authored root\n",
        ),
      },
      { path: "assets/preserved.bin", bytes: new Uint8Array([7, 0, 8, 255]) },
    ],
  })
  let sourceBundle = Buffer.from(bundle)
  const server = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "application/octet-stream" })
    response.end(request.url === "/bundle" ? sourceBundle : asset)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("No fixture listener")
  const origin = `http://127.0.0.1:${address.port}`
  const properties: Record<string, unknown> = {
    Name: { id: "title", type: "title", title: rich("Owned Fixture") },
    Description: {
      id: "description",
      type: "rich_text",
      rich_text: rich("Independent proof fixture"),
    },
    Kind: { id: "kind", type: "select", select: { name: kind } },
    "Default Context": { id: "default", type: "checkbox", checkbox: false },
    Members: { id: "members", type: "relation", relation: [], has_more: false },
    References: { id: "references", type: "rich_text", rich_text: [] },
    Assets: {
      id: "assets",
      type: "files",
      files: [
        { name: "assets/current.bin", type: "external", external: { url: `${origin}/asset` } },
        { name: BUNDLE, type: "external", external: { url: `${origin}/bundle` } },
      ],
    },
    Publication: { id: "publication", type: "rich_text", rich_text: [] },
  }
  const raw: Record<string, unknown> = {
    object: "page",
    id: page,
    parent: { type: "data_source_id", database_id: database, data_source_id: source },
    properties,
    archived: false,
    in_trash: false,
    last_edited_time: "2026-10-17T00:00:00.000Z",
  }
  let root = "# Original authored root\n"
  let rootBlocks: unknown[] = []
  let refBody = "# Reference original\n"
  let writes = 0
  let unknown: "none" | "landed" | "unlanded" = "none"
  let failReadback = false
  let afterPatch = false
  const calls: Array<{ path: string; method: string; body?: unknown }> = []
  const api: Context.Service.Shape<typeof Notion> = {
    credentialIdentity: Effect.succeed(digest("fixture-credential")),
    version: Effect.succeed("fixture"),
    request: (path, body, options) =>
      Effect.suspend(() => {
        calls.push({ path, method: options?.method ?? "GET", ...(body ? { body } : {}) })
        if (options?.method === "PATCH") {
          writes++
          afterPatch = true
          if (unknown !== "unlanded") {
            const fields = property(property(body).properties)
            const change = property(fields.publication)
            const content = String(
              property(property(property((change.rich_text as unknown[])[0]).text)).content,
            )
            properties.Publication = {
              id: "publication",
              type: "rich_text",
              rich_text: rich(content),
            }
            raw.last_edited_time = "2026-10-17T00:01:00.000Z"
          }
          return unknown === "none"
            ? Effect.succeed(structuredClone(raw))
            : Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "Controlled lost response"))
        }
        if (afterPatch && failReadback)
          return Effect.fail(fail("NOTION_REQUEST_FAILED", "Controlled unavailable readback"))
        if (path === `v1/pages/${page}`) return Effect.succeed(structuredClone(raw))
        if (path === `v1/pages/${page}/markdown`) return Effect.succeed(markdown(root))
        if (path === `v1/pages/${page}/properties/references?page_size=100`)
          return Effect.succeed({
            object: "list",
            has_more: false,
            next_cursor: null,
            results: [
              {
                rich_text: {
                  type: "mention",
                  plain_text: "guide.md",
                  mention: { type: "page", page: { id: reference } },
                },
              },
            ],
          })
        if (path === `v1/pages/${reference}`)
          return Effect.succeed({
            object: "page",
            id: reference,
            in_trash: false,
            properties: { title: { type: "title", title: rich("Guide") } },
          })
        if (path === `v1/pages/${reference}/markdown`) return Effect.succeed(markdown(refBody))
        if (
          path === `v1/blocks/${page}/children?page_size=100` ||
          path === `v1/blocks/${reference}/children?page_size=100`
        )
          return Effect.succeed({
            object: "list",
            type: "block",
            block: {},
            results: path === `v1/blocks/${page}/children?page_size=100` ? rootBlocks : [],
            has_more: false,
            next_cursor: null,
          })
        return Effect.fail(fail("UNEXPECTED_REQUEST", path))
      }).pipe(Effect.map((value) => ({ ...value, request_id: `response-${calls.length}` }))),
  }
  const platform = Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerFetch)
  const run = <A, E>(
    effect: Effect.Effect<A, E, NodeServices.NodeServices | Notion | HttpClient>,
  ) =>
    Effect.runPromise(
      Effect.scoped(effect.pipe(Effect.provideService(Notion, api), Effect.provide(platform))),
    )
  const target: MutableTarget = {
    page_id: page,
    database_id: database,
    data_source_id: source,
    source_format: format,
    expected_publication: JSON.stringify({
      version: 1,
      state: "committed",
      operation_id: "p_owned-fixture",
      intended_hash: digest("intended"),
      manifest_hash: "a".repeat(64),
      ownership_hash: "b".repeat(64),
      revision: "c".repeat(64),
    }),
    expected_default_context: false,
    expected_members: [],
    audit_ref: audit,
    audit_sha256: "d".repeat(64),
  }
  const saveAudit = async () => {
    properties.Publication = {
      id: "publication",
      type: "rich_text",
      rich_text: rich(target.expected_publication),
    }
    const bytes = JSON.stringify(raw)
    await writeFile(audit, bytes)
    target.audit_sha256 = digest(bytes)
  }
  await saveAudit()
  const observed = await run(
    observe(
      { ...target, source_format: format === "canonical-name-v2" ? "extended-guard-v1" : format },
      target.expected_publication,
    ),
  )
  const ownership_hash = digest(
    canonical(format === "original-provenance-v1" ? observed.ownership : observed.guard),
  )
  const old = JSON.parse(target.expected_publication)
  old.manifest_hash = observed.manifest_hash
  old.ownership_hash = ownership_hash
  if (format === "canonical-name-v2") {
    const files = observed.files.map((file) => {
      if (file.path !== observed.record.entrypoint) return file
      const current = Buffer.from(file.base64, "base64").toString("utf8")
      const historical = current.replace(
        `"name": ${JSON.stringify(observed.record.name)}\n`,
        `"name": ${JSON.stringify(aliasFor(observed.record.name))}\n`,
      )
      if (historical === current) throw new Error("Fixture requires exact JSON canonical name line")
      const bytes = Buffer.from(historical)
      return {
        path: file.path,
        bytes: bytes.length,
        sha256: digest(bytes),
        base64: bytes.toString("base64"),
      }
    })
    const snapshot: Snapshot = {
      snapshot_id: `s_${digest(JSON.stringify(["retained-historical-fixture", observed.record.id, "retained-historical-version"]))}`,
      scope: "retained-historical-fixture",
      record: observed.record,
      entrypoint: observed.record.entrypoint,
      version_id: "retained-historical-version",
      created_at: 1,
      files: files.map(({ base64: _base64, ...file }) => file),
      references: observed.references,
    }
    const receipt_ref = join(directory, "historical-receipt.json")
    const receipt = JSON.stringify({
      ok: true,
      verified: true,
      snapshot_id: snapshot.snapshot_id,
      version_id: snapshot.version_id,
      record: snapshot.record,
    })
    await writeFile(receipt_ref, receipt)
    const baseline = JSON.stringify({
      format: 1,
      snapshot,
      files,
      receipt_ref,
      receipt_sha256: digest(receipt),
    })
    target.canonical_baseline_ref = join(directory, "canonical-baseline.json")
    target.canonical_baseline_sha256 = digest(baseline)
    await writeFile(target.canonical_baseline_ref, baseline)
    old.version = 2
    old.creation = {
      version: 1,
      operation_token: page,
      operation_id: old.operation_id,
      intent_index: 0,
      scope: snapshot.scope,
      database_id: database,
      data_source_id: source,
      role: "content_root",
      path: snapshot.entrypoint,
      parent_type: "data_source_id",
      parent_id: source,
      intended_hash: old.intended_hash,
      source_sha256: digest(bundle),
    }
    const manifest = await run(publicationManifest(snapshot))
    if (kind === "router") {
      const authored = canonicalMain(
        snapshot.record.name,
        snapshot.record.description,
        observed.references.find((entry) => entry.path === snapshot.entrypoint)!.markdown,
        { path: snapshot.entrypoint, bytes: new Uint8Array() },
      )
      const historical = Buffer.from(authored.bytes)
        .toString("utf8")
        .replace(
          `"name": ${JSON.stringify(snapshot.record.name)}\n`,
          `"name": ${JSON.stringify(aliasFor(snapshot.record.name))}\n`,
        )
      const bytes = Buffer.from(historical)
      manifest.files = manifest.files.map((file) =>
        file[0] === snapshot.entrypoint ? [snapshot.entrypoint, bytes.length, digest(bytes)] : file,
      )
    }
    old.manifest_hash = digest(canonical(manifest))
  }
  old.revision = digest(
    canonical([old.operation_id, old.intended_hash, old.manifest_hash, ownership_hash]),
  )
  target.expected_publication = JSON.stringify(old)
  await saveAudit()
  const plan = () => run(makePlan({ format: 1, targets: [target] }))
  const apply = async (planValue: Plan, mutate = true) => {
    const bytes = JSON.stringify(planValue, null, 2) + "\n"
    // Persist/reopen the exact operator-reviewed plan bytes using actual Node filesystem.
    const path = join(directory, "reviewed-plan.json")
    await writeFile(path, bytes)
    return run(
      applyPlan(await readFile(path, "utf8"), digest(bytes), join(directory, "ledger"), mutate),
    )
  }
  return {
    directory,
    target,
    properties,
    raw,
    calls,
    plan,
    apply,
    run,
    writes: () => writes,
    setRoot: (value: string) => {
      root = value
    },
    setRootBlocks: (value: unknown[]) => {
      rootBlocks = structuredClone(value)
    },
    setReference: (value: string) => {
      refBody = value
    },
    setAsset: () => {
      asset = Buffer.from([9, 1, 2, 255])
    },
    setBundle: () => {
      sourceBundle = Buffer.from(
        portableZip({
          kind: "skill",
          name: "Owned Fixture",
          description: "Independent proof fixture",
          main: "SKILL.md",
          files: [
            {
              path: "SKILL.md",
              bytes: new TextEncoder().encode(
                "---\nname: Owned Fixture\ndescription: Independent proof fixture\n---\n\n# Changed original\n",
              ),
            },
            { path: "assets/preserved.bin", bytes: new Uint8Array([8, 0, 8, 255]) },
          ],
        }),
      )
    },
    setUnknown: (value: typeof unknown, unavailable = false) => {
      unknown = value
      failReadback = unavailable
    },
    restoreReads: () => {
      failReadback = false
    },
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
      await rm(directory, { recursive: true, force: true })
    },
  }
}

for (const format of ["original-provenance-v1", "extended-guard-v1"] as const) {
  test(`${format}: exact owned proof conversion preserves all bytes and can only send one PATCH`, async () => {
    await fixture(format, async (f) => {
      const boundary = {
        id: "66666666-6666-4666-8666-666666666666",
        type: "heading_1",
        has_children: false,
      }
      f.setRootBlocks([
        {
          object: "block",
          ...boundary,
          parent: { type: "page_id", page_id: page },
          heading_1: { rich_text: rich("Original authored root") },
        },
      ])
      const plan = await f.plan()
      expect(
        plan.targets[0]!.before.references.find((reference) => reference.id === page)?.blocks,
      ).toEqual([{ ...boundary, text: "Original authored root" }])
      const serializedPlan: unknown = JSON.parse(JSON.stringify(plan))
      expect(strict(PlanSchema, serializedPlan)).toEqual(serializedPlan)
      expect(f.writes()).toBe(0)
      const before = structuredClone(f.properties)
      const result = await f.apply(plan)
      expect(result.results).toEqual([{ page_id: page, state: "converted", wrote: true }])
      expect(f.writes()).toBe(1)
      expect(
        Object.fromEntries(Object.entries(f.properties).filter(([key]) => key !== "Publication")),
      ).toEqual(Object.fromEntries(Object.entries(before).filter(([key]) => key !== "Publication")))
      const converted = JSON.parse(plan.targets[0]!.after.publication)
      expect(converted.version).toBe(2)
      expect(converted.intended_hash).toBe(JSON.parse(f.target.expected_publication).intended_hash)
      expect(converted.manifest_hash).toBe(JSON.parse(f.target.expected_publication).manifest_hash)
      const patch = f.calls.find((call) => call.method === "PATCH")!
      expect(Object.keys(property(property(patch.body).properties))).toEqual(["publication"])
      const names = await readdir(join(f.directory, "ledger"))
      const observation = JSON.parse(
        await readFile(
          join(f.directory, "ledger", names.find((name) => name.endsWith("observation.json"))!),
          "utf8",
        ),
      )
      expect(observation.observed.files).toEqual(plan.targets[0]!.before.files)
      expect(observation.observed.references).toEqual(plan.targets[0]!.before.references)
      expect(plan.targets[0]!.before.files.some((file) => file.path === BUNDLE)).toBe(true)
      expect(
        plan.targets[0]!.before.files.some((file) => file.path === "assets/preserved.bin"),
      ).toBe(true)
      const again = await f.apply(plan)
      expect(again.results[0]).toMatchObject({ state: "converted", wrote: false })
      expect(f.writes()).toBe(1)
    })
  })
  test(`${format}: selected historical formula cannot silently fall back`, async () => {
    await fixture(format, async (f) => {
      const wrong = {
        ...f.target,
        source_format:
          format === "original-provenance-v1"
            ? ("extended-guard-v1" as const)
            : ("original-provenance-v1" as const),
      }
      await expect(f.run(makePlan({ format: 1, targets: [wrong] }))).rejects.toThrow()
      expect(f.writes()).toBe(0)
    })
  })
}

test("reviewed plan schemas accept absent boundaries and reject malformed or extra evidence", async () => {
  await fixture("extended-guard-v1", async (f) => {
    const plan = await f.plan()
    const withoutBoundaries = {
      ...plan,
      targets: plan.targets.map((target) => ({
        ...target,
        before: {
          ...target.before,
          references: target.before.references.map(
            ({ blocks: _blocks, ...reference }) => reference,
          ),
        },
      })),
    }
    const serializedPlan: unknown = JSON.parse(JSON.stringify(withoutBoundaries))
    expect(strict(PlanSchema, serializedPlan)).toEqual(serializedPlan)
    for (const change of [
      { id: 123 },
      { type: null },
      { has_children: "false" },
      { text: 123 },
      { unreviewed: true },
    ]) {
      const malformed = {
        ...plan,
        targets: plan.targets.map((target) => ({
          ...target,
          before: {
            ...target.before,
            references: target.before.references.map((reference) => ({
              ...reference,
              blocks: [{ id: page, type: "paragraph", has_children: false, ...change }],
            })),
          },
        })),
      }
      expect(() => strict(PlanSchema, JSON.parse(JSON.stringify(malformed)))).toThrow()
    }
    expect(f.writes()).toBe(0)
  })
})

for (const change of [
  "root",
  "reference",
  "asset",
  "bundle",
  "provenance",
  "members",
  "default",
] as const) {
  test(`${change} changes block reviewed-plan apply without PATCH`, async () => {
    await fixture("original-provenance-v1", async (f) => {
      const plan = await f.plan()
      if (change === "root") f.setRoot("# External root edit\n")
      if (change === "reference") f.setReference("# External reference edit\n")
      if (change === "asset") f.setAsset()
      if (change === "bundle") f.setBundle()
      if (change === "provenance")
        f.properties["Upstream Key"] = { type: "rich_text", rich_text: rich("external") }
      if (change === "members")
        f.properties.Members = { type: "relation", relation: [{ id: member }], has_more: false }
      if (change === "default")
        f.properties["Default Context"] = { type: "checkbox", checkbox: true }
      await expect(f.apply(plan)).rejects.toThrow()
      expect(f.writes()).toBe(0)
    })
  })
}

test("old root and reference edits cannot hide behind the unchanged source bundle", async () => {
  await fixture("original-provenance-v1", async (f) => {
    f.setRoot("# Edited current root\n")
    await expect(f.plan()).rejects.toThrow()
    f.setRoot("# Original authored root\n")
    f.setReference("# Edited current reference\n")
    await expect(f.plan()).rejects.toThrow()
    expect(f.writes()).toBe(0)
  })
})

for (const landed of [true, false]) {
  test(`unknown write outcome ${landed ? "landed" : "unlanded"}: read-only reconciliation never resends`, async () => {
    await fixture("original-provenance-v1", async (f) => {
      const plan = await f.plan()
      f.setUnknown(landed ? "landed" : "unlanded", true)
      expect((await f.apply(plan)).results[0]).toMatchObject({ state: "unknown", wrote: true })
      f.restoreReads()
      expect((await f.apply(plan, false)).results[0]).toMatchObject({
        state: landed ? "converted" : "unchanged",
        wrote: false,
      })
      expect((await f.apply(plan)).results[0]).toMatchObject({
        state: landed ? "converted" : "unchanged",
        wrote: false,
      })
      expect(f.writes()).toBe(1)
    })
  })
}

test("an unknown response with immediately visible exact v2 proof is reconciled successfully", async () => {
  await fixture("extended-guard-v1", async (f) => {
    const plan = await f.plan()
    f.setUnknown("landed")
    expect((await f.apply(plan)).results[0]).toMatchObject({ state: "converted", wrote: true })
    expect(f.writes()).toBe(1)
  })
})

test.each(["root", "reference", "metadata"] as const)(
  "converted marker does not hide concurrent %s changes during lost-response recovery",
  async (change) => {
    await fixture("extended-guard-v1", async (f) => {
      const plan = await f.plan()
      f.setUnknown("landed", true)
      expect((await f.apply(plan)).results[0]).toMatchObject({ state: "unknown", wrote: true })
      if (change === "root") f.setRoot("# Concurrent root edit\n")
      if (change === "reference") f.setReference("# Concurrent reference edit\n")
      if (change === "metadata")
        f.properties["Reviewer Note"] = {
          id: "reviewer-note",
          type: "rich_text",
          rich_text: rich("Concurrent note"),
        }
      f.restoreReads()
      for (const mutate of [false, true])
        expect((await f.apply(plan, mutate)).results[0]).toMatchObject({
          state: "conflict",
          wrote: false,
        })
      expect(f.writes()).toBe(1)
    })
  },
)

test("unmanaged pages and empty or missing Publication are rejected without enrolling them", async () => {
  await fixture("original-provenance-v1", async (f) => {
    f.properties.Publication = { id: "publication", type: "rich_text", rich_text: [] }
    await expect(f.plan()).rejects.toThrow()
    delete f.properties.Publication
    await expect(f.plan()).rejects.toThrow()
    expect(f.writes()).toBe(0)
  })
})

test("expected metadata and source format are mandatory and retained baseline bytes must match", async () => {
  await fixture("original-provenance-v1", async (f) => {
    for (const name of [
      "expected_members",
      "expected_default_context",
      "source_format",
      "audit_ref",
      "audit_sha256",
    ]) {
      const target = { ...f.target } as Record<string, unknown>
      delete target[name]
      await expect(
        f.run(makePlan({ format: 1, targets: [target as unknown as Target] })),
      ).rejects.toThrow()
    }
    await writeFile(f.target.audit_ref, "{}")
    await expect(f.plan()).rejects.toThrow()
    expect(f.writes()).toBe(0)
  })
})

test("exact reviewed-plan hash is mandatory", async () => {
  await fixture("original-provenance-v1", async (f) => {
    const plan = await f.plan()
    await expect(
      f.run(applyPlan(JSON.stringify(plan), "0".repeat(64), join(f.directory, "ledger"), true)),
    ).rejects.toThrow()
    expect(f.writes()).toBe(0)
  })
})

for (const kind of ["skill", "prompt", "router"] as const) {
  test(`canonical-name-v2 ${kind}: retained alias proof converts only Publication and preserves bytes`, async () => {
    await fixture(
      "canonical-name-v2",
      async (f) => {
        const plan = await f.plan()
        const before = structuredClone(f.properties)
        const old = JSON.parse(f.target.expected_publication)
        const next = JSON.parse(plan.targets[0]!.after.publication)
        expect(next).toMatchObject({
          version: 2,
          operation_id: old.operation_id,
          intended_hash: old.intended_hash,
          creation: old.creation,
        })
        expect(next.manifest_hash).not.toBe(old.manifest_hash)
        const baseline = JSON.parse(await readFile(f.target.canonical_baseline_ref!, "utf8"))
        for (const file of plan.targets[0]!.before.files) {
          const historical = baseline.files.find(
            (entry: { path: string }) => entry.path === file.path,
          )
          expect(historical).toBeDefined()
          if (file.path === baseline.snapshot.entrypoint) {
            expect(Buffer.from(file.base64, "base64").toString("utf8")).toBe(
              Buffer.from(historical.base64, "base64")
                .toString("utf8")
                .replace(
                  `"name": ${JSON.stringify(aliasFor(baseline.snapshot.record.name))}\n`,
                  `"name": ${JSON.stringify(baseline.snapshot.record.name)}\n`,
                ),
            )
          } else expect(file).toEqual(historical)
        }
        expect(plan.targets[0]!.before.files.some((file) => file.path === BUNDLE)).toBe(true)
        expect((await f.apply(plan)).results[0]).toMatchObject({ state: "converted", wrote: true })
        expect(f.properties).toEqual({ ...before, Publication: f.properties.Publication })
        expect(
          f.calls
            .filter((call) => call.method === "PATCH")
            .map((call) => Object.keys(property(property(call.body).properties))),
        ).toEqual([["publication"]])
        expect((await f.apply(plan)).results[0]).toMatchObject({ state: "converted", wrote: false })
        expect(f.writes()).toBe(1)
      },
      kind,
    )
  })
}

for (const change of [
  "fake-file",
  "body",
  "rawref",
  "nonentryasset",
  "bundle",
  "baselinehash",
  "receipthash",
  "schema-extra",
  "snapshot-extra",
  "receipt-unverified",
  "receipt-record",
  "arbitrary-v2",
] as const) {
  test(`canonical-name-v2 rejects ${change} without PATCH`, async () => {
    await fixture("canonical-name-v2", async (f) => {
      const baselinePath = f.target.canonical_baseline_ref!
      const baseline = JSON.parse(await readFile(baselinePath, "utf8"))
      if (change === "body") f.setRoot("# Changed authored body\n")
      if (change === "rawref") f.setReference("# Changed raw reference\n")
      if (change === "nonentryasset") f.setAsset()
      if (change === "bundle") f.setBundle()
      if (change === "baselinehash") f.target.canonical_baseline_sha256 = "0".repeat(64)
      if (change === "receipthash") baseline.receipt_sha256 = "0".repeat(64)
      if (change === "schema-extra") baseline.extra = "unreviewed"
      if (change === "snapshot-extra") baseline.snapshot.extra = "unreviewed"
      if (change === "fake-file") {
        const file = baseline.files.find(
          (entry: { path: string }) => entry.path === baseline.snapshot.entrypoint,
        )
        file.base64 = Buffer.from("fake historical entry").toString("base64")
      }
      if (change === "receipt-unverified" || change === "receipt-record") {
        const receipt = JSON.parse(await readFile(baseline.receipt_ref, "utf8"))
        if (change === "receipt-unverified") receipt.verified = false
        else receipt.record = { ...receipt.record, description: "Foreign receipt record" }
        const bytes = JSON.stringify(receipt)
        await writeFile(baseline.receipt_ref, bytes)
        baseline.receipt_sha256 = digest(bytes)
      }
      if (change === "arbitrary-v2") {
        const marker = {
          ...JSON.parse(f.target.expected_publication),
          manifest_hash: digest("arbitrary old manifest"),
        }
        marker.revision = digest(
          canonical([
            marker.operation_id,
            marker.intended_hash,
            marker.manifest_hash,
            marker.ownership_hash,
          ]),
        )
        f.target.expected_publication = JSON.stringify(marker)
        f.properties.Publication = {
          id: "publication",
          type: "rich_text",
          rich_text: rich(f.target.expected_publication),
        }
        const audit = JSON.stringify(f.raw)
        await writeFile(f.target.audit_ref, audit)
        f.target.audit_sha256 = digest(audit)
      }
      if (change !== "baselinehash") {
        const bytes = JSON.stringify(baseline)
        await writeFile(baselinePath, bytes)
        f.target.canonical_baseline_sha256 = digest(bytes)
      }
      await expect(f.plan()).rejects.toThrow()
      expect(f.writes()).toBe(0)
    })
  })
}

for (const evidence of ["canonical_baseline_ref", "canonical_baseline_sha256"] as const) {
  test(`canonical baseline field ${evidence} is required for v2 and forbidden for v1`, async () => {
    await fixture("canonical-name-v2", async (f) => {
      delete f.target[evidence]
      await expect(f.plan()).rejects.toThrow()
    })
    await fixture("extended-guard-v1", async (f) => {
      const target = {
        ...f.target,
        [evidence]: evidence.endsWith("sha256") ? "0".repeat(64) : "/unused-baseline",
      }
      await expect(f.run(makePlan({ format: 1, targets: [target] }))).rejects.toThrow()
      expect(f.writes()).toBe(0)
    })
  })
}

for (const evidence of ["baseline", "receipt"] as const) {
  test(`canonical-name-v2 apply binds retained ${evidence} bytes`, async () => {
    await fixture("canonical-name-v2", async (f) => {
      const plan = await f.plan()
      const baseline = JSON.parse(await readFile(f.target.canonical_baseline_ref!, "utf8"))
      await writeFile(
        evidence === "baseline" ? f.target.canonical_baseline_ref! : baseline.receipt_ref,
        "{}",
      )
      await expect(f.apply(plan)).rejects.toThrow()
      expect(f.writes()).toBe(0)
    })
  })
}

for (const field of ["ownership_hash", "revision", "extra"] as const) {
  test(`canonical-name-v2 verifies strict historical marker ${field}`, async () => {
    await fixture("canonical-name-v2", async (f) => {
      const marker = {
        ...JSON.parse(f.target.expected_publication),
        [field]: field === "extra" ? true : digest(`foreign ${field}`),
      }
      if (field === "ownership_hash")
        marker.revision = digest(
          canonical([
            marker.operation_id,
            marker.intended_hash,
            marker.manifest_hash,
            marker.ownership_hash,
          ]),
        )
      f.target.expected_publication = JSON.stringify(marker)
      f.properties.Publication = {
        id: "publication",
        type: "rich_text",
        rich_text: rich(f.target.expected_publication),
      }
      const audit = JSON.stringify(f.raw)
      await writeFile(f.target.audit_ref, audit)
      f.target.audit_sha256 = digest(audit)
      await expect(f.plan()).rejects.toThrow()
      expect(f.writes()).toBe(0)
    })
  })
}

test("canonical-name-v2 accepts a retained receipt JSON stdout wrapper", async () => {
  await fixture("canonical-name-v2", async (f) => {
    const path = f.target.canonical_baseline_ref!
    const baseline = JSON.parse(await readFile(path, "utf8"))
    const receipt = await readFile(baseline.receipt_ref, "utf8")
    const bytes = JSON.stringify({ ok: true, stdout: receipt })
    await writeFile(baseline.receipt_ref, bytes)
    baseline.receipt_sha256 = digest(bytes)
    const retained = JSON.stringify(baseline)
    await writeFile(path, retained)
    f.target.canonical_baseline_sha256 = digest(retained)
    expect((await f.plan()).targets).toHaveLength(1)
    expect(f.writes()).toBe(0)
  })
})
