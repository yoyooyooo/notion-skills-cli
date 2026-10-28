import { createHash } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "bun:test"
import { Lexer } from "marked"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import { Effect, Layer } from "effect"
import { authScope } from "../src/catalog.ts"
import { decode, fail, property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { beginPublication } from "../src/publication.ts"
import { reconcilePublication } from "../src/publication-reconcile.ts"
import {
  completedCodeLanguageRootsMatch,
  proveCompletedCodeLanguageCheckpoint,
} from "../src/publication-code-language-ack-checkpoint.ts"
import { resumePublication } from "../src/mutation.ts"
import { PublicationReceiptSchema, type Receipt } from "../src/publication-model.ts"
import { canonical } from "../src/publication-effect-proof.ts"
import { Store } from "../src/store.ts"
import { UpstreamState } from "../src/upstream-state.ts"
import { integrityRepositoryFixture, upstreamRepositoryFixture } from "./fixtures.ts"

const root = "11111111-1111-4111-8111-111111111111"
const blockId = "22222222-2222-4222-8222-222222222222"
const database = "44444444-4444-4444-8444-444444444444"
const dataSource = "55555555-5555-4555-8555-555555555555"
const operationId = "p_completed-code-language-checkpoint-test"
const rootPath = `v1/pages/${root}`,
  bodyPath = `${rootPath}/markdown`
const blockPath = `v1/blocks/${blockId}`,
  inventoryPath = `v1/blocks/${root}/children?page_size=100`
const referencePath = `${rootPath}/properties/references?page_size=100`
const receiptKey = `publications/${operationId}.json`
const encoder = new TextEncoder()
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex")
type Transform = (path: string, value: unknown, count: number) => unknown

test("the complete physical roots retain authored bullets, emphasis, inline code and exact links", () => {
  const url = "https://example.org/evidence?version=1"
  const source =
    "## **Heading**\n\nA *careful* `exact  text` [link](" +
    url +
    ").\n\n" +
    "- **Bold** and `literal`\n- Plain\n\n```\n  exact\tcode\nlast line\n```\n"
  const rich = (
    content: string,
    style: Record<string, boolean> = {},
    link: string | null = null,
  ) => ({
    type: "text",
    text: { content, link: link === null ? null : { url: link } },
    plain_text: content,
    href: link,
    annotations: {
      bold: false,
      italic: false,
      code: false,
      underline: false,
      strikethrough: false,
      color: "default",
      ...style,
    },
  })
  const roots: Array<Record<string, unknown>> = [
    {
      type: "heading_2",
      heading_2: {
        rich_text: [rich("Heading", { bold: true })],
        color: "default",
        is_toggleable: false,
      },
    },
    {
      type: "paragraph",
      paragraph: {
        rich_text: [
          rich("A "),
          rich("careful", { italic: true }),
          rich(" "),
          rich("exact  text", { code: true }),
          rich(" "),
          rich("link", {}, url),
          rich("."),
        ],
        color: "default",
        icon: null,
      },
    },
    {
      type: "bulleted_list_item",
      bulleted_list_item: {
        rich_text: [rich("Bold", { bold: true }), rich(" and "), rich("literal", { code: true })],
        color: "default",
      },
    },
    {
      type: "bulleted_list_item",
      bulleted_list_item: { rich_text: [rich("Plain")], color: "default" },
    },
    {
      type: "code",
      code: { rich_text: [rich("  exact\tcode\nlast line")], language: "plain text", caption: [] },
    },
  ]
  expect(completedCodeLanguageRootsMatch(source, roots)).toBe(true)
  for (const variant of ["emphasis", "link", "inline_code", "block_code"] as const) {
    const changed = structuredClone(roots)
    const paragraph = property(changed[1]!.paragraph).rich_text as Array<Record<string, unknown>>
    if (variant === "emphasis") property(paragraph[1]!.annotations).italic = false
    if (variant === "link") {
      property(paragraph[5]!.text).link = { url: "https://example.org/different" }
      paragraph[5]!.href = "https://example.org/different"
    }
    if (variant === "inline_code") {
      property(paragraph[3]!.text).content = "exact text"
      paragraph[3]!.plain_text = "exact text"
    }
    if (variant === "block_code")
      property(changed[4]!.code).rich_text = [rich("  exact\tcode\nlast line\n")]
    expect(completedCodeLanguageRootsMatch(source, changed)).toBe(false)
  }
})

/** Real publication code produces every ACK, guard, creation identity and ledger
 * entry. The only injected failure is the owner GET immediately after code ACK.
 * Temporary state roots are retained; no test cleanup removes user files. */
async function fixture() {
  const json = new Map<string, unknown>(),
    objects = new Map<string, Uint8Array>()
  const requestedFields: Record<string, unknown> = {}
  let references: unknown[] = [],
    language = "javascript"
  let published: string | undefined,
    failOwnerRead = false,
    credential = "fixture-credential"
  let mutations = 0,
    receiptWrites = 0,
    failReceiptWrite = false
  let transform: Transform | undefined
  const reads = new Map<string, number>()
  const requests: Array<{ path: string; method: string }> = []
  const rootState = mkdtempSync(join(tmpdir(), "code-language-checkpoint-"))
  const upstream = upstreamRepositoryFixture()
  const rich = (value: unknown) =>
    Array.isArray(value)
      ? value.map((entry) => ({
          type: "text",
          ...property(entry),
          plain_text: property(property(entry).text).content,
          annotations: {
            bold: false,
            italic: false,
            strikethrough: false,
            underline: false,
            code: false,
            color: "default",
          },
        }))
      : value
  const fields = () => ({
    Name: { id: "title", type: "title", title: [] },
    Description: { id: "description", type: "rich_text", rich_text: [] },
    Kind: { id: "kind", type: "select", select: { name: "skill" } },
    Publication: { id: "publication", type: "rich_text", rich_text: [] },
    Files: { id: "files", type: "files", files: [] },
    Members: { id: "members", type: "relation", relation: [], has_more: false },
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
  const page = () => ({
    object: "page",
    id: root,
    properties: fields(),
    parent: { type: "data_source_id", database_id: database, data_source_id: dataSource },
    // Deliberately coarse, like the actual original Notion response.
    last_edited_time: "2026-10-20T14:30:00.000Z",
    is_archived: false,
    in_trash: false,
  })
  const currentBody = () =>
    published === undefined
      ? ""
      : published.replaceAll("\n\n", "\n").replace("\n```\n", `\n\`\`\`${language}\n`)
  const markdown = () => ({
    object: "page_markdown",
    id: root,
    markdown: currentBody(),
    truncated: false,
    unknown_block_ids: [],
  })
  const blocks = () =>
    Lexer.lex(currentBody())
      .filter((token) => token.type !== "space")
      .map((token, index) => {
        const type =
          token.type === "heading"
            ? `heading_${token.depth}`
            : token.type === "code"
              ? "code"
              : "paragraph"
        const content = "text" in token ? String(token.text) : token.raw
        const id =
          type === "code" ? blockId : `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`
        return {
          object: "block",
          id,
          type,
          parent: { type: "page_id", page_id: root },
          has_children: false,
          in_trash: false,
          last_edited_time: "2026-10-20T14:30:00.000Z",
          [type]: {
            rich_text: rich([{ type: "text", text: { content, link: null } }]),
            ...(type === "code" ? { language, caption: [] } : { color: "default" }),
          },
        }
      })
  const transport: Notion["Service"] = {
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.sync(() => credential),
    request: (path, body, options) =>
      Effect.gen(function* () {
        const method = options?.method ?? (body === undefined ? "GET" : "POST")
        requests.push({ path, method })
        let result: unknown
        if (method !== "GET" && !path.endsWith("/query")) {
          mutations++
          if (path === "v1/pages") {
            persistProperties(property(body).properties)
            result = page()
          } else if (path === rootPath && method === "PATCH") {
            persistProperties(property(body).properties)
            result = page()
          } else if (path === bodyPath && method === "PATCH") {
            const value = property(property(body).replace_content).new_str
            if (typeof value !== "string")
              return yield* Effect.fail(fail("UNEXPECTED", "Unexpected fixture Markdown request."))
            published = value
            language = "javascript"
            result = markdown()
          } else if (path === blockPath && method === "PATCH") {
            const value = property(property(body).code).language
            if (typeof value !== "string")
              return yield* Effect.fail(fail("UNEXPECTED", "Unexpected fixture block request."))
            language = value
            failOwnerRead = true
            result = blocks().find((block) => block.id === blockId)
          } else if (path === "v1/file_uploads") {
            return yield* Effect.fail(
              fail(
                "FIXTURE_STOP_AFTER_CHECKPOINT",
                "Reached the original subsequent source upload.",
              ),
            )
          } else
            return yield* Effect.fail(fail("UNEXPECTED", `Unexpected fixture mutation: ${path}`))
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
            result = {
              id: dataSource,
              parent: { type: "database_id", database_id: database },
              properties: fields(),
            }
          else if (path === `v1/data_sources/${dataSource}/query`)
            result = { results: [page()], has_more: false, next_cursor: null }
          else if (path === rootPath) {
            if (failOwnerRead) {
              failOwnerRead = false
              return yield* Effect.fail(
                fail("NOTION_REQUEST_FAILED", "Injected post-ACK owner GET failure.", { path }),
              )
            }
            result = page()
          } else if (path === bodyPath) result = markdown()
          else if (path === inventoryPath)
            result = { object: "list", results: blocks(), has_more: false, next_cursor: null }
          else if (path === referencePath)
            result = { object: "list", results: [], has_more: false, next_cursor: null }
          else if (path === blockPath) result = blocks().find((block) => block.id === blockId)
          else return yield* Effect.fail(fail("UNEXPECTED", `Unexpected fixture read: ${path}`))
          const count = (reads.get(path) ?? 0) + 1
          reads.set(path, count)
          if (transform) result = transform(path, structuredClone(result), count)
        }
        return structuredClone(result)
      }),
  }
  const store: Store["Service"] = {
    root: rootState,
    configRoot: join(rootState, "config"),
    cacheRoot: join(rootState, "cache"),
    upstream,
    integrity: integrityRepositoryFixture(json),
    readJson: (key, schema) =>
      Effect.sync(() =>
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
          return yield* Effect.fail(fail("FIXTURE_STORE_WRITE_FAILED", "Injected receipt failure."))
        }
        if (key === receiptKey) receiptWrites++
        json.set(key, structuredClone(value))
      }),
    readBytes: (key) =>
      objects.has(key)
        ? Effect.succeed(objects.get(key)!.slice())
        : Effect.fail(fail("OBJECT_MISSING", "Missing fixture object.")),
    writeBytes: (key, bytes) =>
      Effect.sync(() => {
        objects.set(key, bytes.slice())
      }),
    reserveCacheGeneration: (() => {
      let generation = 0
      return () => Effect.sync(() => ++generation)
    })(),
    listKeys: (prefix) =>
      Effect.sync(() => [...json.keys()].filter((key) => key.startsWith(`${prefix}/`))),
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
    Layer.succeed(UpstreamState, upstream),
  )
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E>)
  const authored = "# Checkpoint\n\nOriginal words.\n\n```\n  exact\tcode\nlast line\n```\n"
  const portable = {
    kind: "skill" as const,
    name: "checkpoint-sample",
    description: "Use to test an interrupted language checkpoint.",
    main: "SKILL.md",
    files: [
      {
        path: "SKILL.md",
        bytes: encoder.encode(
          `---\nname: checkpoint-sample\ndescription: Use to test an interrupted language checkpoint.\n---\n\n${authored}`,
        ),
      },
      { path: "references/template.tsv", bytes: encoder.encode("field\tevidence\n") },
      {
        path: "scripts/log.sh",
        bytes: encoder.encode("# Retained source byte evidence only; never executed.\n"),
      },
    ],
  }
  const setup = Effect.gen(function* () {
    const publication = yield* beginPublication(portable, "create", { operationId })
    yield* publication.bind({ database_id: database, data_source_id: dataSource }, yield* authScope)
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
        yield* publication.run(
          "references",
          publication.notion.request(
            rootPath,
            { properties: { references: { rich_text: [] } } },
            { method: "PATCH" },
          ),
        )
        yield* publication.run("checkpoint", publication.notion.request(referencePath))
        yield* publication.run(
          "body:SKILL.md",
          publication.notion.request(
            bodyPath,
            {
              markdown_version: "v2",
              type: "replace_content",
              replace_content: { new_str: authored },
            },
            { method: "PATCH" },
          ),
        )
        return { unreachable: true }
      }),
    )
  })
  const initialized = await run(setup.pipe(Effect.result))
  const receipt = () => decode(PublicationReceiptSchema, structuredClone(json.get(receiptKey)))
  if (
    initialized._tag !== "Failure" ||
    receipt().intents.length !== 4 ||
    receipt().intents.some((intent) => intent.status !== "completed")
  )
    throw new Error(
      "Fixture missed its original ACK interruption: " +
        JSON.stringify({
          result: initialized,
          receipt: receipt(),
          requests,
        }),
    )
  expect(receipt().guards[bodyPath]).toContain("```javascript")
  expect(property(property(receipt().guards[blockPath]).code).language).toBe("plain text")
  const fenced = await run(reconcilePublication(operationId))
  expect(fenced.outcome).toBe("conflict")
  expect(receipt().conflict).toBe(true)
  reads.clear()
  requests.length = 0
  return {
    run,
    store,
    json,
    objects,
    receipt,
    requests,
    authored,
    proof: () =>
      run(proveCompletedCodeLanguageCheckpoint(receipt(), transport).pipe(Effect.result)),
    resetReads: () => {
      reads.clear()
      requests.length = 0
    },
    transform: (value: Transform | undefined) => {
      transform = value
    },
    mutations: () => mutations,
    receiptWrites: () => receiptWrites,
    failNextReceiptWrite: () => {
      failReceiptWrite = true
    },
    changeCredential: () => {
      credential = "changed-fixture-credential"
    },
    changeBody: (value: string) => {
      published = value
    },
    changeReceipt: (change: (value: Receipt) => void) => {
      const value = receipt()
      change(value)
      json.set(receiptKey, value)
    },
  }
}

