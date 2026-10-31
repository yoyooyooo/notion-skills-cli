import { Crypto, Effect, Exit, Schema, Stream } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { fail, SkillsError } from "./model.ts"
import { normalizePath } from "./ref.ts"
import type { createRequestMetrics } from "./request-metrics.ts"
import { requestTimeoutMs } from "./request-timeout.ts"

type RequestMetrics = ReturnType<typeof createRequestMetrics>

export type FixedGithubFile = {
  readonly path: string
  readonly source_path: string
  readonly git_oid: string
  /** Uncompressed Git blob byte length declared by the complete tree. */
  readonly bytes: number
}

export type FixedGithubSource = {
  readonly url: string
  readonly commit: string
  readonly root: string
  readonly tree: string
  readonly files: readonly FixedGithubFile[]
}

export type FixedGithubSourceInput = {
  readonly url: string
  readonly commit: string
  readonly root: string
  readonly metrics?: RequestMetrics
}

const CommitSchema = Schema.Struct({
  sha: Schema.String,
  tree: Schema.Struct({ sha: Schema.String }),
})
const TreeSchema = Schema.Struct({
  sha: Schema.String,
  truncated: Schema.Boolean,
  tree: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      mode: Schema.String,
      type: Schema.String,
      sha: Schema.String,
      size: Schema.optional(Schema.Number),
    }),
  ),
})
const PersistedSourceSchema = Schema.Struct({
  url: Schema.String,
  commit: Schema.String,
  root: Schema.String,
  tree: Schema.String,
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      source_path: Schema.String,
      git_oid: Schema.String,
      bytes: Schema.Number,
    }),
  ),
})
const oidPattern = /^[0-9a-f]{40}$/
const controlPattern = /[\u0000-\u001f\u007f-\u009f]/
const foldPath = (path: string) =>
  path.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC")
const comparePath = (a: { readonly path: string }, b: { readonly path: string }) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0

function headerInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

function checkedPath(input: string, code: string, allowEmpty = false): string {
  if (allowEmpty && input === "") return input
  try {
    if (input === "" || controlPattern.test(input) || normalizePath(input) !== input)
      throw new Error()
    encodeURIComponent(input)
    return input
  } catch {
    throw fail(
      code,
      "GitHub paths must be canonical relative paths without traversal or control characters.",
    )
  }
}

function fixedInput(input: Pick<FixedGithubSourceInput, "url" | "commit" | "root">) {
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]{1,100})$/.exec(
      input.url,
    )
  const owner = match?.[1]
  const repository = match?.[2]?.replace(/\.git$/, "")
  if (
    owner === undefined ||
    repository === undefined ||
    repository === "" ||
    repository === "." ||
    repository === ".." ||
    !/^[0-9a-fA-F]{40}$/.test(input.commit)
  ) {
    throw fail(
      "INVALID_GITHUB_SOURCE",
      "Use a public https://github.com/owner/repository URL and a full 40-character commit SHA.",
    )
  }
  const root = checkedPath(input.root, "INVALID_GITHUB_SOURCE", true)
  return {
    owner,
    repository,
    url: `https://github.com/${owner}/${repository}`,
    commit: input.commit.toLowerCase(),
    root,
  }
}

function registerPath(path: string, aliases: Map<string, string>) {
  checkedPath(path, "GITHUB_INVALID_PATH")
  let partial = ""
  for (const segment of path.split("/")) {
    if ([".git", ".ntn-skills.json"].includes(foldPath(segment))) {
      throw fail(
        "GITHUB_INVALID_PATH",
        "The selected source contains a reserved installation path.",
      )
    }
    partial = partial === "" ? segment : `${partial}/${segment}`
    const key = foldPath(partial)
    const existing = aliases.get(key)
    if (existing !== undefined && existing !== partial) {
      throw fail(
        "GITHUB_PATH_COLLISION",
        "Selected GitHub paths collide under case or Unicode normalization.",
      )
    }
    aliases.set(key, partial)
  }
}

