import { createHash } from "node:crypto"
import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Lexer } from "marked"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import { Effect, Layer } from "effect"
import { authScope } from "../src/catalog.ts"
import { decode, fail, property, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { beginPublication } from "../src/publication.ts"
import { reconcilePublication } from "../src/publication-reconcile.ts"
import { resumePublication } from "../src/mutation.ts"
import { withoutCreationMarker } from "../src/publication-create-identity.ts"
import { UpstreamState } from "../src/upstream-state.ts"
import { PublicationReceiptSchema, type Receipt } from "../src/publication-model.ts"
import { canonical } from "../src/publication-effect-proof.ts"
import { samePublishedMarkdown } from "../src/markdown.ts"
import { Store } from "../src/store.ts"
import { integrityRepositoryFixture, upstreamRepositoryFixture } from "./fixtures.ts"

const root = "11111111-1111-4111-8111-111111111111"
const database = "44444444-4444-4444-8444-444444444444"
const dataSource = "55555555-5555-4555-8555-555555555555"
const operationId = "p_completed-child-checkpoint-integration"
const rootPath = `v1/pages/${root}`
const receiptKey = `publications/${operationId}.json`
const encoder = new TextEncoder()
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex")
type Transform = (path: string, value: unknown, count: number) => unknown
const temporaryRoots: string[] = []
afterAll(() => {
  for (const path of temporaryRoots) rmSync(path, { recursive: true, force: true })
})

/** The production publication session creates every marker, ACK, guard and
 * integrity row. Only the final parent read is briefly stale after its child ACK. */
async function fixture() {
  const json = new Map<string, unknown>()
  const objects = new Map<string, Uint8Array>()
  const children: Array<{ id: string; title: string; markdown: string; revision: number }> = []
  const requestedFields: Record<string, unknown> = {}
  let references: unknown[] = []
  let rootRevision = 0
  let staleFinalParent = false
  let publishedMain: string | undefined
  let failReceiptWrite = false
  let receiptWrites = 0
  const stateRoot = mkdtempSync(join(tmpdir(), "child-checkpoint-integration-"))
  temporaryRoots.push(stateRoot)
  const upstream = upstreamRepositoryFixture()
  let mutations = 0
  let localWrites = 0
  let readTransform: Transform | undefined
  const reads = new Map<string, number>()
  const requests: Array<{ path: string; method: string }> = []
  const rich = (value: unknown) =>
    Array.isArray(value)
      ? value.map((entry) => ({
          ...property(entry),
          plain_text: property(property(entry).text).content,
        }))
      : value
  const fields = () => ({
    Name: { id: "title", type: "title", title: [] },
    Description: { id: "description", type: "rich_text", rich_text: [] },
    Kind: { id: "kind", type: "select", select: { name: "skill" } },
    Publication: { id: "publication", type: "rich_text", rich_text: [] },
    ...requestedFields,
    References: { id: "references", type: "rich_text", rich_text: structuredClone(references) },
  })
  const persistProperties = (value: unknown) => {
    for (const [key, raw] of Object.entries(property(value))) {
      const field = property(raw)
      if (key === "References" || key === "references") {
        references = rich(field.rich_text) as unknown[]
        continue
      }
      const name =
        (
          {
            title: "Name",
            description: "Description",
            kind: "Kind",
            publication: "Publication",
          } as Record<string, string>
        )[key] ?? key
      const type = Array.isArray(field.title)
        ? "title"
        : Array.isArray(field.rich_text)
          ? "rich_text"
          : "select"
      requestedFields[name] = {
        id: key,
        type,
        ...field,
        ...(type === "title"
          ? { title: rich(field.title) }
          : type === "rich_text"
            ? { rich_text: rich(field.rich_text) }
            : {}),
      }
    }
  }
  const rootPage = () => ({
    object: "page",
    id: root,
    properties: fields(),
    parent: { type: "data_source_id", database_id: database, data_source_id: dataSource },
    last_edited_time: `root-revision-${rootRevision}`,
    archived: false,
    in_trash: false,
  })
  const childPage = (child: (typeof children)[number]) => ({
    object: "page",
    id: child.id,
    properties: {
      title: {
        id: "title",
        type: "title",
        title: [{ type: "text", text: { content: child.title }, plain_text: child.title }],
      },
    },
    parent: { type: "page_id", page_id: root },
    last_edited_time: `child-revision-${child.revision}`,
    archived: false,
    in_trash: false,
  })
  const tag = (child: (typeof children)[number]) =>
    `<page url="https://www.notion.so/${child.id.replaceAll("-", "")}">${child.title}</page>`
  const pageMarkdown = (value: string) => ({
    object: "page_markdown",
    markdown: value,
    truncated: false,
    unknown_block_ids: [],
  })
  const bodyBlocks = (pageId: string, markdown: string) =>
    Lexer.lex(markdown.replace(/<page\b[^>]*>[\s\S]*?<\/page>/g, ""))
      .filter((token) => token.type !== "space" && token.type !== "def")
      .map((token, index) => {
        const hash = digest([pageId, index])
        const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`
        const type = token.type === "heading" ? `heading_${token.depth}` : "paragraph"
        const content =
          token.type === "heading" || token.type === "paragraph" ? token.text : token.raw.trim()
        return {
          object: "block",
          id,
          type,
          [type]: {
            rich_text: [
              {
                type: "text",
                text: { content },
                plain_text: content,
                annotations: {
                  bold: false,
                  italic: false,
                  strikethrough: false,
                  underline: false,
                  code: false,
                  color: "default",
                },
              },
            ],
          },
          parent: { type: "page_id", page_id: pageId },
          has_children: false,
          archived: false,
          in_trash: false,
        }
      })
  const pageBlocks = (pageId: string) =>
    pageId === root
      ? [
          ...bodyBlocks(root, publishedMain ?? ""),
          ...children.map((child) => ({
            object: "block",
            id: child.id,
            type: "child_page",
            child_page: { title: child.title },
            parent: { type: "page_id", page_id: root },
            has_children: false,
            archived: false,
            in_trash: false,
          })),
        ]
      : bodyBlocks(pageId, children.find((child) => child.id === pageId)?.markdown ?? "")
  const transport: Notion["Service"] = {
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.succeed("fixture-credential"),
    request: (path, body, options) =>
      Effect.gen(function* () {
        const method = options?.method ?? (body === undefined ? "GET" : "POST")
        requests.push({ path, method })
        let result: unknown
        if (method !== "GET") {
          mutations++
          if (path === "v1/pages") {
            if (property(property(body).parent).data_source_id) {
              persistProperties(property(body).properties)
              rootRevision++
              result = rootPage()
            } else {
              const child = {
                id: `22222222-2222-4222-8222-${String(children.length + 1).padStart(12, "0")}`,
                title: text(property(property(property(body).properties).title).title),
                revision: 1,
                markdown: text(
                  property(property((property(body).children as unknown[])[0]).paragraph).rich_text,
                ),
              }
              children.push(child)
              staleFinalParent = children.length === 4
              result = childPage(child)
            }
          } else if (path === rootPath && method === "PATCH") {
            persistProperties(property(body).properties)
            rootRevision++
            result = rootPage()
          } else if (method === "PATCH" && /^v1\/pages\/[^/]+\/markdown$/.test(path)) {
            const request = property(body)
            const markdown = property(request.replace_content).new_str
            if (
              request.markdown_version !== "v2" ||
              request.type !== "replace_content" ||
              typeof markdown !== "string"
            )
              return yield* Effect.fail(fail("UNEXPECTED", "Unexpected Markdown mutation shape."))
            if (path === `${rootPath}/markdown`) {
              publishedMain = markdown
              rootRevision++
            } else {
              const child = children.find((item) => item.id === path.split("/")[2])
              if (!child) return yield* Effect.fail(fail("UNEXPECTED", "Unknown Markdown page."))
              child.markdown = markdown
              child.revision++
            }
            result = pageMarkdown(markdown)
          } else return yield* Effect.fail(fail("UNEXPECTED", "Unexpected fixture mutation."))
        } else {
          if (path === "v1/users/me") result = { object: "user", id: "fixture-user" }
          else if (path === `v1/databases/${database}`)
            result = {
              id: database,
              database_type: "skills",
              title: [],
              data_sources: [{ id: dataSource, name: "Skills" }],
            }
          else if (path === `v1/data_sources/${dataSource}`)
            result = { id: dataSource, properties: fields() }
          else if (path === rootPath) result = rootPage()
          else if (path === `${rootPath}/markdown`) {
            const values = staleFinalParent ? children.slice(0, -1) : children
            result = pageMarkdown(
              publishedMain ?? (values.length ? `\n${values.map(tag).join("\n")}\n` : ""),
            )
            staleFinalParent = false
          } else if (path.startsWith(`${rootPath}/properties/references?`))
            result = {
              object: "list",
              results: references.map((rich_text) => ({
                object: "property_item",
                type: "rich_text",
                rich_text,
              })),
              has_more: false,
              next_cursor: null,
            }
          else if (/^v1\/blocks\/[^/]+\/children\?/.test(path)) {
            const parent = path.split("/")[2]!
            result = {
              object: "list",
              results: pageBlocks(parent),
              has_more: false,
              next_cursor: null,
            }
          } else {
            const child = children.find((item) => item.id === path.split("/")[2])
            if (!child) return yield* Effect.fail(fail("UNEXPECTED", "Unexpected fixture read."))
            result = path.endsWith("/markdown") ? pageMarkdown(child.markdown) : childPage(child)
          }
          const count = (reads.get(path) ?? 0) + 1
          reads.set(path, count)
          if (readTransform) result = readTransform(path, structuredClone(result), count)
        }
        return structuredClone(result)
      }),
  }
  const store: Store["Service"] = {
    root: stateRoot,
    configRoot: join(stateRoot, "config"),
    cacheRoot: join(stateRoot, "cache"),
    upstream,
    integrity: integrityRepositoryFixture(json),
    readJson: (key, schema) =>
      Effect.succeed(
        key === "config.json"
          ? decode(schema, { sources: [] })
          : json.has(key)
            ? decode(schema, structuredClone(json.get(key)))
            : undefined,
      ),
    writeJson: (key, value) =>
      Effect.gen(function* () {
        if (key === receiptKey && failReceiptWrite) {
          failReceiptWrite = false
          return yield* Effect.fail(
            fail("FIXTURE_STORE_WRITE_FAILED", "Injected receipt write failure."),
          )
        }
        localWrites++
        if (key === receiptKey) receiptWrites++
        json.set(key, structuredClone(value))
      }),
    readBytes: (key) =>
      objects.has(key)
        ? Effect.succeed(objects.get(key)!.slice())
        : Effect.fail(fail("OBJECT_MISSING", "Missing fixture object.")),
    writeBytes: (key, value) =>
      Effect.sync(() => {
        localWrites++
        objects.set(key, value.slice())
      }),
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
    registerBindingWithBase: () => Effect.die("Unexpected binding"),
    advanceBaseAndReceipt: () => Effect.die("Unexpected base"),
    backup: () => Effect.die("Unexpected backup"),
    output: () => Effect.die("Unexpected output"),
  }
  const layer = Layer.mergeAll(
    NodeServices.layer,
    NodeHttpClient.layerFetch,
    Layer.succeed(Store, store),
    Layer.succeed(Notion, transport),
    Layer.succeed(UpstreamState, upstream),
  )
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E>)
  const portable = {
    kind: "skill" as const,
    name: "checkpoint-sample",
    description: "Use to test a retained child checkpoint.",
    main: "SKILL.md",
    files: [
      { path: "SKILL.md", bytes: encoder.encode("# Main\n") },
      ...["a.md", "b.md", "c.md", "d.md"].map((title) => ({
        path: `references/${title}`,
        bytes: encoder.encode(`# ${title}\n`),
      })),
    ],
  }
  const setup = Effect.gen(function* () {
    const publication = yield* beginPublication(portable, "create", { operationId })
    const scope = yield* authScope
    yield* publication.bind({ database_id: database, data_source_id: dataSource }, scope)
    return yield* publication.finish(
      Effect.gen(function* () {
        yield* publication.run(
          "create_page",
          publication.notion.request("v1/pages", {
            parent: { type: "data_source_id", data_source_id: dataSource },
            properties: {
              title: { title: [{ text: { content: portable.name } }] },
              description: { rich_text: [{ text: { content: portable.description } }] },
              Kind: { select: { name: "skill" } },
            },
          }),
        )
        for (const file of portable.files.slice(1)) {
          yield* publication.run(
            `create_reference:${file.path}`,
            publication.notion.request("v1/pages", {
              parent: { type: "page_id", page_id: root },
              properties: {
                title: { title: [{ text: { content: file.path.slice("references/".length) } }] },
              },
            }),
          )
          yield* publication.run(
            `register_reference:${file.path}`,
            publication.notion.request(
              rootPath,
              {
                properties: {
                  references: {
                    rich_text: children.flatMap((child, index) => [
                      ...(index ? [{ type: "text", text: { content: "\n" } }] : []),
                      {
                        type: "text",
                        text: {
                          content: `references/${child.title}`,
                          link: { url: `https://www.notion.so/${child.id.replaceAll("-", "")}` },
                        },
                      },
                    ]),
                  },
                },
              },
              { method: "PATCH" },
            ),
          )
        }
        return { unreachable: true }
      }),
    )
  })
  const initialized = await Effect.runPromise(setup.pipe(Effect.provide(layer), Effect.result))
  expect(initialized._tag).toBe("Failure")
  const receipt = () => decode(PublicationReceiptSchema, structuredClone(json.get(receiptKey)))
  if (receipt().intents.length !== 8) {
    const summarize = (error: unknown, depth = 0): unknown => {
      if (depth > 5) return "bounded cause"
      const value = property(error)
      const details = property(value.details)
      return {
        code: value.code,
        message: value.message,
        path: details.path,
        stage: details.stage,
        reason: details.reason,
        ...(details.cause ? { cause: summarize(details.cause, depth + 1) } : {}),
      }
    }
    throw new Error(
      "Syn fixture stopped before the intended parent checkpoint: " +
        JSON.stringify({
          error: initialized._tag === "Failure" ? summarize(initialized.failure) : undefined,
          failure: summarize(receipt().failure),
          intents: receipt().intents.map((intent) => ({
            path: intent.path,
            method: intent.method,
            status: intent.status,
          })),
          guard_paths: Object.keys(receipt().guards),
        }),
    )
  }
  expect(receipt().intents.length).toBe(8)
  expect(receipt().intents.every((intent) => intent.status === "completed")).toBe(true)
  expect(receipt().conflict).toBe(true)
  expect(receipt().owner).toBeUndefined()
  reads.clear()
  requests.length = 0
  return {
    json,
    objects,
    children,
    run,
    store,
    portable,
    receipt,
    requests,
    transform: (value: Transform | undefined) => {
      readTransform = value
    },
    mutations: () => mutations,
    localWrites: () => localWrites,
    receiptWrites: () => receiptWrites,
    failNextReceiptWrite: () => {
      failReceiptWrite = true
    },
    resetReads: () => {
      reads.clear()
      requests.length = 0
    },
    insertParentBody: () => {
      publishedMain = `Inserted remote body.\n\n${children.map(tag).join("\n")}\n`
      rootRevision++
    },
    changeReceipt: (change: (receipt: Receipt) => void) => {
      const value = receipt()
      change(value)
      json.set(receiptKey, value)
    },
  }
}

