import { Crypto, Effect, FileSystem, Schema, Stream } from "effect"
import { HttpClient } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { importDocument, type ImportFile } from "./import.ts"
import { aliasFor, fail, SkillsError } from "./model.ts"
import { requestTimeoutMs } from "./request-timeout.ts"
import { portableFiles, readPortable, type PortableSkill } from "./portable.ts"
import { portableIdentity } from "./export.ts"
import {
  SourceExternalResourceSchema,
  SourcePrerequisiteUnavailableSchema,
} from "./upstream-member-model.ts"
import { sourceExternalResourceTargets } from "./upstream-member-links.ts"

import {
  SourceSpecSchema,
  SourcePatchSchema,
  GitMaterializationSchema,
  type SourceSpec,
  type SourcePatch,
} from "./upstream-source-model.ts"
export {
  SourceSpecSchema,
  SourcePatchSchema,
  type SourceSpec,
  type SourcePatch,
} from "./upstream-source-model.ts"
export const DiscoverSourceInputSchema = Schema.Struct({
  source: SourceSpecSchema,
  roots: Schema.Array(Schema.String),
  include: Schema.Array(Schema.String),
  exclude: Schema.Array(Schema.String),
  mapping: Schema.Record(Schema.String, Schema.String),
  patch: Schema.optional(SourcePatchSchema),
  member_patches: Schema.optional(Schema.Record(Schema.String, SourcePatchSchema)),
  accepted_ref: Schema.optional(Schema.String),
  allow_empty: Schema.optional(Schema.Boolean),
  require_all_included: Schema.optional(Schema.Boolean),
})
export type DiscoverSourceInput = typeof DiscoverSourceInputSchema.Type
const PortableSkillSchema = Schema.Struct({
  kind: Schema.Literal("skill"),
  name: Schema.String,
  description: Schema.String,
  main: Schema.String,
  files: Schema.Array(Schema.Struct({ path: Schema.String, bytes: Schema.Uint8Array })),
  projection: Schema.optional(
    Schema.Struct({
      name: Schema.String,
      description: Schema.String,
      body: Schema.String,
      references: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    }),
  ),
})
export const SourceMemberSchema = Schema.Struct({
  member_key: Schema.String,
  source_path: Schema.String,
  portable: PortableSkillSchema,
  upstream_hash: Schema.String,
  content_hash: Schema.String,
  patch_hash: Schema.optional(Schema.String),
  git_materialization: Schema.optional(GitMaterializationSchema),
})
export type SourceMember = typeof SourceMemberSchema.Type
export const SourceSnapshotSchema = Schema.Struct({
  revision: Schema.String,
  provenance: Schema.Record(Schema.String, Schema.String),
  members: Schema.Array(SourceMemberSchema),
  external_resources: Schema.optional(Schema.Array(SourceExternalResourceSchema)),
  unavailable: Schema.optional(Schema.Array(SourcePrerequisiteUnavailableSchema)),
})
export type SourceSnapshot = typeof SourceSnapshotSchema.Type

const MAX_BYTES = 128 * 1024 * 1024
const MAX_FILES = 10_000
const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const sourceError = (code: string, message: string, details?: unknown) =>
  fail(`UPSTREAM_${code}`, message, details)
