import { ByteSize, Crypto, Effect, FileSystem, Option, Path, PlatformError } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { homedir } from "node:os"
import type { BigIntStats } from "node:fs"
import type { BuiltinInfo } from "./builtin.ts"
import { lstatNoFollow } from "./local-locks.ts"
import { fail, property, SkillsError } from "./model.ts"
import { MANIFEST } from "./portable.ts"
import { normalizePath } from "./ref.ts"

export const BUILTIN_INSTALL_RECEIPT = ".ntn-builtin-install.json"
export interface BuiltinInstallFile {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}
export interface BuiltinInstallReceipt {
  readonly format: "ntn-skills-builtin-install"
  readonly version: 2
  readonly id: string
  readonly data_dir: string
  readonly path: string
  readonly package_version: string
  readonly content_id: string
  readonly files: readonly BuiltinInstallFile[]
}
export interface BuiltinDistribution {
  readonly agent_dir: string
  readonly path: string
  readonly state: "linked" | "missing" | "conflict" | "interrupted"
  readonly reason?: string
}
export type BuiltinInstallationState =
  | "not_installed"
  | "current"
  | "update_available"
  | "modified"
  | "unmanaged"
  | "interrupted"
export interface BuiltinInstallation {
  readonly state: BuiltinInstallationState
  readonly path: string
  readonly data_dir: string
  readonly distributions: readonly BuiltinDistribution[]
  readonly distribution_error?: { readonly code: string; readonly message: string }
  readonly available_content_id: string
  readonly installed_content_id?: string
  readonly installed_package_version?: string
  readonly reload_required: boolean
  readonly changed_paths?: readonly string[]
  readonly journal_path?: string
  readonly retained_paths?: readonly string[]
  readonly reason?: string
}
export interface BuiltinInstallBoundary {
  readonly kind: "stage" | "retain" | "publish" | "trash"
  readonly path: string
  readonly operation_id: string
}
export interface BuiltinInstallOptions {
  readonly dataDir?: string
  readonly homeDir?: string
  /** Production always uses system Trash. Tests retain their own scratch trees. */
  readonly trash?: (location: string) => Effect.Effect<void, SkillsError>
  /** Runs before the destination guard, including recovery. */
  readonly beforeBoundary?: (boundary: BuiltinInstallBoundary) => Effect.Effect<void, SkillsError>
}
export type Node = {
  path: string
  kind: "directory" | "file" | "link" | "other"
  dev: string
  ino: string
  bytes?: number
  sha256?: string
  link?: string
}
export type Tree = { nodes: Node[]; receipt?: BuiltinInstallReceipt }
export type Layout = { agent: string; target: string; state: string; transactions: string }
export type Journal = {
  format: "ntn-skills-builtin-transaction"
  version: 1
  operation_id: string
  operation: "install" | "update"
  receipt: BuiltinInstallReceipt
  previous_proof?: string
}
export type Pending = { directory: string; journal?: Journal; reason?: string }
export const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
export const safeError = (error: unknown): SkillsError => {
  if (error instanceof SkillsError) return error
  const cause = PlatformError.isPlatformError(error) ? error.reason.cause : error
  return fail(
    "BUILTIN_IO_ERROR",
    "The local built-in operation failed; retained bytes are preserved.",
    {
      syscall_code: property(cause).code,
    },
  )
}
export const lstat = (location: string) => lstatNoFollow(location).pipe(Effect.mapError(safeError))
export const inode = (stat: { dev: bigint; ino: bigint }) => `${stat.dev}:${stat.ino}`
export const digest = (bytes: string | Uint8Array) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto
    const hash = yield* crypto.digest(
      "SHA-256",
      typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes,
    )
    return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("")
  }).pipe(Effect.mapError(safeError))
export const expandHome = (input: string, home: string) =>
  input === "~" ? home : input.startsWith("~/") ? `${home}/${input.slice(2)}` : input

/** Resolve the data location without reading or creating the filesystem. */
export const resolveBuiltinDataDir = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  home = env.HOME?.trim() || homedir(),
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const selected =
      env.NTN_SKILLS_DATA_HOME?.trim() ||
      path.join(
        expandHome(env.XDG_DATA_HOME?.trim() || path.join(home, ".local/share"), home),
        "ntn-skills",
      )
    return path.resolve(expandHome(selected, home))
  })

