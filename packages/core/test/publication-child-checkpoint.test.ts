import { createHash } from "node:crypto"
import { expect, test } from "bun:test"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import { Effect, Layer } from "effect"
import { authScope } from "../src/catalog.ts"
import { decode, fail, property, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { beginPublication } from "../src/publication.ts"
import { proveCompletedChildParentCheckpoint } from "../src/publication-child-checkpoint.ts"
import { PublicationReceiptSchema, type Receipt } from "../src/publication-model.ts"
import { creationMarkerProof, creationMarker } from "../src/publication-create-identity.ts"
import { canonical } from "../src/publication-effect-proof.ts"
import { Store } from "../src/store.ts"
import { integrityRepositoryFixture, upstreamRepositoryFixture } from "./fixtures.ts"

const root = "11111111-1111-4111-8111-111111111111"
const database = "44444444-4444-4444-8444-444444444444"
const dataSource = "55555555-5555-4555-8555-555555555555"
const foreign = "99999999-9999-4999-8999-999999999999"
const operationId = "p_completed-child-checkpoint-test"
const rootPath = `v1/pages/${root}`
const receiptKey = `publications/${operationId}.json`
const encoder = new TextEncoder()
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex")
type Transform = (path: string, value: unknown, count: number) => unknown

/** The production publication session creates every marker, ACK, guard and
 * integrity row. Only the final parent read is briefly stale after its child ACK. */
async function fixture(
  tagURL: (id: string) => string = (id) => `https://www.notion.so/${id.replaceAll("-", "")}`,
) {
  const json = new Map<string, unknown>()
  const objects = new Map<string, Uint8Array>()
  const children: Array<{ id: string; title: string; markdown: string }> = []
  const requestedFields: Record<string, unknown> = {}
  let references: unknown[] = []
  let rootRevision = 0
  let staleFinalParent = false
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
    last_edited_time: "child-revision-1",
    archived: false,
    in_trash: false,
  })
  const tag = (child: (typeof children)[number]) =>
    `<page url="${tagURL(child.id)}">${child.title}</page>`
  const pageMarkdown = (value: string) => ({
    object: "page_markdown",
    markdown: value,
    truncated: false,
    unknown_block_ids: [],
  })
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
            result = pageMarkdown(values.length ? `\n${values.map(tag).join("\n")}\n` : "")
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
              results:
                parent === root
                  ? children.map((child) => ({
                      object: "block",
                      id: child.id,
                      type: "child_page",
                      child_page: { title: child.title },
                      parent: { type: "page_id", page_id: root },
                      archived: false,
                      in_trash: false,
                    }))
                  : [],
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
    root: "/memory",
    configRoot: "/memory/config",
    cacheRoot: "/memory/cache",
    upstream: upstreamRepositoryFixture(),
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
      Effect.sync(() => {
        localWrites++
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
    reserveCacheGeneration: () => Effect.die("Unexpected cache reservation"),
    listKeys: () => Effect.die("Unexpected listing"),
    retireKeys: () => Effect.die("Unexpected retirement"),
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
  )
  const run = <A, E>(
    effect: Effect.Effect<A, E, Store | Notion | import("effect").Crypto.Crypto>,
  ) => Effect.runPromise(effect.pipe(Effect.provide(layer)))
  const portable = {
    kind: "skill" as const,
    name: "Checkpoint Sample",
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
    receipt,
    requests,
    transform: (value: Transform) => {
      readTransform = value
    },
    mutations: () => mutations,
    localWrites: () => localWrites,
    prove: () => run(proveCompletedChildParentCheckpoint(receipt(), transport).pipe(Effect.result)),
    changeReceipt: (change: (receipt: Receipt) => void) => {
      const value = receipt()
      change(value)
      json.set(receiptKey, value)
    },
  }
}

test("a completed final child can prove one parent checkpoint without changing its original publication", async () => {
  const f = await fixture()
  const retained = digest(f.receipt())
  const writes = [f.mutations(), f.localWrites()]
  const result = await f.prove()
  expect(result._tag).toBe("Success")
  if (result._tag !== "Success") return
  expect(result.success.outcome).toBe("needs_safe_resume")
  expect(result.success.verified).toBe(false)
  expect(result.success.evidence.intent_index).toBe(7)
  expect(result.success.evidence.child_id).toBe(f.children[3]!.id)
  expect(result.success.evidence.metadata_brackets.length).toBe(5)
  expect(result.success.checkpoint.path).toBe(`${rootPath}/markdown`)
  expect(result.success.checkpoint.before).not.toBe(result.success.checkpoint.after)
  expect(digest(result.success.before_guards)).toBe(digest(f.receipt().guards))
  expect(digest(f.receipt())).toBe(retained)
  expect([f.mutations(), f.localWrites()]).toEqual(writes)
  expect(f.requests.every((request) => request.method === "GET")).toBe(true)
})

