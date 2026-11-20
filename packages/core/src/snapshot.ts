import { Clock, Effect } from "effect"
import {
  cachedRemoteObservation,
  effectiveCachePolicy,
  freshness,
  invalidateScopeCache,
  invalidateSnapshotCache,
  locallySelectedScope,
  validateCachedSharedCurrentTree,
  validateReadPolicy,
  type ObservedSnapshot,
  type ReadPolicyOptions,
} from "./cache.ts"
import { isCurrentNameTarget, resolveCatalogReference } from "./catalog-reference.ts"
import {
  authScope,
  catalog,
  explicitSource,
  freshCatalogForRead,
  databaseId as resolveDatabaseId,
  type CatalogOptions,
} from "./catalog.ts"
import {
  withConsumptionEffects,
  type ConsumptionObservationOptions,
} from "./consumption-effects.ts"
import { openFixedSnapshotFiles } from "./fixed-snapshot-files.ts"
import {
  decode,
  fail,
  PageSchema,
  property,
  resolveRecord,
  SkillsError,
  type Snapshot,
} from "./model.ts"
import { Notion } from "./notion.ts"
import { fileRef, pageId, parseRef, parseTarget, resolveRef, type SkillTarget } from "./ref.ts"
import { withSharedAuthoringTarget } from "./shared-authoring-context.ts"
import { openSharedConsumer } from "./shared-consumer.ts"
import {
  assertSelectedSharedFileReferences,
  currentAuthoredReferenceFiles,
} from "./shared-file-references.ts"
import { sharedGraphTarget } from "./shared-graph-read-context.ts"
import { sharedReadFreshness } from "./shared-read-freshness.ts"
import { resolveCurrentSourceReference } from "./shared-source-references.ts"
import { sha256, Store } from "./store.ts"

export { loadSnapshot, loadSnapshotManifest } from "./fixed-snapshot-files.ts"

export function openSkill(selector: string, options: CatalogOptions = {}) {
  return openSnapshot(selector, options)
}