function attempt<A>(run: () => A) {
  return Effect.try({
    try: run,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : sourceError("INVALID_SOURCE", "Source data is invalid."),
  })
}
function safePath(path: string, root = false): string {
  if (root && path === ".") return path
  if (
    !path ||
    path.length > 4096 ||
    /[\\\u0000-\u001f\u007f]/.test(path) ||
    /^[A-Za-z]:/.test(path) ||
    path.startsWith("/") ||
    path
      .split("/")
      .some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")
  )
    throw sourceError("UNSAFE_PATH", "Source paths must be safe relative POSIX paths.", { path })
  return path
}
function pattern(value: string): RegExp {
  if (
    !value ||
    value.startsWith("/") ||
    /[\\\u0000-\u001f\u007f:]/.test(value) ||
    value.split("/").some((part) => !part || part === ".." || part === ".git")
  )
    throw sourceError("UNSAFE_PATH", "Invalid source selection pattern.", { pattern: value })
  const directoryPattern = value.endsWith("/**") ? value.slice(0, -3) : value
  let out = "^"
  for (let at = 0; at < directoryPattern.length; at++) {
    const char = directoryPattern[at]!
    if (char === "*" && directoryPattern[at + 1] === "*") {
      at++
      if (directoryPattern[at + 1] === "/") {
        at++
        out += "(?:.*/)?"
      } else out += ".*"
    } else if (char === "*") out += "[^/]*"
    else if (char === "?") out += "[^/]"
    else out += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }
  // A directory selector also selects its descendants.
  return new RegExp(out + "(?:/.*)?$")
}
function under(path: string, root: string) {
  return root === "." || path === root || path.startsWith(root + "/")
}
function selectMembers(
  input: DiscoverSourceInput,
  candidates: readonly string[],
  available: readonly string[],
) {
  if (input.roots.length === 0)
    throw sourceError("EMPTY_SELECTION", "At least one source root is required.")
  const roots = input.roots.map((root) => safePath(root, true))
  for (const root of roots)
    if (!input.allow_empty && !available.some((path) => under(path, root)))
      throw sourceError("MISSING_ROOT", "A configured source root does not exist.", { root })
  const include = input.include.map(pattern)
  const exclude = input.exclude.map(pattern)
  const rooted = candidates.filter((path) => roots.some((root) => under(path, root)))
  for (const literal of input.include.filter(
    (value) => !/[?*]/.test(value) && (!input.allow_empty || input.require_all_included),
  ))
    if (!rooted.includes(literal))
      throw sourceError(
        "INCOMPLETE_MEMBER",
        "An explicitly included source member is missing SKILL.md.",
        { member_key: literal },
      )
  const selected = rooted
    .filter(
      (path) =>
        (!include.length || include.some((test) => test.test(path))) &&
        !exclude.some((test) => test.test(path)),
    )
    .sort(order)
  if (!selected.length && !input.allow_empty)
    throw sourceError("EMPTY_SELECTION", "Source selection contains no complete Skills.")
  for (const key of Object.keys(input.mapping)) {
    safePath(key, true)
    if (!selected.includes(key) && !input.allow_empty)
      throw sourceError(
        "INVALID_MAPPING",
        "Mapping names a member outside the selected snapshot.",
        { member_key: key },
      )
  }
  for (const key of Object.keys(input.member_patches ?? {})) {
    safePath(key, true)
    if (!selected.includes(key))
      throw sourceError(
        "PATCH_CONFLICT",
        "Member patch names a member outside the selected snapshot.",
        {
          member_key: key,
        },
      )
  }
  for (let at = 0; at < selected.length; at++)
    if (selected.some((other, index) => index !== at && under(other, selected[at]!)))
      throw sourceError("NESTED_MEMBER", "Nested Skills cannot share source files.", {
        member_key: selected[at],
      })
  return selected
}
function capture<E>(stream: Stream.Stream<Uint8Array, E>, limit: number) {
  return Effect.suspend(() => {
    const chunks: Uint8Array[] = []
    let size = 0
    return stream.pipe(
      Stream.runForEach((chunk) => {
        size += chunk.length
        if (size > limit)
          return Effect.fail(sourceError("LIMIT", "Source output exceeds its byte limit."))
        chunks.push(chunk)
        return Effect.void
      }),
      Effect.map(() => {
        const bytes = new Uint8Array(size)
        let offset = 0
        for (const chunk of chunks) {
          bytes.set(chunk, offset)
          offset += chunk.length
        }
        return bytes
      }),
    )
  })
}
function git(repo: string, args: readonly string[], limit = 8 * 1024 * 1024) {
  return Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const child = yield* spawner.spawn(
        ChildProcess.make(
          "git",
          [
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "protocol.allow=never",
            "-c",
            "protocol.http.allow=always",
            "-c",
            "protocol.https.allow=always",
            "-c",
            "protocol.ssh.allow=always",
            "-c",
            "protocol.file.allow=always",
            "-c",
            "protocol.ext.allow=never",
            "-c",
            "fetch.recurseSubmodules=false",
            "-c",
            "maintenance.auto=false",
            "-c",
            "gc.auto=0",
            "-C",
            repo,
            ...args,
          ],
          {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            detached: false,
            forceKillAfter: "2 seconds",
            env: {
              GIT_TERMINAL_PROMPT: "0",
              // Host-configured credential helpers and SSH agents are trusted capabilities.
              // Source repositories remain isolated; protocol policy is enforced explicitly.
              GIT_ALLOW_PROTOCOL: "http:https:ssh:file",
              GIT_TRACE: "0",
              GIT_TRACE_PACKET: "0",
              GIT_TRACE_CURL: "0",
              GIT_CURL_VERBOSE: "0",
              GIT_TRACE_SETUP: "0",
              GIT_TRACE_PERFORMANCE: "0",
              GIT_TRACE2: "0",
              GIT_TRACE2_EVENT: "0",
              GIT_TRACE2_PERF: "0",
              GIT_NO_REPLACE_OBJECTS: "1",
              GIT_DIR: undefined,
              GIT_WORK_TREE: undefined,
              GIT_INDEX_FILE: undefined,
              GIT_OBJECT_DIRECTORY: undefined,
              GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
            },
            extendEnv: true,
          },
        ),
      )
      const [stdout, , code] = yield* Effect.all(
        [capture(child.stdout, limit), capture(child.stderr, 64 * 1024), child.exitCode],
        { concurrency: "unbounded" },
      )
      if (code !== 0)
        return yield* Effect.fail(
          sourceError("GIT_FAILED", "Git could not acquire or read the pinned source.", {
            operation: args[0],
            exit_code: code,
          }),
        )
      return stdout
    }),
  ).pipe(
    // Acquiring a repository can exceed the smaller per-object read budget.
    Effect.timeout(args[0] === "fetch" ? "5 minutes" : "120 seconds"),
    Effect.mapError((error) =>
      error instanceof SkillsError
        ? error
        : sourceError("GIT_FAILED", "Git source operation failed or timed out."),
    ),
  )
}
function digest(bytes: Uint8Array) {
  return Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto
    const hash = yield* crypto.digest("SHA-256", bytes)
    return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("")
  }).pipe(Effect.mapError(() => sourceError("HASH_FAILED", "Could not hash source content.")))
}
function hashFiles(files: readonly ImportFile[]) {
  return Effect.gen(function* () {
    const entries = yield* Effect.forEach(
      [...files].sort((a, b) => order(a.path, b.path)),
      (file) => Effect.map(digest(file.bytes), (sha256) => [file.path, file.bytes.length, sha256]),
    )
    return yield* digest(encoder.encode(JSON.stringify(entries)))
  })
}
function adapt(files: readonly ImportFile[], patch: SourcePatch): ImportFile[] {
  if (!patch.files.length)
    throw sourceError("PATCH_CONFLICT", "Patch requires a nonempty files array.")
  const prepared = new Map<string, Uint8Array>()
  for (const file of patch.files) {
    safePath(file.path)
    const original = files.find((candidate) => candidate.path === file.path)
    if (!original || prepared.has(file.path) || !file.replacements.length)
      throw sourceError(
        "PATCH_CONFLICT",
        "Patch file is missing, repeated, or has no replacements.",
        { path: file.path },
      )
    let text = decoder.decode(original.bytes)
    for (const replacement of file.replacements) {
      if (!replacement.from || replacement.from === replacement.to)
        throw sourceError("PATCH_CONFLICT", "Patch requires a nonempty, changing replacement.", {
          path: file.path,
        })
      // Count overlapping matches as well: each from must occur exactly once.
      const first = text.indexOf(replacement.from)
      if (first < 0 || text.indexOf(replacement.from, first + 1) >= 0)
        throw sourceError("PATCH_CONFLICT", "Patch replacement must match exactly once.", {
          path: file.path,
        })
      text = text.slice(0, first) + replacement.to + text.slice(first + replacement.from.length)
    }
    prepared.set(file.path, encoder.encode(text))
  }
  return files.map((file) =>
    prepared.has(file.path) ? { path: file.path, bytes: prepared.get(file.path)! } : file,
  )
}
function member(
  input: DiscoverSourceInput,
  key: string,
  files: readonly ImportFile[],
  upstreamFiles: readonly ImportFile[] = files,
) {
  return Effect.gen(function* () {
    files = [...files].sort((left, right) => order(left.path, right.path))
    const upstream_hash = yield* hashFiles(upstreamFiles)
    const scopedPatch = input.member_patches?.[key]
    if (input.patch && scopedPatch) {
      const globalPaths = new Set(input.patch.files.map((file) => file.path))
      const overlap = scopedPatch.files.find((file) => globalPaths.has(file.path))
      if (overlap)
        return yield* Effect.fail(
          sourceError("PATCH_CONFLICT", "Global and member patches target the same file.", {
            member_key: key,
            path: overlap.path,
          }),
        )
    }
    let adapted = input.patch ? yield* attempt(() => adapt(files, input.patch!)) : files
    if (scopedPatch) adapted = yield* attempt(() => adapt(adapted, scopedPatch))
    const portable = yield* attempt((): PortableSkill & { readonly kind: "skill" } => {
      const stored = readPortable(adapted)
      const main = adapted.find((file) => file.path === "SKILL.md")
      if (!main)
        throw sourceError("INCOMPLETE_MEMBER", "A source member requires SKILL.md.", {
          member_key: key,
        })
      const metadata =
        stored ??
        importDocument(main, input.mapping[key] === undefined ? {} : { name: input.mapping[key] })
      if (stored && stored.kind !== "skill")
        throw sourceError("INCOMPLETE_MEMBER", "Upstream source members must contain Skills.", {
          member_key: key,
        })
      const skill: PortableSkill & { readonly kind: "skill" } = {
        ...metadata,
        kind: "skill",
        name: input.mapping[key] ?? metadata.name,
        main: stored?.main ?? "SKILL.md",
        files: stored?.files ?? adapted,
      }
      portableFiles(skill)
      return skill
    })
    const content_hash = yield* portableIdentity(portable)
    const appliedPatch =
      input.patch && scopedPatch
        ? { global: input.patch, member: scopedPatch }
        : (scopedPatch ?? input.patch)
    const patch_hash = appliedPatch
      ? yield* digest(encoder.encode(JSON.stringify(appliedPatch)))
      : undefined
    return {
      member_key: key,
      source_path: key,
      portable,
      upstream_hash,
      content_hash,
      ...(patch_hash === undefined ? {} : { patch_hash }),
    }
  })
}
type GitTreeEntry = { mode: string; type: string; oid: string; size: number; path: string }

