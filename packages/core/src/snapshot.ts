import { Clock, Effect, Stream } from "effect"
import { HttpClient } from "effect/http"
import { readArchive } from "./archive.ts"
import {
  authScope,
  catalog,
  databaseId as resolveDatabaseId,
  explicitSource,
  type CatalogOptions,
} from "./catalog.ts"
import { readImportZip } from "./import.ts"
import { BUNDLE } from "./portable.ts"
import { portableSourceDecoder, PortableSourceDecoder } from "./portable-source.ts"
import {
  ExportSchema,
  PageSchema,
  SnapshotSchema,
  decode,
  fail,
  notionPage,
  property,
  resolveRecord,
  recordFromPage,
  SkillsError,
  type NotionPageRecord,
  type ContentRecord,
  aliasFor,
  type Snapshot,
} from "./model.ts"
import { Notion } from "./notion.ts"
import { requestTimeoutMs } from "./request-timeout.ts"
import { fileRef, pageId, parseRef, parseTarget, resolveRef, type SkillTarget } from "./ref.ts"
import { Store, sha256 } from "./store.ts"
import { publicationMarker, verifyPublicationRead } from "./publication-integrity.ts"
import { readReferences, referencesProperty } from "./references.ts"
import { resolvePublishedSubscription, SUBSCRIPTION_ROUTER_MIN_MEMBERS } from "./upstream-router.ts"
import {
  projectUpstreamMemberSnapshot,
  resolveUpstreamMemberRelative,
} from "./upstream-member-snapshot.ts"
import { canonicalMain } from "./portable.ts"
import {
  cachedRemoteObservation,
  effectiveCachePolicy,
  freshness,
  locallySelectedScope,
  publishSnapshotObservation,
  validateReadPolicy,
  validateSnapshot,
  type ObservedSnapshot,
  type ReadPolicyOptions,
} from "./cache.ts"
import {
  captureSourceBundle,
  hasSourceBundle,
  sourceBundleUnchanged,
} from "./source-bundle-cache.ts"

type SnapshotView = "generated" | "authored"

export function loadSnapshot(id: string) {
  return Effect.gen(function* () {
    if (!/^s_[a-f0-9]{64}$/.test(id))
      return yield* Effect.fail(fail("INVALID_SNAPSHOT", "Invalid snapshot ID."))
    const store = yield* Store
    const snapshot = yield* store.readJson(`snapshots/${id}.json`, SnapshotSchema)
    if (!snapshot)
      return yield* Effect.fail(
        fail("SNAPSHOT_MISSING", "This snapshot has not been cached on this machine.", {
          snapshot_id: id,
        }),
      )
    if (snapshot.snapshot_id !== id || snapshot.files.some((f) => !/^[a-f0-9]{64}$/.test(f.sha256)))
      return yield* Effect.fail(fail("STATE_CORRUPT", "The snapshot manifest is invalid."))
    return yield* validateSnapshot(snapshot)
  })
}