function openSnapshot(
  selector: string,
  options: CatalogOptions = {},
  selectedFiles?: {
    readonly requestedPaths: readonly string[]
    readonly requestedFileIds?: readonly string[]
  },
) {
  return Effect.gen(function* () {
    if (/^(?:upstream|notion_subscription|notion_page):/u.test(selector))
      return yield* Effect.fail(
        fail(
          "CURRENT_TARGET_REQUIRED",
          "Select a current Skill by identity, current page ID or current library reference.",
        ),
      )
    const startedAt = yield* Clock.currentTimeMillis
    const selectedDatabase =
      options.database === undefined ? undefined : yield* resolveDatabaseId(options.database)
    const graphTarget = yield* sharedGraphTarget(selector, selectedDatabase)
    if (graphTarget !== undefined)
      return yield* openSharedConsumer({
        ...graphTarget,
        target: String(property(graphTarget.rawPage).id),
        scope: yield* authScope,
        startedAt,
        forceFull: Boolean(options.refresh) || options.maxAge === 0,
        maxAge: options.maxAge,
        ...selectedFiles,
      })
    const id = pageId(selector)
    if (id !== undefined) {
      const scope = yield* authScope
      const rawPage = yield* (yield* Notion).request(`v1/pages/${id}`)
      const row = yield* Effect.try({
        try: () => decode(PageSchema, rawPage),
        catch: () => fail("INVALID_RESPONSE", "Invalid current Skill page response."),
      })
      if (row.id !== id)
        return yield* Effect.fail(
          fail("INVALID_RESPONSE", "The returned Skill identity differs from the requested page."),
        )
      const parent = property(property(rawPage).parent)
      if (
        typeof parent.database_id !== "string" ||
        typeof parent.data_source_id !== "string" ||
        row.in_trash
      )
        return yield* Effect.fail(
          fail("NOT_SKILL", "The page must belong to an accessible current Skill library."),
        )
      if (selectedDatabase !== undefined && selectedDatabase !== parent.database_id)
        return yield* Effect.fail(
          fail("SKILL_NOT_FOUND", "The Skill does not belong to the selected library."),
        )
      const source = yield* explicitSource(parent.database_id)
      return yield* openSharedConsumer({
        library: source.shared_library,
        target: id,
        rawPage,
        scope,
        startedAt,
        forceFull: Boolean(options.refresh) || options.maxAge === 0,
        maxAge: options.maxAge,
        ...selectedFiles,
      })
    }
    const observation = yield* freshCatalogForRead({ database: options.database })
    const directory = observation.catalog
    const resolved = yield* Effect.try({
      try: () =>
        observation.exactSharedRecords.get(selector) ??
        (isCurrentNameTarget({ selector })
          ? resolveCatalogReference(selector, directory).record
          : resolveRecord(selector, directory)),
      catch: (error) => error as SkillsError,
    })
    if (resolved.locator.type !== "shared_skill")
      return yield* Effect.fail(
        fail("CURRENT_TARGET_REQUIRED", "The selected record is not a current Skill."),
      )
    const locator = resolved.locator
    const library = directory.databases.find(
      (entry) => entry.database_id === locator.database_id,
    )?.shared_library
    if (library === undefined || library.library_id !== locator.library_id)
      return yield* Effect.fail(
        fail("LIBRARY_INVALID", "The current Skill has no matching library descriptor."),
      )
    return yield* openSharedConsumer({
      library,
      target: locator.page_id,
      expectedSkillId: locator.skill_id,
      skillsMetadata: observation.sharedSkills.get(library.skills.data_source_id),
      rawPage: (yield* sharedGraphTarget(resolved.id, library.skills.database_id))?.rawPage,
      scope: directory.scope,
      startedAt,
      forceFull: Boolean(options.refresh) || options.maxAge === 0,
      maxAge: options.maxAge,
      ...selectedFiles,
    })
  })
}

function snapshotReferences(snapshot: Snapshot) {
  return {
    ...(snapshot.file_bindings === undefined ? {} : { file_bindings: snapshot.file_bindings }),
    ...(snapshot.native_references === undefined
      ? {}
      : { native_references: snapshot.native_references }),
    ...((snapshot.members ?? snapshot.router_members) === undefined
      ? {}
      : { members: snapshot.members ?? snapshot.router_members }),
    ...(snapshot.required === undefined ? {} : { required: snapshot.required }),
  }
}
function snapshotFileRef(snapshot: Snapshot, path: string) {
  return fileRef(
    snapshot.record.id,
    path,
    snapshot.snapshot_id,
    snapshot.file_bindings?.find((binding) => binding.path === path)?.file_id,
  )
}
export function boundSnapshotPath(snapshot: Snapshot, target: SkillTarget): string | undefined {
  if (target.file_id === undefined) return target.path
  if (snapshot.record.locator.type !== "shared_skill" || target.selector !== snapshot.record.id)
    throw fail(
      "SHARED_REFERENCE_SCOPE",
      "The stable File reference does not name this exact Skill owner.",
    )
  const bindings = snapshot.file_bindings
  if (bindings === undefined)
    throw fail(
      "SHARED_FILE_BINDING_UNAVAILABLE",
      "This historical snapshot has no frozen stable File bindings; its path bytes remain available through its original reference.",
    )
  const selected = bindings.filter((binding) => binding.file_id === target.file_id)
  const binding = selected[0]
  if (selected.length !== 1 || binding === undefined)
    throw fail(
      "SHARED_FILE_BINDING_UNAVAILABLE",
      "The exact stable File ID is unavailable in this owner snapshot.",
      { file_id: target.file_id },
    )
  if (
    bindings.some(
      (other) =>
        other !== binding && (other.page_id === binding.page_id || other.path === binding.path),
    ) ||
    !snapshot.files.some((file) => file.path === binding.path)
  )
    throw fail(
      "SHARED_FILE_ID_CONFLICT",
      "The stable File ID has an ambiguous or missing physical binding.",
    )
  return binding.path
}