function rejectFileDirectoryCollisions(files: readonly FixedGithubFile[]) {
  const filePaths = new Set(files.map((file) => file.path))
  for (const file of files) {
    const segments = file.path.split("/")
    for (let index = 1; index < segments.length; index += 1) {
      if (filePaths.has(segments.slice(0, index).join("/"))) {
        throw fail(
          "GITHUB_PATH_COLLISION",
          "The GitHub tree contains conflicting file and directory paths.",
        )
      }
    }
  }
}

/** Decode a persisted fixed descriptor without contacting GitHub or choosing a newer revision. */
export function validateFixedGithubSource(input: unknown): FixedGithubSource {
  let decoded: typeof PersistedSourceSchema.Type
  try {
    decoded = Schema.decodeUnknownSync(PersistedSourceSchema)(input)
  } catch {
    throw fail(
      "INVALID_GITHUB_SOURCE",
      "The stored GitHub source descriptor is incomplete or invalid.",
    )
  }
  const fixed = fixedInput(decoded)
  if (
    fixed.url !== decoded.url ||
    fixed.commit !== decoded.commit ||
    !oidPattern.test(decoded.tree)
  ) {
    throw fail(
      "INVALID_GITHUB_SOURCE",
      "Stored GitHub descriptors require canonical URLs and lowercase full commit and tree object IDs.",
    )
  }
  const seen = new Set<string>()
  const aliases = new Map<string, string>()
  const files: FixedGithubFile[] = []
  for (const file of decoded.files) {
    registerPath(file.path, aliases)
    checkedPath(file.source_path, "GITHUB_INVALID_PATH")
    const expected = fixed.root === "" ? file.path : `${fixed.root}/${file.path}`
    if (
      file.source_path !== expected ||
      !oidPattern.test(file.git_oid) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0
    ) {
      throw fail(
        "INVALID_GITHUB_SOURCE",
        "A stored GitHub file lies outside its selected root or has an invalid object ID or byte length.",
      )
    }
    if (seen.has(file.path))
      throw fail("GITHUB_DUPLICATE_PATH", "The stored GitHub source contains duplicate file paths.")
    seen.add(file.path)
    files.push({
      path: file.path,
      source_path: file.source_path,
      git_oid: file.git_oid,
      bytes: file.bytes,
    })
  }
  rejectFileDirectoryCollisions(files)
  return {
    url: fixed.url,
    commit: fixed.commit,
    root: fixed.root,
    tree: decoded.tree,
    files: files.sort(comparePath),
  }
}

function checked<A>(operation: () => A): Effect.Effect<A, SkillsError> {
  return Effect.try({
    try: operation,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("GITHUB_INVALID_RESPONSE", "GitHub returned an invalid source response."),
  })
}

function json<A>(bytes: Uint8Array, decode: (input: unknown) => A): Effect.Effect<A, SkillsError> {
  return Effect.try({
    try: () => {
      const input: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
      return decode(input)
    },
    catch: () =>
      fail("GITHUB_INVALID_RESPONSE", "GitHub returned incomplete or invalid JSON metadata."),
  })
}