function openSubscription(id: string, options: CatalogOptions) {
  return Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis
    const scope = yield* authScope
    const subscription = yield* resolvePublishedSubscription(id)
    if (
      options.database !== undefined &&
      (yield* resolveDatabaseId(options.database)) !== subscription.target_database_id
    )
      return yield* Effect.fail(
        fail(
          "CONTENT_NOT_FOUND",
          "Subscription target differs from the selected content database.",
        ),
      )
    if (subscription.members.length < SUBSCRIPTION_ROUTER_MIN_MEMBERS)
      return yield* Effect.fail(
        fail(
          "UPSTREAM_ROUTER_UNAVAILABLE",
          "Subscription Router requires at least two published active Skills; read individual Skill refs directly.",
          {
            subscription_id: subscription.subscription_id,
            active_member_count: subscription.members.length,
            minimum_member_count: SUBSCRIPTION_ROUTER_MIN_MEMBERS,
          },
        ),
      )
    const members: Array<{
      id: string
      kind: "skill"
      name: string
      description: string
      ref: string
    }> = []
    for (const member of subscription.members) {
      const raw = subscription.memberPages.get(member.page_id)
      const record = yield* Effect.try({
        try: () => {
          const row = decode(PageSchema, raw)
          const parent = property(property(raw).parent)
          if (
            row.in_trash ||
            pageId(row.id) !== member.page_id ||
            parent.database_id !== subscription.target_database_id ||
            typeof parent.data_source_id !== "string"
          )
            throw fail("INVALID_MEMBERS", "Published member is unavailable.")
          const value = recordFromPage(
            row,
            {
              alias: subscription.target_database_id,
              database_id: subscription.target_database_id,
              title: "",
              data_source_ids: [parent.data_source_id],
              role: "content",
            },
            parent.data_source_id,
          )
          if (value.kind !== "skill")
            throw fail("INVALID_MEMBERS", "Published Router members must be Skills.")
          return value
        },
        catch: (error) => error as SkillsError,
      })
      members.push({
        id: record.id,
        kind: "skill",
        name: record.name,
        description: record.description,
        ref: record.ref,
      })
    }
    const unique = [...new Map(members.map((member) => [member.id, member])).values()].sort(
      (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    const record: ContentRecord = {
      id: `notion_subscription:${subscription.subscription_id}`,
      kind: "router",
      locator: {
        type: "notion_subscription",
        subscription_id: subscription.subscription_id,
        database_id: subscription.database_id,
        data_source_id: subscription.data_source_id,
        target_database_id: subscription.target_database_id,
      },
      name: subscription.name,
      alias: aliasFor(subscription.name),
      description: subscription.description,
      default_context: subscription.default_context,
      entrypoint: "ROUTER.md",
      ref: fileRef(`upstream:${subscription.subscription_id}`, "ROUTER.md"),
    }
    const file = canonicalMain(
      record.name,
      record.description,
      `${record.description}\n\n## Members\n\n${unique.map((member) => `- [${member.name}](${member.ref}) — ${member.description}`).join("\n")}`,
      { path: record.entrypoint, bytes: new Uint8Array() },
    )
    const hash = yield* sha256(file.bytes)
    const version = yield* sha256(JSON.stringify([record, subscription.revision, unique, hash]))
    const snapshot: Snapshot = {
      record,
      entrypoint: record.entrypoint,
      scope,
      snapshot_id: `s_${yield* sha256(JSON.stringify([scope, record.id, version]))}`,
      version_id: version,
      created_at: yield* Clock.currentTimeMillis,
      files: [{ path: file.path, bytes: file.bytes.length, sha256: hash }],
    }
    const store = yield* Store
    const generation = yield* store.reserveCacheGeneration(scope, record.id)
    yield* store.writeBytes(`objects/${hash}`, file.bytes)
    yield* store.writeJson(`snapshots/${snapshot.snapshot_id}.json`, snapshot)
    return yield* publishSnapshotObservation(snapshot, startedAt, generation)
  })
}

export function openSkill(
  selector: string,
  options: CatalogOptions = {},
  view: SnapshotView = "generated",
) {
  return openSnapshot(selector, options, view)
}