export function snapshotInfo(snapshot: ObservedSnapshot) {
  return {
    record: snapshot.record,
    scope: snapshot.scope,
    snapshot_id: snapshot.snapshot_id,
    version_id: snapshot.version_id,
    entrypoint: snapshot.entrypoint,
    ref: snapshotFileRef(snapshot, snapshot.entrypoint),
    files: snapshot.files.map((f) => ({
      ...f,
      ref: snapshotFileRef(snapshot, f.path),
    })),
    ...(snapshot.source ? { source: snapshot.source } : {}),
    ...(snapshot.freshness ? { freshness: snapshot.freshness } : {}),
    ...(snapshot.materialization ? { materialization: snapshot.materialization } : {}),
    ...snapshotReferences(snapshot),
  }
}

function assertSnapshotTarget(snapshot: Snapshot, target: SkillTarget, database?: string) {
  if (
    target.snapshot &&
    target.selector &&
    ![
      snapshot.record.id,
      snapshot.record.name,
      snapshot.record.alias,
      snapshot.record.locator.type === "shared_skill"
        ? snapshot.record.locator.page_id
        : snapshot.record.locator.id,
    ].includes(pageId(target.selector) ?? target.selector)
  )
    throw fail("SNAPSHOT_CONFLICT", "The snapshot belongs to another Skill.")
  if (
    target.snapshot &&
    database !== undefined &&
    (snapshot.record.locator.type === "shared_skill"
      ? snapshot.record.locator.database_id
      : undefined) !== database
  )
    throw fail("SKILL_NOT_FOUND", "The Skill does not belong to the selected database.")
  if (
    snapshot.record.locator.type === "shared_skill" &&
    snapshot.record.kind === "router" &&
    snapshot.router_members === undefined &&
    snapshot.members === undefined
  )
    throw fail(
      "SHARED_ROUTER_SNAPSHOT_INCOMPLETE",
      "This older shared Router snapshot has no frozen Members index. Refresh its current page online before consuming it as a complete Router.",
    )
}

function selectedMaterialization(snapshot: Snapshot, files: readonly { readonly path: string }[]) {
  return {
    manifest_complete: true as const,
    local_files_ready: files.length === snapshot.files.length,
    materialized_paths: files.map((file) => file.path),
    loaded: false as const,
  }
}