test("the original language ACK advances only its missing owner checkpoint, with no remote write", async () => {
  const f = await fixture(),
    before = f.receipt(),
    writes = f.receiptWrites(),
    mutations = f.mutations()
  const result = await f.run(reconcilePublication(operationId))
  expect(result).toMatchObject({
    outcome: "needs_safe_resume",
    verified: false,
    unresolved: false,
    state: "running",
  })
  expect(result.next.argv).toEqual(["ntn-skills", "operation", "resume", operationId])
  expect(f.requests.every((request) => request.method === "GET")).toBe(true)
  expect(f.mutations()).toBe(mutations)
  expect(f.receiptWrites() - writes).toBe(1)
  const after = f.receipt(),
    history = after.conflict_history!.at(-1)!,
    proof = history.completed_code_language_checkpoint!
  expect(after.conflict).toBeUndefined()
  expect(after.owner).toBeUndefined()
  expect(after.result).toBeUndefined()
  expect(canonical(after.intents)).toBe(canonical(before.intents))
  expect(canonical(after.stages)).toBe(canonical(before.stages))
  expect(canonical(after.failure)).toBe(canonical(before.failure))
  expect(
    Object.keys(before.guards).filter(
      (path) => canonical(before.guards[path]) !== canonical(after.guards[path]),
    ),
  ).toEqual([bodyPath])
  expect(history.failure).toEqual(before.failure)
  expect(history.guard_paths).toEqual(Object.keys(before.guards))
  expect(proof.receipt_sha256).toBe(digest(before))
  expect(proof.journal_sha256).toBe(digest(before.intents))
  expect(proof.guards_sha256).toBe(digest(before.guards))
  const bodyBefore = before.guards[bodyPath],
    bodyAfter = after.guards[bodyPath]
  if (typeof bodyBefore !== "string" || typeof bodyAfter !== "string")
    throw new Error("Expected complete retained Markdown guards.")
  expect(proof.checkpoint).toEqual({ path: bodyPath, before: bodyBefore, after: bodyAfter })
  expect(proof.metadata_before_sha256).toBe(proof.metadata_after_sha256)
  expect((await f.run(f.store.integrity.inspect(operationId)))?.marker.state).toBe("writing")
}, 20_000)