function openSnapshot(
  selector: string,
  options: CatalogOptions = {},
  view: SnapshotView = "generated",
  allowBundleCache = false,
) {
  return Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis
    const api = yield* Notion
    let rawPage: unknown
    if (selector.startsWith("upstream:") || selector.startsWith("notion_subscription:"))
      return yield* openSubscription(selector.slice(selector.indexOf(":") + 1), options)
    const id = pageId(selector)
    let skill: NotionPageRecord
    let scope: string
    if (id) {
      const selectedDatabase =
        options.database === undefined ? undefined : yield* resolveDatabaseId(options.database)
      scope = yield* authScope
      rawPage = yield* api.request(`v1/pages/${id}`)
      const row = yield* Effect.try({
        try: () => decode(PageSchema, rawPage),
        catch: () => fail("INVALID_RESPONSE", "Invalid skill page response."),
      })
      if (row.id !== id)
        return yield* Effect.fail(
          fail("INVALID_RESPONSE", "The returned skill page ID differs from the requested page."),
        )
      const parent = property(property(rawPage).parent)
      const databaseId = parent.database_id
      const dataSourceId = parent.data_source_id
      if (typeof databaseId !== "string" || typeof dataSourceId !== "string" || row.in_trash)
        return yield* Effect.fail(
          fail("NOT_SKILL", "The page must belong to an accessible skill database."),
        )
      if (selectedDatabase !== undefined && selectedDatabase !== databaseId)
        return yield* Effect.fail(
          fail("SKILL_NOT_FOUND", "The skill does not belong to the selected database."),
        )
      const source = yield* explicitSource(databaseId)
      skill = yield* Effect.try({
        try: () => recordFromPage(row, source, dataSourceId),
        catch: (e) => e as SkillsError,
      })
    } else {
      const directory = yield* catalog({ database: options.database, refresh: true })
      scope = directory.scope
      const resolved = yield* Effect.try({
        try: () => resolveRecord(selector, directory),
        catch: (error) => error as SkillsError,
      })
      if (resolved.locator.type === "notion_subscription")
        return yield* openSubscription(resolved.locator.subscription_id, options)
      skill = yield* Effect.try({
        try: () => notionPage(resolved),
        catch: (error) => error as SkillsError,
      })
    }
    const store = yield* Store
    const generation = yield* store.reserveCacheGeneration(scope, skill.id)
    if (!id) {
      rawPage = yield* api.request(`v1/pages/${skill.locator.page_id}`)
      skill = yield* skillFromCurrentPage(skill, rawPage)
    }
    return yield* snapshotFromPage(
      skill,
      scope,
      rawPage,
      startedAt,
      generation,
      view,
      allowBundleCache,
    )
  })
}

/** Create once per mutation; reuse only while its authenticated Notion service remains active. */
export function makeSkillRefresh(initial: Snapshot) {
  return Effect.gen(function* () {
    const authenticatedApi = yield* Notion
    const credential = yield* authenticatedApi.credentialIdentity
    const workspace = process.env.NOTION_WORKSPACE_ID
    const baseUrl = process.env.NOTION_API_BASE_URL
    const scope = yield* authScope
    if (
      scope !== initial.scope ||
      (yield* authenticatedApi.credentialIdentity) !== credential ||
      process.env.NOTION_WORKSPACE_ID !== workspace ||
      process.env.NOTION_API_BASE_URL !== baseUrl
    )
      return yield* Effect.fail(
        fail("ACCESS_DENIED", "The snapshot does not belong to the current authenticated scope."),
      )
    return (current: Snapshot) =>
      Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis
        const api = yield* Notion
        if (
          api !== authenticatedApi ||
          (yield* api.credentialIdentity) !== credential ||
          process.env.NOTION_WORKSPACE_ID !== workspace ||
          process.env.NOTION_API_BASE_URL !== baseUrl
        )
          return yield* Effect.fail(
            fail("ACCESS_DENIED", "The authenticated service changed during this operation."),
          )
        if (
          current.scope !== scope ||
          current.record.id !== initial.record.id ||
          notionPage(current.record).locator.database_id !==
            notionPage(initial.record).locator.database_id ||
          notionPage(current.record).locator.data_source_id !==
            notionPage(initial.record).locator.data_source_id
        )
          return yield* Effect.fail(
            fail("SKILL_NOT_FOUND", "The snapshot does not belong to this refresh operation."),
          )
        const store = yield* Store
        const generation = yield* store.reserveCacheGeneration(scope, current.record.id)
        const rawPage = yield* api.request(`v1/pages/${notionPage(current.record).locator.page_id}`)
        const skill = yield* skillFromCurrentPage(notionPage(current.record), rawPage)
        return yield* snapshotFromPage(skill, scope, rawPage, startedAt, generation)
      })
  })
}

