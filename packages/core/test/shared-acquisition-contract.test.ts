import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Crypto, Effect, FileSystem, Path, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { openFixedSnapshotFiles } from "../src/fixed-snapshot-files.ts"
import { decode, fail, property, SnapshotSchema, type Snapshot } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { validateSnapshotAcquisition } from "../src/shared-acquisition-model.ts"
import { sharedRecordFromPage } from "../src/shared-content.ts"
import {
  validateCurrentSharedSourceContent,
  type CurrentSharedSourceContent,
} from "../src/shared-current-source.ts"
import { materializeSharedFixedAcquisition } from "../src/shared-fixed-acquisition.ts"
import { LIBRARY_MARKER, type SharedLibrary } from "../src/shared-library-model.ts"
import {
  sharedFileProperties,
  sharedRecordProperties,
  sharedSkillProperties,
} from "../src/shared-library.ts"
import { sourceDefinitionLayout } from "../src/shared-sources-model.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import { Store } from "../src/store.ts"

const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const skillPage = id(1)
const filePage = id(20)
const path = "references/current.md"
const resourceId = `resource-${"a".repeat(64)}`
const scope = hash(JSON.stringify(["principal", "", "https://api.notion.com", "credential"]))
const bindings = (names: readonly string[]) =>
  Object.fromEntries(names.map((name, index) => [name, name === "Name" ? "title" : `p${index}`]))
const library: SharedLibrary = {
  version: 1,
  library_id: "library-current",
  operation_id: "library-current",
  parent_page_id: id(2),
  skills: {
    database_id: id(3),
    data_source_id: id(4),
    property_ids: bindings(
      Object.keys({ ...sharedSkillProperties, Members: {}, Requires: {}, Origin: {} }),
    ),
  },
  files: {
    database_id: id(5),
    data_source_id: id(6),
    property_ids: bindings(Object.keys({ ...sharedFileProperties(id(4)), Origin: {} })),
  },
  records: {
    database_id: id(7),
    data_source_id: id(8),
    property_ids: bindings(Object.keys({ ...sharedRecordProperties(id(4)), Origin: {} })),
  },
  sources: {
    database_id: id(9),
    data_source_id: id(10),
    property_ids: bindings(Object.keys(sourceDefinitionLayout(id(4), id(8)))),
  },
}
const rich = (id: string, value: string) => ({
  id,
  type: "rich_text",
  rich_text: [{ type: "text", plain_text: value, text: { content: value } }],
  has_more: false,
})
const select = (id: string, name: string) => ({ id, type: "select", select: { name } })
const title = (value: string) => ({ id: "title", type: "title", title: [{ plain_text: value }] })
const checkbox = (id: string, value: boolean) => ({ id, type: "checkbox", checkbox: value })
const relation = (id: string, targets: readonly string[] = []) => ({
  id,
  type: "relation",
  relation: targets.map((id) => ({ id })),
  has_more: false,
})
const parent = (table: SharedLibrary["files"]) => ({
  type: "data_source_id",
  data_source_id: table.data_source_id,
  database_id: table.database_id,
})
const list = (results: readonly unknown[]) => ({
  object: "list",
  results,
  has_more: false,
  next_cursor: null,
})
type Requirements =
  | Store
  | Notion
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient

function fixture() {
  const skillIds = library.skills.property_ids
  const fileIds = library.files.property_ids
  const main = {
    object: "page",
    id: skillPage,
    parent: parent(library.skills),
    last_edited_time: "2026-01-01T00:00:00.000Z",
    properties: {
      name: title("current-skill"),
      description: rich(skillIds.Description!, "Current acquisition"),
      kind: select(skillIds.Kind!, "skill"),
      tags: { id: skillIds.Tags!, type: "multi_select", multi_select: [] },
      enabled: checkbox(skillIds.Enabled!, true),
      default: checkbox(skillIds["Default Context"]!, false),
      skill: rich(skillIds["Skill ID"]!, "current-skill"),
      main: rich(skillIds["Main File ID"]!, "main-file"),
      content: rich(
        skillIds.Content!,
        JSON.stringify({ kind: "native", frontmatter: "", mode: "100644" }),
      ),
      state: select(skillIds["Current State"]!, "ready"),
      operation: rich(skillIds.Operation!, ""),
      members: relation(skillIds.Members!),
      requires: relation(skillIds.Requires!),
      origin: relation(skillIds.Origin!),
    },
  }
  const file = {
    object: "page",
    id: filePage,
    parent: parent(library.files),
    last_edited_time: "2026-01-01T00:00:00.000Z",
    properties: {
      name: title("current.md"),
      file: rich(fileIds["File ID"]!, "current-file"),
      path: rich(fileIds.Path!, path),
      content: rich(
        fileIds.Content!,
        JSON.stringify({
          kind: "resource",
          object_id: resourceId,
          sha256: hash("body"),
          bytes: 4,
          mode: "100644",
        }),
      ),
      skill: relation(fileIds.Skill!, [skillPage]),
      origin: {
        id: fileIds.Origin!,
        type: "rollup",
        rollup: { type: "array", array: [], function: "show_unique" },
      },
    },
  }
  const record = sharedRecordFromPage(
    main,
    {
      alias: library.library_id,
      database_id: library.skills.database_id,
      data_source_ids: [library.skills.data_source_id],
      role: "content",
      title: "",
      shared_library: library,
    },
    library.skills.data_source_id,
  )
  const snapshot: Snapshot = {
    snapshot_id: `s_${"b".repeat(64)}`,
    scope,
    record,
    entrypoint: "SKILL.md",
    version_id: "c".repeat(64),
    created_at: 1,
    files: [
      { path: "SKILL.md", sha256: hash("main"), bytes: 4, mode: "100644" },
      { path, sha256: hash("body"), bytes: 4, mode: "100644" },
    ],
    file_bindings: [
      { file_id: "main-file", page_id: skillPage, path: "SKILL.md" },
      { file_id: "current-file", page_id: filePage, path },
    ],
    shared_acquisition: {
      version: 5,
      library,
      files: [{ kind: "resource", path, object_id: resourceId }],
    },
  }
  const calls: string[] = []
  const sourceRows: unknown[] = []
  const providerRequests: string[] = []
  const providerBodies = new Map<string, string>()
  const json = new Map<string, unknown>()
  const objects = new Map<string, Uint8Array>()
  const unexpected = () => Effect.die(new Error("Unexpected local operation"))
  const store: Store["Service"] = {
    root: "/controlled",
    configRoot: "/controlled/config",
    cacheRoot: "/controlled/cache",
    reserveCacheGeneration: unexpected,
    listKeys: unexpected,
    retireKeys: unexpected,
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
    credentialIdentity: Effect.succeed("credential"),
    connectionIdentity: Effect.succeed({
      principal: "principal",
      credential: "credential",
      connection: "test",
      workspace: null,
      api_origin: "https://api.notion.com",
    }),
    request: (request, body, options) =>
      Effect.gen(function* () {
        calls.push(request)
        if (request === `v1/databases/${library.skills.database_id}` && body === undefined)
          return {
            id: library.skills.database_id,
            description: [{ plain_text: LIBRARY_MARKER + JSON.stringify(library) }],
          }
        if (request === `v1/pages/${skillPage}` && body === undefined) return main
        if (
          request.startsWith(`v1/data_sources/${library.files.data_source_id}/query?`) &&
          options?.method === "POST"
        )
          return list([file])
        if (
          request.startsWith(`v1/data_sources/${library.sources!.data_source_id}/query?`) &&
          options?.method === "POST"
        )
          return list(sourceRows)
        return yield* Effect.die(new Error(`Unexpected remote access: ${request}`))
      }),
  }
  const http = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      providerRequests.push(url.href)
      const body = providerBodies.get(url.href)
      if (body === undefined)
        return yield* Effect.die(new Error("No provider access is authorized in this fixture"))
      return HttpClientResponse.fromWeb(
        request,
        new Response(body, {
          headers: { "content-length": String(new TextEncoder().encode(body).length) },
        }),
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
  return {
    snapshot,
    main,
    file,
    calls,
    json,
    objects,
    run,
    sourceRows,
    providerBodies,
    providerRequests,
  }
}

function sourceFixture() {
  const f = fixture()
  const sourcePath = "actual.md"
  const url = "https://raw.githubusercontent.com/example/current/fixed/actual.md"
  const content: CurrentSharedSourceContent = {
    version: 1,
    plan: {
      version: 1,
      kind: "composition",
      mounts: [],
      base: {
        kind: "http",
        manifest: {
          version: 1,
          files: [{ path: sourcePath, sha256: hash("body"), bytes: 4, mode: "100644" }],
        },
        locations: [{ sha256: hash("body"), url }],
      },
    },
  }
  const canonical = validateCurrentSharedSourceContent(content)
  if (!("plan" in canonical)) throw new Error("Expected an inline fixture plan")
  const revision = hash(canonicalSharedJson(canonical.plan))
  const descriptor = {
    kind: "source" as const,
    source_id: "docs",
    revision,
    source_path: sourcePath,
    sha256: hash("body"),
    bytes: 4,
    mode: "100644" as const,
  }
  const ids = library.sources!.property_ids
  const source = {
    object: "page",
    id: id(30),
    parent: parent(library.sources!),
    properties: {
      name: title("docs"),
      source: rich(ids["Source ID"]!, "docs"),
      content: rich(ids.Content!, JSON.stringify(canonical)),
      revision: rich(ids["Last Revision"]!, revision),
      enabled: checkbox(ids.Enabled!, true),
      status: select(ids.Status!, "ready"),
      operation: rich(ids.Operation!, ""),
      skills: relation(ids.Skills!),
      records: relation(ids.Records!),
    },
  }
  f.sourceRows.push(source)
  f.providerBodies.set(url, "body")
  f.file.properties.content = rich(library.files.property_ids.Content!, JSON.stringify(descriptor))
  const snapshot: Snapshot = {
    ...f.snapshot,
    shared_acquisition: {
      version: 5,
      library,
      files: [{ kind: "source", path, source_id: "docs", revision, source_path: sourcePath }],
    },
  }
  return { ...f, snapshot, source, url }
}

describe("current acquisition contract", () => {
  test("v5 independently binds each Source and rejects the previous single-Source shape", () => {
    const f = fixture()
    const source = (path: string, source_id: string) => ({
      kind: "source" as const,
      path,
      source_id,
      revision: "d".repeat(64),
      source_path: path,
    })
    const snapshot = decode(SnapshotSchema, {
      ...f.snapshot,
      shared_acquisition: {
        version: 5,
        library,
        files: [source("SKILL.md", "main-source"), source(path, "other-source")],
      },
    })
    expect([...validateSnapshotAcquisition(snapshot)]).toEqual(["SKILL.md", path])
    expect([...validateSnapshotAcquisition(f.snapshot)]).toEqual([path])
    expect(() =>
      decode(SnapshotSchema, {
        ...snapshot,
        shared_acquisition: { ...snapshot.shared_acquisition, version: 4, source: null },
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(SnapshotSchema)(
        { ...snapshot, shared_acquisition: { ...snapshot.shared_acquisition, source: null } },
        { onExcessProperty: "error" },
      ),
    ).toThrow()
    expect(f.calls).toEqual([])
  })

  test("old cached contracts require reselection without history or remote access", async () => {
    const f = fixture()
    for (const version of [1, 2, 3, 4]) {
      f.json.set(`snapshots/${f.snapshot.snapshot_id}.json`, {
        ...f.snapshot,
        shared_acquisition: { ...f.snapshot.shared_acquisition, version },
      })
      const error = await f.run(
        Effect.flip(openFixedSnapshotFiles(f.snapshot.snapshot_id, () => [path])),
      )
      expect(error.code).toBe("SNAPSHOT_MISSING")
      expect(error.details).toMatchObject({
        reason: "incompatible_acquisition",
        next: "reselect_current",
      })
    }
    expect(f.calls).toEqual([])
  })

  test("route identity, directory and one revision per Source are enforced without I/O", () => {
    const f = fixture()
    const acquisition = f.snapshot.shared_acquisition!
    const route = acquisition.files[0]!
    for (const changed of [
      { ...acquisition, files: [route, route] },
      { ...acquisition, files: [{ ...route, path: "absent.md" }] },
      { ...acquisition, library: { ...library, library_id: "library-other" } },
      {
        ...acquisition,
        files: [
          {
            kind: "source" as const,
            path,
            source_id: "bundle-" + "e".repeat(64),
            revision: "d".repeat(64),
            source_path: path,
          },
        ],
      },
      {
        ...acquisition,
        files: [
          {
            kind: "source" as const,
            path,
            source_id: "docs",
            revision: "d".repeat(64),
            source_path: path,
          },
          {
            kind: "source" as const,
            path: "SKILL.md",
            source_id: "docs",
            revision: "e".repeat(64),
            source_path: "SKILL.md",
          },
        ],
      },
    ])
      expect(() =>
        validateSnapshotAcquisition({ ...f.snapshot, shared_acquisition: changed }),
      ).toThrow()
    expect(f.calls).toEqual([])
  })

  test("offline acquisition never probes a current owner, Sources or resource", async () => {
    const f = fixture()
    const error = await f.run(
      Effect.flip(materializeSharedFixedAcquisition(f.snapshot, [path], { offline: true })),
    )
    expect(error.code).toBe("SNAPSHOT_MISSING")
    expect(f.calls).toEqual([])
  })

  test("missing selected source bytes use the still-current file mapping and one current Source query", async () => {
    const f = sourceFixture()
    const files = await f.run(materializeSharedFixedAcquisition(f.snapshot, [path]))
    expect(files).toEqual([{ path, bytes: new TextEncoder().encode("body") }])
    expect(f.providerRequests).toEqual([f.url])
    expect(f.calls).toHaveLength(4)
    expect(f.calls.some((request) => request.includes(library.records.data_source_id))).toBe(false)
  })

  test("delayed local source acquisition keeps exact bytes and durable local restrictions", async () => {
    const f = sourceFixture()
    const bytes = new TextEncoder().encode("\uFEFF© 作者\r\nexact\u0000bytes\r\n")
    const sha256 = createHash("sha256").update(bytes).digest("hex")
    const files = await f.run(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const paths = yield* Path.Path
          const temporaryRoot = yield* fs.makeTempDirectoryScoped({
            prefix: "ntn-current-local-acquisition-",
          })
          const root = yield* fs.realPath(temporaryRoot)
          yield* fs.writeFile(paths.join(root, "actual.md"), bytes)
          const workspaceRoot = yield* fs.realPath(paths.resolve("."))
          f.json.set("config.json", {
            sources: [],
            source_resources: {
              version: 1,
              machine_scope: "machine",
              workspaces: [
                {
                  workspace_scope: "workspace",
                  absolute_root: workspaceRoot,
                  bindings: [{ binding_key: "docs", absolute_root: root }],
                },
              ],
              http: { allowed_origins: [], locations_by_manifest: {} },
            },
          })
          const content = validateCurrentSharedSourceContent({
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
                manifest: {
                  version: 1,
                  files: [{ path: "actual.md", sha256, bytes: bytes.length, mode: "100644" }],
                },
              },
            },
          })
          if (!("plan" in content)) throw new Error("Expected an inline fixture plan")
          const revision = hash(canonicalSharedJson(content.plan))
          f.source.properties.content = rich(
            library.sources!.property_ids.Content!,
            JSON.stringify(content),
          )
          f.source.properties.revision = rich(
            library.sources!.property_ids["Last Revision"]!,
            revision,
          )
          f.file.properties.content = rich(
            library.files.property_ids.Content!,
            JSON.stringify({
              kind: "source",
              source_id: "docs",
              revision,
              source_path: "actual.md",
              sha256,
              bytes: bytes.length,
              mode: "100644",
            }),
          )
          const snapshot: Snapshot = {
            ...f.snapshot,
            files: f.snapshot.files.map((file) =>
              file.path === path ? { ...file, sha256, bytes: bytes.length } : file,
            ),
            shared_acquisition: {
              version: 5,
              library,
              files: [
                { kind: "source", path, source_id: "docs", revision, source_path: "actual.md" },
              ],
            },
          }
          return yield* materializeSharedFixedAcquisition(snapshot, [path])
        }),
      ),
    )
    expect(files).toEqual([{ path, bytes }])
    expect(f.objects.get(`objects/${sha256}`)).toEqual(bytes)
    expect(f.json.get(`content-restrictions/local/${sha256}.json`)).toEqual({
      version: 1,
      sha256,
      reason: "local_resource",
    })
    expect(f.providerRequests).toEqual([])
    expect(f.calls).toHaveLength(4)
  })

  test("a changed Source stops missing-cache recovery before any provider or old Records access", async () => {
    const f = sourceFixture()
    f.source.properties.revision = rich(
      library.sources!.property_ids["Last Revision"]!,
      "f".repeat(64),
    )
    const error = await f.run(Effect.flip(materializeSharedFixedAcquisition(f.snapshot, [path])))
    expect(error.code).toBe("SHARED_SOURCE_CONFLICT")
    expect(error.details).toMatchObject({ next: "reselect_current" })
    expect(f.providerRequests).toEqual([])
    expect(f.calls).toHaveLength(4)
  })

  test("disabled owner stops before Files or resource access", async () => {
    const f = fixture()
    f.main.properties.enabled.checkbox = false
    const error = await f.run(Effect.flip(materializeSharedFixedAcquisition(f.snapshot, [path])))
    expect(error.code).toBe("SKILL_DISABLED")
    expect(f.calls).toEqual([`v1/databases/${library.skills.database_id}`, `v1/pages/${skillPage}`])
  })

  test.each(["resource", "native", "identity", "path"])(
    "changed current %s cannot recover a former selected resource",
    async (change) => {
      const f = fixture()
      if (change === "resource")
        f.file.properties.content = rich(
          library.files.property_ids.Content!,
          JSON.stringify({
            kind: "resource",
            object_id: `resource-${"e".repeat(64)}`,
            sha256: hash("body"),
            bytes: 4,
            mode: "100644",
          }),
        )
      if (change === "native")
        f.file.properties.content = rich(
          library.files.property_ids.Content!,
          JSON.stringify({ kind: "native", frontmatter: "", mode: "100644" }),
        )
      if (change === "identity")
        f.file.properties.file = rich(library.files.property_ids["File ID"]!, "different-file")
      if (change === "path")
        f.file.properties.path = rich(library.files.property_ids.Path!, "moved.md")
      const error = await f.run(Effect.flip(materializeSharedFixedAcquisition(f.snapshot, [path])))
      expect(error.code).toBe("SHARED_ACQUISITION_CHANGED")
      expect(error.details).toMatchObject({ next: "reselect_current", path })
      expect(f.calls).toHaveLength(3)
      expect(f.calls.some((request) => request.includes(library.records.data_source_id))).toBe(
        false,
      )
    },
  )

  test("unfinished current work is reported without reconciling or querying operation history", async () => {
    const f = fixture()
    f.main.properties.state = select(library.skills.property_ids["Current State"]!, "attention")
    f.main.properties.operation = rich(library.skills.property_ids.Operation!, "current-edit")
    const error = await f.run(Effect.flip(materializeSharedFixedAcquisition(f.snapshot, [path])))
    expect(error.code).toBe("CURRENT_OPERATION_PENDING")
    expect(f.calls).toHaveLength(3)
  })
})
