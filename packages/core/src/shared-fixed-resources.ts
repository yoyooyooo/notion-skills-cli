import { ByteSize, Crypto, Effect, Exit, FileSystem, Option, Path, Schema, Stream } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { markLocalContentRestriction } from "./content-restrictions.ts"
import { fail, SkillsError } from "./model.ts"
import type { createRequestMetrics } from "./request-metrics.ts"
import { requestTimeoutMs } from "./request-timeout.ts"
import { composeSharedFiles } from "./shared-composition.ts"
import { sha256, Store } from "./store.ts"

export type FixedFile = {
  readonly path: string
  readonly sha256: string
  readonly bytes: number
}

/** Content identity contains neither a retrieval URL nor a machine's absolute path. */
export type FixedFileManifest = {
  readonly version: 1
  readonly files: readonly FixedFile[]
}

export type MaterializedFixedFile = {
  readonly path: string
  readonly sha256: string
  readonly bytes: Uint8Array
}

export type FixedHttpLocation = {
  readonly sha256: string
  readonly url: string
}

export type FixedHttpFilesInput = {
  readonly manifest: FixedFileManifest
  readonly locations: readonly FixedHttpLocation[]
}

export type LocalResourceScope = {
  readonly machine_scope: string
  readonly workspace_scope: string
}

export type FixedLocalResource = LocalResourceScope & {
  readonly binding_key: string
  readonly manifest: FixedFileManifest
}

/** Machine configuration only. Never serialize this object into a shared source fact. */
export type LocalResourceBinding = LocalResourceScope & {
  readonly binding_key: string
  readonly absolute_root: string
}

type Metrics = ReturnType<typeof createRequestMetrics>

export type HttpResourceOptions = {
  /** Trusted machine/user configuration, not a policy supplied by shared content. */
  readonly allowedOrigins?: readonly string[]
  readonly metrics?: Metrics
}

export type LocalResourceOptions = {
  readonly scope: LocalResourceScope
  readonly bindings: readonly LocalResourceBinding[]
}

export const MAX_FIXED_RESOURCE_FILE_BYTES = 64 * 1024 * 1024
export const MAX_FIXED_RESOURCE_TOTAL_BYTES = 256 * 1024 * 1024
const maximumFiles = 10_000
const defaultOrigins = ["https://raw.githubusercontent.com"]
const hashPattern = /^[a-f0-9]{64}$/u
const controls = /[\u0000-\u001f\u007f-\u009f]/u
const emptyBytes = new Uint8Array()
const compareFiles = (a: FixedFile, b: FixedFile) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0

const ManifestSchema = Schema.Struct({
  version: Schema.Literal(1),
  files: Schema.Array(
    Schema.Struct({ path: Schema.String, sha256: Schema.String, bytes: Schema.Number }),
  ),
})
const LocalSourceSchema = Schema.Struct({
  binding_key: Schema.String,
  machine_scope: Schema.String,
  workspace_scope: Schema.String,
  manifest: ManifestSchema,
})
const LocationsSchema = Schema.Array(Schema.Struct({ sha256: Schema.String, url: Schema.String }))

function checked<A>(
  operation: () => A,
  code = "INVALID_FIXED_RESOURCE",
): Effect.Effect<A, SkillsError> {
  return Effect.try({
    try: operation,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail(code, "The fixed resource descriptor is invalid."),
  })
}

