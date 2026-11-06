import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { ConfigProvider, Effect } from "effect"
import { nodeRuntime } from "../packages/cli/src/runtime.ts"
import {
  decode,
  property,
  text,
  aliasFor,
  type Snapshot,
  type Source,
  type Catalog,
  SnapshotSchema,
} from "../packages/core/src/model.ts"
import { publishSnapshotObservation } from "../packages/core/src/cache.ts"
import { fileRef } from "../packages/core/src/ref.ts"
import { Store } from "../packages/core/src/store.ts"
import { prepareSharedSnapshotHistory } from "../packages/core/src/shared-snapshot-history.ts"
import { registerRetainedSnapshot } from "../packages/core/src/shared-history-materialization.ts"
import { configureSharedHttpOrigins } from "../packages/core/src/shared-source-config.ts"
import { registerSourcePlanBinding } from "../packages/core/src/shared-source-plan-binding.ts"
import { LIBRARY_MARKER } from "../packages/core/src/shared-library-model.ts"
import { FileEventSchema } from "../packages/core/src/shared-file-state.ts"
import { sharedSkillId } from "../packages/core/src/shared-content.ts"
import { portableFiles } from "../packages/core/src/portable.ts"
import { Notion } from "../packages/core/src/notion.ts"
import { targetSnapshot } from "../packages/core/src/snapshot.ts"
import { prepareGraph } from "../packages/core/src/graph-prepare.ts"
import { nativeGraphFixture } from "../packages/core/test/graph-prepare-live-fixture.ts"
import {
  id as fixtureId,
  library as ownershipLibrary,
  rich,
  sharedSnapshotFixture,
  skillPage as ownershipPage,
} from "../packages/core/test/shared-snapshot-fixture.ts"

const args = process.argv.slice(2)
const recordsHistoryOnly = args.at(-1) === "--records-history"
if (recordsHistoryOnly) args.pop()
if (args.includes("--distinct-names") && args.includes("--ambiguous-names"))
  throw new Error("--distinct-names and --ambiguous-names are mutually exclusive fixture modes")