/** One transport attempt. Supply the standard Fetch-backed client without retry or redirect middleware. */
function getBytes(
  url: string,
  options: {
    readonly key: string
    readonly limit: number
    readonly expected?: number
    readonly metrics?: RequestMetrics
  },
): Effect.Effect<Uint8Array, SkillsError, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const timeoutMs = yield* requestTimeoutMs
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const client = HttpClient.withScope(yield* HttpClient.HttpClient)
        let received: number | undefined
        const finish = options.metrics?.begin({
          path: new URL(url).pathname,
          method: "GET",
          provider: "github",
          key: options.key,
          requestBytes: 0,
        })
        return yield* Effect.gen(function* () {
          const response = yield* client.get(url, {
            headers: {
              accept:
                options.expected === undefined
                  ? "application/vnd.github+json"
                  : "application/octet-stream",
              "accept-encoding": "identity",
              "user-agent": "ntn-skills",
              ...(options.expected === undefined ? { "x-github-api-version": "2022-11-28" } : {}),
            },
          })
          yield* checked(() => {
            const expected = new URL(url)
            const actual = new URL(response.request.url)
            if (
              actual.origin !== expected.origin ||
              actual.pathname !== expected.pathname ||
              actual.username !== "" ||
              actual.password !== ""
            ) {
              throw fail(
                "GITHUB_REQUEST_SCOPE_CHANGED",
                "The HTTP client changed the fixed GitHub request scope.",
              )
            }
          })
          if (response.status >= 300 && response.status < 400) {
            return yield* Effect.fail(
              fail(
                "GITHUB_REDIRECT_REFUSED",
                "GitHub source redirects are not followed; configure the final public repository URL explicitly.",
              ),
            )
          }
          const retryAfterHeader = response.headers["retry-after"]
          if (
            response.status === 429 ||
            (response.status === 403 &&
              (response.headers["x-ratelimit-remaining"] === "0" || retryAfterHeader !== undefined))
          ) {
            const retryAfter = headerInteger(retryAfterHeader)
            const reset = headerInteger(response.headers["x-ratelimit-reset"])
            return yield* Effect.fail(
              fail(
                "GITHUB_RATE_LIMITED",
                "GitHub rate limit was reached; wait before retrying the same fixed request.",
                {
                  status: response.status,
                  ...(retryAfter === undefined ? {} : { retry_after: retryAfter }),
                  ...(reset === undefined ? {} : { reset }),
                },
              ),
            )
          }
          if (response.status !== 200) {
            return yield* Effect.fail(
              fail(
                [401, 403, 404].includes(response.status)
                  ? "GITHUB_PUBLIC_SOURCE_UNAVAILABLE"
                  : "GITHUB_HTTP_ERROR",
                "The fixed public GitHub source could not be read. Private repositories and authenticated provider access are not supported by this reader.",
                { status: response.status },
              ),
            )
          }
          const contentLength = response.headers["content-length"]
          const encoding = response.headers["content-encoding"]
          if (contentLength !== undefined && (encoding === undefined || encoding === "identity")) {
            const length = Number(contentLength)
            if (!/^\d+$/.test(contentLength) || !Number.isSafeInteger(length) || length < 0) {
              return yield* Effect.fail(
                fail("GITHUB_INVALID_RESPONSE", "GitHub returned an invalid Content-Length."),
              )
            }
            if (options.expected !== undefined && length !== options.expected) {
              return yield* Effect.fail(
                fail(
                  "GITHUB_SIZE_MISMATCH",
                  "The response length differs from the fixed Git tree blob size.",
                ),
              )
            }
            if (length > options.limit) {
              return yield* Effect.fail(
                fail("GITHUB_SIZE_EXCEEDED", "The GitHub response exceeds the allowed byte count."),
              )
            }
          }
          const chunks: Uint8Array[] = []
          received = 0
          const length = yield* response.stream.pipe(
            Stream.runFoldEffect(
              () => 0,
              (length, chunk) => {
                const next = length + chunk.byteLength
                received = next
                if (next > options.limit) {
                  return Effect.fail(
                    fail(
                      "GITHUB_SIZE_EXCEEDED",
                      "The streamed GitHub response exceeds the declared byte count.",
                    ),
                  )
                }
                chunks.push(chunk)
                return Effect.succeed(next)
              },
            ),
          )
          if (options.expected !== undefined && length !== options.expected) {
            return yield* Effect.fail(
              fail(
                "GITHUB_SIZE_MISMATCH",
                "The GitHub body ended before the fixed Git tree blob size.",
              ),
            )
          }
          return yield* checked(() => {
            const bytes = new Uint8Array(length)
            let offset = 0
            for (const chunk of chunks) {
              bytes.set(chunk, offset)
              offset += chunk.byteLength
            }
            return bytes
          })
        }).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() =>
              finish?.({
                outcome: Exit.isSuccess(exit)
                  ? "success"
                  : Exit.hasInterrupts(exit)
                    ? "cancelled"
                    : "failure",
                ...(received === undefined ? {} : { responseBytes: received }),
              }),
            ),
          ),
        )
      }),
    ).pipe(
      // Native fetch follows redirects by default. Do not inherit browser cookies or other credentials.
      Effect.provideService(FetchHttpClient.RequestInit, {
        redirect: "manual",
        credentials: "omit",
      }),
      Effect.timeout(timeoutMs),
      Effect.mapError((error) =>
        error instanceof SkillsError
          ? error
          : fail("GITHUB_REQUEST_FAILED", "The fixed public GitHub request failed or timed out."),
      ),
    )
  })
}

