import { Crypto, Effect, FileSystem, Path, Schema } from "effect"
import type { HttpClient } from "effect/http"
import { localContentRestrictedHashes } from "./content-restrictions.ts"
import { fail, FileEntrySchema, SkillsError } from "./model.ts"
import type { createRequestMetrics } from "./request-metrics.ts"
import {
  composeSharedFiles,
  type CompositionFile,
  type CompositionMount,
} from "./shared-composition.ts"
import {
  fixedFileManifestId,
  materializeFixedHttpFiles,
  materializeFixedLocalFiles,
  MAX_FIXED_RESOURCE_FILE_BYTES,
  MAX_FIXED_RESOURCE_TOTAL_BYTES,
  validateFixedFileManifest,
  type FixedFileManifest,
  type FixedHttpLocation,
  type FixedLocalResource,
  type LocalResourceOptions,
} from "./shared-fixed-resources.ts"
import { validateFixedGithubSource, type FixedGithubSource } from "./shared-github-source.ts"
import { materializeFixedGithubSource } from "./shared-source-materialization.ts"
import { sha256, Store } from "./store.ts"

export type SourcePlanResource =
  | { readonly kind: "git"; readonly source: FixedGithubSource }
  | {
      readonly kind: "http"
      readonly manifest: FixedFileManifest
      readonly locations: readonly FixedHttpLocation[]
    }
  | ({ readonly kind: "local" } & FixedLocalResource)

export type SharedSourcePlan = {
  readonly version: 1
  readonly kind: "composition"
  readonly base: SourcePlanResource | null
  readonly mounts: readonly { readonly mount_path: string; readonly resource: SourcePlanResource }[]
}

export type SourcePlanInspection = {
  readonly plan: SharedSourcePlan
  /** Complete deterministic source paths, before Notion main/whole-file overrides. */
  readonly paths: readonly string[]
  /** Declared local paths. Materialization also includes existing restrictions from other plans. */
  readonly local_paths: readonly string[]
}

export type SharedSourcePlanOptions = {
  readonly metrics?: ReturnType<typeof createRequestMetrics>
  readonly http?: {
    /** Trusted machine/user policy only; never take this field from shared source content. */
    readonly allowedOrigins?: readonly string[]
    /** Keys are files-<SHA256> from fixedFileManifestId, not aliases or output basenames. */
    readonly locationsByManifest?: Readonly<Record<string, readonly FixedHttpLocation[]>>
  }
  /** Machine configuration only. Absolute roots never enter the shared plan or its identity. */
  readonly local?: LocalResourceOptions
}

export type MaterializedSourcePlan = {
  readonly source_plan_id: string
  readonly paths: readonly string[]
  readonly files: readonly CompositionFile[]
  readonly local_paths: readonly string[]
}

const FixedManifestSchema = Schema.Struct({
  version: Schema.Literal(1),
  files: Schema.Array(FileEntrySchema),
})
const GitSourceSchema = Schema.Struct({
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
const ResourceSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("git"), source: GitSourceSchema }),
  Schema.Struct({
    kind: Schema.Literal("http"),
    manifest: FixedManifestSchema,
    locations: Schema.Array(Schema.Struct({ sha256: Schema.String, url: Schema.String })),
  }),
  Schema.Struct({
    kind: Schema.Literal("local"),
    binding_key: Schema.String,
    machine_scope: Schema.String,
    workspace_scope: Schema.String,
    manifest: FixedManifestSchema,
  }),
])

export const SharedSourcePlanSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("composition"),
  base: Schema.NullOr(ResourceSchema),
  mounts: Schema.Array(Schema.Struct({ mount_path: Schema.String, resource: ResourceSchema })),
})

const emptyBytes = new Uint8Array()
const controls = /[\u0000-\u001f\u007f-\u009f]/u
const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)
const mountedPath = (mountPath: string, path: string) =>
  mountPath === "" ? path : `${mountPath}/${path}`

function checked<A>(operation: () => A): Effect.Effect<A, SkillsError> {
  return Effect.try({
    try: operation,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("INVALID_SOURCE_PLAN", "The fixed composition source plan is invalid."),
  })
}

function declaredFiles(
  resource: SourcePlanResource,
): readonly { readonly path: string; readonly bytes: number }[] {
  return resource.kind === "git" ? resource.source.files : resource.manifest.files
}

