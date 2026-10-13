import { Effect, FileSystem, Path } from "effect"
import { parse } from "effect/encoding/Yaml"
import { authScope, catalog, creationSource } from "./catalog.ts"
import {
  importDocument,
  importFiles,
  importEntrypoint,
  loadImport,
  type ImportFile,
  type ImportMetadataOptions,
} from "./import.ts"
import {
  aliasFor,
  decode,
  ExportSchema,
  fail,
  PageSchema,
  property,
  SkillsError,
  type Snapshot,
} from "./model.ts"
import { Notion } from "./notion.ts"
import { fileRef, pageId, parseTarget } from "./ref.ts"
import { openSkill, targetSnapshot, snapshotInfo } from "./snapshot.ts"
import { sha256, Store } from "./store.ts"
import { portableIdentity, snapshotPortable } from "./export.ts"
import {
  BUNDLE,
  MANIFEST,
  bodyIdentity,
  portableZip,
  readPortable,
  type PortableSkill,
} from "./portable.ts"

const DESCRIPTION = "notion%3A%2F%2Fskills%2Fdescription_property"
const FILES = "notion%3A%2F%2Fskills%2Ffiles_property"
const decoder = new TextDecoder("utf-8", { fatal: true })

export function skillDocument(bytes: Uint8Array) {
  try {
    const content = decoder.decode(bytes)
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)
    if (!match) throw fail("INVALID_SKILL", "SKILL.md requires YAML frontmatter.")
    const metadata = property(parse(match[1]!))
    const name = metadata.name
    const description = metadata.description
    if (typeof name !== "string" || !/^[a-z]+(?:-[a-z]+)*$/.test(name) || name.length > 64)
      throw fail(
        "INVALID_SKILL_NAME",
        "SKILL.md name must use lowercase English words separated by hyphens, at most 64 characters.",
      )
    if (typeof description !== "string" || !description.trim() || description.length > 1024)
      throw fail("INVALID_SKILL", "SKILL.md description must contain 1–1024 characters.")
    if (
      metadata.notion_page_id !== undefined &&
      (typeof metadata.notion_page_id !== "string" || !pageId(metadata.notion_page_id))
    )
      throw fail("INVALID_SKILL", "Invalid notion_page_id in SKILL.md.")
    const body = content.slice(match[0].length).replace(/^\r?\n/, "")
    if (body.includes("\0")) throw fail("INVALID_SKILL", "SKILL.md must contain UTF-8 text.")
    return {
      name,
      description,
      body,
      page_id:
        metadata.notion_page_id === undefined
          ? undefined
          : pageId(metadata.notion_page_id as string),
    }
  } catch (error) {
    if (error instanceof SkillsError) throw error
    throw fail("INVALID_SKILL", "Could not parse UTF-8 SKILL.md and its frontmatter.")
  }
}

function inputFile(input: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const full = path.resolve(input)
    const info = yield* fs.stat(full)
    if (info.type !== "File")
      return yield* Effect.fail(fail("INVALID_INPUT", "Input must be a regular file.", { input }))
    return { local: full, bytes: yield* fs.readFile(full) }
  }).pipe(
    Effect.mapError((error) =>
      error instanceof SkillsError
        ? error
        : fail("INPUT_FAILED", "Could not read the input file.", { input }),
    ),
  )
}

function documentName(name: string) {
  return name
    .split("-")
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ")
}

function pageProperties(raw: unknown) {
  const properties = property(property(raw).properties)
  const values = Object.values(properties).map(property)
  const title = values.find((p) => p.type === "title")
  const description = values.find((p) => p.id === DESCRIPTION) ?? property(properties.Description)
  const files = values.find((p) => p.id === FILES) ?? property(properties.Files)
  if (
    typeof title?.id !== "string" ||
    typeof description.id !== "string" ||
    typeof files.id !== "string"
  )
    throw fail(
      "INVALID_RESPONSE",
      "Skills Database must expose title, Description and Files properties.",
    )
  return {
    title: title.id,
    description: description.id,
    files: files.id,
    attachments: Array.isArray(files.files) ? files.files : [],
  }
}

