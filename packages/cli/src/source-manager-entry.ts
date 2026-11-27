import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, readdir, readlink, realpath } from "node:fs/promises"
import { hostname, homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { Schema } from "effect"
import { fail, SkillsError } from "../../core/src/model.ts"
import { SourceMaterializationRequestSchema } from "../../core/src/shared-source-materialization-model.ts"
import { runBoundSourceManagerCommand } from "./source-manager-runtime.ts"
import { readSourceManagerJson } from "./source-manager-transport.ts"

const Positive = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))
const Budget = Schema.Struct({ max_requests: Positive, max_bytes: Positive, timeout_ms: Positive })
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const ServerConfig = Schema.Struct({
  version: Schema.Literal(2),
  host: Schema.Struct({ name: Schema.Literal("mini"), hostname: Schema.String }),
  library: Schema.String,
  sources: Schema.Array(Schema.String),
  projection: Schema.Literals(["markdown", "none"]),
  store: Schema.Struct({
    home: Schema.String,
    config_home: Schema.String,
    cache_home: Schema.String,
  }),
  request_scheduler_root: Schema.String,
  notion_api_origin: Schema.optional(Schema.String),
  generation: Schema.Struct({
    root: Schema.String,
    inventory_sha256: Hash,
    cli_entry: Schema.String,
    runtime: Schema.String,
    runtime_sha256: Hash,
  }),
  git: Schema.Struct({
    executable: Schema.String,
    sha256: Hash,
    http_proxy: Schema.optional(Schema.String),
  }),
  credentials: Schema.Struct({ path: Schema.String, notion_token_sha256: Hash }),
  artifacts: Schema.Unknown,
  budgets: Schema.Struct({ changed: Budget, full: Budget }),
})
const SyncInput = Schema.Struct({
  library: Schema.String,
  source_ids: Schema.Array(Schema.String),
  manager_id: Schema.String,
  execution_id: Schema.String,
  mode: Schema.optional(Schema.Literals(["changed", "full"])),
  projection: Schema.optional(Schema.Literals(["none", "markdown"])),
  limits: Schema.optional(
    Schema.Struct({
      requests: Schema.optional(Positive),
      bytes: Schema.optional(Positive),
      duration_ms: Schema.optional(Positive),
    }),
  ),
})
const Envelope = Schema.Struct({
  version: Schema.Literal(1),
  request_id: Schema.String,
  execution_id: Hash,
  library: Schema.String,
  command: Schema.Union([
    Schema.Struct({
      version: Schema.Literal(1),
      action: Schema.Literal("materialize"),
      input: SourceMaterializationRequestSchema,
    }),
    Schema.Struct({ version: Schema.Literal(1), action: Schema.Literal("sync"), input: SyncInput }),
  ]),
})
const Credentials = Schema.Struct({
  NOTION_API_TOKEN: Schema.String,
  GITHUB_TOKEN: Schema.optional(Schema.String),
  GH_TOKEN: Schema.optional(Schema.String),
})
const digest = (value: string) => createHash("sha256").update(value).digest("hex")
async function fileDigest(path: string) {
  const hash = createHash("sha256")
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return hash.digest("hex")
}
async function canonical(path: string, directory: boolean) {
  if (!isAbsolute(path) || resolve(path) !== path || (await realpath(path)) !== path)
    throw fail("SOURCE_MANAGER_CONFIG_INVALID", "A manager path is not canonical.")
  const info = await lstat(path)
  if (info.uid !== process.getuid?.() || (directory ? !info.isDirectory() : !info.isFile()))
    throw fail("SOURCE_MANAGER_CONFIG_INVALID", "A manager path has the wrong owner or kind.")
  return info
}
async function inventory(root: string) {
  const files: (
    | { path: string; sha256: string; executable: boolean }
    | { path: string; link: string }
  )[] = []
  const walk = async (name: string): Promise<void> => {
    const path = join(root, name),
      info = await lstat(path)
    if (info.isSymbolicLink()) {
      const target = relative(root, await realpath(path))
      if (!target || target === ".." || target.startsWith("../") || isAbsolute(target))
        throw fail(
          "SOURCE_MANAGER_GENERATION_CHANGED",
          "A manager generation link escapes its installation.",
        )
      files.push({ path: name, link: await readlink(path) })
    } else if (info.isDirectory()) {
      for (const child of (await readdir(path)).sort())
        await walk(name ? `${name}/${child}` : child)
    } else if (info.isFile())
      files.push({
        path: name,
        sha256: await fileDigest(path),
        executable: Boolean(info.mode & 0o111),
      })
    else
      throw fail(
        "SOURCE_MANAGER_GENERATION_CHANGED",
        "The manager generation contains an unsupported file.",
      )
  }
  await walk("")
  return digest(JSON.stringify(files))
}
async function readRequest() {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.byteLength
    if (size > 65_536) throw fail("INVALID_ARGUMENT", "The manager request exceeds 64 KiB.")
    chunks.push(bytes)
  }
  return Schema.decodeUnknownSync(Envelope)(JSON.parse(Buffer.concat(chunks).toString("utf8")), {
    onExcessProperty: "error",
  })
}

