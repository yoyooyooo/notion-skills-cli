import { Clock, Effect, Schema } from "effect"
import { invalidateSnapshotCache, publishSnapshotObservation } from "./cache.ts"
import {
  localContentRestrictedHashes,
  markLocalContentRestriction,
} from "./content-restrictions.ts"
import { decode, fail, SkillsError, SnapshotSchema, type Snapshot, type Source } from "./model.ts"
import { Notion } from "./notion.ts"
import { withReadOnlyNotion } from "./notion-readonly.ts"
import { normalizePath, pageId } from "./ref.ts"
import { isSharedAuthoringTarget } from "./shared-authoring-context.ts"
import { sharedRecordFromPage } from "./shared-content.ts"
import { queryCurrentSkillIndex } from "./shared-current-index.ts"
import { requireCurrentSkillReady } from "./shared-current-file.ts"
import { readCurrentSharedResourceBytes } from "./shared-current-resource.ts"
import { resolveCurrentSharedSources } from "./shared-current-source.ts"
import { assertSharedFileReferences } from "./shared-file-references.ts"
import { sharedGraphInventory, sharedGraphMetadata } from "./shared-graph-read-context.ts"
import type { SharedLibrary } from "./shared-library-model.ts"
import {
  sharedSkillMetadataFor,
  type SharedSkillMetadataObservation,
} from "./shared-metadata-inventory.ts"
import { NativeBodyCompletionSchema } from "./shared-native-body-completion.ts"
import { materializeSharedNativeFile } from "./shared-native-file-content.ts"
import { compileSharedNativeReferences } from "./shared-native-references.ts"
import { observeSharedBody } from "./shared-page-body.ts"
import { canonicalSharedJson } from "./shared-records.ts"
import {
  querySharedRouterMembers,
  querySharedSkillRelation,
  type SharedRouterMember,
} from "./shared-router-members.ts"
import type { SharedSourcePlanOptions } from "./shared-source-plan.ts"
import { sha256, Store } from "./store.ts"

export { sharedPendingObservationPrefix } from "./shared-pending-file-operations.ts"
export type FixedSharedSource = {
  readonly source_id: string
  readonly revision: string
  readonly files: readonly import("./shared-composition.ts").CompositionFile[]
  readonly local_paths?: readonly string[]
}

export const SHARED_FULL_BODY_MAX_AGE_MS = 24 * 60 * 60 * 1000
const encoder = new TextEncoder()
const NativeObservationSchema = Schema.Struct({
  file_id: Schema.String,
  page_id: Schema.String,
  path: Schema.String,
  descriptor: Schema.String,
  last_edited_time: Schema.String,
  body_sha256: Schema.String,
  body_verified_at: Schema.Number,
  native_body_completion: Schema.optional(NativeBodyCompletionSchema),
})
const CurrentObservationSchema = Schema.Struct({
  version: Schema.Literal(1),
  generation: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  scope: Schema.String,
  library_id: Schema.String,
  skill_id: Schema.String,
  skill_page_id: Schema.String,
  files: Schema.Array(NativeObservationSchema),
})

export type OpenSharedSnapshotInput = {
  readonly library: SharedLibrary
  readonly target: string
  readonly expectedSkillId?: string
  readonly rawPage?: unknown
  readonly scope: string
  readonly skillsMetadata?: SharedSkillMetadataObservation
  readonly startedAt: number
  readonly forceFull?: boolean
  readonly maxAge?: number
  readonly requestedPaths?: readonly string[]
  readonly requestedFileIds?: readonly string[]
  readonly sourceOptions?: SharedSourcePlanOptions
  readonly routerMembers?: readonly SharedRouterMember[]
  readonly relations?: {
    readonly members?: readonly SharedRouterMember[]
    readonly required?: readonly SharedRouterMember[]
  }
}

const checked = <A>(action: () => A) =>
  Effect.try({
    try: action,
    catch: (error) =>
      error instanceof SkillsError
        ? error
        : fail("CURRENT_TREE_INVALID", "The current file tree is invalid."),
  })
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Current facts only. This boundary never reconciles a management operation,
 * adopts a body, or reads historical Records. Native bodies have a disposable
 * local observation; source and resource bodies remain exact bytes. */