test("reconcile catches up only the final ACK checkpoint and retains the complete original fence in history", async () => {
  const f = await fixture()
  const before = f.receipt()
  const mutations = f.mutations()
  const writes = f.receiptWrites()
  const result = await f.run(reconcilePublication(operationId))
  expect(result.outcome).toBe("needs_safe_resume")
  expect(result.verified).toBe(false)
  expect(result.state).toBe("running")
  expect(result.next.argv).toEqual(["ntn-skills", "operation", "resume", operationId])
  expect(f.mutations()).toBe(mutations)
  expect(f.receiptWrites() - writes).toBe(1)
  expect(f.requests.every((request) => request.method === "GET")).toBe(true)
  const after = f.receipt()
  const path = `${rootPath}/markdown`
  expect(after.conflict).toBeUndefined()
  expect(after.owner).toBeUndefined()
  expect(after.result).toBeUndefined()
  expect(canonical(after.intents)).toBe(canonical(before.intents))
  expect(canonical(after.stages)).toBe(canonical(before.stages))
  expect(canonical(after.failure)).toBe(canonical(before.failure))
  expect(Object.keys(after.guards).sort()).toEqual(Object.keys(before.guards).sort())
  expect(
    Object.keys(before.guards).filter(
      (key) => canonical(before.guards[key]) !== canonical(after.guards[key]),
    ),
  ).toEqual([path])
  expect(after.conflict_history?.length).toBe((before.conflict_history?.length ?? 0) + 1)
  const history = after.conflict_history!.at(-1)!
  expect(history.conflict).toBe(true)
  expect(history.state).toBe(before.state)
  expect(history.stages).toEqual(before.stages)
  expect(canonical(history.failure)).toBe(canonical(before.failure))
  expect(history.intent_count).toBe(before.intents.length)
  expect(history.guard_paths).toEqual(Object.keys(before.guards))
  const proof = history.completed_child_checkpoint!
  expect(proof.operation_id).toBe(operationId)
  expect(proof.page_id).toBe(root)
  expect(proof.child_id).toBe(f.children[3]!.id)
  expect(proof.intent_index).toBe(7)
  expect(proof.receipt_sha256).toBe(digest(before))
  expect(proof.guards_sha256).toBe(digest(before.guards))
  const beforeMarkdown = before.guards[path]
  const afterMarkdown = after.guards[path]
  if (typeof beforeMarkdown !== "string" || typeof afterMarkdown !== "string")
    throw new Error("Expected original and caught-up parent Markdown checkpoints.")
  expect(proof.checkpoint).toEqual({ path, before: beforeMarkdown, after: afterMarkdown })
  expect(proof.metadata_brackets.length).toBe(5)
  expect(proof.metadata_brackets.every((entry) => entry.before_sha256 === entry.after_sha256)).toBe(
    true,
  )
  const integrity = await f.run(f.store.integrity.inspect(operationId))
  expect(integrity?.marker.state).toBe("writing")
})

