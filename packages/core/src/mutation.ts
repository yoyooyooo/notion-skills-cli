import { Effect, FileSystem, Path } from "effect"
import { parseYaml as parse } from "./yaml.ts"
import { authScope, catalog, creationSource } from "./catalog.ts"
import {
  importDocument,
  importFiles,
  importEntrypoint,
  loadImport,
  readImportZip,
} from "./import.ts"
import type { ImportFile, ImportMetadataOptions } from "./import.ts"
import {
  aliasFor,
  decode,
  ExportSchema,
  fail,
  notionPage,
  PageSchema,
  property,
  SkillsError,
  validateDisplayName,
  entrypointFor,
  validateDescription,
} from "./model.ts"
import type { Snapshot } from "./model.ts"
import { Notion } from "./notion.ts"
import { fileRef, normalizePath, pageId, parseTarget } from "./ref.ts"
import { openSkill, targetSnapshot, snapshotInfo } from "./snapshot.ts"
import { sha256, Store } from "./store.ts"
import { portableIdentity, snapshotAuthoredPortable } from "./export.ts"
import {
  authoredPortable,
  BUNDLE,
  MANIFEST,
  bodyIdentity,
  portableZip,
  portableFiles,
  readPortable,
} from "./portable.ts"
import type { PortableSkill } from "./portable.ts"
import { PortableSourceDecoder, portableSourceDecoder } from "./portable-source.ts"
import { rejectPublicationSourceOverride } from "./publication-source.ts"
import { referencesProperty } from "./references.ts"
import {
  saveReferences,
  referenceContentIdentity,
  referenceInput,
  referencePagesMatch,
} from "./reference-mutation.ts"
import { invalidateSnapshotCache } from "./cache.ts"
import { beginPublication, progressPublication } from "./publication.ts"
import { PublicationReadOperation } from "./publication-integrity.ts"
import { recoverPublication } from "./publication-recovery.ts"
import { PublicationReceiptSchema } from "./publication-model.ts"
import { resumeContentAdoption } from "./upstream-content-adoption.ts"
import type { Publication, PublicationContext, PublicationOptions } from "./publication.ts"
import { fromNotionMarkdown, markdownIdentity } from "./markdown.ts"
import { memberIds, membersProperty, resolveRouterMembers } from "./router-members.ts"
import { recoverPreparedPublication } from "./publication-prepare-recovery.ts"
import type { PreparedPublicationRecovery } from "./publication-prepare-recovery.ts"
import {
  publishMarkdownFiles,
  resumeMarkdownFilesPublication,
} from "./markdown-files-publication.ts"
import { writeSharedSkillFile, verifySharedAuthoredSnapshot } from "./shared-authoring.ts"

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
    const description = validateDescription(metadata.description)
    if (typeof name !== "string")
      throw fail("INVALID_SKILL_NAME", "SKILL.md name must be a string.")
    validateDisplayName(name)
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
function defaultContextProperty(raw: unknown, requested: boolean) {
  const field = property(property(raw).properties)["Default Context"]
  const checkbox = property(field)
  if (checkbox.type !== "checkbox" || typeof checkbox.id !== "string")
    throw fail("PROPERTY_UNAVAILABLE", "Default Context must be an existing checkbox property.", {
      requested,
    })
  return checkbox.id
}

