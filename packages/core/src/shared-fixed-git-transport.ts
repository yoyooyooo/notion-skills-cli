import { Config, Context, Crypto, Effect, Exit, FileSystem, Layer } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { fail, SkillsError } from "./model.ts"
import type { createRequestMetrics } from "./request-metrics.ts"
import {
  gitBlobOid,
  assertSupportedGitBlob,
  validateFixedGithubSource,
  type FixedGithubFile,
  type FixedGithubSource,
} from "./shared-github-source.ts"
import { runSourceGit } from "./upstream-source.ts"
import { sha256 } from "./store.ts"
import { gitRemoteUrl } from "./shared-git-origin.ts"

type Metrics = ReturnType<typeof createRequestMetrics>
type Input = {
  readonly source: FixedGithubSource
  readonly files: readonly FixedGithubFile[]
  readonly metrics?: Metrics
}
export class FixedGitObjectReader extends Context.Service<
  FixedGitObjectReader,
  {
    readonly read: (
      input: Input,
    ) => Effect.Effect<ReadonlyMap<string, Uint8Array>, SkillsError, Crypto.Crypto>
  }
>()("ntn-skills/FixedGitObjectReader") {}

/** Machine-local transport choice never changes a shared source identity. */
export const fixedGitTransport = Config.String("NTN_SKILLS_FIXED_GIT_TRANSPORT").pipe(
  Config.withDefault("auto"),
  Effect.mapError(() => fail("CONFIG_ERROR", "The fixed Git transport setting is invalid.")),
  Effect.flatMap((value) =>
    value === "auto" || value === "http" || value === "git"
      ? Effect.succeed(value)
      : Effect.fail(
          fail("CONFIG_ERROR", "NTN_SKILLS_FIXED_GIT_TRANSPORT must be auto, http, or git."),
        ),
  ),
)

const checked = <A>(f: () => A) =>
  Effect.try({
    try: f,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail(
            "FIXED_GIT_TRANSFER_INVALID",
            "The exact Git object response is incomplete or invalid.",
          ),
  })
const decoder = new TextDecoder("utf-8", { fatal: true }),
  encoder = new TextEncoder()

/** No worktree/checkout, branch discovery, unselected blob fetch, resource
 * execution or shared Notion byte retention. Host Git authentication is local;
 * the source descriptor contains only canonical origin/commit/tree/file IDs. */