/** Resolve existing profile aliases without creating directories during observation. */
export const canonicalProfile = (
  input: string,
): Effect.Effect<string, SkillsError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    if (!input.trim())
      return yield* Effect.fail(fail("INVALID_ARGUMENT", "A directory must not be empty."))
    const absolute = path.resolve(expandHome(input, process.env.HOME?.trim() || homedir()))
    if (yield* lstat(absolute)) {
      const canonical = yield* fs.realPath(absolute)
      if ((yield* fs.stat(canonical)).type !== "Directory")
        return yield* Effect.fail(
          fail("INVALID_ARGUMENT", "--agent-dir must resolve to a directory."),
        )
      return canonical
    }
    return path.join(yield* canonicalProfile(path.dirname(absolute)), path.basename(absolute))
  }).pipe(Effect.mapError(safeError))

export const layout = (agent: string, info: BuiltinInfo): Effect.Effect<Layout, never, Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    return {
      agent,
      target: path.join(agent, "skills", info.name),
      state: path.join(agent, ".ntn-skills"),
      transactions: path.join(agent, ".ntn-skills", "builtin", info.name),
    }
  })
export const builtinLocations = (
  info: BuiltinInfo,
  agentDirs: string | readonly string[] | undefined,
  options: BuiltinInstallOptions,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const home = options.homeDir || process.env.HOME?.trim() || homedir()
    const data = yield* canonicalProfile(
      expandHome(options.dataDir || (yield* resolveBuiltinDataDir(process.env, home)), home),
    )
    const explicit = yield* Effect.forEach(
      typeof agentDirs === "string" ? [agentDirs] : agentDirs || [],
      (directory) => canonicalProfile(expandHome(directory, home)),
    )
    const agents = [...new Set([yield* canonicalProfile(path.join(home, ".agents")), ...explicit])]
    if (agents.includes(data))
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "An agent directory cannot be the central data directory."),
      )
    return { locations: yield* layout(data, info), agents, explicit: new Set(explicit) }
  })
export const ordinaryDirectory = (location: string, create = false) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    let stat = yield* lstat(location)
    if (!stat && create) {
      yield* fs
        .makeDirectory(location, { mode: 0o700 })
        .pipe(
          Effect.catch((error) =>
            error.reason._tag === "AlreadyExists" ? Effect.void : Effect.fail(error),
          ),
        )
      stat = yield* lstat(location)
    }
    if (stat && !stat.isDirectory())
      return yield* Effect.fail(
        fail("BUILTIN_PATH_CHANGED", "A managed parent must be an ordinary directory.", {
          path: location,
        }),
      )
    return stat
  }).pipe(Effect.mapError(safeError))

/** Each inspection owns its no-follow handle; Scope closes on failure and interruption. */
export const readRegular = (location: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const before = yield* lstat(location)
      if (!before?.isFile()) return undefined
      const handle = yield* fs.open(location, { flag: "r", noFollow: true })
      const opened = yield* handle.stat
      if (
        opened.dev !== BigInt.asUintN(64, before.dev) ||
        Option.getOrUndefined(opened.ino) !== BigInt.asUintN(64, before.ino)
      )
        return yield* Effect.fail(
          fail("BUILTIN_PATH_CHANGED", "A file changed while it was being inspected.", {
            path: location,
          }),
        )
      const size = Number(ByteSize.toBigInt(opened.size))
      if (!Number.isSafeInteger(size))
        return yield* Effect.fail(
          fail("BUILTIN_PATH_CHANGED", "The inspected file is too large.", { path: location }),
        )
      const bytes = new Uint8Array(size)
      let offset = 0
      while (offset < bytes.length) {
        const count = yield* handle.read(bytes.subarray(offset))
        if (!count) break
        offset += count
      }
      const extra = yield* handle.readAlloc(1)
      const after = yield* handle.stat
      const linked = yield* lstat(location)
      if (
        !linked?.isFile() ||
        inode(before) !== inode(linked) ||
        before.size !== linked.size ||
        before.mtimeNs !== linked.mtimeNs ||
        before.ctimeNs !== linked.ctimeNs ||
        opened.size !== after.size ||
        offset !== bytes.length ||
        Option.isSome(extra)
      )
        return yield* Effect.fail(
          fail("BUILTIN_PATH_CHANGED", "An inspected file changed identity or contents.", {
            path: location,
          }),
        )
      return bytes
    }),
  ).pipe(Effect.mapError(safeError))