const reject = async (f: Awaited<ReturnType<typeof fixture>>) => {
  const retained = digest(f.receipt())
  const writes = [f.mutations(), f.localWrites()]
  const result = await f.prove()
  expect(result._tag).toBe("Failure")
  expect([f.mutations(), f.localWrites()]).toEqual(writes)
  expect(digest(f.receipt())).toBe(retained)
}

test("the exact original app.notion.com child tags prove the checkpoint with compact IDs", async () => {
  const f = await fixture((id) => `https://app.notion.com/p/${id.replaceAll("-", "")}`)
  const retained = digest(f.receipt())
  const writes = [f.mutations(), f.localWrites()]
  const result = await f.prove()
  expect(result._tag).toBe("Success")
  if (result._tag !== "Success") return
  expect(result.success.outcome).toBe("needs_safe_resume")
  expect(result.success.verified).toBe(false)
  expect(result.success.evidence.intent_index).toBe(7)
  expect(result.success.checkpoint.before).toContain("https://app.notion.com/p/")
  expect(result.success.checkpoint.after).toContain("https://app.notion.com/p/")
  expect(digest(f.receipt())).toBe(retained)
  expect([f.mutations(), f.localWrites()]).toEqual(writes)
  expect(f.requests.every((request) => request.method === "GET")).toBe(true)
})

for (const [name, tagURL] of [
  ["a deceptive host", (id: string) => `https://app.notion.com.invalid/p/${id}`],
  ["an extra path prefix", (id: string) => `https://app.notion.com/other/p/${id}`],
  ["an extra path suffix", (id: string) => `https://app.notion.com/p/${id}/other`],
  ["a query", (id: string) => `https://app.notion.com/p/${id}?view=one`],
  ["a fragment", (id: string) => `https://app.notion.com/p/${id}#section`],
  ["an HTTP URL", (id: string) => `http://app.notion.com/p/${id}`],
] satisfies Array<[string, (id: string) => string]>) {
  test(`the fresh final app child tag cannot authorize ${name}`, async () => {
    const f = await fixture((id) => `https://app.notion.com/p/${id.replaceAll("-", "")}`)
    const lastId = f.children[3]!.id.replaceAll("-", "")
    f.transform((path, value) => {
      if (path !== `${rootPath}/markdown`) return value
      const raw = property(structuredClone(value))
      raw.markdown = String(raw.markdown).replace(
        `https://app.notion.com/p/${lastId}`,
        tagURL(lastId),
      )
      return raw
    })
    const retained = digest(f.receipt())
    const writes = [f.mutations(), f.localWrites()]
    const result = await f.prove()
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        code: "PUBLICATION_CHILD_CHECKPOINT_UNPROVEN",
        message: "A parent tag differs from its exact ACK child and title.",
      },
    })
    expect(digest(f.receipt())).toBe(retained)
    expect([f.mutations(), f.localWrites()]).toEqual(writes)
    expect(f.requests.every((request) => request.method === "GET")).toBe(true)
  })
}

test("a supported hostname alias cannot change the retained original child tag spelling", async () => {
  const f = await fixture((id) => `https://app.notion.com/p/${id.replaceAll("-", "")}`)
  f.transform((path, value) => {
    if (path !== `${rootPath}/markdown`) return value
    const raw = property(structuredClone(value))
    raw.markdown = String(raw.markdown).replaceAll(
      "https://app.notion.com/p/",
      "https://www.notion.so/",
    )
    return raw
  })
  await reject(f)
})

for (const variant of [
  "ack",
  "unresolved",
  "later_intent",
  "registered_last",
  "source_path",
  "original_parent",
  "original_title",
  "original_marker",
  "missing_guard",
  "foreign_guard",
] as const) {
  test(`completed child checkpoint refuses ${variant} original authority`, async () => {
    const f = await fixture()
    f.changeReceipt((receipt) => {
      const last = receipt.intents.at(-1)!
      if (variant === "ack") last.response = { id: foreign }
      if (variant === "unresolved") last.status = "unknown"
      if (variant === "later_intent")
        receipt.intents.push({
          path: `${rootPath}/markdown`,
          method: "PATCH",
          status: "completed",
          body: {},
        })
      if (variant === "registered_last") receipt.intents.push(structuredClone(receipt.intents[6]!))
      if (variant === "source_path")
        receipt.portable.files[1] = {
          ...receipt.portable.files[1]!,
          path: "references/elsewhere.md",
        }
      if (variant === "original_parent")
        property(last.body).parent = { type: "page_id", page_id: foreign }
      if (variant === "original_title")
        property(property(last.body).properties).title = {
          title: [{ text: { content: "elsewhere.md" } }],
        }
      if (variant === "original_marker") property(last.body).children = []
      if (variant === "missing_guard") delete receipt.guards[rootPath]
      if (variant === "foreign_guard")
        receipt.guards[`v1/pages/${foreign}`] = receipt.guards[rootPath]
    })
    await reject(f)
  })
}