function skillFromCurrentPage(current: NotionPageRecord, rawPage: unknown) {
  return Effect.gen(function* () {
    const row = yield* Effect.try({
      try: () => decode(PageSchema, rawPage),
      catch: () => fail("INVALID_RESPONSE", "Invalid skill page response."),
    })
    if (pageId(row.id) !== current.locator.page_id)
      return yield* Effect.fail(
        fail("INVALID_RESPONSE", "The returned skill page ID differs from the requested page."),
      )
    if (row.in_trash)
      return yield* Effect.fail(
        fail("NOT_SKILL", "The page must belong to an accessible skill database."),
      )
    const parent = property(property(rawPage).parent)
    if (
      parent.database_id !== current.locator.database_id ||
      parent.data_source_id !== current.locator.data_source_id
    )
      return yield* Effect.fail(
        fail("SKILL_NOT_FOUND", "The skill no longer belongs to the original data source."),
      )
    return yield* Effect.try({
      try: () =>
        recordFromPage(
          row,
          {
            alias: current.locator.database_id,
            database_id: current.locator.database_id,
            title: "",
            data_source_ids: [current.locator.data_source_id],
          },
          current.locator.data_source_id,
        ),
      catch: (error) => error as SkillsError,
    })
  })
}

function snapshotFromPage(
  skill: NotionPageRecord,
  scope: string,
  rawPage: unknown,
  startedAt: number,
  generation: number,
  view: SnapshotView = "generated",
  allowBundleCache = false,
) {
  return Effect.gen(function* () {
    const decodeSource = yield* portableSourceDecoder
    let capture: Effect.Success<ReturnType<typeof captureSourceBundle>> | undefined
    const publish = (snapshot: Snapshot) =>
      Effect.gen(function* () {
        const canonical = yield* loadSnapshot(snapshot.snapshot_id)
        snapshot = {
          ...canonical,
          record: { ...canonical.record, default_context: skill.default_context },
        }
        const state = yield* verifyPublicationRead(
          rawPage,
          {
            ...snapshot,
            files: snapshot.source_files ?? snapshot.files,
          },
          "current",
        ).pipe(Effect.provideService(Notion, capture?.api ?? (yield* Notion)))
        // Authored exports use the verified original files. Keep this unprojected
        // observation out of the default cache, whose readers require generated links.
        if (state === "writing" || view === "authored") {
          const now = yield* Clock.currentTimeMillis
          return {
            ...snapshot,
            source: "notion" as const,
            freshness: freshness(
              { refresh: true },
              now,
              now,
              (yield* effectiveCachePolicy).read_max_age_ms,
            ),
          }
        }
        const bundleCheckpoint =
          state === "committed" && capture ? yield* capture.checkpoint(snapshot) : undefined
        // A stable Notion edit is current authored content, not the source
        // publication's projection. Its own files and links were read above;
        // an old source map cannot certify or block this observation.
        if (state !== "current")
          snapshot = yield* projectUpstreamMemberSnapshot(snapshot, rawPage, { optional: true })
        return yield* publishSnapshotObservation(snapshot, startedAt, generation, {
          bundleCheckpoint,
        })
      })
    const api = yield* Notion
    const store = yield* Store
    const hasReferences = yield* Effect.try({
      try: () => referencesProperty(rawPage),
      catch: (error) => error as SkillsError,
    })
    if (hasReferences) {
      const sourcePolicy = yield* Effect.serviceOption(PortableSourceDecoder)
      const currentMarker = yield* Effect.try({
        try: () => publicationMarker(rawPage),
        catch: (error) => error as SkillsError,
      })
      const eligible =
        skill.kind === "skill" &&
        currentMarker?.state === "committed" &&
        sourcePolicy._tag === "None" &&
        hasSourceBundle(rawPage)
      if (allowBundleCache && eligible) {
        const observed = yield* cachedRemoteObservation(skill.id, scope).pipe(
          Effect.catch((error) =>
            error.code === "CACHE_REFRESH_REQUIRED"
              ? Effect.succeed(undefined)
              : Effect.fail(error),
          ),
        )
        const checkpoint = observed?.bundle_checkpoint
        if (observed && checkpoint) {
          const {
            source_files: sourceFiles,
            source_projection: _projection,
            ...base
          } = observed.snapshot
          let cached: Snapshot = {
            ...base,
            files: sourceFiles ?? base.files,
            snapshot_id: checkpoint.snapshot_id,
            version_id: checkpoint.version_id,
          }
          yield* validateSnapshot(cached)
          const bundle = cached.files.find((file) => file.path === BUNDLE)
          if (
            cached.scope === scope &&
            cached.record.id === skill.id &&
            !cached.markdown_files &&
            bundle?.sha256 === checkpoint.bundle_hash &&
            JSON.stringify(cached.references?.map((page) => page.id)) ===
              JSON.stringify(checkpoint.pages.map((page) => page.id)) &&
            (yield* sourceBundleUnchanged(checkpoint, rawPage))
          ) {
            cached = { ...cached, record: skill }
            if (view === "authored") {
              const now = yield* Clock.currentTimeMillis
              return {
                ...cached,
                source: "notion" as const,
                freshness: freshness(
                  {},
                  now,
                  now,
                  (yield* effectiveCachePolicy).read_max_age_ms,
                  true,
                ),
              }
            }
            cached = yield* projectUpstreamMemberSnapshot(cached, rawPage, { optional: true })
            return yield* publishSnapshotObservation(cached, startedAt, generation, {
              bundleCheckpoint: checkpoint,
              metadataOnly: true,
            })
          }
        }
      }
      if (eligible && view === "generated") capture = yield* captureSourceBundle(rawPage, api)
      const graph = yield* readReferences(skill, rawPage).pipe(
        Effect.provideService(Notion, capture?.api ?? api),
      )
      const marker = yield* Effect.try({
        try: () => publicationMarker(rawPage),
        catch: (error) => error as SkillsError,
      })
      const revision =
        marker?.state === "committed"
          ? marker.revision
          : marker?.state === "writing"
            ? marker.base_revision
            : undefined
      if (revision) graph.version_id = yield* sha256(JSON.stringify([graph.version_id, revision]))
      const snapshotId = `s_${yield* sha256(JSON.stringify([scope, skill.id, graph.version_id]))}`
      const cachedResult = yield* loadSnapshot(snapshotId).pipe(Effect.result)
      if (cachedResult._tag === "Success")
        return yield* publish({ ...cachedResult.success, record: skill })
      const files: Array<Snapshot["files"][number]> = []
      const paths = new Set<string>()
      for (const file of graph.files.sort((a, b) => a.path.localeCompare(b.path))) {
        if (paths.has(file.path))
          return yield* Effect.fail(
            fail("REFERENCE_PATH_CONFLICT", "A reference and attachment share a path.", {
              path: file.path,
            }),
          )
        paths.add(file.path)
        const hash = yield* sha256(file.bytes)
        yield* store.writeBytes(`objects/${hash}`, file.bytes)
        files.push({ path: file.path, bytes: file.bytes.length, sha256: hash })
      }
      const snapshot: Snapshot = {
        snapshot_id: snapshotId,
        scope,
        record: skill,
        entrypoint: skill.entrypoint,
        version_id: graph.version_id,
        created_at: yield* Clock.currentTimeMillis,
        files,
        references: graph.pages,
        router_members: graph.members,
        ...("markdown_files" in graph ? { markdown_files: graph.markdown_files } : {}),
      }
      yield* store.writeJson(`snapshots/${snapshotId}.json`, snapshot)
      return yield* publish(snapshot)
    }
    if (skill.kind !== "skill")
      return yield* Effect.fail(
        fail("INVALID_CONTENT_SOURCE", "Router and Prompt pages require a References property."),
      )
    const raw = yield* api.request(`v1/ai/skills/${skill.locator.page_id}`)
    const exported = yield* Effect.try({
      try: () => decode(ExportSchema, raw),
      catch: () => fail("INVALID_RESPONSE", "Invalid skill export response."),
    })
    if (pageId(exported.id) !== skill.locator.page_id)
      return yield* Effect.fail(
        fail("INVALID_RESPONSE", "The exported skill ID differs from the requested page."),
      )
    const exportedVersion = exported.version_id
    const snapshotId = `s_${yield* sha256(JSON.stringify([scope, skill.id, exportedVersion]))}`
    const cachedResult = yield* loadSnapshot(snapshotId).pipe(Effect.result)
    const cached = cachedResult._tag === "Success" ? cachedResult.success : undefined
    const validateName = (name: string) => {
      if (aliasFor(name) !== skill.alias)
        throw fail(
          "INVALID_SKILL",
          "SKILL.md name must derive the same invocation alias as the Notion Name.",
          {
            page_id: skill.locator.page_id,
            expected: skill.alias,
            actual: name,
          },
        )
    }
    if (cached) {
      if (cached.record.alias !== skill.alias)
        return yield* Effect.fail(
          fail("INVALID_SKILL", "Cached invocation name differs from the content record.", {
            page_id: skill.locator.page_id,
            expected: skill.alias,
            actual: cached.record.alias,
          }),
        )
      return yield* publish({ ...cached, record: skill })
    }
    const timeoutMs = yield* requestTimeoutMs
    const downloaded = yield* Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const response = yield* client.get(exported.url)
      if (response.status < 200 || response.status >= 300)
        return yield* Effect.fail(
          fail("DOWNLOAD_FAILED", "The skill archive could not be downloaded.", {
            status: response.status,
          }),
        )
      const chunks: Uint8Array[] = []
      const length = yield* response.stream.pipe(
        Stream.runFoldEffect(
          () => 0,
          (size, chunk) => {
            if (size + chunk.length > 32 * 1024 * 1024)
              return Effect.fail(
                fail("ARCHIVE_TOO_LARGE", "Compressed skill archive exceeds 32 MiB."),
              )
            chunks.push(chunk)
            return Effect.succeed(size + chunk.length)
          },
        ),
      )
      const bytes = new Uint8Array(length)
      let at = 0
      for (const chunk of chunks) {
        bytes.set(chunk, at)
        at += chunk.length
      }
      return bytes
    }).pipe(
      Effect.timeout(timeoutMs),
      Effect.mapError((e) =>
        e instanceof SkillsError
          ? e
          : fail(
              "DOWNLOAD_FAILED",
              "The skill archive download failed or timed out. Read the current target again to obtain a fresh URL.",
            ),
      ),
    )
    const archive = yield* Effect.try({
      try: () => readArchive(downloaded),
      catch: (e) => e as SkillsError,
    })
    yield* Effect.try({ try: () => validateName(archive.name), catch: (e) => e as SkillsError })
    const sourceBundle = archive.files.find((file) => file.path === BUNDLE)
    const preserved = sourceBundle
      ? yield* Effect.try({
          try: () => decodeSource(readImportZip(sourceBundle.data)),
          catch: (e) => e as SkillsError,
        })
      : undefined
    const expandedFiles = new Map(archive.files.map((file) => [file.path, file]))
    for (const file of preserved?.files ?? []) {
      if (file.path !== preserved!.main && !expandedFiles.has(file.path))
        expandedFiles.set(file.path, { path: file.path, data: file.bytes })
    }
    const files: Array<Snapshot["files"][number]> = []
    for (const file of [...expandedFiles.values()].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    )) {
      const hash = yield* sha256(file.data)
      yield* store.writeBytes(`objects/${hash}`, file.data)
      files.push({ path: file.path, bytes: file.data.length, sha256: hash })
    }
    const snapshot: Snapshot = {
      snapshot_id: snapshotId,
      scope,
      record: skill,
      entrypoint: skill.entrypoint,
      version_id: exportedVersion,
      created_at: yield* Clock.currentTimeMillis,
      files,
    }
    // Publish only after all content objects exist. Readers never observe a half-written version.
    yield* store.writeJson(`snapshots/${snapshotId}.json`, snapshot)
    return yield* publish(snapshot)
  })
}