/** Pure validation, including the same canonical/portable output-path rules as composition. */
export function validateFixedFileManifest(input: unknown): FixedFileManifest {
  let decoded: typeof ManifestSchema.Type
  try {
    decoded = Schema.decodeUnknownSync(ManifestSchema)(input, { onExcessProperty: "error" })
  } catch {
    throw fail(
      "INVALID_FIXED_FILE_MANIFEST",
      "A fixed file manifest requires version 1 and exact path/hash/byte-length entries.",
    )
  }
  if (decoded.files.length > maximumFiles) {
    throw fail(
      "INVALID_FIXED_FILE_MANIFEST",
      "The fixed file manifest exceeds the supported file count.",
    )
  }
  const sizes = new Map<string, number>()
  let total = 0
  for (const file of decoded.files) {
    if (
      !hashPattern.test(file.sha256) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      file.bytes > MAX_FIXED_RESOURCE_FILE_BYTES ||
      file.path.length > 4096
    ) {
      throw fail(
        "INVALID_FIXED_FILE_MANIFEST",
        "File hashes must be lowercase SHA-256 and byte lengths must fit the fixed-resource limits.",
      )
    }
    const previous = sizes.get(file.sha256)
    if (previous !== undefined && previous !== file.bytes) {
      throw fail(
        "INVALID_FIXED_FILE_MANIFEST",
        "One content hash cannot declare different byte lengths.",
      )
    }
    sizes.set(file.sha256, file.bytes)
    total += file.bytes
    if (total > MAX_FIXED_RESOURCE_TOTAL_BYTES) {
      throw fail(
        "INVALID_FIXED_FILE_MANIFEST",
        "The complete fixed file manifest exceeds the supported byte count.",
      )
    }
  }
  const first = decoded.files[0]
  if (first !== undefined) {
    composeSharedFiles({
      base: decoded.files.map((file) => ({ path: file.path, bytes: emptyBytes })),
      mounts: [],
      overrides: [],
      entrypoint: first.path,
    })
  }
  return {
    version: 1,
    files: decoded.files
      .map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.bytes }))
      .sort(compareFiles),
  }
}

/** Stable across retrieval-address changes; a path, length, or hash change produces a new identity. */
export function fixedFileManifestId(
  input: FixedFileManifest,
): Effect.Effect<string, SkillsError, Crypto.Crypto> {
  return Effect.gen(function* () {
    const manifest = yield* checked(() => validateFixedFileManifest(input))
    return `files-${yield* sha256(JSON.stringify(manifest))}`
  })
}

function verifyBytes(entry: FixedFile, bytes: Uint8Array, cached: boolean) {
  return Effect.gen(function* () {
    const invalid = cached ? "FIXED_RESOURCE_CACHE_CORRUPT" : "FIXED_RESOURCE_SIZE_MISMATCH"
    if (bytes.byteLength !== entry.bytes) {
      return yield* Effect.fail(
        fail(invalid, "Resource bytes do not match the fixed manifest length.", {
          path: entry.path,
        }),
      )
    }
    if ((yield* sha256(bytes)) !== entry.sha256) {
      return yield* Effect.fail(
        fail(
          cached ? "FIXED_RESOURCE_CACHE_CORRUPT" : "FIXED_RESOURCE_HASH_MISMATCH",
          "Resource bytes do not match the fixed manifest SHA-256.",
          { path: entry.path },
        ),
      )
    }
    return bytes
  })
}

function materialize<R>(
  manifest: FixedFileManifest,
  read: (entry: FixedFile) => Effect.Effect<Uint8Array, SkillsError, R>,
  localResource = false,
): Effect.Effect<readonly MaterializedFixedFile[], SkillsError, Store | Crypto.Crypto | R> {
  return Effect.gen(function* () {
    const store = yield* Store
    const unique = new Map<string, FixedFile>()
    for (const entry of manifest.files)
      if (!unique.has(entry.sha256)) unique.set(entry.sha256, entry)
    const objects = yield* Effect.forEach(
      [...unique.values()],
      (entry) =>
        Effect.gen(function* () {
          const key = `objects/${entry.sha256}`
          const cached = yield* store.readBytes(key).pipe(
            Effect.catchIf(
              (error) => error.code === "SNAPSHOT_MISSING",
              () => Effect.succeed(undefined),
            ),
          )
          if (cached !== undefined) {
            const bytes = yield* verifyBytes(entry, cached, true)
            if (localResource) yield* markLocalContentRestriction(entry.sha256)
            return { sha256: entry.sha256, bytes }
          }
          const bytes = yield* verifyBytes(entry, yield* read(entry), false)
          // Persist the restriction before publishing new local bytes. Cancellation can leave a
          // conservative marker, but must not expose a newly cached private object without one.
          if (localResource) yield* markLocalContentRestriction(entry.sha256)
          // The immutable object is published only after the complete body passes both checks.
          yield* store.writeBytes(key, bytes)
          return { sha256: entry.sha256, bytes }
        }),
      { concurrency: 4 },
    )
    const byHash = new Map(objects.map((object) => [object.sha256, object.bytes]))
    return yield* checked(() =>
      manifest.files.map((entry) => {
        const bytes = byHash.get(entry.sha256)
        if (bytes === undefined)
          throw fail(
            "FIXED_RESOURCE_INCOMPLETE",
            "The complete fixed resource could not be materialized.",
          )
        return { path: entry.path, sha256: entry.sha256, bytes }
      }),
    )
  })
}