function acquireTargetSnapshot(
  target: SkillTarget,
  options: CatalogOptions = {},
  access: "all" | "manifest" | "entrypoint" | "target" = "all",
) {
  return Effect.gen(function* () {
    yield* Effect.try({
      try: () => validateReadPolicy(options, Boolean(target.snapshot)),
      catch: (error) => error as SkillsError,
    })
    const pinnedDatabase =
      target.snapshot && options.database !== undefined
        ? yield* resolveDatabaseId(options.database)
        : undefined
    const select = (manifest: Snapshot) => {
      assertSnapshotTarget(manifest, target, pinnedDatabase)
      const selectedPath = boundSnapshotPath(manifest, target)
      if (access === "all") return manifest.files.map((file) => file.path)
      if (access === "manifest") return []
      if (access === "entrypoint") {
        if (selectedPath && selectedPath !== manifest.entrypoint)
          throw fail(
            "PREPARE_ROOT_NOT_MAIN",
            "Prepare selects a content main file; supporting resources remain references.",
            { id: manifest.record.id, path: selectedPath },
          )
        return [manifest.entrypoint]
      }
      const path = selectedPath || manifest.entrypoint
      if (!manifest.files.some((file) => file.path === path))
        throw fail("FILE_NOT_FOUND", "The fixed snapshot does not contain the selected file.", {
          path,
        })
      return [path]
    }
    let snapshot: ObservedSnapshot
    let files: readonly { readonly path: string; readonly bytes: Uint8Array }[] | undefined
    if (target.snapshot) {
      const selected = yield* openFixedSnapshotFiles(target.snapshot, select, options)
      snapshot = {
        ...selected.snapshot,
        source: "local_snapshot",
        freshness: {
          policy: "pinned",
          ...(selected.access_denied === undefined ? {} : { stale: true }),
        },
        materialization: selectedMaterialization(selected.snapshot, selected.files),
      }
      files = selected.files
    } else {
      const currentEligibilityMaxAge = (yield* effectiveCachePolicy).read_max_age_ms
      let maxAge = options.maxAge ?? currentEligibilityMaxAge
      let resolvedPolicy: Effect.Success<ReturnType<typeof sharedReadFreshness>> | undefined
      const scopeResult = yield* locallySelectedScope(Boolean(options.offline)).pipe(Effect.result)
      if (scopeResult._tag === "Failure" && options.offline)
        return yield* Effect.fail(scopeResult.failure)
      const scope = scopeResult._tag === "Success" ? scopeResult.success : undefined
      let selected =
        pageId(target.selector) ??
        (target.selector.startsWith("shared_skill:") ? target.selector : undefined)
      if (!selected && !options.refresh) {
        const directoryResult = yield* catalog(options).pipe(Effect.result)
        if (directoryResult._tag === "Failure") return yield* Effect.fail(directoryResult.failure)
        selected = yield* Effect.try({
          try: () => resolveCatalogReference(target.selector, directoryResult.success).record.id,
          catch: (error) => error as SkillsError,
        })
      }
      const observedResult =
        scope && selected && !options.refresh
          ? yield* cachedRemoteObservation(selected, scope, {
              access: "metadata" as const,
              offline: options.offline,
            }).pipe(Effect.result)
          : undefined
      if (observedResult?._tag === "Failure" && options.offline)
        return yield* Effect.fail(observedResult.failure)
      const observed = observedResult?._tag === "Success" ? observedResult.success : undefined
      if (observed?.snapshot.record.locator.type === "shared_skill") {
        resolvedPolicy = yield* sharedReadFreshness(observed.snapshot.record, options)
        maxAge = resolvedPolicy.read_max_age_ms
      }
      const now = yield* Clock.currentTimeMillis
      const age = observed ? now - observed.validated_at : NaN
      const bodyFresh =
        observed?.snapshot.record.locator.type !== "shared_skill" ||
        (observed.shared_body_valid_until !== undefined &&
          now < observed.shared_body_valid_until &&
          (observed.snapshot.record.kind !== "router" ||
            observed.snapshot.router_members !== undefined))
      const locator = observed?.snapshot.record.locator
      let useObserved =
        observed !== undefined &&
        (options.offline ||
          (Number.isFinite(age) &&
            age >= 0 &&
            age <
              (locator?.type === "shared_skill"
                ? Math.min(maxAge, currentEligibilityMaxAge)
                : maxAge) &&
            bodyFresh))
      let materialization: ObservedSnapshot["materialization"]
      if (observed && useObserved) {
        if (
          options.database !== undefined &&
          (observed.snapshot.record.locator.type === "shared_skill"
            ? observed.snapshot.record.locator.database_id
            : undefined) !== (yield* resolveDatabaseId(options.database))
        )
          return yield* Effect.fail(
            fail("SKILL_NOT_FOUND", "The Skill does not belong to the selected database."),
          )
        if (access !== "all" || observed.snapshot.record.locator.type === "shared_skill") {
          const selected = yield* Effect.gen(function* () {
            const fixed = observed.stored_snapshot ?? observed.snapshot
            const paths = yield* Effect.try({
              try: () => select(observed.snapshot),
              catch: (error) => error as SkillsError,
            })
            if (observed.snapshot.record.locator.type === "shared_skill")
              yield* validateCachedSharedCurrentTree(fixed)
            return yield* openFixedSnapshotFiles(fixed, () => paths, options)
          }).pipe(Effect.result)
          if (selected._tag === "Failure") {
            if (!options.offline && selected.failure.code === "SNAPSHOT_MISSING")
              useObserved = false
            else return yield* Effect.fail(selected.failure)
          } else
            materialization = selectedMaterialization(
              selected.success.snapshot,
              selected.success.files,
            )
        }
      }
      if (observed && useObserved) {
        if (access === "all" && observed.snapshot.record.locator.type === "shared_skill") {
          // The full-cache path still checks current references. Selective cache
          // access already required a receipt for this complete immutable tree.
          const store = yield* Store
          const files = yield* Effect.forEach(observed.snapshot.files, (file) =>
            store
              .readBytes(`objects/${file.sha256}`)
              .pipe(Effect.map((bytes) => ({ path: file.path, bytes }))),
          )
          yield* Effect.try({
            try: () =>
              assertSelectedSharedFileReferences(
                currentAuthoredReferenceFiles(files, observed.snapshot.shared_acquisition?.files),
                observed.snapshot.files.map((file) => file.path),
              ),
            catch: (error) =>
              error instanceof SkillsError
                ? error
                : fail(
                    "SHARED_REFERENCE_INVALID",
                    "The complete current tree could not be checked.",
                  ),
          })
        }
        snapshot = {
          ...observed.snapshot,
          ...(materialization === undefined ? {} : { materialization }),
          ...(observed.shared_body_valid_until === undefined
            ? {}
            : { shared_body_valid_until: observed.shared_body_valid_until }),
          source: "local_cache",
          freshness: {
            ...freshness(options, observed.validated_at, now, maxAge, observed.metadata_only),
            ...(resolvedPolicy === undefined
              ? {}
              : {
                  policy_source: resolvedPolicy.read_policy_source,
                  full_body_max_age_ms: resolvedPolicy.full_body_max_age_ms,
                  current_eligibility_max_age_ms: resolvedPolicy.current_eligibility_max_age_ms,
                  ...(resolvedPolicy.profile === null
                    ? {}
                    : { profile_fingerprint: resolvedPolicy.profile.fingerprint }),
                }),
            ...(observed.invalidated ? { stale: true } : {}),
          },
        }
      } else {
        if (options.offline)
          return yield* Effect.fail(
            fail(
              "CACHE_MISSING",
              "No complete Skill observation is available in the selected scope.",
            ),
          )
        const previousLocator = observed?.snapshot.record.locator
        const online = yield* openSnapshot(
          previousLocator?.type === "shared_skill"
            ? previousLocator.page_id
            : options.refresh
              ? target.selector
              : (selected ?? target.selector),
          options,
          access === "all"
            ? undefined
            : {
                requestedPaths:
                  access === "target" && target.path && target.file_id === undefined
                    ? [target.path]
                    : [],
                ...(access === "target" && target.file_id !== undefined
                  ? { requestedFileIds: [target.file_id] }
                  : {}),
              },
        ).pipe(
          Effect.tapError((error) =>
            Effect.gen(function* () {
              if (!scope) return
              if (error.code === "AUTH_REQUIRED") return yield* invalidateScopeCache(scope)
              if (
                error.code !== "ACCESS_DENIED" &&
                error.code !== "NOT_FOUND" &&
                error.code !== "CONTENT_DISABLED"
              )
                return
              // A refresh by name still has a known local binding when its
              // online lookup is denied. Resolve only existing metadata here.
              if (!selected) {
                const cached = yield* catalog({
                  database: options.database,
                  offline: true,
                }).pipe(Effect.result)
                if (cached._tag === "Success") {
                  const resolved = yield* Effect.try({
                    try: () => resolveRecord(target.selector, cached.success).id,
                    catch: (cause) => cause as SkillsError,
                  }).pipe(Effect.result)
                  if (resolved._tag === "Success") selected = resolved.success
                }
              }
              if (selected)
                yield* invalidateSnapshotCache(selected, scope, {
                  retainForOffline: true,
                  ...(error.code === "ACCESS_DENIED" ? { accessDenied: error.code } : {}),
                })
            }),
          ),
        )
        const validatedAt = online.freshness?.validated_at
          ? Date.parse(online.freshness.validated_at)
          : yield* Clock.currentTimeMillis
        if (online.record.locator.type === "shared_skill") {
          resolvedPolicy = yield* sharedReadFreshness(online.record, {
            ...(options.offline ? { offline: true } : {}),
            ...(options.maxAge === undefined ? {} : { maxAge: options.maxAge }),
          })
          maxAge = resolvedPolicy.read_max_age_ms
        }
        snapshot = {
          ...online,
          source: "notion",
          freshness: {
            ...freshness(
              options,
              validatedAt,
              yield* Clock.currentTimeMillis,
              maxAge,
              online.freshness?.validation === "metadata",
            ),
            ...(resolvedPolicy === undefined
              ? {}
              : {
                  policy_source: resolvedPolicy.read_policy_source,
                  full_body_max_age_ms: resolvedPolicy.full_body_max_age_ms,
                  current_eligibility_max_age_ms: resolvedPolicy.current_eligibility_max_age_ms,
                  ...(resolvedPolicy.profile === null
                    ? {}
                    : { profile_fingerprint: resolvedPolicy.profile.fingerprint }),
                }),
          },
        }
        // Sparse Git intentionally opens only requested bytes. An all-file
        // consumer (notably a cold export) must acquire that same fixed manifest
        // through the existing verified byte reader before returning it.
        if (
          snapshot.record.locator.type === "shared_skill" &&
          (access !== "all" || snapshot.shared_acquisition !== undefined)
        ) {
          const selected = yield* openFixedSnapshotFiles(snapshot, select, options)
          files = selected.files
          snapshot = {
            ...snapshot,
            materialization: selectedMaterialization(selected.snapshot, selected.files),
          }
        }
      }
    }
    yield* Effect.try({
      try: () => assertSnapshotTarget(snapshot, target, pinnedDatabase),
      catch: (error) => error as SkillsError,
    })
    return { snapshot, files }
  })
}

