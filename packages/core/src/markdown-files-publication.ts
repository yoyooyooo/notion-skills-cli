import { Crypto, Effect } from "effect"
import { withLocalLocks } from "./local-locks.ts"
import { publicationSession } from "./publication.ts"
import { PublicationReceiptSchema } from "./publication-model.ts"
import { Store, sha256 } from "./store.ts"
import { publicationMarker } from "./publication-integrity.ts"
import { readMarkdownFileBlocks } from "./markdown-files.ts"
import { hostname } from "node:os"
import { authScope, creationSource, catalog } from "./catalog.ts"
import { aliasFor, fail, notionPage, property, type Snapshot, type SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import {
  beginPublication,
  progressPublication,
  type PublicationOptions,
  type PublicationContext,
} from "./publication.ts"
import { PublicationReadOperation } from "./publication-integrity.ts"
import { openSkill, snapshotInfo } from "./snapshot.ts"
import { portableIdentity, snapshotAuthoredPortable } from "./export.ts"
import {
  markdownFileChunks,
  markdownFileCode,
  markdownFileSpans,
  markdownFilesHeader,
} from "./markdown-files.ts"
import { importDocument } from "./import.ts"
import type { PortableSkill } from "./portable.ts"
import {
  reconcileMarkdownFileAppend,
  reconcileMarkdownFileProperties,
} from "./markdown-files-recovery.ts"
import { observation, canonical } from "./publication-observation.ts"
import { unresolvedIntent } from "./publication-upload.ts"
import {
  retryEditableMetadata,
  type EditableMetadataRetry,
} from "./markdown-files-metadata-retry.ts"
import {
  bindPublicationSource,
  publicationGuardComparison,
  rejectPublicationSourceOverride,
  unobservedPublicationMetadataAck,
  verifyPublicationMetadata,
} from "./publication-source.ts"

function defaultContextProperties(raw: unknown, value: boolean | undefined) {
  if (value === undefined) return undefined
  const field = property(property(property(raw).properties)["Default Context"])
  if (field.type !== "checkbox" || typeof field.id !== "string")
    throw fail("PROPERTY_UNAVAILABLE", "Default Context must be an existing checkbox property.")
  return { [field.id]: { checkbox: value } }
}

function applyDefaultContext(pageId: string, value: boolean | undefined, api: Notion["Service"]) {
  return Effect.gen(function* () {
    if (value === undefined) return
    const raw = yield* api.request(`v1/pages/${pageId}`)
    const properties = yield* Effect.try({
      try: () => defaultContextProperties(raw, value),
      catch: (error) => error as SkillsError,
    })
    if (property(property(property(raw).properties)["Default Context"]).checkbox === value) return
    yield* api.request(`v1/pages/${pageId}/markdown`)
    yield* api.request(`v1/pages/${pageId}`, { properties }, { method: "PATCH" })
  })
}

/** Files are editable code text; neither the Markdown parser nor a source ZIP
 * participates in their write/read proof. Every remote mutation is journalled. */
export function publishMarkdownFiles(
  portable: PortableSkill,
  options: PublicationOptions & {
    readonly database?: string
    readonly target?: Snapshot
    readonly dryRun?: boolean
    readonly defaultContext?: boolean
    readonly members?: readonly string[]
    readonly operation?: "create" | "replace" | "write"
    readonly context?: PublicationContext
  },
) {
  return Effect.gen(function* () {
    if (options.members !== undefined)
      return yield* Effect.fail(
        fail(
          "INVALID_CONTENT_SOURCE",
          "Members belong to a Router; editable file storage contains a Skill.",
        ),
      )
    if (portable.kind !== "skill" || portable.files.length > 10000)
      return yield* Effect.fail(
        fail("INVALID_CONTENT_SOURCE", "Editable file publication currently requires a Skill."),
      )
    const decoded = yield* Effect.try({
      try: () =>
        portable.files.map((file) => ({
          path: file.path,
          text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(file.bytes),
        })),
      catch: () =>
        fail("INVALID_CONTENT_SOURCE", "Editable file publication requires UTF-8 text resources."),
    })
    if (decoded.some((file) => file.text.includes("\0")))
      return yield* Effect.fail(
        fail("INVALID_CONTENT_SOURCE", "Editable file publication requires UTF-8 text resources."),
      )
    if (decoded.some((file) => file.text.includes("\r")))
      return yield* Effect.fail(
        fail(
          "INVALID_CONTENT_SOURCE",
          "Notion code blocks normalize carriage returns. Normalize text to LF before selecting editable file storage, or use native Files storage for exact source bytes.",
        ),
      )
    const operation = options.operation ?? (options.target ? "replace" : "create")
    const doc = yield* Effect.try({
      try: () =>
        importDocument(portable.files.find((file) => file.path === portable.main)!, portable),
      catch: (error) => error as SkillsError,
    })
    if (options.target) {
      if (options.target.scope !== (yield* authScope))
        return yield* Effect.fail(
          fail("SNAPSHOT_CONFLICT", "The snapshot belongs to another authentication scope."),
        )
      const current = yield* openSkill(notionPage(options.target.record).locator.page_id, {
        database: options.database,
        refresh: true,
      })
      if (
        current.version_id !== options.target.version_id ||
        (options.defaultContext !== undefined &&
          current.record.default_context !== options.target.record.default_context)
      )
        return yield* Effect.fail(
          fail("WRITE_CONFLICT", "The selected Skill changed before overwrite."),
        )
    }
    const source = options.target
      ? notionPage(options.target.record).locator
      : yield* creationSource(options.database)
    const dataSource =
      "data_source_id" in source ? source.data_source_id : source.data_source_ids[0]
    if (!dataSource || (!("data_source_id" in source) && source.data_source_ids.length !== 1))
      return yield* Effect.fail(
        fail("DATABASE_AMBIGUOUS", "Select exactly one content data source."),
      )
    if (options.defaultContext !== undefined) {
      const raw = yield* (yield* Notion).request(
        options.target
          ? `v1/pages/${notionPage(options.target.record).locator.page_id}`
          : `v1/data_sources/${dataSource}`,
      )
      yield* Effect.try({
        try: () => defaultContextProperties(raw, options.defaultContext),
        catch: (error) => error as SkillsError,
      })
    }
    const context = {
      ...options.context,
      markdown_files: true,
      ...(options.defaultContext === undefined ? {} : { default_context: options.defaultContext }),
    }
    const operationId =
      options.operationId ??
      `p_${yield* (yield* Crypto.Crypto)
        .randomUUIDv4()
        .pipe(
          Effect.mapError(() =>
            fail("CRYPTO_ERROR", "Could not allocate a file publication identity."),
          ),
        )}`
    const session = yield* options.dryRun
      ? progressPublication(options, operation, context)
      : beginPublication(portable, operation, { ...options, operationId }, context)
    if (!options.target) {
      const directory = yield* catalog({ database: source.database_id, refresh: true }, "content")
      if (directory.coverage.failed_sources.length)
        return yield* Effect.fail(
          fail("CATALOG_INCOMPLETE", "Cannot prove target name uniqueness."),
        )
      const matches = directory.records.filter((record) => record.alias === aliasFor(doc.name))
      if (matches.length > 1)
        return yield* Effect.fail(
          fail("SKILL_AMBIGUOUS", "Multiple pages share this invocation name.", {
            candidates: matches,
            databases: directory.databases,
          }),
        )
      if (matches[0])
        return yield* Effect.fail(
          fail(
            "CREATE_CONFLICT",
            "A Skill with this invocation name already exists; use replace with its exact page identity.",
            {
              page_id: matches[0].id,
              name: doc.name,
              database_id: source.database_id,
              data_source_id: dataSource,
            },
          ),
        )
    }
    yield* session.bind(
      {
        database_id: source.database_id,
        data_source_id: dataSource,
        ...(options.target ? { page_id: notionPage(options.target.record).locator.page_id } : {}),
      },
      yield* authScope,
    )
    const sameContent =
      options.target?.markdown_files &&
      (yield* portableIdentity(yield* snapshotAuthoredPortable(options.target))) ===
        (yield* portableIdentity(portable))
    const contextSame =
      options.defaultContext === undefined ||
      options.target?.record.default_context === options.defaultContext
    const metadataSame = sameContent ? yield* session.metadataUnchanged() : false
    if (options.dryRun)
      return {
        dry_run: true,
        storage: "markdown_files",
        database_id: source.database_id,
        data_source_id: dataSource,
        name: portable.name,
        operation,
        action:
          sameContent && metadataSame && contextSame
            ? ("reuse" as const)
            : options.target
              ? ("update" as const)
              : ("create" as const),
        content_id: yield* portableIdentity(portable),
        reused: Boolean(sameContent && metadataSame && contextSame),
        snapshot_id: options.target?.snapshot_id,
        previous_version_id: options.target?.version_id,
        operation_id: operationId,
        files: decoded.map((file) => ({
          path: file.path,
          bytes: new TextEncoder().encode(file.text).length,
        })),
      }
    return yield* session.finish(
      Effect.gen(function* () {
        const api = session.notion
        yield* session.bind(
          {
            database_id: source.database_id,
            data_source_id: dataSource,
            ...(options.target
              ? { page_id: notionPage(options.target.record).locator.page_id }
              : {}),
          },
          yield* authScope,
        )
        let id = options.target ? notionPage(options.target.record).locator.page_id : undefined
        if (id && options.target) {
          const current = yield* openSkill(id, { database: source.database_id, refresh: true })
          if (
            current.version_id !== options.target.version_id ||
            (options.defaultContext !== undefined &&
              current.record.default_context !== options.target.record.default_context)
          )
            return yield* Effect.fail(
              fail("WRITE_CONFLICT", "The selected Skill changed before overwrite."),
            )
          if (
            current.markdown_files &&
            (yield* portableIdentity(yield* snapshotAuthoredPortable(current))) ===
              (yield* portableIdentity(portable))
          ) {
            yield* applyDefaultContext(id, options.defaultContext, api)
            const observed = contextSame
              ? current
              : yield* openSkill(id, { database: source.database_id, refresh: true }).pipe(
                  Effect.provideService(PublicationReadOperation, session.operationId),
                )
            if (
              options.defaultContext !== undefined &&
              observed.record.default_context !== options.defaultContext
            )
              return yield* Effect.fail(
                fail(
                  "WRITE_VERIFICATION_FAILED",
                  "Saved Default Context differs from the requested checkbox.",
                ),
              )
            return {
              ...snapshotInfo(observed),
              operation,
              verified: true,
              action: metadataSame && contextSame ? ("reuse" as const) : ("update" as const),
              previous_version_id: current.version_id,
              storage: "markdown_files",
              content_id: yield* portableIdentity(portable),
              reused: metadataSame && contextSame,
            }
          }
          if (current.markdown_files) {
            // A child inventory omits ordinary blocks. Retain concrete ancestors
            // so the acknowledged clear can retire only this page's old guards.
            const originalBlocks = yield* readMarkdownFileBlocks(id, api)
            for (const block of originalBlocks) yield* api.request(`v1/blocks/${String(block.id)}`)
          }
          yield* api.request(
            `v1/pages/${id}/markdown`,
            { markdown_version: "v2", type: "replace_content", replace_content: { new_str: "" } },
            { method: "PATCH" },
          )
          if (operation !== "write")
            yield* api.request(
              `v1/pages/${id}`,
              {
                properties: {
                  title: { title: [{ text: { content: doc.name } }] },
                  Description: { rich_text: markdownFileSpans(doc.description) },
                },
              },
              { method: "PATCH" },
            )
        } else {
          const created = property(
            yield* api.request("v1/pages", {
              parent: { type: "data_source_id", data_source_id: dataSource },
              properties: {
                title: { title: [{ text: { content: doc.name } }] },
                Description: { rich_text: markdownFileSpans(doc.description) },
                Kind: { select: { name: "skill" } },
                References: { rich_text: [] },
              },
            }),
          )
          if (typeof created.id !== "string")
            return yield* Effect.fail(
              fail("WRITE_OUTCOME_UNKNOWN", "File page creation returned no identity."),
            )
          id = created.id
        }
        yield* appendMarkdownFiles(portable, id!, api)
        yield* applyDefaultContext(id!, options.defaultContext, api)
        const snapshot = yield* openSkill(id!, {
          database: source.database_id,
          refresh: true,
        }).pipe(Effect.provideService(PublicationReadOperation, session.operationId))
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
        const saved = yield* snapshotAuthoredPortable(snapshot)
        if ((yield* portableIdentity(saved)) !== (yield* portableIdentity(portable)))
          return yield* Effect.fail(
            fail(
              "WRITE_VERIFICATION_FAILED",
              "Live editable files differ from the complete input.",
            ),
          )
        return {
          ...snapshotInfo(snapshot),
          operation,
          verified: true,
          action: options.target ? ("update" as const) : ("create" as const),
          previous_version_id: options.target?.version_id,
          storage: "markdown_files",
          content_id: yield* portableIdentity(saved),
          reused: false,
        }
      }).pipe(Effect.provideService(Notion, session.notion)),
    )
  })
}

export function appendMarkdownFiles(
  portable: PortableSkill,
  id: string,
  api: Notion["Service"],
  existing: readonly Record<string, unknown>[] = [],
) {
  return Effect.gen(function* () {
    const literal = (value: unknown) => {
      if (!Array.isArray(value))
        throw fail("MARKDOWN_FILES_INVALID", "Incomplete literal file text.")
      return value
        .map((value) => {
          const span = property(value),
            text = property(span.text)
          if (span.type !== "text" || typeof text.content !== "string" || text.link != null)
            throw fail("MARKDOWN_FILES_INVALID", "Nonliteral file content.")
          return text.content
        })
        .join("")
    }
    const header = markdownFilesHeader(portable.main)
    if (!existing.length)
      yield* api.request(
        `v1/blocks/${id}/children`,
        {
          children: [
            {
              object: "block",
              type: "paragraph",
              paragraph: { rich_text: markdownFileSpans(header) },
            },
          ],
        },
        { method: "PATCH" },
      )
    else if (
      existing[0]!.type !== "paragraph" ||
      literal(property(existing[0]!.paragraph).rich_text) !== header
    )
      return yield* Effect.fail(fail("WRITE_CONFLICT", "The retained file header changed."))
    const actual: Array<{ path: string; id: string; text: string }> = []
    for (const block of existing.slice(1)) {
      if (block.type === "toggle" && property(block.parent).page_id === id) {
        actual.push({
          path: literal(property(block.toggle).rich_text),
          id: String(block.id),
          text: "",
        })
      } else if (
        block.type === "code" &&
        actual.length &&
        property(block.parent).block_id === actual.at(-1)!.id
      )
        actual.at(-1)!.text += literal(property(block.code).rich_text)
      else
        return yield* Effect.fail(
          fail("WRITE_CONFLICT", "Unexpected content in the retained file prefix."),
        )
    }
    if (actual.length > portable.files.length)
      return yield* Effect.fail(
        fail("WRITE_CONFLICT", "The live file tree contains additional files."),
      )
    const pending: Array<{ file: PortableSkill["files"][number]; text: string }> = []
    let pendingBytes = 0
    const flush = () =>
      Effect.gen(function* () {
        if (!pending.length) return
        yield* api.request(
          `v1/blocks/${id}/children`,
          {
            children: pending.map(({ file, text }) => ({
              object: "block",
              type: "toggle",
              toggle: {
                rich_text: markdownFileSpans(file.path),
                children: [markdownFileCode(text)],
              },
            })),
          },
          { method: "PATCH" },
        )
        pending.length = 0
        pendingBytes = 0
      })
    for (const [index, file] of portable.files.entries()) {
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(file.bytes),
        saved = actual[index]
      if (
        saved &&
        (saved.path !== file.path ||
          !text.startsWith(saved.text) ||
          (index + 1 < actual.length && saved.text !== text))
      )
        return yield* Effect.fail(
          fail("WRITE_CONFLICT", "The live file prefix differs from frozen source.", {
            path: file.path,
          }),
        )
      const remaining = text.slice(saved?.text.length ?? 0),
        chunks = markdownFileChunks(remaining, 30000)
      // Keep one append well below the API's 500 KiB JSON limit, including
      // escaping/span overhead; at most 50 roots and 100 total blocks.
      if (!saved && chunks.length === 1) {
        const bytes =
          new TextEncoder().encode(JSON.stringify({ path: file.path, text })).length + 6000
        if (pending.length && (pending.length >= 50 || pendingBytes + bytes > 350000))
          yield* flush()
        pending.push({ file, text })
        pendingBytes += bytes
        continue
      }
      yield* flush()
      if (saved && !remaining) continue
      let toggle = saved?.id
      let children: ReturnType<typeof markdownFileCode>[] = [],
        bytes = 0
      const flushChunks = () =>
        Effect.gen(function* () {
          if (!children.length) return
          if (!toggle) {
            const response = property(
              yield* api.request(
                `v1/blocks/${id}/children`,
                {
                  children: [
                    {
                      object: "block",
                      type: "toggle",
                      toggle: {
                        rich_text: markdownFileSpans(file.path),
                        children,
                      },
                    },
                  ],
                },
                { method: "PATCH" },
              ),
            )
            toggle = Array.isArray(response.results)
              ? String(property(response.results[0]).id ?? "")
              : ""
            if (!toggle)
              return yield* Effect.fail(
                fail("WRITE_OUTCOME_UNKNOWN", "File append returned no exact toggle identity."),
              )
          } else
            yield* api.request(`v1/blocks/${toggle}/children`, { children }, { method: "PATCH" })
          children = []
          bytes = 0
        })
      for (const chunk of chunks) {
        const code = markdownFileCode(chunk),
          size = new TextEncoder().encode(JSON.stringify(code)).length
        if (children.length && (children.length >= 99 || bytes + size > 350000))
          yield* flushChunks()
        children.push(code)
        bytes += size
      }
      yield* flushChunks()
    }
    yield* flush()
  })
}

export function resumeMarkdownFilesPublication(
  operationId: string,
  options: PublicationOptions = {},
) {
  return Effect.gen(function* () {
    const store = yield* Store
    yield* rejectPublicationSourceOverride(options)
    return yield* withLocalLocks(
      store.root,
      [`publication:${operationId}`],
      Effect.gen(function* () {
        const receipt = yield* store.readJson(
          `publications/${operationId}.json`,
          PublicationReceiptSchema,
        )
        if (
          !receipt?.context?.markdown_files ||
          !receipt.page_id ||
          !receipt.database_id ||
          !receipt.scope ||
          (yield* authScope) !== receipt.scope ||
          receipt.conflict
        )
          return yield* Effect.fail(
            fail(
              "PUBLICATION_UNRESOLVED",
              "The original editable file publication cannot be resumed.",
            ),
          )
        if (receipt.owner) {
          const owner = receipt.owner
          if (owner.host !== hostname())
            return yield* Effect.fail(
              fail("PUBLICATION_BUSY", "The publication belongs to another host."),
            )
          const alive = yield* Effect.sync(() => {
            try {
              process.kill(owner.pid, 0)
              return true
            } catch (error) {
              return property(error).code !== "ESRCH"
            }
          })
          if (alive)
            return yield* Effect.fail(
              fail("PUBLICATION_BUSY", "The original publication process is alive."),
            )
        }
        if (receipt.data_source_id)
          yield* bindPublicationSource(receipt, receipt.data_source_id, yield* Notion)
        if (receipt.state === "completed" && receipt.result) {
          yield* verifyPublicationMetadata(receipt, yield* Notion)
          const snapshot = yield* openSkill(receipt.page_id, {
            database: receipt.database_id,
            refresh: true,
          }).pipe(Effect.provideService(PublicationReadOperation, operationId))
          if (
            receipt.context.default_context !== undefined &&
            snapshot.record.default_context !== receipt.context.default_context
          )
            return yield* Effect.fail(
              fail(
                "WRITE_CONFLICT",
                "The completed publication's requested Default Context changed.",
              ),
            )
          return {
            ...receipt.result,
            ...snapshotInfo(snapshot),
            operation: receipt.operation,
            verified: true,
            action: "reuse" as const,
            storage: "markdown_files",
            content_id: yield* portableIdentity(yield* snapshotAuthoredPortable(snapshot)),
            operation_id: operationId,
            reused: true,
          }
        }
        let retry: EditableMetadataRetry | undefined
        if (options.retryMetadata) retry = yield* retryEditableMetadata(receipt, yield* Notion)
        else if (
          receipt.intents.some(
            (intent) =>
              unresolvedIntent(intent) || unobservedPublicationMetadataAck(receipt, intent),
          )
        ) {
          if (receipt.intents.at(-1)?.path === `v1/pages/${receipt.page_id}`)
            yield* reconcileMarkdownFileProperties(receipt, yield* Notion)
          else yield* reconcileMarkdownFileAppend(receipt, yield* Notion)
          yield* store.writeJson(`publications/${operationId}.json`, receipt)
        }
        const portable: PortableSkill = {
          ...receipt.portable,
          files: yield* Effect.forEach(receipt.portable.files, (file) =>
            Effect.gen(function* () {
              const bytes = yield* store.readBytes(`objects/${file.sha256}`)
              if ((yield* sha256(bytes)) !== file.sha256)
                return yield* Effect.fail(fail("STATE_CORRUPT", "Frozen source object changed."))
              return { path: file.path, bytes }
            }),
          ),
        }
        const transport = yield* Notion,
          before = yield* transport.request(`v1/pages/${receipt.page_id}`)
        const marker = publicationMarker(before)
        if (marker?.operation_id !== operationId)
          return yield* Effect.fail(fail("WRITE_CONFLICT", "The file publication marker changed."))
        const blocks = yield* readMarkdownFileBlocks(receipt.page_id, transport)
        for (const [path, expected] of Object.entries(receipt.guards)) {
          const actual = yield* transport.request(path)
          // Reuse the existing publication observation grammar, including request IDs.
          if (
            publicationGuardComparison(receipt, path, observation(path, actual)) !==
            publicationGuardComparison(receipt, path, expected)
          )
            return yield* Effect.fail(
              fail("WRITE_CONFLICT", "Retained file publication guard changed.", { path }),
            )
        }
        const metadataOnly =
          receipt.intents.length > 0 &&
          receipt.intents.every(
            (intent) => intent.method === "PATCH" && intent.path === `v1/pages/${receipt.page_id}`,
          )
        const session = yield* publicationSession(receipt, options)
        return yield* session.finish(
          Effect.gen(function* () {
            if (retry) yield* session.notion.request(retry.path, retry.body, { method: "PATCH" })
            // A metadata-only journal has no file allocation to resume; file order is not content identity.
            if (!metadataOnly)
              yield* appendMarkdownFiles(portable, receipt.page_id!, session.notion, blocks)
            yield* applyDefaultContext(
              receipt.page_id!,
              receipt.context?.default_context,
              session.notion,
            )
            const snapshot = yield* openSkill(receipt.page_id!, {
              database: receipt.database_id,
              refresh: true,
            }).pipe(Effect.provideService(PublicationReadOperation, operationId))
            if (
              receipt.context?.default_context !== undefined &&
              snapshot.record.default_context !== receipt.context.default_context
            )
              return yield* Effect.fail(
                fail(
                  "WRITE_VERIFICATION_FAILED",
                  "Saved Default Context differs from the frozen request.",
                ),
              )
            const saved = yield* snapshotAuthoredPortable(snapshot)
            if ((yield* portableIdentity(saved)) !== (yield* portableIdentity(portable)))
              return yield* Effect.fail(
                fail(
                  "WRITE_VERIFICATION_FAILED",
                  "Resumed live file tree differs from frozen source.",
                ),
              )
            return {
              ...snapshotInfo(snapshot),
              verified: true,
              operation: receipt.operation,
              action: "update" as const,
              storage: "markdown_files",
              content_id: yield* portableIdentity(saved),
              reused: false,
            }
          }).pipe(Effect.provideService(Notion, session.notion)),
        )
      }),
    )
  })
}