function markdown(raw: unknown) {
  const value = property(raw)
  if (
    value.object !== "page_markdown" ||
    typeof value.markdown !== "string" ||
    value.truncated !== false ||
    !Array.isArray(value.unknown_block_ids) ||
    value.unknown_block_ids.length
  )
    throw fail(
      "MARKDOWN_INCOMPLETE",
      "Cannot write or verify a page with truncated or unsupported Markdown content.",
    )
  return value.markdown
}

function upload(input: { bytes: Uint8Array }, filename: string) {
  return Effect.gen(function* () {
    const api = yield* Notion
    if (input.bytes.length > 20 * 1024 * 1024)
      return yield* Effect.fail(
        fail("FILE_TOO_LARGE", "Direct upload supports files up to 20 MiB.", { path: filename }),
      )
    const store = yield* Store
    const path = yield* Path.Path
    const key = `uploads/${yield* sha256(input.bytes)}/${filename}`
    yield* store.writeBytes(key, input.bytes)
    const raw = property(
      yield* api.request("v1/file_uploads", {
        filename,
        mode: "single_part",
      }),
    )
    if (typeof raw.id !== "string")
      return yield* Effect.fail(fail("INVALID_RESPONSE", "File upload returned no ID."))
    const result = property(
      yield* api.request(`v1/file_uploads/${raw.id}/send`, undefined, {
        method: "POST",
        file: path.join(store.root, key),
      }),
    )
    if (result.status !== "uploaded")
      return yield* Effect.fail(
        fail("INVALID_RESPONSE", "File upload has not completed.", { upload_id: raw.id }),
      )
    return { name: filename, type: "file_upload" as const, file_upload: { id: raw.id } }
  })
}

function assertVersion(snapshot: {
  readonly skill: { readonly id: string }
  readonly version_id: string
}) {
  return Effect.gen(function* () {
    const api = yield* Notion
    const latest = decode(ExportSchema, yield* api.request(`v1/ai/skills/${snapshot.skill.id}`))
    if (latest.id !== snapshot.skill.id || latest.version_id !== snapshot.version_id)
      return yield* Effect.fail(
        fail("WRITE_CONFLICT", "The remote skill changed; read it again before writing.", {
          page_id: snapshot.skill.id,
          expected_version: snapshot.version_id,
          actual_version: latest.version_id,
        }),
      )
  })
}

function verifyFiles(
  snapshot: Snapshot,
  expected: ReadonlyArray<{ path: string; bytes: Uint8Array }>,
) {
  return Effect.gen(function* () {
    for (const file of expected) {
      const actual = snapshot.files.find((item) => item.path === file.path)
      if (!actual || actual.sha256 !== (yield* sha256(file.bytes)))
        return yield* Effect.fail(
          fail(
            "WRITE_VERIFICATION_FAILED",
            "Exported attachment differs from the submitted file.",
            { path: file.path },
          ),
        )
    }
  })
}

function verifyBody(snapshot: Snapshot, expected: string) {
  return Effect.gen(function* () {
    const store = yield* Store
    const entrypoint = snapshot.files.find((f) => f.path === "SKILL.md")!
    const bytes = yield* store.readBytes(`objects/${entrypoint.sha256}`)
    const exported = yield* Effect.try({
      try: () => skillDocument(bytes),
      catch: (e) => e as SkillsError,
    })
    if (bodyIdentity(exported.body) !== bodyIdentity(expected))
      return yield* Effect.fail(
        fail("WRITE_VERIFICATION_FAILED", "Exported Skill body differs from page Markdown."),
      )
  })
}

export interface WriteOptions {
  readonly database?: string
  readonly input: string
  readonly dryRun?: boolean
  readonly path?: string
}

