import { expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { Lexer } from "marked"
import { createSkill, resumePublication } from "../src/mutation.ts"
import { decode, fail, property, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { Store } from "../src/store.ts"
import { UpstreamState } from "../src/upstream-state.ts"
import { PublicationReceiptSchema } from "../src/publication-model.ts"
import { reconcilePublication } from "../src/publication-reconcile.ts"
import { integrityRepositoryFixture, upstreamRepositoryFixture } from "./fixtures.ts"

const database = "44444444-4444-4444-8444-444444444444"
const root = "11111111-1111-4111-8111-111111111111"
const operation = "p_acknowledged-code-languages"
const key = `publications/${operation}.json`
const authoredBody =
  "# Original\n\nOriginal paragraph boundary.\n\n---\n\n" +
  Array.from({ length: 6 }, (_, index) => `\`\`\`text\n  exact code ${index}\n\`\`\`\n\n`).join(
    "",
  ) +
  "[site](https://example.test/original)\n"
const inputText =
  "---\nname: sample-skill\ndescription: Use for acknowledged language recovery.\n---\n\n" +
  authoredBody
const structuredPrefix =
  "# Evidence\n\n> Guidance.\n>\n> - Preserve the source.\n\n" +
  "Keep the original mapping.\n\n1. Before.\n2. Status mapping:\n\n" +
  "   | Value | Action |\n   | --- | --- |\n   | `accept` | Read the manual. |\n\n" +
  "3. After.\n\n## Code\n\n"
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")

function fixture(options: { stopAfterFirstCode?: boolean; structuredBody?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "acknowledged-code-languages-"))
  const input = join(directory, "input")
  mkdirSync(input)
  const frozenInput = options.structuredBody
    ? inputText.replace(authoredBody, structuredPrefix + authoredBody)
    : inputText
  writeFileSync(join(input, "SKILL.md"), frozenInput)
  let exists = false,
    revision = 0,
    codeWrites = 0,
    bodyWrites = 0,
    allocationWrites = 0
  let interrupted = options.stopAfterFirstCode === false
  let loss: "before" | "after" | undefined
  let changeDescendantAfterCode = false,
    changeOwnerDuringTreeRead = false
  let uploadCount = 0,
    downloadCount = 0
  const uploads = new Map<string, Uint8Array>()
  const properties: Record<string, unknown> = {
    Name: { id: "title", type: "title", title: [] },
    Description: { id: "description", type: "rich_text", rich_text: [] },
    References: { id: "references", type: "rich_text", rich_text: [] },
    Publication: { id: "publication", type: "rich_text", rich_text: [] },
    Kind: { id: "kind", type: "select", select: { name: "skill" } },
    ...(options.structuredBody ? { Files: { id: "files", type: "files", files: [] } } : {}),
  }
  const roots: Record<string, unknown>[] = []
  const descendants = new Map<string, Record<string, unknown>[]>()
  const requests: Array<{ path: string; method: string; body?: unknown }> = []
  const json = new Map<string, unknown>(),
    objects = new Map<string, Uint8Array>()
  const rich = (value: string) =>
    Lexer.lexInline(value).map((token) => {
      const content = "text" in token ? String(token.text) : token.raw
      return {
        type: "text",
        text: { content, link: token.type === "link" ? { url: token.href } : null },
        plain_text: content,
        annotations: { bold: false, code: token.type === "codespan" },
      }
    })
  const node = (type: string, body: unknown, parent = root): Record<string, unknown> => ({
    id: randomUUID(),
    type,
    parent:
      parent === root ? { type: "page_id", page_id: root } : { type: "block_id", block_id: parent },
    has_children: false,
    archived: false,
    in_trash: false,
    last_edited_time: `block-${revision}`,
    [type]: body,
  })
  const makeRoots = (markdown: string) =>
    Lexer.lex(markdown)
      .filter((token) => !["space", "def"].includes(token.type))
      .flatMap((token): Record<string, unknown>[] => {
        if (options.structuredBody && token.type === "blockquote") {
          const quote = node("quote", { rich_text: rich("Guidance."), color: "default" })
          quote.has_children = true
          descendants.set(String(quote.id), [
            node(
              "bulleted_list_item",
              {
                rich_text: rich("Preserve the source."),
                color: "default",
              },
              String(quote.id),
            ),
          ])
          return [quote]
        }
        if (options.structuredBody && token.type === "list") {
          const owner = node("numbered_list_item", {
            rich_text: rich("Status mapping:"),
            color: "default",
          })
          const table = node(
            "table",
            { table_width: 2, has_column_header: true, has_row_header: false },
            String(owner.id),
          )
          owner.has_children = true
          table.has_children = true
          descendants.set(String(owner.id), [table])
          descendants.set(String(table.id), [
            node("table_row", { cells: [rich("Value"), rich("Action")] }, String(table.id)),
            node(
              "table_row",
              { cells: [rich("`accept`"), rich("Read the manual.")] },
              String(table.id),
            ),
          ])
          return [
            node("numbered_list_item", { rich_text: rich("Before."), color: "default" }),
            owner,
            node("numbered_list_item", { rich_text: rich("After."), color: "default" }),
          ]
        }
        const type =
          token.type === "code"
            ? "code"
            : token.type === "heading"
              ? `heading_${token.depth}`
              : token.type === "hr"
                ? "divider"
                : "paragraph"
        const content = "text" in token ? String(token.text) : token.raw
        return [
          node(
            type,
            type === "code"
              ? { language: "javascript", rich_text: rich(content), caption: [] }
              : type === "divider"
                ? {}
                : { rich_text: rich(content), color: "default" },
          ),
        ]
      })
  const inline = (values: unknown) =>
    Array.isArray(values)
      ? values
          .map((value) => {
            const item = property(value),
              content = String(property(item.text).content ?? "")
            const url = property(property(item.text).link).url
            const label = property(item.annotations).code === true ? `\`${content}\`` : content
            return typeof url === "string" ? `[${label}](${url})` : label
          })
          .join("")
      : ""
  const tableMarkdown = (table: Record<string, unknown>) =>
    [
      '\t<table header-row="true">',
      ...(descendants.get(String(table.id)) ?? []).flatMap((row) => {
        const cells = property(row.table_row).cells
        if (!Array.isArray(cells)) throw new Error("Expected fixture table cells")
        return ["<tr>", ...cells.map((cell) => `<td>${inline(cell)}</td>`), "</tr>"]
      }),
      "\t</table>",
    ].join("\n")
  const markdown = () =>
    roots
      .map((block, index) => {
        const type = String(block.type),
          body = property(block[type])
        const value =
          type === "code"
            ? `\`\`\`${body.language}\n${text(body.rich_text)}\n\`\`\``
            : type === "divider"
              ? "---"
              : /^heading_[123]$/.test(type)
                ? `${"#".repeat(Number(type.slice(-1)))} ${inline(body.rich_text)}`
                : type === "quote"
                  ? `> ${inline(body.rich_text)}\n` +
                    (descendants.get(String(block.id)) ?? [])
                      .map((child) => `\t- ${inline(property(child.bulleted_list_item).rich_text)}`)
                      .join("\n")
                  : type === "numbered_list_item"
                    ? `${
                        1 +
                        roots
                          .slice(0, index)
                          .reverse()
                          .findIndex((entry) => entry.type !== type)
                      }. ${inline(body.rich_text)}` +
                      (block.has_children
                        ? "\n" +
                          (descendants.get(String(block.id)) ?? []).map(tableMarkdown).join("\n")
                        : "")
                    : inline(body.rich_text)
        // Faithfully model the independent paragraph/divider readback defect. The
        // original ordered roots still retain both blocks and their exact content.
        return (
          (index
            ? type === "divider" && roots[index - 1]!.type === "paragraph"
              ? "\n"
              : "\n\n"
            : "") + value
        )
      })
      .join("") + (roots.length ? "\n" : "")
  const page = () => ({
    id: root,
    last_edited_time: `page-${revision}`,
    archived: false,
    in_trash: false,
    parent: { type: "data_source_id", database_id: database, data_source_id: "ds" },
    properties: structuredClone(properties),
  })
  const setProperties = (values: unknown) => {
    const names: Record<string, string> = {
      title: "Name",
      description: "Description",
      references: "References",
      publication: "Publication",
      kind: "Kind",
      files: "Files",
    }
    for (const [key, raw] of Object.entries(property(values))) {
      const name = names[key] ?? key,
        old = property(properties[name]),
        value = property(raw)
      const kind = Array.isArray(value.title)
        ? "title"
        : Array.isArray(value.rich_text)
          ? "rich_text"
          : Array.isArray(value.files)
            ? "files"
            : "select"
      properties[name] = {
        ...old,
        ...value,
        id: old.id ?? key,
        type: kind,
        ...(["title", "rich_text"].includes(kind)
          ? {
              [kind]: (value[kind] as unknown[]).map((item) => ({
                ...property(item),
                type: "text",
                plain_text: property(property(item).text).content,
              })),
            }
          : {}),
        ...(kind === "files" && Array.isArray(value.files)
          ? {
              files: value.files.map((item) => {
                const file = property(item),
                  id = property(file.file_upload).id
                if (typeof id !== "string" || !uploads.has(id))
                  throw new Error("Source attachment lacks its native upload bytes")
                return {
                  id,
                  name: file.name,
                  type: "file",
                  file: { url: `https://code-language-fixture.test/${id}` },
                }
              }),
            }
          : {}),
      }
    }
  }
  const upstream = upstreamRepositoryFixture()
  const integrity = integrityRepositoryFixture()
  const store = Layer.succeed(Store, {
    root: directory,
    configRoot: directory,
    cacheRoot: directory,
    upstream,
    integrity,
    registerBindingWithBase: () => Effect.die("Unexpected binding write"),
    advanceBaseAndReceipt: () => Effect.die("Unexpected baseline write"),
    backup: () => Effect.die("Unexpected backup"),
    output: () => Effect.die("Unexpected output"),
    reserveCacheGeneration: (() => {
      let generation = 0
      return () => Effect.succeed(++generation)
    })(),
    listKeys: (prefix) =>
      Effect.succeed([...json.keys()].filter((value) => value.startsWith(`${prefix}/`))),
    retireKeys: (keys) =>
      Effect.sync(() =>
        keys.map((key) => {
          json.delete(key)
          return { key, retention_path: "fixture" }
        }),
      ),
    readJson: (key, schema) =>
      Effect.sync(() =>
        json.has(key) ? decode(schema, structuredClone(json.get(key))) : undefined,
      ),
    writeJson: (key, value) =>
      Effect.sync(() => {
        json.set(key, structuredClone(value))
      }),
    readBytes: (key) =>
      objects.has(key)
        ? Effect.succeed(objects.get(key)!)
        : Effect.fail(fail("SNAPSHOT_MISSING", "Missing fixture object")),
    writeBytes: (key, value) =>
      Effect.sync(() => {
        objects.set(key, new Uint8Array(value))
      }),
  })
  const api = Layer.succeed(Notion, {
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.succeed("credential"),
    request: (path, body, options) =>
      Effect.gen(function* () {
        const method = options?.method ?? (body === undefined ? "GET" : "POST")
        requests.push({
          path,
          method,
          ...(body === undefined ? {} : { body: structuredClone(body) }),
        })
        if (path === "v1/users/me") return { id: "fixture", object: "user" }
        if (path === `v1/databases/${database}`)
          return {
            id: database,
            database_type: null,
            title: [],
            data_sources: [{ id: "ds", name: "Skills" }],
          }
        if (path === "v1/data_sources/ds") return { id: "ds", properties: page().properties }
        if (path === "v1/data_sources/ds/query")
          return { results: exists ? [page()] : [], has_more: false, next_cursor: null }
        if (path === "v1/file_uploads") return { id: `source-${++uploadCount}`, status: "pending" }
        const sent = /^v1\/file_uploads\/([^/]+)\/send$/.exec(path)
        if (sent) {
          const absolute = options?.file
          const bytes = absolute?.startsWith(directory + "/")
            ? objects.get(absolute.slice(directory.length + 1))
            : undefined
          if (!bytes)
            return yield* Effect.fail(
              fail("UNEXPECTED", "Source upload did not use its native retained artifact"),
            )
          uploads.set(sent[1]!, bytes.slice())
          return { id: sent[1], status: "uploaded" }
        }
        const uploaded = /^v1\/file_uploads\/([^/]+)$/.exec(path)
        if (uploaded)
          return { id: uploaded[1], status: uploads.has(uploaded[1]!) ? "uploaded" : "pending" }
        if (path === "v1/pages" && method === "POST") {
          exists = true
          allocationWrites++
          revision++
          setProperties(property(body).properties)
          return page()
        }
        if (path === `v1/pages/${root}`) {
          if (method === "PATCH") {
            revision++
            setProperties(property(body).properties)
          }
          return page()
        }
        if (path === `v1/pages/${root}/properties/references?page_size=100`)
          return { results: [], has_more: false, next_cursor: null }
        if (path === `v1/blocks/${root}/children?page_size=100`)
          return { results: structuredClone(roots), has_more: false, next_cursor: null }
        const childInventory = /^v1\/blocks\/([^/]+)\/children\?page_size=100$/.exec(path)
        if (childInventory && descendants.has(childInventory[1]!)) {
          if (changeOwnerDuringTreeRead) {
            changeOwnerDuringTreeRead = false
            revision++
          }
          return {
            results: structuredClone(descendants.get(childInventory[1]!)!),
            has_more: false,
            next_cursor: null,
          }
        }
        if (path === `v1/pages/${root}/markdown`) {
          if (method === "PATCH") {
            bodyWrites++
            revision++
            const value = property(property(body).replace_content).new_str
            if (typeof value !== "string")
              return yield* Effect.fail(
                fail("UNEXPECTED", "Expected a complete Markdown replacement"),
              )
            roots.splice(0, roots.length, ...makeRoots(value))
          }
          return {
            object: "page_markdown",
            markdown: markdown(),
            truncated: false,
            unknown_block_ids: [],
          }
        }
        const block = roots.find((entry) => path === `v1/blocks/${entry.id}`)
        if (block) {
          if (
            !interrupted &&
            method === "GET" &&
            codeWrites === 1 &&
            block.type === "code" &&
            property(block.code).language === "javascript"
          ) {
            interrupted = true
            return yield* Effect.fail(
              fail("NTN_UNAVAILABLE", "Controlled read failure before the next language intent."),
            )
          }
          if (method === "PATCH") {
            if (digest(body) !== digest({ code: { language: "plain text" } }))
              return yield* Effect.fail(
                fail("UNEXPECTED", "Only the exact language field may change"),
              )
            const lost = loss
            loss = undefined
            if (lost === "before")
              return yield* Effect.fail(
                fail("WRITE_OUTCOME_UNKNOWN", "Controlled lost response before application"),
              )
            codeWrites++
            revision++
            block.code = { ...property(block.code), language: "plain text" }
            block.last_edited_time = `block-${revision}`
            if (changeDescendantAfterCode) {
              changeDescendantAfterCode = false
              const child = [...descendants.values()]
                .flat()
                .find((entry) => entry.type === "table_row")
              if (!child) throw new Error("Expected complete table evidence")
              child.last_edited_time = `foreign-descendant-${revision}`
            }
            if (lost === "after")
              return yield* Effect.fail(
                fail("WRITE_OUTCOME_UNKNOWN", "Controlled lost response after application"),
              )
          }
          return structuredClone(block)
        }
        return yield* Effect.fail(
          fail("UNEXPECTED", "Unexpected fixture request", { path, method }),
        )
      }),
  })
  const fixtureFetch: typeof globalThis.fetch = Object.assign(
    async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = new URL(String(input))
      if (url.origin !== "https://code-language-fixture.test")
        throw new Error("Unexpected fixture download origin")
      const bytes = uploads.get(url.pathname.slice(1))
      if (bytes) downloadCount++
      return bytes ? new Response(bytes.slice().buffer) : new Response(null, { status: 404 })
    },
    {
      preconnect: () => {
        throw new Error("Unexpected fixture preconnect")
      },
    },
  )
  const layer = Layer.mergeAll(
    NodeServices.layer,
    NodeHttpClient.layerFetch,
    store,
    api,
    Layer.succeed(FetchHttpClient.Fetch, fixtureFetch),
    Layer.succeed(UpstreamState, upstream),
  )
  type Services = typeof layer extends Layer.Layer<infer R, infer _E, infer _I> ? R : never
  return {
    input,
    roots,
    descendants,
    objects,
    requests,
    properties,
    integrity,
    run: <A, E>(effect: Effect.Effect<A, E, Services>) =>
      Effect.runPromise(effect.pipe(Effect.provide(layer))),
    receipt: () => decode(PublicationReceiptSchema, structuredClone(json.get(key))),
    counts: () => ({ codeWrites, bodyWrites, allocationWrites }),
    sourceCounts: () => ({ uploads: uploadCount, downloads: downloadCount }),
    lose: (mode: "before" | "after") => {
      loss = mode
    },
    changeTreeAfterCode: () => {
      changeDescendantAfterCode = true
    },
    changeOwnerInsideTreeRead: () => {
      changeOwnerDuringTreeRead = true
    },
    changed: (kind: "body" | "url" | "owner" | "source" | "foreign_block" | "field") => {
      if (kind === "source") {
        const receipt = decode(PublicationReceiptSchema, json.get(key))
        objects.set(
          `objects/${receipt.portable.files[0]!.sha256}`,
          new TextEncoder().encode(frozenInput + "changed"),
        )
      } else if (kind === "field") {
        const receipt = decode(PublicationReceiptSchema, json.get(key))
        const path = receipt.intents.at(-1)!.path
        const code = roots.find((entry) => path === `v1/blocks/${entry.id}`)!
        code.code = { ...property(code.code), language: "python" }
      } else if (kind === "owner")
        properties.DefaultContext = {
          id: "context",
          type: "rich_text",
          rich_text: rich("external"),
        }
      else if (kind === "foreign_block") {
        const code = roots.filter((entry) => entry.type === "code")[2]!
        code.parent = { type: "page_id", page_id: "22222222-2222-4222-8222-222222222222" }
      } else {
        const paragraph =
          kind === "body"
            ? roots.find((entry) => entry.type === "paragraph")!
            : roots.findLast((entry) => entry.type === "paragraph")!
        paragraph.paragraph = {
          ...property(paragraph.paragraph),
          rich_text: rich(
            kind === "body" ? "external words" : "[site](https://example.test/changed)",
          ),
        }
      }
    },
    close: () => rmSync(directory, { recursive: true, force: true }),
  }
}