function initialLocations(
  input: readonly FixedHttpLocation[],
  manifest: FixedFileManifest,
): readonly FixedHttpLocation[] {
  const required = new Set(manifest.files.map((file) => file.sha256))
  const locations = new Map<string, FixedHttpLocation>()
  for (const location of input) {
    if (!required.has(location.sha256) || locations.has(location.sha256)) {
      throw fail(
        "INVALID_SOURCE_PLAN",
        "Initial HTTP locations must identify each fixed content hash exactly once.",
      )
    }
    let url: URL
    try {
      url = new URL(location.url)
    } catch {
      throw fail(
        "INVALID_SOURCE_PLAN",
        "Initial HTTP locations must be canonical public HTTPS URLs.",
      )
    }
    // Syntax only. Runtime origin authorization remains in the fixed HTTP reader.
    const labels = url.hostname.split(".")
    const suffix = labels.at(-1) ?? ""
    if (
      url.href !== location.url ||
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      url.hash !== "" ||
      labels.length < 2 ||
      !/[a-z]/u.test(suffix) ||
      !labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)) ||
      ["localhost", "local", "internal", "lan", "home", "test", "invalid", "onion"].includes(suffix)
    ) {
      throw fail(
        "INVALID_SOURCE_PLAN",
        "Initial HTTP locations must be canonical public HTTPS URLs without embedded credentials or local addresses.",
      )
    }
    locations.set(location.sha256, { sha256: location.sha256, url: location.url })
  }
  if (locations.size !== required.size)
    throw fail("INVALID_SOURCE_PLAN", "An initial HTTP retrieval location is missing.")
  return [...locations.values()].sort((left, right) => compare(left.sha256, right.sha256))
}

function normalizedResource(resource: SourcePlanResource): SourcePlanResource {
  switch (resource.kind) {
    case "git":
      return { kind: "git", source: validateFixedGithubSource(resource.source) }
    case "http": {
      const manifest = validateFixedFileManifest(resource.manifest)
      return { kind: "http", manifest, locations: initialLocations(resource.locations, manifest) }
    }
    case "local": {
      for (const id of [resource.binding_key, resource.machine_scope, resource.workspace_scope]) {
        if (
          id.length === 0 ||
          id.length > 256 ||
          id.trim() !== id ||
          controls.test(id) ||
          /[\\/]/u.test(id)
        ) {
          throw fail(
            "INVALID_SOURCE_PLAN",
            "Local resource binding and scope identifiers must be nonempty bounded identifiers.",
          )
        }
      }
      return {
        kind: "local",
        binding_key: resource.binding_key,
        machine_scope: resource.machine_scope,
        workspace_scope: resource.workspace_scope,
        manifest: validateFixedFileManifest(resource.manifest),
      }
    }
  }
}

function sourceTree(
  base: readonly CompositionFile[],
  mounts: readonly CompositionMount[],
): readonly CompositionFile[] {
  let entrypoint = base[0]?.path
  for (const mount of mounts) {
    // Even an empty fixed resource must not conceal an unsafe mount prefix.
    const probe = "source-plan-path-probe"
    composeSharedFiles({
      base: [],
      mounts: [{ mount_path: mount.mount_path, files: [{ path: probe, bytes: emptyBytes }] }],
      overrides: [],
      entrypoint: mountedPath(mount.mount_path, probe),
    })
    if (entrypoint === undefined && mount.files[0] !== undefined)
      entrypoint = mountedPath(mount.mount_path, mount.files[0].path)
  }
  if (entrypoint === undefined) return []
  return composeSharedFiles({ base, mounts, overrides: [], entrypoint }).files
}

/** Pure complete-layout preflight. No source discovery, provider request, or machine configuration read. */
export function inspectSharedSourcePlan(input: unknown): SourcePlanInspection {
  let decoded: typeof SharedSourcePlanSchema.Type
  try {
    decoded = Schema.decodeUnknownSync(SharedSourcePlanSchema)(input, { onExcessProperty: "error" })
  } catch {
    throw fail(
      "INVALID_SOURCE_PLAN",
      "Expected a version 1 composition plan with only fixed Git, HTTP, or scoped local resources.",
    )
  }
  const plan: SharedSourcePlan = {
    version: 1,
    kind: "composition",
    base: decoded.base === null ? null : normalizedResource(decoded.base),
    mounts: decoded.mounts
      .map((mount) => ({
        mount_path: mount.mount_path,
        resource: normalizedResource(mount.resource),
      }))
      .sort(
        (left, right) =>
          compare(left.mount_path, right.mount_path) ||
          compare(JSON.stringify(left.resource), JSON.stringify(right.resource)),
      ),
  }
  const resources = [
    ...(plan.base === null ? [] : [plan.base]),
    ...plan.mounts.map((mount) => mount.resource),
  ]
  let count = 0
  let total = 0
  for (const resource of resources) {
    for (const file of declaredFiles(resource)) {
      count++
      total += file.bytes
      if (
        count > 10_000 ||
        file.bytes > MAX_FIXED_RESOURCE_FILE_BYTES ||
        total > MAX_FIXED_RESOURCE_TOTAL_BYTES
      ) {
        throw fail(
          "SOURCE_PLAN_SIZE_EXCEEDED",
          "The complete composition exceeds the fixed-resource file or byte limits.",
        )
      }
    }
  }
  const placeholderFiles = (resource: SourcePlanResource) =>
    declaredFiles(resource).map((file) => ({ path: file.path, bytes: emptyBytes }))
  const files = sourceTree(
    plan.base === null ? [] : placeholderFiles(plan.base),
    plan.mounts.map((mount) => ({
      mount_path: mount.mount_path,
      files: placeholderFiles(mount.resource),
    })),
  )
  const localPaths: string[] = []
  if (plan.base?.kind === "local")
    localPaths.push(...plan.base.manifest.files.map((file) => file.path))
  for (const mount of plan.mounts) {
    if (mount.resource.kind === "local")
      localPaths.push(
        ...mount.resource.manifest.files.map((file) => mountedPath(mount.mount_path, file.path)),
      )
  }
  return { plan, paths: files.map((file) => file.path), local_paths: localPaths.sort(compare) }
}

