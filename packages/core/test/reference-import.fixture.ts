import {
  integrityRepositoryFixture,
  upstreamRepositoryFixture,
  publicationSourceRows,
  publicationSourceSchema,
} from "./fixtures.ts"
import { createHash } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { ByteSize, Effect, FileSystem, Layer, Option } from "effect"
import { decode, fail, property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { Store } from "../src/store.ts"
import { PublicationReceiptSchema } from "../src/publication-model.ts"
import { withoutChildPages } from "../src/references.ts"
import { Lexer } from "marked"
import { markdownFileCode, markdownFileSpans, markdownFilesHeader } from "../src/markdown-files.ts"
export const database = "44444444-4444-4444-8444-444444444444"
export const root = "11111111-1111-4111-8111-111111111111"
export const encoder = new TextEncoder()
const servers = new Set<{ stop: (closeActiveConnections?: boolean) => void }>()
export function closeFixtureServers() {
  for (const server of servers) server.stop(true)
  servers.clear()
}

export function fixture(
  failure?:
    | "registration"
    | "registration_unknown"
    | "body"
    | "root_body"
    | "child_create"
    | "attachment"
    | "reference_limit",
  hasFiles = false,
  changed?: "main" | "reference",
  normalized = false,
  quoteBoundary = false,
  typedLinkRepair = false,
  literal = false,
) {
  const bundles = new Map<string, Uint8Array>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const bytes = bundles.get(new URL(request.url).pathname)
      return bytes
        ? new Response(new Blob([new Uint8Array(bytes).buffer]))
        : new Response(null, { status: 404 })
    },
  })
  servers.add(server)
  let exists = false
  let interrupted = false
  let registrationUnknownArmed = false
  let ownershipUnknownArmed = false
  let ownershipSchema = false
  let main = ""
  let literalStorage = false
  let mutations = 0
  let businessPatches = 0
  let failNextRead = false
  let changedRootRevision = false
  let singleQuote = false
  let noticeChanged = false
  const revision = { last_edited_time: "2026-10-18T00:00:00.000Z" }
  const pageRevisions = new Map<string, string>()
  const pageRevision = (id: string) =>
    pageRevisions.has(id) ? { last_edited_time: pageRevisions.get(id)! } : revision
  const blocks = new Map<string, Record<string, unknown>>()
  const inventories = new Map<string, unknown>()
  const bodyBlocks = (id: string, body: string) =>
    Lexer.lex(body)
      .filter((token) => token.type !== "space" && token.type !== "def")
      .flatMap((token, index) => {
        if (singleQuote && token.type === "paragraph" && token.text.startsWith("注意：")) return []
        const type =
          token.type === "code"
            ? "code"
            : token.type === "blockquote"
              ? "quote"
              : token.type === "heading"
                ? `heading_${token.depth}`
                : "paragraph"
        const content =
          token.type === "blockquote"
            ? token.text + (singleQuote ? "\n注意：保留原始边界。" : "")
            : "text" in token
              ? String(token.text)
              : token.raw
        const richText = typedLinkRepair
          ? Lexer.lexInline(content).map((token) => {
              const text = "text" in token ? String(token.text) : token.raw
              return {
                type: "text",
                text: {
                  content: text,
                  ...(token.type === "link" ? { link: { url: token.href } } : {}),
                },
                plain_text: text,
                annotations: { bold: false, code: false },
              }
            })
          : [
              {
                type: "text",
                text: { content },
                plain_text: content,
                annotations: { bold: false, code: false },
              },
            ]
        return [
          {
            id: createHash("sha256")
              .update(id + ":" + index)
              .digest("hex")
              .slice(0, 32)
              .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5"),
            parent: { type: "page_id", page_id: id },
            type,
            has_children: false,
            [type]: {
              rich_text: richText,
              ...(token.type === "code"
                ? { language: token.lang === "ts" ? "typescript" : token.lang || "plain text" }
                : {}),
            },
          },
        ]
      })
  const blockMarkdown = (block: Record<string, unknown>) => {
    const values = property(block[String(block.type)]).rich_text
    if (!Array.isArray(values)) throw new Error("Fixture expected a text block")
    return values
      .map((value) => {
        const text = property(property(value).text)
        const url = property(text.link).url
        return typeof url === "string" ? `[${text.content}](${url})` : String(text.content)
      })
      .join("")
  }
  const reads = new Map<string, number>()
  const propertyWrites: Array<Record<string, unknown>> = []
  const children: Array<{ id: string; title: string; body: string }> = []
  let references: unknown[] = []
  const savedProperties: Record<string, unknown> = {}
  const persistProperties = (raw: unknown) => {
    for (const [key, rawValue] of Object.entries(property(raw))) {
      if (["references", "References", "files", "Files"].includes(key)) continue
      const value = property(rawValue)
      const name =
        (
          {
            title: "Name",
            description: "Description",
            publication: "Publication",
            kind: "Kind",
          } as Record<string, string>
        )[key] ?? key
      const type = Array.isArray(value.rich_text)
        ? "rich_text"
        : Array.isArray(value.title)
          ? "title"
          : value.select
            ? "select"
            : Array.isArray(value.relation)
              ? "relation"
              : undefined
      savedProperties[name] = {
        id:
          (ownershipSchema
            ? (
                {
                  Upstream: "upstream",
                  "Sync Mode": "mode",
                  "Upstream Key": "key",
                  "Upstream Revision": "revision",
                  "Published Hash": "hash",
                  "Fork Baseline": "baseline",
                } as Record<string, string>
              )[name]
            : undefined) ?? key,
        ...value,
        ...(type ? { type } : {}),
        ...(value.select
          ? {
              select: {
                id: `option-${String(property(value.select).name)}`,
                color: "default",
                ...property(value.select),
              },
            }
          : {}),
        ...(Array.isArray(value.rich_text)
          ? {
              rich_text: value.rich_text.map((item) => ({
                ...property(item),
                plain_text: property(property(item).text).content,
              })),
            }
          : {}),
      }
    }
  }
  let attachment: { id: string; name: string; type: string; file: { url: string } } | undefined
  const uploads = new Map<string, Uint8Array>()
  let upload = 0
  let uploadSends = 0
  const input = new Map([
    [
      "SKILL.md",
      encoder.encode(
        "---\nname: sample-skill\ndescription: Use for recovery.\n---\n\n# Sample\n\nRead [guide](references/guide.md).\n",
      ),
    ],
    ["references/guide.md", encoder.encode("# Guide\n\nRead [policy](./policy.md).\n")],
    [
      "references/policy.md",
      encoder.encode("# Policy\n\nA consumer must keep original page identities.\n"),
    ],
  ])
  const json = new Map<string, unknown>()
  const objects = new Map<string, Uint8Array>()
  const properties = () => ({
    Name: { id: "title", type: "title", title: [{ plain_text: "Sample Skill" }] },
    Description: {
      id: "description",
      type: "rich_text",
      rich_text: [{ plain_text: "Use for recovery." }],
    },
    References: { id: "references", type: "rich_text", rich_text: references },
    Publication: { id: "publication", type: "rich_text", rich_text: [] },
    Kind: { id: "kind", type: "select", select: { name: "skill" } },
    ...(ownershipSchema
      ? {
          ...structuredClone(publicationSourceRows),
          Upstream: { id: "upstream", type: "relation", relation: [], has_more: false },
          "Sync Mode": { id: "mode", type: "select", select: null },
          "Upstream Key": { id: "key", type: "rich_text", rich_text: [] },
          "Upstream Revision": { id: "revision", type: "rich_text", rich_text: [] },
          "Published Hash": { id: "hash", type: "rich_text", rich_text: [] },
          "Fork Baseline": { id: "baseline", type: "rich_text", rich_text: [] },
        }
      : {}),
    ...savedProperties,
    ...(hasFiles
      ? { Files: { id: "files", type: "files", files: attachment ? [attachment] : [] } }
      : {}),
  })
  const row = () => ({
    id: root,
    ...pageRevision(root),
    parent: { type: "data_source_id", database_id: database, data_source_id: "ds" },
    properties: properties(),
  })
  const outputs = new Map<string, Uint8Array>()
  const stateRoot = mkdtempSync(join(tmpdir(), "reference-import-"))
  const store = Layer.succeed(Store, {
    upstream: upstreamRepositoryFixture(),
    registerBindingWithBase: () => Effect.die(new Error("Unexpected binding transaction")),
    integrity: integrityRepositoryFixture(),
    advanceBaseAndReceipt: () => Effect.die(new Error("Unexpected baseline transaction")),
    backup: () => Effect.die(new Error("Unexpected backup")),
    root: stateRoot,
    configRoot: "/memory",
    cacheRoot: "/memory",
    reserveCacheGeneration: (() => {
      let generation = 0
      return () => Effect.sync(() => ++generation)
    })(),
    listKeys: (prefix) =>
      Effect.sync(() => [...json.keys()].filter((key) => key.startsWith(`${prefix}/`))),
    retireKeys: (keys) =>
      Effect.sync(() => {
        for (const key of keys) json.delete(key)
        return keys.map((key) => ({ key, retention_path: "fixture_trash" }))
      }),
    readJson: (key, schema) =>
      Effect.succeed(json.has(key) ? decode(schema, json.get(key)) : undefined),
    writeJson: (key, value) =>
      Effect.sync(() => {
        json.set(key, value)
      }),
    readBytes: (key) =>
      objects.has(key)
        ? Effect.succeed(objects.get(key)!)
        : Effect.fail(fail("SNAPSHOT_MISSING", "Missing object")),
    writeBytes: (key, bytes) =>
      Effect.sync(() => {
        objects.set(key, bytes)
      }),
    output: (destination, bytes) =>
      Effect.sync(() => {
        outputs.set(destination, bytes)
        return { output: destination, reused: false }
      }),
  })
  const api = Layer.succeed(Notion, {
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.succeed("credential"),
    request: (path, payload, options) =>
      Effect.gen(function* () {
        if (payload === undefined && !options?.method) reads.set(path, (reads.get(path) ?? 0) + 1)
        if (failNextRead && payload === undefined && !options?.method) {
          failNextRead = false
          return yield* Effect.fail(fail("ACCESS_DENIED", "Final verification read interrupted"))
        }
        const block = blocks.get(path.split("/")[2]!)
        if (/^v1\/blocks\/[^/]+$/.test(path) && block) {
          if (options?.method === "PATCH") {
            mutations++
            businessPatches++
            const before = typedLinkRepair ? blockMarkdown(block) : undefined
            Object.assign(block, property(payload))
            const field = property(block[String(block.type)]),
              spans = field.rich_text
            if (Array.isArray(spans))
              field.rich_text = spans.map((span) => ({
                ...property(span),
                plain_text: property(property(span).text).content,
                annotations: { bold: false, code: false, ...property(property(span).annotations) },
              }))
            if (before !== undefined) {
              const owner = property(block.parent).page_id
              const after = blockMarkdown(block)
              const child = children.find((child) => child.id === owner)
              if (child) child.body = child.body.replace(before, after)
              else if (owner === root) main = main.replace(before, after)
            }
          }
          return structuredClone(block)
        }
        if (inventories.has(path)) return inventories.get(path)
        if (path === "v1/users/me") return { id: "fixture", object: "user" }
        if (path === `v1/databases/${database}`)
          return {
            id: database,
            database_type: null,
            title: [],
            data_sources: [{ id: "ds", name: "Skills" }],
          }
        if (path === "v1/data_sources/ds")
          return {
            properties: {
              ...properties(),
              ...(ownershipSchema ? structuredClone(publicationSourceSchema) : {}),
            },
          }
        if (path === "v1/data_sources/ds/query")
          return { results: exists ? [row()] : [], has_more: false, next_cursor: null }
        if (path === "v1/pages") {
          mutations++
          if (property(payload).parent && property(property(payload).parent).data_source_id) {
            exists = true
            persistProperties(property(payload).properties)
            return row()
          }
          const title = String(
            property(
              property(
                (property(property(payload).properties).title as { title: unknown[] }).title[0],
              ).text,
            ).content,
          )
          const child = {
            id: `22222222-2222-4222-8222-${String(children.length + 1).padStart(12, "0")}`,
            title,
            body: ((property(payload).children as unknown[]) ?? [])
              .map((block) => {
                const values = property(property(block).paragraph).rich_text
                return Array.isArray(values)
                  ? values
                      .map((item) => String(property(property(item).text).content ?? ""))
                      .join("")
                  : ""
              })
              .join("\n"),
          }
          children.push(child)
          if (failure === "child_create" && title === "mocking.md" && !interrupted) {
            interrupted = true
            return yield* Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "Applied child response lost"))
          }
          return {
            id: child.id,
            ...pageRevision(child.id),
            parent: { type: "page_id", page_id: root },
            properties: {
              title: {
                type: "title",
                title: [{ type: "text", text: { content: title }, plain_text: title }],
              },
            },
          }
        }
        if (path === `v1/pages/${root}`) {
          if (options?.method === "PATCH") {
            mutations++
            if (!property(property(payload).properties).Publication) businessPatches++
            propertyWrites.push(property(property(payload).properties))
            if (
              ownershipUnknownArmed &&
              Object.hasOwn(property(property(payload).properties), "Upstream")
            ) {
              ownershipUnknownArmed = false
              return yield* Effect.fail(
                fail("WRITE_OUTCOME_UNKNOWN", "Ownership response lost before application"),
              )
            }
            if (property(property(payload).properties).references) {
              const proposedReferences = property(
                property(property(payload).properties).references,
              ).rich_text
              if (
                failure === "reference_limit" &&
                Array.isArray(proposedReferences) &&
                proposedReferences.length > 100
              )
                return yield* Effect.fail(
                  fail("NOTION_REQUEST_FAILED", "The Notion API request failed.", {
                    path,
                    notion_code: "validation_error",
                    exit_code: 5,
                    http_status: 400,
                    phase: "definitive_rejection",
                  }),
                )
              if (
                (failure === "registration" ||
                  (failure === "registration_unknown" && registrationUnknownArmed)) &&
                !interrupted
              ) {
                interrupted = true
                return yield* Effect.fail(
                  fail(
                    failure === "registration_unknown" ? "WRITE_OUTCOME_UNKNOWN" : "ACCESS_DENIED",
                    "Registration interrupted",
                  ),
                )
              }
              references = (
                property(property(property(payload).properties).references).rich_text as unknown[]
              ).map((value) => {
                const item = property(value)
                return { ...item, plain_text: property(item.text).content }
              })
            }
            const uploaded = property(property(property(payload).properties).files).files
            if (Array.isArray(uploaded)) {
              const file = property(uploaded[0])
              const key = `/${crypto.randomUUID()}`
              bundles.set(key, uploads.get(String(property(file.file_upload).id))!)
              attachment = {
                id: String(property(file.file_upload).id),
                name: String(file.name),
                type: "file",
                file: { url: new URL(key, server.url).href },
              }
            }
            persistProperties(property(payload).properties)
            if (Array.isArray(uploaded) && failure === "attachment" && !interrupted) {
              interrupted = true
              return yield* Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "Attachment response lost"))
            }
          }
          const current = row()
          if (changedRootRevision && payload === undefined && !options?.method) {
            return { ...current, last_edited_time: "2026-10-19T00:00:00.000Z" }
          }
          return current
        }
        if (path.includes(`/blocks/${root}/children`)) {
          const results = [
            ...(typedLinkRepair || literalStorage
              ? [...blocks.values()].filter((block) => property(block.parent).page_id === root)
              : bodyBlocks(root, main)),
            ...children.map((child) => ({
              id: child.id,
              type: "child_page",
              has_children: false,
              parent: { type: "page_id", page_id: root },
              child_page: { title: child.title },
            })),
          ]
          const cursor = new URLSearchParams(path.split("?")[1] ?? "").get("start_cursor")
          const start = cursor === null ? 0 : Number(cursor)
          if (
            !Number.isInteger(start) ||
            start < 0 ||
            start > results.length ||
            (start > 0 && start % 100 !== 0)
          )
            return { results: [], has_more: true, next_cursor: null }
          const page = results.slice(start, start + 100)
          const has_more = start + 100 < results.length
          return { results: page, has_more, next_cursor: has_more ? String(start + 100) : null }
        }
        if (path.includes("/blocks/") && path.includes("/children")) {
          const child = children.find((child) => child.id === path.split("/")[2])
          if (child)
            return {
              results: [
                ...(typedLinkRepair ? [] : bodyBlocks(child.id, child.body)),
                ...[...blocks.values()].filter(
                  (block) => property(block.parent).page_id === child.id,
                ),
              ],
              has_more: false,
              next_cursor: null,
            }
        }
        if (
          path.includes("/blocks/") &&
          path.includes("/children") &&
          blocks.has(path.split("/")[2]!)
        )
          return {
            results: [...blocks.values()].filter(
              (block) => property(block.parent).block_id === path.split("/")[2],
            ),
            has_more: false,
            next_cursor: null,
          }
        if (path.includes("/blocks/") && path.includes("/children"))
          return { results: [], has_more: false, next_cursor: null }
        if (path.includes(`/pages/${root}/properties/references`))
          return {
            results: references.map((rich_text) => ({
              object: "property_item",
              id: "references",
              type: "rich_text",
              rich_text,
            })),
            has_more: false,
            next_cursor: null,
          }
        if (path === "v1/file_uploads") return { id: `upload-${++upload}` }
        if (/^v1\/file_uploads\/[^/]+$/.test(path)) {
          const id = path.split("/")[2]!
          return { id, status: uploads.has(id) ? "uploaded" : "pending" }
        }
        if (path.startsWith("v1/file_uploads/") && path.endsWith("/send")) {
          uploadSends++
          uploads.set(
            path.split("/")[2]!,
            objects.get(options!.file!.slice(`${stateRoot}/`.length))!,
          )
          return { status: "uploaded" }
        }
        const id = path.split("/")[2]
        const child = children.find((child) => child.id === id)
        if (path.endsWith("/markdown")) {
          if (options?.method === "PATCH") {
            mutations++
            const removed: string[] = []
            for (const [blockId, block] of blocks) {
              let parent = property(block.parent)
              const seen = new Set<string>()
              while (
                parent.type === "block_id" &&
                typeof parent.block_id === "string" &&
                !seen.has(parent.block_id)
              ) {
                seen.add(parent.block_id)
                parent = property(blocks.get(parent.block_id)?.parent)
              }
              if (parent.page_id === id) removed.push(blockId)
            }
            for (const blockId of removed) blocks.delete(blockId)
            businessPatches++
            const submitted = String(property(property(payload).replace_content).new_str)
            const body = typedLinkRepair
              ? submitted.replace(
                  /https:\/\/www\.notion\.so\/([a-f0-9]{32})#ntn-skills-path=[^\s)>]+/g,
                  "https://app.notion.com/p/$1",
                )
              : submitted
            if (child)
              child.body = changed === "reference" ? "# Silently replaced reference\n" : body
            else {
              main =
                changed === "main" ? "# Silently replaced instructions\n" : withoutChildPages(body)
              literalStorage = false
            }
            if (typedLinkRepair)
              for (const block of bodyBlocks(String(id), withoutChildPages(body)))
                blocks.set(block.id, block)
            if (
              ((failure === "body" && child?.title === "policy.md") ||
                (failure === "root_body" && id === root)) &&
              !interrupted
            ) {
              interrupted = true
              return yield* Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "Response lost after write"))
            }
          }
          if (literalStorage && id === root) {
            const literal = [...blocks.values()].filter(
              (block) => property(block.parent).page_id === root && block.type !== "child_page",
            )
            const text = (value: unknown) =>
              Array.isArray(value)
                ? value.map((span) => String(property(property(span).text).content ?? "")).join("")
                : ""
            main = literal
              .map((block) => {
                const nested = [...blocks.values()]
                  .filter(
                    (child) =>
                      property(child.parent).block_id === block.id && child.type === "code",
                  )
                  .map((child) => text(property(child.code).rich_text))
                  .join("")
                return (
                  (block.type === "paragraph"
                    ? text(property(block.paragraph).rich_text)
                    : block.type === "toggle"
                      ? text(property(block.toggle).rich_text)
                      : "") + (nested ? `\n${nested}` : "")
                )
              })
              .join("\n")
          }
          const source = child ? child.body : main
          const body = quoteBoundary
            ? source
                .replace(/(^>[^\n]*(?:\n>[^\n]*)*)\n\n(?=注意：)/gm, "$1\n")
                .replace(
                  "注意：保留原始边界。",
                  noticeChanged ? "注意：外部修改。" : "注意：保留原始边界。",
                )
            : source
          const rendered = normalized
            ? body
                .replace(/([^\n])\n(?=[^\n<])/g, "$1<br>")
                .replaceAll("https://www.notion.so/", "https://app.notion.com/p/")
            : body
          const tags =
            id === root
              ? children
                  .map(
                    (child) =>
                      `<page url="https://app.notion.com/p/${child.id.replaceAll("-", "")}">${child.title}</page>`,
                  )
                  .join("\n")
              : ""
          return {
            ...(options?.method === "PATCH" ? { id } : {}),
            object: "page_markdown",
            markdown: `${rendered}${tags ? "\n" + tags : ""}`,
            truncated: false,
            unknown_block_ids: [],
          }
        }
        if (child)
          return {
            id: child.id,
            ...pageRevision(child.id),
            parent: { type: "page_id", page_id: root },
            properties: {
              title: {
                type: "title",
                title: [{ type: "text", text: { content: child.title }, plain_text: child.title }],
              },
            },
          }
        return yield* Effect.fail(fail("UNEXPECTED", "Unexpected request", { path }))
      }),
  })
  const fs = FileSystem.makeNoop({
    stat: (path) =>
      Effect.succeed({
        type: path === "/input" ? "Directory" : "File",
        mtime: Option.none(),
        atime: Option.none(),
        birthtime: Option.none(),
        dev: 1n,
        ino: Option.none(),
        mode: 0o600,
        nlink: Option.none(),
        uid: Option.none(),
        gid: Option.none(),
        rdev: Option.none(),
        size: ByteSize.bytes(10),
        blksize: Option.none(),
        blocks: Option.none(),
      }),
    readDirectory: () => Effect.succeed([...input.keys()]),
    readFile: (path) => Effect.succeed(input.get(path.slice("/input/".length))!),
  })
  const layer = Layer.mergeAll(
    NodeServices.layer,
    NodeHttpClient.layerFetch,
    store,
    api,
    Layer.succeed(FileSystem.FileSystem, fs),
  )
  return {
    children,
    blocks,
    inventories,
    input,
    outputs,
    seedLiteral: () => {
      exists = true
      literalStorage = true
      main = markdownFilesHeader("SKILL.md")
      const parent = { type: "page_id", page_id: root }
      blocks.set("33333333-3333-4333-8333-000000000000", {
        id: "33333333-3333-4333-8333-000000000000",
        type: "paragraph",
        parent,
        has_children: false,
        paragraph: { rich_text: markdownFileSpans(main) },
      })
      for (const [index, [path, bytes]] of [...input].entries()) {
        const id = `33333333-3333-4333-8333-${String(index + 1).padStart(12, "0")}`
        const code = `55555555-5555-4555-8555-${String(index + 1).padStart(12, "0")}`
        blocks.set(id, {
          id,
          type: "toggle",
          parent,
          has_children: true,
          toggle: { rich_text: markdownFileSpans(path) },
        })
        blocks.set(code, {
          ...markdownFileCode(new TextDecoder().decode(bytes)),
          id: code,
          parent: { type: "block_id", block_id: id },
          has_children: false,
        })
      }
      persistProperties({
        title: {
          title: [{ type: "text", text: { content: "sample-skill" }, plain_text: "sample-skill" }],
        },
        defaultcontext: {
          rich_text: [{ type: "text", text: { content: "Preserve this context" } }],
        },
      })
    },
    properties,
    // Model a pre-publication-protocol page; never used by enrolled-page conflict cases.
    legacyPublication: () => {
      delete savedProperties.Publication
    },
    setPublication: (marker: unknown) =>
      persistProperties({
        Publication: { rich_text: [{ type: "text", text: { content: JSON.stringify(marker) } }] },
      }),
    mutations: () => mutations,
    businessPatches: () => businessPatches,
    reads,
    collapseQuote: () => {
      singleQuote = true
    },
    changeNotice: () => {
      noticeChanged = true
    },
    interruptRegistration: () => {
      ownershipSchema = true
      registrationUnknownArmed = true
    },
    interruptOwnership: () => {
      ownershipSchema = true
      ownershipUnknownArmed = true
    },
    uploadCounts: () => ({ allocations: upload, sends: uploadSends }),
    pageRevision: (id: string, value: string) => {
      pageRevisions.set(id, value)
    },
    rotateAttachmentUrl: () => {
      if (!attachment) throw new Error("Expected an acknowledged source archive")
      attachment.file.url =
        new URL(attachment.file.url).origin +
        new URL(attachment.file.url).pathname +
        "?signature=renewed"
    },
    replaceAttachmentIdentity: () => {
      if (!attachment) throw new Error("Expected an acknowledged source archive")
      const old = new URL(attachment.file.url),
        next = "/" + crypto.randomUUID()
      bundles.set(next, bundles.get(old.pathname)!)
      attachment.id = crypto.randomUUID()
      attachment.file.url = new URL(next, server.url).href
    },
    changeAttachedBytes: () => {
      if (!attachment) throw new Error("Expected an acknowledged source attachment")
      const key = new URL(attachment.file.url).pathname
      const original = bundles.get(key)
      if (!original?.length) throw new Error("Expected retained source archive bytes")
      const changed = original.slice()
      changed[0] = changed[0]! ^ 1
      bundles.set(key, changed)
    },
    changeFrozenBytes: (operationId: string) => {
      const receipt = decode(PublicationReceiptSchema, json.get(`publications/${operationId}.json`))
      const file = receipt.portable.files.find((file) => file.path === receipt.portable.main)!
      const original = objects.get(`objects/${file.sha256}`)
      if (!original?.length) throw new Error("Expected the frozen original main source")
      const changed = original.slice()
      changed[0] = changed[0]! ^ 1
      objects.set(`objects/${file.sha256}`, changed)
    },
    failNextRead: () => {
      failNextRead = true
    },
    changeRootRevision: (changed: boolean) => {
      changedRootRevision = changed
    },
    changeDescription: () => {
      savedProperties.Description = {
        id: "description",
        type: "rich_text",
        rich_text: [
          { type: "text", text: { content: "External edit" }, plain_text: "External edit" },
        ],
      }
    },
    changeKind: () => {
      savedProperties.Kind = {
        id: "kind",
        type: "select",
        select: { id: "option-skill", color: "default", name: "prompt" },
      }
    },
    changeResource: () => {
      savedProperties.Files = {
        id: "files",
        type: "files",
        files: [
          {
            id: "external-resource",
            name: "changed.bin",
            type: "external",
            external: { url: "https://example.com/changed.bin" },
          },
        ],
      }
    },
    receipt: (operationId: string) =>
      decode(PublicationReceiptSchema, json.get(`publications/${operationId}.json`)),
    retainSyntheticChildren: (operationId: string) => {
      const receipt = decode(PublicationReceiptSchema, json.get(`publications/${operationId}.json`))
      const base = `v1/blocks/${root}/children?page_size=100`
      const results = Object.keys(receipt.guards)
        .filter((path) => path === base || path.startsWith(`${base}&start_cursor=`))
        .flatMap((path) => property(receipt.guards[path]).results as unknown[])
      for (const path of Object.keys(receipt.guards))
        if (path.startsWith(`${base}&start_cursor=`)) delete receipt.guards[path]
      receipt.guards[base] = { results, has_more: false, next_cursor: null }
      receipt.conflict = true
      receipt.state = "failed"
      json.set(`publications/${operationId}.json`, receipt)
    },
    propertyWrites,
    run: <A, E>(effect: Effect.Effect<A, E, any>) =>
      Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E>),
  }
}