/** Resolve only pinned tree objects, never host filesystem links. */
function expandGitResources(
  key: string,
  entries: readonly GitTreeEntry[],
  blobs: ReadonlyMap<string, Uint8Array>,
) {
  const tree = new Map(entries.map((entry) => [entry.path, entry]))
  const directories = new Map<string, Set<string>>()
  for (const entry of entries) {
    const parts = entry.path.split("/")
    for (let at = 0; at < parts.length; at++) {
      const parent = parts.slice(0, at).join("/") || "."
      let children = directories.get(parent)
      if (!children) directories.set(parent, (children = new Set()))
      children.add(parts.slice(0, at + 1).join("/"))
    }
  }
  const links: {
    path: string
    declared_git_oid: string
    bytes: Uint8Array
    target: string
    resolved_path: string
  }[] = []
  const targets = new Map<string, string>()
  for (const entry of entries.filter((entry) => entry.mode === "120000")) {
    const bytes = blobs.get(entry.oid)!
    const target = decoder.decode(bytes)
    if (
      !target ||
      target.startsWith("/") ||
      /^[A-Za-z]:/.test(target) ||
      /[\\\u0000-\u001f\u007f]/.test(target)
    )
      throw sourceError("GIT_LINK_ABSOLUTE", "Git links require a relative POSIX target.", {
        path: entry.path,
        target,
      })
    const parts = entry.path.split("/").slice(0, -1)
    const floor = key === "." ? 0 : key.split("/").length
    for (const part of target.split("/")) {
      if (!part || part === ".") continue
      if (part === "..") {
        if (parts.length <= floor)
          throw sourceError("GIT_LINK_ESCAPE", "Git link escapes the selected Skill root.", {
            path: entry.path,
            target,
            root: key,
          })
        parts.pop()
      } else {
        if (part.toLowerCase() === ".git")
          throw sourceError("GIT_LINK_ESCAPE", "Git link enters reserved metadata.", {
            path: entry.path,
            target,
          })
        parts.push(part)
      }
    }
    const resolved_path = parts.join("/") || "."
    if (!under(resolved_path, key))
      throw sourceError("GIT_LINK_ESCAPE", "Git link escapes the selected Skill root.", {
        path: entry.path,
        target,
      })
    if (under(entry.path, resolved_path))
      throw sourceError("GIT_LINK_OVERLAP", "Git link target overlaps its own output subtree.", {
        path: entry.path,
        target,
      })
    targets.set(entry.path, resolved_path)
    links.push({
      path: key === "." ? entry.path : entry.path.slice(key.length + 1),
      declared_git_oid: entry.oid,
      bytes,
      target,
      resolved_path,
    })
  }
  const outputs = new Map<
    string,
    {
      path: string
      declared_git_oid: string
      source_path: string
      source_git_oid: string
      bytes: Uint8Array
    }
  >()
  let total = 0
  const visit = (
    path: string,
    output: string,
    active: readonly string[],
    declared?: string,
  ): void => {
    const parts = path === "." ? [] : path.split("/")
    for (let at = 1; at <= parts.length; at++) {
      const prefix = parts.slice(0, at).join("/")
      const entry = tree.get(prefix)
      if (entry?.mode === "120000") {
        if (active.includes(prefix))
          throw sourceError("GIT_LINK_CYCLE", "Git link expansion contains a cycle.", {
            path: prefix,
            chain: [...active, prefix],
          })
        // 64 link dereferences accommodates normal resources and bounds malicious chains.
        // Ordinary tree depth is not counted; output still obeys the global file/byte limits.
        if (active.length >= 64)
          throw sourceError("GIT_LINK_DEPTH", "Git link expansion exceeds 64 dereferences.", {
            path: prefix,
            limit: 64,
          })
        const suffix = parts.slice(at).join("/")
        const target = targets.get(prefix)!
        visit(
          suffix ? (target === "." ? suffix : `${target}/${suffix}`) : target,
          output,
          [...active, prefix],
          declared ?? entry.oid,
        )
        return
      }
      if (entry?.type === "commit" || entry?.mode === "160000")
        throw sourceError(
          "GIT_LINK_SUBMODULE",
          "Git resources cannot contain or traverse submodules.",
          { path: prefix },
        )
    }
    const entry = tree.get(path)
    if (entry) {
      if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode))
        throw sourceError("UNSAFE_FILE", "Git resource is not a regular blob.", {
          path,
          mode: entry.mode,
        })
      if (outputs.has(output))
        throw sourceError("GIT_LINK_OVERLAP", "Git resources produce conflicting output paths.", {
          path: output,
        })
      const bytes = blobs.get(entry.oid)!
      total += bytes.length
      if (outputs.size >= MAX_FILES || total > MAX_BYTES)
        throw sourceError("LIMIT", "Materialized source exceeds 128 MiB or 10,000 files.")
      outputs.set(output, {
        path: output,
        declared_git_oid: declared ?? entry.oid,
        source_path: path,
        source_git_oid: entry.oid,
        bytes,
      })
      return
    }
    const children = directories.get(path)
    if (!children)
      throw sourceError("GIT_LINK_MISSING", "Git link target is absent from the pinned tree.", {
        path,
      })
    for (const child of [...children].sort(order)) {
      const name = child.slice(child.lastIndexOf("/") + 1)
      visit(child, output ? `${output}/${name}` : name, active, declared)
    }
  }
  visit(key, "", [])
  const files = [...outputs.values()].sort((a, b) => order(a.path, b.path))
  for (let at = 1; at < files.length; at++)
    if (files[at]!.path.startsWith(files[at - 1]!.path + "/"))
      throw sourceError("GIT_LINK_OVERLAP", "Git output overlaps a regular file.", {
        path: files[at]!.path,
      })
  return { files, links }
}