async function stoppedCreate(f: ReturnType<typeof fixture>) {
  const stopped = await f.run(
    createSkill(f.input, { database, operationId: operation }).pipe(Effect.result),
  )
  expect(stopped._tag).toBe("Failure")
  expect(stopped._tag === "Failure" ? property(stopped.failure).code : "success").toBe(
    "WRITE_PARTIAL",
  )
  expect(
    stopped._tag === "Failure" ? property(property(stopped.failure).details).cause_code : "success",
  ).toBe("NTN_UNAVAILABLE")
  const receipt = f.receipt()
  expect(receipt.state).toBe("failed")
  expect(receipt.owner).toBeUndefined()
  expect(receipt.conflict).not.toBe(true)
  expect(receipt.intents.every((intent) => intent.status === "completed")).toBe(true)
  expect(receipt.intents.filter((intent) => intent.path.endsWith("/markdown"))).toHaveLength(1)
  expect(
    receipt.intents.find((intent) => intent.path.endsWith("/markdown"))!.typed_links,
  ).toBeUndefined()
  expect(f.counts()).toEqual({ codeWrites: 1, bodyWrites: 1, allocationWrites: 1 })
  return receipt
}

test("ordinary original resume completes five omitted language fields without replacing the acknowledged body", async () => {
  const f = fixture()
  try {
    const before = await stoppedCreate(f),
      prefix = digest(before.intents),
      ids = f.roots.map((block) => block.id)
    const ledger = await f.run(f.integrity.inspect(operation))
    expect(ledger?.marker.state).toBe("writing")
    expect(ledger?.page_id).toBeUndefined()
    const resumed = await f.run(resumePublication(operation))
    expect(resumed).toMatchObject({ resumed: true, verified: true })
    expect(f.counts()).toEqual({ codeWrites: 6, bodyWrites: 1, allocationWrites: 1 })
    expect(f.roots.map((block) => block.id)).toEqual(ids)
    const receipt = f.receipt()
    expect(digest(receipt.intents.slice(0, before.intents.length))).toBe(prefix)
    expect(
      receipt.intents
        .slice(before.intents.length)
        .filter((intent) => intent.path.startsWith("v1/blocks/")),
    ).toHaveLength(5)
    expect(receipt.intents.every((intent) => intent.status === "completed")).toBe(true)
    expect(
      f.roots
        .filter((block) => block.type === "code")
        .every((block) => property(block.code).language === "plain text"),
    ).toBe(true)
    expect(await f.run(reconcilePublication(operation))).toMatchObject({
      outcome: "success",
      verified: true,
    })
  } finally {
    f.close()
  }
}, 15000)

