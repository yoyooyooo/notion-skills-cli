import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { homedir } from "node:os"
import { parseArgs } from "node:util"
import { Schema } from "effect"
import { property } from "../../../../packages/core/src/model.ts"
import { SharedLibrarySchema } from "../../../../packages/core/src/shared-library-model.ts"
import { requireTestCommand } from "./empty-library.ts"

const digest = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex")
const json = async (path: string) => JSON.parse(await readFile(path, "utf8")) as unknown
const save = async (path: string, value: unknown) => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" })
}

export const nxtCases = [
  ["NXT01", "AH-1051", "empty init / census", "ready empty", "partial init", "verify-ntn-skills"],
  [
    "NXT02",
    "AH-1052",
    "apply / operation show",
    "exact next argv",
    "unknown is not replayable",
    "verify-notion-operation-recovery",
  ],
  [
    "NXT03",
    "AH-1053",
    "apply",
    "new references and main in one intent",
    "stale or unknown binding",
    "verify-ntn-skills",
  ],
  [
    "NXT04",
    "AH-1054",
    "library sources run",
    "selected and display separately",
    "custom protected",
    "verify-notion-resource-lifecycle",
  ],
  [
    "NXT05",
    "AH-1055",
    "library file request",
    "original update and feedback",
    "feedback-only retry",
    "verify-notion-operation-recovery",
  ],
  [
    "NXT06",
    "AH-1056",
    "library init / Pi source",
    "entry then explicit connection",
    "unavailable configuration",
    "verify-notion-skills-integration",
  ],
  [
    "NXT07",
    "AH-1057",
    "Pi read / use / refresh",
    "one complete effective body",
    "foreign ref or truncated result",
    "verify-context-broker",
  ],
  [
    "NXT08",
    "AH-1034",
    "profile / read",
    "shared policy and original validation time",
    "expired does not erase pin",
    "verify-notion-consumer-state",
  ],
  [
    "NXT09",
    "AH-1058",
    "SDK read",
    "equal content and freshness at lower cost",
    "canceled waiter and late observation",
    "verify-notion-skills-integration",
  ],
  [
    "NXT10",
    "AH-1059",
    "cache status / audit",
    "growth and exact retention reasons",
    "partial inventory protects unknowns",
    "verify-ntn-skills",
  ],
  [
    "NXT11",
    "AH-1060",
    "cache retention",
    "preview then Trash and rebuild",
    "protected set over budget",
    "verify-ntn-skills",
  ],
  [
    "NXT12",
    "AH-1023",
    "Pi working set",
    "release root and preserve Requires",
    "late result cannot reactivate",
    "verify-notion-consumer-state",
  ],
  [
    "NXT13",
    "AH-1061",
    "native write / readback",
    "bound representation and bounded diagnostic",
    "changed code or foreign link",
    "verify-ntn-skills",
  ],
  [
    "NXT14",
    "AH-1062",
    "schema / package / guard",
    "one exact CLI and SDK input",
    "wrong producer or missing resource",
    "verify-notion-skills-integration",
  ],
  [
    "NXT15",
    "AH-1063",
    "same-library full journey",
    "all verified layers joined",
    "partial remains partial",
    "verify-notion-skills-integration",
  ],
] as const

