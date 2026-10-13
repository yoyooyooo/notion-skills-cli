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
    return snapshot
  })
}

export function openSkill(selector: string, options: CatalogOptions = {}) {
  return Effect.gen(function* () {
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
          fail("NOT_SKILL", "The page must belong to an accessible Skills Database."),
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
      const directory = yield* catalog(options)
      scope = directory.scope
      skill = yield* Effect.try({
        try: () => resolveSkill(selector, directory),
        catch: (e) => e as SkillsError,
      })
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
    const cached = yield* store.readJson(`snapshots/${snapshotId}.json`, SnapshotSchema)
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
      return cached
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
    return snapshot
  })
}

export function snapshotInfo(snapshot: Snapshot) {
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
  }
}

export function targetSnapshot(target: SkillTarget, options: CatalogOptions = {}) {
  return Effect.gen(function* () {
    const snapshot = target.snapshot
      ? yield* loadSnapshot(target.snapshot)
      : yield* openSkill(target.selector, options)
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

export interface ReadOptions {
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
      source: target.snapshot ? "local_snapshot" : "notion",
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
  options: { readonly database?: string; readonly path?: string } = {},
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