test("acknowledged root code repair proves complete quote and list table descendants", async () => {
  const f = fixture({ structuredBody: true })
  const before = await stoppedCreate(f),
    prefix = digest(before.intents),
    roots = f.roots.map((block) => block.id)
  const descendants = digest([...f.descendants]),
    requestIndex = f.requests.length
  const result = await f.run(resumePublication(operation))
  expect(result).toMatchObject({ resumed: true, verified: true })
  expect(f.counts()).toEqual({ codeWrites: 6, bodyWrites: 1, allocationWrites: 1 })
  expect(f.sourceCounts().uploads).toBe(1)
  expect(f.sourceCounts().downloads).toBeGreaterThan(0)
  expect(f.roots.map((block) => block.id)).toEqual(roots)
  expect(digest([...f.descendants])).toBe(descendants)
  expect(digest(f.receipt().intents.slice(0, before.intents.length))).toBe(prefix)
  const resumed = f.requests.slice(requestIndex)
  for (const owner of f.descendants.keys())
    expect(
      resumed.some(
        (request) =>
          request.method === "GET" && request.path === `v1/blocks/${owner}/children?page_size=100`,
      ),
    ).toBe(true)
  const writes = resumed.filter(
    (request) => request.method === "PATCH" && request.path.startsWith("v1/blocks/"),
  )
  expect(writes).toHaveLength(5)
  expect(
    writes.every((request) =>
      f.roots.some((block) => block.type === "code" && request.path === `v1/blocks/${block.id}`),
    ),
  ).toBe(true)
}, 15000)

