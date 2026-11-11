/** Read-only CLI acceptance against a receipt created by shared-library-probe.ts. */
import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { Effect, Schema } from "effect"
import { live } from "../../../../packages/cli/src/command-runtime.ts"
import { Notion } from "../../../../packages/core/src/notion.ts"
import { withReadOnlyNotion } from "../../../../packages/core/src/notion-readonly.ts"
import { decode, listSchema, property } from "../../../../packages/core/src/model.ts"
import { loadSharedLibrary } from "../../../../packages/core/src/shared-library.ts"

const args = process.argv.slice(2)
const value = (flag: string) => {
  const index = args.indexOf(flag)
  return index < 0 ? undefined : args[index + 1]
}
const plan = {
  purpose: "Observe a fresh native fixture through the actual CLI without adopting ownership",
  usage:
    "node native-state-readonly-probe.ts --live --fixture RECEIPT_JSON --cli FROZEN_CLI_MJS --run NEW_ABSOLUTE_DIRECTORY",
  commands: ["ctl library state", "ctl library state --observe", "ctl library state"],
  checks: [
    "all recorded pages retain metadata and body hashes",
    "selected Skill Records remain empty",
    "all CLI calls issue zero remote writes",
    "no state observation adopts ownership",
  ],
  remote_writes: 0,
  mixed_c2_c1_n1_coverage: false,
}
if (!args.includes("--live") || args.includes("--help")) {
  console.log(JSON.stringify(plan, null, 2))
  process.exit(0)
}
const receiptPath = value("--fixture")
const cliPath = value("--cli")
const directory = value("--run")
if (!receiptPath || !cliPath || !directory || !isAbsolute(directory)) throw Error(plan.usage)
const run = resolve(directory)
await mkdir(run, { mode: 0o700 })
const save = (name: string, data: unknown) =>
  writeFile(join(run, name), `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: "wx" })
const hash = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex")
const receiptBytes = await readFile(receiptPath)
const fixture = decode(
  Schema.Struct({
    entry: Schema.String,
    fixture_id: Schema.String,
    pages: Schema.Record(Schema.String, Schema.String),
    pending: Schema.optional(Schema.String),
  }),
  JSON.parse(receiptBytes.toString("utf8")),
)
const target = fixture.pages.main
if (!target || fixture.pending || Object.keys(fixture.pages).length < 3)
  throw Error("A complete owned main-plus-files fixture receipt is required.")
const env = {
  ...process.env,
  NTN_SKILLS_CONFIG_HOME: join(run, "runtime", "config"),
  NTN_SKILLS_HOME: join(run, "runtime", "state"),
  NTN_SKILLS_CACHE_HOME: join(run, "runtime", "cache"),
  NTN_SKILLS_DATA_HOME: join(run, "runtime", "data"),
  XDG_CONFIG_HOME: join(run, "runtime", "xdg", "config"),
  XDG_STATE_HOME: join(run, "runtime", "xdg", "state"),
  XDG_CACHE_HOME: join(run, "runtime", "xdg", "cache"),
  XDG_DATA_HOME: join(run, "runtime", "xdg", "data"),
  NTN_SKILLS_REQUEST_TRACE_LIMIT: "10000",
}
// Consume inherited credential configuration through the existing provider; never copy token values.
for (const key of [
  "NTN_SKILLS_CONFIG_HOME",
  "NTN_SKILLS_HOME",
  "NTN_SKILLS_CACHE_HOME",
  "NTN_SKILLS_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "NTN_SKILLS_REQUEST_TRACE_LIMIT",
] as const)
  process.env[key] = env[key]
await save("started.json", {
  ...plan,
  started_at: new Date().toISOString(),
  node: process.version,
  fixture,
  receipt_file: resolve(receiptPath),
  receipt_sha256: hash(receiptBytes),
  cli_file: resolve(cliPath),
  cli_sha256: hash(await readFile(cliPath)),
  probe_sha256: hash(await readFile(new URL(import.meta.url))),
})
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    )
  return value
}
function identity(raw: unknown, propertyId: string) {
  const properties = property(property(raw).properties)
  const field = Object.values(properties)
    .map(property)
    .find((item) => item.id === propertyId)
  const text = field?.rich_text
  return Array.isArray(text)
    ? text
        .map((item) => property(item).plain_text ?? property(property(item).text).content ?? "")
        .join("")
    : undefined
}
function responseContent(raw: unknown) {
  // The response envelope carries a new transport request ID for each successful read.
  // Keep it in raw evidence, but do not mistake it for changed page state.
  return Object.fromEntries(Object.entries(property(raw)).filter(([key]) => key !== "request_id"))
}
function capture(label: string) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const api = yield* Notion
      let sequence = 0
      const observed: Notion["Service"] = {
        ...api,
        request: (path, body, options) =>
          Effect.gen(function* () {
            const id = `${label}-${String(++sequence).padStart(3, "0")}`
            yield* Effect.promise(() =>
              save(`${id}-request.json`, {
                path,
                body,
                method: options?.method ?? (body === undefined ? "GET" : "POST"),
                started_at: new Date().toISOString(),
              }),
            )
            return yield* api.request(path, body, options).pipe(
              Effect.tap((response) =>
                Effect.promise(() =>
                  save(`${id}-response.json`, { received_at: new Date().toISOString(), response }),
                ),
              ),
              Effect.tapError((error) =>
                Effect.promise(() =>
                  save(`${id}-error.json`, { observed_at: new Date().toISOString(), error }),
                ),
              ),
            )
          }),
      }
      const data = yield* Effect.gen(function* () {
        const guarded = yield* Notion
        const library = yield* loadSharedLibrary(fixture.entry)
        const pages = []
        for (const [key, id] of Object.entries(fixture.pages).sort(([a], [b]) =>
          a.localeCompare(b),
        )) {
          const raw = yield* guarded.request(`v1/pages/${id}`)
          const table = key === "main" ? library.skills : library.files
          const field = table.property_ids[key === "main" ? "Skill ID" : "File ID"]
          if (
            !field ||
            property(raw).id !== id ||
            property(property(raw).parent).data_source_id !== table.data_source_id ||
            identity(raw, field) !== `${fixture.fixture_id}:${Buffer.from(key).toString("hex")}`
          )
            throw Error(`Owned receipt identity or parent mismatch for ${key}.`)
          const markdown = yield* guarded.request(`v1/pages/${id}/markdown?markdown_version=v2`)
          const body = property(markdown).markdown
          const unknownBlocks = property(markdown).unknown_block_ids
          if (
            typeof body !== "string" ||
            property(markdown).truncated !== false ||
            !Array.isArray(unknownBlocks) ||
            unknownBlocks.length !== 0
          )
            throw Error(`Complete markdown was not observed for ${key}.`)
          pages.push({ key, id, metadata: raw, markdown, body_sha256: hash(body) })
        }
        const records: unknown[] = []
        const cursors = new Set<string>()
        let cursor: string | undefined
        do {
          const raw = yield* guarded.request(
            `v1/data_sources/${library.records.data_source_id}/query`,
            {
              page_size: 100,
              filter: {
                property: library.records.property_ids.Skill,
                relation: { contains: target },
              },
              ...(cursor ? { start_cursor: cursor } : {}),
            },
          )
          const page = decode(listSchema(Schema.Unknown), raw)
          records.push(...page.results)
          if (page.has_more && typeof page.next_cursor !== "string")
            throw Error("Records pagination was incomplete.")
          cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined
          if (cursor !== undefined) {
            if (cursors.has(cursor)) throw Error("Records pagination repeated a cursor.")
            cursors.add(cursor)
          }
        } while (cursor)
        records.sort((a, b) => String(property(a).id).localeCompare(String(property(b).id)))
        return { library, pages, records }
      }).pipe(withReadOnlyNotion, Effect.provideService(Notion, observed))
      const result = {
        captured_at: new Date().toISOString(),
        data,
        sha256: hash(
          JSON.stringify(
            canonical({
              ...data,
              pages: data.pages.map((page) => ({
                ...page,
                metadata: responseContent(page.metadata),
                markdown: responseContent(page.markdown),
              })),
            }),
          ),
        ),
        raw_response_sha256: hash(JSON.stringify(canonical(data))),
        comparison_excludes: ["pages[*].metadata.request_id", "pages[*].markdown.request_id"],
        request_metrics: api.requestMetrics?.(),
      }
      yield* Effect.promise(() => save(`${label}.json`, result))
      return result
    }).pipe(Effect.provide(live)),
  )
}
async function command(label: string, observe: boolean) {
  const argv = [
    resolve(cliPath!),
    "ctl",
    "library",
    "state",
    target!,
    "--entry",
    fixture.entry,
    ...(observe ? ["--observe"] : []),
  ]
  const started = new Date().toISOString()
  await save(`${label}-argv.json`, { executable: process.execPath, argv, started_at: started })
  const child = spawn(process.execPath, argv, { env, stdio: ["ignore", "pipe", "pipe"] })
  let stdout = "",
    stderr = ""
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8")
  })
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8")
  })
  const result = await new Promise<{ exit_code: number | null; signal: NodeJS.Signals | null }>(
    (resolveChild, reject) => {
      child.once("error", reject)
      child.once("close", (exit_code, signal) => resolveChild({ exit_code, signal }))
    },
  )
  await save(`${label}-process.json`, {
    ...result,
    started_at: started,
    finished_at: new Date().toISOString(),
    stdout,
    stderr,
  })
  if (result.exit_code !== 0)
    throw Error(`${label} failed; original process evidence was retained.`)
  const output: unknown = JSON.parse(stdout)
  await save(`${label}.json`, output)
  return property(output)
}
try {
  const before = await capture("before")
  if (before.data.records.length !== 0)
    throw Error("This acceptance case requires a fresh native fixture with zero Records facts.")
  const normal = await command("state-default", false)
  const observed = await command("state-observed", true)
  const repeated = await command("state-default-after", false)
  const after = await capture("after")
  const summaries = [normal, observed, repeated].map((output) => ({
    ok: output.ok,
    remote_writes: output.remote_writes,
    metadata_only: output.metadata_only,
    source: output.source,
    selected: output.selected,
    candidate: output.candidate,
    session: output.session,
    files: output.files,
    requests: property(output.request_metrics).requests,
  }))
  const remoteWrites = summaries.map((output) => property(output.requests).notion_write)
  const nativeStatesExpected = summaries.every(
    (output, index) =>
      property(output.source).kind === "unconfigured" &&
      property(output.selected).kind === "none" &&
      Array.isArray(output.files) &&
      output.files.length === Object.keys(fixture.pages).length &&
      output.files.every(
        (file) =>
          property(property(file).resolution).kind === "uninitialized" &&
          property(property(file).customization).kind === "unknown" &&
          property(property(property(file).display).observation).kind ===
            (index === 1 ? "observed" : "unobserved"),
      ),
  )
  const result = {
    evidence_kind: "real_notion_native_fixture_cli_readonly",
    fixture,
    fixture_metadata_and_bodies_unchanged: before.sha256 === after.sha256,
    before_sha256: before.sha256,
    after_sha256: after.sha256,
    before_record_count: before.data.records.length,
    after_record_count: after.data.records.length,
    native_states_match_expected: nativeStatesExpected,
    command_request_write_counts: remoteWrites,
    all_command_remote_writes_zero: summaries.every(
      (output, index) => output.remote_writes === 0 && remoteWrites[index] === 0,
    ),
    snapshots_remote_writes_zero:
      before.request_metrics?.requests.notion_write === 0 &&
      after.request_metrics?.requests.notion_write === 0,
    no_human_ui_claim: true,
    no_second_machine_claim: true,
    mixed_c2_c1_n1_coverage: false,
    command_states: summaries,
  }
  await save("summary.json", result)
  if (
    !result.fixture_metadata_and_bodies_unchanged ||
    !result.all_command_remote_writes_zero ||
    !result.snapshots_remote_writes_zero ||
    result.after_record_count !== 0 ||
    !nativeStatesExpected
  )
    throw Error("Read-only invariants did not hold; preserve the evidence without repair.")
  console.log(
    JSON.stringify({
      ok: true,
      run,
      fixture_metadata_and_bodies_unchanged: result.fixture_metadata_and_bodies_unchanged,
      command_request_write_counts: remoteWrites,
      before_record_count: result.before_record_count,
      after_record_count: result.after_record_count,
      mixed_c2_c1_n1_coverage: false,
    }),
  )
} catch (error) {
  await save("failure.json", {
    observed_at: new Date().toISOString(),
    error: error instanceof Error ? { name: error.name, message: error.message } : error,
  })
  throw error
}