async function freeze(root: string, bin: string) {
  const folder = join(root, "scratch", "nxt-fixture")
  const paragraphs = Array.from(
    { length: 28 },
    (_, i) =>
      `Section ${i + 1} records an approved maintenance observation. Preserve the exact selected owner, resource path and version. Reading this text never authorizes script execution or a remote write.`,
  )
  const files = [
    {
      path: "SKILL.md",
      mode: 0o644,
      bytes: Buffer.from(
        "---\nname: nxt-journey\ndescription: Read the two named references for the isolated maintenance acceptance task.\n---\n\n# NXT journey\n\n" +
          paragraphs.join("\n\n") +
          "\n\nRead [alpha](references/alpha.md) and [beta](references/beta.md) only when requested.\n",
      ),
    },
    {
      path: "references/alpha.md",
      mode: 0o644,
      bytes: Buffer.from("# Alpha\n\nALPHA_FIXED_VALUE_20261115\n"),
    },
    {
      path: "references/beta.md",
      mode: 0o644,
      bytes: Buffer.from("# Beta\n\nBETA_FIXED_VALUE_20261115\n"),
    },
    {
      path: "scripts/example.sh",
      mode: 0o755,
      bytes: Buffer.from("#!/bin/sh\nprintf '%s\\n' 'NXT_RESOURCE_NOT_EXECUTED'\n"),
    },
    {
      path: "assets/config.json",
      mode: 0o644,
      bytes: Buffer.from('{"version":1,"purpose":"nxt-frozen-input","execute":false}\n'),
    },
    {
      path: "assets/sample.bin",
      mode: 0o644,
      bytes: Uint8Array.from([0, 1, 2, 127, 128, 254, 255, 13, 10]),
    },
  ]
  const hashes = []
  for (const file of files) {
    const path = join(folder, file.path)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, file.bytes, { flag: "wx", mode: file.mode })
    await chmod(path, file.mode)
    hashes.push({
      path: file.path,
      bytes: file.bytes.length,
      sha256: digest(file.bytes),
      mode: file.mode,
    })
  }
  const sentinels = []
  for (const path of [
    join(homedir(), ".config/ntn-skills/config.json"),
    join(homedir(), ".pi/agent/settings.json"),
    join(homedir(), ".pi/agent/context-broker/config.yml"),
    join(homedir(), ".zshenv"),
  ]) {
    try {
      sentinels.push({ path, sha256: digest(await readFile(path)) })
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        sentinels.push({ path, missing: true })
      else throw error
    }
  }
  const baseline = {
    version: 1,
    frozen_at: new Date().toISOString(),
    fixture: folder,
    files: hashes,
    product: {
      cli: bin,
      sha256: digest(await readFile(bin)),
      commit: "4580b7d6d692013091d5c66e90d703d51fd5fb10",
    },
    source: {
      url: "https://github.com/nowledge-co/community.git",
      A: "d6e546efe17c9ba48291a67356c4be6f7a7883a8",
      B: "657919af19c22951796b326af44032a63dec24f2",
      roots: [
        "nowledge-mem-npx-skills/skills/check-integration",
        "nowledge-mem-npx-skills/skills/read-working-memory",
      ],
      execution_allowed: false,
    },
    comparison: {
      invariants: [
        "task",
        "content_hashes",
        "version",
        "permission",
        "freshness_policy",
        "cache_state",
      ],
      budgets: {
        unchanged_author_content_writes: 0,
        unchanged_extra_objects: 0,
        required_body_copies: 1,
      },
      http: "Measured product request_metrics only. Missing bytes, attempts or waits are unknown, never inferred from tool counts.",
      no_regression:
        "For unchanged and single-reference changes, candidate request/complete-response bytes must not exceed the measured baseline at equal inputs; compare affected cases separately.",
      latency: "Record samples; no percentile or all-environment latency claim.",
    },
    model: {
      provider: "magpie",
      model: "group/worker",
      runs_per_task: 1,
      max_turns: 10,
      max_output_tokens_per_turn: 4096,
      tasks: [
        "cold onboarding and safe connection choice",
        "one complete maintenance intent",
        "read vs use and two references",
      ],
      failures_retained: true,
      rerun_for_green: false,
    },
    scenarios: nxtCases.map(([id, issue, entry, positive, negative, owner]) => ({
      id,
      issue,
      entry,
      positive,
      negative,
      owner,
      evidence: "pending",
    })),
    sentinels,
  }
  const path = join(root, "evidence", "nxt-baseline.json")
  await save(path, baseline)
  return { baseline: path, fixture: folder, files: hashes.length, cases: nxtCases.length }
}