function pageProperties(raw: unknown, options?: { readonly defaultContext?: boolean }) {
  const properties = property(property(raw).properties)
  const values = Object.values(properties).map(property)
  const title = values.find((p) => p.type === "title")
  const description = values.find((p) => p.id === DESCRIPTION) ?? property(properties.Description)
  const files = values.find((p) => p.id === FILES) ?? property(properties.Files)
  const references = referencesProperty(raw)
  if (
    typeof title?.id !== "string" ||
    typeof description.id !== "string" ||
    (!references && typeof files.id !== "string")
  )
    throw fail(
      "INVALID_RESPONSE",
      "Skill database must expose title, Description and References or Files properties.",
    )
  return {
    title: title.id,
    description: description.id,
    files: typeof files.id === "string" ? files.id : undefined,
    references: references ? String(references.id) : undefined,
    attachments: Array.isArray(files.files) ? files.files : [],
    defaultContext:
      options?.defaultContext === undefined
        ? undefined
        : defaultContextProperty(raw, options.defaultContext),
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

function assertVersion(snapshot: {
  readonly record: Snapshot["record"]
  readonly version_id: string
  readonly references?: Snapshot["references"]
}) {
  return Effect.gen(function* () {
    const api = yield* Notion
    if ("references" in snapshot && snapshot.references) {
      const latest = yield* openSkill(notionPage(snapshot.record).locator.page_id, {
        refresh: true,
      })
      if (latest.version_id !== snapshot.version_id)
        return yield* Effect.fail(
          fail(
            "WRITE_CONFLICT",
            "The skill or a reference page changed; read it again before writing.",
            {
              page_id: notionPage(snapshot.record).locator.page_id,
              expected_version: snapshot.version_id,
              actual_version: latest.version_id,
            },
          ),
        )
      return
    }
    const latest = decode(
      ExportSchema,
      yield* api.request(`v1/ai/skills/${notionPage(snapshot.record).locator.page_id}`),
    )
    if (
      pageId(latest.id) !== notionPage(snapshot.record).locator.page_id ||
      latest.version_id !== snapshot.version_id
    )
      return yield* Effect.fail(
        fail("WRITE_CONFLICT", "The remote skill changed; read it again before writing.", {
          page_id: notionPage(snapshot.record).locator.page_id,
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
    const entrypoint = snapshot.files.find((f) => f.path === snapshot.entrypoint)!
    const bytes = yield* store.readBytes(`objects/${entrypoint.sha256}`)
    const exported = yield* Effect.try({
      try: () => skillDocument(bytes),
      catch: (e) => e as SkillsError,
    })
    const root = snapshot.references?.find((page) => page.path === snapshot.entrypoint)
    if (
      markdownIdentity(fromNotionMarkdown(exported.body)) !==
      markdownIdentity(fromNotionMarkdown(expected, root?.blocks))
    )
      return yield* Effect.fail(
        fail("WRITE_VERIFICATION_FAILED", "Exported Skill body differs from page Markdown."),
      )
  })
}

function pinnedDocument(file: ImportFile, metadata: ImportMetadataOptions, targetPageId: string) {
  const imported = importDocument(file, metadata)
  const text = decoder.decode(file.bytes)
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  const explicitPage = (match ? property(parse(match[1]!)) : {}).notion_page_id
  if (explicitPage !== undefined) {
    if (typeof explicitPage !== "string" || !pageId(explicitPage))
      throw fail("INVALID_SKILL", "Invalid notion_page_id in the content entrypoint.")
    if (pageId(explicitPage) !== targetPageId)
      throw fail(
        "SNAPSHOT_CONFLICT",
        "The content entrypoint notion_page_id belongs to another page.",
      )
  }
  return imported
}

export interface WriteOptions
  extends Omit<PublicationOptions, "source" | "retainedSource" | "ownership"> {
  readonly database?: string
  readonly input: string
  readonly dryRun?: boolean
  readonly path?: string
}

export function writeSkill(inputTarget: string, options: WriteOptions) {
  return Effect.gen(function* () {
    yield* rejectPublicationSourceOverride(options as PublicationOptions)
    const target = yield* Effect.try({
      try: () => parseTarget(inputTarget, options.path),
      catch: (e) => e as SkillsError,
    })
    const baseline = target.snapshot ? yield* targetSnapshot(target, options) : undefined
    if (baseline && baseline.scope !== (yield* authScope))
      return yield* Effect.fail(
        fail("SNAPSHOT_CONFLICT", "The snapshot belongs to another authentication scope."),
      )
    const current = yield* openSkill(baseline?.record.id ?? target.selector, {
      database: options.database,
      refresh: true,
      sharedReadOnly: Boolean(options.dryRun),
    })
    if (baseline && baseline.version_id !== current.version_id)
      return yield* Effect.fail(
        fail("WRITE_CONFLICT", "The remote Skill changed since the pinned read.", {
          page_id:
            current.record.locator.type === "shared_skill"
              ? current.record.locator.page_id
              : notionPage(current.record).locator.page_id,
          expected_version: baseline.version_id,
          actual_version: current.version_id,
        }),
      )
    const path = target.path || current.entrypoint
    if (path === BUNDLE || path === MANIFEST)
      return yield* Effect.fail(
        fail("INVALID_PATH", "The target is a reserved portability file.", { path }),
      )
    const input = yield* inputFile(options.input)
    if (current.record.locator.type === "shared_skill") {
      const result = yield* writeSharedSkillFile({
        snapshot: current,
        path,
        bytes: input.bytes,
        dryRun: options.dryRun,
      })
      if (result.status === "not_applied")
        return yield* Effect.fail(
          fail(
            "SHARED_BODY_WRITE_NOT_APPLIED",
            "The original operation was verified as having no body effect. Read the current page before preparing another write.",
            {
              body_write_operation_id: result.operation_id,
              read_again: true,
            },
          ),
        )
      if (result.status === "planned" || result.status === "unchanged")
        return {
          ...snapshotInfo(current),
          operation: "write",
          action: result.unchanged ? "unchanged" : "planned",
          unchanged: result.unchanged,
          path,
          ref: fileRef(current.record.id, path, current.snapshot_id),
          previous_version_id: current.version_id,
          verified: true,
          body_write_operation_id: result.operation_id,
          input_sha256: result.input_sha256,
          candidate_sha256: result.candidate_sha256,
          protection: result.protection,
          ...(result.status === "planned" ? { dry_run: true } : {}),
        }
      const observed = yield* openSkill(current.record.locator.page_id, {
        database: options.database,
        refresh: true,
      }).pipe(
        Effect.mapError((error) =>
          fail(
            "SHARED_WRITE_REFRESH_FAILED",
            "The original body operation was verified, but its fresh current snapshot could not be published. Preserve the original operation and retry only the read.",
            {
              body_write_operation_id: result.operation_id,
              cause_code: error instanceof SkillsError ? error.code : "REFRESH_FAILED",
              read_again: true,
            },
          ),
        ),
      )
      yield* Effect.try({
        try: () => verifySharedAuthoredSnapshot(observed, result),
        catch: (error) =>
          error instanceof SkillsError
            ? error
            : fail(
                "WRITE_VERIFICATION_FAILED",
                "The current shared body could not be compared with the original write.",
                { body_write_operation_id: result.operation_id },
              ),
      })
      return {
        ...snapshotInfo(observed),
        operation: "write",
        action: "updated",
        unchanged: false,
        path,
        ref: fileRef(observed.record.id, path, observed.snapshot_id),
        previous_version_id: current.version_id,
        verified: true,
        body_write_operation_id: result.operation_id,
        input_sha256: result.input_sha256,
        candidate_sha256: result.candidate_sha256,
        protection: result.protection,
      }
    }
    notionPage(current.record)
    const portable = yield* snapshotAuthoredPortable(current)
    const sourcePath = path === current.entrypoint ? portable.main : path
    const doc =
      path === current.entrypoint
        ? yield* Effect.try({
            try: () =>
              pinnedDocument(
                { path: sourcePath, bytes: input.bytes },
                portable,
                notionPage(current.record).locator.page_id,
              ),
            catch: (e) => e as SkillsError,
          })
        : undefined
    const next: PortableSkill = {
      ...portable,
      ...(portable.kind === "router" && doc && portable.projection
        ? { projection: { ...portable.projection, body: doc.body } }
        : {}),
      files: [
        ...portable.files.filter((file) => file.path !== sourcePath),
        { path: sourcePath, bytes: input.bytes },
      ],
    }
    const hash = yield* sha256(input.bytes)
    const original = portable.files.find((file) => file.path === sourcePath)
    const unchanged =
      (original && (yield* sha256(original.bytes)) === hash) ||
      (path === current.entrypoint &&
        current.files.find((file) => file.path === path)?.sha256 === hash)
    const ref = fileRef(notionPage(current.record).locator.page_id, path, current.snapshot_id)
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
    const result = yield* saveDocument(next, options, "write", current, {
      write_path: path,
      previous_version_id: current.version_id,
    })
    return {
      ...result,
      path,
      ref: fileRef(
        notionPage(current.record).locator.page_id,
        path,
        result.snapshot_id ?? current.snapshot_id,
      ),
      previous_version_id: current.version_id,
      unchanged: false,
    }
  })
}

export interface ApplyOptions extends Omit<WriteOptions, "input" | "path"> {
  /** Sparse changes, rooted at the Skill; omitted paths remain unchanged. */
  readonly input?: string
  readonly remove?: readonly string[]
  readonly name?: string
  readonly description?: string
  readonly defaultContext?: boolean
  readonly members?: readonly string[]
}

/** Merge one pinned edit, then use the existing complete replacement publication. */
export function applySkill(inputTarget: string, options: ApplyOptions = {}) {
  return Effect.gen(function* () {
    yield* rejectPublicationSourceOverride(options as PublicationOptions)
    const target = yield* Effect.try({
      try: () => {
        if (options.name !== undefined) validateDisplayName(options.name)
        if (options.description !== undefined) validateDescription(options.description)
        if (options.defaultContext !== undefined && typeof options.defaultContext !== "boolean")
          throw fail("INVALID_ARGUMENT", "Default Context must be a boolean.")
        if (
          options.input === undefined &&
          !options.remove?.length &&
          options.name === undefined &&
          options.description === undefined &&
          options.defaultContext === undefined &&
          options.members === undefined
        )
          throw fail(
            "INVALID_ARGUMENT",
            "Apply requires files, explicit removals or changed properties.",
          )
        const selected = parseTarget(inputTarget)
        if (!selected.snapshot)
          throw fail("EXACT_TARGET_REQUIRED", "Apply requires a pinned read ref or snapshot ID.")
        return selected
      },
      catch: (error) => error as SkillsError,
    })
    const baseline = yield* targetSnapshot(target, { database: options.database })
    if (baseline.scope !== (yield* authScope))
      return yield* Effect.fail(
        fail("SNAPSHOT_CONFLICT", "The snapshot belongs to another authentication scope."),
      )
    const id = notionPage(baseline.record).locator.page_id
    if (target.path && target.path !== baseline.entrypoint)
      return yield* Effect.fail(
        fail(
          "EXACT_TARGET_REQUIRED",
          "Apply targets the complete Skill; use its main ref or snapshot ID.",
        ),
      )
    const current = yield* openSkill(id, { database: options.database, refresh: true })
    if (
      current.version_id !== baseline.version_id ||
      (options.defaultContext !== undefined &&
        current.record.default_context !== baseline.record.default_context)
    )
      return yield* Effect.fail(
        fail("WRITE_CONFLICT", "The remote Skill changed since the pinned read.", {
          page_id: id,
          expected_version: baseline.version_id,
          actual_version: current.version_id,
        }),
      )
    const portable = yield* snapshotAuthoredPortable(current)
    const loaded = options.input === undefined ? undefined : yield* loadImport(options.input)
    const changes = yield* Effect.try({
      try: () => {
        const pathFor = (input: string) => {
          const normalized = normalizePath(input)
          if (
            !normalized ||
            normalized !== input ||
            normalized === BUNDLE ||
            normalized === MANIFEST
          )
            throw fail(
              "INVALID_PATH",
              "Apply paths must be normalized, nonreserved relative file paths.",
              { path: input },
            )
          return normalized === current.entrypoint ? portable.main : normalized
        }
        const packaged = loaded?.files.some((file) => file.path === MANIFEST)
          ? readPortable(loaded.files)
          : undefined
        const authored = packaged ? authoredPortable(packaged) : undefined
        if (authored && (authored.kind !== portable.kind || authored.main !== portable.main))
          throw fail(
            "INVALID_CONTENT_SOURCE",
            "The portable input must preserve the pinned content kind and main path.",
          )
        const upsert = new Map<string, ImportFile>()
        // A portable manifest describes files; deletion still requires explicit remove.
        // Sparse inputs retain their paths instead of stripping a common directory.
        for (const file of authored?.files ?? loaded?.files ?? []) {
          const path = pathFor(file.path)
          if (upsert.has(path))
            throw fail("INVALID_INPUT", "Multiple input files target the same Skill path.", {
              path,
            })
          upsert.set(path, { ...file, path })
        }
        const removed = new Set<string>()
        for (const input of options.remove ?? []) {
          const path = pathFor(input)
          if (path === portable.main)
            throw fail("INVALID_PATH", "Apply cannot remove the content entrypoint.", { path })
          if (upsert.has(path) || removed.has(path))
            throw fail("INVALID_INPUT", "A path may be changed or removed once per apply.", {
              path,
            })
          if (!portable.files.some((file) => file.path === path))
            throw fail("FILE_NOT_FOUND", "The removed path does not exist in the pinned Skill.", {
              path,
            })
          removed.add(path)
        }
        if (
          loaded &&
          !upsert.size &&
          !removed.size &&
          options.name === undefined &&
          options.description === undefined &&
          options.defaultContext === undefined &&
          options.members === undefined
        )
          throw fail("INVALID_INPUT", "The changes input contains no files.")
        const name = options.name ?? portable.name
        const description = options.description ?? portable.description
        const main = upsert.get(portable.main)
        const doc = main ? pinnedDocument(main, { name, description }, id) : undefined
        const merged: PortableSkill = {
          ...portable,
          name,
          description,
          ...(portable.projection
            ? {
                projection: {
                  ...portable.projection,
                  name,
                  description,
                  ...(doc ? { body: doc.body } : {}),
                },
              }
            : {}),
          files: [
            ...portable.files.filter((file) => !upsert.has(file.path) && !removed.has(file.path)),
            ...upsert.values(),
          ],
        }
        portableFiles(merged)
        return { portable: merged, files: [...upsert.keys()].sort(), removed: [...removed].sort() }
      },
      catch: (error) =>
        error instanceof SkillsError
          ? error
          : fail("INVALID_INPUT", "Could not construct a complete Skill edit."),
    })
    const result = yield* replaceSkill(changes.portable, { ...options, target: baseline })
    return { ...result, changes: { files: changes.files, removed: changes.removed } }
  })
}

export interface CreateOptions extends ImportMetadataOptions, PublicationOptions {
  readonly database?: string
  readonly dryRun?: boolean
  readonly storage?: "markdown_files" | "notion_blocks"
  readonly members?: readonly string[]
  /** Internal receipt policy. Public create never sets this. */
  readonly allowSameName?: boolean
  /** Change only the exact target page checkbox when explicitly requested. */
  readonly defaultContext?: boolean
}
export interface ReplaceOptions extends CreateOptions {
  readonly target: string | Snapshot
}

export function createSkill(input: string, options: CreateOptions = {}) {
  return saveInput(input, options, "create")
}

export function replaceSkill(input: string | PortableSkill, options: ReplaceOptions) {
  return Effect.gen(function* () {
    const selected = options?.target
    if (!selected)
      return yield* Effect.fail(
        fail(
          "EXACT_TARGET_REQUIRED",
          "Replacement requires a page ID, page URL, page-ID main ref or pinned snapshot.",
        ),
      )
    const baseline =
      typeof selected === "string"
        ? yield* Effect.gen(function* () {
            const target = yield* Effect.try({
              try: () => parseTarget(selected),
              catch: (error) => error as SkillsError,
            })
            if (
              (!target.snapshot && !pageId(target.selector)) ||
              (target.path && !["SKILL.md", "ROUTER.md", "PROMPT.md"].includes(target.path))
            )
              return yield* Effect.fail(
                fail(
                  "EXACT_TARGET_REQUIRED",
                  "Replacement requires a page ID, page URL, page-ID main ref or pinned snapshot.",
                ),
              )
            return target.snapshot
              ? yield* targetSnapshot(target, { database: options.database })
              : yield* openSkill(pageId(target.selector)!, {
                  database: options.database,
                  refresh: true,
                })
          })
        : selected
    return typeof input === "string"
      ? yield* saveInput(input, options, "replace", baseline)
      : yield* saveDocument(input, options, "replace", baseline)
  })
}

export function createPortable(portable: PortableSkill, options: CreateOptions = {}) {
  return saveDocument(portable, options, "create")
}

function saveInput(
  input: string,
  options: CreateOptions,
  operation: "create" | "replace",
  baseline?: Snapshot,
) {
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
          ...(portable?.projection ? { projection: portable.projection } : {}),
          kind: portable?.kind ?? "skill",
          name: doc.name,
          description: doc.description,
          main: entry.main.path,
          files: [entry.main, ...entry.attachments],
        } satisfies PortableSkill
      },
      catch: (e) => e as SkillsError,
    })
    return {
      ...(yield* saveDocument(source, options, operation, baseline, {
        input_type: loaded.kind,
        main_path: source.main,
      })),
      input_type: loaded.kind,
      main_path: source.main,
    }
  })
}