for (const variant of [
  "parent",
  "title",
  "marker",
  "child_body",
  "body",
  "literal_tag",
  "extra_child",
  "reordered_child",
  "changed_tag",
  "interior_space",
  "references",
  "partial_inventory",
  "final_cursor",
  "partial_references",
  "truncated",
  "revision",
  "child_revision",
] as const) {
  test(`completed child checkpoint refuses ${variant} current evidence`, async () => {
    const f = await fixture()
    const last = f.children[3]!
    f.transform((path, value, count) => {
      const raw = property(value)
      if (path === `v1/pages/${last.id}`) {
        if (variant === "parent") raw.parent = { type: "page_id", page_id: foreign }
        if (variant === "title")
          property(raw.properties).title = {
            type: "title",
            title: [{ text: { content: "changed.md" }, plain_text: "changed.md" }],
          }
        if (variant === "child_revision" && count === 2) raw.last_edited_time = "changed-after-read"
      }
      if (path === `v1/pages/${last.id}/markdown`) {
        if (variant === "marker") {
          const proof = creationMarkerProof(String(raw.markdown))!
          raw.markdown = creationMarker({ ...proof, operation_token: foreign })
        }
        if (variant === "child_body") raw.markdown = String(raw.markdown) + "\nInserted body.\n"
      }
      if (path === `${rootPath}/markdown`) {
        if (variant === "body") raw.markdown = String(raw.markdown) + "\nInserted body.\n"
        if (variant === "literal_tag") raw.markdown = "```html\n" + String(raw.markdown) + "\n```"
        if (variant === "changed_tag")
          raw.markdown = String(raw.markdown).replace("a.md</page>", "changed.md</page>")
        if (variant === "interior_space")
          raw.markdown = String(raw.markdown).replace("</page>\n<page", "</page>\n \n<page")
        if (variant === "truncated") raw.truncated = true
      }
      if (path === `v1/blocks/${root}/children?page_size=100`) {
        const entries = raw.results as unknown[]
        if (variant === "extra_child")
          raw.results = [...entries, { ...property(entries[0]), id: foreign }]
        if (variant === "reordered_child")
          raw.results = [entries[1], entries[0], ...entries.slice(2)]
        if (variant === "partial_inventory") {
          raw.has_more = true
          raw.next_cursor = null
        }
        if (variant === "final_cursor") raw.next_cursor = "unexpected"
      }
      if (path.startsWith(`${rootPath}/properties/references?`)) {
        if (variant === "references") raw.results = []
        if (variant === "partial_references") {
          raw.has_more = true
          raw.next_cursor = null
        }
      }
      if (variant === "revision" && path === rootPath && count === 2)
        raw.last_edited_time = "changed-after-read"
      return raw
    })
    await reject(f)
  })
}

test("a changed frozen object is refused without refreshing any guard", async () => {
  const f = await fixture()
  const file = f.receipt().portable.files[0]!
  f.objects.set(`objects/${file.sha256}`, encoder.encode("Changed source.\n"))
  await reject(f)
})

for (const variant of ["receipt", "source", "integrity"] as const) {
  test(`checkpoint proof detects ${variant} changing during its fresh read phase`, async () => {
    const f = await fixture()
    const writes = [f.mutations(), f.localWrites()]
    let changed = false
    f.transform((path, value) => {
      if (!changed && path === `${rootPath}/markdown`) {
        changed = true
        if (variant === "receipt")
          f.changeReceipt((receipt) => receipt.stages.push("external-stage"))
        if (variant === "source")
          f.objects.set(
            `objects/${f.receipt().portable.files[0]!.sha256}`,
            encoder.encode("Changed source.\n"),
          )
        if (variant === "integrity") {
          const key = `integrity/operations/${operationId}`
          f.json.set(key, { ...property(f.json.get(key)), page_id: foreign })
        }
      }
      return value
    })
    const result = await f.prove()
    expect(result._tag).toBe("Failure")
    expect(changed).toBe(true)
    expect([f.mutations(), f.localWrites()]).toEqual(writes)
  })
}