test("repeated reconciliation never reuses the audit certificate to refresh another body", async () => {
  const f = await fixture()
  await f.run(reconcilePublication(operationId))
  const before = f.receipt(),
    mutations = f.mutations()
  const repeated = await f.run(reconcilePublication(operationId))
  expect(repeated.verified).toBe(false)
  expect(canonical(f.receipt().conflict_history)).toBe(canonical(before.conflict_history))
  expect(canonical(f.receipt().guards)).toBe(canonical(before.guards))
  f.changeBody(f.authored.replace("Original words", "External edit"))
  expect((await f.run(reconcilePublication(operationId))).outcome).toBe("conflict")
  expect(canonical(f.receipt().conflict_history)).toBe(canonical(before.conflict_history))
  expect(canonical(f.receipt().guards)).toBe(canonical(before.guards))
  expect(f.mutations()).toBe(mutations)
}, 20_000)

for (const variant of [
  "main_source",
  "resource_source",
  "partial_markdown",
  "partial_inventory",
  "block_effect",
  "paragraph_effect",
  "extra_root",
  "missing_root",
  "reordered_roots",
  "archived_root",
  "archived_block",
  "unknown_archive_state",
] as const) {
  test(`a language checkpoint refuses inconsistent ${variant} while retaining its original fence`, async () => {
    const f = await fixture(),
      before = f.receipt(),
      mutations = f.mutations()
    if (variant === "main_source" || variant === "resource_source") {
      const file = before.portable.files.find((file) =>
        variant === "main_source" ? file.path === "SKILL.md" : file.path.endsWith(".tsv"),
      )!
      f.objects.set(`objects/${file.sha256}`, encoder.encode("changed source bytes"))
    } else
      f.transform((path, value) => {
        if (variant === "partial_markdown" && path === bodyPath)
          return { ...property(value), truncated: true }
        if (variant === "archived_root" && path === rootPath)
          return { ...property(value), is_archived: true }
        if (variant === "unknown_archive_state" && path === rootPath)
          return { ...property(value), is_archived: "false" }
        if (path !== inventoryPath) return value
        const result = property(value),
          roots = structuredClone(result.results) as Record<string, unknown>[]
        if (variant === "partial_inventory") return { ...result, has_more: true, next_cursor: null }
        if (variant === "extra_root")
          roots.push({ ...structuredClone(roots[1]!), id: "66666666-6666-4666-8666-666666666666" })
        if (variant === "missing_root") roots.splice(1, 1)
        if (variant === "reordered_roots") [roots[0], roots[1]] = [roots[1]!, roots[0]!]
        if (variant === "archived_block") roots[0]!.archived = true
        if (variant === "paragraph_effect" || variant === "block_effect") {
          const block = roots.find(
            (block) => block.type === (variant === "paragraph_effect" ? "paragraph" : "code"),
          )!
          const body = property(block[String(block.type)])
          body.rich_text = [
            {
              type: "text",
              text: { content: "unrequested content", link: null },
              plain_text: "unrequested content",
              annotations: {
                bold: false,
                code: false,
                italic: false,
                strikethrough: false,
                underline: false,
                color: "default",
              },
            },
          ]
        }
        return { ...result, results: roots }
      })
    const proof = await f.proof()
    expect(proof._tag).toBe("Failure")
    expect(canonical(f.receipt())).toBe(canonical(before))
    expect(f.mutations()).toBe(mutations)
  })
}

