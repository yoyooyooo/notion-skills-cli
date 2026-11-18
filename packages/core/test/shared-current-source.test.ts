import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Crypto, Effect, FileSystem, Path, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { fail, property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import type { SharedLibrary } from "../src/shared-library-model.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import {
  currentSharedSourceRevision,
  resolveCurrentSharedSources,
  validateCurrentSharedSourceContent,
  type CurrentSharedSourceContent,
} from "../src/shared-current-source.ts"
import { Store } from "../src/store.ts"
import { integrityRepositoryFixture, upstreamRepositoryFixture } from "./fixtures.ts"

const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const encode = (value: string) => new TextEncoder().encode(value)
const origin = "https://raw.githubusercontent.com"
const library: SharedLibrary = {
  version: 1,
  library_id: "current-library",
  operation_id: "current-library",
  parent_page_id: id(1),
  skills: { database_id: id(2), data_source_id: id(3), property_ids: {} },
  files: { database_id: id(4), data_source_id: id(5), property_ids: {} },
  records: { database_id: id(6), data_source_id: id(7), property_ids: {} },
  sources: {
    database_id: id(8),
    data_source_id: id(9),
    property_ids: {
      "Source ID": "source",
      Content: "content",
      Enabled: "enabled",
      Status: "status",
      "Last Revision": "revision",
    },
  },
}
const content = (files: Readonly<Record<string, string>>): CurrentSharedSourceContent => ({
  version: 1,
  plan: {
    version: 1,
    kind: "composition",
    base: {
      kind: "http",
      manifest: {
        version: 1,
        files: Object.entries(files).map(([path, body]) => ({
          path,
          sha256: digest(body),
          bytes: encode(body).length,
          mode: "100644",
        })),
      },
      locations: Object.entries(files).map(([path, body]) => ({
        sha256: digest(body),
        url: `${origin}/example/skills/fixed/${path}`,
      })),
    },
    mounts: [],
  },
})
const rich = (id: string, value: string) => ({
  id,
  type: "rich_text",
  rich_text: [{ type: "text", text: { content: value }, plain_text: value }],
  has_more: false,
})
function row(sourceId: string, value: CurrentSharedSourceContent, page = id(20)) {
  const canonical = validateCurrentSharedSourceContent(value)
  const revision = digest(canonicalSharedJson(canonical.plan))
  return {
    object: "page",
    id: page,
    parent: {
      type: "data_source_id",
      data_source_id: library.sources!.data_source_id,
      database_id: library.sources!.database_id,
    },
    properties: {
      source: rich("source", sourceId),
      content: rich("content", JSON.stringify(canonical)),
      revision: rich("revision", revision),
      enabled: { id: "enabled", type: "checkbox", checkbox: true },
      status: { id: "status", type: "select", select: { name: "ready" } },
    },
  }
}
type SourceRow = ReturnType<typeof row>
const selection = (row: SourceRow) => ({
  source_id: row.properties.source.rich_text[0]!.plain_text,
  revision: row.properties.revision.rich_text[0]!.plain_text,
})
const list = (results: readonly unknown[], next: string | null = null) => ({
  object: "list",
  results,
  has_more: next !== null,
  next_cursor: next,
})
type Requirements =
  | Store
  | Notion
  | Crypto.Crypto
  | HttpClient.HttpClient
  | FileSystem.FileSystem
  | Path.Path

function fixture(
  responses: readonly unknown[],
  bodies: ReadonlyMap<string, Uint8Array> = new Map(),
) {
  const calls: Array<{ path: string; body: unknown; method: string }> = []
  const requests: string[] = []
  const objects = new Map<string, Uint8Array>()
  const json = new Map<string, unknown>()
  const unexpected = () => Effect.die(new Error("Unexpected Store mutation"))
  const store: Store["Service"] = {
    root: "/controlled",
    configRoot: "/controlled/config",
    cacheRoot: "/controlled/cache",
    upstream: upstreamRepositoryFixture(),
    integrity: integrityRepositoryFixture(),
    reserveCacheGeneration: unexpected,
    listKeys: unexpected,
    retireKeys: unexpected,
    registerBindingWithBase: unexpected,
    advanceBaseAndReceipt: unexpected,
    backup: unexpected,
    output: unexpected,
    readJson: (key, schema) =>
      Effect.sync(() =>
        json.has(key) ? Schema.decodeUnknownSync(schema)(json.get(key)) : undefined,
      ),
    writeJson: (key, value) =>
      Effect.sync(() => {
        json.set(key, structuredClone(value))
      }),
    readBytes: (key) =>
      objects.has(key)
        ? Effect.succeed(objects.get(key)!.slice())
        : Effect.fail(fail("SNAPSHOT_MISSING", "No local bytes")),
    writeBytes: (key, bytes) =>
      Effect.sync(() => {
        objects.set(key, bytes.slice())
      }),
  }
  const notion: Notion["Service"] = {
    version: Effect.succeed("test"),
    credentialIdentity: Effect.succeed("test"),
    request: (path, body, options) =>
      Effect.gen(function* () {
        const method = options?.method ?? (body === undefined ? "GET" : "POST")
        calls.push({ path, body, method })
        if (
          method !== "POST" ||
          !path.startsWith(`v1/data_sources/${library.sources!.data_source_id}/query?`)
        )
          return yield* Effect.die(new Error("A current Source reader must only query Sources"))
        const response = responses[calls.length - 1]
        if (response === undefined)
          return yield* Effect.die(new Error("Unexpected extra Source query"))
        return response
      }),
  }
  const http = HttpClient.make((request, url) =>
    Effect.sync(() => {
      requests.push(url.href)
      const bytes = bodies.get(url.href)
      return HttpClientResponse.fromWeb(
        request,
        bytes === undefined
          ? new Response(null, { status: 404 })
          : new Response(bytes.slice(), { headers: { "content-length": String(bytes.length) } }),
      )
    }),
  )
  const run = <A, E>(effect: Effect.Effect<A, E, Requirements>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provideService(Store, store),
        Effect.provideService(Notion, notion),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provide(NodeServices.layer),
      ),
    )
  return { calls, requests, objects, json, run }
}