export function resumePublication(operationId: string, options: PublicationOptions = {}) {
  return Effect.gen(function* () {
    yield* rejectPublicationSourceOverride(options)
    if (!/^p_[a-zA-Z0-9-]{1,100}$/.test(operationId))
      return yield* Effect.fail(fail("INVALID_ARGUMENT", "Invalid publication operation ID."))
    const store = yield* Store
    const retained = yield* store.readJson(
      `publications/${operationId}.json`,
      PublicationReceiptSchema,
    )
    if (retained?.context?.content_adoption)
      return yield* resumeContentAdoption(operationId, options)
    if (retained?.context?.markdown_files)
      return yield* resumeMarkdownFilesPublication(operationId, options)
    return yield* recoverPublication(
      operationId,
      options,
      (portable, id, database, session, operation, context) =>
        Effect.gen(function* () {
          const current = yield* openSkill(id, { database, refresh: true })
          return yield* executePublicationDocument(
            portable,
            {
              ...options,
              database,
              ...(context?.members ? { members: context.members } : {}),
              ...(context?.allow_same_name ? { allowSameName: true } : {}),
              ...(context?.default_context === undefined
                ? {}
                : { defaultContext: context.default_context }),
            },
            operation,
            session,
            current,
          )
        }),
    )
  })
}