test("matching corrupted journal and current content cannot replace the independently frozen source", async () => {
  const f = await fixture()
  const altered = f.authored.replace("Original words", "Coordinated lie")
  f.changeBody(altered)
  f.changeReceipt((receipt) => {
    property(property(receipt.intents[2]!.body).replace_content).new_str = altered
    receipt.guards[bodyPath] = String(receipt.guards[bodyPath]).replace(
      "Original words",
      "Coordinated lie",
    )
    receipt.intents[3] = {
      ...receipt.intents[3]!,
      guards: { ...receipt.intents[3]!.guards, [bodyPath]: receipt.guards[bodyPath] },
    }
  })
  const before = f.receipt(),
    proof = await f.proof()
  expect(proof._tag).toBe("Failure")
  if (proof._tag === "Failure")
    expect(proof.failure.message).toContain("exact frozen authored body")
  expect(canonical(f.receipt())).toBe(canonical(before))
})

for (const variant of [
  "published_file",
  "member_relation",
  "duplicate_reference_id",
  "ambiguous_reference_alias",
] as const) {
  test(`a first root-body checkpoint refuses ${variant} outside its complete narrow scope`, async () => {
    const f = await fixture()
    f.changeReceipt((receipt) => {
      for (const guard of [receipt.guards[rootPath], receipt.intents[3]!.guards![rootPath]]) {
        const fields = property(property(guard).properties)
        if (variant === "published_file")
          property(fields.Files).files = [{ name: "unproven.zip", type: "file", id: blockId }]
        if (variant === "member_relation") property(fields.Members).relation = [{ id: blockId }]
        if (variant === "duplicate_reference_id") property(fields.Description).id = "references"
        if (variant === "ambiguous_reference_alias")
          fields.references = { id: "unrelated", type: "rich_text", rich_text: [] }
      }
    })
    const before = f.receipt(),
      result = await f.proof()
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure")
      expect(result.failure.message).toContain(
        variant === "published_file" || variant === "member_relation"
          ? "published files or member relations"
          : "References field",
      )
    expect(canonical(f.receipt())).toBe(canonical(before))
    expect(f.requests).toEqual([])
  })
}

