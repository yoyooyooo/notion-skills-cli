import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    sdk: { type: "string" },
    cli: { type: "string" },
    label: { type: "string" },
    phase: { type: "string" },
  },
})
assert.ok(values.root && values.sdk && values.cli && values.label)
assert.match(values.label, /^[a-z0-9][a-z0-9-]*$/u)
assert.ok(["capacity", "profile", "audit"].includes(values.phase))
const root = resolve(values.root),
  sdkPath = resolve(values.sdk),
  cliPath = resolve(values.cli),
  label = values.label
const hash = (value) => createHash("sha256").update(value).digest("hex")
const json = async (path) => JSON.parse(await readFile(path, "utf8"))
const save = async (path, value) => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" })
}
assert.equal((await json(join(root, "verification-run.json"))).root, root)
const original = (await json(join(root, "evidence/nxt-commands/baseline-cold-main.json"))).output
const { page_id: page, database_id: entry, skill_id: skillId } = original.record.locator
assert.equal(original.record.locator.type, "shared_skill")
const output = join(root, "evidence/nxt-cache", label)
await mkdir(dirname(output), { recursive: true, mode: 0o700 })
await mkdir(output, { mode: 0o700 })
const artifacts = {
  sdk: { path: sdkPath, sha256: hash(await readFile(sdkPath)) },
  cli: { path: cliPath, sha256: hash(await readFile(cliPath)) },
}
await save(join(output, "started.json"), {
  phase: values.phase,
  artifacts,
  entry,
  page,
  skill_id: skillId,
  started: new Date().toISOString(),
})
const sdk = await import(pathToFileURL(sdkPath).href)
let sequence = 0
const evidencePath = (name) => join(output, `${String(++sequence).padStart(2, "0")}-${name}.json`)
async function client(name) {
  const directory = join(root, "scratch/clients", `${label}-${name}`)
  await mkdir(directory, { mode: 0o700 })
  assert.deepEqual(await readdir(directory), [])
  const env = {
    ...process.env,
    NTN_SKILLS_HOME: join(directory, "state"),
    NTN_SKILLS_CONFIG_HOME: join(directory, "config"),
    NTN_SKILLS_CACHE_HOME: join(directory, "cache"),
    NTN_SKILLS_DATA_HOME: join(directory, "data"),
    NTN_SKILLS_REQUEST_TRACE_LIMIT: "10000",
  }
  delete env.NTN_SKILLS_DEV_ROOT
  return { name, directory, env }
}
async function cli(client, name, args, controls = {}) {
  const destination = evidencePath(name)
  await save(destination + ".started", {
    client: client.name,
    argv: args,
    artifact: artifacts.cli,
    node_arguments: controls.nodeArgs ?? [],
    started: new Date().toISOString(),
  })
  const child = spawn(process.execPath, [...(controls.nodeArgs ?? []), cliPath, ...args], {
    env: { ...client.env, ...controls.env },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = "",
    stderr = ""
  child.stdout.setEncoding("utf8").on("data", (part) => {
    stdout += part
  })
  child.stderr.setEncoding("utf8").on("data", (part) => {
    stderr += part
  })
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("close", resolve)
  })
  let result
  try {
    result = JSON.parse(stdout)
  } catch {
    result = { unparsed_stdout_sha256: hash(stdout) }
  }
  await save(destination, {
    client: client.name,
    argv: args,
    code,
    result,
    stderr: { bytes: Buffer.byteLength(stderr), sha256: hash(stderr) },
    finished: new Date().toISOString(),
  })
  assert.equal(hash(await readFile(cliPath)), artifacts.cli.sha256)
  assert.ok(
    (controls.allowedCodes ?? [0]).includes(code),
    `${name} failed (${code}); inspect ${destination}`,
  )
  return result
}
async function call(client, name, operation, input, overrides = {}) {
  const destination = evidencePath(name)
  let metrics = null
  try {
    const result = await sdk[operation](input, {
      env: client.env,
      database: entry,
      readOnly: true,
      metrics: true,
      ...overrides,
      onRequestMetrics: (value) => {
        metrics = value
      },
    })
    await save(destination, {
      client: client.name,
      operation,
      input,
      overrides,
      result,
      metrics,
      finished: new Date().toISOString(),
    })
    assert.equal(hash(await readFile(sdkPath)), artifacts.sdk.sha256)
    assert.equal(metrics?.requests.notion_write, 0)
    assert.equal(metrics?.unknown_response_bytes, 0)
    assert.equal(metrics?.in_flight, 0)
    return { result, metrics }
  } catch (error) {
    await save(destination + ".failed", {
      client: client.name,
      operation,
      input,
      error: {
        code: error?.code ?? null,
        message: error instanceof Error ? error.message : "unknown",
      },
      metrics,
    })
    throw error
  }
}
function proof(read, policy, ttl, revision) {
  assert.equal(read.result.freshness?.policy_source, policy)
  assert.equal(read.result.freshness?.max_age_ms, ttl)
  if (revision !== undefined) assert.equal(read.result.freshness?.profile_revision_id, revision)
  assert.equal(read.result.freshness?.current_eligibility_max_age_ms, 300000)
  assert.equal(read.result.freshness?.full_body_max_age_ms, 86400000)
}
async function protectedState(client, report) {
  const objects = []
  for (const object of report.objects)
    objects.push({
      sha256: object.sha256,
      actual_sha256: hash(
        await readFile(join(client.env.NTN_SKILLS_HOME, "objects", object.sha256)),
      ),
      bytes: object.bytes,
    })
  return {
    entries: report.entries
      .filter((row) => !row.reconstructible || row.protected_by.length > 0)
      .map(({ key, sha256 }) => ({ key, sha256 })),
    objects,
  }
}
try {
  if (values.phase === "profile") {
    const author = await client("author"),
      a = await client("a"),
      b = await client("b")
    const profile = `nxt-${label}`
    const defaults = { read_max_age_ms: 60000, source_check_max_age_ms: 90000 }
    const rules = {
      default: defaults,
      skills: [{ skill_id: skillId, read_max_age_ms: 0, source_check_max_age_ms: 15000 }],
    }
    const setArgs = (base, value) => [
      "ctl",
      "library",
      "profile",
      "set",
      profile,
      "--entry",
      entry,
      "--name",
      "NXT shared freshness",
      "--enabled",
      "true",
      "--base",
      base,
      "--freshness-json",
      JSON.stringify(value),
    ]
    const initial = await cli(author, "profile-set-initial", setArgs("new", rules))
    assert.equal(initial.verified, true)
    const readings = []
    for (const current of [a, b]) {
      const bound = await cli(current, `${current.name}-bind-initial`, [
        "ctl",
        "library",
        "profile",
        "bind",
        profile,
        "--entry",
        entry,
      ])
      assert.equal(bound.profile_revision_id, initial.revision_id)
      const effective = await cli(current, `${current.name}-effective-initial`, [
        "ctl",
        "library",
        "profile",
        "freshness",
        profile,
        "--entry",
        entry,
        "--skill",
        skillId,
      ])
      assert.equal(effective.effective.source_check_max_age_ms, 15000)
      const cold = await call(current, `${current.name}-initial-cold`, "readSkill", page)
      const repeated = await call(current, `${current.name}-initial-repeated`, "readSkill", page)
      proof(cold, "skill", 0, initial.revision_id)
      proof(repeated, "skill", 0, initial.revision_id)
      assert.equal(repeated.result.snapshot_id, cold.result.snapshot_id)
      assert.ok(repeated.metrics.total_requests > 0)
      readings.push({
        client: current.name,
        cold: cold.metrics.total_requests,
        repeated: repeated.metrics.total_requests,
        initial_snapshot: cold.result.snapshot_id,
      })
    }
    const reverted = await cli(
      author,
      "profile-remove-override",
      setArgs(initial.revision_id, { default: defaults, skills: [] }),
    )
    assert.equal(reverted.verified, true)
    assert.notEqual(reverted.revision_id, initial.revision_id)
    for (const current of [a, b]) {
      const bound = await cli(current, `${current.name}-bind-inherited`, [
        "ctl",
        "library",
        "profile",
        "bind",
        profile,
        "--entry",
        entry,
      ])
      assert.equal(bound.profile_revision_id, reverted.revision_id)
      const effective = await cli(current, `${current.name}-effective-inherited`, [
        "ctl",
        "library",
        "profile",
        "freshness",
        profile,
        "--entry",
        entry,
        "--skill",
        skillId,
      ])
      assert.equal(effective.effective.source_check_max_age_ms, 90000)
      const inherited = await call(current, `${current.name}-inherited-observed`, "readSkill", page)
      proof(inherited, "profile", 60000, reverted.revision_id)
      const warm = await call(current, `${current.name}-inherited-warm`, "readSkill", page)
      proof(warm, "profile", 60000, reverted.revision_id)
      assert.equal(warm.metrics.total_requests, 0)
      assert.equal(warm.result.snapshot_id, inherited.result.snapshot_id)
      assert.equal(warm.result.freshness.validated_at, inherited.result.freshness.validated_at)
      const explicit = await call(current, `${current.name}-explicit-zero`, "readSkill", page, {
        maxAge: 0,
      })
      proof(explicit, "explicit", 0)
      assert.ok(explicit.metrics.total_requests > 0)
      const config = await json(join(current.env.NTN_SKILLS_CONFIG_HOME, "config.json"))
      assert.deepEqual(config.shared_profile, { library_entry: entry, profile_id: profile })
      assert.equal(config.shared_profile.freshness, undefined)
    }
    await save(join(output, "result.json"), {
      status: "passed",
      kind: "real_shared_profile_two_independent_clients",
      artifacts,
      profile,
      initial_revision: initial.revision_id,
      inherited_revision: reverted.revision_id,
      no_store_copy: true,
      readings,
      source_check: "effective shared policy observed; no source run dispatched",
      finished: new Date().toISOString(),
    })
  } else if (values.phase === "audit") {
    const current = await client("audit")
    const budget = ["--max-requests", "100", "--max-bytes", "16777216", "--duration-ms", "120000"]
    const controls = { allowedCodes: [0, 3, 4, 75] }
    let report = await cli(
      current,
      "audit-census",
      ["ctl", "audit", "run", "--entry", entry, "--census", "--depth", "metadata", ...budget],
      controls,
    )
    const runId = report.run_id
    assert.match(runId, /^audit-[a-f0-9-]{36}$/u)
    for (let continuation = 1; report.execution === "paused" && continuation <= 3; continuation++) {
      report = await cli(
        current,
        `audit-resume-${continuation}`,
        ["ctl", "audit", "resume", runId, "--entry", entry, ...budget],
        controls,
      )
      assert.equal(report.run_id, runId)
    }
    assert.equal(report.execution, "completed")
    assert.equal(report.reverse_table_completeness, "complete")
    assert.equal(report.skill_states, "unobserved")
    assert.deepEqual([...report.inventory.reverse_tables].sort(), [
      "files",
      "records",
      "skills",
      "sources",
    ])
    assert.deepEqual([...report.inventory.final_census_tables].sort(), [
      "files",
      "records",
      "skills",
      "sources",
    ])
    assert.equal(report.observation_interval.atomic_snapshot, false)
    assert.equal(report.growth.sizes.header_payload_bytes, null)
    assert.equal(report.growth.sizes.remote_physical_bytes, null)
    assert.equal(report.growth.sizes.total_library_bytes, null)
    assert.equal(report.growth.remote_gc, "not_performed")
    assert.equal(report.growth.deletion, "not_performed")
    const guard = join(output, "offline-network-guard.mjs"),
      networkCount = join(output, "offline-network-count.json")
    await writeFile(
      guard,
      `import {writeFileSync} from "node:fs";let attempts=0;globalThis.fetch=()=>{attempts++;throw new Error("Offline audit report attempted Fetch")};process.once("exit",()=>writeFileSync(${JSON.stringify(networkCount)},JSON.stringify({fetch_attempts:attempts})+"\\n",{flag:"wx",mode:0o600}));\n`,
      { mode: 0o600, flag: "wx" },
    )
    const offline = await cli(
      current,
      "audit-offline-report",
      ["ctl", "audit", "report", runId, "--entry", entry],
      {
        allowedCodes: [0, 3, 4],
        nodeArgs: ["--import", guard],
        env: { NOTION_API_TOKEN: "", NOTION_API_BASE_URL: "http://127.0.0.1:9" },
      },
    )
    assert.deepEqual(offline, report)
    assert.equal((await json(networkCount)).fetch_attempts, 0)
    const { DatabaseSync } = await import("node:sqlite")
    const database = new DatabaseSync(join(current.env.NTN_SKILLS_HOME, "state.sqlite"), {
      readOnly: true,
    })
    let raw
    try {
      raw = database
        .prepare("SELECT payload FROM shared_local_records WHERE key=?")
        .get(`audit/runs/${runId}.json`)?.payload
    } finally {
      database.close()
    }
    assert.equal(typeof raw, "string")
    await writeFile(join(output, "original-checkpoint.json"), raw + "\n", {
      flag: "wx",
      mode: 0o600,
    })
    const checkpoint = JSON.parse(raw),
      run = checkpoint.run
    assert.equal(run.run_id, runId)
    const field = (row, table, name) =>
      Object.values(row.properties ?? {}).find((value) => value.id === table.property_ids[name]) ??
      row.properties?.[name] ??
      {}
    const rich = (row, table, name) =>
      (field(row, table, name).rich_text ?? field(row, table, name).title ?? [])
        .map((part) => part.plain_text ?? part.text?.content ?? "")
        .join("")
    const relations = (row, table, name) =>
      (field(row, table, name).relation ?? []).map((value) => value.id)
    const records = run.inventory.records.map((row) => {
      const kind = field(row, run.library.records, "Kind").select?.name ?? null
      const owners = relations(row, run.library.records, "Skill")
      return {
        page_id: row.id,
        record_id: rich(row, run.library.records, "Record ID"),
        kind,
        entity_id: rich(row, run.library.records, "Entity ID"),
        hash: rich(row, run.library.records, "Hash"),
        owners,
        bytes: null,
        protected_by: [
          ...(kind === "snapshot" ? ["historical_snapshot"] : []),
          ...(kind === "operation" || kind === "plan"
            ? ["original_operation_or_pending_intent"]
            : []),
          ...(owners.length > 1 ? ["multiple_owners"] : []),
          "private_pins_and_external_sessions_unobserved",
        ],
        reclaimable: false,
      }
    })
    const identities = {
      run_id: runId,
      basis: "complete non-atomic metadata census; no payload or live private reference closure",
      current_skills: run.inventory.skills.map((row) => ({
        page_id: row.id,
        skill_id: rich(row, run.library.skills, "Skill ID"),
        main_file_id: rich(row, run.library.skills, "Main File ID"),
        enabled: field(row, run.library.skills, "Enabled").checkbox ?? null,
        requires: relations(row, run.library.skills, "Requires"),
        origin: relations(row, run.library.skills, "Origin"),
      })),
      files: run.inventory.files.map((row) => ({
        page_id: row.id,
        file_id: rich(row, run.library.files, "File ID"),
        path: rich(row, run.library.files, "Path"),
        owners: relations(row, run.library.files, "Skill"),
      })),
      retained_records: records,
      record_kind_counts: Object.fromEntries(
        [...new Set(records.map((row) => row.kind))].map((kind) => [
          kind,
          records.filter((row) => row.kind === kind).length,
        ]),
      ),
      sources: run.inventory.sources.map((row) => ({
        page_id: row.id,
        last_edited_time: row.last_edited_time,
      })),
      active_and_tombstone_state: "unobserved_at_census_depth",
      remote_reclamation: "not_performed",
    }
    await save(join(output, "identities-and-protection.json"), identities)
    await save(join(output, "result.json"), {
      status: "census_completed",
      kind: "installed_cli_complete_metadata_growth_and_offline_replay",
      artifacts,
      no_store_copy: true,
      run_id: runId,
      execution: report.execution,
      coverage: report.coverage,
      severity: report.severity,
      inventory: report.inventory,
      observation_interval: report.observation_interval,
      request_totals: report.request_totals,
      growth: report.growth,
      offline_report_identical: true,
      offline_fetch_attempts: 0,
      checkpoint_file_sha256: hash(raw + "\n"),
      current_and_old_identity_file: "identities-and-protection.json",
      remote_writes: "none",
      remote_reclamation: "not_performed",
      finished: new Date().toISOString(),
    })
  } else {
    const current = await client("cache")
    const main = await call(current, "cold-main", "readSkill", page)
    const input = { version: 1, targets: [main.result.ref], purpose: "use" }
    const first = await call(current, "consume-before", "consume", input)
    assert.equal(first.result.status, "ready")
    const before = await cli(current, "retention-before", ["ctl", "cache", "retention"])
    const protectedBefore = await protectedState(current, before)
    assert.ok(
      before.entries.some(
        (row) => row.reconstructible && row.key.startsWith("cache/shared-derived-graphs/"),
      ),
      "The public consumer must produce a real rebuildable graph index",
    )
    await cli(current, "capacity-zero", [
      "ctl",
      "cache",
      "capacity",
      "--max-bytes",
      "0",
      "--retention",
      "0",
    ])
    const preview = await cli(current, "reclaim-preview", ["ctl", "cache", "reclaim"])
    assert.ok(preview.candidates.length > 0)
    assert.equal(preview.remote_requests, 0)
    for (const candidate of preview.candidates)
      assert.match(
        candidate.key,
        /^cache\/(shared-github-blobs|shared-record-payloads|shared-derived-graphs)\//u,
      )
    const reclaimed = await cli(current, "reclaim-apply", [
      "ctl",
      "cache",
      "reclaim",
      "--apply",
      "--plan",
      preview.plan_id,
    ])
    assert.equal(reclaimed.archive?.trash_confirmed, true)
    assert.deepEqual(
      [...reclaimed.reclaimed].sort(),
      preview.candidates.map((row) => row.key).sort(),
    )
    const after = await cli(current, "retention-after", ["ctl", "cache", "retention"])
    assert.equal(after.totals.rebuildable_logical_bytes, 0)
    assert.deepEqual(await protectedState(current, after), protectedBefore)
    let trashReadback
    const guessedTrash = join(homedir(), ".Trash", basename(reclaimed.archive.original_path))
    try {
      const bytes = await readFile(guessedTrash)
      assert.equal(hash(bytes), reclaimed.archive.sha256)
      trashReadback = { status: "verified", sha256: hash(bytes), path: guessedTrash }
    } catch (error) {
      if (error?.code !== "EACCES" && error?.code !== "EPERM" && error?.code !== "ENOENT")
        throw error
      trashReadback = { status: "not_independently_readable", code: error.code }
    }
    const bounded = await call(current, "consume-capacity-zero", "consume", input)
    assert.equal(bounded.result.status, "ready")
    const boundedReport = await cli(current, "retention-capacity-zero", [
      "ctl",
      "cache",
      "retention",
    ])
    assert.equal(boundedReport.totals.rebuildable_logical_bytes, 0)
    await cli(current, "capacity-restore", [
      "ctl",
      "cache",
      "capacity",
      "--max-bytes",
      "67108864",
      "--retention",
      "7d",
    ])
    const rebuilt = await call(current, "consume-rebuilt", "consume", input)
    assert.equal(rebuilt.result.status, "ready")
    assert.deepEqual(
      rebuilt.result.entries.map((row) => row.manifest_sha256),
      first.result.entries.map((row) => row.manifest_sha256),
    )
    const final = await cli(current, "retention-rebuilt", ["ctl", "cache", "retention"])
    assert.ok(final.totals.rebuildable_logical_bytes > 0)
    assert.ok(final.entries.some((row) => row.key.startsWith("cache/shared-derived-graphs/")))
    await save(join(output, "result.json"), {
      status: "passed",
      kind: "real_sdk_derived_cache_trash_rebuild",
      artifacts,
      no_store_copy: true,
      plan_id: preview.plan_id,
      reclaimed: reclaimed.reclaimed,
      trash_readback: trashReadback,
      protected_payloads_and_objects_identical_after_reclaim: true,
      before: before.totals,
      after: after.totals,
      rebuilt: final.totals,
      physical_sqlite_before: before.database,
      physical_sqlite_after: after.database,
      capacity_zero_consume: "ready_without_optional_index_admission",
      remote_writes: "none",
      finished: new Date().toISOString(),
    })
  }
  console.log(
    JSON.stringify({
      evidence: join(output, "result.json"),
      phase: values.phase,
      status: "passed",
    }),
  )
} catch (error) {
  await save(join(output, "failed.json"), {
    phase: values.phase,
    code: error?.code ?? null,
    message: error instanceof Error ? error.message : "unknown",
    finished: new Date().toISOString(),
  })
  throw error
}
