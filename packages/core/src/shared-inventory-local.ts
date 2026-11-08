import { constants, type BigIntStats } from "node:fs"
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createHash } from "node:crypto"
import { parseDocument } from "yaml"
import { Effect } from "effect"
import { fail, property } from "./model.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import { sharedMarkdownReferences } from "./shared-file-references.ts"
import { sha256 } from "./store.ts"
import {
  INVENTORY_RULES,
  type InventoryFinding,
  type LocalInventoryEntity,
  type LocalInventoryFile,
  type LocalSkillInventory,
} from "./shared-inventory-model.ts"
import {
  localInventoryProvenance,
  inventoryCanonicalAssetId,
  type ProvenanceDocument,
} from "./shared-inventory-provenance.ts"
import { saveInventoryArtifact } from "./shared-inventory-store.ts"

const executeFile = promisify(execFile)
const within = (root: string, path: string) => {
  const value = relative(root, path)
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value))
}
const identity = (value: BigIntStats) =>
  [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs, value.mode].map(String).join(":")
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex")
const gitHash = (value: Uint8Array) =>
  createHash("sha1").update(`blob ${value.length}\0`).update(value).digest("hex")
const syscall = (value: unknown) => {
  const code = property(value).code
  return typeof code === "string" ? code : "IO_ERROR"
}
const io = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: (error) =>
      fail("LOCAL_INVENTORY_IO", "The exact local inventory object could not be read.", {
        syscall_code: syscall(error),
      }),
  })
const sensitiveName = (path: string) =>
  /(?:^|\/)(?:\.env(?:\..*)?|credentials(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|id_(?:rsa|ed25519)|\.npmrc|\.pypirc)$/iu.test(
    path,
  )
const secretPattern =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16}|secret_[A-Za-z0-9]{32,})\b/u

async function boundedFile(
  path: string,
  expected: BigIntStats,
  allowance: number,
  consumed: (bytes: number) => void,
) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true })
    if (identity(before) !== identity(expected))
      return { kind: "changed" as const, bytes: new Uint8Array() }
    const parts: Uint8Array[] = []
    let total = 0
    while (total <= allowance) {
      const buffer = new Uint8Array(Math.min(64 * 1024, allowance + 1 - total))
      if (!buffer.length) break
      const read = await handle.read(buffer, 0, buffer.length, null)
      if (!read.bytesRead) break
      parts.push(buffer.slice(0, read.bytesRead))
      total += read.bytesRead
      consumed(read.bytesRead)
    }
    if (total > allowance) return { kind: "budget_limited" as const, bytes: new Uint8Array() }
    const after = await handle.stat({ bigint: true })
    if (identity(before) !== identity(after) || BigInt(total) !== after.size)
      return { kind: "changed" as const, bytes: new Uint8Array() }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const part of parts) {
      bytes.set(part, offset)
      offset += part.length
    }
    return { kind: "verified" as const, bytes }
  } finally {
    await handle.close()
  }
}

export type ScanLocalSkillInventoryInput = {
  readonly roots: readonly string[]
  /** Revalidation may constrain previously observed roots to their frozen targets. */
  readonly expected_root_targets?: Readonly<Record<string, string>>
  readonly allow_targets?: readonly string[]
  readonly provenance_files?: readonly string[]
  readonly budget?: {
    readonly entries?: number
    readonly bytes?: number
    readonly duration_ms?: number
  }
}

/** Reads explicit files and Git metadata only. It never invokes Skill scripts,
 * modifies links, refreshes the Git index, or writes into a scanned root. */
