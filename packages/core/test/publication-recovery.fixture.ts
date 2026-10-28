import {
  integrityRepositoryFixture,
  upstreamRepositoryFixture,
  publicationSourceRows,
  publicationSourceSchema,
} from "./fixtures.ts"
import { mkdtemp } from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, expect } from "bun:test"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { ByteSize, Effect, FileSystem, Layer, Option } from "effect"
import { createSkill, resumePublication } from "../src/mutation.ts"
import { decode, fail, property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { Store } from "../src/store.ts"
import { metadata } from "../src/publication-observation.ts"
import { creationMarker, creationMarkerProof } from "../src/publication-create-identity.ts"
import { PublicationReceiptSchema, type Receipt } from "../src/publication-model.ts"
import { observePublicationListRepair } from "../src/publication-list-repair.ts"
import { UpstreamState } from "../src/upstream-state.ts"
import { fromNotionMarkdown } from "../src/markdown.ts"
import { BUNDLE, bodyIdentity, portableZip } from "../src/portable.ts"
import { Lexer } from "marked"
import { markdownRichText } from "../src/markdown-blocks.ts"

export {
  database,
  root,
  encoder,
  fixture,
  originalListFence,
  historicalAttachedZeroSource,
  historicalListRepair,
}

const database = "44444444-4444-4444-8444-444444444444"
const root = "11111111-1111-4111-8111-111111111111"
const encoder = new TextEncoder()
const sourceDownloads = new Map<string, Uint8Array>()
const sourceDownloadEffects = new Map<string, () => void>()
const sourceServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => {
    const path = new URL(request.url).pathname
    const bytes = sourceDownloads.get(path)
    sourceDownloadEffects.get(path)?.()
    return bytes
      ? new Response(new Blob([new Uint8Array(bytes).buffer]))
      : new Response(null, { status: 404 })
  },
})
afterAll(() => sourceServer.stop(true))