export function validReceipt(
  value: unknown,
  info: Pick<BuiltinInfo, "id">,
  locations: Layout,
): value is BuiltinInstallReceipt {
  const raw = property(value)
  if (
    raw.format !== "ntn-skills-builtin-install" ||
    raw.version !== 2 ||
    raw.data_dir !== locations.agent ||
    raw.id !== info.id ||
    raw.path !== locations.target ||
    typeof raw.package_version !== "string" ||
    !raw.package_version ||
    typeof raw.content_id !== "string" ||
    !/^[a-f\d]{64}$/.test(raw.content_id) ||
    !Array.isArray(raw.files)
  )
    return false
  const seen = new Set<string>()
  for (const value of raw.files) {
    const file = property(value)
    if (
      typeof file.path !== "string" ||
      !file.path ||
      file.path === BUILTIN_INSTALL_RECEIPT ||
      seen.has(file.path) ||
      typeof file.bytes !== "number" ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      typeof file.sha256 !== "string" ||
      !/^[a-f\d]{64}$/.test(file.sha256)
    )
      return false
    try {
      if (normalizePath(file.path) !== file.path) return false
    } catch {
      return false
    }
    seen.add(file.path)
  }
  return seen.has("SKILL.md") && seen.has(MANIFEST)
}
const unchanged = (before: BigIntStats, after: BigIntStats | undefined) =>
  !!after &&
  inode(before) === inode(after) &&
  before.size === after.size &&
  before.mtimeNs === after.mtimeNs &&
  before.ctimeNs === after.ctimeNs
export const inspect = (
  location: string,
  info: Pick<BuiltinInfo, "id">,
  locations: Layout,
): Effect.Effect<
  Tree | undefined,
  SkillsError,
  FileSystem.FileSystem | Path.Path | Crypto.Crypto
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    if (!(yield* lstat(location))) return undefined
    const nodes: Node[] = []
    let receipt: BuiltinInstallReceipt | undefined
    const walk = (
      relative: string,
    ): Effect.Effect<void, SkillsError, FileSystem.FileSystem | Path.Path | Crypto.Crypto> =>
      Effect.gen(function* () {
        const absolute = relative ? path.join(location, relative) : location
        const stat = yield* lstat(absolute)
        if (!stat)
          return yield* Effect.fail(
            fail("BUILTIN_PATH_CHANGED", "An inspected entry disappeared.", { path: absolute }),
          )
        const node: Node = {
          path: relative,
          kind: stat.isDirectory()
            ? "directory"
            : stat.isFile()
              ? "file"
              : stat.isSymbolicLink()
                ? "link"
                : "other",
          dev: String(stat.dev),
          ino: String(stat.ino),
        }
        if (node.kind === "file") {
          const bytes = yield* readRegular(absolute)
          if (!bytes || !unchanged(stat, yield* lstat(absolute)))
            return yield* Effect.fail(
              fail("BUILTIN_PATH_CHANGED", "An inspected file changed identity or contents.", {
                path: absolute,
              }),
            )
          node.bytes = bytes.length
          node.sha256 = yield* digest(bytes)
          if (relative === BUILTIN_INSTALL_RECEIPT) {
            try {
              const raw: unknown = JSON.parse(new TextDecoder().decode(bytes))
              if (validReceipt(raw, info, locations)) receipt = raw
            } catch {
              /* Invalid metadata grants no authority. */
            }
          }
        } else if (node.kind === "link") {
          node.link = yield* fs.readLink(absolute)
          const after = yield* lstat(absolute)
          if (!after?.isSymbolicLink() || inode(stat) !== inode(after))
            return yield* Effect.fail(
              fail("BUILTIN_PATH_CHANGED", "An inspected symbolic link changed identity.", {
                path: absolute,
              }),
            )
        }
        nodes.push(node)
        if (node.kind === "directory") {
          for (const name of (yield* fs.readDirectory(absolute)).sort())
            yield* walk(relative ? `${relative}/${name}` : name)
          const after = yield* lstat(absolute)
          if (!after?.isDirectory() || !unchanged(stat, after))
            return yield* Effect.fail(
              fail("BUILTIN_PATH_CHANGED", "An inspected directory changed identity.", {
                path: absolute,
              }),
            )
        }
      }).pipe(Effect.mapError(safeError))
    yield* walk("")
    return { nodes, receipt }
  }).pipe(Effect.mapError(safeError))