/** One fixed-command request. The installed v2 scheduler binding owns credentials,
 * generation and recovery Store. No input can override those bindings. */
export async function runSourceManagerEntry(configPath: string): Promise<void> {
  const config = Schema.decodeUnknownSync(ServerConfig)(await readSourceManagerJson(configPath), {
    onExcessProperty: "error",
  })
  if (hostname().toLowerCase() !== config.host.hostname.toLowerCase())
    throw fail("SOURCE_MANAGER_WRONG_HOST", "This host does not own the configured writer.")
  const request = await readRequest()
  const response = {
    version: 1,
    request_id: request.request_id,
    execution_id: config.generation.inventory_sha256,
    library: config.library,
  }
  // Losing an SSH channel must not intentionally terminate accepted business work.
  const ignoreHangup = () => {}
  const ignoreOutputClosure = () => {}
  process.on("SIGHUP", ignoreHangup)
  process.stdout.on("error", ignoreOutputClosure)
  try {
    if (
      request.execution_id !== config.generation.inventory_sha256 ||
      request.library !== config.library ||
      request.command.input.library !== config.library
    )
      throw fail(
        "SOURCE_MANAGER_SCOPE_MISMATCH",
        "The requested manager generation or Library differs from its binding.",
      )
    if (
      request.command.action === "materialize" &&
      request.command.input.request_id !== request.request_id
    )
      throw fail(
        "SOURCE_MANAGER_SCOPE_MISMATCH",
        "The materialization identity differs from its request envelope.",
      )
    const sources =
      request.command.action === "materialize"
        ? [request.command.input.target.source_id]
        : request.command.input.source_ids
    if (sources.some((source) => !config.sources.includes(source)))
      throw fail(
        "SOURCE_MANAGER_SCOPE_MISMATCH",
        "The Source is outside this manager's explicit scope.",
      )
    for (const root of [
      ...Object.values(config.store),
      config.request_scheduler_root,
      config.generation.root,
    ])
      await canonical(root, true)
    const database = await canonical(join(config.store.home, "state.sqlite"), false)
    if (database.size === 0)
      throw fail("SOURCE_MANAGER_STORE_UNAVAILABLE", "The original manager Store is empty.")
    await canonical(config.generation.runtime, false)
    await canonical(config.git.executable, false)
    const entry = resolve(config.generation.root, config.generation.cli_entry)
    const relativeEntry = relative(config.generation.root, entry)
    if (
      !relativeEntry ||
      relativeEntry.startsWith("../") ||
      isAbsolute(relativeEntry) ||
      (await realpath(process.argv[1] ?? "")) !== (await realpath(entry)) ||
      (await realpath(process.execPath)) !== config.generation.runtime ||
      (await fileDigest(config.generation.runtime)) !== config.generation.runtime_sha256 ||
      (await fileDigest(config.git.executable)) !== config.git.sha256 ||
      (await inventory(config.generation.root)) !== config.generation.inventory_sha256
    )
      throw fail(
        "SOURCE_MANAGER_GENERATION_CHANGED",
        "The running manager does not match its accepted complete installation.",
      )
    const credentials = Schema.decodeUnknownSync(Credentials)(
      await readSourceManagerJson(config.credentials.path),
      { onExcessProperty: "error" },
    )
    if (
      !credentials.NOTION_API_TOKEN.trim() ||
      digest(credentials.NOTION_API_TOKEN) !== config.credentials.notion_token_sha256
    )
      throw fail("SOURCE_MANAGER_CREDENTIAL_CHANGED", "The manager credential identity changed.")
    if (config.git.http_proxy !== undefined && config.git.http_proxy !== "") {
      const proxy = new URL(config.git.http_proxy)
      if (!["http:", "https:"].includes(proxy.protocol) || proxy.origin !== config.git.http_proxy)
        throw fail("SOURCE_MANAGER_CONFIG_INVALID", "The manager Git proxy is invalid.")
    }
    if (config.notion_api_origin !== undefined) {
      const origin = new URL(config.notion_api_origin)
      const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)
      if (
        origin.origin !== config.notion_api_origin ||
        (origin.protocol !== "https:" && !(origin.protocol === "http:" && loopback))
      )
        throw fail("SOURCE_MANAGER_CONFIG_INVALID", "The manager Notion origin is invalid.")
    }
    const env = {
      HOME: homedir(),
      PATH: `${dirname(config.git.executable)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      LANG: "en_US.UTF-8",
      NTN_SKILLS_HOME: config.store.home,
      NTN_SKILLS_CONFIG_HOME: config.store.config_home,
      NTN_SKILLS_CACHE_HOME: config.store.cache_home,
      NTN_SKILLS_SCHEDULER_ROOT: config.request_scheduler_root,
      ...(config.notion_api_origin === undefined
        ? {}
        : { NOTION_API_BASE_URL: config.notion_api_origin }),
      ...(config.git.http_proxy === undefined
        ? {}
        : {
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "http.proxy",
            GIT_CONFIG_VALUE_0: config.git.http_proxy,
          }),
      ...credentials,
    }
    const selectedBudget =
      config.budgets[
        request.command.action === "sync" ? (request.command.input.mode ?? "changed") : "changed"
      ]
    const limits = {
      requests: selectedBudget.max_requests,
      bytes: selectedBudget.max_bytes,
      duration_ms: selectedBudget.timeout_ms,
    }
    const command =
      request.command.action === "materialize"
        ? request.command
        : {
            ...request.command,
            input: {
              ...request.command.input,
              manager_id: "mini-upstream-sync",
              execution_id: config.generation.inventory_sha256,
              limits: {
                requests: Math.min(
                  request.command.input.limits?.requests ?? limits.requests,
                  limits.requests,
                ),
                bytes: Math.min(request.command.input.limits?.bytes ?? limits.bytes, limits.bytes),
                duration_ms: Math.min(
                  request.command.input.limits?.duration_ms ?? limits.duration_ms,
                  limits.duration_ms,
                ),
              },
            },
          }
    const result = await runBoundSourceManagerCommand(
      command,
      { env },
      { library_id: config.library, store_root: config.store.home, source_ids: config.sources },
      limits,
    )
    process.stdout.write(JSON.stringify({ ...response, ok: true, result }) + "\n")
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        ...response,
        ok: false,
        error:
          error instanceof SkillsError
            ? { code: error.code, message: error.message }
            : {
                code: "SOURCE_MANAGER_FAILED",
                message: "The configured manager could not complete this request.",
              },
      }) + "\n",
    )
  } finally {
    process.removeListener("SIGHUP", ignoreHangup)
    // Keep the output error handler until stream shutdown. EPIPE after a detached
    // caller must not turn a settled operation into an uncaught process failure.
  }
}