function fixture(
  failure: "registration" | "body" | "create" | "child_create" | "list_normal",
  stateRoot: string,
  managed = false,
  initialEvidence?: "stable" | "missing",
  sourceBundle = false,
  filenameAutolink = false,
) {
  let credential = "credential"
  let exists = false
  let interrupted = false
  let main = ""
  let notionZeroReadback = false
  let sourceFilesWithoutId = false
  let uploadAllocations = 0,
    uploadSends = 0
  let uploadExpiry: string | null = null
  let uploadStatus: "pending" | "expired" | "failed" | undefined
  const uploads = new Map<string, Uint8Array>()
  let mutations = 0
  let rootRevision = 0
  const childRevisions: Record<string, number> = {}
  let crashReferencesRead = false
  let nextReceiptWrite: (() => void) | undefined
  let propertyRequests = 0
  let queryMode: "normal" | "duplicate" | "partial" | "paged" = "normal"
  let childInventoryMode: "normal" | "paged" | "partial" = "normal"
  const pagePosts: unknown[] = []
  const children: Array<{ id: string; title: string; body: string }> = []
  const childBodyBlocks = (child: { id: string; body: string }) =>
    Lexer.lex(child.body)
      .filter((token) => token.type !== "space" && token.type !== "def")
      .map((token, index) => {
        if (token.type !== "paragraph" && token.type !== "heading")
          throw new Error(`Unsupported recovery child fixture block: ${token.type}`)
        if (!token.tokens) throw new Error("Recovery child text block requires inline tokens")
        const type = token.type === "heading" ? `heading_${Math.min(token.depth, 3)}` : "paragraph"
        const richText = markdownRichText(token.tokens).map((span) => ({
          ...span,
          plain_text: String(property(span.text).content),
          annotations: { bold: false, code: false, ...property(span.annotations) },
        }))
        return {
          object: "block",
          id: createHash("sha256")
            .update(`${child.id}:${index}`)
            .digest("hex")
            .slice(0, 32)
            .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5"),
          type,
          parent: { type: "page_id", page_id: child.id },
          has_children: false,
          archived: false,
          in_trash: false,
          last_edited_time: `child-${childRevisions[child.id]}`,
          [type]: { rich_text: richText },
        }
      })
  let references: unknown[] = []
  const savedProperties: Record<string, unknown> = {}
  const listMode = failure === "list_normal"
  let listPatches = 0
  let zeroRequests = 0
  let zeroResponse: "ack" | "unknown_before" | "unknown_after" | "ack_no_effect" | "failed_before" =
    "ack"
  let listStart: number | undefined
  let listRevision = 0
  let listRootsChange: ((roots: unknown[]) => unknown[]) | undefined
  let evidenceIdentity = initialEvidence
  const listIds = [
    "33333333-3333-4333-8333-000000000001",
    "33333333-3333-4333-8333-000000000002",
    "33333333-3333-4333-8333-000000000003",
    "33333333-3333-4333-8333-000000000004",
    "33333333-3333-4333-8333-000000000005",
  ]
  const listRoots = () => {
    if (!main) return []
    const rich = (content: string, code = false) => ({
      type: "text",
      plain_text: content,
      text: { content, link: null },
      annotations: { bold: false, code },
    })
    const literalZero = main.includes("0\\. First exact item.")
    const roots: unknown[] = [
      { type: "heading_1", heading_1: { rich_text: [rich("Sample")] } },
      {
        type: "numbered_list_item",
        numbered_list_item: {
          rich_text: [rich("First exact item.")],
          list_format: "numbers",
          ...(listStart === undefined ? {} : { list_start_index: listStart }),
        },
      },
      {
        type: "numbered_list_item",
        numbered_list_item: {
          rich_text: [rich("Keep "), rich("code", true), rich(" exact.")],
          list_format: "numbers",
        },
      },
      // The historical archive drops blank lines; a heading keeps this paragraph
      // outside the preceding list in both the archive and its before-image.
      ...(filenameAutolink
        ? [
            { type: "heading_2", heading_2: { rich_text: [rich("Edit scope")] } },
            {
              type: "paragraph",
              paragraph: {
                rich_text: [
                  rich("Edit "),
                  {
                    ...rich("SKILL.md"),
                    text: { content: "SKILL.md", link: { url: "http://skill.md/" } },
                  },
                  rich(" only."),
                ],
              },
            },
          ]
        : []),
    ].map((body, index) => {
      let physical: unknown = body
      if (literalZero && body.type === "numbered_list_item") {
        const {
          list_start_index: _start,
          list_format: _format,
          ...content
        } = property(property(body).numbered_list_item)
        if (!Array.isArray(content.rich_text)) throw new Error("Missing fixture list rich text")
        physical = {
          type: "paragraph",
          paragraph: {
            ...content,
            ...(notionZeroReadback ? { icon: null } : {}),
            rich_text: [rich(index - 1 + ". "), ...content.rich_text],
          },
        }
      }
      return {
        object: "block",
        id: literalZero ? String(listIds[index]).replace("33333333", "66666666") : listIds[index],
        ...property(physical),
        parent: { type: "page_id", page_id: root },
        has_children: false,
        archived: false,
        in_trash: false,
        last_edited_time: index === 1 ? `list-${listRevision}` : "block-0",
      }
    })
    return listRootsChange ? listRootsChange(roots) : roots
  }
  const applyListEffect = () => {
    listStart = 0
    listRevision++
    rootRevision++
    main = main
      .replace(/^1\. First exact item\./m, "0. First exact item.")
      .replace(/^2\. Keep/m, "1. Keep")
  }
  const persistProperties = (raw: unknown) => {
    for (const [key, rawValue] of Object.entries(property(raw))) {
      if (key === "references" || key === "References") continue
      const value = property(rawValue)
      const name =
        (
          {
            title: "Name",
            description: "Description",
            references: "References",
            publication: "Publication",
            kind: "Kind",
            files: "Files",
            upstream: "Upstream",
            mode: "Sync Mode",
            key: "Upstream Key",
            revision: "Upstream Revision",
            hash: "Published Hash",
            baseline: "Fork Baseline",
          } as Record<string, string>
        )[key] ?? key
      const uploaded = Array.isArray(value.files)
        ? value.files.map((rawFile) => {
            const file = property(rawFile)
            if (file.type !== "file_upload") return file
            const id = String(property(file.file_upload).id),
              bytes = uploads.get(id)
            if (!bytes)
              throw new Error("Source attachment must have a real uploaded fixture artifact")
            const key = "/" + crypto.randomUUID()
            sourceDownloads.set(key, bytes)
            return {
              ...(sourceFilesWithoutId ? {} : { id }),
              name: file.name,
              type: "file",
              file: { url: new URL(key, sourceServer.url).href },
            }
          })
        : undefined
      const type = Array.isArray(value.rich_text)
        ? "rich_text"
        : Array.isArray(value.title)
          ? "title"
          : "select" in value
            ? "select"
            : Array.isArray(value.files)
              ? "files"
              : Array.isArray(value.relation)
                ? "relation"
                : undefined
      savedProperties[name] = {
        id: key,
        ...value,
        ...(uploaded ? { files: uploaded } : {}),
        ...(type ? { type } : {}),
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
  if (listMode) {
    input.clear()
    input.set(
      "SKILL.md",
      encoder.encode(
        "---\nname: sample-skill\ndescription: Use for recovery.\n---\n\n# Sample\n\n0. First exact item.\n1. Keep `code` exact.\n" +
          // Keep a real filename link through the current wire, which escapes
          // bare filenames to prevent the historical automatic-link side effect.
          // The recovery cases exercise its localized projection and exact archive.
          (filenameAutolink ? "\n## Edit scope\n\nEdit [SKILL.md](http://SKILL.md) only.\n" : ""),
      ),
    )
  }
  const json = new Map<string, unknown>()
  const objects = new Map<string, Uint8Array>()
  const properties = () => ({
    Name: { id: "title", type: "title", title: [{ plain_text: "Sample Skill" }] },
    Description: {
      id: "description",
      type: "rich_text",
      rich_text: [
        {
          type: "text",
          plain_text: "Use for recovery.",
          text: { content: "Use for recovery.", link: null },
        },
      ],
    },
    References: { id: "references", type: "rich_text", rich_text: references },
    Publication: { id: "publication", type: "rich_text", rich_text: [] },
    Kind: { id: "kind", type: "select", select: { name: "skill" } },
    ...(sourceBundle ? { Files: { id: "files", type: "files", files: [] } } : {}),
    ...(evidenceIdentity
      ? {
          Evidence: {
            id: "evidence",
            type: "files",
            files: [
              {
                name: "evidence.txt",
                type: "external",
                ...(evidenceIdentity === "stable"
                  ? { id: "77777777-7777-4777-8777-777777777777" }
                  : {}),
                external: { url: "data:text/plain,evidence%20fixture%20bytes" },
              },
            ],
          },
        }
      : {}),
    ...(managed
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
    Updated: { id: "updated", type: "last_edited_time", last_edited_time: `root-${rootRevision}` },
  })
  const row = () => ({
    id: root,
    last_edited_time: `root-${rootRevision}`,
    parent: { type: "data_source_id", database_id: database, data_source_id: "ds" },
    properties: properties(),
  })
  const upstream = upstreamRepositoryFixture()
  const store = Layer.succeed(Store, {
    upstream,
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
        if (key.startsWith("publications/") && nextReceiptWrite) {
          const hook = nextReceiptWrite
          nextReceiptWrite = undefined
          hook()
        }
      }),
    readBytes: (key) =>
      objects.has(key)
        ? Effect.succeed(objects.get(key)!)
        : Effect.fail(fail("SNAPSHOT_MISSING", "Missing object")),
    writeBytes: (key, bytes) =>
      Effect.sync(() => {
        objects.set(key, bytes)
      }),
    output: () => Effect.fail(fail("UNUSED", "unused")),
  })
  const api = Layer.succeed(Notion, {
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.sync(() => credential),
    request: (path, payload, options) =>
      Effect.gen(function* () {
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
              ...(managed ? structuredClone(publicationSourceSchema) : {}),
            },
          }
        if (path === "v1/file_uploads") {
          mutations++
          return {
            id: "88888888-8888-4888-8888-" + String(++uploadAllocations).padStart(12, "0"),
            status: "pending",
          }
        }
        if (/^v1\/file_uploads\/[^/]+\/send$/.test(path)) {
          const key = options?.file?.slice(stateRoot.length + 1)
          const bytes = key && objects.get(key)
          if (!bytes)
            return yield* Effect.fail(
              fail("UNEXPECTED", "The real source bundle upload bytes are missing"),
            )
          mutations++
          uploadSends++
          const id = path.split("/")[2]!
          uploads.set(id, new Uint8Array(bytes))
          return { id, status: "uploaded" }
        }
        if (/^v1\/file_uploads\/[^/]+$/.test(path)) {
          const id = path.split("/")[2]!
          return {
            id,
            status: uploadStatus ?? (uploads.has(id) ? "uploaded" : "pending"),
            expiry_time: uploadExpiry,
          }
        }
        if (path === "v1/data_sources/ds/query") {
          if (queryMode === "partial")
            return { results: exists ? [row()] : [], has_more: true, next_cursor: null }
          if (queryMode === "paged" && !property(payload).start_cursor)
            return { results: [], has_more: true, next_cursor: "root-next" }
          return {
            results: exists
              ? [
                  row(),
                  ...(queryMode === "duplicate"
                    ? [{ ...row(), id: "99999999-9999-4999-8999-999999999999" }]
                    : []),
                ]
              : [],
            has_more: false,
            next_cursor: null,
          }
        }
        if (path === "v1/pages") {
          pagePosts.push(structuredClone(payload))
          mutations++
          rootRevision++
          if (property(payload).parent && property(property(payload).parent).data_source_id) {
            exists = true
            persistProperties(property(payload).properties)
            if (failure === "create" && !interrupted) {
              interrupted = true
              return yield* Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "Create response lost"))
            }
            return row()
          }
          const titleValues = property(property(property(payload).properties).title).title
          if (!Array.isArray(titleValues))
            return yield* Effect.fail(fail("INVALID_RESPONSE", "Missing title fixture input"))
          const title = String(property(property(titleValues[0]).text).content)
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
          childRevisions[child.id] = 0
          if (failure === "child_create" && !interrupted) {
            interrupted = true
            return yield* Effect.fail(
              fail("WRITE_OUTCOME_UNKNOWN", "Child response lost after initial POST"),
            )
          }
          return {
            id: child.id,
            last_edited_time: `child-${childRevisions[child.id]}`,
            parent: { type: "page_id", page_id: root },
            properties: { title: { type: "title", title: [{ plain_text: title }] } },
          }
        }
        if (path === `v1/pages/${root}`) {
          if (options?.method === "PATCH") {
            mutations++
            if (property(property(payload).properties).references) {
              if (failure === "registration" && !interrupted) {
                interrupted = true
                return yield* Effect.fail(fail("ACCESS_DENIED", "Registration interrupted"))
              }
              const values = property(property(property(payload).properties).references).rich_text
              if (!Array.isArray(values))
                return yield* Effect.fail(
                  fail("INVALID_RESPONSE", "Missing References fixture input"),
                )
              references = values.map((value) => {
                const item = property(value)
                return { ...item, plain_text: property(item.text).content }
              })
              rootRevision++
            }
            persistProperties(property(payload).properties)
            rootRevision++
          }
          return row()
        }
        if (path.includes("/blocks/") && path.includes("/children")) {
          const id = path.split("/")[2]
          if (listMode && id === root) {
            return { results: listRoots(), has_more: false, next_cursor: null }
          }
          return {
            results:
              id === root
                ? (childInventoryMode === "paged" && !path.includes("start_cursor=")
                    ? []
                    : children
                  ).map((child) => ({
                    id: child.id,
                    type: "child_page",
                    parent: { type: "page_id", page_id: root },
                    has_children: true,
                    child_page: { title: child.title },
                  }))
                : children.filter((child) => child.id === id).flatMap(childBodyBlocks),
            has_more:
              id === root &&
              (childInventoryMode === "partial" ||
                (childInventoryMode === "paged" && !path.includes("start_cursor="))),
            next_cursor:
              id === root && childInventoryMode === "paged" && !path.includes("start_cursor=")
                ? "children-next"
                : null,
          }
        }
        if (path.includes(`/pages/${root}/properties/references`)) {
          if (crashReferencesRead) {
            crashReferencesRead = false
            return yield* Effect.die("Process exited during version validation")
          }
          return {
            request_id: `property-request-${++propertyRequests}`,
            results: references.map((rich_text) => ({ rich_text })),
            has_more: false,
            next_cursor: null,
          }
        }
        const id = path.split("/")[2]
        if (listMode && /^v1\/blocks\/[^/]+$/.test(path)) {
          const block = listRoots().find((block) => property(block).id === id)
          if (!block) return yield* Effect.fail(fail("UNEXPECTED", "Unknown list block fixture."))
          if (options?.method === "PATCH") {
            if (
              id !== listIds[1] ||
              JSON.stringify(payload) !==
                JSON.stringify({ numbered_list_item: { list_start_index: 0 } })
            )
              return yield* Effect.fail(fail("UNEXPECTED", "Unexpected list correction request."))
            mutations++
            listPatches++
            // Model the public schema, not a hypothetical writable list start.
            // A production correction must be refused before this transport.
            return yield* Effect.fail(
              fail("NOTION_REQUEST_FAILED", "Unsupported numbered-list field.", {
                http_status: 400,
                notion_code: "validation_error",
                phase: "definitive_rejection",
              }),
            )
          }
          return listRoots().find((block) => property(block).id === id)!
        }
        const child = children.find((child) => child.id === id)
        if (path.endsWith("/markdown")) {
          if (options?.method === "PATCH") {
            mutations++
            const submitted = String(property(property(payload).replace_content).new_str)
            const literalZero = submitted.includes("0\\. First exact item.")
            const zeroOutcome = literalZero ? zeroResponse : "ack"
            if (literalZero) {
              zeroRequests++
              zeroResponse = "ack"
              if (zeroOutcome === "unknown_before" || zeroOutcome === "failed_before")
                return yield* Effect.fail(
                  fail(
                    zeroOutcome === "unknown_before"
                      ? "WRITE_OUTCOME_UNKNOWN"
                      : "NOTION_REQUEST_FAILED",
                    "No effect before send outcome",
                  ),
                )
              if (zeroOutcome === "ack_no_effect")
                return {
                  object: "page_markdown",
                  markdown: main,
                  truncated: false,
                  unknown_block_ids: [],
                }
            }
            if (child) childRevisions[child.id] = (childRevisions[child.id] ?? 0) + 1
            else rootRevision++
            const body = String(property(property(payload).replace_content).new_str)
            if (child) child.body = body
            else {
              main = listMode
                ? body
                    .replace(/^0\. First exact item\./m, "1. First exact item.")
                    .replace(/^1\. Keep/m, "2. Keep")
                : body
              if (listMode) {
                listStart = undefined
                listRevision = 0
              }
            }
            if (literalZero && zeroOutcome === "unknown_after")
              return yield* Effect.fail(
                fail("WRITE_OUTCOME_UNKNOWN", "Response lost after literal-zero write"),
              )
            if (failure === "body" && child?.title === "policy.md" && !interrupted) {
              interrupted = true
              return yield* Effect.fail(fail("WRITE_OUTCOME_UNKNOWN", "Response lost after write"))
            }
          }
          const tags =
            id === root
              ? children
                  .map(
                    (child) =>
                      `<page url="https://www.notion.so/${child.id.replaceAll("-", "")}">${child.title}</page>`,
                  )
                  .join("\n")
              : ""
          return {
            object: "page_markdown",
            markdown: child
              ? child.body
              : `${
                  notionZeroReadback && main.includes("0\\. First exact item.")
                    ? main
                        .replace(/^(\d+)\\\. /gm, "$1. ")
                        .replace(/\n\n/g, "\n")
                        .trimEnd()
                    : main
                }${tags ? "\n" + tags : ""}`.replace(
                  "Edit SKILL.md only.",
                  filenameAutolink
                    ? "Edit [SKILL.md](http://SKILL.md) only."
                    : "Edit SKILL.md only.",
                ),
            truncated: false,
            unknown_block_ids: [],
          }
        }
        if (child)
          return {
            id: child.id,
            last_edited_time: `child-${childRevisions[child.id]}`,
            parent: { type: "page_id", page_id: root },
            properties: { title: { type: "title", title: [{ plain_text: child.title }] } },
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
    Layer.succeed(UpstreamState, upstream),
    store,
    api,
    Layer.succeed(FileSystem.FileSystem, fs),
  )
  return {
    children,
    input,
    json,
    objects,
    pagePosts,
    rootPage: row,
    editProperties: persistProperties,
    setQueryMode: (value: typeof queryMode) => {
      queryMode = value
    },
    setChildInventoryMode: (value: typeof childInventoryMode) => {
      childInventoryMode = value
    },
    duplicateChild: (otherOperation = false) => {
      const child = children[0]!
      const proof = creationMarkerProof(child.body)!
      children.push({
        ...child,
        id: "99999999-9999-4999-8999-999999999999",
        body: otherOperation ? creationMarker({ ...proof, operation_id: "p_other" }) : child.body,
      })
    },
    clearPublication: () => {
      delete savedProperties.Publication
    },
    setCredential: (value: string) => {
      credential = value
    },
    crashAfterRootRead: () => {
      crashReferencesRead = true
    },
    onNextReceiptWrite: (hook: () => void) => {
      nextReceiptWrite = hook
    },
    editRoot: (value: string) => {
      main = value
    },
    omitFirstReference: () => {
      references = references.slice(1)
    },
    mutations: () => mutations,
    listPatches: () => listPatches,
    zeroRequests: () => zeroRequests,
    setNotionZeroReadback: () => {
      notionZeroReadback = true
    },
    setSourceFilesWithoutId: () => {
      sourceFilesWithoutId = true
    },
    changeAttachedBytes: (bytes: Uint8Array) => {
      const files = property(property(row().properties).Files).files
      if (!Array.isArray(files)) throw new Error("Missing fixture source Files")
      const url = String(property(property(files[0]).file).url)
      sourceDownloads.set(new URL(url).pathname, bytes)
    },
    changeOwnerAfterDownload: () => {
      const files = property(property(row().properties).Files).files
      if (!Array.isArray(files)) throw new Error("Missing fixture source Files")
      const url = String(property(property(files[0]).file).url)
      sourceDownloadEffects.set(new URL(url).pathname, () => {
        rootRevision++
      })
    },
    uploadAllocations: () => uploadAllocations,
    uploadSends: () => uploadSends,
    setUploadExpiry: (value: string | null) => {
      uploadExpiry = value
    },
    setUploadStatus: (value: typeof uploadStatus) => {
      uploadStatus = value
    },
    zeroResponse: (response: typeof zeroResponse) => {
      zeroResponse = response
    },
    editListRoots: (change: (roots: unknown[]) => unknown[]) => {
      listRootsChange = change
    },
    applyListEffect,
    setEvidenceIdentity: (value: "stable" | "missing") => {
      evidenceIdentity = value
      rootRevision++
    },
    run: <A, E>(effect: Effect.Effect<A, E, any>) =>
      Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E>),
  }
}

async function originalListFence(
  evidence?: "stable" | "missing",
  sourceBundle = false,
  filenameAutolink = false,
) {
  const f = fixture(
    "list_normal",
    await mkdtemp(join(tmpdir(), "publication-list-start-")),
    false,
    evidence,
    sourceBundle,
    filenameAutolink,
  )
  const stopped = await f.run(createSkill("/input", { database }).pipe(Effect.result))
  expect(stopped._tag).toBe("Failure")
  if (stopped._tag !== "Failure") throw new Error("Expected unsupported list-start restoration")
  const details = property(property(stopped.failure).details)
  expect(details.cause_code, JSON.stringify(stopped.failure)).toBe("UNSUPPORTED_MARKDOWN")
  const id = String(details.operation_id)
  const key = "publications/" + id + ".json"
  const receipt = () => decode(PublicationReceiptSchema, f.json.get(key))
  expect(
    receipt().intents.some(
      (intent) => intent.path.endsWith("/markdown") && intent.status === "completed",
    ),
  ).toBe(true)
  // Normal continuation encounters the strict acknowledged-body mismatch. It
  // establishes the original fence without inventing a receipt or an ACK.
  const fenced = await f.run(resumePublication(id).pipe(Effect.result))
  expect(fenced._tag).toBe("Failure")
  if (!receipt().conflict) {
    const error = property(fenced._tag === "Failure" ? fenced.failure : undefined)
    const failureDetails = property(error.details)
    throw new Error(
      `Original continuation did not establish its expected fence: ${JSON.stringify({
        code: error.code,
        message: error.message,
        cause_code: failureDetails.cause_code,
        cause_message: failureDetails.cause_message,
        stage: failureDetails.stage,
      })}`,
    )
  }
  expect(receipt().conflict).toBe(true)
  expect(receipt().owner).toBeUndefined()
  expect(f.listPatches()).toBe(0)
  const receiptHash = () =>
    createHash("sha256")
      .update(JSON.stringify(f.json.get(key)))
      .digest("hex")
  const observe = () =>
    f.run(Notion.pipe(Effect.flatMap((api) => observePublicationListRepair(receipt(), api))))
  return { f, id, receipt, receiptHash, observe }
}

async function historicalAttachedZeroSource(
  evidence?: "stable" | "missing",
  filenameAutolink = false,
) {
  const state = await originalListFence(evidence, true, filenameAutolink)
  const { f, id, receipt } = state
  const historical = structuredClone(receipt())
  const owner = "v1/pages/" + root
  const body = historical.guards[owner + "/markdown"]
  if (typeof body !== "string") throw new Error("Missing original complete body")
  const normalized = bodyIdentity(fromNotionMarkdown(body))
  // CommonMark permits repeated markers after the first ordered item. Preserve
  // the list's actual start while exercising the archive/readback spelling alias.
  const projection = normalized.replace(/^2\. Keep/m, "1. Keep")
  expect(projection).not.toBe(normalized)
  const bytes = portableZip(
    {
      ...historical.portable,
      files: historical.portable.files.map((file) => {
        const bytes = f.objects.get("objects/" + file.sha256)
        if (!bytes) throw new Error("Missing original frozen source")
        return { path: file.path, bytes }
      }),
      projection: {
        name: historical.portable.name,
        description: historical.portable.description,
        body: projection,
        references: {},
      },
    },
    true,
  )
  const index = historical.intents.length
  const artifact = {
    suboperation_id: id + ":upload:" + index,
    filename: BUNDLE,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byte_length: bytes.length,
  }
  const key = "uploads/" + artifact.sha256 + "/" + BUNDLE
  f.setSourceFilesWithoutId()
  // Older publications attached their source before diagnosing the native
  // zero-start mismatch. Model that historical journal using the fixture's real
  // allocation/send/Files responses, without copying its old publication code.
  const sent = await f.run(
    Effect.gen(function* () {
      const api = yield* Notion,
        store = yield* Store
      yield* store.writeBytes(key, bytes)
      const allocationBody = { filename: BUNDLE, mode: "single_part" }
      const allocation = property(
        yield* api.request("v1/file_uploads", allocationBody, { method: "POST" }),
      )
      if (typeof allocation.id !== "string") throw new Error("Missing fixture upload identity")
      const sendPath = "v1/file_uploads/" + allocation.id + "/send"
      const send = property(
        yield* api.request(sendPath, undefined, { method: "POST", file: join(store.root, key) }),
      )
      const attachmentBody = {
        properties: {
          files: {
            files: [{ name: BUNDLE, type: "file_upload", file_upload: { id: allocation.id } }],
          },
        },
      }
      const current = yield* api.request(owner, attachmentBody, { method: "PATCH" })
      return {
        allocationBody,
        allocation: { ...allocation, status: send.status },
        sendPath,
        send,
        attachmentBody,
        current,
      }
    }),
  )
  historical.intents.push(
    {
      path: "v1/file_uploads",
      method: "POST",
      body: sent.allocationBody,
      status: "completed",
      response: sent.allocation,
      artifact,
    },
    { path: sent.sendPath, method: "POST", status: "completed", response: sent.send },
    {
      path: owner,
      method: "PATCH",
      body: sent.attachmentBody,
      status: "completed",
      response: { id: root },
    },
  )
  historical.guards[owner] = metadata(sent.current)
  f.json.set("publications/" + id + ".json", decode(PublicationReceiptSchema, historical))
  return { ...state, artifact, artifactKey: key, allocationIndex: index }
}

async function historicalListRepair(
  status: "pending" | "unknown" | "completed" | "failed",
  evidence?: "stable" | "missing",
  noEffect = false,
  sourceBundle = false,
) {
  const state = await originalListFence(evidence, sourceBundle)
  const { f, id, receipt, observe } = state
  const proof = await observe()
  expect(proof.outcome).toBe("before")
  const original = structuredClone(receipt())
  const guards = structuredClone(original.guards)
  for (const block of proof.repair.before_roots)
    guards["v1/blocks/" + String(property(block).id)] = structuredClone(block)
  // These records exercise legacy journal interpretation only. Their original
  // source and fence above follow the real lifecycle; the transport below never
  // claims that the current public API can send this unsupported correction.
  const intent: Receipt["intents"][number] = {
    path: "v1/blocks/" + proof.repair.block_id,
    method: "PATCH",
    body: { numbered_list_item: { list_start_index: 0 } },
    status,
    guards: structuredClone(guards),
    list_start_repair: structuredClone(proof.repair),
    ...(status === "completed" ? { response: { id: proof.repair.block_id } } : {}),
    ...(noEffect
      ? {
          response: {
            prior_status: "unknown",
            recovery: "known_not_applied",
            replayed_by_intent: original.intents.length + 1,
          },
        }
      : {}),
  }
  const historical: Receipt = {
    ...original,
    state: status === "pending" || status === "unknown" ? "unknown" : "failed",
    guards,
    intents: [...original.intents, intent],
  }
  f.json.set("publications/" + id + ".json", historical)
  return state
}