export function writeSkill(inputTarget: string, options: WriteOptions) {
  return Effect.gen(function* () {
    const target = yield* Effect.try({
      try: () => parseTarget(inputTarget, options.path),
      catch: (e) => e as SkillsError,
    })
    const baseline = target.snapshot ? yield* targetSnapshot(target, options) : undefined
    if (baseline && baseline.scope !== (yield* authScope))
      return yield* Effect.fail(
        fail("SNAPSHOT_CONFLICT", "The snapshot belongs to another authentication scope."),
      )
    const current = yield* openSkill(baseline?.skill.id ?? target.selector, {
      database: options.database,
      refresh: true,
    })
    if (baseline && baseline.version_id !== current.version_id)
      return yield* Effect.fail(
        fail("WRITE_CONFLICT", "The remote Skill changed since the pinned read.", {
          page_id: current.skill.id,
          expected_version: baseline.version_id,
          actual_version: current.version_id,
        }),
      )
    const path = target.path || "SKILL.md"
    if (path === BUNDLE || path === MANIFEST)
      return yield* Effect.fail(
        fail("INVALID_PATH", "The target is a reserved portability file.", { path }),
      )
    const input = yield* inputFile(options.input)
    const portable = yield* snapshotPortable(current)
    const sourcePath = path === "SKILL.md" ? portable.main : path
    const doc =
      path === "SKILL.md"
        ? yield* Effect.try({
            try: () => skillDocument(input.bytes),
            catch: (e) => e as SkillsError,
          })
        : undefined
    if (doc?.page_id && doc.page_id !== current.skill.id)
      return yield* Effect.fail(
        fail("SNAPSHOT_CONFLICT", "SKILL.md notion_page_id belongs to another Skill."),
      )
    const name = doc
      ? doc.name === current.skill.alias
        ? current.skill.name
        : documentName(doc.name)
      : current.skill.name
    const next: PortableSkill = {
      ...portable,
      name,
      description: doc?.description ?? portable.description,
      files: [
        ...portable.files.filter((file) => file.path !== sourcePath),
        { path: sourcePath, bytes: input.bytes },
      ],
    }
    const hash = yield* sha256(input.bytes)
    const original = portable.files.find((file) => file.path === sourcePath)
    const unchanged =
      (original && (yield* sha256(original.bytes)) === hash) ||
      (path === "SKILL.md" && current.files.find((file) => file.path === path)?.sha256 === hash)
    const ref = fileRef(current.skill.id, path, current.snapshot_id)
    if (unchanged) {
      yield* assertVersion(current)
      return {
        ...snapshotInfo(current),
        operation: "write",
        action: "unchanged",
        unchanged: true,
        path,
        ref,
        previous_version_id: current.version_id,
        content_id: yield* portableIdentity(portable),
        verified: true,
        ...(options.dryRun ? { dry_run: true } : {}),
      }
    }
    const result = yield* saveDocument(next, options, "write", current)
    return {
      ...result,
      path,
      ref: fileRef(current.skill.id, path, result.snapshot_id ?? current.snapshot_id),
      previous_version_id: current.version_id,
      unchanged: false,
    }
  })
}

export interface CreateOptions extends ImportMetadataOptions {
  readonly database?: string
  readonly dryRun?: boolean
}
export interface ImportOptions extends CreateOptions {}

export function createSkill(input: string, options: CreateOptions = {}) {
  return saveInput(input, options, "create")
}

export function importSkill(input: string, options: ImportOptions = {}) {
  return saveInput(input, options, "import")
}

function saveInput(input: string, options: CreateOptions, operation: "create" | "import") {
  return Effect.gen(function* () {
    const loaded = yield* loadImport(input)
    const source = yield* Effect.try({
      try: () => {
        const portable = readPortable(importFiles(loaded.files, loaded.kind === "markdown"))
        const entry = portable
          ? {
              main: portable.files.find((file) => file.path === portable.main)!,
              attachments: portable.files.filter((file) => file.path !== portable.main),
            }
          : importEntrypoint(loaded.files, loaded.kind === "markdown")
        if (
          !portable &&
          entry.attachments.some((file) => file.path === BUNDLE || file.path === MANIFEST)
        )
          throw fail("INVALID_INPUT", "Input contains a reserved portability filename.")
        const doc = importDocument(entry.main, {
          name: options.name ?? portable?.name,
          description: options.description ?? portable?.description,
        })
        return {
          name: doc.name,
          description: doc.description,
          main: entry.main.path,
          files: [entry.main, ...entry.attachments],
        } satisfies PortableSkill
      },
      catch: (e) => e as SkillsError,
    })
    return {
      ...(yield* saveDocument(source, options, operation)),
      input_type: loaded.kind,
      main_path: source.main,
    }
  })
}