/** Keep selected bytes private to the operation that consumes them. */
export function targetSnapshot(
  target: SkillTarget,
  options: CatalogOptions = {},
  access: "all" | "manifest" | "entrypoint" | "target" = "all",
) {
  return acquireTargetSnapshot(target, options, access).pipe(Effect.map(({ snapshot }) => snapshot))
}

/** Local refs remain pure; a source-root crossing uses the same exact map as read --from. */
export function resolveSkillRef(from: string, relative: string, options: CatalogOptions = {}) {
  return Effect.gen(function* () {
    const base = yield* Effect.try({
      try: () => parseRef(from),
      catch: (error) => error as SkillsError,
    })
    if (base.file_id !== undefined) {
      const containing = yield* targetSnapshot(base, options, "manifest")
      const path = yield* Effect.try({
        try: () => boundSnapshotPath(containing, base),
        catch: (error) => error as SkillsError,
      })
      return yield* resolveCurrentRelative(
        containing,
        path || containing.entrypoint,
        relative,
        options,
      )
    }
    const local = yield* Effect.try({
      try: () => resolveRef(from, relative),
      catch: (error) => error as SkillsError,
    }).pipe(Effect.result)
    if (local._tag === "Success") return local.success
    if (
      local.failure.code !== "INVALID_PATH" ||
      local.failure.message !== "The path escapes the skill root."
    )
      return yield* Effect.fail(local.failure)
    const containing = yield* targetSnapshot(base, options, "manifest")
    return yield* resolveCurrentRelative(
      containing,
      base.path || containing.entrypoint,
      relative,
      options,
    )
  })
}