function selectedFiles(
  source: ReturnType<typeof fixedInput>,
  tree: typeof TreeSchema.Type,
): readonly FixedGithubFile[] {
  if (tree.truncated)
    throw fail(
      "GITHUB_TREE_INCOMPLETE",
      "GitHub truncated the recursive tree; a partial tree cannot define the source.",
    )
  const prefix = source.root === "" ? "" : `${source.root}/`
  const seen = new Set<string>()
  const aliases = new Map<string, string>()
  const files: FixedGithubFile[] = []
  const unsupported: { path: string; type: string; mode: string }[] = []
  let foundRoot = source.root === ""
  for (const entry of tree.tree) {
    checkedPath(entry.path, "GITHUB_INVALID_PATH")
    if (seen.has(entry.path))
      throw fail("GITHUB_DUPLICATE_PATH", "The GitHub tree contains duplicate paths.")
    seen.add(entry.path)
    if (entry.path === source.root) {
      if (entry.type !== "tree" || entry.mode !== "040000") {
        throw fail(
          "GITHUB_ROOT_NOT_DIRECTORY",
          "The configured GitHub source root is not a directory.",
        )
      }
      foundRoot = true
    }
    if (!entry.path.startsWith(prefix) || entry.path === source.root) continue
    const path = entry.path.slice(prefix.length)
    registerPath(path, aliases)
    if (entry.type === "tree" && entry.mode === "040000") continue
    if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) {
      unsupported.push({ path, type: entry.type, mode: entry.mode })
      continue
    }
    if (
      !oidPattern.test(entry.sha) ||
      entry.size === undefined ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0
    ) {
      throw fail(
        "GITHUB_INVALID_RESPONSE",
        "A selected Git blob has an invalid object ID or declared size.",
      )
    }
    files.push({ path, source_path: entry.path, git_oid: entry.sha, bytes: entry.size })
  }
  if (!foundRoot)
    throw fail(
      "GITHUB_ROOT_NOT_FOUND",
      "The configured root is absent from the complete GitHub tree.",
    )
  if (unsupported.length > 0) {
    throw fail(
      "GITHUB_UNSUPPORTED_ENTRIES",
      "Selected symlinks, submodules, and unsupported Git modes require explicit resolution.",
      {
        entries: unsupported.sort(comparePath),
      },
    )
  }
  rejectFileDirectoryCollisions(files)
  return files.sort(comparePath)
}

/** Inspect a complete pinned tree. This never downloads file bodies or clones a repository. */
export function inspectFixedGithubSource(
  input: FixedGithubSourceInput,
): Effect.Effect<FixedGithubSource, SkillsError, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const source = yield* checked(() => fixedInput(input))
    const api = `https://api.github.com/repos/${source.owner}/${source.repository}/git`
    const scope = [
      "github-public",
      source.owner.toLowerCase(),
      source.repository.toLowerCase(),
      source.commit,
    ]
    const commitBytes = yield* getBytes(`${api}/commits/${source.commit}`, {
      key: JSON.stringify([...scope, "commit"]),
      limit: 2 * 1024 * 1024,
      ...(input.metrics === undefined ? {} : { metrics: input.metrics }),
    })
    const commit = yield* json(commitBytes, Schema.decodeUnknownSync(CommitSchema))
    if (commit.sha !== source.commit) {
      return yield* Effect.fail(
        fail(
          "GITHUB_COMMIT_MISMATCH",
          "GitHub returned a commit other than the explicitly pinned revision.",
        ),
      )
    }
    if (!oidPattern.test(commit.tree.sha)) {
      return yield* Effect.fail(
        fail("GITHUB_INVALID_RESPONSE", "The pinned commit did not identify a valid Git tree."),
      )
    }
    const treeBytes = yield* getBytes(`${api}/trees/${commit.tree.sha}?recursive=1`, {
      key: JSON.stringify([...scope, "tree", commit.tree.sha, "recursive"]),
      // GitHub documents a 7 MB recursive-tree limit. Leave room for JSON framing, then reject truncation explicitly.
      limit: 8 * 1024 * 1024,
      ...(input.metrics === undefined ? {} : { metrics: input.metrics }),
    })
    const tree = yield* json(treeBytes, Schema.decodeUnknownSync(TreeSchema))
    if (tree.sha !== commit.tree.sha) {
      return yield* Effect.fail(
        fail("GITHUB_TREE_MISMATCH", "GitHub returned a tree other than the pinned commit's tree."),
      )
    }
    const files = yield* checked(() => selectedFiles(source, tree))
    return { url: source.url, commit: source.commit, root: source.root, tree: tree.sha, files }
  })
}