export function snapshotInfo(snapshot: ObservedSnapshot) {
  return {
    record: snapshot.record,
    scope: snapshot.scope,
    snapshot_id: snapshot.snapshot_id,
    version_id: snapshot.version_id,
    entrypoint: snapshot.entrypoint,
    ref: fileRef(snapshot.record.id, snapshot.entrypoint, snapshot.snapshot_id),
    files: snapshot.files.map((f) => ({
      path: f.path,
      bytes: f.bytes,
      ref: fileRef(snapshot.record.id, f.path, snapshot.snapshot_id),
    })),
    ...(snapshot.source ? { source: snapshot.source } : {}),
    ...(snapshot.freshness ? { freshness: snapshot.freshness } : {}),
    ...(snapshot.source_projection ? { source_projection: snapshot.source_projection } : {}),
  }
}

export function targetSnapshot(
  target: SkillTarget,
  options: CatalogOptions = {},
  view: SnapshotView = "generated",
) {
  return Effect.gen(function* () {
    yield* Effect.try({
      try: () => validateReadPolicy(options, Boolean(target.snapshot)),
      catch: (error) => error as SkillsError,
    })
    let snapshot: ObservedSnapshot
    if (target.snapshot)
      snapshot = {
        ...(yield* loadSnapshot(target.snapshot)),
        source: "local_snapshot",
        freshness: { policy: "pinned" },
      }
    else {
      const maxAge = options.maxAge ?? (yield* effectiveCachePolicy).read_max_age_ms
      const scopeResult = yield* locallySelectedScope(Boolean(options.offline)).pipe(Effect.result)
      if (scopeResult._tag === "Failure" && options.offline)
        return yield* Effect.fail(scopeResult.failure)
      const scope = scopeResult._tag === "Success" ? scopeResult.success : undefined
      const subscription = /^(?:upstream|notion_subscription):(.+)$/.exec(target.selector)
      const subscriptionId = subscription && pageId(subscription[1]!)
      if (subscription && !subscriptionId)
        return yield* Effect.fail(
          fail("EXACT_TARGET_REQUIRED", "Subscription Router requires a UUID."),
        )
      let selected = subscriptionId
        ? `notion_subscription:${subscriptionId}`
        : pageId(target.selector)
          ? `notion_page:${pageId(target.selector)}`
          : undefined
      if (!selected && !options.refresh) {
        const directoryResult = yield* catalog(options).pipe(Effect.result)
        if (directoryResult._tag === "Failure") return yield* Effect.fail(directoryResult.failure)
        selected = yield* Effect.try({
          try: () => resolveRecord(target.selector, directoryResult.success).id,
          catch: (error) => error as SkillsError,
        })
      }
      const observedResult =
        scope && selected && !options.refresh
          ? yield* cachedRemoteObservation(selected, scope).pipe(Effect.result)
          : undefined
      if (observedResult?._tag === "Failure" && options.offline)
        return yield* Effect.fail(observedResult.failure)
      const observed = observedResult?._tag === "Success" ? observedResult.success : undefined
      const now = yield* Clock.currentTimeMillis
      const age = observed ? now - observed.validated_at : NaN
      if (observed && (options.offline || (Number.isFinite(age) && age >= 0 && age < maxAge))) {
        if (
          options.database !== undefined &&
          (observed.snapshot.record.locator.type === "notion_subscription"
            ? observed.snapshot.record.locator.target_database_id
            : notionPage(observed.snapshot.record).locator.database_id) !==
            (yield* resolveDatabaseId(options.database))
        )
          return yield* Effect.fail(
            fail("SKILL_NOT_FOUND", "The Skill does not belong to the selected database."),
          )
        snapshot = {
          ...observed.snapshot,
          source: "local_cache",
          freshness: freshness(options, observed.validated_at, now, maxAge, observed.metadata_only),
        }
      } else {
        if (options.offline)
          return yield* Effect.fail(
            fail(
              "CACHE_MISSING",
              "No complete Skill observation is available in the selected scope.",
            ),
          )
        const online = yield* openSnapshot(
          options.refresh ? target.selector : (selected ?? target.selector),
          { database: options.database },
          view,
          !options.refresh && options.maxAge !== 0,
        )
        const validatedAt = online.freshness?.validated_at
          ? Date.parse(online.freshness.validated_at)
          : yield* Clock.currentTimeMillis
        snapshot = {
          ...online,
          source: "notion",
          freshness: freshness(
            options,
            validatedAt,
            yield* Clock.currentTimeMillis,
            maxAge,
            online.freshness?.validation === "metadata",
          ),
        }
      }
    }
    if (
      target.snapshot &&
      target.selector &&
      ![
        snapshot.record.id,
        snapshot.record.name,
        snapshot.record.alias,
        snapshot.record.locator.type === "notion_page"
          ? snapshot.record.locator.page_id
          : snapshot.record.locator.type === "notion_subscription"
            ? `upstream:${snapshot.record.locator.subscription_id}`
            : snapshot.record.locator.id,
      ].includes(pageId(target.selector) ?? target.selector)
    )
      return yield* Effect.fail(fail("SNAPSHOT_CONFLICT", "The snapshot belongs to another Skill."))
    if (
      target.snapshot &&
      options.database !== undefined &&
      (snapshot.record.locator.type === "notion_subscription"
        ? snapshot.record.locator.target_database_id
        : notionPage(snapshot.record).locator.database_id) !==
        (yield* resolveDatabaseId(options.database))
    )
      return yield* Effect.fail(
        fail("SKILL_NOT_FOUND", "The Skill does not belong to the selected database."),
      )
    return snapshot
  })
}

