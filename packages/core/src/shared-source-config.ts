import { Crypto, Effect, FileSystem, Path, Schema } from "effect"
import { ConfigSchema, fail, SkillsError } from "./model.ts"
import {
  fixedFileManifestId,
  validateFixedFileManifest,
  validateFixedHttpLocations,
  validateHttpResourceOrigins,
} from "./shared-fixed-resources.ts"
import {
  publicSourceResourceConfiguration,
  SourceResourceConfigurationSchema,
  type SourceResourceConfiguration,
} from "./shared-source-config-model.ts"
import type { SharedSourcePlanOptions } from "./shared-source-plan.ts"
import { Store } from "./store.ts"

const defaultOrigins = ["https://raw.githubusercontent.com"]
const ManifestId = /^files-[a-f0-9]{64}$/u
const LocationsSchema = Schema.Array(Schema.Struct({ sha256: Schema.String, url: Schema.String }))

function checked<A>(operation: () => A): Effect.Effect<A, SkillsError> {
  return Effect.try({
    try: operation,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail(
            "SOURCE_RESOURCE_CONFIG_INVALID",
            "The machine source-resource configuration is invalid.",
          ),
  })
}

function validateConfiguration(value: unknown): SourceResourceConfiguration {
  const config = Schema.decodeUnknownSync(SourceResourceConfigurationSchema)(value, {
    onExcessProperty: "error",
  })
  const scopes = new Set<string>(),
    roots = new Set<string>()
  for (const workspace of config.workspaces) {
    if (
      !workspace.absolute_root ||
      scopes.has(workspace.workspace_scope) ||
      roots.has(workspace.absolute_root) ||
      new Set(workspace.bindings.map((binding) => binding.binding_key)).size !==
        workspace.bindings.length ||
      workspace.bindings.some((binding) => binding.absolute_root.length === 0)
    )
      throw fail(
        "SOURCE_RESOURCE_CONFIG_INVALID",
        "Machine workspaces require unique scopes, roots, and binding keys.",
      )
    scopes.add(workspace.workspace_scope)
    roots.add(workspace.absolute_root)
  }
  const origins = validateHttpResourceOrigins(config.http.allowed_origins)
  for (const [manifestId, locations] of Object.entries(config.http.locations_by_manifest)) {
    if (!ManifestId.test(manifestId))
      throw fail(
        "SOURCE_RESOURCE_CONFIG_INVALID",
        "HTTP overrides must use an exact fixed-file manifest identity.",
      )
    // Shape/policy only; consumption checks this mapping against the complete actual manifest.
    validateFixedHttpLocations(
      locations,
      {
        version: 1,
        files: locations.map((location, index) => ({
          path: `objects/${index}`,
          sha256: location.sha256,
          bytes: 0,
        })),
      },
      { allowedOrigins: origins },
    )
  }
  return { ...config, http: { ...config.http, allowed_origins: origins } }
}

function readConfiguration() {
  return Effect.gen(function* () {
    const raw = yield* (yield* Store).readJson("config.json", Schema.Unknown)
    return yield* checked(() => {
      if (raw === undefined)
        return { raw: { sources: [] } as Record<string, unknown>, resources: undefined }
      if (raw === null || typeof raw !== "object" || Array.isArray(raw))
        throw fail("SOURCE_RESOURCE_CONFIG_INVALID", "The machine configuration must be an object.")
      Schema.decodeUnknownSync(ConfigSchema)(raw)
      const object: Record<string, unknown> = { ...raw }
      return {
        raw: object,
        resources:
          object.source_resources === undefined
            ? undefined
            : validateConfiguration(object.source_resources),
      }
    })
  })
}

function initialized(config: SourceResourceConfiguration | undefined, machineScope?: string) {
  return Effect.gen(function* () {
    if (config !== undefined) {
      if (machineScope !== undefined && machineScope !== config.machine_scope)
        return yield* Effect.fail(
          fail(
            "LOCAL_RESOURCE_SCOPE_MISMATCH",
            "An existing machine scope cannot be replaced when registering a local binding.",
          ),
        )
      return config
    }
    const generated =
      machineScope ??
      `machine-${yield* (yield* Crypto.Crypto)
        .randomUUIDv4()
        .pipe(
          Effect.mapError(() =>
            fail("CRYPTO_ERROR", "Could not establish the machine source-resource identity."),
          ),
        )}`
    return yield* checked(() =>
      validateConfiguration({
        version: 1,
        machine_scope: generated,
        workspaces: [],
        http: { allowed_origins: defaultOrigins, locations_by_manifest: {} },
      }),
    )
  })
}

