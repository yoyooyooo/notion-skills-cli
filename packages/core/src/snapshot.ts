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
import { BUNDLE, readPortable } from "./portable.ts"
import {
  ExportSchema,
  PageSchema,
  SnapshotSchema,
  decode,
  fail,
  property,
  resolveSkill,
  skillFromPage,
  SkillsError,
  type Skill,
  type Snapshot,
} from "./model.ts"
import { Notion } from "./notion.ts"
import { fileRef, pageId, parseTarget, resolveRef, type SkillTarget } from "./ref.ts"
import { Store, sha256 } from "./store.ts"
import { readReferences, referencesProperty } from "./references.ts"
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

export function openSkill(selector: string, options: CatalogOptions = {}) {
  return Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis
    const api = yield* Notion
    const store = yield* Store
    const id = pageId(selector)
    let skill: Skill
    let scope: string
    if (id) {
      const selectedDatabase =
        options.database === undefined ? undefined : yield* resolveDatabaseId(options.database)
      scope = yield* authScope
      const raw = yield* api.request(`v1/pages/${id}`)
      const row = yield* Effect.try({
        try: () => decode(PageSchema, raw),
        catch: () => fail("INVALID_RESPONSE", "Invalid skill page response."),
      })
      const parent = property(property(raw).parent)
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
        try: () => skillFromPage(row, source, dataSourceId),
        catch: (e) => e as SkillsError,
      })
    } else {
      const directory = yield* catalog({ database: options.database, refresh: true })
      scope = directory.scope
      skill = yield* Effect.try({
        try: () => resolveSkill(selector, directory),
        catch: (e) => e as SkillsError,
      })
    }
    const generation = yield* store.reserveCacheGeneration(scope, skill.id)
    const rawPage = yield* api.request(`v1/pages/${skill.id}`)
    const hasReferences = yield* Effect.try({
      try: () => referencesProperty(rawPage),
      catch: (error) => error as SkillsError,
    })
    if (hasReferences) {
      const graph = yield* readReferences(skill, rawPage)
      const snapshotId = `s_${yield* sha256(JSON.stringify([scope, skill.id, graph.version_id]))}`
      const cachedResult = yield* loadSnapshot(snapshotId).pipe(Effect.result)
      if (cachedResult._tag === "Success")
        return yield* publishSnapshotObservation(cachedResult.success, startedAt, generation)
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
        skill,
        skill_name: skill.alias,
        version_id: graph.version_id,
        created_at: yield* Clock.currentTimeMillis,
        files,
        references: graph.pages,
      }
      yield* store.writeJson(`snapshots/${snapshotId}.json`, snapshot)
      return yield* publishSnapshotObservation(snapshot, startedAt, generation)
    }
    const raw = yield* api.request(`v1/ai/skills/${skill.id}`)
    const exported = yield* Effect.try({
      try: () => decode(ExportSchema, raw),
      catch: () => fail("INVALID_RESPONSE", "Invalid skill export response."),
    })
    if (exported.id !== skill.id)
      return yield* Effect.fail(
        fail("INVALID_RESPONSE", "The exported skill ID differs from the requested page."),
      )
    const snapshotId = `s_${yield* sha256(JSON.stringify([scope, skill.id, exported.version_id]))}`
    const cachedResult = yield* loadSnapshot(snapshotId).pipe(Effect.result)
    const cached = cachedResult._tag === "Success" ? cachedResult.success : undefined
    const validateName = (name: string) => {
      if (name !== skill.alias)
        throw fail(
          "INVALID_SKILL",
          "SKILL.md name must equal the lowercase, hyphenated Notion Name.",
          {
            page_id: skill.id,
            expected: skill.alias,
            actual: name,
          },
        )
    }
    if (cached) {
      yield* Effect.try({
        try: () => validateName(cached.skill_name),
        catch: (e) => e as SkillsError,
      })
      return yield* publishSnapshotObservation(cached, startedAt, generation)
    }
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
      Effect.timeout("60 seconds"),
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
          try: () => readPortable(readImportZip(sourceBundle.data)),
          catch: (e) => e as SkillsError,
        })
      : undefined
    const expandedFiles = new Map(archive.files.map((file) => [file.path, file]))
    for (const file of preserved?.files ?? []) {
      if (file.path !== "SKILL.md" && !expandedFiles.has(file.path))
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
      skill,
      skill_name: archive.name,
      version_id: exported.version_id,
      created_at: yield* Clock.currentTimeMillis,
      files,
    }
    // Publish only after all content objects exist. Readers never observe a half-written version.
    yield* store.writeJson(`snapshots/${snapshotId}.json`, snapshot)
    return yield* publishSnapshotObservation(snapshot, startedAt, generation)
  })
}