for (const variant of [
  "synthetic_ack",
  "wrong_response",
  "extra_field",
  "unsettled_ack",
  "foreign_owner",
] as const) {
  test(`a terminal ${variant} has no checkpoint authority`, async () => {
    const f = await fixture()
    f.changeReceipt((receipt) => {
      const repair = receipt.intents[3]!
      if (variant === "synthetic_ack")
        repair.response = { id: blockId, recovery: "observed_applied" }
      if (variant === "wrong_response")
        repair.response = { id: "66666666-6666-4666-8666-666666666666" }
      if (variant === "extra_field")
        property(repair.body).code = { language: "plain text", caption: [] }
      if (variant === "unsettled_ack") repair.status = "unknown"
      if (variant === "foreign_owner")
        property(repair.guards![blockPath]).parent = { type: "page_id", page_id: database }
    })
    const before = f.receipt()
    expect((await f.proof())._tag).toBe("Failure")
    expect(canonical(f.receipt())).toBe(canonical(before))
  })
}

for (const variant of ["body", "metadata", "integrity", "source", "scope", "archived"] as const) {
  test(`fresh proof refuses ${variant} drift even while server edit times stay coarse`, async () => {
    const f = await fixture(),
      before = f.receipt(),
      mutations = f.mutations()
    let injected = false
    f.transform((path, value, count) => {
      if (variant === "metadata" && path === rootPath && count === 3) {
        injected = true
        return { ...property(value), last_edited_time: "changed" }
      }
      if (variant === "archived" && path === rootPath && count === 4) {
        injected = true
        return { ...property(value), is_archived: true }
      }
      if (path === bodyPath && count === 2) {
        if (variant === "body") {
          injected = true
          f.changeBody(f.authored.replace("Original words", "Racing body"))
        }
        if (variant === "integrity") {
          injected = true
          property(f.json.get(`integrity/operations/${operationId}`)).intended_hash = "f".repeat(64)
        }
        if (variant === "source") {
          injected = true
          f.objects.set(
            `objects/${before.portable.files[0]!.sha256}`,
            encoder.encode("racing bytes"),
          )
        }
        if (variant === "scope") {
          injected = true
          f.changeCredential()
        }
      }
      return value
    })
    const result = await f.run(reconcilePublication(operationId))
    expect(injected).toBe(true)
    expect(result.outcome).toBe("conflict")
    expect(canonical(f.receipt().guards)).toBe(canonical(before.guards))
    expect(canonical(f.receipt().intents)).toBe(canonical(before.intents))
    expect(f.receipt().conflict_history).toEqual(before.conflict_history)
    expect(f.mutations()).toBe(mutations)
  })
}