test("a changed descendant revision after a root language PATCH stops the remaining field writes", async () => {
  const f = fixture({ structuredBody: true }),
    before = await stoppedCreate(f),
    prefix = digest(before.intents)
  f.changeTreeAfterCode()
  const result = await f.run(resumePublication(operation).pipe(Effect.result))
  expect(result._tag).toBe("Failure")
  expect(f.counts()).toEqual({ codeWrites: 2, bodyWrites: 1, allocationWrites: 1 })
  expect(digest(f.receipt().intents.slice(0, before.intents.length))).toBe(prefix)
  expect(
    [...f.descendants.values()]
      .flat()
      .some((block) => String(block.last_edited_time).startsWith("foreign-descendant-")),
  ).toBe(true)
}, 15000)

test("a metadata change inside descendant enumeration refuses before a new root field write", async () => {
  const f = fixture({ structuredBody: true }),
    before = await stoppedCreate(f),
    prefix = digest(before.intents)
  f.changeOwnerInsideTreeRead()
  const result = await f.run(resumePublication(operation).pipe(Effect.result))
  expect(result._tag).toBe("Failure")
  expect(f.counts()).toEqual({ codeWrites: 1, bodyWrites: 1, allocationWrites: 1 })
  expect(digest(f.receipt().intents)).toBe(prefix)
}, 15000)