test("stored checkpoint evidence is audit history, not authority for a second refresh", async () => {
  const f = await fixture()
  await f.run(reconcilePublication(operationId))
  const checkpoint = f.receipt()
  const mutations = f.mutations()
  const repeated = await f.run(reconcilePublication(operationId))
  expect(repeated.verified).toBe(false)
  expect(repeated.state).toBe("running")
  expect(canonical(f.receipt().guards)).toBe(canonical(checkpoint.guards))
  expect(canonical(f.receipt().conflict_history)).toBe(canonical(checkpoint.conflict_history))
  f.insertParentBody()
  const edited = await f.run(reconcilePublication(operationId))
  expect(edited.outcome).toBe("conflict")
  expect(edited.verified).toBe(false)
  expect(f.receipt().conflict).toBe(true)
  expect(canonical(f.receipt().guards)).toBe(canonical(checkpoint.guards))
  expect(canonical(f.receipt().conflict_history)).toBe(canonical(checkpoint.conflict_history))
  expect(f.mutations()).toBe(mutations)
})

for (const variant of [
  "source_bytes",
  "integrity",
  "revision_bracket",
  "partial_markdown",
  "partial_inventory",
] as const) {
  test(`reconcile retains the old fence when fresh checkpoint proof loses ${variant}`, async () => {
    const f = await fixture()
    const before = f.receipt()
    const mutations = f.mutations()
    let injected = false
    f.transform((path, value, count) => {
      if (path === `${rootPath}/markdown` && count === 2) {
        if (variant === "source_bytes") {
          const file = before.portable.files[0]!
          f.objects.set(`objects/${file.sha256}`, encoder.encode("changed original source"))
          injected = true
        }
        if (variant === "integrity") {
          const key = `integrity/operations/${operationId}`
          const row = property(structuredClone(f.json.get(key)))
          row.intended_hash = "f".repeat(64)
          f.json.set(key, row)
          injected = true
        }
        if (variant === "partial_markdown") {
          injected = true
          return { ...property(value), truncated: true }
        }
      }
      if (variant === "revision_bracket" && path === rootPath && count === 3) {
        injected = true
        return { ...property(value), last_edited_time: "changed-during-proof" }
      }
      if (
        variant === "partial_inventory" &&
        path === `v1/blocks/${root}/children?page_size=100` &&
        count === 2
      ) {
        injected = true
        return { ...property(value), has_more: true, next_cursor: null }
      }
      return value
    })
    const result = await f.run(reconcilePublication(operationId))
    expect(injected).toBe(true)
    expect(result.outcome).toBe("conflict")
    expect(result.verified).toBe(false)
    expect(f.receipt().conflict).toBe(true)
    expect(canonical(f.receipt().guards)).toBe(canonical(before.guards))
    expect(canonical(f.receipt().intents)).toBe(canonical(before.intents))
    expect(canonical(f.receipt().conflict_history)).toBe(canonical(before.conflict_history))
    expect(f.mutations()).toBe(mutations)
  })
}

