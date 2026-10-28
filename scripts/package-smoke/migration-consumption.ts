import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { Schema } from "effect"
import { CatalogSchema, ContentRecordSchema } from "../../packages/core/src/model.ts"
import type { SmokeContext } from "./context.ts"

import type { MigrationFixture } from "./migration-fixture.ts"

export async function checkMigrationConsumption(context: SmokeContext, fixture: MigrationFixture) {
  const {
    scratch,
    runtime,
    env,
    manifest,
    executable,
    run,
    check,
    cli,
    rejected,
    rejectedCommands,
    evidence,
  } = context
  const {
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
  } = fixture
  const resolved = await cli([
    "resolve",
    "../assets/template.md",
    "--from",
    `skill://${pageId}/references/guide.md?snapshot=${snapshotId}`,
  ])
  check(
    resolved.ref === `skill://${pageId}/assets/template.md?snapshot=${snapshotId}`,
    "Relative refs lost path or version.",
  )

  const preservedConfig = async () => {
    const config = (await cli(["ctl", "config", "show"])).config
    check(
      config.token_configured && !config.token && config.default_database === databaseId,
      "Cache policy changed unrelated configuration.",
    )
  }
  await cli(["ctl", "config", "set", "cache_policy.read_max_age_ms", "7200000"])
  await cli(["ctl", "config", "set", "cache_policy.catalog_max_age_ms", "180000"])
  await preservedConfig()
  const persisted = await cli(["ctl", "config", "show"])
  check(
    persisted.config.effective_cache_policy.read_max_age_ms === 7200000 &&
      persisted.config.effective_cache_policy.catalog_max_age_ms === 180000 &&
      persisted.config.token_configured &&
      !persisted.config.token,
    "Policy failed to persist safely into a new process.",
  )
  await cli(["ctl", "config", "set", "cache_policy.read_max_age_ms", "0"])
  check(
    (await cli(["ctl", "config", "show"])).config.effective_cache_policy.catalog_max_age_ms ===
      180000,
    "Partial policy update lost the catalog default.",
  )
  await cli(["ctl", "config", "unset", "cache_policy.read_max_age_ms"])
  await cli(["ctl", "config", "unset", "cache_policy.catalog_max_age_ms"])
  await preservedConfig()
  evidence.policy_after_clear = (await cli(["ctl", "config", "show"])).config.effective_cache_policy
  check(
    JSON.stringify(evidence.policy_after_clear) ===
      JSON.stringify({ read_max_age_ms: 300000, catalog_max_age_ms: 60000 }),
    "Clearing policy did not restore effective defaults.",
  )
  check(!JSON.stringify(persisted).includes(token), "Policy output exposed a credential.")
  const beforeSnapshot = await readFile(snapshotPath)
  const beforeObjects = await Promise.all(
    files.map((file) => readFile(join(env.NTN_SKILLS_HOME, "objects", file.sha256))),
  )
  const pinnedRead = await cli(["read", ref, "--offline"])
  check(
    pinnedRead.content === main && pinnedRead.source === "local_snapshot",
    "Installed snapshot read differs.",
  )
  const raw = await run([runtime, executable, "read", ref, "--raw", "--offline"])
  check(raw === main, "Pinned raw read did not preserve exact text.")
  const listed = await cli(["files", snapshotId, "--offline"])
  check(
    listed.files.length === files.length &&
      listed.files.every((file: { path: string }) =>
        files.some((expected) => expected.path === file.path),
      ),
    "Installed snapshot file listing omitted supporting files.",
  )
  const range = await cli([
    "read",
    "references/guide.md",
    "--from",
    ref,
    "--lines",
    "2-2",
    "--offline",
  ])
  check(
    range.content === "second" && range.range.start === 2 && range.has_more,
    "Installed ranged relative read differs.",
  )
  const output = join(scratch, "portable.zip")
  const exported = await cli(["export", ref, "--output", output, "--offline"])
  const reused = await cli(["export", ref, "--output", output, "--offline"])
  check(
    !exported.reused && reused.reused && exported.content_id === reused.content_id,
    "Portable export reuse differs.",
  )
  const snapshotOutput = join(scratch, "snapshot-projection")
  const snapshotExport = await cli([
    "export",
    snapshotId,
    "--projection",
    "snapshot",
    "--format",
    "directory",
    "--output",
    snapshotOutput,
    "--offline",
  ])
  check(snapshotExport.projection === "snapshot", "Installed export lost snapshot projection.")
  check(
    (await readFile(join(snapshotOutput, snapshotExport.entrypoint), "utf8")) === main,
    "Snapshot export entry differs from the pinned read bytes.",
  )
  for (const file of snapshotExport.files) {
    const bytes = await readFile(join(snapshotOutput, file.path))
    check(
      bytes.length === file.bytes &&
        createHash("sha256").update(bytes).digest("hex") === file.hash &&
        ["entrypoint", "resource", "source_bundle", "manifest"].includes(file.role),
      `Installed snapshot inventory differs: ${file.path}`,
    )
  }
  const snapshotManifest = JSON.parse(
    await readFile(join(snapshotOutput, ".ntn-skills.json"), "utf8"),
  )
  check(
    snapshotManifest.format === "ntn-skills" &&
      snapshotManifest.version === 2 &&
      snapshotManifest.main === snapshotExport.entrypoint,
    "Installed snapshot portable manifest differs.",
  )
  evidence.snapshot_projection_export = snapshotExport
  check(
    (await cli(["read", ref, "--database", "smoke", "--offline"])).content === main,
    "Offline registered alias constraint failed.",
  )
  for (const command of [
    ["read", ref],
    ["read", "references/guide.md", "--from", ref],
    ["files", snapshotId],
    ["files", ref],
    ["export", ref, "--output", join(scratch, "rejected.zip")],
  ])
    for (const policy of [["--refresh"], ["--max-age", "0"]])
      await rejected([...command, ...policy])
  await rejected([
    "replace",
    localPath,
    "--target",
    `skill://${pageId}/references/guide.md?snapshot=${snapshotId}`,
  ])
  await rejected(
    ["replace", localPath, "--target", pageId, "--name", "Renamed Consumer", "--dry-run"],
    "NTN_UNAVAILABLE",
    1,
  )
  await rejected(
    ["sync", "local", "bind", pageId, "--path", localPath, "--as", "candidate", "--dry-run"],
    "NTN_UNAVAILABLE",
    1,
  )
  await rejected(
    ["sync", "local", "apply", "--plan", `p_${"c".repeat(64)}`],
    "SYNC_PLAN_MISSING",
    1,
  )
  await rejected(
    ["sync", "local", "apply", "--plan", join(scratch, "missing-plan.json")],
    "SYNC_PLAN_MISSING",
    1,
  )
  for (const selector of [pageId, "package-smoke"])
    await rejected(
      ["read", selector, "--database", "smoke", "--offline"],
      "CACHE_SCOPE_UNAVAILABLE",
      1,
    )
  await rejected(["files", pageId, "--offline"], "CACHE_SCOPE_UNAVAILABLE", 1)
  await rejected(
    ["export", pageId, "--output", join(scratch, "current-export"), "--offline"],
    "CACHE_SCOPE_UNAVAILABLE",
    1,
  )
  await rejected(
    ["list", "--database", "smoke", "--query", "package", "--offline"],
    "CACHE_SCOPE_UNAVAILABLE",
    1,
  )
  const opened = await cli(["files", snapshotId, "--offline"])
  check(
    opened.snapshot_id === snapshotId &&
      opened.files.length === files.length &&
      files.every((expected) =>
        opened.files.some(
          (actual: { path: string; bytes: number }) =>
            actual.path === expected.path && actual.bytes === expected.bytes,
        ),
      ),
    "Migrated pinned snapshot lost complete content.",
  )
  const catalog = {
    scope: opened.scope,
    fetched_at: observationTime,
    databases: [],
    records: [{ ...opened.record, ref: opened.ref }],
    coverage: {
      method: "pinned_snapshot_fixture",
      exhaustive: false,
      queried_data_sources: [],
      failed_sources: [],
      search_index_limited: true,
    },
  }
  evidence.migrated_pinned_snapshot = {
    snapshot_id: opened.snapshot_id,
    file_count: opened.files.length,
    disposable_current_cache: "dropped",
  }
  // Synthetic offline broker proof: discovery is metadata; activation selects a pinned snapshot.
  const ActivationSchema = Schema.Struct({
    content: Schema.String,
    snapshot_id: Schema.String,
    version_id: Schema.String,
    scope: Schema.String,
    ref: Schema.String,
  })
  const DirectoryExportSchema = Schema.Struct({
    snapshot_id: Schema.String,
    version_id: Schema.String,
    scope: Schema.String,
    record: ContentRecordSchema,
    entrypoint: Schema.String,
    output: Schema.String,
    main_path: Schema.String,
    reused: Schema.Boolean,
    files: Schema.Array(Schema.Struct({ path: Schema.String, bytes: Schema.Number })),
  })
  const PortableManifestSchema = Schema.Struct({
    format: Schema.Literal("ntn-skills"),
    version: Schema.Literal(2),
    kind: Schema.Literals(["skill", "router", "prompt"]),
    name: Schema.String,
    description: Schema.String,
    main: Schema.String,
  })
  const brokerCatalog = Schema.decodeUnknownSync(
    Schema.Struct({
      ...CatalogSchema.fields,
      records: Schema.Array(
        Schema.Struct({
          ...ContentRecordSchema.fields,
          content: Schema.optional(Schema.Unknown),
          body: Schema.optional(Schema.Unknown),
          files: Schema.optional(Schema.Unknown),
          manifest: Schema.optional(Schema.Unknown),
          main_path: Schema.optional(Schema.Unknown),
        }),
      ),
    }),
  )(catalog)
  check(brokerCatalog.scope === scope, "List omitted credential scope.")
  for (const metadata of brokerCatalog.records)
    check(
      !["content", "body", "files", "manifest", "main_path"].some((key) => key in metadata),
      "Metadata discovery exposed content or a manifest.",
    )
  const activation = Schema.decodeUnknownSync(ActivationSchema)(
    await cli(["read", brokerCatalog.records[0]!.ref, "--offline"]),
  )
  check(
    activation.content === main &&
      activation.snapshot_id === snapshotId &&
      activation.version_id === versionId &&
      activation.scope === brokerCatalog.scope,
    "List-selected activation lost pinned content or identity.",
  )
  const brokerOutput = join(scratch, "broker-pinned")
  const brokerArgs = [
    "export",
    activation.ref,
    "--output",
    brokerOutput,
    "--format",
    "directory",
    "--projection",
    "snapshot",
    "--offline",
  ]
  const brokerExport = Schema.decodeUnknownSync(DirectoryExportSchema)(await cli(brokerArgs))
  check(
    brokerExport.snapshot_id === snapshotId &&
      brokerExport.version_id === versionId &&
      brokerExport.record.id === `notion_page:${pageId}` &&
      brokerExport.scope === scope &&
      brokerExport.output === brokerOutput &&
      !brokerExport.reused,
    "Pinned export lost identity or output entry.",
  )
  const manifestBytes = await readFile(join(brokerExport.output, ".ntn-skills.json"))
  const portableManifestJson: unknown = JSON.parse(manifestBytes.toString("utf8"))
  const portableManifest = Schema.decodeUnknownSync(PortableManifestSchema)(portableManifestJson)
  check(
    portableManifest.main === brokerExport.main_path &&
      (await readFile(join(brokerExport.output, brokerExport.main_path))).equals(Buffer.from(main)),
    "Actual manifest entry differs from pinned activation.",
  )
  const emittedFiles = brokerExport.files
  check(
    portableManifest.format === "ntn-skills" &&
      portableManifest.version === 2 &&
      portableManifest.kind === "skill" &&
      portableManifest.name === skill.name &&
      portableManifest.description === skill.description &&
      emittedFiles.length === contents.length + 1,
    "Portable manifest or file inventory lost its documented contract.",
  )
  for (const file of emittedFiles) {
    const bytes = await readFile(join(brokerExport.output, file.path))
    const expected =
      file.path === ".ntn-skills.json"
        ? manifestBytes
        : contents.find((entry) => entry.path === file.path)?.bytes
    check(
      expected && bytes.equals(expected) && bytes.length === file.bytes,
      "Export inventory differs from actual full bytes.",
    )
  }
  check(
    Schema.decodeUnknownSync(DirectoryExportSchema)(await cli(brokerArgs)).reused === true,
    "Identical directory was not reused.",
  )
  // Source projection regenerates missing source metadata using the current exact display name.
  // Snapshot projection above retains the historical activation bytes without rewriting them.
  const sourceExport = Schema.decodeUnknownSync(DirectoryExportSchema)(
    await cli([
      "export",
      activation.ref,
      "--output",
      join(scratch, "broker-source"),
      "--format",
      "directory",
      "--projection",
      "source",
      "--offline",
    ]),
  )
  const sourceManifest = Schema.decodeUnknownSync(PortableManifestSchema)(
    JSON.parse(await readFile(join(sourceExport.output, ".ntn-skills.json"), "utf8")),
  )
  check(
    sourceExport.snapshot_id === snapshotId &&
      sourceExport.version_id === versionId &&
      sourceExport.scope === scope &&
      sourceExport.record.id === `notion_page:${pageId}` &&
      sourceManifest.name === skill.name &&
      sourceManifest.description === skill.description &&
      sourceManifest.main === sourceExport.main_path &&
      sourceExport.files.length === contents.length + 1,
    "Current source projection lost its original record identity, metadata or inventory.",
  )
  for (const file of sourceExport.files) {
    const bytes = await readFile(join(sourceExport.output, file.path))
    const expected =
      file.path === sourceExport.main_path
        ? Buffer.from(sourceMain)
        : contents.find((entry) => entry.path === file.path)?.bytes
    check(
      bytes.length === file.bytes &&
        (file.path === ".ntn-skills.json" || (expected && bytes.equals(expected))),
      "Current source export differs from exact display-name metadata or supporting bytes.",
    )
  }
  const occupied = join(scratch, "broker-occupied")
  for (const file of emittedFiles)
    await writePrivate(join(occupied, file.path), await readFile(join(brokerOutput, file.path)))
  await writePrivate(join(occupied, brokerExport.main_path), Buffer.from([0, 255, 17, 128, 10]))
  const occupiedBefore = await Promise.all(
    emittedFiles.map((file) => readFile(join(occupied, file.path))),
  )
  await rejected(
    [
      "export",
      activation.ref,
      "--output",
      occupied,
      "--format",
      "directory",
      "--projection",
      "snapshot",
      "--offline",
    ],
    "OUTPUT_CONFLICT",
    1,
  )
  for (const [index, file] of emittedFiles.entries())
    check(
      (await readFile(join(occupied, file.path))).equals(occupiedBefore[index]!),
      "Rejected export changed occupied bytes.",
    )
  await rejected(
    [
      "export",
      `skill://${pageId}/SKILL.md?snapshot=${historicalWorkflowSnapshot}`,
      "--output",
      join(scratch, "broker-historical-workflow"),
      "--format",
      "directory",
      "--offline",
    ],
    "PORTABLE_UPGRADE_REQUIRED",
    1,
  )
  const workflowExport = Schema.decodeUnknownSync(DirectoryExportSchema)(
    await cli([
      "export",
      `skill://${pageId}/SKILL.md?snapshot=${workflowSnapshot}`,
      "--output",
      join(scratch, "broker-workflow"),
      "--format",
      "directory",
      "--offline",
    ]),
  )
  const workflowManifestJson: unknown = JSON.parse(
    await readFile(join(workflowExport.output, ".ntn-skills.json"), "utf8"),
  )
  const workflowManifest = Schema.decodeUnknownSync(PortableManifestSchema)(workflowManifestJson)
  check(
    workflowExport.main_path === "workflow.md" &&
      workflowManifest.main === workflowExport.main_path &&
      workflowExport.snapshot_id === workflowSnapshot &&
      workflowExport.version_id === workflowVersion &&
      workflowExport.record.id === `notion_page:${pageId}` &&
      workflowExport.scope === scope &&
      (await readFile(join(workflowExport.output, workflowExport.main_path))).equals(
        Buffer.from(main),
      ),
    "Portable source entry filename or bytes were lost.",
  )
  for (const file of workflowExport.files) {
    const bytes = await readFile(join(workflowExport.output, file.path))
    const expected =
      file.path === workflowExport.main_path
        ? Buffer.from(main)
        : contents.find((entry) => entry.path === file.path)?.bytes
    check(
      bytes.length === file.bytes &&
        (file.path === ".ntn-skills.json" || (expected && bytes.equals(expected))),
      "Workflow portable files differ from source bytes.",
    )
  }
  evidence.broker_consumption = {
    catalog,
    activation,
    exported: brokerExport,
    source: sourceExport,
    workflow: workflowExport,
  }
  const setTokenResult = await cli(
    ["ctl", "config", "set-token", "--stdin"],
    0,
    {},
    `${alternateToken}\n`,
  )
  check(
    !JSON.stringify(setTokenResult).includes(alternateToken),
    "Token setter exposed stdin credential.",
  )
  await rejected(["list", "--database", "smoke", "--offline"], "CACHE_SCOPE_UNAVAILABLE", 1)
  await rejected(["read", pageId, "--offline"], "CACHE_SCOPE_UNAVAILABLE", 1)
  check(
    Schema.decodeUnknownSync(ActivationSchema)(await cli(["read", ref, "--offline"])).content ===
      main,
    "Credential change prevented pinned snapshot consumption.",
  )
  await cli(["ctl", "config", "set-token", "--stdin"], 0, {}, `${token}\n`)
  const savedWins = Schema.decodeUnknownSync(ActivationSchema)(
    await cli(["read", ref, "--offline"], 0, { NOTION_API_TOKEN: alternateToken }),
  )
  check(
    savedWins.scope === scope && savedWins.content === main,
    "Environment token overrode saved config.",
  )
  await cli(["ctl", "config", "clear-token"])
  await rejected(["list", "--database", "smoke", "--offline"], "CACHE_SCOPE_UNAVAILABLE", 1, {
    NOTION_API_TOKEN: alternateToken,
  })
  await rejected(["read", pageId, "--offline"], "CACHE_SCOPE_UNAVAILABLE", 1, {
    NOTION_API_TOKEN: alternateToken,
  })
  await cli(["ctl", "config", "set-token", "--stdin"], 0, {}, `${token}\n`)
  await preservedConfig()
  evidence.synthetic_scope_isolation = {
    proof: "same seeded user; distinct token; absent observations",
    original_scope: scope,
    absent_scope: alternateScope,
    saved_config_scope: savedWins.scope,
  }
  for (const command of [
    ["read", pageId],
    ["files", pageId],
    ["export", pageId, "--output", join(scratch, "warm.zip")],
    ["list", "--database", "smoke"],
  ])
    await rejected([...command, "--max-age", "2h"], "NTN_UNAVAILABLE", 1)
  evidence.migrated_cache_policy = {
    max_age_ms: 7200000,
    observations: "dropped; online validation required",
  }
  await rejected(["read", pageId, "--refresh"], "NTN_UNAVAILABLE", 1)
  await rejected(["files", pageId, "--max-age", "0"], "NTN_UNAVAILABLE", 1)
  await rejected(["read", pageId, "--offline"], "CACHE_SCOPE_UNAVAILABLE", 1)
  const status = await cli(["sync", "local", "status", binding.label])
  const edge = status.bindings[0]
  check(
    status.bindings.length === 1 &&
      edge.binding.page_id === pageId &&
      edge.baseline_initialized === false &&
      edge.baseline_generation === 0 &&
      edge.status === "needs_initialization" &&
      edge.provisional &&
      !edge.authoritative &&
      edge.remote_snapshot_id === null &&
      edge.remote_validated_at === null &&
      edge.pending_receipts.length === 0,
    "Offline sync status reused discarded observations or executable historical receipts.",
  )
  evidence.seeded_offline_sync_status = status
  const migrationReview = JSON.parse(
    await readFile(join(env.NTN_SKILLS_HOME, "migration-review.json"), "utf8"),
  )
  check(
    migrationReview.executable === false &&
      migrationReview.plans.every((plan: { approval: string }) => plan.approval === "required"),
    "Historical plans lost explicit reapproval boundary.",
  )
  evidence.historical_review = migrationReview
  await rejected(["sync", "local", "status", binding.label, "--refresh"], "NTN_UNAVAILABLE", 1)
  const dryUnbind = await cli(["sync", "local", "unbind", binding.label, "--dry-run"])
  check(dryUnbind.dry_run && !dryUnbind.deactivated, "Dry-run unbind reported a deactivation.")
  await preservedConfig()
  // Migration deliberately dropped identities above. Seed only this synthetic credential
  // identity through the current Store before testing scoped cache retirement.
  const identityKey = createHash("sha256")
    .update(
      JSON.stringify([
        createHash("sha256").update(token).digest("hex"),
        env.NOTION_WORKSPACE_ID,
        env.NOTION_API_BASE_URL,
      ]),
    )
    .digest("hex")
  const fixtureRequire = createRequire(new URL("../../packages/core/package.json", import.meta.url))
  await run([
    runtime,
    "--input-type=module",
    "-e",
    `import {Effect} from ${JSON.stringify(fixtureRequire.resolve("effect"))};import * as NodeServices from ${JSON.stringify(fixtureRequire.resolve("@effect/platform-node/NodeServices"))};import {Store,StoreLive} from ${JSON.stringify(new URL("../../packages/core/src/store.ts", import.meta.url).href)};await Effect.runPromise(Effect.scoped(Effect.gen(function*(){yield* (yield* Store).writeJson(${JSON.stringify(`cache/identities/${identityKey}.json`)},${JSON.stringify({ scope })})})).pipe(Effect.provide(StoreLive),Effect.provide(NodeServices.layer)));`,
  ])
  evidence.retention_scope_setup = {
    proof: "synthetic current Store identity only; no provider observation",
    scope,
  }
  const stateBeforeClear = await Promise.all(retainedState.map((state) => readFile(state.path)))
  const cacheBeforeClear = await Promise.all(
    cacheFixtures.map((fixture) => readFile(join(env.NTN_SKILLS_CACHE_HOME, fixture.key))),
  )
  const preview = await cli(["ctl", "cache", "clear", pageId, "--database", "smoke", "--dry-run"])
  check(
    preview.dry_run && preview.retired.length === 0 && preview.entries.length === 0,
    "Migration unexpectedly retained disposable latest/catalog observations.",
  )
  for (let index = 0; index < cacheFixtures.length; index++)
    check(
      (await readFile(join(env.NTN_SKILLS_CACHE_HOME, cacheFixtures[index]!.key))).equals(
        cacheBeforeClear[index]!,
      ),
      "Dry-run cache clear changed cache bytes.",
    )
  evidence.cache_clear_dry_run = preview
  const cleared = await cli(["ctl", "cache", "clear", "--all"])
  check(!cleared.dry_run, "Cache clear did not execute logical retirement.")
  const cacheAfterClear = await cli(["ctl", "cache", "status"])
  check(
    cacheAfterClear.observations.length === 0 && cacheAfterClear.catalogs.length === 0,
    "Retired SQL observations survived into a new process.",
  )
  for (const [index, path] of migrationInputs.entries())
    check(
      (await readFile(path)).equals(migrationInputBytes[index]!),
      "Clear changed retained migration evidence.",
    )
  const afterClearStatus = await cli(["sync", "local", "status", binding.label])
  check(
    afterClearStatus.bindings[0].remote_freshness === "unknown" &&
      afterClearStatus.bindings[0].baseline_generation === 0 &&
      afterClearStatus.bindings[0].pending_receipts.length === 0,
    "Cache retirement changed the uninitialized baseline or exposed historical receipts as executable work.",
  )
  await rejected(["read", pageId, "--offline"], "CACHE_SCOPE_UNAVAILABLE", 1)
  evidence.cache_after_clear = cacheAfterClear
  evidence.cache_clear = cleared
  const trashCheck = "sqlite_logical_retirement_migration_evidence_preserved"
  for (let index = 0; index < retainedState.length; index++)
    check(
      (await readFile(retainedState[index]!.path)).equals(stateBeforeClear[index]!),
      "Cache clear changed baseline/plan/receipt bytes.",
    )
  await preservedConfig()
  check(
    (await cli(["read", ref, "--offline"])).content === main,
    "Cache clear lost pinned content.",
  )
  check(
    (await readFile(snapshotPath)).equals(beforeSnapshot),
    "Offline reads/cache clear changed the immutable snapshot.",
  )
  for (let index = 0; index < files.length; index++)
    check(
      (await readFile(join(env.NTN_SKILLS_HOME, "objects", files[index]!.sha256))).equals(
        beforeObjects[index]!,
      ),
      "Offline reads/cache clear changed immutable objects.",
    )
  const unbound = await cli(["sync", "local", "unbind", binding.label])
  check(
    unbound.deactivated && !unbound.binding.active && unbound.binding.revision === 2,
    "Unbind did not persist deactivation/revision.",
  )
  check(
    (await cli(["sync", "local", "status"])).bindings.length === 0,
    "New process still lists a deactivated binding.",
  )
  await preservedConfig()
  for (let index = 0; index < retainedState.length; index++)
    check(
      (await readFile(retainedState[index]!.path)).equals(stateBeforeClear[index]!),
      "Unbind changed baseline/plan/receipt bytes.",
    )
  for (const file of contents)
    check(
      (await readFile(join(localPath, file.path))).equals(file.bytes),
      "Unbind changed local content.",
    )
  evidence.rejected_commands = rejectedCommands
  check(
    !JSON.stringify(evidence).includes(token) && !JSON.stringify(evidence).includes(alternateToken),
    "Consumer evidence exposed a configured credential.",
  )
  await writePrivate(
    join(scratch, "offline-command-evidence.json"),
    JSON.stringify(
      {
        proof: "seeded offline installed-consumer behavior; no live Notion proof",
        trash_check: trashCheck,
        outputs: evidence,
      },
      null,
      2,
    ),
  )
  return { trashCheck }
}