export function validateSharedSourcePlan(input: unknown): SharedSourcePlan {
  return inspectSharedSourcePlan(input).plan
}

/** The plan ID is also its immutable revision; only explicitly selected plans are consumed. */
export function sharedSourcePlanId(
  input: SharedSourcePlan,
): Effect.Effect<string, SkillsError, Crypto.Crypto> {
  return Effect.gen(function* () {
    const plan = yield* checked(() => validateSharedSourcePlan(input))
    return `source-plan-${yield* sha256(JSON.stringify(plan))}`
  })
}

type Requirements =
  | Store
  | Crypto.Crypto
  | HttpClient.HttpClient
  | FileSystem.FileSystem
  | Path.Path
type ResolvedSourceFile = CompositionFile & { readonly sha256: string }

function resourceFiles(
  resource: SourcePlanResource,
  options: SharedSourcePlanOptions,
): Effect.Effect<readonly ResolvedSourceFile[], SkillsError, Requirements> {
  return Effect.gen(function* () {
    switch (resource.kind) {
      case "git":
        return yield* materializeFixedGithubSource(resource.source, { metrics: options.metrics })
      case "http": {
        const identity = yield* fixedFileManifestId(resource.manifest)
        return yield* materializeFixedHttpFiles(
          {
            manifest: resource.manifest,
            locations: options.http?.locationsByManifest?.[identity] ?? resource.locations,
          },
          { allowedOrigins: options.http?.allowedOrigins, metrics: options.metrics },
        )
      }
      case "local": {
        if (options.local === undefined)
          return yield* Effect.fail(
            fail(
              "SOURCE_PLAN_LOCAL_BINDING_REQUIRED",
              "This source plan requires explicit machine/workspace local bindings.",
            ),
          )
        const { kind: _kind, ...source } = resource
        return yield* materializeFixedLocalFiles(source, options.local)
      }
    }
  })
}

/**
 * Materialize a complete fixed source tree only. Notion main/whole-file overrides, snapshot publication,
 * archive permission, and execution permission belong to their existing separate workflows.
 */
export function materializeSharedSourcePlan(
  input: SharedSourcePlan,
  options: SharedSourcePlanOptions = {},
): Effect.Effect<MaterializedSourcePlan, SkillsError, Requirements> {
  return Effect.gen(function* () {
    const inspection = yield* checked(() => inspectSharedSourcePlan(input))
    const plan = inspection.plan
    if (
      options.local === undefined &&
      (plan.base?.kind === "local" || plan.mounts.some((mount) => mount.resource.kind === "local"))
    ) {
      return yield* Effect.fail(
        fail(
          "SOURCE_PLAN_LOCAL_BINDING_REQUIRED",
          "This source plan requires explicit machine/workspace local bindings.",
        ),
      )
    }
    const id = `source-plan-${yield* sha256(JSON.stringify(plan))}`
    const base = plan.base === null ? [] : yield* resourceFiles(plan.base, options)
    // Each resource already bounds body I/O at four. Serial resources preserve that total bound
    // and make later resources reuse completed immutable objects from earlier resources.
    const mounts = yield* Effect.forEach(
      plan.mounts,
      (mount) =>
        Effect.gen(function* () {
          return {
            mount_path: mount.mount_path,
            files: yield* resourceFiles(mount.resource, options),
          }
        }),
      { concurrency: 1 },
    )
    const files = yield* checked(() => sourceTree(base, mounts))
    if (
      files.length !== inspection.paths.length ||
      files.some((file, index) => file.path !== inspection.paths[index])
    ) {
      return yield* Effect.fail(
        fail(
          "SOURCE_PLAN_INCOMPLETE",
          "The materialized source paths differ from the complete fixed plan.",
        ),
      )
    }
    const hashes = new Map(base.map((file) => [file.path, file.sha256]))
    for (const mount of mounts) {
      for (const file of mount.files)
        hashes.set(mountedPath(mount.mount_path, file.path), file.sha256)
    }
    const actual = yield* checked(() =>
      files.map((file) => {
        const hash = hashes.get(file.path)
        if (hash === undefined)
          throw fail(
            "SOURCE_PLAN_INCOMPLETE",
            "A verified source object identity is missing from the complete plan.",
          )
        return { path: file.path, sha256: hash }
      }),
    )
    const restricted = new Set(
      yield* localContentRestrictedHashes(actual.map((file) => file.sha256)),
    )
    const localPaths = new Set(inspection.local_paths)
    for (const file of actual) if (restricted.has(file.sha256)) localPaths.add(file.path)
    return {
      source_plan_id: id,
      paths: inspection.paths,
      files,
      local_paths: [...localPaths].sort(compare),
    }
  })
}