function marketplace(raw: string) {
  const url = new URL(raw)
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent)
  if (
    !["https:", "http:"].includes(url.protocol) ||
    !["skills.sh", "www.skills.sh"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    parts.length !== 3 ||
    parts.some((part) => !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part))
  )
    throw sourceError(
      "INVALID_SOURCE",
      "GitHub marketplace sources require a skills.sh/owner/repository/skill URL.",
    )
  return {
    url: `https://github.com/${parts[0]}/${parts[1]}.git`,
    slug: parts[2]!,
    source_url: `https://www.skills.sh/${parts.join("/")}`,
  }
}
export function validateGitSource(url: string, ref: string) {
  if (
    !url ||
    url.startsWith("-") ||
    /[\u0000-\u001f\u007f]/.test(url) ||
    !/^(https?:\/\/|ssh:\/\/|file:\/\/|\/|\.\.?\/|[\w.-]+@[\w.-]+:)/.test(url)
  )
    throw sourceError("INVALID_SOURCE", "Unsupported Git source URL.")
  if (/^(https?|ssh|file):\/\//.test(url)) {
    const parsed = new URL(url)
    if (
      parsed.password ||
      (parsed.protocol !== "ssh:" && parsed.username) ||
      parsed.search ||
      parsed.hash
    )
      throw sourceError(
        "INVALID_SOURCE",
        "Git source URLs must use host authentication without query or fragment data.",
      )
  }
  if (!ref || ref.startsWith("-") || /[\u0000-\u0020\u007f]/.test(ref))
    throw sourceError("INVALID_REF", "Invalid Git source ref.")
}