function publicAddress(value: string, originOnly = false): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw fail("INVALID_HTTP_RESOURCE_URL", "Use a canonical public HTTPS resource URL.")
  }
  const labels = url.hostname.split(".")
  const suffix = labels.at(-1) ?? ""
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.hash !== "" ||
    labels.length < 2 ||
    !/[a-z]/u.test(suffix) ||
    !labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)) ||
    ["localhost", "local", "internal", "lan", "home", "test", "invalid", "onion"].includes(
      suffix,
    ) ||
    (originOnly ? url.origin !== value : url.href !== value)
  ) {
    throw fail(
      "INVALID_HTTP_RESOURCE_URL",
      "Only canonical HTTPS DNS origins without credentials, private/local names, IP literals, or extra ports are supported.",
    )
  }
  return url
}

function httpLocations(
  input: readonly FixedHttpLocation[],
  manifest: FixedFileManifest,
  options: HttpResourceOptions,
) {
  const allowed = new Set(
    (options.allowedOrigins ?? defaultOrigins).map((origin) => publicAddress(origin, true).origin),
  )
  let decoded: typeof LocationsSchema.Type
  try {
    decoded = Schema.decodeUnknownSync(LocationsSchema)(input, { onExcessProperty: "error" })
  } catch {
    throw fail(
      "INVALID_HTTP_RESOURCE_LOCATIONS",
      "HTTP retrieval locations must identify exactly one URL for each fixed content hash.",
    )
  }
  const required = new Set(manifest.files.map((file) => file.sha256))
  const result = new Map<string, string>()
  for (const location of decoded) {
    if (!required.has(location.sha256) || result.has(location.sha256)) {
      throw fail(
        "INVALID_HTTP_RESOURCE_LOCATIONS",
        "Missing, duplicate, or unrelated HTTP locations cannot define a fixed resource.",
      )
    }
    const url = publicAddress(location.url)
    if (!allowed.has(url.origin))
      throw fail(
        "HTTP_RESOURCE_ORIGIN_NOT_ALLOWED",
        "The retrieval origin is not authorized by this machine's resource policy.",
      )
    result.set(location.sha256, url.href)
  }
  if (result.size !== required.size)
    throw fail(
      "INVALID_HTTP_RESOURCE_LOCATIONS",
      "Every fixed content hash requires one explicit retrieval location.",
    )
  return result
}