/** Git hashes the object header and exact bytes, without text normalization. */
export function gitBlobOid(bytes: Uint8Array): Effect.Effect<string, SkillsError, Crypto.Crypto> {
  return Effect.gen(function* () {
    const blob = yield* checked(() => {
      const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`)
      const blob = new Uint8Array(header.byteLength + bytes.byteLength)
      blob.set(header)
      blob.set(bytes, header.byteLength)
      return blob
    })
    const digest = yield* (yield* Crypto.Crypto)
      .digest("SHA-1", blob)
      .pipe(
        Effect.mapError(() =>
          fail("CRYPTO_ERROR", "Could not verify the fixed Git blob identity."),
        ),
      )
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")
  })
}

/** Download one inspected blob, preserve its bytes, and verify Git's SHA-1 blob identity. */
export function fetchFixedGithubFile(
  source: FixedGithubSource,
  entry: FixedGithubFile,
  options: { readonly metrics?: RequestMetrics } = {},
): Effect.Effect<Uint8Array, SkillsError, HttpClient.HttpClient | Crypto.Crypto> {
  return Effect.gen(function* () {
    const fixed = yield* checked(() => fixedInput(source))
    yield* checked(() => {
      const matches = source.files.filter(
        (file) =>
          file.path === entry.path &&
          file.source_path === entry.source_path &&
          file.git_oid === entry.git_oid &&
          file.bytes === entry.bytes,
      )
      const expectedSourcePath = fixed.root === "" ? entry.path : `${fixed.root}/${entry.path}`
      if (
        matches.length !== 1 ||
        entry.source_path !== expectedSourcePath ||
        !oidPattern.test(entry.git_oid) ||
        !Number.isSafeInteger(entry.bytes) ||
        entry.bytes < 0
      ) {
        throw fail(
          "GITHUB_FILE_NOT_SELECTED",
          "Only an unchanged entry from the inspected source root can be fetched.",
        )
      }
      checkedPath(entry.path, "GITHUB_FILE_NOT_SELECTED")
      checkedPath(entry.source_path, "GITHUB_FILE_NOT_SELECTED")
    })
    const encodedPath = entry.source_path.split("/").map(encodeURIComponent).join("/")
    const bytes = yield* getBytes(
      `https://raw.githubusercontent.com/${fixed.owner}/${fixed.repository}/${fixed.commit}/${encodedPath}`,
      {
        key: JSON.stringify([
          "github-public",
          fixed.owner.toLowerCase(),
          fixed.repository.toLowerCase(),
          fixed.commit,
          "blob",
          entry.source_path,
        ]),
        limit: entry.bytes,
        expected: entry.bytes,
        ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
      },
    )
    const oid = yield* gitBlobOid(bytes)
    if (oid !== entry.git_oid) {
      return yield* Effect.fail(
        fail(
          "GITHUB_BLOB_MISMATCH",
          "The downloaded bytes do not match the fixed Git tree blob identity.",
        ),
      )
    }
    return bytes
  })
}
