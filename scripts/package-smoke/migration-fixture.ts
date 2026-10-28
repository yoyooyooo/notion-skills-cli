import { createHash } from "node:crypto"
import { lstat, mkdir, readFile, readlink, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path"
import { createRequire } from "node:module"
import type * as Fflate from "../../packages/core/node_modules/fflate"
import type { SmokeContext } from "./context.ts"
import { CURRENT_MATERIALIZATION_VERSION } from "../../packages/core/src/materialization.ts"

export async function prepareMigrationFixture(context: SmokeContext) {
  const { scratch, runtime, env, migrationExecutable, run, evidence } = context
  const { zipSync } = createRequire(new URL("../../packages/core/package.json", import.meta.url))(
    "fflate",
  ) as typeof Fflate
  // Migration uses fresh roots: the initial consumer checks own a separate empty SQLite scope.
  env.NTN_SKILLS_HOME = join(scratch, "migration-state")
  env.NTN_SKILLS_CONFIG_HOME = join(scratch, "migration-config")
  env.NTN_SKILLS_CACHE_HOME = join(scratch, "migration-cache")

  // These fixtures prove installed offline consumption and retention only; no provider observation is performed.
  const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")
  const token = "offline-consumer-fixture-token"
  const scope = digest(
    JSON.stringify([
      "offline-fixture-user",
      env.NOTION_WORKSPACE_ID,
      env.NOTION_API_BASE_URL,
      digest(token),
    ]),
  )
  const identityKey = digest(
    JSON.stringify([digest(token), env.NOTION_WORKSPACE_ID, env.NOTION_API_BASE_URL]),
  )
  const pageId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  const databaseId = "11111111-1111-4111-8111-111111111111"
  const dataSourceId = "22222222-2222-4222-8222-222222222222"
  const versionId = "offline-consumer-version"
  const snapshotId = `s_${digest(JSON.stringify([scope, pageId, versionId]))}`
  const ref = `skill://${pageId}/SKILL.md?snapshot=${snapshotId}`
  const main =
    '---\n"description": "Verify installed offline consumption"\n"name": "package-smoke"\n---\n\n# Package Smoke\n\nRead supporting files from the same snapshot.\n'
  const sourceMain =
    '---\n"description": "Verify installed offline consumption"\n"name": "Package Smoke"\n---\n\n# Package Smoke\n\nRead supporting files from the same snapshot.\n'
  const supporting = "first\nsecond\nthird\n"
  const contents = [
    { path: "SKILL.md", bytes: Buffer.from(main) },
    { path: "references/guide.md", bytes: Buffer.from(supporting) },
    { path: "references/nested/details.md", bytes: Buffer.from("# Nested details\n") },
    { path: "assets/example.bin", bytes: Buffer.from([0, 255, 1, 128]) },
  ]
  const files = contents.map((file) => ({
    path: file.path,
    bytes: file.bytes.length,
    sha256: digest(file.bytes),
  }))
  const writePrivate = async (path: string, value: string | Uint8Array) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, value, { mode: 0o600 })
  }
  const skill = {
    id: pageId,
    name: "Package Smoke",
    alias: "package-smoke",
    description: "Verify installed offline consumption",
    database_id: databaseId,
    data_source_id: dataSourceId,
    ref: `skill://${pageId}/SKILL.md`,
  }
  const snapshotValue = {
    snapshot_id: snapshotId,
    scope,
    skill,
    skill_name: "package-smoke",
    version_id: versionId,
    created_at: 0,
    files,
  }
  for (const file of contents)
    await writePrivate(join(env.NTN_SKILLS_HOME, "objects", digest(file.bytes)), file.bytes)
  const snapshotPath = join(env.NTN_SKILLS_HOME, "snapshots", `${snapshotId}.json`)
  await writePrivate(snapshotPath, JSON.stringify(snapshotValue))
  const sources = [
    { alias: "smoke", database_id: databaseId, title: "Smoke", data_source_ids: [dataSourceId] },
  ]
  const localPath = join(scratch, "local-skill")
  for (const file of contents) await writePrivate(join(localPath, file.path), file.bytes)
  const binding = {
    id: "b_offline-consumer",
    label: "consumer-local",
    page_id: pageId,
    database_id: databaseId,
    data_source_id: dataSourceId,
    scope,
    logical_path: localPath,
    active: true,
    revision: 1,
  }
  const originalConfig = { token, sources, default_database: databaseId, sync_bindings: [binding] }
  const configPath = join(env.NTN_SKILLS_CONFIG_HOME, "config.json")
  await writePrivate(configPath, JSON.stringify(originalConfig))
  const base = {
    format: "ntn-skills-sync-base",
    version: 1,
    binding_id: binding.id,
    generation: 0,
    initialized: false,
  }
  const contentFiles = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const content = {
    name: skill.name,
    description: skill.description,
    main: "SKILL.md",
    files: contentFiles,
    content_id: digest(
      JSON.stringify([
        skill.name,
        skill.description,
        "SKILL.md",
        contentFiles.map((file) => [file.path, file.sha256]),
      ]),
    ),
  }
  // Record real inode/link evidence for seeded state; this plan is never applied or presented as provider proof.
  async function fixturePathProof(location: string) {
    let current = parse(resolve(location)).root
    let pending = resolve(location).slice(current.length).split(sep).filter(Boolean)
    const root = await lstat(current, { bigint: true })
    const nodes: Array<{
      path: string
      kind: "directory" | "file" | "link"
      dev: string
      ino: string
      link?: string
    }> = [{ path: current, kind: "directory", dev: String(root.dev), ino: String(root.ino) }]
    let links = 0
    while (pending.length) {
      const component = pending.shift()!
      if (component === ".") continue
      if (component === "..") {
        current = dirname(current)
        continue
      }
      const next = join(current, component)
      const info = await lstat(next, { bigint: true })
      const kind: "link" | "directory" | "file" = info.isSymbolicLink()
        ? "link"
        : info.isDirectory()
          ? "directory"
          : "file"
      const node = { path: next, kind, dev: String(info.dev), ino: String(info.ino) }
      if (kind === "link") {
        if (++links > 40)
          throw new Error("Consumer scratch contains an unresolved symbolic-link cycle.")
        const link = await readlink(next)
        nodes.push({ ...node, link })
        pending = [...link.split(sep).filter(Boolean), ...pending]
        if (isAbsolute(link)) current = parse(link).root
      } else {
        nodes.push(node)
        current = next
      }
    }
    return { nodes, resolved_path: current, exists: true }
  }
  const rootProof = await fixturePathProof(localPath)
  const fileProofs = await Promise.all(
    contentFiles.map(async (file) => ({
      path: file.path,
      proof: await fixturePathProof(join(localPath, file.path)),
    })),
  )
  function canonicalFixtureJson(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined"
    if (Array.isArray(value)) return `[${value.map(canonicalFixtureJson).join(",")}]`
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalFixtureJson(entry)}`)
      .join(",")}}`
  }
  const planBody = {
    format: "ntn-skills-sync-plan",
    version: 1,
    applicable: true,
    conflicts: [],
    bindings: [
      {
        binding,
        base,
        local: {
          logical_path: localPath,
          resolved_path: rootProof.resolved_path,
          exists: true,
          proof: { root: rootProof, files: fileProofs },
          file_hashes: contentFiles,
          content,
        },
        remote: snapshotValue,
        remote_content: content,
        mode: "exact",
        direction: "advance_baseline",
        source: "notion",
        intended: content,
        actions: contentFiles
          .map((file) => file.path)
          .sort()
          .map((path) => ({ path, action: "retain" })),
      },
    ],
  }
  const planId = `p_${digest(canonicalFixtureJson(planBody))}`
  const retainedPlan = { ...planBody, plan_id: planId }
  const retainedState = [
    { path: join(env.NTN_SKILLS_HOME, "sync", "bases", `${binding.id}.json`), value: base },
    { path: join(env.NTN_SKILLS_HOME, "sync", "plans", `${planId}.json`), value: retainedPlan },
    {
      path: join(
        env.NTN_SKILLS_HOME,
        "sync",
        "receipts",
        "o_33333333-3333-4333-8333-333333333333.json",
      ),
      value: {
        format: "ntn-skills-sync-receipt",
        version: 1,
        operation_id: "o_33333333-3333-4333-8333-333333333333",
        plan_id: planId,
        created_at: 0,
        status: "pending",
        groups: [{ page_id: pageId, stage: "prepared" }],
        bindings: [
          {
            binding_id: binding.id,
            page_id: pageId,
            resolved_path: rootProof.resolved_path,
            stage: "prepared",
            generation_before: 0,
            retained: [],
          },
        ],
      },
    },
  ]
  for (const state of retainedState) await writePrivate(state.path, JSON.stringify(state.value))
  const observationTime = Date.now() - 3600000
  const latestKey = `latest/${scope}/${pageId}/44444444-4444-4444-8444-444444444444.json`
  const catalogKey = `catalogs/${scope}/${digest(JSON.stringify(["database-selection-v2", "smoke", sources]))}.json`
  const cacheFixtures = [
    { key: `identities/${identityKey}.json`, value: { scope } },
    {
      key: latestKey,
      value: {
        page_id: pageId,
        scope,
        started_at: observationTime,
        validated_at: observationTime,
        generation: 1,
        materialization_version: CURRENT_MATERIALIZATION_VERSION,
        snapshot_id: snapshotId,
        invalidated: false,
      },
    },
    {
      key: catalogKey,
      value: {
        scope,
        generation: 1,
        fetched_at: observationTime,
        databases: sources,
        skills: [skill],
        coverage: {
          method: "explicit_database",
          exhaustive: true,
          queried_data_sources: [dataSourceId],
          failed_sources: [],
          search_index_limited: false,
        },
      },
    },
  ]
  for (const fixture of cacheFixtures)
    await writePrivate(join(env.NTN_SKILLS_CACHE_HOME, fixture.key), JSON.stringify(fixture.value))
  // Encode historical v1 independently; normal consumption must refuse it after migration.
  const historicalWorkflowVersion = "offline-consumer-workflow-version"
  const historicalWorkflowSnapshot = `s_${digest(JSON.stringify([scope, pageId, historicalWorkflowVersion]))}`
  const workflowVersion = "offline-consumer-workflow-v2-version"
  const workflowSnapshot = `s_${digest(JSON.stringify([scope, pageId, workflowVersion]))}`
  const workflowEvidencePaths: string[] = []
  for (const fixture of [
    { version: 1, versionId: historicalWorkflowVersion, snapshotId: historicalWorkflowSnapshot },
    { version: 2, versionId: workflowVersion, snapshotId: workflowSnapshot },
  ]) {
    const workflowMetadata = {
      format: "ntn-skills",
      version: fixture.version,
      ...(fixture.version === 2 ? { kind: "skill" } : {}),
      name: skill.name,
      description: skill.description,
      main: "workflow.md",
      projection: {
        name: skill.name,
        description: skill.description,
        body: "# Package Smoke\nRead supporting files from the same snapshot.",
      },
    }
    const workflowEntries: Fflate.Zippable = Object.create(null)
    for (const file of [
      { path: ".ntn-skills.json", bytes: Buffer.from(JSON.stringify(workflowMetadata) + "\n") },
      { path: "workflow.md", bytes: Buffer.from(main) },
      ...contents.slice(1),
    ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)))
      workflowEntries[file.path] = [file.bytes, { mtime: new Date(1980, 0, 1), level: 6 }]
    const workflowBundle = Buffer.from(zipSync(workflowEntries))
    const workflowContents = [...contents, { path: "ntn-skills-source.zip", bytes: workflowBundle }]
    const workflowFiles = workflowContents.map((file) => ({
      path: file.path,
      bytes: file.bytes.length,
      sha256: digest(file.bytes),
    }))
    for (const file of workflowContents)
      await writePrivate(join(env.NTN_SKILLS_HOME, "objects", digest(file.bytes)), file.bytes)
    const workflowPath = join(env.NTN_SKILLS_HOME, "snapshots", `${fixture.snapshotId}.json`)
    await writePrivate(
      workflowPath,
      JSON.stringify({
        ...snapshotValue,
        snapshot_id: fixture.snapshotId,
        version_id: fixture.versionId,
        files: workflowFiles,
      }),
    )
    workflowEvidencePaths.push(
      workflowPath,
      join(env.NTN_SKILLS_HOME, "objects", digest(workflowBundle)),
    )
  }
  const alternateToken = "offline-consumer-same-user-absent-scope-token"
  const alternateScope = digest(
    JSON.stringify([
      "offline-fixture-user",
      env.NOTION_WORKSPACE_ID,
      env.NOTION_API_BASE_URL,
      digest(alternateToken),
    ]),
  )
  const alternateIdentity = digest(
    JSON.stringify([digest(alternateToken), env.NOTION_WORKSPACE_ID, env.NOTION_API_BASE_URL]),
  )
  await writePrivate(
    join(env.NTN_SKILLS_CACHE_HOME, "identities", `${alternateIdentity}.json`),
    JSON.stringify({ scope: alternateScope }),
  )
  // All JSON above is old-format importer input. No fixture writes enter the live store.
  const migrationBackup = join(scratch, "migration-backup")
  const migration = await run([
    runtime,
    migrationExecutable,
    env.NTN_SKILLS_HOME,
    "--config-directory",
    env.NTN_SKILLS_CONFIG_HOME,
    "--cache-directory",
    env.NTN_SKILLS_CACHE_HOME,
    "--backup-directory",
    migrationBackup,
    "--old-writers-stopped",
  ])
  evidence.migration = JSON.parse(migration)
  const migrationInputs = [
    ...retainedState.map((state) => state.path),
    snapshotPath,
    ...workflowEvidencePaths,
    ...cacheFixtures.map((fixture) => join(env.NTN_SKILLS_CACHE_HOME, fixture.key)),
  ]
  const migrationInputBytes = await Promise.all(migrationInputs.map((path) => readFile(path)))
  return {
    digest,
    token,
    scope,
    pageId,
    databaseId,
    versionId,
    snapshotId,
    ref,
    main,
    sourceMain,
    contents,
    files,
    writePrivate,
    skill,
    snapshotPath,
    localPath,
    binding,
    retainedState,
    observationTime,
    latestKey,
    catalogKey,
    cacheFixtures,
    historicalWorkflowSnapshot,
    workflowSnapshot,
    workflowVersion,
    alternateToken,
    alternateScope,
    migrationInputs,
    migrationInputBytes,
  }
}
export type MigrationFixture = Awaited<ReturnType<typeof prepareMigrationFixture>>