function httpBytes(
  entry: FixedFile,
  url: string,
  metrics?: Metrics,
): Effect.Effect<Uint8Array, SkillsError, HttpClient.HttpClient | Crypto.Crypto> {
  return Effect.gen(function* () {
    const timeoutMs = yield* requestTimeoutMs
    const key = yield* sha256(JSON.stringify(["public-http", url, entry.sha256, entry.bytes]))
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const client = HttpClient.withScope(yield* HttpClient.HttpClient)
        let received: number | undefined
        const finish = metrics?.begin({
          path: new URL(url).pathname,
          method: "GET",
          provider: "http",
          key,
          requestBytes: 0,
        })
        return yield* Effect.gen(function* () {
          const response = yield* client.get(url, {
            headers: {
              accept: "application/octet-stream",
              "accept-encoding": "identity",
              "user-agent": "ntn-skills",
            },
          })
          yield* checked(() => {
            const expected = new URL(url)
            const actual = new URL(response.request.url)
            // HttpClient may hold query parameters separately from request.url.
            if (
              actual.origin !== expected.origin ||
              actual.pathname !== expected.pathname ||
              actual.username !== "" ||
              actual.password !== ""
            ) {
              throw fail(
                "HTTP_RESOURCE_SCOPE_CHANGED",
                "The HTTP client changed the fixed retrieval origin or path.",
              )
            }
          })
          if (response.status >= 300 && response.status < 400) {
            return yield* Effect.fail(
              fail(
                "HTTP_RESOURCE_REDIRECT_REFUSED",
                "Resource redirects are not followed; configure an authorized final URL explicitly.",
              ),
            )
          }
          if (response.status !== 200) {
            return yield* Effect.fail(
              fail(
                "HTTP_RESOURCE_UNAVAILABLE",
                "The fixed public resource is unavailable without provider authentication.",
                { status: response.status },
              ),
            )
          }
          const lengthHeader = response.headers["content-length"]
          const encoding = response.headers["content-encoding"]
          if (lengthHeader !== undefined && (encoding === undefined || encoding === "identity")) {
            if (
              !/^\d+$/u.test(lengthHeader) ||
              !Number.isSafeInteger(Number(lengthHeader)) ||
              Number(lengthHeader) !== entry.bytes
            ) {
              return yield* Effect.fail(
                fail(
                  "FIXED_RESOURCE_SIZE_MISMATCH",
                  "HTTP Content-Length does not match the fixed resource byte length.",
                ),
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
                if (next > entry.bytes)
                  return Effect.fail(
                    fail(
                      "FIXED_RESOURCE_SIZE_EXCEEDED",
                      "The HTTP response exceeded the fixed resource byte length.",
                    ),
                  )
                chunks.push(chunk)
                return Effect.succeed(next)
              },
            ),
          )
          if (length !== entry.bytes)
            return yield* Effect.fail(
              fail(
                "FIXED_RESOURCE_SIZE_MISMATCH",
                "The HTTP body ended before the fixed resource byte length.",
              ),
            )
          const bytes = new Uint8Array(length)
          let offset = 0
          for (const chunk of chunks) {
            bytes.set(chunk, offset)
            offset += chunk.byteLength
          }
          return bytes
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
      Effect.provideService(FetchHttpClient.RequestInit, {
        redirect: "manual",
        credentials: "omit",
      }),
      Effect.timeout(timeoutMs),
      Effect.mapError((error) =>
        error instanceof SkillsError
          ? error
          : fail(
              "HTTP_RESOURCE_REQUEST_FAILED",
              "The fixed public resource request failed or timed out.",
            ),
      ),
    )
  })
}

/**
 * Supply the standard Fetch client without credential, retry, or redirect middleware.
 * Extra allowed origins are trusted machine configuration. DNS names are not a DNS-rebinding sandbox.
 */
export function materializeFixedHttpFiles(
  input: FixedHttpFilesInput,
  options: HttpResourceOptions = {},
): Effect.Effect<
  readonly MaterializedFixedFile[],
  SkillsError,
  Store | Crypto.Crypto | HttpClient.HttpClient
> {
  return Effect.gen(function* () {
    const manifest = yield* checked(() => validateFixedFileManifest(input.manifest))
    const locations = yield* checked(() => httpLocations(input.locations, manifest, options))
    return yield* materialize(manifest, (entry) =>
      Effect.gen(function* () {
        const url = locations.get(entry.sha256)
        if (url === undefined)
          return yield* Effect.fail(
            fail("INVALID_HTTP_RESOURCE_LOCATIONS", "A fixed retrieval location is missing."),
          )
        return yield* httpBytes(entry, url, options.metrics)
      }),
    )
  })
}

function scopedId(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    !controls.test(value) &&
    !/[\\/]/u.test(value)
  )
}