test("a durable receipt changed during fresh proof is never overwritten by the old reconciliation copy", async () => {
  const f = await fixture()
  const before = f.receipt()
  const mutations = f.mutations()
  const writes = f.receiptWrites()
  let retained: Receipt | undefined
  f.transform((path, value, count) => {
    if (path === `${rootPath}/markdown` && count === 2) {
      f.changeReceipt((receipt) => {
        receipt.stages.push("external-retained-stage")
      })
      retained = f.receipt()
    }
    return value
  })
  const result = await f.run(reconcilePublication(operationId).pipe(Effect.result))
  expect(retained).toBeDefined()
  expect(result._tag).toBe("Failure")
  if (result._tag === "Failure")
    expect(result.failure.code).toBe("PUBLICATION_CHILD_CHECKPOINT_UNPROVEN")
  expect(canonical(f.receipt())).toBe(canonical(retained))
  expect(canonical(f.receipt().guards)).toBe(canonical(before.guards))
  expect(f.receipt().conflict).toBe(true)
  expect(f.receiptWrites()).toBe(writes)
  expect(f.mutations()).toBe(mutations)
})

test("a failed checkpoint persistence keeps the prior guard and fence byte for byte", async () => {
  const f = await fixture()
  const retained = digest(f.receipt())
  const mutations = f.mutations()
  const writes = f.receiptWrites()
  f.failNextReceiptWrite()
  const result = await f.run(reconcilePublication(operationId).pipe(Effect.result))
  expect(result._tag).toBe("Failure")
  if (result._tag === "Failure") expect(result.failure.code).toBe("FIXTURE_STORE_WRITE_FAILED")
  expect(digest(f.receipt())).toBe(retained)
  expect(f.receiptWrites()).toBe(writes)
  expect(f.mutations()).toBe(mutations)
})