/** Continue frozen reviewed replacement input after a proven read-only prepare failure. */
export function resumePreparedPublication<R, E>(
  operationId: string,
  bounds: PreparedPublicationRecovery<R, E>,
  options: PublicationOptions = {},
) {
  return recoverPreparedPublication(operationId, bounds, options, false, (session, baseline) =>
    executePublicationDocument(
      bounds.portable,
      { ...options, database: notionPage(bounds.baseline.record).locator.database_id },
      "replace",
      session,
      baseline,
    ).pipe(Effect.provideService(Notion, session.notion)),
  )
}

function saveDocument(
  portable: PortableSkill,
  options: CreateOptions,
  operation: "create" | "replace" | "write",
  baseline?: Snapshot,
  context?: PublicationContext,
) {
  return Effect.gen(function* () {
    portable = yield* Effect.try({
      try: () => authoredPortable(portable),
      catch: (error) => error as SkillsError,
    })
    if (
      portable.main !== entrypointFor(portable.kind) &&
      portable.files.some(
        (file) => file.path !== portable.main && file.path === entrypointFor(portable.kind),
      )
    )
      return yield* Effect.fail(
        fail(
          "INVALID_CONTENT_SOURCE",
          "The canonical entrypoint collides with another source Markdown page.",
          { path: entrypointFor(portable.kind), main: portable.main },
        ),
      )
    if (options.storage === "markdown_files" && portable.kind !== "skill")
      return yield* Effect.fail(
        fail(
          "INVALID_CONTENT_SOURCE",
          "Editable file storage requires a Skill; Prompt and Router use native publication.",
        ),
      )
    if (
      portable.kind === "skill" &&
      (options.storage === "markdown_files" ||
        (options.storage === undefined && baseline?.markdown_files))
    )
      return yield* publishMarkdownFiles(portable, {
        ...options,
        target: baseline,
        operation,
        context,
      })
    const retainedContext =
      options.members === undefined &&
      options.allowSameName === undefined &&
      options.defaultContext === undefined
        ? context
        : {
            ...context,
            ...(options.members === undefined ? {} : { members: options.members }),
            ...(options.allowSameName ? { allow_same_name: true } : {}),
            ...(options.defaultContext === undefined
              ? {}
              : { default_context: options.defaultContext }),
          }
    const session = yield* options.dryRun
      ? progressPublication(options, operation, retainedContext)
      : beginPublication(portable, operation, options, retainedContext)
    return yield* session.finish(
      session
        .run("prepare", executePublicationDocument(portable, options, operation, session, baseline))
        .pipe(Effect.provideService(Notion, session.notion)),
    )
  })
}