export function scanLocalSkillInventory(input: ScanLocalSkillInventoryInput) {
  return Effect.gen(function* () {
    const started = Date.now(),
      monotonic = performance.now()
    const limits = {
      entries: input.budget?.entries ?? 50_000,
      bytes: input.budget?.bytes ?? 256 * 1024 * 1024,
      duration_ms: input.budget?.duration_ms ?? 120_000,
    }
    const validPath = (value: string) => isAbsolute(value) && !/[\0\r\n]/u.test(value)
    if (
      !input.roots.length ||
      [...input.roots, ...(input.allow_targets ?? []), ...(input.provenance_files ?? [])].some(
        (path) => !validPath(path),
      ) ||
      Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1)
    )
      return yield* Effect.fail(
        fail(
          "INVALID_ARGUMENT",
          "Inventory requires explicit absolute roots/allowed targets and positive finite budgets.",
        ),
      )
    const roots = [...new Set(input.roots.map((path) => resolve(path)))].sort()
    const allowTargets = [
      ...new Set((input.allow_targets ?? []).map((path) => resolve(path))),
    ].sort()
    const provenanceFiles = [
      ...new Set((input.provenance_files ?? []).map((path) => resolve(path))),
    ].sort()
    // A normal explicit directory can have a system ancestor alias (macOS
    // /var -> /private/var). Canonicalize that boundary without implicitly
    // approving a root that is itself an outward symlink.
    const rootEntries = new Map<string, string>()
    for (const root of roots) {
      const canonical = yield* io(async () =>
        (await lstat(root, { bigint: true })).isDirectory() ? realpath(root) : root,
      ).pipe(Effect.result)
      rootEntries.set(root, canonical._tag === "Success" ? canonical.success : root)
      const expected = input.expected_root_targets?.[root]
      if (expected !== undefined) {
        if (!validPath(expected))
          return yield* Effect.fail(
            fail("INVALID_ARGUMENT", "A frozen root target must be absolute."),
          )
        const observed = yield* io(() => realpath(root)).pipe(Effect.result)
        if (observed._tag === "Failure" || observed.success !== expected)
          return yield* Effect.fail(
            fail(
              "INVENTORY_REVIEW_STALE",
              "A previously observed logical root now resolves to another target.",
              { logical_path: root, expected_target: expected },
            ),
          )
      }
    }
    const canonicalTargets: string[] = []
    for (const target of allowTargets) {
      const canonical = yield* io(() => realpath(target)).pipe(Effect.result)
      canonicalTargets.push(canonical._tag === "Success" ? canonical.success : target)
    }
    const allowed = (path: string) =>
      [...rootEntries.values(), ...canonicalTargets].some((root) => within(root, path))
    const findings: InventoryFinding[] = []
    const aliases: LocalSkillInventory["aliases"][number][] = []
    const files = new Map<string, LocalInventoryFile>()
    const content = new Map<string, Uint8Array>()
    const contentIdentity = new Map<string, string>()
    const visited = new Map<string, string>()
    const directories = new Map<string, string>()
    let entries = 0,
      bytesRead = 0,
      limit: string | null = null
    const add = (
      code: string,
      path: string,
      details: unknown = null,
      severity: InventoryFinding["severity"] = "blocked",
    ) => findings.push({ code, path, details, severity })
    const timeRemaining = () => Math.max(0, limits.duration_ms - (performance.now() - monotonic))
    const queue = roots.map((path) => ({ logical: path, entry: rootEntries.get(path)! }))
    while (queue.length) {
      if (entries >= limits.entries || timeRemaining() <= 0) {
        limit = entries >= limits.entries ? "entries" : "duration"
        break
      }
      const item = queue.shift()!
      entries++
      const statResult = yield* io(() => lstat(item.entry, { bigint: true })).pipe(Effect.result)
      if (statResult._tag === "Failure") {
        add("LOCAL_ENTRY_UNAVAILABLE", item.logical, statResult.failure.details)
        continue
      }
      let stat = statResult.success,
        target = item.entry
      if (
        [...rootEntries.values()].includes(item.entry) &&
        !stat.isDirectory() &&
        !stat.isSymbolicLink()
      ) {
        add("ROOT_NOT_DIRECTORY", item.logical)
        continue
      }
      if (stat.isSymbolicLink()) {
        const link = yield* io(async () => ({
          text: await readlink(item.entry),
          target: await realpath(item.entry),
          after: await lstat(item.entry, { bigint: true }),
        })).pipe(Effect.result)
        if (link._tag === "Failure") {
          aliases.push({ logical_path: item.logical, real_path: null, boundary: "broken" })
          add("BROKEN_SYMLINK", item.logical)
          continue
        }
        target = link.success.target
        if (identity(link.success.after) !== identity(stat)) {
          add("SYMLINK_CHANGED", item.logical)
          continue
        }
        if (!allowed(target)) {
          aliases.push({ logical_path: item.logical, real_path: target, boundary: "outside_scope" })
          add("SYMLINK_OUTSIDE_SCOPE", item.logical, { target })
          continue
        }
        const resolved = yield* io(() => lstat(target, { bigint: true })).pipe(Effect.result)
        if (resolved._tag === "Failure") {
          add("LOCAL_TARGET_UNAVAILABLE", item.logical, resolved.failure.details)
          continue
        }
        stat = resolved.success
      }
      if (stat.isDirectory()) {
        if (basename(target) === ".git") {
          add("GIT_METADATA_BOUNDARY", item.logical, null, "review")
          continue
        }
        const key = `${stat.dev}:${stat.ino}`
        aliases.push({
          logical_path: item.logical,
          real_path: target,
          boundary: visited.has(key) ? "cycle_or_alias" : "allowed",
        })
        if (visited.has(key)) continue
        visited.set(key, target)
        directories.set(target, identity(stat))
        const names = yield* io(() => readdir(target)).pipe(Effect.result)
        if (names._tag === "Failure") {
          add("DIRECTORY_UNAVAILABLE", item.logical, names.failure.details)
          continue
        }
        for (const name of names.success.sort())
          queue.push({ logical: join(item.logical, name), entry: join(target, name) })
        continue
      }
      if (!stat.isFile()) {
        add("UNSUPPORTED_FILE_TYPE", item.logical)
        continue
      }
      if (target !== item.entry)
        aliases.push({ logical_path: item.logical, real_path: target, boundary: "allowed" })
      const known = content.get(target)
      let file: LocalInventoryFile
      const mode = (stat.mode & 0o111n) === 0n ? ("100644" as const) : ("100755" as const)
      const base = {
        path: item.entry,
        real_path: target,
        bytes: Number(stat.size),
        mode,
        sha256: null,
        git_oid: null,
        sensitive: sensitiveName(item.entry),
        metadata_identity: identity(stat),
      }
      if (known !== undefined && contentIdentity.get(target) !== identity(stat)) {
        file = { ...base, status: "changed" }
        add("FILE_CHANGED_DURING_SCAN", item.entry)
      } else if (
        stat.size > BigInt(Number.MAX_SAFE_INTEGER) ||
        (known === undefined && stat.size > BigInt(limits.bytes - bytesRead))
      ) {
        limit = "bytes"
        file = { ...base, status: "budget_limited" }
        add("FILE_BYTES_UNOBSERVED", item.entry, { reason: "bytes" })
      } else {
        const loaded =
          known === undefined
            ? yield* io(() =>
                boundedFile(target, stat, limits.bytes - bytesRead, (bytes) => {
                  bytesRead += bytes
                }),
              ).pipe(Effect.result)
            : { _tag: "Success" as const, success: { kind: "verified" as const, bytes: known } }
        if (loaded._tag === "Failure") {
          file = { ...base, status: "unavailable" }
          add("FILE_UNAVAILABLE", item.entry, loaded.failure.details)
        } else if (loaded.success.kind !== "verified") {
          file = { ...base, status: loaded.success.kind }
          add(
            loaded.success.kind === "changed"
              ? "FILE_CHANGED_DURING_SCAN"
              : "FILE_BYTES_UNOBSERVED",
            item.entry,
          )
          if (loaded.success.kind === "budget_limited") limit = "bytes"
        } else {
          if (known === undefined) {
            content.set(target, loaded.success.bytes)
            contentIdentity.set(target, identity(stat))
          }
          const decoded = new TextDecoder().decode(loaded.success.bytes)
          const sensitive = base.sensitive || secretPattern.test(decoded)
          file = {
            ...base,
            status: "verified",
            sha256: hash(loaded.success.bytes),
            git_oid: gitHash(loaded.success.bytes),
            sensitive,
          }
          if (sensitive)
            add("SENSITIVE_CONTENT_REQUIRES_REVIEW", item.entry, { contents: "redacted" })
        }
      }
      files.set(item.entry, file)
    }
    if (queue.length)
      add("LOCAL_SCOPE_UNOBSERVED", queue[0]!.logical, {
        remaining_entries: queue.length,
        budget: limit,
      })
    for (const [path, original] of directories) {
      if (timeRemaining() <= 0) {
        limit = "duration"
        add("DIRECTORY_RECHECK_UNOBSERVED", path, { budget: "duration" })
        break
      }
      const current = yield* io(() => lstat(path, { bigint: true })).pipe(Effect.result)
      if (current._tag === "Failure" || identity(current.success) !== original)
        add("DIRECTORY_CHANGED_DURING_SCAN", path)
    }
    const documents: ProvenanceDocument[] = []
    const provenance: LocalSkillInventory["provenance"][number][] = []
    for (const path of provenanceFiles) {
      if (timeRemaining() <= 0 || bytesRead >= limits.bytes) {
        limit = timeRemaining() <= 0 ? "duration" : "bytes"
        provenance.push({ path, sha256: null, status: "unavailable" })
        add("PROVENANCE_UNOBSERVED", path, { budget: limit })
        continue
      }
      const loaded = yield* io(async () => {
        const stat = await lstat(path, { bigint: true })
        return boundedFile(
          path,
          stat,
          Math.min(2 * 1024 * 1024, Math.max(0, limits.bytes - bytesRead)),
          (bytes) => {
            bytesRead += bytes
          },
        )
      }).pipe(Effect.result)
      if (loaded._tag === "Failure" || loaded.success.kind !== "verified") {
        provenance.push({
          path,
          sha256: null,
          status:
            loaded._tag === "Success" && loaded.success.kind === "changed"
              ? "changed"
              : "unavailable",
        })
        add("PROVENANCE_UNAVAILABLE", path)
        continue
      }
      const canonical = yield* io(() => realpath(path)).pipe(Effect.result)
      try {
        const source = new TextDecoder("utf-8", { fatal: true }).decode(loaded.success.bytes)
        const document = /\.ya?ml$/iu.test(path)
          ? parseDocument(source, { logLevel: "silent" })
          : undefined
        if (document?.errors.length) throw Error("Invalid provenance YAML")
        documents.push({
          path: canonical._tag === "Success" ? canonical.success : path,
          value: document === undefined ? JSON.parse(source) : document.toJS(),
        })
        provenance.push({ path, sha256: hash(loaded.success.bytes), status: "verified" })
      } catch {
        provenance.push({ path, sha256: hash(loaded.success.bytes), status: "invalid" })
        add("PROVENANCE_INVALID", path)
      }
    }
    const identities = localInventoryProvenance(documents)
    findings.push(...identities.findings)
    const gitRoots = new Map<
      string,
      { head: string | null; changed: readonly string[]; known: boolean }
    >()
    const git = (cwd: string, args: readonly string[]) =>
      io(
        async () =>
          (
            await executeFile(
              "git",
              [
                "--no-optional-locks",
                "-c",
                "core.fsmonitor=false",
                "-c",
                "core.untrackedCache=false",
                "-C",
                cwd,
                ...args,
              ],
              {
                timeout: Math.max(1, Math.min(10_000, timeRemaining())),
                maxBuffer: 4 * 1024 * 1024,
                encoding: "utf8",
                env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
              },
            )
          ).stdout,
      )
    for (const root of roots) {
      if (timeRemaining() <= 0) {
        limit = "duration"
        add("GIT_STATE_UNOBSERVED", root, { budget: "duration" })
        break
      }
      const resolved = yield* io(() => realpath(root)).pipe(Effect.result)
      if (resolved._tag === "Failure" || !allowed(resolved.success)) continue
      const repository = yield* git(resolved.success, ["rev-parse", "--show-toplevel"]).pipe(
        Effect.result,
      )
      if (repository._tag === "Failure") continue
      const directory = repository.success.trim()
      if (gitRoots.has(directory)) continue
      const head = yield* git(directory, ["rev-parse", "HEAD"]).pipe(Effect.result)
      const selected = [...directories.keys()]
        .filter((path) => within(directory, path))
        .sort((a, b) => a.length - b.length)
      const minimal: string[] = []
      for (const path of selected)
        if (!minimal.some((parent) => within(parent, path))) minimal.push(path)
      const status = yield* git(directory, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--",
        ...minimal.map((path) => relative(directory, path) || "."),
      ]).pipe(Effect.result)
      const changed =
        status._tag === "Success"
          ? status.success
              .split("\0")
              .filter(Boolean)
              .map((value) =>
                resolve(directory, /^[ MADRCU?!]{2} /u.test(value) ? value.slice(3) : value),
              )
          : []
      gitRoots.set(directory, {
        head:
          head._tag === "Success" && /^[a-f0-9]{40}\n?$/u.test(head.success)
            ? head.success.trim()
            : null,
        changed,
        known: status._tag === "Success",
      })
    }
    const mains = [...files.keys()]
      .filter((path) => /^(?:SKILL|ROUTER|PROMPT)\.md$/u.test(basename(path)))
      .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))
    const entityRoots: string[] = []
    for (const main of mains)
      if (!entityRoots.some((root) => within(root, main))) entityRoots.push(dirname(main))
    const observedAliases = new Map<string, Set<string>>()
    for (const alias of aliases) {
      if (
        alias.real_path === null ||
        !["allowed", "cycle_or_alias"].includes(alias.boundary) ||
        !directories.has(alias.real_path)
      )
        continue
      const targets = observedAliases.get(alias.logical_path) ?? new Set<string>()
      targets.add(alias.real_path)
      observedAliases.set(alias.logical_path, targets)
    }
    const resolvedIdentities = identities.entries.flatMap((entry) => {
      let prefix = entry.path
      let targets: readonly string[] = directories.has(entry.path) ? [entry.path] : []
      // A declaration is not a new filesystem traversal. Only this observation's
      // authorized directory aliases may establish its real target.
      while (targets.length === 0) {
        const observed = observedAliases.get(prefix)
        if (observed !== undefined) {
          targets = [
            ...new Set(
              [...observed]
                .map((target) => resolve(target, relative(prefix, entry.path)))
                .filter((target) => directories.has(target)),
            ),
          ]
          break
        }
        const parent = dirname(prefix)
        if (parent === prefix) break
        prefix = parent
      }
      const target = targets.length === 1 ? targets[0] : undefined
      if (target === undefined || !entityRoots.includes(target)) {
        findings.push({
          code:
            targets.length > 1
              ? "PROVENANCE_PATH_AMBIGUOUS"
              : entry.identity.authority === "explicit_identity"
                ? "PROVENANCE_PATH_UNESTABLISHED"
                : "PROVENANCE_TARGET_NOT_IN_INVENTORY",
          path: target ?? entry.path,
          severity:
            targets.length > 1 || entry.identity.authority === "explicit_identity"
              ? "blocked"
              : "review",
          details: {
            declared_path: entry.path,
            evidence_file: entry.identity.evidence_file,
            authority: entry.identity.authority,
            observed_targets: targets,
            deletion_inferred: false,
          },
        })
        return []
      }
      return [
        { ...entry, path: target, identity: { ...entry.identity, declared_path: entry.path } },
      ]
    })
    const entities: LocalInventoryEntity[] = []
    for (const root of entityRoots.sort()) {
      const ownFiles = [...files.values()]
        .filter((file) => within(root, file.path))
        .map((file) => ({ ...file, path: relative(root, file.path).split("\\").join("/") }))
        .sort((a, b) => a.path.localeCompare(b.path))
      const ownIdentities = resolvedIdentities
        .filter((entry) => entry.path === root)
        .map((entry) => entry.identity)
      const configured = identities.roots
        .filter((entry) => within(entry.path, root))
        .sort((a, b) => b.path.length - a.path.length)[0]
      const discovery_identity = {
        mode: configured?.name ?? null,
        canonical_name:
          configured === undefined ? null : relative(configured.path, root).split("\\").join("/"),
        config_file: configured?.config_file ?? null,
      }
      const ownFindings = findings.filter((finding) => within(root, finding.path))
      const repository = [...gitRoots.keys()]
        .filter((directory) => within(directory, root))
        .sort((a, b) => b.length - a.length)[0]
      const gitState = repository === undefined ? undefined : gitRoots.get(repository)
      const changed = gitState?.changed.filter((path) => within(root, path)) ?? []
      if (changed.length)
        ownFindings.push({
          code: "GIT_DIRTY",
          path: root,
          severity: "review",
          details: { changed_paths: changed },
        })
      if (
        ownIdentities
          .filter((identity) => identity.page_id !== null)
          .map((identity) => identity.page_id)
          .filter((value, i, all) => all.indexOf(value) === i).length > 1
      )
        ownFindings.push({
          code: "MANAGEMENT_IDENTITY_CONFLICT",
          path: root,
          severity: "blocked",
          details: null,
        })
      for (const file of ownFiles) {
        const bytes = content.get(file.real_path)
        if (/\.(?:sh|bash|zsh|py|js|cjs|mjs|ts|tsx|rb|pl)$/iu.test(file.path))
          ownFindings.push({
            code: "SCRIPT_DEPENDENCIES_REQUIRE_REVIEW",
            path: join(root, file.path),
            severity: "review",
            details: { executed: false },
          })
        if (bytes !== undefined && /\.(?:md|markdown)$/iu.test(file.path)) {
          try {
            for (const reference of sharedMarkdownReferences(
              file.path,
              new TextDecoder("utf-8", { fatal: true }).decode(bytes),
            ))
              if (!ownFiles.some((target) => target.path === reference.target))
                ownFindings.push({
                  code: "LOCAL_REFERENCE_UNAVAILABLE",
                  path: join(root, file.path),
                  severity: "review",
                  details: { target: reference.target, line: reference.line },
                })
          } catch {
            ownFindings.push({
              code: "LOCAL_REFERENCE_UNVERIFIED",
              path: join(root, file.path),
              severity: "review",
              details: null,
            })
          }
        }
      }
      const manifest_sha256 = yield* sha256(
        canonicalSharedJson(
          ownFiles.map((file) => ({
            path: file.path,
            real_path: file.real_path,
            sha256: file.sha256,
            bytes: file.bytes,
            mode: file.mode,
            status: file.status,
          })),
        ),
      )
      entities.push({
        entity_id: `local-entity-${yield* sha256(root)}`,
        real_root: root,
        aliases: [
          ...new Set([
            root,
            ...aliases.flatMap((alias) =>
              alias.real_path !== null &&
              ["allowed", "cycle_or_alias"].includes(alias.boundary) &&
              directories.has(alias.real_path) &&
              within(alias.real_path, root)
                ? [resolve(alias.logical_path, relative(alias.real_path, root))]
                : [],
            ),
          ]),
        ].sort(),
        name: basename(root),
        main: basename(mains.find((main) => dirname(main) === root)!),
        manifest_sha256,
        files: ownFiles,
        identities: ownIdentities,
        discovery_identity,
        derived_origin: null,
        git: {
          repository_root: repository ?? null,
          head: gitState?.head ?? null,
          dirty: gitState?.known === true ? changed.length > 0 : null,
          changed_paths: changed,
        },
        classification: ownFindings.some((finding) => finding.severity === "blocked")
          ? "review_required"
          : ownIdentities.some((identity) => identity.page_id !== null)
            ? "managed_candidate"
            : ownIdentities.some((identity) => identity.commit !== null)
              ? "upstream_candidate"
              : root.includes(`${join(".ak", "state", "views")}/`)
                ? "derived_projection"
                : "local_custom",
        findings: ownFindings,
      })
    }
    const classifiedEntities = entities.map((entity): LocalInventoryEntity => {
      const identity = entity.discovery_identity
      if (identity?.canonical_name == null || identity.config_file == null) return entity
      const conflicts = entities.filter(
        (other) =>
          other.discovery_identity?.config_file === identity.config_file &&
          other.discovery_identity.canonical_name === identity.canonical_name,
      )
      if (conflicts.length < 2) return entity
      const finding: InventoryFinding = {
        code: "CANONICAL_NAME_CONFLICT",
        path: entity.real_root,
        severity: "blocked",
        details: {
          canonical_name: identity.canonical_name,
          entity_ids: conflicts.map((other) => other.entity_id),
        },
      }
      findings.push(finding)
      return {
        ...entity,
        classification: "review_required",
        findings: [...entity.findings, finding],
      }
    })
    const unassigned_files = [...files.values()]
      .filter((file) => !entityRoots.some((root) => within(root, file.path)))
      .sort((a, b) => a.path.localeCompare(b.path))
    const finalEntities = classifiedEntities.map((entity): LocalInventoryEntity => {
      const configured = identities.roots.find((entry) =>
        within(join(entry.repository, ".ak", "state", "views"), entity.real_root),
      )
      if (configured === undefined) return entity
      const path = relative(
        join(configured.repository, ".ak", "state", "views"),
        entity.real_root,
      ).split(sep)
      if (path.length !== 3 || path[1] !== "skills") return entity
      const canonical = inventoryCanonicalAssetId(path[2]!)
      if (canonical === undefined)
        return {
          ...entity,
          findings: [
            ...entity.findings,
            {
              code: "DERIVED_VIEW_CODEC_INVALID",
              path: entity.real_root,
              severity: "review",
              details: null,
            },
          ],
        }
      const candidates = classifiedEntities.filter(
        (value) =>
          value.discovery_identity?.config_file === configured.config_file &&
          value.discovery_identity.canonical_name === canonical,
      )
      const same =
        candidates.length === 1 &&
        entity.files.length === candidates[0]!.files.length &&
        entity.files.every((file) =>
          candidates[0]!.files.some(
            (other) =>
              file.path === other.path &&
              file.status === "verified" &&
              other.status === "verified" &&
              file.sha256 !== null &&
              file.sha256 === other.sha256 &&
              file.bytes === other.bytes &&
              file.mode === other.mode,
          ),
        )
      return {
        ...entity,
        derived_origin: {
          canonical_name: canonical,
          candidate_entity_ids: candidates.map((value) => value.entity_id),
          config_file: configured.config_file,
          verification: "configuration_codec_candidate",
          body_comparison: candidates.length !== 1 ? "unobserved" : same ? "exact" : "different",
        },
        findings: [
          ...entity.findings,
          {
            code: "DERIVED_VIEW_AUTHORITY_UNESTABLISHED",
            path: entity.real_root,
            severity: "review",
            details: { deduplicated_as_owner: false },
          },
        ],
      }
    })
    const scope = {
      roots,
      allow_targets: allowTargets,
      provenance_files: provenanceFiles,
      discovery: "first_entrypoint_per_branch" as const,
    }
    const manifest_id = `local-manifest-${yield* sha256(canonicalSharedJson({ rules_version: INVENTORY_RULES, scope, entities: finalEntities, aliases, unassigned_files, provenance }))}`
    const report: LocalSkillInventory = {
      version: 1,
      rules_version: INVENTORY_RULES,
      manifest_id,
      scope,
      observation_interval: { from: started, to: Date.now(), atomic_snapshot: false },
      coverage:
        limit !== null ||
        findings.some((finding) => finding.severity === "blocked") ||
        [...files.values()].some((file) => file.status !== "verified")
          ? "partial"
          : "full",
      entities: finalEntities,
      unassigned_files,
      aliases,
      findings,
      provenance,
      metrics: {
        entries,
        files: files.size,
        bytes: bytesRead,
        elapsed_ms: performance.now() - monotonic,
        limit,
        byte_overshoot: Math.max(0, bytesRead - limits.bytes),
        byte_policy: "at_most_one_probe_byte",
        duration_policy: "between_filesystem_operations",
      },
      source_writes: 0,
      remote_writes: 0,
    }
    return { inventory_id: yield* saveInventoryArtifact("local", report), ...report }
  })
}