export const proof = (tree: Tree) => digest(JSON.stringify(tree.nodes))
export function changes(tree: Tree, receipt: BuiltinInstallReceipt): string[] {
  const expected = new Map<string, BuiltinInstallFile | undefined>(
    receipt.files.map((file) => [file.path, file]),
  )
  for (const file of receipt.files) {
    const parts = file.path.split("/")
    parts.pop()
    while (parts.length) {
      const parent = parts.join("/")
      if (!expected.has(parent)) expected.set(parent, undefined)
      parts.pop()
    }
  }
  const changed = new Set<string>()
  for (const node of tree.nodes) {
    if (!node.path || node.path === BUILTIN_INSTALL_RECEIPT) continue
    if (!expected.has(node.path)) changed.add(node.path)
    else {
      const file = expected.get(node.path)
      if (
        file
          ? node.kind !== "file" || node.bytes !== file.bytes || node.sha256 !== file.sha256
          : node.kind !== "directory"
      )
        changed.add(node.path)
      expected.delete(node.path)
    }
  }
  for (const relative of expected.keys()) changed.add(relative)
  return [...changed].sort()
}
export const clean = (tree: Tree | undefined, receipt: BuiltinInstallReceipt) =>
  tree?.nodes[0]?.kind === "directory" &&
  equal(tree.receipt, receipt) &&
  changes(tree, receipt).length === 0
export const record = (
  directory: string,
  operationId: string,
  phase: string,
  details: object = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* fs.writeFileString(
      path.join(directory, `${phase}.json`),
      JSON.stringify({
        format: "ntn-skills-builtin-boundary",
        version: 1,
        operation_id: operationId,
        phase,
        ...details,
      }) + "\n",
      { flag: "wx", mode: 0o600 },
    )
  }).pipe(Effect.mapError(safeError))
export const recorded = (directory: string, operationId: string, phase: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const location = path.join(directory, `${phase}.json`)
    if (!(yield* lstat(location))) return false
    const bytes = yield* readRegular(location)
    if (bytes) {
      try {
        const raw = property(JSON.parse(new TextDecoder().decode(bytes)))
        if (
          raw.format === "ntn-skills-builtin-boundary" &&
          raw.version === 1 &&
          raw.operation_id === operationId &&
          raw.phase === phase
        )
          return true
      } catch {
        /* Invalid receipts fence recovery. */
      }
    }
    return yield* Effect.fail(
      fail("BUILTIN_INTERRUPTED", "A transaction boundary receipt is invalid.", { path: location }),
    )
  })