/** Retained bytes identify a same-source request; they never prove live pages.
 * A live export may incorporate external edits and therefore cannot answer this
 * separate policy question after its identity differs from the submitted input. */
function retainedSourceMatches(snapshot: Snapshot, contentId: string) {
  return Effect.gen(function* () {
    const archive = (snapshot.source_files ?? snapshot.files).find((file) => file.path === BUNDLE)
    if (!archive) return false
    const store = yield* Store
    const bytes = yield* store.readBytes(`objects/${archive.sha256}`)
    if (bytes.length !== archive.bytes || (yield* sha256(bytes)) !== archive.sha256)
      return yield* Effect.fail(
        fail("STATE_CORRUPT", "Retained source archive failed its snapshot checksum.", {
          path: archive.path,
        }),
      )
    const decodeSource = yield* portableSourceDecoder
    const source = yield* Effect.try({
      try: () => decodeSource(readImportZip(bytes)),
      catch: (error) =>
        error instanceof SkillsError
          ? error
          : fail("INVALID_ARCHIVE", "Could not decode the retained source archive."),
    })
    if (!source)
      return yield* Effect.fail(
        fail("INVALID_ARCHIVE", "Reserved source attachment has no portable manifest."),
      )
    if (source.kind !== snapshot.record.kind)
      return yield* Effect.fail(
        fail("INVALID_CONTENT_SOURCE", "Portable source kind differs from the selected record."),
      )
    return (yield* portableIdentity(source)) === contentId
  })
}