for (const changed of ["body", "url", "owner", "source", "foreign_block"] as const) {
  test(`acknowledged language repair rejects changed ${changed} before any new field write`, async () => {
    const f = fixture()
    try {
      const before = await stoppedCreate(f),
        prefix = digest(before.intents),
        counts = f.counts()
      f.changed(changed)
      const outcome = await f.run(resumePublication(operation).pipe(Effect.result))
      expect(outcome._tag).toBe("Failure")
      expect(f.counts()).toEqual(counts)
      expect(digest(f.receipt().intents)).toBe(prefix)
    } finally {
      f.close()
    }
  })
}

function failureCode(result: { _tag: string; failure?: unknown }) {
  return result._tag === "Failure" ? String(property(result.failure).code) : undefined
}

async function unknownLanguage(
  f: ReturnType<typeof fixture>,
  origin: "ordinary" | "acknowledged",
  lost: "before" | "after",
) {
  if (origin === "acknowledged") {
    const stopped = await f.run(
      createSkill(f.input, { database, operationId: operation }).pipe(Effect.result),
    )
    expect(failureCode(stopped)).toBe("WRITE_PARTIAL")
    expect(f.receipt().intents.every((intent) => intent.status === "completed")).toBe(true)
    expect(f.counts()).toEqual({ codeWrites: 1, bodyWrites: 1, allocationWrites: 1 })
  }
  f.lose(lost)
  const stopped =
    origin === "ordinary"
      ? await f.run(createSkill(f.input, { database, operationId: operation }).pipe(Effect.result))
      : await f.run(resumePublication(operation).pipe(Effect.result))
  expect(stopped._tag).toBe("Failure")
  const receipt = f.receipt(),
    index = receipt.intents.length - 1
  expect(receipt.state).toBe("unknown")
  expect(receipt.owner).toBeUndefined()
  expect(receipt.conflict).not.toBe(true)
  expect(receipt.intents[index]!.status).toBe("unknown")
  expect(receipt.intents[index]!.body).toEqual({ code: { language: "plain text" } })
  expect(receipt.intents.slice(0, index).every((intent) => intent.status === "completed")).toBe(
    true,
  )
  return {
    receipt,
    index,
    prefix: digest(receipt.intents.slice(0, index)),
    code: f.counts().codeWrites,
  }
}