/** Local refs remain pure; a source-root crossing uses the same exact map as read --from. */
export function resolveSkillRef(from: string, relative: string, options: CatalogOptions = {}) {
  return Effect.gen(function* () {
    const base = yield* Effect.try({
      try: () => parseRef(from),
      catch: (error) => error as SkillsError,
    })
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
    const containing = yield* targetSnapshot(base, options)
    return yield* resolveUpstreamMemberRelative(
      containing,
      base.path || containing.entrypoint,
      relative,
    )
  })
}

export interface ReadOptions extends ReadPolicyOptions {
  readonly database?: string
  readonly path?: string
  readonly from?: string
  readonly lines?: string
  readonly output?: string
}

export function readSkill(input: string, options: ReadOptions = {}) {
  return Effect.gen(function* () {
    if (options.from && options.path !== undefined)
      return yield* Effect.fail(fail("INVALID_ARGUMENT", "--from and --path cannot be combined."))
    if (options.output && options.lines)
      return yield* Effect.fail(
        fail("INVALID_ARGUMENT", "--output and --lines cannot be combined."),
      )
    let target: SkillTarget
    let snapshot: ObservedSnapshot
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
      const containing = yield* targetSnapshot(base, options)
      const resolved = yield* resolveUpstreamMemberRelative(
        containing,
        base.path ?? containing.entrypoint,
        input,
      )
      target = yield* Effect.try({
        try: () => parseTarget(resolved),
        catch: (error) => error as SkillsError,
      })
      snapshot =
        target.snapshot === containing.snapshot_id &&
        target.selector === parseTarget(fileRef(containing.record.id, "")).selector
          ? containing
          : yield* targetSnapshot(target, options)
    } else {
      target = yield* Effect.try({
        try: () => parseTarget(input, options.path),
        catch: (error) => error as SkillsError,
      })
      snapshot = yield* targetSnapshot(target, options)
    }
    const path = target.path || snapshot.entrypoint
    const file = snapshot.files.find((f) => f.path === path)
    if (!file)
      return yield* Effect.fail(
        fail("FILE_NOT_FOUND", "The file does not exist in this snapshot.", {
          path,
          available: snapshot.files.map((f) => f.path),
        }),
      )
    const store = yield* Store
    const bytes = yield* store.readBytes(`objects/${file.sha256}`)
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
      ref: fileRef(snapshot.record.id, path, snapshot.snapshot_id),
      source: snapshot.source,
      freshness: snapshot.freshness,
      ...(snapshot.source_projection ? { source_projection: snapshot.source_projection } : {}),
    }
    if (options.output) {
      return {
        ...metadata,
        ...(yield* store.output(options.output, bytes)),
        bytes: bytes.length,
      }
    }
    const content = yield* Effect.try({
      try: () => {
        if (bytes.includes(0)) throw new Error("binary")
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
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
    const snapshot = yield* targetSnapshot(target, options)
    const path = target.path ?? ""
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
        path: f.path,
        bytes: f.bytes,
        ref: fileRef(snapshot.record.id, f.path, snapshot.snapshot_id),
      })),
    }
  })
}