export interface ReadOptions extends ReadPolicyOptions, ConsumptionObservationOptions {
  readonly database?: string
  readonly path?: string
  readonly from?: string
  readonly lines?: string
  readonly output?: string
  readonly authoring?: boolean
}

/** Output-only file and owner commitments; text reads retain their existing shape. */
export const READ_OUTPUT_PROOF_VERSION = 1

export function readSkill(input: string, options: ReadOptions = {}) {
  return withConsumptionEffects(readSkillSelected(input, options), options)
}

function readSkillSelected(input: string, options: ReadOptions) {
  if (options.authoring === true) {
    const selected = pageId(input)
    if (!selected || options.from || options.offline || options.maxAge !== undefined)
      return Effect.fail(
        fail(
          "EXACT_TARGET_REQUIRED",
          "Authoring reads require an exact current page ID or URL; offline, max-age and relative/pinned selection are unavailable.",
        ),
      )
    return withSharedAuthoringTarget(
      selected,
      readSkillContent(selected, { ...options, refresh: true }),
    )
  }
  return readSkillContent(input, options)
}

function readSkillContent(input: string, options: ReadOptions) {
  return Effect.gen(function* () {
    if (options.from && options.path !== undefined)
      return yield* Effect.fail(fail("INVALID_ARGUMENT", "--from and --path cannot be combined."))
    if (options.output && options.lines)
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "--output and --lines cannot be combined."),
      )
    let target: SkillTarget
    let acquired: Effect.Success<ReturnType<typeof acquireTargetSnapshot>>
    if (options.from) {
      const base = yield* Effect.try({
        try: () => {
          if (/^[a-z]+:/i.test(input) || input.startsWith("s_"))
            throw fail("INVALID_ARGUMENT", "--from requires a relative file path.")
          if (input.includes("?") || input.includes("#"))
            throw fail("INVALID_PATH", "Only relative file paths can be resolved within a skill.")
          return parseRef(options.from!)
        },
        catch: (error) => error as SkillsError,
      })
      const containing = yield* targetSnapshot(base, options, "manifest")
      const basePath = yield* Effect.try({
        try: () => boundSnapshotPath(containing, base),
        catch: (error) => error as SkillsError,
      })
      const resolved = yield* resolveCurrentRelative(
        containing,
        basePath ?? containing.entrypoint,
        input,
        options,
      )
      target = yield* Effect.try({
        try: () => parseTarget(resolved),
        catch: (error) => error as SkillsError,
      })
      if (
        target.snapshot === containing.snapshot_id &&
        target.selector === parseTarget(fileRef(containing.record.id, "")).selector
      ) {
        const selected = yield* openFixedSnapshotFiles(
          containing,
          (manifest) => [boundSnapshotPath(manifest, target) || manifest.entrypoint],
          { offline: options.offline },
        )
        acquired = {
          snapshot: {
            ...containing,
            materialization: selectedMaterialization(selected.snapshot, selected.files),
          },
          files: selected.files,
        }
      } else acquired = yield* acquireTargetSnapshot(target, options, "target")
    } else {
      target = yield* Effect.try({
        try: () => parseTarget(input, options.path),
        catch: (error) => error as SkillsError,
      })
      acquired = yield* acquireTargetSnapshot(target, options, "target")
    }
    const { snapshot, files } = acquired
    const path =
      (yield* Effect.try({
        try: () => boundSnapshotPath(snapshot, target),
        catch: (error) => error as SkillsError,
      })) || snapshot.entrypoint
    const file = snapshot.files.find((f) => f.path === path)
    if (!file)
      return yield* Effect.fail(
        fail("FILE_NOT_FOUND", "The file does not exist in this snapshot.", {
          path,
          available: snapshot.files.map((f) => f.path),
        }),
      )
    const store = yield* Store
    const bytes =
      files?.find((selected) => selected.path === path)?.bytes ??
      (yield* store.readBytes(`objects/${file.sha256}`))
    if (bytes.length !== file.bytes || (yield* sha256(bytes)) !== file.sha256)
      return yield* Effect.fail(
        fail("STATE_CORRUPT", "The cached file failed its content checksum."),
      )
    const metadata = {
      record: snapshot.record,
      entrypoint: snapshot.entrypoint,
      scope: snapshot.scope,
      snapshot_id: snapshot.snapshot_id,
      version_id: snapshot.version_id,
      path,
      ref: snapshotFileRef(snapshot, path),
      source: snapshot.source,
      freshness: snapshot.freshness,
      ...(snapshot.materialization ? { materialization: snapshot.materialization } : {}),
      ...snapshotReferences(snapshot),
    }
    if (options.output) {
      const entrypoint = snapshot.files.find((entry) => entry.path === snapshot.entrypoint)
      if (!entrypoint)
        return yield* Effect.fail(fail("STATE_CORRUPT", "The snapshot has no entrypoint file."))
      return {
        ...metadata,
        ...(yield* store.output(options.output, bytes)),
        bytes: bytes.length,
        sha256: file.sha256,
        entrypoint_sha256: entrypoint.sha256,
      }
    }
    const content = yield* Effect.try({
      try: () => {
        if (bytes.includes(0)) throw new Error("binary")
        return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
      },
      catch: () =>
        fail("BINARY_FILE", "Use --output <new-path> to retrieve this binary file.", { path }),
    })
    const lines = content.split("\n")
    let start = 1
    let end = lines.length
    if (options.lines) {
      const range = /^(\d+)(?:-(\d+))?$/.exec(options.lines)
      if (!range)
        return yield* Effect.fail(
          fail(
            "INVALID_RANGE",
            "Expected --lines <start>-<end>, using inclusive 1-based line numbers.",
          ),
        )
      start = Number(range[1])
      end = Number(range[2] ?? range[1])
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 1 ||
        end < start ||
        start > lines.length
      )
        return yield* Effect.fail(
          fail("INVALID_RANGE", "Line range is outside the file.", { total_lines: lines.length }),
        )
      end = Math.min(end, lines.length)
    }
    return {
      ...metadata,
      content: options.lines ? lines.slice(start - 1, end).join("\n") : content,
      range: { start, end, total_lines: lines.length },
      has_more: end < lines.length,
    }
  })
}