function gitSnapshot(
  input: DiscoverSourceInput,
  source: Extract<SourceSpec, { type: "git" | "github-market" }>,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const market =
        source.type === "github-market" ? yield* attempt(() => marketplace(source.url)) : undefined
      const url = market?.url ?? source.url
      const ref = input.accepted_ref ?? source.ref ?? "HEAD"
      yield* attempt(() => validateGitSource(url, ref))
      const fs = yield* FileSystem.FileSystem
      const repo = yield* fs
        .makeTempDirectoryScoped({ prefix: "ntn-upstream-" })
        .pipe(
          Effect.mapError(() =>
            sourceError("TEMP_FAILED", "Could not create scoped Git repository."),
          ),
        )
      yield* git(repo, ["init", "--bare", "--template=", "."])
      yield* git(repo, ["fetch", "--depth=1", "--no-tags", "--", url, ref])
      const resolved = yield* git(repo, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"])
      const revision = yield* attempt(() => {
        const commit = decoder.decode(resolved).trim()
        if (!/^[a-f0-9]{40,64}$/.test(commit))
          throw sourceError("INVALID_REF", "Git did not resolve a commit.")
        if (/^[a-f0-9]{40,64}$/.test(ref) && commit !== ref)
          throw sourceError("INVALID_REF", "Fetched commit differs from the requested pin.")
        return commit
      })
      const resolvedTree = yield* git(repo, ["rev-parse", "--verify", `${revision}^{tree}`])
      const treeHash = yield* attempt(() => {
        const tree = decoder.decode(resolvedTree).trim()
        if (!/^[a-f0-9]{40,64}$/.test(tree))
          throw sourceError("INVALID_TREE", "Git did not resolve the pinned commit tree.")
        return tree
      })
      const rawTree = yield* git(repo, ["ls-tree", "-r", "-l", "-z", revision], 16 * 1024 * 1024)
      const entries = yield* attempt(() => {
        const text = decoder.decode(rawTree)
        if (text && !text.endsWith("\0"))
          throw sourceError("INVALID_TREE", "Git tree output is incomplete.")
        const rows = text ? text.slice(0, -1).split("\0") : []
        if (rows.length > 100_000)
          throw sourceError("LIMIT", "Source repository contains too many tree entries.")
        return rows.map((row) => {
          const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40,64}) +([\d-]+)\t([\s\S]+)$/.exec(row)
          if (!match) throw sourceError("INVALID_TREE", "Git returned an invalid tree entry.")
          return {
            mode: match[1]!,
            type: match[2]!,
            oid: match[3]!,
            size: Number(match[4]),
            path: safePath(match[5]!),
          }
        })
      })
      const candidates = entries
        .filter((entry) => entry.path === "SKILL.md" || entry.path.endsWith("/SKILL.md"))
        .map((entry) => (entry.path === "SKILL.md" ? "." : entry.path.slice(0, -9)))
      const keys = yield* attempt(() => {
        let roster = candidates
        if (market) {
          roster = candidates.filter((key) => key.split("/").at(-1) === market.slug)
          if (roster.length !== 1)
            throw sourceError(
              "MARKET_AMBIGUOUS",
              "Marketplace slug must resolve to exactly one Git Skill directory.",
              { slug: market.slug, candidates: roster },
            )
        }
        return selectMembers(
          input,
          roster,
          entries.map((entry) => entry.path),
        )
      })
      let totalBytes = 0
      let totalFiles = 0
      let materializedBytes = 0
      let materializedFiles = 0
      const members: SourceMember[] = []
      for (const key of keys) {
        const selected = entries.filter((entry) => under(entry.path, key))
        yield* attempt(() => {
          for (const entry of selected) {
            if (entry.type === "commit" || entry.mode === "160000")
              throw sourceError("GIT_LINK_SUBMODULE", "Git resources cannot contain submodules.", {
                path: entry.path,
              })
            if (entry.type !== "blob" || !["100644", "100755", "120000"].includes(entry.mode))
              throw sourceError(
                "UNSAFE_FILE",
                "Selected Git resource is not a regular file or contained link.",
                { path: entry.path, mode: entry.mode },
              )
            totalBytes += entry.size
            totalFiles++
            if (
              !Number.isSafeInteger(entry.size) ||
              entry.size < 0 ||
              totalBytes > MAX_BYTES ||
              totalFiles > MAX_FILES
            )
              throw sourceError("LIMIT", "Selected source exceeds 128 MiB or 10,000 files.")
          }
        })
        const files: ImportFile[] = []
        const blobs = new Map<string, Uint8Array>()
        for (const entry of selected) {
          // Tree paths are validated as POSIX names; blob IDs bypass Git pathspec/glob parsing.
          const bytes =
            blobs.get(entry.oid) ?? (yield* git(repo, ["cat-file", "blob", entry.oid], entry.size))
          if (bytes.length !== entry.size)
            return yield* Effect.fail(
              sourceError("INVALID_TREE", "Git blob size differs from the pinned tree.", {
                path: entry.path,
              }),
            )
          blobs.set(entry.oid, bytes)
          files.push({ path: key === "." ? entry.path : entry.path.slice(key.length + 1), bytes })
        }
        const expanded = yield* attempt(() => expandGitResources(key, selected, blobs))
        materializedBytes += expanded.files.reduce((sum, file) => sum + file.bytes.length, 0)
        materializedFiles += expanded.files.length
        if (materializedBytes > MAX_BYTES || materializedFiles > MAX_FILES)
          return yield* Effect.fail(
            sourceError("LIMIT", "Materialized selection exceeds 128 MiB or 10,000 files."),
          )
        const acquired = yield* member(
          input,
          key,
          expanded.files.map(({ path, bytes }) => ({ path, bytes })),
          files,
        )
        if (expanded.links.length) {
          const links = yield* Effect.forEach(expanded.links, ({ bytes, ...link }) =>
            Effect.map(digest(bytes), (source_hash) => ({ ...link, source_hash })),
          )
          const materialized = yield* Effect.forEach(expanded.files, ({ bytes, ...file }) =>
            Effect.map(digest(bytes), (materialized_file_hash) => ({
              ...file,
              materialized_file_hash,
            })),
          )
          members.push({
            ...acquired,
            git_materialization: {
              source_hash: acquired.upstream_hash,
              derived_hash: yield* hashFiles(expanded.files),
              links,
              files: materialized,
            },
          })
        } else members.push(acquired)
      }
      const external_resources: { source_path: string; git_oid: string; sha256: string }[] = []
      const unavailable: { reason: "outside_source_root"; from_path: string; href: string }[] = []
      const externalTargets = yield* attempt(() =>
        sourceExternalResourceTargets(members, entries, (entry) => unavailable.push(entry)),
      )
      for (const target of externalTargets) {
        const entry = entries.find((entry) => entry.path === target.source_path)!
        totalBytes += entry.size
        totalFiles++
        if (totalBytes > MAX_BYTES || totalFiles > MAX_FILES)
          return yield* Effect.fail(
            sourceError("LIMIT", "Referenced source exceeds 128 MiB or 10,000 files."),
          )
        const bytes = yield* git(repo, ["cat-file", "blob", target.git_oid], entry.size)
        if (bytes.length !== entry.size)
          return yield* Effect.fail(
            sourceError("INVALID_TREE", "Referenced blob size differs from the pinned tree.", {
              path: target.source_path,
            }),
          )
        external_resources.push({ ...target, sha256: yield* digest(bytes) })
      }
      const provenance: Record<string, string> = {
        provider: market ? "skills.sh" : "git",
        source_url: market?.source_url ?? source.url,
        git_url: url,
        requested_ref: ref,
        resolved_ref: revision,
        tree_hash: treeHash,
      }
      if (market) provenance.catalog_slug = market.slug
      return {
        revision,
        provenance,
        members,
        unavailable,
        ...(external_resources.length ? { external_resources } : {}),
      }
    }),
  )
}

