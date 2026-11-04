import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { ConfigProvider, Effect } from "effect"
import { nodeRuntime } from "../packages/cli/src/runtime.ts"
import { type Snapshot, type Source, type Catalog } from "../packages/core/src/model.ts"
import { publishSnapshotObservation } from "../packages/core/src/cache.ts"
import { fileRef } from "../packages/core/src/ref.ts"
import { Store } from "../packages/core/src/store.ts"
import { prepareSharedSnapshotHistory } from "../packages/core/src/shared-snapshot-history.ts"
import { registerRetainedSnapshot } from "../packages/core/src/shared-history-materialization.ts"

const args = process.argv.slice(2)
if (
  (args.length !== 2 && !(args.length === 3 && args[2] === "--catalog")) ||
  args[0] !== "--outdir" ||
  !isAbsolute(args[1]!)
)
  throw new Error(
    "Usage: node scripts/sdk-fixture.ts --outdir /new/absolute/fixture-directory [--catalog]",
  )
const withCatalog = args[2] === "--catalog"
const root = args[1]!
await mkdir(root, { mode: 0o700 })
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const token = "sdk-controlled-offline-fixture-token"
const origin = "http://127.0.0.1:9"
const env = {
  NOTION_API_TOKEN: token,
  NOTION_WORKSPACE_ID: "",
  NOTION_API_BASE_URL: origin,
  NTN_SKILLS_HOME: "state",
  NTN_SKILLS_CONFIG_HOME: "config",
  NTN_SKILLS_CACHE_HOME: "cache",
}
const scope = hash(JSON.stringify(["sdk-fixture", "", origin, hash(token)]))
const bodies = new Map<string, Uint8Array>()
const names = ["a", "b", "c", "base", "broken", "foreign", "resources"]
const binary = Uint8Array.from([0, 255, 1, 2, 128, 13, 10])
const resourceFiles = [
  {
    path: "references/guide.md",
    file_id: "resource-utf8",
    bytes: new TextEncoder().encode("Resource instructions: 完整 UTF-8 α 😀.\n"),
    selected: true,
    encoding: "utf8" as const,
  },
  {
    path: "references/bom-crlf.md",
    file_id: "resource-bom-crlf",
    bytes: new TextEncoder().encode("\uFEFFResource BOM preserved.\r\n逐字节正文 β.\r\n"),
    selected: true,
    encoding: "utf8" as const,
  },
  {
    path: "references/empty.txt",
    file_id: "resource-empty",
    bytes: new Uint8Array(),
    selected: true,
    encoding: "utf8" as const,
  },
  {
    path: "assets/batch.bin",
    file_id: "resource-binary",
    bytes: binary,
    selected: true,
    encoding: "base64" as const,
  },
  {
    path: "references/unselected.txt",
    file_id: "resource-unselected",
    bytes: new TextEncoder().encode("UNSELECTED RESOURCE MUST NOT BE DELIVERED.\n"),
    selected: false,
    encoding: "utf8" as const,
  },
]
const snapshots: Snapshot[] = names.map((name, index) => {
  const library = name === "foreign" ? "sdk-foreign-library" : "sdk-library"
  const id = `shared_skill:${library}:${name}`
  const content =
    name === "a" ? "\uFEFF# a\r\n完整正文 α\r\n" : `# ${name}\nFull instruction ${name}.\n`
  const bytes = new TextEncoder().encode(content)
  bodies.set(hash(bytes), bytes)
  const version = hash(content)
  const page = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`
  return {
    scope,
    snapshot_id: `s_${hash(JSON.stringify([scope, id, version]))}`,
    version_id: version,
    created_at: 1000,
    record: {
      id,
      kind: "skill",
      name: name === "foreign" ? "a" : name,
      alias: name === "foreign" ? "a" : name,
      description: `Controlled SDK fixture ${name}`,
      enabled: true,
      default_context: false,
      entrypoint: "SKILL.md",
      ref: fileRef(id, "SKILL.md"),
      locator: {
        type: "shared_skill",
        library_id: library,
        skill_id: name,
        page_id: page,
        database_id: "00000000-0000-4000-8000-000000000010",
        data_source_id: "00000000-0000-4000-8000-000000000011",
      },
    },
    entrypoint: "SKILL.md",
    files: [
      { path: "SKILL.md", bytes: bytes.byteLength, sha256: hash(bytes) },
      ...(name === "a"
        ? [{ path: "assets/sample.bin", bytes: binary.byteLength, sha256: hash(binary) }]
        : []),
      ...(name === "resources"
        ? resourceFiles.map((file) => ({
            path: file.path,
            bytes: file.bytes.byteLength,
            sha256: hash(file.bytes),
          }))
        : []),
    ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    file_bindings: [
      { file_id: `main-${name}`, page_id: page, path: "SKILL.md" },
      ...(name === "a"
        ? [
            {
              file_id: "resource-a",
              page_id: "00000000-0000-4000-8000-000000000020",
              path: "assets/sample.bin",
            },
          ]
        : []),
      ...(name === "resources"
        ? resourceFiles.map((file, index) => ({
            file_id: file.file_id,
            page_id: `00000000-0000-4000-8000-${String(index + 101).padStart(12, "0")}`,
            path: file.path,
          }))
        : []),
    ],
    required: [],
    members: [],
  }
})
bodies.set(hash(binary), binary)
for (const file of resourceFiles) bodies.set(hash(file.bytes), file.bytes)
const resourceSnapshot = snapshots.find((snapshot) => snapshot.record.name === "resources")!
const ref = (snapshot: Snapshot) =>
  fileRef(
    snapshot.record.id,
    "SKILL.md",
    snapshot.snapshot_id,
    snapshot.file_bindings!.find((binding) => binding.path === "SKILL.md")!.file_id,
  )
const relation = (snapshot: Snapshot) => ({
  id: snapshot.record.id,
  ref: ref(snapshot),
  metadata: snapshot.record,
})
for (let index = 0; index < 3; index++)
  snapshots[index] = { ...snapshots[index]!, required: [relation(snapshots[3]!)] }
snapshots[4] = {
  ...snapshots[4]!,
  required: [
    {
      id: "shared_skill:sdk-library:missing",
      ref: fileRef(
        "shared_skill:sdk-library:missing",
        "SKILL.md",
        `s_${"f".repeat(64)}`,
        "main-missing",
      ),
      metadata: {
        kind: "skill",
        name: "missing",
        description: "Controlled missing Required",
        enabled: true,
      },
    },
  ],
}
const catalogSnapshots = snapshots.filter(
  (snapshot) => snapshot !== snapshots[4] && snapshot !== snapshots[5],
)
const seedEnv = {
  ...env,
  NTN_SKILLS_HOME: join(root, "state"),
  NTN_SKILLS_CONFIG_HOME: join(root, "config"),
  NTN_SKILLS_CACHE_HOME: join(root, "cache"),
}
const library: NonNullable<Source["shared_library"]> = {
  version: 1,
  library_id: "sdk-library",
  operation_id: "sdk-fixture",
  parent_page_id: "00000000-0000-4000-8000-000000000030",
  skills: {
    database_id: "00000000-0000-4000-8000-000000000010",
    data_source_id: "00000000-0000-4000-8000-000000000011",
    property_ids: {},
  },
  files: {
    database_id: "00000000-0000-4000-8000-000000000012",
    data_source_id: "00000000-0000-4000-8000-000000000013",
    property_ids: {},
  },
  records: {
    database_id: "00000000-0000-4000-8000-000000000014",
    data_source_id: "00000000-0000-4000-8000-000000000015",
    property_ids: {},
  },
}
const resourcePlan = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const store = yield* Store
      yield* store.writeJson(
        `cache/identities/${hash(JSON.stringify([hash(token), "", origin]))}.json`,
        { scope },
      )
      for (const [sha, bytes] of bodies) yield* store.writeBytes(`objects/${sha}`, bytes)
      for (const snapshot of snapshots)
        yield* store.writeJson(`snapshots/${snapshot.snapshot_id}.json`, snapshot)
      if (withCatalog) {
        const source: Source = {
          alias: "sdk-library",
          database_id: "00000000-0000-4000-8000-000000000010",
          title: "Controlled SDK fixture library",
          data_source_ids: ["00000000-0000-4000-8000-000000000011"],
          role: "content",
          shared_library: library,
        }
        yield* store.writeJson("config.json", { sources: [source] })
        const now = Date.now()
        for (const snapshot of catalogSnapshots) {
          const generation = yield* store.reserveCacheGeneration(scope, snapshot.record.id)
          yield* publishSnapshotObservation(snapshot, now, generation, {
            sharedBodyValidUntil: now + 300000,
          })
        }
        for (const database of ["auto", source.database_id])
          for (const selection of ["all", "content"]) {
            const key = [
              "database-selection-v6-shared",
              database,
              [source],
              ...(selection === "content" ? ["content-only"] : []),
            ]
            const catalog: Catalog = {
              scope,
              fetched_at: now,
              databases: [source],
              records: catalogSnapshots.map((snapshot) => snapshot.record),
              coverage: {
                method: database === "auto" ? "search_and_registered" : "explicit_database",
                exhaustive: database !== "auto",
                queried_data_sources: source.data_source_ids,
                failed_sources: [],
                search_index_limited: database === "auto",
              },
            }
            const identity = hash(JSON.stringify(key))
            const generation = yield* store.reserveCacheGeneration(scope, `catalog-${identity}`)
            yield* store.writeJson(`cache/catalogs/${scope}/${identity}.json`, {
              ...catalog,
              generation,
            })
          }
      }
      return yield* prepareSharedSnapshotHistory(library, resourceSnapshot)
    }),
  ).pipe(
    Effect.provide(nodeRuntime(root).live),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(seedEnv))),
  ),
)
// A separate admitted lazy pin reaches the real SDK identity/HTTP boundary.
// It intentionally has neither a complete local snapshot nor local source objects.
const retainedFixture = join(root, "retained-resource-source")
await mkdir(retainedFixture, { mode: 0o700 })
await Effect.runPromise(
  Effect.scoped(
    registerRetainedSnapshot(scope, library, resourcePlan.pin_id, resourcePlan.manifest),
  ).pipe(
    Effect.provide(nodeRuntime(retainedFixture).live),
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          ...env,
          NTN_SKILLS_HOME: join(retainedFixture, "state"),
          NTN_SKILLS_CONFIG_HOME: join(retainedFixture, "config"),
          NTN_SKILLS_CACHE_HOME: join(retainedFixture, "cache"),
        }),
      ),
    ),
  ),
)
const metadata = {
  version: 1,
  cwd: root,
  scope,
  env: join(root, "env.json"),
  catalog: withCatalog,
  database: "00000000-0000-4000-8000-000000000010",
  catalog_records: catalogSnapshots.map((snapshot) => snapshot.record.id),
  roots: snapshots.slice(0, 3).map(ref),
  broken: ref(snapshots[4]!),
  foreign: ref(snapshots[5]!),
  resource: {
    ref: fileRef(
      snapshots[0]!.record.id,
      "assets/sample.bin",
      snapshots[0]!.snapshot_id,
      "resource-a",
    ),
    sha256: hash(binary),
    bytes: binary.byteLength,
  },
  resourceBatch: {
    retained_fixture: retainedFixture,
    name: resourceSnapshot.record.name,
    owner_ref: ref(resourceSnapshot),
    refs: resourceFiles
      .filter((file) => file.selected)
      .map((file) =>
        fileRef(resourceSnapshot.record.id, file.path, resourceSnapshot.snapshot_id, file.file_id),
      ),
    files: resourceFiles
      .filter((file) => file.selected)
      .map((file) => ({
        ref: fileRef(
          resourceSnapshot.record.id,
          file.path,
          resourceSnapshot.snapshot_id,
          file.file_id,
        ),
        path: file.path,
        file_id: file.file_id,
        bytes: file.bytes.byteLength,
        sha256: hash(file.bytes),
        encoding: file.encoding,
        content:
          file.encoding === "base64"
            ? Buffer.from(file.bytes).toString("base64")
            : new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(file.bytes),
      })),
    unselected: resourceFiles
      .filter((file) => !file.selected)
      .map((file) => ({
        ref: fileRef(
          resourceSnapshot.record.id,
          file.path,
          resourceSnapshot.snapshot_id,
          file.file_id,
        ),
        path: file.path,
        file_id: file.file_id,
        bytes: file.bytes.byteLength,
        sha256: hash(file.bytes),
        content: new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(file.bytes),
      })),
    source_cache: "warm",
  },
  snapshots,
}
await writeFile(join(root, "env.json"), JSON.stringify(env, null, 2) + "\n", { mode: 0o600 })
await writeFile(join(root, "fixture.json"), JSON.stringify(metadata, null, 2) + "\n", {
  mode: 0o600,
})
console.log(
  JSON.stringify({
    fixture: join(root, "fixture.json"),
    snapshots: snapshots.length,
    network: "not-used",
  }),
)