export function listSkill(
  input: string,
  options: ReadPolicyOptions & { readonly database?: string; readonly path?: string } = {},
) {
  return Effect.gen(function* () {
    const target = yield* Effect.try({
      try: () => parseTarget(input, options.path),
      catch: (e) => e as SkillsError,
    })
    const snapshot = yield* targetSnapshot(target, options, "manifest")
    const path =
      (yield* Effect.try({
        try: () => boundSnapshotPath(snapshot, target),
        catch: (error) => error as SkillsError,
      })) ?? ""
    const files = snapshot.files.filter(
      (f) => !path || f.path.startsWith(path + "/") || f.path === path,
    )
    if (path && !files.length)
      return yield* Effect.fail(
        fail("FILE_NOT_FOUND", "No file or directory matches this path.", { path }),
      )
    return {
      ...snapshotInfo(snapshot),
      files: files.map((f) => ({
        ...f,
        ref: snapshotFileRef(snapshot, f.path),
      })),
    }
  })
}

function resolveCurrentRelative(
  snapshot: Snapshot,
  from: string,
  relative: string,
  options: { readonly offline?: boolean } = {},
) {
  return resolveCurrentSourceReference(snapshot, from, relative, options).pipe(
    Effect.mapError((error) =>
      error.code === "INVALID_PATH" && error.message === "The path escapes the skill root."
        ? fail(
            "CURRENT_SOURCE_REQUIRED",
            "A relative path crossing the current Skill root requires an explicit current Source contribution link.",
            {
              from_path: from,
              relative_path: relative,
              next: "manage_current_source_links",
            },
          )
        : error,
    ),
  )
}