test("ordinary safe resume after catch-up reuses the original root and four ACKed children", async () => {
  const f = await fixture()
  const original = f.receipt()
  const ids = f.children.map((child) => child.id)
  const result = await f.run(reconcilePublication(operationId))
  expect(result.outcome).toBe("needs_safe_resume")
  expect(result.verified).toBe(false)
  const history = canonical(f.receipt().conflict_history)
  f.resetReads()
  const resumed = await f.run(resumePublication(operationId).pipe(Effect.result))
  if (resumed._tag === "Failure") {
    const summarize = (error: unknown, depth = 0): unknown => {
      if (depth > 5) return "bounded cause"
      const value = property(error)
      const details = property(value.details)
      return {
        code: value.code,
        message: value.message,
        path: details.path,
        stage: details.stage,
        reason: details.reason,
        ...(details.cause ? { cause: summarize(details.cause, depth + 1) } : {}),
      }
    }
    throw new Error(
      "Original checkpoint resume failed: " + JSON.stringify(summarize(resumed.failure)),
    )
  }
  if (!("verified" in resumed.success))
    throw new Error("Ordinary resume did not return a verification result.")
  expect(resumed.success.verified).toBe(true)
  expect(f.receipt().operation_id).toBe(operationId)
  expect(f.receipt().page_id).toBe(root)
  expect(f.receipt().state).toBe("completed")
  expect(f.receipt().conflict).toBeUndefined()
  expect(f.receipt().owner).toBeUndefined()
  expect(f.children.map((child) => child.id)).toEqual(ids)
  expect(
    f.requests.some((request) => request.method === "POST" && request.path === "v1/pages"),
  ).toBe(false)
  expect(canonical(f.receipt().intents.slice(0, original.intents.length))).toBe(
    canonical(original.intents),
  )
  expect(canonical(f.receipt().conflict_history)).toBe(history)
  for (const child of f.children) {
    // Native request escaping may change wire bytes; each page must still contain
    // exactly its own authored heading, with no added or substituted instructions.
    expect(samePublishedMarkdown(withoutCreationMarker(child.markdown), `# ${child.title}\n`)).toBe(
      true,
    )
  }
  const verified = await f.run(reconcilePublication(operationId))
  expect(verified.verified).toBe(true)
  expect(verified.state).toBe("completed")
  expect(canonical(f.receipt().conflict_history)).toBe(history)
})