test("a concurrent durable receipt change is preserved instead of overwritten by reconciliation", async () => {
  const f = await fixture(),
    writes = f.receiptWrites()
  let changed: Receipt | undefined
  f.transform((path, value, count) => {
    if (path === bodyPath && count === 2) {
      f.changeReceipt((receipt) => {
        receipt.stages.push("concurrent-stage")
      })
      changed = f.receipt()
    }
    return value
  })
  const result = await f.run(reconcilePublication(operationId).pipe(Effect.result))
  expect(changed).toBeDefined()
  expect(result._tag).toBe("Failure")
  if (result._tag === "Failure")
    expect(result.failure.code).toBe("PUBLICATION_CODE_LANGUAGE_CHECKPOINT_UNPROVEN")
  expect(canonical(f.receipt())).toBe(canonical(changed))
  expect(f.receiptWrites()).toBe(writes)
})

test("a failed checkpoint persist retains the original journal and fence byte for byte", async () => {
  const f = await fixture(),
    before = canonical(f.receipt()),
    writes = f.receiptWrites()
  f.failNextReceiptWrite()
  const result = await f.run(reconcilePublication(operationId).pipe(Effect.result))
  expect(result._tag).toBe("Failure")
  if (result._tag === "Failure") expect(result.failure.code).toBe("FIXTURE_STORE_WRITE_FAILED")
  expect(canonical(f.receipt())).toBe(before)
  expect(f.receiptWrites()).toBe(writes)
})

test("ordinary resume advances past the original body without resending its completed language PATCH", async () => {
  const f = await fixture(),
    original = f.receipt()
  expect((await f.run(reconcilePublication(operationId))).outcome).toBe("needs_safe_resume")
  const history = canonical(f.receipt().conflict_history)
  f.resetReads()
  const resumed = await f.run(resumePublication(operationId).pipe(Effect.result))
  expect(resumed._tag).toBe("Failure") // Deliberately stop at the next source-upload boundary.
  expect(
    f.requests.some((request) => request.path === "v1/file_uploads" && request.method === "POST"),
  ).toBe(true)
  expect(
    f.requests.some((request) => request.path === blockPath && request.method === "PATCH"),
  ).toBe(false)
  expect(
    f.requests.some((request) => request.path === bodyPath && request.method === "PATCH"),
  ).toBe(false)
  expect(canonical(f.receipt().intents.slice(0, 4))).toBe(canonical(original.intents))
  expect(canonical(f.receipt().conflict_history)).toBe(history)
})