export function snapshotInfo(snapshot: ObservedSnapshot) {
  return {
    skill: snapshot.skill,
    skill_name: snapshot.skill_name,
    snapshot_id: snapshot.snapshot_id,
    version_id: snapshot.version_id,
    entrypoint: "SKILL.md",
    ref: fileRef(snapshot.skill.id, "SKILL.md", snapshot.snapshot_id),
    files: snapshot.files.map((f) => ({
      path: f.path,
      bytes: f.bytes,
      ref: fileRef(snapshot.skill.id, f.path, snapshot.snapshot_id),
    })),
    ...(snapshot.source ? { source: snapshot.source } : {}),
    ...(snapshot.freshness ? { freshness: snapshot.freshness } : {}),
  }
}

export function targetSnapshot(target: SkillTarget, options: CatalogOptions = {}) {
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
      let selected = pageId(target.selector)
      if (!selected && !options.refresh) {
        const directoryResult = yield* catalog(options).pipe(Effect.result)
        if (directoryResult._tag === "Failure") return yield* Effect.fail(directoryResult.failure)
        selected = yield* Effect.try({
          try: () => resolveSkill(target.selector, directoryResult.success).id,
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
          observed.snapshot.skill.database_id !== (yield* resolveDatabaseId(options.database))
        )
          return yield* Effect.fail(
            fail("SKILL_NOT_FOUND", "The Skill does not belong to the selected database."),
          )
        snapshot = {
          ...observed.snapshot,
          source: "local_cache",
          freshness: freshness(options, observed.validated_at, now, maxAge),
        }
      } else {
        if (options.offline)
          return yield* Effect.fail(
            fail(
              "CACHE_MISSING",
              "No complete Skill observation is available in the selected scope.",
            ),
          )
        const online = yield* openSkill(
          options.refresh ? target.selector : (selected ?? target.selector),
          { database: options.database },
        )
        const validatedAt = online.freshness?.validated_at
          ? Date.parse(online.freshness.validated_at)
          : yield* Clock.currentTimeMillis
        snapshot = {
          ...online,
          source: "notion",
          freshness: freshness(options, validatedAt, yield* Clock.currentTimeMillis, maxAge),
        }
      }
    }
    if (
      target.snapshot &&
      target.selector &&
      ![snapshot.skill.id, snapshot.skill.name, snapshot.skill.alias].includes(
        pageId(target.selector) ?? target.selector,
      )
    )
      return yield* Effect.fail(fail("SNAPSHOT_CONFLICT", "The snapshot belongs to another Skill."))
    if (
      target.snapshot &&
      options.database !== undefined &&
      snapshot.skill.database_id !== (yield* resolveDatabaseId(options.database))
    )
      return yield* Effect.fail(
        fail("SKILL_NOT_FOUND", "The Skill does not belong to the selected database."),
      )
    return snapshot
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
    const target = yield* Effect.try({
      try: () => {
        if (options.from && (/^[a-z]+:/i.test(input) || input.startsWith("s_")))
          throw fail("INVALID_ARGUMENT", "--from requires a relative file path.")
        return parseTarget(options.from ? resolveRef(options.from, input) : input, options.path)
      },
      catch: (e) => e as SkillsError,
    })
    const path = target.path || "SKILL.md"
    const snapshot = yield* targetSnapshot(target, options)
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
      skill: snapshot.skill,
      snapshot_id: snapshot.snapshot_id,
      version_id: snapshot.version_id,
      path,
      ref: fileRef(snapshot.skill.id, path, snapshot.snapshot_id),
      source: snapshot.source,
      freshness: snapshot.freshness,
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
        ref: fileRef(snapshot.skill.id, f.path, snapshot.snapshot_id),
      })),
    }
  })
}