const RegistryInfoSchema = Schema.Struct({
  skill: Schema.Struct({ slug: Schema.String, displayName: Schema.optional(Schema.String) }),
  owner: Schema.Struct({ handle: Schema.String }),
  latestVersion: Schema.optional(Schema.NullOr(Schema.Struct({ version: Schema.String }))),
})
const RegistryVersionSchema = Schema.Struct({
  version: Schema.Struct({
    version: Schema.String,
    files: Schema.Array(
      Schema.Struct({
        path: Schema.String,
        size: Schema.optional(Schema.Number),
        sha256: Schema.optional(Schema.String),
        contentType: Schema.optional(Schema.String),
      }),
    ),
    security: Schema.optional(Schema.Struct({ status: Schema.optional(Schema.String) })),
  }),
})
function download(url: string, limit: number, accept: string) {
  return Effect.gen(function* () {
    const timeoutMs = yield* requestTimeoutMs
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const client = HttpClient.withScope(yield* HttpClient.HttpClient)
        const response = yield* client.get(url, {
          headers: { Accept: accept, "User-Agent": "ntn-skills" },
        })
        if (response.status < 200 || response.status >= 300)
          return yield* Effect.fail(
            sourceError("HTTP_FAILED", "Source provider returned an unsuccessful response.", {
              status: response.status,
            }),
          )
        const declared = response.headers["content-length"]
        if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > limit))
          return yield* Effect.fail(sourceError("LIMIT", "Source response exceeds its byte limit."))
        return yield* capture(response.stream, limit)
      }),
    ).pipe(
      Effect.timeout(timeoutMs),
      Effect.mapError((error) =>
        error instanceof SkillsError
          ? error
          : sourceError("HTTP_FAILED", "Source download failed or timed out."),
      ),
    )
  })
}
function registrySnapshot(
  input: DiscoverSourceInput,
  source: Extract<SourceSpec, { type: "registry" }>,
) {
  return Effect.gen(function* () {
    const base = yield* attempt(() => {
      const url = new URL(source.base_url)
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !/^\/?$/.test(url.pathname)
      )
        throw sourceError("INVALID_SOURCE", "Registry base URL must be an HTTP origin.")
      if (
        ![source.owner, source.slug].every((value) => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(value))
      )
        throw sourceError("INVALID_SOURCE", "Registry owner and slug must be safe identifiers.")
      return url.origin
    })
    const apiUrl = (suffix: string, params: Readonly<Record<string, string>> = {}) => {
      const url = new URL(`/api/v1/skills/${encodeURIComponent(source.slug)}${suffix}`, base)
      url.searchParams.set("ownerHandle", source.owner)
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
      return url.href
    }
    const infoBytes = yield* download(apiUrl(""), 1024 * 1024, "application/json")
    const info = yield* attempt(() =>
      Schema.decodeUnknownSync(RegistryInfoSchema)(JSON.parse(decoder.decode(infoBytes))),
    )
    const revision = input.accepted_ref ?? source.version ?? info.latestVersion?.version
    if (!revision || revision.length > 256 || /[\u0000-\u0020\u007f]/.test(revision))
      return yield* Effect.fail(
        sourceError("INVALID_REF", "Registry has no valid resolved version."),
      )
    if (info.owner.handle !== source.owner || info.skill.slug !== source.slug)
      return yield* Effect.fail(
        sourceError(
          "REGISTRY_MISMATCH",
          "Registry owner or slug differs from the requested source.",
        ),
      )
    const versionBytes = yield* download(
      apiUrl(`/versions/${encodeURIComponent(revision)}`),
      4 * 1024 * 1024,
      "application/json",
    )
    const manifest = yield* attempt(
      () =>
        Schema.decodeUnknownSync(RegistryVersionSchema)(JSON.parse(decoder.decode(versionBytes)))
          .version,
    )
    if (manifest.version !== revision)
      return yield* Effect.fail(
        sourceError("REGISTRY_MISMATCH", "Registry returned a different version than requested."),
      )
    yield* attempt(() => {
      if (!manifest.files.length || manifest.files.length > MAX_FILES)
        throw sourceError("LIMIT", "Registry manifest must contain 1–10,000 files.")
      const seen = new Set<string>()
      let declared = 0
      for (const file of manifest.files) {
        safePath(file.path)
        if (seen.has(file.path))
          throw sourceError("INVALID_MANIFEST", "Registry manifest repeats a file path.", {
            path: file.path,
          })
        seen.add(file.path)
        if (file.size !== undefined) {
          if (!Number.isSafeInteger(file.size) || file.size < 0)
            throw sourceError("INVALID_MANIFEST", "Registry manifest has an invalid file size.", {
              path: file.path,
            })
          declared += file.size
        }
        if (file.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(file.sha256))
          throw sourceError("INVALID_MANIFEST", "Registry manifest has an invalid SHA-256.", {
            path: file.path,
          })
      }
      for (const path of seen) {
        const parts = path.split("/")
        for (let end = 1; end < parts.length; end++)
          if (seen.has(parts.slice(0, end).join("/")))
            throw sourceError(
              "INVALID_MANIFEST",
              "Registry file paths conflict with a parent file.",
              { path },
            )
      }
      if (declared > MAX_BYTES) throw sourceError("LIMIT", "Registry manifest exceeds 128 MiB.")
      selectMembers(
        input,
        manifest.files.some((file) => file.path === "SKILL.md") ? ["."] : [],
        manifest.files.map((file) => file.path),
      )
    })
    const files: ImportFile[] = []
    let total = 0
    for (const file of manifest.files) {
      const bytes = yield* download(
        apiUrl("/file", { path: file.path, version: revision }),
        Math.min(file.size ?? MAX_BYTES, MAX_BYTES - total),
        "application/octet-stream",
      )
      total += bytes.length
      if (file.size !== undefined && bytes.length !== file.size)
        return yield* Effect.fail(
          sourceError(
            "REGISTRY_MISMATCH",
            "Registry file size differs from the version manifest.",
            { path: file.path },
          ),
        )
      if (file.sha256 !== undefined && (yield* digest(bytes)) !== file.sha256)
        return yield* Effect.fail(
          sourceError(
            "HASH_MISMATCH",
            "Registry file checksum differs from the version manifest.",
            { path: file.path },
          ),
        )
      files.push({ path: file.path, bytes })
    }
    const normalized = manifest.files
      .map(
        (file) => `${file.path}:${file.sha256 ?? ""}:${file.size ?? ""}:${file.contentType ?? ""}`,
      )
      .sort()
      .join("\n")
    const manifest_hash = yield* digest(encoder.encode(`${revision}\n${normalized}`))
    const provenance: Record<string, string> = {
      provider: "clawhub",
      source_url: `https://clawhub.ai/${source.owner}/skills/${source.slug}`,
      base_url: base,
      owner: source.owner,
      slug: source.slug,
      resolved_ref: revision,
      manifest_hash,
    }
    if (source.version !== undefined) provenance.requested_ref = source.version
    if (manifest.security?.status !== undefined)
      provenance.security_status = manifest.security.status
    const selected = yield* attempt(() =>
      selectMembers(
        input,
        ["."],
        files.map((file) => file.path),
      ),
    )
    return {
      revision,
      provenance,
      members: selected.length ? [yield* member(input, ".", files)] : [],
    }
  })
}