function saveDocument(
  portable: PortableSkill,
  options: CreateOptions,
  operation: "create" | "import" | "write",
  baseline?: Snapshot,
) {
  return Effect.gen(function* () {
    const contentId = yield* portableIdentity(portable)
    const doc = yield* Effect.try({
      try: () => {
        portableZip(portable)
        return importDocument(portable.files.find((file) => file.path === portable.main)!, {
          name: portable.name,
          description: portable.description,
        })
      },
      catch: (e) => e as SkillsError,
    })
    let current = baseline
    let databaseId = current?.skill.database_id
    let dataSourceId = current?.skill.data_source_id
    if (!current) {
      const source = yield* creationSource(options.database)
      databaseId = source.database_id
      if (source.data_source_ids.length !== 1)
        return yield* Effect.fail(
          fail("DATABASE_AMBIGUOUS", "Skills Database must have exactly one data source.", {
            source,
          }),
        )
      dataSourceId = source.data_source_ids[0]!
      const directory = yield* catalog({ database: databaseId, refresh: true })
      if (directory.coverage.failed_sources.length)
        return yield* Effect.fail(
          fail("CATALOG_INCOMPLETE", "Cannot prove Skill name uniqueness.", directory.coverage),
        )
      const matches = directory.skills.filter((skill) => skill.alias === aliasFor(doc.name))
      if (matches.length > 1)
        return yield* Effect.fail(
          fail("SKILL_AMBIGUOUS", "Multiple pages share this invocation name.", {
            candidates: matches,
            databases: directory.databases,
          }),
        )
      if (matches[0]) {
        if (operation === "create")
          return yield* Effect.fail(
            fail(
              "CREATE_CONFLICT",
              "A Skill with this invocation name already exists; use import to replace it.",
              {
                page_id: matches[0].id,
                name: doc.name,
                database_id: databaseId,
                data_source_id: dataSourceId,
              },
            ),
          )
        current = yield* openSkill(matches[0].id, { refresh: true })
        if ((yield* portableIdentity(yield* snapshotPortable(current))) === contentId) {
          yield* assertVersion(current)
          return {
            ...snapshotInfo(current),
            operation,
            action: "reuse",
            reused: true,
            content_id: contentId,
            verified: true,
            ...(options.dryRun ? { dry_run: true } : {}),
          }
        }
      }
    }
    const api = yield* Notion
    const raw = yield* api.request(
      current ? `v1/pages/${current.skill.id}` : `v1/data_sources/${dataSourceId}`,
    )
    const props = yield* Effect.try({
      try: () => pageProperties(raw),
      catch: (e) => e as SkillsError,
    })
    let oldBody = ""
    if (current) {
      const rawBody = yield* api.request(`v1/pages/${current.skill.id}/markdown`)
      oldBody = yield* Effect.try({ try: () => markdown(rawBody), catch: (e) => e as SkillsError })
    }
    const action = current ? "update" : "create"
    const plan = {
      operation,
      action,
      database_id: databaseId!,
      data_source_id: dataSourceId!,
      name: doc.name,
      description: doc.description,
      content_id: contentId,
      reused: false,
      ...(current
        ? {
            page_id: current.skill.id,
            base_version_id: current.version_id,
            snapshot_id: current.snapshot_id,
            ref: snapshotInfo(current).ref,
          }
        : {}),
      files: portable.files.map((file) => ({ path: file.path, bytes: file.bytes.length })),
    }
    if (options.dryRun) return { ...plan, dry_run: true }
    const completed: string[] = []
    let id = current?.skill.id
    let stage = "prepare"
    return yield* Effect.gen(function* () {
      if (current) yield* assertVersion(current)
      else {
        stage = "create_page"
        const created = yield* api.request("v1/pages", {
          parent: { type: "data_source_id", data_source_id: dataSourceId },
          properties: {
            [props.title]: { title: [{ text: { content: doc.name } }] },
            [props.description]: { rich_text: [{ text: { content: doc.description } }] },
          },
        })
        completed.push(stage)
        id = yield* Effect.try({
          try: () => decode(PageSchema, created).id,
          catch: (e) => e as SkillsError,
        })
      }
      let expectedBody = oldBody
      if (bodyIdentity(oldBody) !== bodyIdentity(doc.body)) {
        stage = "body"
        const written = yield* api.request(
          `v1/pages/${id}/markdown`,
          oldBody
            ? {
                type: "update_content",
                update_content: { content_updates: [{ old_str: oldBody, new_str: doc.body }] },
              }
            : { type: "replace_content", replace_content: { new_str: doc.body } },
          { method: "PATCH" },
        )
        completed.push(stage)
        expectedBody = yield* Effect.try({
          try: () => markdown(written),
          catch: (e) => e as SkillsError,
        })
      }
      const exportedVersion = yield* api.request(`v1/ai/skills/${id}`)
      const beforeUpload = yield* Effect.try({
        try: () => decode(ExportSchema, exportedVersion),
        catch: (e) => e as SkillsError,
      })
      stage = "source_bundle"
      const bytes = yield* Effect.try({
        try: () =>
          portableZip(
            {
              ...portable,
              projection: {
                name: doc.name,
                description: doc.description,
                body: bodyIdentity(expectedBody),
              },
            },
            true,
          ),
        catch: (e) => e as SkillsError,
      })
      const bundle = yield* upload({ bytes }, BUNDLE)
      completed.push("upload:source_bundle")
      stage = "metadata"
      yield* assertVersion({ skill: { id: id! }, version_id: beforeUpload.version_id })
      yield* api.request(
        `v1/pages/${id}`,
        {
          properties: {
            [props.title]: { title: [{ text: { content: doc.name } }] },
            [props.description]: { rich_text: [{ text: { content: doc.description } }] },
            [props.files]: { files: [bundle] },
          },
        },
        { method: "PATCH" },
      )
      completed.push(stage)
      stage = "verify_export"
      const snapshot = yield* openSkill(id!, { refresh: true })
      if (snapshot.skill.name !== doc.name || snapshot.skill.description !== doc.description)
        return yield* Effect.fail(
          fail("WRITE_VERIFICATION_FAILED", "Skill metadata differs from the submitted values."),
        )
      yield* verifyFiles(snapshot, [{ path: BUNDLE, bytes }])
      const readback = yield* api.request(`v1/pages/${id}/markdown`)
      const body = yield* Effect.try({
        try: () => markdown(readback),
        catch: (e) => e as SkillsError,
      })
      if (body !== expectedBody)
        return yield* Effect.fail(
          fail("WRITE_VERIFICATION_FAILED", "Page Markdown changed during verification."),
        )
      yield* verifyBody(snapshot, body)
      if ((yield* portableIdentity(yield* snapshotPortable(snapshot))) !== contentId)
        return yield* Effect.fail(
          fail("WRITE_VERIFICATION_FAILED", "Saved Skill files differ from the submitted content."),
        )
      return {
        ...snapshotInfo(snapshot),
        operation,
        action,
        verified: true,
        content_id: contentId,
        reused: false,
        ...(current ? { previous_version_id: current.version_id } : {}),
      }
    }).pipe(
      Effect.mapError((error) =>
        fail(
          error.code === "WRITE_OUTCOME_UNKNOWN"
            ? error.code
            : completed.length
              ? "WRITE_PARTIAL"
              : error.code,
          error.message,
          {
            database_id: databaseId,
            ...(id ? { page_id: id } : {}),
            stage,
            completed,
            cause_code: error.code,
            cause_details: error.details,
          },
        ),
      ),
    )
  })
}