function localConfiguration(input: FixedLocalResource, options: LocalResourceOptions) {
  let source: typeof LocalSourceSchema.Type
  try {
    source = Schema.decodeUnknownSync(LocalSourceSchema)(input, { onExcessProperty: "error" })
  } catch {
    throw fail(
      "INVALID_LOCAL_RESOURCE",
      "A local source may contain only its binding key, machine/workspace scope, and fixed manifest.",
    )
  }
  if (![source.binding_key, source.machine_scope, source.workspace_scope].every(scopedId)) {
    throw fail(
      "INVALID_LOCAL_RESOURCE",
      "Local binding and scope identifiers must be nonempty bounded identifiers.",
    )
  }
  if (
    options.scope.machine_scope !== source.machine_scope ||
    options.scope.workspace_scope !== source.workspace_scope
  ) {
    throw fail(
      "LOCAL_RESOURCE_SCOPE_MISMATCH",
      "This local resource belongs to another machine or workspace; no same-name fallback is allowed.",
    )
  }
  const matches = options.bindings.filter(
    (binding) =>
      binding.binding_key === source.binding_key &&
      binding.machine_scope === source.machine_scope &&
      binding.workspace_scope === source.workspace_scope,
  )
  if (matches.length === 0)
    throw fail(
      "LOCAL_RESOURCE_BINDING_MISSING",
      "No exact machine/workspace binding exists for this fixed local resource.",
    )
  if (matches.length !== 1)
    throw fail(
      "LOCAL_RESOURCE_BINDING_AMBIGUOUS",
      "The fixed local resource has multiple exact machine/workspace bindings.",
    )
  const binding = matches[0]
  if (
    binding === undefined ||
    typeof binding.absolute_root !== "string" ||
    binding.absolute_root.length === 0 ||
    controls.test(binding.absolute_root)
  ) {
    throw fail(
      "INVALID_LOCAL_RESOURCE_BINDING",
      "The machine binding requires a canonical absolute root.",
    )
  }
  return {
    manifest: validateFixedFileManifest(source.manifest),
    absoluteRoot: binding.absolute_root,
  }
}

type PathIdentity = { readonly path: string; readonly dev: bigint; readonly ino: bigint }

function identity(path: string, info: FileSystem.File.Info): PathIdentity {
  const ino = Option.getOrUndefined(info.ino)
  if (ino === undefined)
    throw fail(
      "LOCAL_RESOURCE_IDENTITY_UNAVAILABLE",
      "The local filesystem cannot establish file identity for a fixed resource.",
    )
  return { path, dev: info.dev, ino }
}