export function executePublicationDocument(
  portable: PortableSkill,
  options: CreateOptions,
  operation: "create" | "replace" | "write",
  session: Publication,
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
    if (operation !== "create" && !baseline)
      return yield* Effect.fail(
        fail("EXACT_TARGET_REQUIRED", "An existing baseline is required for replacement or write."),
      )
    let current = baseline
    if (baseline) {
      current = yield* session.validate(
        Effect.gen(function* () {
          if (baseline.scope !== (yield* authScope))
            return yield* Effect.fail(
              fail("SNAPSHOT_CONFLICT", "The snapshot belongs to another authentication scope."),
            )
          const readLatest = openSkill(notionPage(baseline.record).locator.page_id, {
            database: options.database,
            refresh: true,
          })
          // A pinned public view includes the active source-link projection. Prove
          // that exact view before entering the publication's source-byte view.
          const latest = yield* baseline.source_projection
            ? readLatest.pipe(Effect.provideService(PublicationReadOperation, undefined))
            : readLatest
          if (
            latest.version_id !== baseline.version_id ||
            (options.defaultContext !== undefined &&
              latest.record.default_context !== baseline.record.default_context) ||
            notionPage(latest.record).locator.database_id !==
              notionPage(baseline.record).locator.database_id ||
            notionPage(latest.record).locator.data_source_id !==
              notionPage(baseline.record).locator.data_source_id
          )
            return yield* Effect.fail(
              fail("WRITE_CONFLICT", "The remote Skill changed since the expected baseline.", {
                page_id: notionPage(baseline.record).locator.page_id,
                expected_version: baseline.version_id,
                actual_version: latest.version_id,
              }),
            )
          if (baseline.source_projection) {
            const source = yield* readLatest
            if (
              !latest.source_projection ||
              source.source_projection ||
              latest.scope !== source.scope ||
              latest.record.id !== source.record.id ||
              latest.record.kind !== source.record.kind ||
              latest.entrypoint !== source.entrypoint ||
              notionPage(latest.record).locator.database_id !==
                notionPage(source.record).locator.database_id ||
              notionPage(latest.record).locator.data_source_id !==
                notionPage(source.record).locator.data_source_id ||
              JSON.stringify(latest.source_files) !==
                JSON.stringify(source.source_files ?? source.files) ||
              (yield* sha256(
                JSON.stringify([source.version_id, latest.source_projection, latest.files]),
              )) !== latest.version_id
            )
              return yield* Effect.fail(
                fail(
                  "WRITE_CONFLICT",
                  "The source publication changed across its projected baseline proof.",
                  {
                    page_id: notionPage(baseline.record).locator.page_id,
                    expected_version: baseline.version_id,
                    actual_version: source.version_id,
                  },
                ),
              )
            return source
          }
          return latest
        }),
      )
    }
    let databaseId = current ? notionPage(current.record).locator.database_id : undefined
    let dataSourceId = current ? notionPage(current.record).locator.data_source_id : undefined
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
      const directory = yield* catalog({ database: databaseId, refresh: true }, "content")
      if (directory.coverage.failed_sources.length)
        return yield* Effect.fail(
          fail("CATALOG_INCOMPLETE", "Cannot prove Skill name uniqueness.", directory.coverage),
        )
      const sameName = options.allowSameName === true
      const matches = directory.records.filter((skill) => skill.alias === aliasFor(doc.name))
      if (!sameName && matches.length > 1)
        return yield* Effect.fail(
          fail("SKILL_AMBIGUOUS", "Multiple pages share this invocation name.", {
            candidates: matches,
            databases: directory.databases,
          }),
        )
      if (!sameName && matches[0])
        return yield* Effect.fail(
          fail(
            "CREATE_CONFLICT",
            "A Skill with this invocation name already exists; use replace with its exact page identity.",
            {
              page_id: matches[0].id,
              name: doc.name,
              database_id: databaseId,
              data_source_id: dataSourceId,
            },
          ),
        )
    }
    const api = yield* Notion
    const raw = yield* api.request(
      current
        ? `v1/pages/${notionPage(current.record).locator.page_id}`
        : `v1/data_sources/${dataSourceId}`,
    )
    const props = yield* Effect.try({
      try: () => pageProperties(raw, options),
      catch: (e) => e as SkillsError,
    })
    const members =
      options.members === undefined
        ? undefined
        : (yield* resolveRouterMembers(
            options.members,
            { database_id: databaseId!, data_source_id: dataSourceId! },
            portable.kind,
          )).map((member) => pageId(member.id)!)
    const memberProperty =
      members === undefined
        ? undefined
        : yield* Effect.try({
            try: () => String(membersProperty(raw).id),
            catch: (error) => error as SkillsError,
          })
    const sameMembers =
      members === undefined ||
      !current ||
      JSON.stringify(members) ===
        JSON.stringify(
          yield* Effect.try({ try: () => memberIds(raw), catch: (error) => error as SkillsError }),
        )
    if (members !== undefined && !props.references)
      return yield* Effect.fail(
        fail(
          "INVALID_CONTENT_SOURCE",
          "Router Members require the content References publication path.",
        ),
      )
    yield* session.bind(
      {
        database_id: databaseId!,
        data_source_id: dataSourceId!,
        ...(current ? { page_id: notionPage(current.record).locator.page_id } : {}),
      },
      current?.scope ?? (yield* authScope),
    )
    if (current && operation === "replace" && !current.markdown_files) {
      const saved = yield* snapshotAuthoredPortable(current)
      const sourcePolicy = yield* Effect.serviceOption(PortableSourceDecoder)
      const sameSourceArchive =
        sourcePolicy._tag === "None" || !sourcePolicy.value.rewriteSourceArchive
      const sameContent =
        sameSourceArchive &&
        (props.references && !props.files
          ? (yield* referenceContentIdentity(saved)) === (yield* referenceContentIdentity(portable))
          : (yield* portableIdentity(saved)) === contentId)
      let samePages = !props.references
      // A same-source request must still prove its live pages. A changed live
      // export cannot silently turn failed reuse verification into an update.
      if (
        sameSourceArchive &&
        props.references &&
        (sameContent || (yield* retainedSourceMatches(current, contentId)))
      ) {
        const expectedPaths = new Set(
          portable.files
            .filter((file) => file.path === portable.main || /\.md$/i.test(file.path))
            .map((file) => file.path),
        )
        const livePaths = new Set(
          (current.references ?? []).map((page) =>
            page.path === current.entrypoint ? portable.main : page.path,
          ),
        )
        const additionsOnly =
          livePaths.has(portable.main) &&
          livePaths.size < expectedPaths.size &&
          [...livePaths].every((path) => expectedPaths.has(path))
        if (additionsOnly) {
          // An earlier native layout kept some Markdown only in Files. Prove
          // every existing live page before adding the missing authored paths;
          // missing pages are not reuse, and damaged pages must still fail.
          yield* referencePagesMatch(current, {
            ...portable,
            files: portable.files.filter((file) => livePaths.has(file.path)),
          })
        } else samePages = yield* referencePagesMatch(current, portable)
      }
      const same = sameContent && samePages && sameMembers
      if (same) {
        if (!props.references) yield* verifyBody(current, doc.body)
        yield* session.validate(assertVersion(current))
        const contextChanged =
          options.defaultContext !== undefined &&
          current.record.default_context !== options.defaultContext
        let observed = current
        if (contextChanged && !options.dryRun) {
          // A property-only publication still freezes its original body before the first PATCH.
          yield* api.request(`v1/pages/${notionPage(current.record).locator.page_id}/markdown`)
          yield* session.run(
            "metadata",
            api.request(
              `v1/pages/${notionPage(current.record).locator.page_id}`,
              { properties: { [props.defaultContext!]: { checkbox: options.defaultContext! } } },
              { method: "PATCH" },
            ),
          )
          observed = yield* session.validate(
            openSkill(notionPage(current.record).locator.page_id, {
              database: options.database,
              refresh: true,
            }),
          )
          if (observed.record.default_context !== options.defaultContext)
            return yield* Effect.fail(
              fail(
                "WRITE_VERIFICATION_FAILED",
                "Saved Default Context differs from the requested checkbox.",
              ),
            )
        }
        const metadataSame = yield* session.metadataUnchanged()
        return {
          ...snapshotInfo(observed),
          operation,
          action: metadataSame && !contextChanged ? "reuse" : "update",
          reused: metadataSame && !contextChanged,
          content_id: yield* portableIdentity(saved),
          previous_version_id: current.version_id,
          expected_version_id: baseline?.version_id ?? current.version_id,
          verified: true,
          ...(options.dryRun ? { dry_run: true } : {}),
        }
      }
    }
    let oldBody = ""
    if (current && !props.references) {
      const rawBody = yield* api.request(
        `v1/pages/${notionPage(current.record).locator.page_id}/markdown`,
      )
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
            page_id: notionPage(current.record).locator.page_id,
            base_version_id: current.version_id,
            previous_version_id: current.version_id,
            expected_version_id: baseline?.version_id ?? current.version_id,
            snapshot_id: current.snapshot_id,
            ref: snapshotInfo(current).ref,
          }
        : {}),
      files: portable.files.map((file) => ({ path: file.path, bytes: file.bytes.length })),
    }
    if (options.dryRun) {
      if (props.references) yield* referenceInput(portable, Boolean(props.files))
      return { ...plan, dry_run: true }
    }
    if (props.references)
      return yield* saveReferences(
        portable,
        doc,
        {
          title: props.title,
          description: props.description,
          references: props.references,
          files: props.files,
          ...(members === undefined
            ? {}
            : { members: { property: memberProperty!, ids: members } }),
          ...(props.defaultContext === undefined
            ? {}
            : {
                defaultContext: { property: props.defaultContext, value: options.defaultContext! },
              }),
        },
        { database_id: databaseId!, data_source_id: dataSourceId! },
        operation,
        current,
        session.upload,
        session,
      ).pipe(
        Effect.map((saved) => ({
          ...saved,
          ...(baseline ? { expected_version_id: baseline.version_id } : {}),
        })),
      )
    const completed: string[] = []
    let id = current ? notionPage(current.record).locator.page_id : undefined
    let stage = "prepare"
    return yield* Effect.gen(function* () {
      if (current) yield* session.validate(assertVersion(current))
      else {
        stage = "create_page"
        const created = yield* session.run(
          stage,
          api.request("v1/pages", {
            parent: { type: "data_source_id", data_source_id: dataSourceId },
            properties: {
              [props.title]: { title: [{ text: { content: doc.name } }] },
              [props.description]: { rich_text: [{ text: { content: doc.description } }] },
              ...(props.defaultContext === undefined
                ? {}
                : { [props.defaultContext]: { checkbox: options.defaultContext! } }),
            },
          }),
        )
        completed.push(stage)
        id = yield* Effect.try({
          try: () => decode(PageSchema, created).id,
          catch: (e) => e as SkillsError,
        })
      }
      let expectedBody = oldBody
      if (bodyIdentity(oldBody) !== bodyIdentity(doc.body)) {
        stage = "body"
        const written = yield* session.run(
          stage,
          api.request(
            `v1/pages/${id}/markdown`,
            {
              markdown_version: "v2",
              ...(oldBody
                ? {
                    type: "update_content",
                    update_content: { content_updates: [{ old_str: oldBody, new_str: doc.body }] },
                  }
                : { type: "replace_content", replace_content: { new_str: doc.body } }),
            },
            { method: "PATCH" },
          ),
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
      const bundle = yield* session.run(stage, session.upload({ bytes }, BUNDLE))
      completed.push("upload:source_bundle")
      stage = "metadata"
      yield* session.validate(
        Effect.gen(function* () {
          const actual = decode(ExportSchema, yield* api.request(`v1/ai/skills/${id}`))
          if (actual.id !== beforeUpload.id || actual.version_id !== beforeUpload.version_id)
            return yield* Effect.fail(
              fail("WRITE_CONFLICT", "Remote content changed before attachment publication."),
            )
        }),
      )
      yield* session.run(
        stage,
        api.request(
          `v1/pages/${id}`,
          {
            properties: {
              ...(operation === "write"
                ? {}
                : {
                    [props.title]: { title: [{ text: { content: doc.name } }] },
                    [props.description]: { rich_text: [{ text: { content: doc.description } }] },
                  }),
              [props.files!]: { files: [bundle] },
              ...(props.defaultContext === undefined
                ? {}
                : { [props.defaultContext]: { checkbox: options.defaultContext! } }),
            },
          },
          { method: "PATCH" },
        ),
      )
      completed.push(stage)
      stage = "verify_export"
      const snapshot = yield* session.validate(
        Effect.gen(function* () {
          const snapshot = yield* session.run(stage, openSkill(id!, { refresh: true }))
          if (snapshot.record.name !== doc.name || snapshot.record.description !== doc.description)
            return yield* Effect.fail(
              fail(
                "WRITE_VERIFICATION_FAILED",
                "Skill metadata differs from the submitted values.",
              ),
            )
          if (
            options.defaultContext !== undefined &&
            snapshot.record.default_context !== options.defaultContext
          )
            return yield* Effect.fail(
              fail(
                "WRITE_VERIFICATION_FAILED",
                "Saved Default Context differs from the requested checkbox.",
              ),
            )
          yield* verifyFiles(snapshot, [{ path: BUNDLE, bytes }])
          const readback = yield* api.request(`v1/pages/${id}/markdown`)
          const body = yield* Effect.try({
            try: () => markdown(readback),
            catch: (e) => e as SkillsError,
          })
          const root = snapshot.references?.find((page) => page.path === snapshot.entrypoint)
          if (
            body !== expectedBody ||
            markdownIdentity(fromNotionMarkdown(body, root?.blocks)) !== markdownIdentity(doc.body)
          )
            return yield* Effect.fail(
              fail("WRITE_VERIFICATION_FAILED", "Page Markdown differs from submitted content."),
            )
          yield* verifyBody(snapshot, body)
          if ((yield* portableIdentity(yield* snapshotAuthoredPortable(snapshot))) !== contentId)
            return yield* Effect.fail(
              fail(
                "WRITE_VERIFICATION_FAILED",
                "Saved Skill files differ from the submitted content.",
              ),
            )
          return snapshot
        }),
      )
      return {
        ...snapshotInfo(snapshot),
        operation,
        action,
        verified: true,
        content_id: contentId,
        reused: false,
        ...(current
          ? {
              previous_version_id: current.version_id,
              expected_version_id: baseline?.version_id ?? current.version_id,
            }
          : {}),
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
      Effect.tapError((error) =>
        id && (error.code === "WRITE_PARTIAL" || error.code === "WRITE_OUTCOME_UNKNOWN")
          ? invalidateSnapshotCache(id, current?.scope).pipe(Effect.catch(() => Effect.void))
          : Effect.void,
      ),
    )
  })
}