const distinctNames = args.at(-1) === "--distinct-names"
const ambiguousNames = args.at(-1) === "--ambiguous-names"
if (distinctNames || ambiguousNames) args.pop()
const defaultViewCache = args[4] ?? "complete"
if (
  (args.length !== 2 &&
    !(args.length === 3 && args[2] === "--catalog") &&
    !(args.length === 5 && args[2] === "--catalog" && args[3] === "--default-view-cache")) ||
  !["complete", "missing", "incomplete"].includes(defaultViewCache) ||
  (ambiguousNames && args[2] !== "--catalog") ||
  (recordsHistoryOnly && (args.length !== 2 || distinctNames || ambiguousNames)) ||
  args[0] !== "--outdir" ||
  !isAbsolute(args[1]!)
)
  throw new Error(
    "Usage: node scripts/sdk-fixture.ts --outdir /new/absolute/fixture-directory [--records-history | --catalog [--default-view-cache complete|missing|incomplete]] [--distinct-names | --ambiguous-names (requires --catalog)]",
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
if (recordsHistoryOnly) {
  // Use the existing producer, including its real parent/event/retention rules.
  // The consumer receives only the frozen service observations and empty config.
  const observations = []
  const finishedAt = Date.now() - 5000
  for (const history of [1, 101]) {
    const f = nativeGraphFixture()
    const [a, , c, d, optional] = f.pageIds
    const shared = f.pages[3]
    if (!a || !c || !d || !optional || !shared) throw new Error("History diamond is incomplete")
    for (const page of f.pages) page.last_edited_time = new Date(finishedAt).toISOString()
    const producer = []
    for (let revision = 0; revision < history; revision++) {
      shared.last_edited_time = new Date(finishedAt - (history - revision - 1) * 1000).toISOString()
      f.bodies.set(d, revision === history - 1 ? "# d instruction\n" : `# d history ${revision}\n`)
      f.clearCalls()
      const prepared = await f.run(
        prepareGraph(
          { roots: [d], purpose: "inspect", freshness: { policy: "refresh" } },
          { database: f.descriptor.skills.database_id, metrics: true },
        ),
      )
      if (prepared.status !== "ready") throw new Error(JSON.stringify(prepared))
      producer.push({
        revision,
        graph_lock: prepared.graph_lock,
        request_metrics: f.requestMetrics(),
        calls: structuredClone(f.calls),
      })
    }
    f.clearCalls()
    const prepared = await f.run(
      prepareGraph(
        { roots: [a, c], purpose: "use", freshness: { policy: "refresh" } },
        { database: f.descriptor.skills.database_id, metrics: true },
      ),
    )
    if (prepared.status !== "ready") throw new Error(JSON.stringify(prepared))
    const oracle = prepared.nodes
      .filter((node) => node.state === "prepared")
      .map((node) => {
        const snapshot = decode(
          SnapshotSchema,
          f.json.get(`snapshots/${node.binding.snapshot_id}.json`),
        )
        for (const file of snapshot.files) {
          const bytes = f.objects.get(`objects/${file.sha256}`)
          if (bytes === undefined || bytes.length !== file.bytes || hash(bytes) !== file.sha256)
            throw new Error("History producer oracle is incomplete")
        }
        return {
          record: snapshot.record,
          version_id: snapshot.version_id,
          entrypoint: snapshot.entrypoint,
          files: snapshot.files,
          file_bindings: snapshot.file_bindings,
          required: node.required,
          candidates: node.candidates,
          references: node.references,
          members: snapshot.members ?? [],
          content: node.content,
        }
      })
      .sort((left, right) => left.record.id.localeCompare(right.record.id))
    if (oracle.length !== 4 || oracle.some((node) => node.files.length !== 1))
      throw new Error("History measurement must preserve the four-file diamond")
    const records = structuredClone([...f.records.values()])
    const sharedEvents = records.filter((row) => {
      const fields = property(row.properties)
      const owners = property(fields.skill).relation
      return (
        property(property(fields.kind).select).name === "file_event" &&
        Array.isArray(owners) &&
        owners.some((owner) => property(owner).id === d)
      )
    })
    if (sharedEvents.length !== history)
      throw new Error(`Producer did not create ${history} distinct shared-file events`)
    const seed = join(root, `history-${history}-config`)
    await mkdir(seed, { mode: 0o700 })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* (yield* Store).writeJson("config.json", {
            sources: [
              {
                alias: f.descriptor.library_id,
                database_id: f.descriptor.skills.database_id,
                title: "Controlled Records history library",
                data_source_ids: [f.descriptor.skills.data_source_id],
                role: "content",
                shared_library: f.descriptor,
              },
            ],
          })
        }),
      ).pipe(
        Effect.provide(nodeRuntime(seed).live),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              ...env,
              NTN_SKILLS_HOME: join(seed, "state"),
              NTN_SKILLS_CONFIG_HOME: join(seed, "config"),
              NTN_SKILLS_CACHE_HOME: join(seed, "cache"),
            }),
          ),
        ),
      ),
    )
    const rootRefs = [a, c].map((id) => {
      const entry = oracle.find(
        (node) => node.record.locator.type === "shared_skill" && node.record.locator.page_id === id,
      )
      if (entry === undefined) throw new Error("History root is absent from its full oracle")
      return entry.record.ref
    })
    observations.push({
      history,
      seed,
      roots: rootRefs,
      optional_page: optional,
      shared_page: d,
      shared_event_count: sharedEvents.length,
      oracle,
      producer,
      final_producer: {
        graph_lock: prepared.graph_lock,
        request_metrics: f.requestMetrics(),
        calls: structuredClone(f.calls),
      },
      notion: {
        library: f.descriptor,
        database: {
          object: "database",
          id: f.descriptor.skills.database_id,
          database_type: null,
          title: [{ plain_text: "Controlled Records history library" }],
          description: [{ plain_text: LIBRARY_MARKER + JSON.stringify(f.descriptor) }],
          data_sources: [{ id: f.descriptor.skills.data_source_id, name: "Skills" }],
        },
        main: structuredClone(f.pages[0]),
        skills: structuredClone(f.pages),
        files: structuredClone(f.files),
        records,
        bodies: Object.fromEntries([...f.bodies].filter(([id]) => id !== optional)),
      },
    })
  }
  await writeFile(
    join(root, "history.json"),
    JSON.stringify({ version: 1, observations }, null, 2) + "\n",
    { mode: 0o600, flag: "wx" },
  )
  console.log(
    JSON.stringify({
      path: join(root, "history.json"),
      histories: [1, 101],
      production_network: false,
    }),
  )
  process.exit(0)
}
const scope = hash(JSON.stringify(["sdk-fixture", "", origin, hash(token)]))
const bodies = new Map<string, Uint8Array>()
const names = ["a", "b", "c", "base", "broken", "foreign", "resources", "entrypoint"]
const binary = Uint8Array.from([0, 255, 1, 2, 128, 13, 10])
// Keep the source complete. Independent consumers create their own partial-cache
// copies after a real public current observation has validated this whole tree.
const entrypointFiles = [
  {
    path: "references/selected.txt",
    file_id: "entrypoint-selected",
    bytes: new TextEncoder().encode("Selected entrypoint resource: 按需逐字节读取.\n"),
    role: "selected" as const,
  },
  {
    path: "assets/missing.bin",
    file_id: "entrypoint-missing",
    bytes: new Uint8Array(2 * 1024 * 1024).fill(0x81),
    role: "missing" as const,
  },
  {
    path: "assets/corrupt.bin",
    file_id: "entrypoint-corrupt",
    bytes: new Uint8Array(2 * 1024 * 1024).fill(0x82),
    role: "corrupt" as const,
  },
]
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
  // Derive both selectors before publishing the original manifest and current
  // receipts. Consumers never rewrite an alias inside signed fixture state.
  const displayName =
    name === "foreign"
      ? "a"
      : (distinctNames && name === "a") || (ambiguousNames && (name === "a" || name === "c"))
        ? "A"
        : name
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
      name: displayName,
      alias: aliasFor(displayName),
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
      ...(name === "entrypoint"
        ? entrypointFiles.map((file) => ({
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
      ...(name === "entrypoint"
        ? entrypointFiles.map((file, index) => ({
            file_id: file.file_id,
            page_id: `00000000-0000-4000-8000-${String(index + 201).padStart(12, "0")}`,
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
for (const file of entrypointFiles) bodies.set(hash(file.bytes), file.bytes)
const resourceSnapshot = snapshots.find((snapshot) => snapshot.record.name === "resources")!
const entrypointSnapshot = snapshots.find((snapshot) => snapshot.record.name === "entrypoint")!
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
const defaultView = {
  id: "00000000-0000-4000-8000-000000000041",
  name: "Controlled daily Skills",
  type: "table",
  database_id: "00000000-0000-4000-8000-000000000010",
  data_source_id: "00000000-0000-4000-8000-000000000011",
  url: "https://www.notion.so/00000000000040008000000000000010?v=00000000000040008000000000000041",
}
const defaultViewRecords = snapshots.slice(0, 2).map((snapshot) => snapshot.record)
const defaultViewCacheKeys: string[] = []
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
      // The new current-validation sample is available to the SDK-only fixture
      // too; catalog publication for the existing Pi cases stays opt-in.
      for (const snapshot of withCatalog ? catalogSnapshots : [entrypointSnapshot]) {
        const generation = yield* store.reserveCacheGeneration(scope, snapshot.record.id)
        yield* publishSnapshotObservation(snapshot, now, generation, {
          sharedBodyValidUntil: now + 300000,
        })
      }
      if (withCatalog) {
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
        // View observation is metadata only. Publishing it does not load or
        // validate any additional entrypoint or supporting-file object.
        for (const database of defaultViewCache === "missing" ? [] : [[source], source.database_id])
          for (const selection of ["first", defaultView.id]) {
            const identity = hash(
              JSON.stringify(["notion-views-v2-shared-metadata", ["members", selection, database]]),
            )
            const key = `cache/views/${scope}/${identity}.json`
            defaultViewCacheKeys.push(key)
            const generation = yield* store.reserveCacheGeneration(scope, `views-${identity}`)
            yield* store.writeJson(key, {
              scope,
              fetched_at: now,
              databases: [source],
              records: defaultViewRecords,
              coverage: {
                method: "explicit_view",
                exhaustive: defaultViewCache === "complete",
                queried_data_sources: source.data_source_ids,
                failed_sources:
                  defaultViewCache === "complete"
                    ? []
                    : [
                        {
                          id: defaultView.id,
                          code: "VIEW_INCOMPLETE",
                          database_id: source.database_id,
                          data_source_id: defaultView.data_source_id,
                        },
                      ],
                search_index_limited: false,
              },
              view: defaultView,
              view_selection: selection === "first" ? "first" : "explicit",
              view_query: {
                id: "00000000-0000-4000-8000-000000000042",
                expires_at: new Date(now + 300000).toISOString(),
                total_count: defaultViewRecords.length,
              },
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
// Build the ownership oracle through the retained full-byte composition API.
// Only serialized controlled Notion data and configuration reach the installed SDK;
// no in-memory Store, current receipt, snapshot or object is copied into its cwd.
const ownership = await (async () => {
  const f = sharedSnapshotFixture()
  await f.target({ selector: ownershipPage })
  const deleted = [...f.records.values()]
    .filter(
      (row) =>
        property(property(property(row.properties).kind).select).name === "file_event" &&
        text(property(property(row.properties).entity).rich_text) === "file-2",
    )
    .map((row) =>
      decode(
        FileEventSchema,
        property(JSON.parse(text(property(property(row.properties).payload).rich_text))).payload,
      ),
    )
    .find((event) => event.kind === "adopted")
  if (deleted?.kind !== "adopted") throw new Error("Expected actual retained native adoption")
  f.seedFact(
    {
      event_id: "sdk-delete-reference-two",
      file_id: "file-2",
      parents: [deleted.event_id],
      kind: "deleted",
      retained: deleted.content,
    },
    "file_event",
    "file-2",
    "sdk-delete-reference-two",
  )
  const providerOrigin = "https://ownership.resources.example.com"
  const mainMarker = "ownership-source-main-yaml-required"
  const completeSource = [
    {
      path: "SKILL.md",
      bytes: new TextEncoder().encode(
        `---\nname: Upstream name\ndescription: Upstream description\nlicense: Apache-2.0\nsource_marker: ${mainMarker}\n---\n\n# Upstream body replaced by native ownership\n`,
      ),
      role: "required" as const,
    },
    {
      path: "references/1.md",
      bytes: new Uint8Array(2 * 1024 * 1024).fill(0x61),
      role: "excluded" as const,
    },
    {
      path: "references/2.md",
      bytes: new Uint8Array(2 * 1024 * 1024).fill(0x62),
      role: "excluded" as const,
    },
    {
      path: "assets/following.bin",
      bytes: Uint8Array.from([0, 255, 128, 13, 10, 1, 2, 3]),
      role: "required" as const,
    },
  ]
  const providerRoot = join(root, "ownership-provider-bytes")
  await mkdir(providerRoot, { mode: 0o700 })
  const sourceFiles = await Promise.all(
    completeSource.map(async (file) => {
      const sha256 = hash(file.bytes)
      const sourceFile = join(providerRoot, sha256)
      await writeFile(sourceFile, file.bytes, { mode: 0o600, flag: "wx" })
      return {
        path: file.path,
        bytes: file.bytes.byteLength,
        sha256,
        role: file.role,
        url: `${providerOrigin}/fixed/${sha256}`,
        source_file: sourceFile,
      }
    }),
  )
  const registration = await f.run(
    registerSourcePlanBinding(ownershipLibrary, {
      skillPageId: ownershipPage,
      mode: "create",
      plan: {
        version: 1,
        kind: "composition",
        base: {
          kind: "http",
          manifest: {
            version: 1,
            files: sourceFiles.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
          },
          locations: sourceFiles.map(({ sha256, url }) => ({ sha256, url })),
        },
        mounts: [],
      },
    }),
  )
  const sourceId = registration.binding.source_plan_id
  property(f.main.properties).source = rich("source", sourceId)
  const fixedSource = { source_id: sourceId, revision: sourceId, files: completeSource }
  const oracle = (snapshot: Snapshot) => {
    for (const file of snapshot.files) {
      const bytes = f.objects.get(`objects/${file.sha256}`)
      if (bytes === undefined || bytes.byteLength !== file.bytes || hash(bytes) !== file.sha256)
        throw new Error("The full-byte ownership oracle is incomplete")
    }
    const main = snapshot.files.find((file) => file.path === snapshot.entrypoint)
    if (main === undefined) throw new Error("The full-byte oracle has no main file")
    return {
      files: snapshot.files,
      export_files: portableFiles(
        {
          kind: snapshot.record.kind,
          name: snapshot.record.name,
          description: snapshot.record.description,
          main: snapshot.entrypoint,
          files: snapshot.files.map((file) => ({
            path: file.path,
            bytes: f.objects.get(`objects/${file.sha256}`)!,
          })),
        },
        false,
        true,
      ).map((file) => ({
        path: file.path,
        bytes: file.bytes.byteLength,
        sha256: hash(file.bytes),
      })),
      main: new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(
        f.objects.get(`objects/${main.sha256}`)!,
      ),
    }
  }
  const cold = oracle(await f.open({ fixedSource }))
  const initialMain = structuredClone(f.main)
  property(f.main.properties).title = {
    id: "title",
    type: "title",
    title: [{ plain_text: "Ownership metadata refreshed" }],
  }
  property(f.main.properties).description = rich("description", "Updated ownership description")
  f.main.last_edited_time = new Date(
    Date.parse(String(f.main.last_edited_time)) + 1000,
  ).toISOString()
  const metadataOnly = oracle(await f.open({ fixedSource }))
  const seed = join(root, "ownership-current-source")
  await mkdir(seed, { mode: 0o700 })
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* (yield* Store).writeJson("config.json", {
          sources: [
            {
              alias: ownershipLibrary.library_id,
              database_id: ownershipLibrary.skills.database_id,
              title: "Controlled ownership library",
              data_source_ids: [ownershipLibrary.skills.data_source_id],
              role: "content",
              shared_library: ownershipLibrary,
            },
          ],
        })
        yield* configureSharedHttpOrigins([providerOrigin])
      }),
    ).pipe(
      Effect.provide(nodeRuntime(seed).live),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            ...env,
            NTN_SKILLS_HOME: join(seed, "state"),
            NTN_SKILLS_CONFIG_HOME: join(seed, "config"),
            NTN_SKILLS_CACHE_HOME: join(seed, "cache"),
          }),
        ),
      ),
    ),
  )
  return {
    seed,
    source_cache: "cold-current-without-source-objects-or-snapshots",
    source_id: sourceId,
    source_main_marker: mainMarker,
    source_files: sourceFiles,
    oracle: { cold, metadata: metadataOnly },
    notion: {
      library: ownershipLibrary,
      database: {
        object: "database",
        id: ownershipLibrary.skills.database_id,
        database_type: null,
        title: [{ plain_text: "Controlled ownership library" }],
        description: [{ plain_text: LIBRARY_MARKER + JSON.stringify(ownershipLibrary) }],
        data_sources: [{ id: ownershipLibrary.skills.data_source_id, name: "Skills" }],
      },
      main: initialMain,
      metadata_main: structuredClone(f.main),
      files: structuredClone(f.files),
      records: structuredClone([...f.records.values()]),
      bodies: Object.fromEntries(f.bodies),
    },
  }
})()
// A separate scalar fixture forces complete metadata pagination and an external
// disabled target. Its full-page oracle never uses the logical selector path.
const scalarInventory = await (async () => {
  const f = sharedSnapshotFixture()
  const scalarLibrary = {
    ...ownershipLibrary,
    skills: {
      ...ownershipLibrary.skills,
      property_ids: {
        ...ownershipLibrary.skills.property_ids,
        Members: "members",
        Requires: "requires",
      },
    },
  }
  property(f.main.properties).title = {
    id: "title",
    type: "title",
    title: [{ plain_text: "Scalar inventory root" }],
  }
  property(f.main.properties).description = rich("description", "Scalar current description")
  for (const field of ["members", "requires"])
    property(f.main.properties)[field] = {
      id: field,
      type: "relation",
      relation: [],
      has_more: false,
    }
  const skills = [
    f.main,
    ...Array.from({ length: 100 }, (_, index) => {
      const row: Record<string, unknown> = {
        ...structuredClone(f.main),
        id: fixtureId(1000 + index),
      }
      const fields = property(row.properties)
      fields.title = {
        id: "title",
        type: "title",
        title: [{ plain_text: `Inventory target ${index + 1}` }],
      }
      fields.skill_id = rich("skill_id", `inventory-${index + 1}`)
      fields.main_file_id = rich("main_file_id", `inventory-main-${index + 1}`)
      fields.references = rich("references", "UNSELECTED_METADATA_" + "x".repeat(4096))
      return row
    }),
  ]
  const available = skills[1]!
  const disabled = skills[100]!
  property(disabled.properties).enabled = { id: "enabled", type: "checkbox", checkbox: false }
  const nativeUrl = (page: Record<string, unknown>) =>
    "https://www.notion.so/" + String(page.id).replaceAll("-", "")
  f.bodies.set(
    ownershipPage,
    `# Scalar inventory body\n\nKeep the complete authored body and both native links.\n\n[Available target](${nativeUrl(available)})\n\n[Disabled target](${nativeUrl(disabled)})\n`,
  )
  const observeFull = () =>
    f.run(
      Effect.gen(function* () {
        const api = yield* Notion
        return yield* targetSnapshot({ selector: ownershipPage }, { refresh: true }).pipe(
          Effect.provideService(Notion, {
            ...api,
            request: (path, body, options) => {
              const url = new URL(path, "https://api.notion.com/")
              if (url.pathname === `/v1/databases/${scalarLibrary.skills.database_id}`)
                return api.request(path, body, options).pipe(
                  Effect.map((value) => ({
                    ...property(value),
                    description: [{ plain_text: LIBRARY_MARKER + JSON.stringify(scalarLibrary) }],
                  })),
                )
              if (
                url.pathname !== `/v1/data_sources/${ownershipLibrary.skills.data_source_id}/query`
              )
                return api.request(path, body, options)
              const cursor = property(body).start_cursor
              const offset = cursor === undefined ? 0 : Number(String(cursor).slice(7))
              const end = Math.min(skills.length, offset + 100)
              return Effect.succeed({
                object: "list",
                results: structuredClone(skills.slice(offset, end)),
                has_more: end < skills.length,
                next_cursor: end < skills.length ? `offset-${end}` : null,
              })
            },
          }),
        )
      }),
    )
  const oracle = (snapshot: Snapshot) => {
    const files = snapshot.files.map((file) => {
      const bytes = f.objects.get(`objects/${file.sha256}`)
      if (bytes === undefined || bytes.byteLength !== file.bytes || hash(bytes) !== file.sha256)
        throw new Error("The scalar full-page oracle is incomplete")
      return { path: file.path, bytes }
    })
    return {
      root_id: snapshot.record.id,
      root_ref: snapshot.record.ref,
      members: snapshot.members,
      required: snapshot.required,
      files: snapshot.files,
      contents: Object.fromEntries(
        files.map((file) => [
          file.path,
          new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(file.bytes),
        ]),
      ),
      native_references: snapshot.native_references,
      export_files: portableFiles(
        {
          kind: snapshot.record.kind,
          name: snapshot.record.name,
          description: snapshot.record.description,
          main: snapshot.entrypoint,
          files,
        },
        false,
        true,
      ).map((file) => ({
        path: file.path,
        bytes: file.bytes.byteLength,
        sha256: hash(file.bytes),
      })),
    }
  }
  const cold = oracle(await observeFull())
  const initialSkills = structuredClone(skills)
  property(f.main.properties).title = {
    id: "title",
    type: "title",
    title: [{ plain_text: "Scalar inventory refreshed" }],
  }
  property(f.main.properties).description = rich("description", "Refreshed scalar description")
  f.main.last_edited_time = new Date(
    Date.parse(String(f.main.last_edited_time)) + 1000,
  ).toISOString()
  property(disabled.properties).description = rich("description", "Refreshed disabled metadata")
  const refreshed = oracle(await observeFull())
  const refreshedMain = structuredClone(f.main)
  const refreshedSkills = structuredClone(skills)
  property(property(f.main.properties).members).relation = [{ id: available.id }]
  property(property(f.main.properties).requires).relation = [{ id: skills[2]!.id }]
  f.main.last_edited_time = new Date(
    Date.parse(String(f.main.last_edited_time)) + 1000,
  ).toISOString()
  const relations = oracle(await observeFull())
  const seed = join(root, "scalar-inventory-source")
  await mkdir(seed, { mode: 0o700 })
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* (yield* Store).writeJson("config.json", {
          sources: [
            {
              alias: ownershipLibrary.library_id,
              database_id: ownershipLibrary.skills.database_id,
              title: "Controlled scalar inventory library",
              data_source_ids: [ownershipLibrary.skills.data_source_id],
              role: "content",
              shared_library: scalarLibrary,
            },
          ],
        })
      }),
    ).pipe(
      Effect.provide(nodeRuntime(seed).live),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            ...env,
            NTN_SKILLS_HOME: join(seed, "state"),
            NTN_SKILLS_CONFIG_HOME: join(seed, "config"),
            NTN_SKILLS_CACHE_HOME: join(seed, "cache"),
          }),
        ),
      ),
    ),
  )
  return {
    seed,
    source_cache: "cold-current-without-objects-snapshots-or-catalogs",
    row_count: skills.length,
    root_ref: cold.root_ref,
    resource_path: "references/1.md",
    projection: ["Name", "Description", "Kind", "Skill ID", "Enabled", "Default Context"].map(
      (name) => ownershipLibrary.skills.property_ids[name],
    ),
    external: { available: available.id, disabled: disabled.id },
    // Frozen service observations for the existing installed scalar harness.
    // This records the Tags/filter facts and API membership separately; it does
    // not claim to execute Notion's server-side filter implementation.
    view_dynamics: {
      view: {
        id: fixtureId(2100),
        name: "Controlled Tags View",
        type: "table",
        data_source_id: ownershipLibrary.skills.data_source_id,
        parent: { type: "database_id", database_id: ownershipLibrary.skills.database_id },
        url: `https://notion.so/${ownershipLibrary.skills.database_id}?v=${fixtureId(2100)}`,
      },
      tags_property_id: ownershipLibrary.skills.property_ids.Tags,
      ordinary_record_ids: [
        cold.root_id,
        ...Array.from({ length: 99 }, (_, index) =>
          sharedSkillId(ownershipLibrary.library_id, `inventory-${index + 1}`),
        ),
      ],
      observations: [
        {
          id: "initial",
          query_id: fixtureId(2101),
          tags: [
            [ownershipPage, ["featured"]],
            [available.id, ["secondary"]],
          ],
          filter: {
            property: ownershipLibrary.skills.property_ids.Tags,
            multi_select: { contains: "featured" },
          },
          member_page_ids: [ownershipPage],
          member_record_ids: [cold.root_id],
        },
        {
          id: "tags-changed",
          query_id: fixtureId(2102),
          tags: [
            [ownershipPage, ["secondary"]],
            [available.id, ["featured"]],
          ],
          filter: {
            property: ownershipLibrary.skills.property_ids.Tags,
            multi_select: { contains: "featured" },
          },
          member_page_ids: [available.id],
          member_record_ids: [sharedSkillId(ownershipLibrary.library_id, "inventory-1")],
        },
        {
          id: "filter-changed",
          query_id: fixtureId(2103),
          tags: [
            [ownershipPage, ["secondary"]],
            [available.id, ["featured"]],
          ],
          filter: {
            or: ["featured", "secondary"].map((tag) => ({
              property: ownershipLibrary.skills.property_ids.Tags,
              multi_select: { contains: tag },
            })),
          },
          member_page_ids: [ownershipPage, available.id],
          member_record_ids: [
            cold.root_id,
            sharedSkillId(ownershipLibrary.library_id, "inventory-1"),
          ],
        },
      ],
    },
    oracle: { cold, refreshed, relations },
    notion: {
      library: scalarLibrary,
      database: {
        object: "database",
        id: ownershipLibrary.skills.database_id,
        database_type: null,
        title: [{ plain_text: "Controlled scalar inventory library" }],
        description: [{ plain_text: LIBRARY_MARKER + JSON.stringify(scalarLibrary) }],
        data_sources: [{ id: ownershipLibrary.skills.data_source_id, name: "Skills" }],
      },
      main: initialSkills[0],
      skills: initialSkills,
      refreshed_main: refreshedMain,
      refreshed_skills: refreshedSkills,
      relations_main: structuredClone(f.main),
      relations_skills: structuredClone(skills),
      files: structuredClone(f.files),
      records: structuredClone([...f.records.values()]),
      bodies: Object.fromEntries(f.bodies),
    },
  }
})()
const metadata = {
  version: 1,
  cwd: root,
  scope,
  env: join(root, "env.json"),
  catalog: withCatalog,
  distinct_names: distinctNames,
  ...(ambiguousNames
    ? {
        ambiguous_names: true,
        ambiguity: {
          name: "A",
          alias: "a",
          candidate_ids: [snapshots[0]!.record.id, snapshots[2]!.record.id],
        },
      }
    : {}),
  database: "00000000-0000-4000-8000-000000000010",
  catalog_records: catalogSnapshots.map((snapshot) => snapshot.record.id),
  default_view: withCatalog
    ? {
        ...defaultView,
        selection: "first",
        source_cache: `${defaultViewCache}-metadata-only`,
        records: defaultViewRecords.map(({ id, name, ref }) => ({ id, name, ref })),
        cache_keys: defaultViewCacheKeys,
      }
    : null,
  ownership,
  scalarInventory,
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
  entrypoint: {
    name: entrypointSnapshot.record.name,
    ref: ref(entrypointSnapshot),
    current_ref: entrypointSnapshot.record.ref,
    source_cache: "controlled-complete-before-owned-partial-copy",
    files: entrypointFiles.map((file) => ({
      ref: fileRef(
        entrypointSnapshot.record.id,
        file.path,
        entrypointSnapshot.snapshot_id,
        file.file_id,
      ),
      path: file.path,
      file_id: file.file_id,
      bytes: file.bytes.byteLength,
      sha256: hash(file.bytes),
      role: file.role,
      ...(file.role === "selected"
        ? { content: new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(file.bytes) }
        : {}),
    })),
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