function persist(raw: Record<string, unknown>, resources: SourceResourceConfiguration) {
  return Effect.gen(function* () {
    const verified = yield* checked(() => validateConfiguration(resources))
    yield* (yield* Store).writeJson("config.json", { ...raw, source_resources: verified })
    return publicSourceResourceConfiguration(verified)
  })
}

export function sharedSourceResourceConfiguration() {
  return readConfiguration().pipe(
    Effect.map(({ resources }) =>
      resources === undefined
        ? {
            configured: false as const,
            http: { allowed_origins: defaultOrigins, location_overrides: [] },
          }
        : { configured: true as const, ...publicSourceResourceConfiguration(resources) },
    ),
  )
}

function directory(input: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path
    const root = yield* fs
      .realPath(path.resolve(input))
      .pipe(
        Effect.mapError(() =>
          fail(
            "SOURCE_RESOURCE_ROOT_UNAVAILABLE",
            "The explicitly configured resource or workspace root is unavailable.",
          ),
        ),
      )
    const stat = yield* fs
      .stat(root)
      .pipe(
        Effect.mapError(() =>
          fail("SOURCE_RESOURCE_ROOT_UNAVAILABLE", "The configured root could not be inspected."),
        ),
      )
    if (stat.type !== "Directory")
      return yield* Effect.fail(
        fail(
          "SOURCE_RESOURCE_ROOT_UNAVAILABLE",
          "Source-resource bindings require an existing directory root.",
        ),
      )
    return root
  })
}

/** Explicit machine configuration. Absolute paths never enter a shared source payload. */
export function bindSharedLocalResource(input: {
  readonly bindingKey: string
  readonly workspaceScope: string
  readonly workspaceRoot: string
  readonly root: string
  readonly machineScope?: string
}) {
  return Effect.gen(function* () {
    const current = yield* readConfiguration()
    const config = yield* initialized(current.resources, input.machineScope)
    const workspaceRoot = yield* directory(input.workspaceRoot)
    const resourceRoot = yield* directory(input.root)
    const existing = config.workspaces.find(
      (workspace) => workspace.workspace_scope === input.workspaceScope,
    )
    const workspace = {
      workspace_scope: input.workspaceScope,
      absolute_root: workspaceRoot,
      bindings: [
        ...(existing?.bindings ?? []).filter((binding) => binding.binding_key !== input.bindingKey),
        { binding_key: input.bindingKey, absolute_root: resourceRoot },
      ].sort((a, b) =>
        a.binding_key < b.binding_key ? -1 : a.binding_key > b.binding_key ? 1 : 0,
      ),
    }
    const next = {
      ...config,
      workspaces: [
        ...config.workspaces.filter((item) => item.workspace_scope !== input.workspaceScope),
        workspace,
      ].sort((a, b) =>
        a.workspace_scope < b.workspace_scope ? -1 : a.workspace_scope > b.workspace_scope ? 1 : 0,
      ),
    }
    yield* persist(current.raw, next)
    return {
      machine_scope: config.machine_scope,
      workspace_scope: input.workspaceScope,
      binding_key: input.bindingKey,
      configured: true as const,
    }
  })
}

export function unbindSharedLocalResource(input: {
  readonly workspaceScope: string
  readonly bindingKey: string
}) {
  return Effect.gen(function* () {
    const current = yield* readConfiguration(),
      config = current.resources
    const workspace = config?.workspaces.find(
      (item) => item.workspace_scope === input.workspaceScope,
    )
    if (
      config === undefined ||
      workspace === undefined ||
      !workspace.bindings.some((binding) => binding.binding_key === input.bindingKey)
    )
      return yield* Effect.fail(
        fail(
          "LOCAL_RESOURCE_BINDING_MISSING",
          "The exact workspace and binding key are not configured on this machine.",
        ),
      )
    return yield* persist(current.raw, {
      ...config,
      workspaces: config.workspaces.map((item) =>
        item.workspace_scope !== input.workspaceScope
          ? item
          : {
              ...item,
              bindings: item.bindings.filter((binding) => binding.binding_key !== input.bindingKey),
            },
      ),
    })
  })
}

/** Replace authorized origins explicitly. Empty means deny all HTTP resources. */
export function configureSharedHttpOrigins(origins: readonly string[]) {
  return Effect.gen(function* () {
    const checkedOrigins = yield* checked(() => validateHttpResourceOrigins(origins))
    const current = yield* readConfiguration(),
      config = yield* initialized(current.resources)
    const locations = Object.fromEntries(
      Object.entries(config.http.locations_by_manifest).filter(([, values]) =>
        values.every((value) => checkedOrigins.includes(new URL(value.url).origin)),
      ),
    )
    return yield* persist(current.raw, {
      ...config,
      http: { allowed_origins: checkedOrigins, locations_by_manifest: locations },
    })
  })
}