export function validateSourceSelection(
  decoded: Pick<
    DiscoverSourceInput,
    "roots" | "include" | "exclude" | "mapping" | "member_patches"
  >,
) {
  // Validate selectors before any provider operation, including registry downloads.
  for (const root of decoded.roots) safePath(root, true)
  for (const selector of [...decoded.include, ...decoded.exclude]) pattern(selector)
  for (const key of Object.keys(decoded.mapping)) safePath(key, true)
  for (const key of Object.keys(decoded.member_patches ?? {})) safePath(key, true)
  if (decoded.roots.length === 0)
    throw sourceError("EMPTY_SELECTION", "At least one source root is required.")
}

/** Acquire one immutable provider snapshot. All subprocesses and temporary files belong to this call. */
export function discoverSource(input: DiscoverSourceInput) {
  return Effect.gen(function* () {
    const decoded = yield* attempt(() => Schema.decodeUnknownSync(DiscoverSourceInputSchema)(input))
    yield* attempt(() => validateSourceSelection(decoded))
    const snapshot: SourceSnapshot =
      decoded.source.type === "registry"
        ? yield* registrySnapshot(decoded, decoded.source)
        : yield* gitSnapshot(decoded, decoded.source)
    yield* attempt(() => {
      const aliases = new Map<string, string>()
      for (const member of snapshot.members) {
        const alias = aliasFor(member.portable.name)
        const existing = aliases.get(alias)
        if (existing !== undefined)
          throw sourceError(
            "NAME_COLLISION",
            "Selected source members share a callable alias; use exact member selectors to choose the intended source.",
            { alias, member_keys: [existing, member.member_key] },
          )
        aliases.set(alias, member.member_key)
      }
    })
    return snapshot
  }).pipe(
    Effect.timeout("10 minutes"),
    Effect.mapError((error) =>
      error instanceof SkillsError
        ? error
        : sourceError("TIMEOUT", "Source discovery exceeded its time limit."),
    ),
  )
}