export const pendingTransactions = (locations: Layout, info: BuiltinInfo) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const parents = yield* Effect.gen(function* () {
      for (const directory of [
        locations.state,
        path.join(locations.state, "builtin"),
        locations.transactions,
      ])
        if (!(yield* ordinaryDirectory(directory))) return "absent" as const
      return "present" as const
    }).pipe(Effect.catch(() => Effect.succeed("unsafe" as const)))
    if (parents === "absent") return [] as Pending[]
    if (parents === "unsafe")
      return [
        { directory: locations.transactions, reason: "unsafe_management_directory" },
      ] as Pending[]
    const pending: Pending[] = []
    for (const name of (yield* fs.readDirectory(locations.transactions)).sort()) {
      const directory = path.join(locations.transactions, name)
      const journal = yield* Effect.gen(function* () {
        if (!(yield* ordinaryDirectory(directory))) return undefined
        const bytes = yield* readRegular(path.join(directory, "journal.json"))
        const raw = yield* Effect.try(() =>
          bytes ? property(JSON.parse(new TextDecoder().decode(bytes))) : {},
        )
        if (
          /^[a-f\d-]{36}$/.test(name) &&
          raw.format === "ntn-skills-builtin-transaction" &&
          raw.version === 1 &&
          raw.operation_id === name &&
          (raw.operation === "install" || raw.operation === "update") &&
          validReceipt(raw.receipt, info, locations) &&
          (raw.previous_proof === undefined ||
            (typeof raw.previous_proof === "string" && /^[a-f\d]{64}$/.test(raw.previous_proof)))
        )
          return {
            format: "ntn-skills-builtin-transaction",
            version: 1,
            operation_id: name,
            operation: raw.operation,
            receipt: raw.receipt,
            ...(typeof raw.previous_proof === "string"
              ? { previous_proof: raw.previous_proof }
              : {}),
          } as Journal
        return undefined
      }).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!journal) {
        pending.push({ directory, reason: "invalid_or_incomplete_journal" })
        continue
      }
      const result = yield* Effect.gen(function* () {
        const completed = yield* recorded(directory, name, "completed")
        const rolledBack = yield* recorded(directory, name, "rolled_back")
        const notApplied = yield* recorded(directory, name, "not_applied")
        const staged = yield* recorded(directory, name, "staged")
        const retained = yield* recorded(directory, name, "retained")
        const published = yield* recorded(directory, name, "published")
        const trashStarted = yield* recorded(directory, name, "trash_started")
        const trashed = yield* recorded(directory, name, "trashed")
        if (
          [completed, rolledBack, notApplied].filter(Boolean).length > 1 ||
          ((completed || rolledBack || notApplied) &&
            (yield* lstat(path.join(directory, "previous")))) ||
          (completed &&
            ((yield* lstat(path.join(directory, "staged"))) ||
              !staged ||
              !published ||
              (journal.previous_proof !== undefined &&
                (!retained || !trashStarted || !trashed)))) ||
          (rolledBack && (!staged || published || trashStarted || trashed)) ||
          (notApplied && (retained || published || trashStarted || trashed))
        )
          return { directory, reason: "inconsistent_terminal_receipt" } as Pending
        if (!completed && !rolledBack && !notApplied) return { directory, journal } as Pending
        return undefined
      }).pipe(
        Effect.catch(() =>
          Effect.succeed({ directory, reason: "invalid_boundary_receipt" } as Pending),
        ),
      )
      if (result) pending.push(result)
    }
    return pending
  }).pipe(Effect.mapError(safeError))
export function installation(
  info: BuiltinInfo,
  locations: Layout,
  tree: Tree | undefined,
  pending: readonly Pending[] = [],
): BuiltinInstallation {
  const base = {
    path: locations.target,
    data_dir: locations.agent,
    distributions: [] as readonly BuiltinDistribution[],
    available_content_id: info.content_id,
    ...(tree?.receipt
      ? {
          installed_content_id: tree.receipt.content_id,
          installed_package_version: tree.receipt.package_version,
        }
      : {}),
  }
  if (pending.length)
    return {
      ...base,
      state: "interrupted",
      reload_required: true,
      journal_path: `${pending[0]!.directory}/journal.json`,
      retained_paths: pending.flatMap((entry) => [
        `${entry.directory}/staged`,
        `${entry.directory}/previous`,
      ]),
      ...(pending[0]!.reason ? { reason: pending[0]!.reason } : {}),
    }
  if (!tree) return { ...base, state: "not_installed", reload_required: false }
  if (tree.nodes[0]?.kind !== "directory" || !tree.receipt)
    return { ...base, state: "unmanaged", reload_required: false }
  const changed = changes(tree, tree.receipt)
  return {
    ...base,
    state: changed.length
      ? "modified"
      : tree.receipt.content_id === info.content_id
        ? "current"
        : "update_available",
    reload_required: false,
    ...(changed.length ? { changed_paths: changed } : {}),
  }
}
export const observe = (info: BuiltinInfo, locations: Layout) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const pending = yield* pendingTransactions(locations, info)
    const skills = yield* ordinaryDirectory(path.dirname(locations.target))
    const tree = skills ? yield* inspect(locations.target, info, locations) : undefined
    return { tree, pending, installation: installation(info, locations, tree, pending) }
  })
export const trashCapability = (options: BuiltinInstallOptions) =>
  Effect.gen(function* () {
    if (options.trash) return
    const unavailable = fail(
      "RETENTION_UNAVAILABLE",
      "The /usr/bin/trash capability is required before replacement.",
    )
    if (process.platform !== "darwin") return yield* Effect.fail(unavailable)
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const code = yield* spawner
      .exitCode(
        ChildProcess.make("/bin/test", ["-x", "/usr/bin/trash"], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      )
      .pipe(Effect.mapError(() => unavailable))
    if (code !== 0) return yield* Effect.fail(unavailable)
  })