function localBytes(
  entry: FixedFile,
  absoluteRoot: string,
): Effect.Effect<Uint8Array, SkillsError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const timeoutMs = yield* requestTimeoutMs
    const target = path.join(absoluteRoot, ...entry.path.split("/"))
    const components: string[] = []
    let cursor = target
    while (true) {
      components.push(cursor)
      const parent = path.dirname(cursor)
      if (parent === cursor) break
      cursor = parent
    }
    components.reverse()
    const inspect = Effect.forEach(
      components,
      (component) =>
        Effect.gen(function* () {
          // stat follows links on Node. Canonical resolution, not stat.type, detects a linked component.
          if ((yield* fs.realPath(component)) !== component) {
            return yield* Effect.fail(
              fail(
                "LOCAL_RESOURCE_SYMLINK_REFUSED",
                "Local resource paths must not contain symbolic-link components.",
              ),
            )
          }
          const info = yield* fs.stat(component)
          if (info.type !== (component === target ? "File" : "Directory")) {
            return yield* Effect.fail(
              fail(
                "LOCAL_RESOURCE_NOT_REGULAR_FILE",
                "A fixed local resource must be a regular file beneath regular directories.",
              ),
            )
          }
          return yield* checked(() => identity(component, info))
        }),
      { concurrency: 1 },
    )
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const before = yield* inspect
        const handle = yield* fs.open(target, { flag: "r", noFollow: true })
        const opened = yield* handle.stat
        if (opened.type !== "File")
          return yield* Effect.fail(
            fail(
              "LOCAL_RESOURCE_NOT_REGULAR_FILE",
              "The opened local resource is not a regular file.",
            ),
          )
        if (ByteSize.toBigInt(opened.size) !== BigInt(entry.bytes)) {
          return yield* Effect.fail(
            fail(
              "FIXED_RESOURCE_SIZE_MISMATCH",
              "The opened local file size differs from its fixed manifest.",
            ),
          )
        }
        const fdIdentity = yield* checked(() => identity(target, opened))
        const verifyPaths = Effect.gen(function* () {
          const current = yield* inspect
          if (
            current.length !== before.length ||
            current.some((item, index) => {
              const prior = before[index]
              return (
                prior === undefined ||
                item.path !== prior.path ||
                item.dev !== prior.dev ||
                item.ino !== prior.ino
              )
            })
          )
            return yield* Effect.fail(
              fail(
                "LOCAL_RESOURCE_CHANGED",
                "The local resource path changed while its descriptor was being opened or read.",
              ),
            )
          const leaf = current.at(-1)
          if (leaf === undefined || leaf.dev !== fdIdentity.dev || leaf.ino !== fdIdentity.ino) {
            return yield* Effect.fail(
              fail(
                "LOCAL_RESOURCE_CHANGED",
                "The local resource name no longer identifies the opened descriptor.",
              ),
            )
          }
        })
        yield* verifyPaths
        const bytes = new Uint8Array(entry.bytes)
        let offset = 0
        while (offset < bytes.byteLength) {
          const view = bytes.subarray(offset, Math.min(offset + 64 * 1024, bytes.byteLength))
          const read = yield* handle.read(view)
          if (read <= 0 || read > view.byteLength)
            return yield* Effect.fail(
              fail(
                "FIXED_RESOURCE_SIZE_MISMATCH",
                "The local file ended before its fixed byte length.",
              ),
            )
          offset += read
        }
        if ((yield* handle.read(new Uint8Array(1))) !== 0) {
          return yield* Effect.fail(
            fail("FIXED_RESOURCE_SIZE_EXCEEDED", "The local file exceeded its fixed byte length."),
          )
        }
        const after = yield* handle.stat
        const afterIdentity = yield* checked(() => identity(target, after))
        if (
          after.type !== "File" ||
          ByteSize.toBigInt(after.size) !== BigInt(entry.bytes) ||
          afterIdentity.dev !== fdIdentity.dev ||
          afterIdentity.ino !== fdIdentity.ino
        ) {
          return yield* Effect.fail(
            fail("LOCAL_RESOURCE_CHANGED", "The opened local resource changed during its read."),
          )
        }
        yield* verifyPaths
        return bytes
      }),
    ).pipe(
      Effect.timeout(timeoutMs),
      Effect.mapError((error) =>
        error instanceof SkillsError
          ? error
          : fail(
              "LOCAL_RESOURCE_UNAVAILABLE",
              "The fixed local resource could not be read within its bound directory.",
            ),
      ),
    )
  })
}

/**
 * Scope and binding checks precede even cache reads. Misses use noFollow and a fixed descriptor.
 * This is a normal workspace boundary, not an openat sandbox against a same-UID adversary replacing directories concurrently.
 */
export function materializeFixedLocalFiles(
  input: FixedLocalResource,
  options: LocalResourceOptions,
): Effect.Effect<
  readonly MaterializedFixedFile[],
  SkillsError,
  Store | Crypto.Crypto | FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const selected = yield* checked(() => localConfiguration(input, options))
    const path = yield* Path.Path
    if (
      !path.isAbsolute(selected.absoluteRoot) ||
      path.resolve(selected.absoluteRoot) !== selected.absoluteRoot
    ) {
      return yield* Effect.fail(
        fail(
          "INVALID_LOCAL_RESOURCE_BINDING",
          "The machine binding root must already be a canonical absolute path.",
        ),
      )
    }
    return yield* materialize(
      selected.manifest,
      (entry) => localBytes(entry, selected.absoluteRoot),
      true,
    )
  })
}