export function configureSharedHttpLocations(input: {
  readonly manifest: unknown
  readonly locations: unknown
}) {
  return Effect.gen(function* () {
    const current = yield* readConfiguration(),
      config = yield* initialized(current.resources)
    const manifest = yield* checked(() => validateFixedFileManifest(input.manifest))
    const locations = yield* checked(() =>
      validateFixedHttpLocations(
        Schema.decodeUnknownSync(LocationsSchema)(input.locations, { onExcessProperty: "error" }),
        manifest,
        { allowedOrigins: config.http.allowed_origins },
      ),
    )
    const manifestId = yield* fixedFileManifestId(manifest)
    yield* persist(current.raw, {
      ...config,
      http: {
        ...config.http,
        locations_by_manifest: {
          ...config.http.locations_by_manifest,
          [manifestId]: locations,
        },
      },
    })
    return { manifest_id: manifestId, object_count: locations.length, configured: true as const }
  })
}

export function clearSharedHttpLocations(manifestId: string) {
  return Effect.gen(function* () {
    if (!ManifestId.test(manifestId))
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "Select an exact files manifest identity."),
      )
    const current = yield* readConfiguration(),
      config = current.resources
    if (config === undefined || config.http.locations_by_manifest[manifestId] === undefined)
      return yield* Effect.fail(
        fail(
          "SOURCE_RESOURCE_LOCATIONS_MISSING",
          "No retrieval override exists for this exact manifest.",
        ),
      )
    return yield* persist(current.raw, {
      ...config,
      http: {
        ...config.http,
        locations_by_manifest: Object.fromEntries(
          Object.entries(config.http.locations_by_manifest).filter(([key]) => key !== manifestId),
        ),
      },
    })
  })
}

/** Scope comes from the actual machine/workspace, never a shared plan's claimed identities. */
export type LoadedSharedSourceOptions = SharedSourcePlanOptions & {
  readonly http: NonNullable<SharedSourcePlanOptions["http"]>
}
export function loadSharedSourceOptions(
  input: { readonly localRequired?: boolean; readonly cwd?: string } = {},
): Effect.Effect<
  LoadedSharedSourceOptions,
  SkillsError,
  Store | FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const { resources } = yield* readConfiguration()
    const http: NonNullable<SharedSourcePlanOptions["http"]> =
      resources === undefined
        ? { allowedOrigins: defaultOrigins, locationsByManifest: {} }
        : {
            allowedOrigins: resources.http.allowed_origins,
            locationsByManifest: resources.http.locations_by_manifest,
          }
    if (!input.localRequired) return { http } satisfies SharedSourcePlanOptions
    if (resources === undefined)
      return yield* Effect.fail(
        fail(
          "LOCAL_RESOURCE_BINDING_MISSING",
          "Register an explicit machine/workspace local binding before consuming this source.",
        ),
      )
    const path = yield* Path.Path
    const cwd = yield* directory(input.cwd ?? ".")
    const candidates = yield* checked(() =>
      resources.workspaces
        .filter((workspace) => {
          if (
            !path.isAbsolute(workspace.absolute_root) ||
            path.normalize(workspace.absolute_root) !== workspace.absolute_root ||
            workspace.bindings.some(
              (binding) =>
                !path.isAbsolute(binding.absolute_root) ||
                path.normalize(binding.absolute_root) !== binding.absolute_root,
            )
          )
            throw fail(
              "SOURCE_RESOURCE_CONFIG_INVALID",
              "Configured local roots must be canonical absolute paths.",
            )
          const relative = path.relative(workspace.absolute_root, cwd)
          return (
            relative === "" ||
            (!path.isAbsolute(relative) &&
              relative !== ".." &&
              !relative.startsWith(`..${path.sep}`))
          )
        })
        .sort((a, b) => b.absolute_root.length - a.absolute_root.length),
    )
    const workspace = candidates[0]
    if (workspace === undefined)
      return yield* Effect.fail(
        fail(
          "LOCAL_RESOURCE_WORKSPACE_UNBOUND",
          "The current workspace has no explicit local resource bindings; a same-named binding elsewhere cannot be substituted.",
        ),
      )
    const scope = {
      machine_scope: resources.machine_scope,
      workspace_scope: workspace.workspace_scope,
    }
    return {
      http,
      local: { scope, bindings: workspace.bindings.map((binding) => ({ ...scope, ...binding })) },
    } satisfies SharedSourcePlanOptions
  })
}
