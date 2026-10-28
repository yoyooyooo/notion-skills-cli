import { integrityRepositoryFixture, upstreamRepositoryFixture } from "./fixtures.ts"
import { afterAll, test } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import { Effect, Layer } from "effect"
import { mkdtemp, mkdir, rename, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { Lexer } from "marked"
import { decode, fail, property, SkillsError } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { Store } from "../src/store.ts"
import { snapshotPortable } from "../src/export.ts"
import { openSkill } from "../src/snapshot.ts"
import { makeSyncLocal, SyncLocal, type LocalBoundary } from "../src/sync-local.ts"

import { bindSync } from "../src/sync.ts"

export const page = "11111111-1111-4111-8111-111111111111"
export const database = "44444444-4444-4444-8444-444444444444"
export const guide = "22222222-2222-4222-8222-222222222222"
export const encoder = new TextEncoder()
export const downloads = new Map<string, Uint8Array>()
export const downloadServer = createServer((request, response) => {
  const bytes = downloads.get(new URL(request.url!, "http://127.0.0.1").pathname)
  response.writeHead(bytes ? 200 : 404)
  response.end(bytes ?? "missing")
})
downloadServer.listen(0, "127.0.0.1")
await once(downloadServer, "listening")
export const downloadAddress = downloadServer.address()
if (!downloadAddress || typeof downloadAddress === "string")
  throw new Error("Missing download address")
export const downloadUrl = `http://127.0.0.1:${downloadAddress.port}`
afterAll(async () => {
  downloadServer.closeAllConnections()
  await new Promise<void>((resolve, reject) =>
    downloadServer.close((error) => (error ? reject(error) : resolve())),
  )
})

export interface Faults {
  lostResponse?: boolean
  bodyDenied?: boolean
  receiptStop?: boolean
  beforeRemoteWrite?: boolean
  baselineStop?: boolean
  denyMain?: boolean
  interruptBody?: boolean
  denyRemote?: boolean
  incompleteRemote?: boolean
  unknownRemote?: boolean
  localBoundary?: (boundary: LocalBoundary) => Promise<void>
  planSaved?: () => void
}
export async function fixture(
  exact = false,
  target = { page, guide },
  state?: {
    json: Map<string, unknown>
    objects: Map<string, Uint8Array>
  },
) {
  const { page, guide } = target
  const scratch = await mkdtemp(join(tmpdir(), "ntn-sync-test-"))
  const root = join(scratch, "skill")
  const retained = join(scratch, "retained")
  await mkdir(root)
  await mkdir(retained)
  const faults: Faults = {}
  const json = state?.json ?? new Map<string, unknown>()
  const objects = state?.objects ?? new Map<string, Uint8Array>()
  const copies = new Map<string, Uint8Array>()
  const generations = new Map<string, number>()
  const childRevisions = new Map<string, number>()
  const calls: Array<{ path: string; method: string }> = []
  const delegates = new Map<string, Notion["Service"]["request"]>()
  let body = "# Sample\n\nRead [guide](references/guide.md).\n"
  let guideBody = "# Guide\n\nOriginal guide.\n"
  let name = "Sample Skill"
  let description = "Use for sync tests."
  let kind = "skill"
  let mutations = 0
  let rootRevision = 0
  let retentionCount = 0
  let included = true
  let credential = "sync-credential"
  const uploads = new Map<string, Uint8Array>()
  let attachments: Array<{ name: string; type: "file"; file: { url: string } }> = []
  let uploadSequence = 0
  const extraReferences = new Map<string, { id: string; title: string; body: string }>()
  let extraIncluded: string[] = []
  let referenceText: unknown[] | undefined
  let publication: unknown[] = []
  const props = () => ({
    Publication: { id: "publication", type: "rich_text", rich_text: publication },
    Name: {
      id: "title",
      type: "title",
      title: [{ type: "text", text: { content: name, link: null }, plain_text: name, href: null }],
    },
    Description: {
      id: "description",
      type: "rich_text",
      rich_text: [
        {
          type: "text",
          text: { content: description, link: null },
          plain_text: description,
          href: null,
        },
      ],
    },
    Kind: { id: "kind", type: "select", select: { name: kind } },
    References: {
      id: "references",
      type: "rich_text",
      rich_text: referenceText ?? [
        ...(included
          ? [
              {
                type: "mention",
                mention: { type: "page", page: { id: guide } },
                plain_text: "references/guide.md",
              },
            ]
          : []),
        ...extraIncluded.map((id) => ({
          type: "mention",
          mention: { type: "page", page: { id } },
          plain_text: extraReferences.get(id)!.title,
        })),
      ],
    },
    ...(exact ? { Files: { id: "files", type: "files", files: attachments } } : {}),
  })
  const row = () => ({
    object: "page",
    id: page,
    parent: { type: "data_source_id", database_id: database, data_source_id: "ds" },
    archived: false,
    in_trash: false,
    last_edited_time: new Date(Date.UTC(2026, 9, 17) + rootRevision * 1000).toISOString(),
    properties: props(),
  })
  const childRow = (id: string, title: string) => ({
    object: "page",
    id,
    parent: { type: "page_id", page_id: page },
    archived: false,
    in_trash: false,
    last_edited_time: new Date(
      Date.UTC(2026, 9, 17, 0, 0, childRevisions.get(id) ?? 0),
    ).toISOString(),
    properties: {
      title: {
        id: "title",
        type: "title",
        title: [
          { type: "text", text: { content: title, link: null }, plain_text: title, href: null },
        ],
      },
    },
  })
  const plain = { bold: false, italic: false, strikethrough: false, code: false }
  const richText = (
    content: string,
    formatting = plain,
    url: string | null = null,
  ): Record<string, unknown>[] =>
    Lexer.lexInline(content).flatMap((token): Record<string, unknown>[] => {
      if (token.type === "link") return richText(token.text, formatting, token.href)
      if (token.type === "strong" || token.type === "em" || token.type === "del")
        return richText(
          token.text,
          {
            ...formatting,
            [token.type === "strong" ? "bold" : token.type === "em" ? "italic" : "strikethrough"]:
              true,
          },
          url,
        )
      if (!["text", "escape", "codespan", "br"].includes(token.type))
        throw new Error(`Unsupported sync fixture inline block: ${token.type}`)
      const value = token.type === "br" ? "\n" : "text" in token ? String(token.text) : token.raw
      return [
        {
          type: "text",
          text: { content: value, link: url ? { url } : null },
          plain_text: value,
          href: url,
          annotations: {
            ...formatting,
            code: formatting.code || token.type === "codespan",
            underline: false,
            color: "default",
          },
        },
      ]
    })
  // The same stored page body supplies both Markdown and its physical blocks.
  // In particular, a real POST-created identity paragraph cannot have an empty inventory.
  const bodyBlocks = (id: string, markdown: string) =>
    Lexer.lex(markdown.replace(/<page\b[^>]*>[\s\S]*?<\/page>/g, ""))
      .filter((token) => token.type !== "space" && token.type !== "def")
      .map((token, index) => {
        if (token.type !== "heading" && token.type !== "paragraph" && token.type !== "code")
          throw new Error(`Unsupported sync fixture body block: ${token.type}`)
        const hash = createHash("sha256").update(`${id}:${index}`).digest("hex")
        const blockId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`
        const type = token.type === "heading" ? `heading_${token.depth}` : token.type
        const content =
          token.type === "code"
            ? {
                language: !token.lang || token.lang === "text" ? "plain text" : token.lang,
                rich_text: [
                  {
                    type: "text",
                    text: { content: token.text, link: null },
                    plain_text: token.text,
                    annotations: { ...plain, underline: false, color: "default" },
                  },
                ],
              }
            : { rich_text: richText(token.text) }
        return {
          object: "block",
          id: blockId,
          type,
          [type]: content,
          parent: { type: "page_id", page_id: id },
          has_children: false,
          archived: false,
          in_trash: false,
        }
      })
  const store = Layer.succeed(Store, {
    integrity: integrityRepositoryFixture(),
    upstream: upstreamRepositoryFixture(),
    registerBindingWithBase: (binding, base) =>
      Effect.sync(() => {
        const config = property(json.get("config.json"))
        const existing = (config.sync_bindings ?? []) as Array<{ id: string }>
        json.set("config.json", {
          ...config,
          sync_bindings: [
            ...existing.filter((item) => item.id !== binding.id),
            structuredClone(binding),
          ],
        })
        json.set(`sync/bases/${binding.id}.json`, structuredClone(base))
      }),
    advanceBaseAndReceipt: (bindingId, expectedGeneration, base, receipt) =>
      Effect.gen(function* () {
        if (property(json.get(`sync/bases/${bindingId}.json`)).generation !== expectedGeneration)
          return yield* Effect.fail(fail("SYNC_PLAN_STALE", "Fixture baseline generation changed"))
        if (faults.baselineStop && base.generation === 2) {
          faults.baselineStop = false
          return yield* Effect.fail(fail("STORAGE_ERROR", "Baseline publication interrupted"))
        }
        json.set(`sync/bases/${bindingId}.json`, structuredClone(base))
        json.set(`sync/receipts/${receipt.operation_id}.json`, structuredClone(receipt))
      }),
    backup: () => Effect.die(new Error("Unexpected backup")),
    root: scratch,
    configRoot: join(scratch, "config"),
    cacheRoot: join(scratch, "cache"),
    readJson: (key, schema) =>
      Effect.try({
        try: () => (json.has(key) ? decode(schema, json.get(key)) : undefined),
        catch: () => fail("STATE_CORRUPT", "Malformed fixture state"),
      }),
    writeJson: (key, value) =>
      Effect.gen(function* () {
        if (
          faults.beforeRemoteWrite &&
          key.startsWith("sync/receipts/") &&
          Array.isArray(property(value).groups) &&
          (property(value).groups as unknown[]).some((group) => property(group).stage === "writing")
        ) {
          faults.beforeRemoteWrite = false
          return yield* Effect.fail(fail("STORAGE_ERROR", "Interrupted before remote mutation"))
        }
        if (
          faults.baselineStop &&
          key.startsWith("sync/bases/") &&
          property(value).generation === 2
        ) {
          faults.baselineStop = false
          return yield* Effect.fail(fail("STORAGE_ERROR", "Baseline publication interrupted"))
        }
        if (
          faults.receiptStop &&
          key.startsWith("sync/receipts/") &&
          property(value).status === "complete"
        ) {
          faults.receiptStop = false
          return yield* Effect.fail(fail("STORAGE_ERROR", "Receipt publication interrupted"))
        }
        json.set(key, structuredClone(value))
        if (key.startsWith("sync/plans/")) faults.planSaved?.()
      }),
    readBytes: (key) =>
      objects.has(key)
        ? Effect.succeed(objects.get(key)!)
        : Effect.fail(fail("SNAPSHOT_MISSING", "Missing fixture object")),
    writeBytes: (key, bytes) =>
      Effect.sync(() => {
        objects.set(key, new Uint8Array(bytes))
      }),
    listKeys: (prefix) =>
      Effect.succeed(
        [...new Set([...json.keys(), ...objects.keys()])]
          .filter((key) => key.startsWith(prefix))
          .sort(),
      ),
    reserveCacheGeneration: (scope, pageId) =>
      Effect.sync(() => {
        const key = `${scope}:${pageId}`
        const generation = (generations.get(key) ?? 0) + 1
        generations.set(key, generation)
        return generation
      }),
    retireKeys: (keys) =>
      Effect.sync(() => {
        for (const key of keys) {
          json.delete(key)
          objects.delete(key)
        }
        return keys.map((key) => ({ key, retention_path: join(retained, key) }))
      }),
    output: (destination, bytes) =>
      Effect.gen(function* () {
        const old = copies.get(destination)
        if (
          old &&
          (old.length !== bytes.length || old.some((byte, index) => byte !== bytes[index]))
        )
          return yield* Effect.fail(fail("OUTPUT_CONFLICT", "Occupied review copy"))
        if (!old) {
          copies.set(destination, new Uint8Array(bytes))
          yield* Effect.promise(() => writeFile(destination, bytes))
        }
        return { output: destination, reused: Boolean(old) }
      }),
  })
  const provider: Notion["Service"] = {
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.sync(() => credential),
    request: (path, payload, options) =>
      Effect.gen(function* () {
        const method = options?.method ?? (payload === undefined ? "GET" : "POST")
        calls.push({ path, method })
        for (const [id, request] of delegates)
          if (path.includes(id)) return yield* request(path, payload, options)
        if (path === "v1/users/me") return { id: "sync-user", object: "user" }
        if (path === `v1/databases/${database}`)
          return {
            id: database,
            database_type: null,
            title: [],
            data_sources: [{ id: "ds", name: "Skills" }],
          }
        if (path === "v1/data_sources/ds") return { properties: props() }
        if (path === "v1/data_sources/ds/query")
          return { results: [row()], has_more: false, next_cursor: null }
        if (path === "v1/pages") {
          mutations++
          const title = property(property(property(payload).properties).title).title
          if (!Array.isArray(title))
            return yield* Effect.fail(fail("INVALID_RESPONSE", "Missing child title"))
          const children = property(payload).children
          const marker = Array.isArray(children)
            ? property(property(children[0]).paragraph).rich_text
            : []
          const child = {
            id: `33333333-3333-4333-8333-${String(extraReferences.size + 1).padStart(12, "0")}`,
            title: String(property(property(title[0]).text).content),
            body: Array.isArray(marker)
              ? marker.map((item) => String(property(property(item).text).content ?? "")).join("")
              : "",
          }
          extraReferences.set(child.id, child)
          rootRevision++
          return childRow(child.id, child.title)
        }
        if (path === `v1/pages/${page}`) {
          if (faults.denyRemote)
            return yield* Effect.fail(fail("ACCESS_DENIED", "Remote read denied"))
          if (method === "PATCH") {
            mutations++
            rootRevision++
            const updates = property(property(payload).properties)
            const marker = updates.Publication ?? updates.publication
            if (marker) {
              publication = (property(marker).rich_text as unknown[]).map((value) => ({
                ...property(value),
                plain_text: property(property(value).text).content,
              }))
              return row()
            }
            const title = property(updates.title).title
            const rich = property(updates.description).rich_text
            const nextKind = property(property(updates.Kind ?? updates.kind).select).name
            if (Array.isArray(title)) name = String(property(property(title[0]).text).content)
            if (Array.isArray(rich)) description = String(property(property(rich[0]).text).content)
            if (typeof nextKind === "string") kind = nextKind
            if (updates.references) {
              const rich = property(updates.references).rich_text
              if (Array.isArray(rich)) {
                // Readback keeps the authored link text, destinations, and separators.
                referenceText = rich.map((value) => {
                  const item = property(value)
                  const text = property(item.text)
                  return typeof text.content === "string"
                    ? {
                        ...item,
                        type: "text",
                        text: { ...text, link: text.link ?? null },
                        plain_text: text.content,
                        href: property(text.link).url ?? null,
                      }
                    : { ...item }
                })
                const ids = rich.flatMap((item) => {
                  const row = property(item)
                  const mention = property(property(row.mention).page).id
                  const url = property(property(row.text).link).url
                  const compact = typeof url === "string" ? url.split("/").at(-1) : undefined
                  const id =
                    typeof mention === "string"
                      ? mention
                      : compact?.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5")
                  return id ? [id] : []
                })
                included = ids.includes(guide)
                extraIncluded = ids.filter((id) => extraReferences.has(id))
              }
            }
            if (updates.files) {
              const files = property(updates.files).files
              if (!Array.isArray(files))
                return yield* Effect.fail(fail("INVALID_RESPONSE", "Invalid upload inclusion"))
              attachments = files.map((value) => {
                const item = property(value)
                const upload = String(property(item.file_upload).id)
                const route = `/upload/${upload}`
                const bytes = uploads.get(upload)
                if (!bytes) throw fail("INVALID_RESPONSE", "Missing upload bytes")
                downloads.set(route, bytes)
                return {
                  name: String(item.name),
                  type: "file",
                  file: { url: new URL(route, downloadUrl).href },
                }
              })
            }
          }
          return row()
        }
        if (path.includes(`/blocks/${page}/children`))
          return {
            results: [
              ...bodyBlocks(page, body),
              {
                id: guide,
                type: "child_page",
                parent: { type: "page_id", page_id: page },
                has_children: false,
                child_page: { title: "guide.md" },
              },
              ...[...extraReferences.values()].map((child) => ({
                id: child.id,
                type: "child_page",
                parent: { type: "page_id", page_id: page },
                has_children: false,
                child_page: { title: child.title },
              })),
            ],
            has_more: false,
            next_cursor: null,
          }
        if (path.includes(`/pages/${page}/properties/references`))
          return {
            results: props().References.rich_text.map((rich_text) => ({ rich_text })),
            has_more: false,
            next_cursor: null,
          }
        if (path === `v1/pages/${guide}`) return childRow(guide, "guide.md")
        const child = extraReferences.get(path.split("/")[2]!)
        if (child && path === `v1/pages/${child.id}`) return childRow(child.id, child.title)
        if (
          path === `v1/blocks/${guide}/children?page_size=100` ||
          (child && path === `v1/blocks/${child.id}/children?page_size=100`)
        )
          return {
            object: "list",
            results: bodyBlocks(child?.id ?? guide, child?.body ?? guideBody),
            has_more: false,
            next_cursor: null,
          }
        if (method === "GET" && /^v1\/blocks\/[^/]+$/.test(path)) {
          const id = path.split("/")[2]
          const blocks = [
            bodyBlocks(page, body),
            bodyBlocks(guide, guideBody),
            ...[...extraReferences.values()].map((entry) => bodyBlocks(entry.id, entry.body)),
          ].flat()
          const block = blocks.find((entry) => entry.id === id)
          if (block) return block
        }
        if (path === "v1/file_uploads")
          return { id: `sync-upload-${scratch.split("/").at(-1)}-${++uploadSequence}` }
        if (path.startsWith("v1/file_uploads/") && path.endsWith("/send")) {
          const bytes = objects.get(options!.file!.slice(scratch.length + 1))
          if (!bytes) return yield* Effect.fail(fail("INVALID_RESPONSE", "Missing staged upload"))
          uploads.set(path.split("/")[2]!, bytes)
          return { status: "uploaded" }
        }
        if (path.endsWith("/markdown")) {
          const isGuide = path === `v1/pages/${guide}/markdown`
          if (method === "PATCH") {
            if (faults.interruptBody) {
              faults.interruptBody = false
              return yield* Effect.interrupt
            }
            if (faults.denyMain && !isGuide && !child)
              return yield* Effect.fail(
                fail("ACCESS_DENIED", "Main body denied after reference success"),
              )
            mutations++
            if (faults.bodyDenied) return yield* Effect.fail(fail("ACCESS_DENIED", "Body denied"))
            const next = String(property(property(payload).replace_content).new_str)
            if (isGuide) guideBody = next
            else if (child) child.body = next
            else {
              body = next
              rootRevision++
            }
            if (isGuide || child) {
              const id = isGuide ? guide : child!.id
              childRevisions.set(id, (childRevisions.get(id) ?? 0) + 1)
            }
            if (faults.lostResponse) {
              faults.lostResponse = false
              return yield* Effect.fail(
                fail("WRITE_OUTCOME_UNKNOWN", "Accepted write response lost"),
              )
            }
          }
          const tags = [{ id: guide, title: "guide.md" }, ...extraReferences.values()]
            .map(
              (child) =>
                `<page url="https://www.notion.so/${child.id.replaceAll("-", "")}">${child.title}</page>`,
            )
            .join("\n")
          return {
            object: "page_markdown",
            markdown: isGuide ? guideBody : child ? child.body : body + "\n" + tags,
            truncated: Boolean(faults.incompleteRemote),
            unknown_block_ids: faults.unknownRemote ? ["unsupported-block"] : [],
          }
        }
        return yield* Effect.fail(fail("UNEXPECTED", "Unexpected provider request", { path }))
      }),
  }
  const api = Layer.succeed(Notion, provider)
  const filesystem = await Effect.runPromise(
    makeSyncLocal({
      stateRoot: scratch,
      trash: (location) =>
        Effect.tryPromise({
          try: () => rename(location, join(retained, `retained-${++retentionCount}`)),
          catch: () => fail("LOCAL_IO_ERROR", "Test retention failed."),
        }),
      beforeBoundary: (boundary) =>
        Effect.tryPromise({
          try: async () => {
            await faults.localBoundary?.(boundary)
          },
          catch: (error) =>
            error instanceof SkillsError ? error : fail("LOCAL_IO_ERROR", "Test boundary failed."),
        }),
    }).pipe(Effect.provide(NodeServices.layer)),
  )
  const layer = Layer.mergeAll(
    store,
    api,
    Layer.succeed(SyncLocal, filesystem),
    NodeServices.layer,
    NodeHttpClient.layerFetch,
  )
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E>)
  const initial = await run(openSkill(page).pipe(Effect.flatMap(snapshotPortable)))
  for (const file of initial.files) {
    const location = join(root, file.path)
    await mkdir(join(location, ".."), { recursive: true })
    await writeFile(location, file.bytes)
  }
  const editLocal = async (text: string, directory = root) => {
    await writeFile(join(directory, "references/guide.md"), text)
  }
  const bind = (directory = root, label = "test") =>
    run(bindSync(page, { path: directory, as: label }))
  const bases = () => [...json.entries()].filter(([key]) => key.startsWith("sync/bases/"))
  return {
    scratch,
    root,
    retained,
    run,
    bind,
    editLocal,
    json,
    objects,
    copies,
    calls,
    faults,
    bases,
    filesystem,
    provider,
    seedAttachment: (name: string, bytes: Uint8Array) => {
      const location = `/seed-${encodeURIComponent(name)}`
      downloads.set(location, bytes)
      attachments.push({ name, type: "file", file: { url: `${downloadUrl}${location}` } })
      rootRevision++
    },
    delegates,
    remoteEdit: (text: string) => {
      guideBody = text
      childRevisions.set(guide, (childRevisions.get(guide) ?? 0) + 1)
    },
    renameRemote: (text: string) => {
      name = text
      rootRevision++
    },
    changeCredential: () => {
      credential = "other-credential"
    },
    mutations: () => mutations,
    remoteGuide: () => guideBody,
  }
}
export function code(result: { readonly _tag: string; readonly failure?: unknown }) {
  return property(result.failure).code
}