describe("current Sources", () => {
  test("two Sources share one metadata query and only requested bytes are fetched", async () => {
    const first = row("docs", content({ "SKILL.md": "main", "unused.md": "unused" }))
    const second = row("scripts", content({ "run.sh": "echo selected\n" }), id(21))
    const url = `${origin}/example/skills/fixed/run.sh`
    const f = fixture([list([first, second])], new Map([[url, encode("echo selected\n")]]))
    const sources = await f.run(
      resolveCurrentSharedSources(library, {
        selections: [selection(first), selection(second)],
        sourceOptions: {},
      }),
    )
    expect(f.calls).toHaveLength(1)
    expect(property(f.calls[0]!.body).filter).toEqual({
      or: [
        { property: "source", rich_text: { equals: "docs" } },
        { property: "source", rich_text: { equals: "scripts" } },
      ],
    })
    expect(sources.get("docs")!.manifest.map((file) => file.path)).toEqual([
      "SKILL.md",
      "unused.md",
    ])
    expect(f.requests).toEqual([])
    const result = await f.run(sources.get("scripts")!.materialize(["run.sh"]))
    expect(result.files).toEqual([
      { path: "run.sh", bytes: encode("echo selected\n"), mode: "100644" },
    ])
    expect(f.requests).toEqual([url])
    expect(f.calls).toHaveLength(1)
  })

  test("duplicate selection coalesces but duplicate current physical rows are rejected after pagination", async () => {
    const current = row("docs", content({ "SKILL.md": "main" }))
    const same = selection(current)
    const f = fixture([list([current], "next"), list([{ ...current, id: id(22) }])])
    const error = await f.run(
      Effect.flip(
        resolveCurrentSharedSources(library, { selections: [same, same], sourceOptions: {} }),
      ),
    )
    expect(error.code).toBe("CURRENT_SOURCE_DUPLICATE")
    expect(f.calls).toHaveLength(2)
    expect(property(f.calls[1]!.body).start_cursor).toBe("next")
    expect(f.requests).toEqual([])
  })

  test.each(["disabled", "applying", "attention", "applied"])(
    "%s current Source cannot supply bytes",
    async (state) => {
      const current = row("docs", content({ "SKILL.md": "main" }))
      if (state === "disabled") current.properties.enabled.checkbox = false
      else current.properties.status.select.name = state
      const f = fixture([list([current])])
      const error = await f.run(
        Effect.flip(
          resolveCurrentSharedSources(library, {
            selections: [selection(current)],
            sourceOptions: {},
          }),
        ),
      )
      expect(error.code).toBe(state === "disabled" ? "SOURCE_DISABLED" : "CURRENT_SOURCE_NOT_READY")
      expect(f.requests).toEqual([])
    },
  )

  test("a changed current plan or Last Revision rejects the selected fingerprint", async () => {
    const current = row("docs", content({ "SKILL.md": "main" }))
    for (const altered of [
      {
        ...current,
        properties: { ...current.properties, revision: rich("revision", "b".repeat(64)) },
      },
      {
        ...current,
        properties: {
          ...current.properties,
          content: row("docs", content({ "SKILL.md": "changed" })).properties.content,
        },
      },
    ]) {
      const f = fixture([list([altered])])
      const error = await f.run(
        Effect.flip(
          resolveCurrentSharedSources(library, {
            selections: [selection(current)],
            sourceOptions: {},
          }),
        ),
      )
      expect(error.code).toBe("SHARED_SOURCE_CONFLICT")
      expect(error.details).toMatchObject({ next: "reselect_current" })
      expect(f.requests).toEqual([])
    }
  })

  test("incomplete pagination and missing selected rows never establish a usable plan", async () => {
    const current = row("docs", content({ "SKILL.md": "main" }))
    for (const response of [
      { ...list([current]), request_status: { type: "incomplete" } },
      { ...list([current]), has_more: true, next_cursor: null },
      { ...list([current]), has_more: false, next_cursor: "unexpected" },
      {
        ...list([current]),
        results: [{ ...current, parent: { type: "data_source_id", data_source_id: id(99) } }],
      },
    ]) {
      const f = fixture([response])
      const result = await f.run(
        resolveCurrentSharedSources(library, {
          selections: [selection(current)],
          sourceOptions: {},
        }).pipe(Effect.result),
      )
      expect(result._tag).toBe("Failure")
      expect(f.requests).toEqual([])
    }
    const f = fixture([list([])])
    const error = await f.run(
      Effect.flip(
        resolveCurrentSharedSources(library, {
          selections: [selection(current)],
          sourceOptions: {},
        }),
      ),
    )
    expect(error.code).toBe("SHARED_SOURCE_MISSING")
  })

  test("old carriers and conflicting Source revisions fail before Notion access", async () => {
    const f = fixture([])
    for (const source_id of [
      "snapshot-" + "a".repeat(64),
      "bundle-" + "a".repeat(64),
      "source-plan-" + "a".repeat(64),
      "source-" + "a".repeat(64),
    ]) {
      const error = await f.run(
        Effect.flip(
          resolveCurrentSharedSources(library, {
            selections: [{ source_id, revision: "b".repeat(64) }],
            sourceOptions: {},
          }),
        ),
      )
      expect(error.code).toBe("CURRENT_SOURCE_REQUIRED")
    }
    const error = await f.run(
      Effect.flip(
        resolveCurrentSharedSources(library, {
          selections: [
            { source_id: "docs", revision: "a".repeat(64) },
            { source_id: "docs", revision: "b".repeat(64) },
          ],
          sourceOptions: {},
        }),
      ),
    )
    expect(error.code).toBe("SHARED_SOURCE_CONFLICT")
    expect(f.calls).toEqual([])
  })

  test("source fingerprints follow normalized plans and reject credentials, unknown fields and Git manifests without SHA", async () => {
    const value = content({ "SKILL.md": "main" })
    const f = fixture([])
    expect(await f.run(currentSharedSourceRevision(value))).toBe(
      selection(row("docs", value)).revision,
    )
    expect(() => validateCurrentSharedSourceContent({ ...value, history: [] })).toThrow()
    expect(() =>
      validateCurrentSharedSourceContent({
        ...value,
        plan: {
          ...value.plan,
          base: {
            kind: "http",
            manifest: {
              version: 1,
              files: [{ path: "SKILL.md", sha256: digest("main"), bytes: 4 }],
            },
            locations: [{ sha256: digest("main"), url: "https://user:secret@example.com/file" }],
          },
        },
      }),
    ).toThrow()
    expect(() =>
      validateCurrentSharedSourceContent({
        version: 1,
        plan: {
          version: 1,
          kind: "composition",
          mounts: [],
          base: {
            kind: "git",
            source: {
              url: "https://github.com/example/skills",
              commit: "1".repeat(40),
              tree: "2".repeat(40),
              root: "",
              files: [
                {
                  path: "SKILL.md",
                  source_path: "SKILL.md",
                  git_oid: "3".repeat(40),
                  bytes: 4,
                  mode: "100644",
                },
              ],
            },
          },
        },
      }),
    ).toThrow("SHA-256")
    expect(f.calls).toEqual([])
  })

  test("local Source plans require explicit machine bindings and cannot contain local paths", async () => {
    const local: CurrentSharedSourceContent = {
      version: 1,
      plan: {
        version: 1,
        kind: "composition",
        mounts: [],
        base: {
          kind: "local",
          binding_key: "docs",
          machine_scope: "machine",
          workspace_scope: "workspace",
          manifest: { version: 1, files: [{ path: "SKILL.md", sha256: digest("main"), bytes: 4 }] },
        },
      },
    }
    const current = row("local-docs", local)
    const f = fixture([list([current])])
    const error = await f.run(
      Effect.flip(
        resolveCurrentSharedSources(library, {
          selections: [selection(current)],
          sourceOptions: {},
        }),
      ),
    )
    expect(error.code).toBe("SOURCE_PLAN_LOCAL_BINDING_REQUIRED")
    expect(f.requests).toEqual([])
    expect(() =>
      validateCurrentSharedSourceContent({
        ...local,
        plan: { ...local.plan, base: { ...local.plan.base, absolute_root: "/private/local/path" } },
      }),
    ).toThrow()
  })

  test("an oversized current inline manifest fails before it could be truncated into Notion", () => {
    const large = content(
      Object.fromEntries(
        Array.from({ length: 1000 }, (_, index) => [`asset-${index}.txt`, `content-${index}`]),
      ),
    )
    expect(() => validateCurrentSharedSourceContent(large)).toThrow("inline limit")
  })
})