for (const origin of ["ordinary", "acknowledged"] as const)
  for (const lost of ["before", "after"] as const) {
    test(`native ${origin} code-language ${lost} loss retains history and completes only after original effect proof`, async () => {
      const f = fixture({ stopAfterFirstCode: origin === "acknowledged" })
      try {
        const original = await unknownLanguage(f, origin, lost)
        const requests = f.requests.length,
          ids = f.roots.map((block) => block.id)
        const reconciled = await f.run(reconcilePublication(operation))
        expect(f.requests.slice(requests).every((request) => request.method === "GET")).toBe(true)
        expect(f.counts().codeWrites).toBe(original.code)
        if (lost === "before") {
          expect(reconciled.outcome).toBe("unknown")
          expect(
            reconciled.observations.some(
              (item) => item.reason === "PUBLICATION_BLOCK_RETRY_REQUIRED",
            ),
          ).toBe(true)
          expect(f.receipt().intents[original.index]!.status).toBe("unknown")
        } else {
          expect(reconciled.outcome).toBe("success")
          expect(f.receipt().intents[original.index]!.status).toBe("completed")
          expect(property(f.receipt().intents[original.index]!.response).recovery).toBe(
            "observed_applied",
          )
        }
        const outcome = await f.run(resumePublication(operation).pipe(Effect.result))
        if (outcome._tag === "Failure")
          throw new Error(
            JSON.stringify({
              code: failureCode(outcome),
              cause_code: property(property(outcome.failure).details).cause_code,
              stage: property(property(outcome.failure).details).stage,
            }),
          )
        expect(outcome.success).toMatchObject({ resumed: true, verified: true })
        expect(f.counts()).toEqual({ codeWrites: 6, bodyWrites: 1, allocationWrites: 1 })
        expect(f.roots.map((block) => block.id)).toEqual(ids)
        const final = f.receipt(),
          historical = final.intents[original.index]!
        expect(digest(final.intents.slice(0, original.index))).toBe(original.prefix)
        expect(historical.path).toBe(original.receipt.intents[original.index]!.path)
        expect(digest(historical.body)).toBe(digest(original.receipt.intents[original.index]!.body))
        expect(digest(historical.guards)).toBe(
          digest(original.receipt.intents[original.index]!.guards),
        )
        if (lost === "before") {
          expect(historical.status).toBe("failed")
          expect(property(historical.response).recovery).toBe("known_not_applied")
          expect(property(historical.response).prior_status).toBe("unknown")
          const successorIndex = property(historical.response).replayed_by_intent
          expect(typeof successorIndex).toBe("number")
          if (typeof successorIndex !== "number") throw new Error("Missing formal replay successor")
          const successor = final.intents[successorIndex]!
          expect(successor.status).toBe("completed")
          expect(successor.path).toBe(historical.path)
          expect(digest(successor.body)).toBe(digest(historical.body))
        } else expect(historical.status).toBe("completed")
        expect(
          f.roots
            .filter((block) => block.type === "code")
            .every((block) => property(block.code).language === "plain text"),
        ).toBe(true)
        expect(await f.run(reconcilePublication(operation))).toMatchObject({
          outcome: "success",
          verified: true,
        })
      } finally {
        f.close()
      }
    }, 15000)
  }

for (const lost of ["before", "after"] as const)
  for (const changed of ["body", "owner", "field"] as const) {
    test(`native language ${lost} loss refuses external ${changed} before another mutation`, async () => {
      const f = fixture({ stopAfterFirstCode: false })
      try {
        const original = await unknownLanguage(f, "ordinary", lost)
        const prefix = digest(f.receipt().intents),
          counts = f.counts()
        f.changed(changed)
        const reconciled = await f.run(reconcilePublication(operation))
        expect(reconciled.outcome).not.toBe("success")
        const requestIndex = f.requests.length
        const outcome = await f.run(resumePublication(operation).pipe(Effect.result))
        expect(outcome._tag).toBe("Failure")
        expect(f.counts()).toEqual(counts)
        expect(f.requests.slice(requestIndex).every((request) => request.method === "GET")).toBe(
          true,
        )
        expect(digest(f.receipt().intents)).toBe(prefix)
        expect(digest(f.receipt().intents.slice(0, original.index))).toBe(original.prefix)
      } finally {
        f.close()
      }
    }, 15000)
  }