export function readFixedGitObjects(input: Input) {
  return Effect.scoped(
    Effect.gen(function* () {
      const source = yield* checked(() => validateFixedGithubSource(input.source))
      const selected = yield* checked(() => {
        if (
          input.files.length > 10000 ||
          new Set(input.files.map((file) => file.path)).size !== input.files.length
        )
          throw fail("FIXED_GIT_SELECTION_INVALID", "Select each exact fixed file once.")
        return input.files.map((file) => {
          const exact = source.files.find((row) => row.path === file.path)
          if (
            !exact ||
            exact.source_path !== file.source_path ||
            exact.git_oid !== file.git_oid ||
            exact.bytes !== file.bytes ||
            exact.mode !== file.mode ||
            exact.sha256 !== file.sha256
          )
            throw fail(
              "FIXED_GIT_SELECTION_INVALID",
              "The requested file differs from its complete frozen source descriptor.",
            )
          return exact
        })
      })
      const unique = [...new Map(selected.map((file) => [file.git_oid, file])).values()]
      if (unique.length === 0) return new Map<string, Uint8Array>()
      const total = unique.reduce((bytes, file) => bytes + file.bytes, 0)
      if (!Number.isSafeInteger(total) || total > 256 * 1024 * 1024)
        return yield* Effect.fail(
          fail(
            "FIXED_GIT_TRANSFER_LIMIT",
            "The selected fixed blob bytes exceed the bounded transfer limit.",
          ),
        )
      const fs = yield* FileSystem.FileSystem
      const repo = yield* fs
        .makeTempDirectoryScoped({ prefix: "ntn-fixed-git-" })
        .pipe(
          Effect.mapError(() =>
            fail("FIXED_GIT_TEMP_FAILED", "Could not create the isolated bare Git directory."),
          ),
        )
      let fetchMs = 0,
        catBytes = 0
      const finish = input.metrics?.beginSourceAcquisition({
        provider: "git",
        configured_transport: source.url.startsWith("https:") ? "https" : "http",
      })
      yield* Effect.addFinalizer((exit) =>
        Effect.sync(() =>
          finish?.({
            outcome: Exit.isSuccess(exit)
              ? "success"
              : Exit.hasInterrupts(exit)
                ? "cancelled"
                : "failure",
            fetchMilliseconds: fetchMs,
            catFileBytes: catBytes,
            observationMilliseconds: 0,
          }),
        ),
      )
      yield* runSourceGit(repo, ["init", "--bare", "--template=", "."])
      yield* runSourceGit(repo, ["remote", "add", "origin", gitRemoteUrl(source.url)])
      yield* runSourceGit(repo, ["config", "remote.origin.promisor", "true"])
      yield* runSourceGit(repo, ["config", "remote.origin.partialclonefilter", "blob:none"])
      const fetch = (args: readonly string[]) =>
        Effect.suspend(() => {
          const at = performance.now()
          return runSourceGit(repo, args, undefined, { noNegotiation: true }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                fetchMs += performance.now() - at
              }),
            ),
          )
        })
      yield* fetch([
        "fetch",
        "--filter=blob:none",
        "--depth=1",
        "--no-tags",
        "--recurse-submodules=no",
        "--",
        "origin",
        source.commit,
      ])
      const commit = decoder
        .decode(yield* runSourceGit(repo, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"]))
        .trim()
      const tree = decoder
        .decode(yield* runSourceGit(repo, ["rev-parse", "--verify", `${source.commit}^{tree}`]))
        .trim()
      if (commit !== source.commit || tree !== source.tree)
        return yield* Effect.fail(
          fail(
            "FIXED_GIT_TREE_MISMATCH",
            "The fetched commit/tree differs from the original fixed selection.",
          ),
        )
      const roster = yield* checked(() => {
        return new Map<string, { mode: string; type: string; oid: string }>()
      })
      const raw = yield* runSourceGit(
        repo,
        ["ls-tree", "-r", "-z", source.commit],
        16 * 1024 * 1024,
      )
      yield* checked(() => {
        const text = decoder.decode(raw)
        if (text && !text.endsWith("\0")) throw new Error("Truncated tree")
        for (const row of text ? text.slice(0, -1).split("\0") : []) {
          const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/u.exec(row)
          if (!match || roster.has(match[4]!)) throw new Error("Invalid or duplicate tree row")
          roster.set(match[4]!, { mode: match[1]!, type: match[2]!, oid: match[3]! })
        }
        for (const file of selected) {
          const row = roster.get(file.source_path)
          if (
            !row ||
            row.type !== "blob" ||
            !["100644", "100755"].includes(row.mode) ||
            row.oid !== file.git_oid ||
            (file.mode !== undefined && row.mode !== file.mode)
          )
            throw fail(
              "FIXED_GIT_FILE_MISMATCH",
              "A requested original path, blob or mode differs from the pinned tree.",
              { path: file.path },
            )
        }
      })
      const missing: string[] = []
      const metadata = decoder
        .decode(
          yield* runSourceGit(
            repo,
            ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
            unique.length * 128,
            {
              stdin: encoder.encode(unique.map((file) => file.git_oid).join("\n") + "\n"),
              noLazyFetch: true,
            },
          ),
        )
        .trimEnd()
        .split("\n")
      yield* checked(() => {
        if (metadata.length !== unique.length) throw new Error("Incomplete fixed blob inventory")
        unique.forEach((file, at) => {
          if (metadata[at] === `${file.git_oid} missing`) missing.push(file.git_oid)
          else if (metadata[at] !== `${file.git_oid} blob ${file.bytes}`)
            throw fail(
              "FIXED_GIT_FILE_MISMATCH",
              "Original Git blob size differs from the selected manifest.",
              { path: file.path },
            )
        })
      })
      for (let at = 0; at < missing.length; at += 128)
        yield* fetch([
          "fetch",
          "--filter=blob:none",
          "--no-tags",
          "--no-write-fetch-head",
          "--recurse-submodules=no",
          "--",
          "origin",
          ...missing.slice(at, at + 128),
        ])
      const batch = yield* runSourceGit(
        repo,
        ["cat-file", "--batch"],
        total + unique.length * 128,
        {
          stdin: encoder.encode(unique.map((file) => file.git_oid).join("\n") + "\n"),
          noLazyFetch: true,
          stdoutBytes: (count) => {
            catBytes += count
          },
        },
      )
      const blobs = yield* checked(() => {
        const result = new Map<string, Uint8Array>()
        let offset = 0
        for (const file of unique) {
          const lineEnd = batch.indexOf(10, offset)
          if (
            lineEnd < 0 ||
            decoder.decode(batch.subarray(offset, lineEnd)) !== `${file.git_oid} blob ${file.bytes}`
          )
            throw new Error("Wrong selected batch header")
          offset = lineEnd + 1
          const bytes = batch.slice(offset, offset + file.bytes)
          offset += file.bytes
          if (bytes.length !== file.bytes || batch[offset++] !== 10)
            throw new Error("Incomplete exact blob")
          result.set(file.git_oid, bytes)
        }
        if (offset !== batch.length) throw new Error("Unexpected trailing blob output")
        return result
      })
      for (const file of selected) {
        const bytes = blobs.get(file.git_oid)!
        if (
          (yield* gitBlobOid(bytes)) !== file.git_oid ||
          (file.sha256 !== undefined && (yield* sha256(bytes)) !== file.sha256)
        )
          return yield* Effect.fail(
            fail(
              "GITHUB_BLOB_MISMATCH",
              "Git transport returned bytes outside the exact fixed blob/hash identity.",
              { path: file.path },
            ),
          )
        yield* checked(() => assertSupportedGitBlob(bytes))
      }
      return blobs
    }),
  )
}

export const FixedGitObjectReaderLive = Layer.effect(
  FixedGitObjectReader,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    return {
      read: (input: Input) =>
        readFixedGitObjects(input).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
    }
  }),
)