export function openSharedSnapshot(input: OpenSharedSnapshotInput) {
  return Effect.gen(function* () {
    const selected = yield* checked(() => {
      const selected = pageId(input.target)
      if (!selected || !input.scope || !Number.isFinite(input.startedAt) || input.startedAt < 0)
        throw fail("INVALID_ARGUMENT", "Select an exact Skill page and authenticated scope.")
      return selected
    })
    const api = yield* Notion
    const store = yield* Store
    const raw =
      input.rawPage === undefined ? yield* api.request(`v1/pages/${selected}`) : input.rawPage
    const source: Source = {
      alias: input.library.library_id,
      title: "",
      role: "content",
      database_id: input.library.skills.database_id,
      data_source_ids: [input.library.skills.data_source_id],
      shared_library: input.library,
    }
    const record = yield* checked(() =>
      sharedRecordFromPage(raw, source, input.library.skills.data_source_id),
    )
    if (
      record.locator.page_id !== selected ||
      (input.expectedSkillId !== undefined && record.locator.skill_id !== input.expectedSkillId)
    )
      return yield* Effect.fail(
        fail("SHARED_SKILL_ID_CONFLICT", "The selected current Skill changed identity."),
      )
    if (!record.enabled && !(yield* isSharedAuthoringTarget(selected)))
      return yield* Effect.fail(
        fail("CONTENT_DISABLED", "The selected Skill is disabled.", { id: record.id }),
      )
    if (!record.enabled)
      yield* invalidateSnapshotCache(record.id, input.scope, { retainForOffline: true })
    // Reserve before dependent metadata/body reads. The native-body slot and the
    // current snapshot observation use this same owner and causal generation.
    const generation = yield* store.reserveCacheGeneration(input.scope, record.id)
    const inventory =
      (yield* sharedGraphInventory(input.library)) ??
      (input.skillsMetadata === undefined
        ? undefined
        : yield* checked(() =>
            sharedSkillMetadataFor(input.skillsMetadata!, input.library, input.scope),
          ))
    const members =
      record.kind === "router" ||
      (record.kind === "skill" && input.library.skills.property_ids.Members !== undefined)
        ? (input.relations?.members ??
          input.routerMembers ??
          (yield* querySharedRouterMembers(input.library, {
            router: record,
            rawPage: raw,
            inventory,
          })))
        : undefined
    const required =
      record.kind !== "prompt" && input.library.skills.property_ids.Requires !== undefined
        ? (input.relations?.required ??
          (yield* querySharedSkillRelation(input.library, {
            record,
            rawPage: raw,
            field: "Requires",
            inventory,
          })))
        : undefined
    const graph = yield* sharedGraphMetadata(input.library, record, required ?? [], input.scope)
    const index = yield* queryCurrentSkillIndex(input.library, selected, raw, graph?.files)
    yield* checked(() => requireCurrentSkillReady(index.state, index.page_id))
    const bindings = [index.main, ...index.files].sort((a, b) => compare(a.path, b.path))
    const byPath = new Map(bindings.map((file) => [file.path, file]))
    const paths = bindings.map((file) => file.path)
    const requested = yield* checked(() => {
      if (input.requestedPaths === undefined && input.requestedFileIds === undefined)
        return new Set(paths)
      const selectedPaths = new Set([record.entrypoint])
      for (const path of input.requestedPaths ?? []) {
        if (normalizePath(path) !== path || !byPath.has(path))
          throw fail(
            "FILE_NOT_FOUND",
            "The requested path is absent from the current complete tree.",
            { path },
          )
        selectedPaths.add(path)
      }
      for (const id of input.requestedFileIds ?? []) {
        const binding = bindings.find((file) => file.file_id === id)
        if (binding === undefined)
          throw fail("FILE_NOT_FOUND", "The selected File ID is not current.", { file_id: id })
        selectedPaths.add(binding.path)
      }
      return selectedPaths
    })
    const selections = [
      ...new Map(
        bindings.flatMap((file) =>
          file.content.kind === "source"
            ? [
                [
                  file.content.source_id,
                  { source_id: file.content.source_id, revision: file.content.revision },
                ] as const,
              ]
            : [],
        ),
      ).values(),
    ]
    for (const file of bindings) {
      const content = file.content
      if (
        content.kind === "source" &&
        selections.find((selection) => selection.source_id === content.source_id)?.revision !==
          content.revision
      )
        return yield* Effect.fail(
          fail(
            "CURRENT_SOURCE_CONFLICT",
            "One Skill selects conflicting current revisions of the same Source.",
          ),
        )
    }
    const sources = yield* resolveCurrentSharedSources(input.library, {
      selections,
      sourceOptions: input.sourceOptions,
    })
    for (const file of bindings)
      if (file.content.kind === "source") {
        const content = file.content
        const selectedSource = sources.get(content.source_id)
        const declared = selectedSource?.manifest.find((item) => item.path === content.source_path)
        if (
          !declared ||
          declared.bytes !== content.bytes ||
          declared.mode !== content.mode ||
          declared.sha256 !== content.sha256
        )
          return yield* Effect.fail(
            fail(
              "CURRENT_SOURCE_CONFLICT",
              "The File differs from its currently selected complete Source manifest.",
              { path: file.path, source_id: content.source_id, next: "reconcile_current" },
            ),
          )
        if (selectedSource?.local_paths.includes(content.source_path))
          yield* markLocalContentRestriction(content.sha256)
      }
    const observationKey = `cache/current-native-bodies/${yield* sha256(canonicalSharedJson([input.scope, input.library.library_id, index.skill_id]))}/latest.json`
    const previous = yield* store.readJson(observationKey, CurrentObservationSchema)
    if (
      previous !== undefined &&
      (previous.scope !== input.scope ||
        previous.library_id !== input.library.library_id ||
        previous.skill_id !== index.skill_id ||
        previous.skill_page_id !== selected)
    )
      return yield* Effect.fail(
        fail("STATE_CORRUPT", "The current body cache belongs to another owner."),
      )
    const now = yield* Clock.currentTimeMillis
    const observations: Array<typeof NativeObservationSchema.Type> = []
    const nativeBodies: Array<{
      path: string
      markdown: string
      body_sha256: string
      page_id: string
      native_body_completion?: typeof NativeBodyCompletionSchema.Type
    }> = []
    const materialized = new Map<string, Uint8Array>()
    let bodyReads = 0
    for (const binding of bindings) {
      const content = binding.content
      if (content.kind !== "native") continue
      const descriptor = canonicalSharedJson(content)
      const prior = previous?.files.find((file) => file.file_id === binding.file_id)
      const fresh =
        !input.forceFull &&
        prior !== undefined &&
        prior.page_id === binding.page_id &&
        prior.path === binding.path &&
        prior.descriptor === descriptor &&
        prior.last_edited_time === binding.last_edited_time &&
        prior.body_verified_at <= now &&
        now - prior.body_verified_at < SHARED_FULL_BODY_MAX_AGE_MS
      const cached = fresh
        ? yield* store.readBytes(`objects/${prior.body_sha256}`).pipe(
            Effect.catchIf(
              (error) => error.code === "SNAPSHOT_MISSING",
              () => Effect.succeed(undefined),
            ),
          )
        : undefined
      let observed: typeof NativeObservationSchema.Type
      let markdown: string
      if (cached !== undefined && prior !== undefined) {
        if ((yield* sha256(cached)) !== prior.body_sha256)
          return yield* Effect.fail(
            fail("STATE_CORRUPT", "The current body cache failed its checksum."),
          )
        markdown = yield* checked(() => new TextDecoder("utf-8", { fatal: true }).decode(cached))
        observed = prior
      } else {
        const body = yield* observeSharedBody(binding.page_id)
        bodyReads++
        markdown = body.markdown
        yield* store.writeBytes(`objects/${body.fingerprint.sha256}`, encoder.encode(markdown))
        observed = {
          file_id: binding.file_id,
          page_id: binding.page_id,
          path: binding.path,
          descriptor,
          last_edited_time: binding.last_edited_time,
          body_sha256: body.fingerprint.sha256,
          body_verified_at: body.downloaded_at,
          ...(body.native_body_completion === undefined
            ? {}
            : { native_body_completion: body.native_body_completion }),
        }
      }
      observations.push(observed)
      nativeBodies.push({
        path: binding.path,
        markdown,
        body_sha256: observed.body_sha256,
        page_id: binding.page_id,
        ...(observed.native_body_completion === undefined
          ? {}
          : { native_body_completion: observed.native_body_completion }),
      })
    }
    const frozenMembers = members?.map(({ id, ref, metadata }) => ({ id, ref, metadata }))
    const frozenRequired = required?.map(({ id, ref, metadata }) => ({ id, ref, metadata }))
    const native = yield* compileSharedNativeReferences({
      library: input.library,
      record,
      bindings,
      files: nativeBodies,
      inventory: inventory === undefined ? undefined : { skills: inventory },
      relations: { members: frozenMembers ?? [], required: frozenRequired ?? [] },
    })
    for (const body of nativeBodies) {
      const binding = byPath.get(body.path)
      if (binding?.content.kind !== "native")
        return yield* Effect.fail(
          fail("CURRENT_TREE_INVALID", "Native content lost its current owner."),
        )
      const markdown = yield* checked(() =>
        materializeSharedNativeFile(
          body.markdown,
          body.path,
          bindings,
          native.links,
          native.linkedPages.get(body.path),
          native.completions.get(body.path),
        ),
      )
      materialized.set(body.path, encoder.encode(binding.content.frontmatter + markdown))
    }
    for (const binding of bindings) {
      const content = binding.content
      if (content.kind === "native" || !requested.has(binding.path)) continue
      const cached = yield* store.readBytes(`objects/${content.sha256}`).pipe(
        Effect.catchIf(
          (error) => error.code === "SNAPSHOT_MISSING",
          () => Effect.succeed(undefined),
        ),
      )
      if (cached !== undefined) {
        if (cached.length !== content.bytes || (yield* sha256(cached)) !== content.sha256)
          return yield* Effect.fail(
            fail("STATE_CORRUPT", "A selected current object failed its checksum.", {
              path: binding.path,
            }),
          )
        materialized.set(binding.path, cached)
      }
    }
    for (const selectedSource of sources.values()) {
      const needed = bindings.filter(
        (file) =>
          file.content.kind === "source" &&
          file.content.source_id === selectedSource.source_id &&
          requested.has(file.path) &&
          !materialized.has(file.path),
      )
      if (needed.length === 0) continue
      const sourcePaths = needed.flatMap((file) =>
        file.content.kind === "source" ? [file.content.source_path] : [],
      )
      const acquired = yield* selectedSource.materialize([...new Set(sourcePaths)])
      for (const binding of needed) {
        const content = binding.content
        if (content.kind !== "source") continue
        const sourceFile = acquired.files.find((file) => file.path === content.source_path)
        if (
          !sourceFile ||
          sourceFile.bytes.length !== content.bytes ||
          (sourceFile.mode ?? "100644") !== content.mode ||
          (yield* sha256(sourceFile.bytes)) !== content.sha256
        )
          return yield* Effect.fail(
            fail(
              "CURRENT_SOURCE_CONFLICT",
              "The selected current Source bytes failed verification.",
              { path: binding.path },
            ),
          )
        if (acquired.local_paths.includes(content.source_path))
          yield* markLocalContentRestriction(content.sha256)
        materialized.set(binding.path, sourceFile.bytes)
      }
    }
    for (const binding of bindings)
      if (
        binding.content.kind === "resource" &&
        requested.has(binding.path) &&
        !materialized.has(binding.path)
      ) {
        const loaded = yield* readCurrentSharedResourceBytes(input.library, {
          skillPageId: selected,
          content: binding.content,
        })
        materialized.set(binding.path, loaded)
      }
    const files: Snapshot["files"][number][] = []
    const routes: NonNullable<Snapshot["shared_acquisition"]>["files"][number][] = []
    for (const binding of bindings) {
      const content = binding.content
      const bytes = materialized.get(binding.path)
      if (content.kind === "native" && bytes === undefined)
        return yield* Effect.fail(
          fail("BODY_INCOMPLETE", "The current native body is incomplete.", { path: binding.path }),
        )
      const hash = content.kind === "native" ? yield* sha256(bytes!) : content.sha256
      files.push({
        path: binding.path,
        sha256: hash,
        bytes: content.kind === "native" ? bytes!.length : content.bytes,
        mode: content.mode,
      })
      if (bytes !== undefined) yield* store.writeBytes(`objects/${hash}`, bytes)
      if (content.kind === "source")
        routes.push({
          kind: "source",
          path: binding.path,
          source_id: content.source_id,
          revision: content.revision,
          source_path: content.source_path,
        })
      if (content.kind === "resource")
        routes.push({ kind: "resource", path: binding.path, object_id: content.object_id })
    }
    const restricted = new Set(
      yield* localContentRestrictedHashes(files.map((file) => file.sha256)),
    )
    for (const file of files)
      if (restricted.has(file.sha256)) yield* markLocalContentRestriction(file.sha256)
    yield* checked(() =>
      assertSharedFileReferences(
        [...materialized].map(([path, bytes]) => ({ path, bytes })),
        undefined,
        paths,
      ),
    )
    // A current writer marks the owner before changing its files. Check that
    // boundary again after all body/provider requests, including a writer that
    // completed and returned to ready. This is a change detector, not a CAS.
    const finalRaw = yield* api.request(`v1/pages/${selected}`)
    const finalIndex = yield* queryCurrentSkillIndex(input.library, selected, finalRaw, index.files)
    yield* checked(() => requireCurrentSkillReady(finalIndex.state, finalIndex.page_id))
    if (canonicalSharedJson(finalIndex) !== canonicalSharedJson(index))
      return yield* Effect.fail(
        fail(
          "CURRENT_TREE_CHANGED",
          "The current owner changed while its files were being read. Select current content again.",
          { skill_page_id: selected, next: "reselect_current" },
        ),
      )
    const fileBindings = bindings.map(({ file_id, page_id, path }) => ({ file_id, page_id, path }))
    const acquisition: Snapshot["shared_acquisition"] = {
      version: 5,
      library: input.library,
      files: routes,
    }
    // Content identity excludes display fields, property IDs, page projections,
    // body-observation timestamps and operation history. The selected response
    // below always carries freshly observed metadata, even if bytes are unchanged.
    const version = yield* sha256(
      canonicalSharedJson({
        contract: 1,
        record_id: record.id,
        kind: record.kind,
        files,
        authority: bindings.map((file) => ({
          file_id: file.file_id,
          path: file.path,
          kind: file.content.kind,
          ...(file.content.kind === "source"
            ? {
                source_id: file.content.source_id,
                revision: file.content.revision,
                source_path: file.content.source_path,
              }
            : {}),
        })),
        members: (frozenMembers ?? []).map(({ id, ref }) => ({ id, ref })),
        required: (frozenRequired ?? []).map(({ id, ref }) => ({ id, ref })),
      }),
    )
    const snapshotId = `s_${yield* sha256(JSON.stringify([input.scope, record.id, version]))}`
    const current = yield* checked(() =>
      decode(SnapshotSchema, {
        snapshot_id: snapshotId,
        scope: input.scope,
        record,
        entrypoint: record.entrypoint,
        version_id: version,
        created_at: now,
        files,
        file_bindings: fileBindings,
        shared_acquisition: acquisition,
        ...(native.index === undefined ? {} : { native_references: native.index }),
        ...(frozenMembers === undefined
          ? {}
          : record.kind === "router"
            ? { router_members: frozenMembers }
            : { members: frozenMembers }),
        ...(frozenRequired === undefined ? {} : { required: frozenRequired }),
      }),
    )
    // The local selection keeps its original metadata; a current observation is
    // free to return newer display data without altering that selected artifact.
    if ((yield* store.readJson(`snapshots/${snapshotId}.json`, SnapshotSchema)) === undefined)
      yield* store.writeJson(`snapshots/${snapshotId}.json`, current)
    yield* store.writeJson(observationKey, {
      version: 1,
      generation,
      scope: input.scope,
      library_id: input.library.library_id,
      skill_id: index.skill_id,
      skill_page_id: selected,
      files: observations,
    })
    const bodyValidUntil =
      observations.length === 0
        ? now + SHARED_FULL_BODY_MAX_AGE_MS
        : Math.min(
            ...observations.map((file) => file.body_verified_at + SHARED_FULL_BODY_MAX_AGE_MS),
          )
    if (!record.enabled)
      return {
        ...current,
        source: "notion" as const,
        freshness: {
          policy: "refresh" as const,
          validated_at: new Date(now).toISOString(),
          age_ms: 0,
        },
      }
    return yield* publishSnapshotObservation(current, input.startedAt, generation, {
      ...(bodyReads === 0 ? { metadataOnly: true as const } : {}),
      sharedBodyValidUntil: bodyValidUntil,
      sharedMaterializedPaths: [...materialized.keys()].sort(compare),
    })
  }).pipe(withReadOnlyNotion)
}