async function command(root: string, bin: string, label: string, argv: string[], client?: string) {
  assert.match(label, /^[a-z0-9][a-z0-9-]*$/)
  const state = property(await json(join(root, "evidence", "empty-library", "state.json")))
  assert.equal(state.kind, "library_ready")
  const library = Schema.decodeUnknownSync(SharedLibrarySchema)(state.library)
  if (
    argv.slice(0, 3).join(" ") === "ctl library sources" &&
    ["run-status", "run-resume"].includes(argv[3] ?? "")
  ) {
    assert.match(argv[4] ?? "", /^source-run-[a-f0-9-]+$/)
    assert.ok(
      !argv.includes("--entry") && !argv.includes("--database"),
      "Original-run commands obtain scope from their retained receipt",
    )
    let retained = false
    for (const name of await readdir(join(root, "evidence", "nxt-commands"))) {
      if (!name.endsWith(".json")) continue
      const evidence = property(await json(join(root, "evidence", "nxt-commands", name)))
      const output = property(evidence.output)
      if (
        output.run_id === argv[4] &&
        output.entry === library.skills.database_id &&
        output.library_id === library.library_id &&
        evidence.client === (client ?? "author")
      )
        retained = true
    }
    assert.ok(
      retained,
      "Continue only an original run already observed in this owned library and client",
    )
  } else requireTestCommand(argv, library)
  assert.ok(
    !argv.some((arg) => /^(?:Bearer |secret_|ntn_)/u.test(arg)) && !argv.includes("set-token"),
  )
  const marker = property(await json(join(root, "verification-run.json")))
  assert.equal(marker.root, root)
  if (client !== undefined) assert.match(client, /^[a-z0-9][a-z0-9-]*$/)
  const scratch =
    client === undefined ? join(root, "scratch") : join(root, "scratch", "clients", client)
  const env: Record<string, string | undefined> = {
    ...process.env,
    NTN_SKILLS_REQUEST_TRACE_LIMIT: "10000",
    NTN_SKILLS_CONFIG_HOME: join(scratch, "config"),
    NTN_SKILLS_HOME: join(scratch, "state"),
    NTN_SKILLS_CACHE_HOME: join(scratch, "cache"),
    NTN_SKILLS_DATA_HOME: join(scratch, "data"),
    XDG_CONFIG_HOME: join(scratch, "xdg", "config"),
    XDG_STATE_HOME: join(scratch, "xdg", "state"),
    XDG_CACHE_HOME: join(scratch, "xdg", "cache"),
    XDG_DATA_HOME: join(scratch, "xdg", "data"),
  }
  // The package launcher treats even an empty DEV_ROOT as an explicit override.
  // Remove it only in this verification child; retain the inherited value as evidence.
  delete env.NTN_SKILLS_DEV_ROOT
  const execution = {
    entry: "packaged-node",
    inherited_dev_root: process.env.NTN_SKILLS_DEV_ROOT ?? null,
    forwarded_dev_root: false,
  }
  const path = join(root, "evidence", "nxt-commands", label + ".json")
  const started = Date.now()
  const binSha = digest(await readFile(bin))
  await save(path + ".started", {
    argv,
    bin,
    bin_sha256: binSha,
    execution,
    started: new Date().toISOString(),
    root,
  })
  const child = Bun.spawn(["node", bin, ...argv], {
    env,
    cwd: dirname(bin),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  let output: unknown
  try {
    output = JSON.parse(stdout)
  } catch {
    output = stdout
  }
  const binAfterSha = digest(await readFile(bin))
  const result = {
    argv,
    bin,
    bin_sha256: binSha,
    bin_after_sha256: binAfterSha,
    bin_unchanged: binAfterSha === binSha,
    execution,
    client: client ?? "author",
    scratch,
    exit,
    output,
    elapsed_ms: Date.now() - started,
    finished: new Date().toISOString(),
    stderr: { bytes: Buffer.byteLength(stderr), sha256: digest(stderr) },
  }
  await save(path, result)
  assert.equal(
    binAfterSha,
    binSha,
    "The command artifact changed; preserve its outcome before any follow-up",
  )
  const visible = property(output)
  const metrics = property(visible.request_metrics)
  return {
    evidence: path,
    exit,
    ok: visible.ok,
    status: visible.status,
    operation_id: visible.operation_id,
    error:
      visible.error === undefined
        ? undefined
        : {
            code: property(visible.error).code,
            message: property(visible.error).message,
          },
    request_metrics: {
      requests: metrics.requests,
      total_requests: metrics.total_requests,
      request_bytes: metrics.request_bytes,
      response_bytes: metrics.response_bytes,
      duplicate_requests: metrics.duplicate_requests,
      coalesced_requests: metrics.coalesced_requests,
    },
  }
}

async function prepareIntents(root: string) {
  const baseline = property(await json(join(root, "evidence", "nxt-baseline.json")))
  const original = await readFile(join(root, "scratch", "nxt-fixture", "SKILL.md"), "utf8")
  const sections = original.split("\n\n").filter((part) => part.startsWith("Section "))
  assert.equal(sections.length, 28)
  const folder = join(root, "scratch", "nxt-maintenance")
  const files = [
    {
      path: "SKILL.md",
      text: "---\nname: nxt-journey\ndescription: Read the two named references for the isolated maintenance acceptance task.\n---\n\n# NXT journey\n\nRead [part A](references/part-a.md) and [part B](references/part-b.md) for the complete maintenance observations.\n\nRead [alpha](references/renamed-alpha.md) and [beta](references/beta.md) only when requested.\n",
    },
    {
      path: "references/part-a.md",
      text: "# Maintenance observations A\n\n" + sections.slice(0, 14).join("\n\n") + "\n",
    },
    {
      path: "references/part-b.md",
      text: "# Maintenance observations B\n\n" + sections.slice(14).join("\n\n") + "\n",
    },
  ]
  for (const file of files) {
    const path = join(folder, file.path)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, file.text, { flag: "wx", mode: 0o644 })
  }
  const changes = join(root, "scratch", "nxt-maintenance-changes.json")
  await save(changes, {
    version: 1,
    moves: [{ from: "references/alpha.md", to: "references/renamed-alpha.md" }],
  })
  const source = property(baseline.source)
  const definition = {
    version: 1,
    source_id: "nxt-community-upstream",
    name: "NXT community upstream",
    description: "Owned NXT fixed two-member Git acceptance; content is never executed.",
    enabled: true,
    policy: "manual",
    adapter: { type: "git", url: source.url, ref: source.A },
    selection: { roots: source.roots, include: [], exclude: [], mapping: {} },
    options: {},
  }
  const sourceA = join(root, "scratch", "nxt-source-A.json")
  const sourceB = join(root, "scratch", "nxt-source-B.json")
  await save(sourceA, definition)
  await save(sourceB, { ...definition, adapter: { ...definition.adapter, ref: source.B } })
  const result = {
    frozen_at: new Date().toISOString(),
    folder,
    changes,
    sourceA,
    sourceB,
    files: files.map((file) => ({
      path: file.path,
      bytes: Buffer.byteLength(file.text),
      sha256: digest(file.text),
    })),
    unchanged_resources: [
      "references/beta.md",
      "scripts/example.sh",
      "assets/config.json",
      "assets/sample.bin",
    ],
    moved_identity: { from: "references/alpha.md", to: "references/renamed-alpha.md" },
    all_original_observations_retained: true,
  }
  await save(join(root, "evidence", "nxt-intents.json"), result)
  return result
}

export async function runNxtJourney(args: readonly string[]) {
  const split = args.indexOf("--")
  const parsed = parseArgs({
    args: [...args.slice(0, split < 0 ? undefined : split)],
    options: {
      run: { type: "string" },
      bin: { type: "string" },
      label: { type: "string" },
      client: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  })
  const root = parsed.values.run,
    bin = parsed.values.bin
  assert.ok(root && isAbsolute(root) && bin && isAbsolute(bin))
  assert.equal((await stat(bin)).isFile(), true)
  assert.equal(resolve(root), root)
  assert.ok(
    (await readdir(root)).includes("verification-run.json"),
    "Use existing control.ts init first",
  )
  if (parsed.positionals[0] === "freeze") return freeze(root, bin)
  if (parsed.positionals[0] === "prepare-intents") return prepareIntents(root)
  assert.equal(parsed.positionals[0], "command")
  assert.ok(parsed.values.label && split >= 0)
  return command(root, bin, parsed.values.label, [...args.slice(split + 1)], parsed.values.client)
}

if (import.meta.main) {
  const result = await runNxtJourney(process.argv.slice(2))
  console.log(JSON.stringify(result))
}
