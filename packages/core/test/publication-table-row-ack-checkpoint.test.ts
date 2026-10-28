import { createHash } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "bun:test"
import { Lexer, type Tokens } from "marked"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, Layer } from "effect"
import { authScope } from "../src/catalog.ts"
import { decode, fail, property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { canonical } from "../src/publication-effect-proof.ts"
import {
  creationMarker,
  creationMarkerBlock,
  type CreationProof,
} from "../src/publication-create-identity.ts"
import { markdownRichText, markdownTableCells } from "../src/markdown-blocks.ts"
import { PublicationReceiptSchema, type Receipt } from "../src/publication-model.ts"
import { blockObservation, metadata, observation } from "../src/publication-observation.ts"
import { reconcilePublication } from "../src/publication-reconcile.ts"
import {
  completedTableRowCheckpointCandidate,
  proveCompletedTableRowCheckpoint,
} from "../src/publication-table-row-ack-checkpoint.ts"
import { referenceLinks } from "../src/reference-links.ts"
import { Store } from "../src/store.ts"
import { UpstreamState } from "../src/upstream-state.ts"
import { integrityRepositoryFixture, upstreamRepositoryFixture } from "./fixtures.ts"

const id = (n: number) => `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`
const root = id(1),
  earlier = id(2),
  owner = id(3),
  later = id(4),
  database = id(5),
  dataSource = id(6)
const tableId = id(7),
  rowId = id(8),
  operationId = "p_completed-table-row-checkpoint-test"
const rootPath = `v1/pages/${root}`,
  ownerPath = `v1/pages/${owner}`,
  bodyPath = `${ownerPath}/markdown`
const blockPath = `v1/blocks/${rowId}`,
  tablePath = `v1/blocks/${tableId}`
const ownerInventory = `v1/blocks/${owner}/children?page_size=100`
const tableInventory = `${tablePath}/children?page_size=100`
const receiptKey = `publications/${operationId}.json`,
  integrityKey = `integrity/operations/${operationId}`
const oldTime = "2026-10-20T15:37:00.000Z",
  newTime = "2026-10-20T15:39:00.000Z"
const encoder = new TextEncoder()
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex")
const bytesHash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex")
type Transform = (path: string, raw: unknown, count: number) => unknown
const responseRich = (values: readonly unknown[]) =>
  values.map((raw) => {
    const value = property(raw),
      body = property(value.text),
      link = property(body.link).url ?? null
    return {
      ...value,
      type: "text",
      plain_text: body.content,
      href: link,
      text: { ...body, link: link === null ? null : { url: link } },
      annotations: {
        bold: false,
        italic: false,
        code: false,
        underline: false,
        strikethrough: false,
        color: "default",
        ...property(value.annotations),
      },
    }
  })
const textRich = (content: string) => responseRich([{ type: "text", text: { content } }])
const physical = (
  blockId: string,
  parentId: string,
  type: string,
  body: unknown,
  revision = oldTime,
  parentType = "page_id",
) => ({
  object: "block",
  id: blockId,
  type,
  parent: { type: parentType, [parentType]: parentId },
  has_children: type === "table",
  in_trash: false,
  archived: false,
  last_edited_time: revision,
  [type]: body,
})
const inventory = (results: unknown[], next: string | null = null) => ({
  object: "list",
  results,
  has_more: next !== null,
  next_cursor: next,
})
const markdown = (page: string, body: string) => ({
  object: "page_markdown",
  id: page,
  markdown: body,
  truncated: false,
  unknown_block_ids: [],
})

/** Synthetic native journals are explicit test seeds, not live recovery evidence.
 * Every source object, original creation marker, registration and full row ACK
 * is constructed independently of the checkpoint helper. There is no live API.
 * Temporary lock roots are retained for inspection and never removed. */
async function fixture() {
  const json = new Map<string, unknown>(),
    objects = new Map<string, Uint8Array>(),
    raw = new Map<string, unknown>()
  const reads = new Map<string, number>(),
    requests: Array<{ path: string; method: string }> = []
  let transform: Transform | undefined,
    writes = 0,
    mutations = 0,
    failWrite = false
  const upstream = upstreamRepositoryFixture(),
    rootState = mkdtempSync(join(tmpdir(), "table-row-checkpoint-"))
  const transport: Notion["Service"] = {
    version: Effect.succeed("fixture"),
    credentialIdentity: Effect.succeed("table-fixture-credential"),
    request: (path, body, options) =>
      Effect.gen(function* () {
        const method = options?.method ?? (body === undefined ? "GET" : "POST")
        requests.push({ path, method })
        if (method !== "GET") {
          mutations++
          return yield* Effect.fail(
            fail("UNEXPECTED_WRITE", "The checkpoint attempted a remote mutation."),
          )
        }
        if (!raw.has(path))
          return yield* Effect.fail(fail("UNEXPECTED_GET", `Uncaptured fixture GET: ${path}`))
        const count = (reads.get(path) ?? 0) + 1
        reads.set(path, count)
        const value = structuredClone(raw.get(path))
        return transform ? transform(path, value, count) : value
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
        if (key === receiptKey && failWrite) {
          failWrite = false
          return yield* Effect.fail(fail("FIXTURE_STORE_FAILURE", "Receipt write stopped."))
        }
        if (key === receiptKey) writes++
        json.set(key, structuredClone(value))
      }),
    readBytes: (key) =>
      objects.has(key)
        ? Effect.succeed(objects.get(key)!.slice())
        : Effect.fail(fail("OBJECT_MISSING", "Missing frozen fixture source.")),
    writeBytes: () => Effect.die("Unexpected source write"),
    reserveCacheGeneration: () => Effect.die("Unexpected cache write"),
    listKeys: () => Effect.die("Unexpected key scan"),
    retireKeys: () => Effect.die("Unexpected retirement"),
    registerBindingWithBase: () => Effect.die("Unexpected binding"),
    advanceBaseAndReceipt: () => Effect.die("Unexpected base"),
    backup: () => Effect.die("Unexpected backup"),
    output: () => Effect.die("Unexpected output"),
  }
  const layer = Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(Store, store),
    Layer.succeed(Notion, transport),
    Layer.succeed(UpstreamState, upstream),
  )
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E>)
  raw.set("v1/users/me", { object: "user", id: "fixture-user" })
  const scope = await run(authScope)
  const ownerSource =
    "# Table\n\nA **kept** paragraph with `code` and [evidence](https://example.org/evidence).\n\n" +
    "| Item | Rule |\n| --- | --- |\n| Framework `theme` + variable | Use `root` + `colors` |\n| Other | Remains exact |\n"
  const sourceFiles = [
    {
      path: "SKILL.md",
      bytes: encoder.encode(
        "---\nname: table-sample\ndescription: Use to test table checkpoint recovery.\n---\n\n# Main\n\nOriginal main.\n",
      ),
    },
    {
      path: "references/a-earlier.md",
      bytes: encoder.encode("# Earlier\n\nAlready published words.\n"),
    },
    { path: "references/b-owner.md", bytes: encoder.encode(ownerSource) },
    { path: "references/c-later.md", bytes: encoder.encode("# Later\n\nNot written yet.\n") },
  ]
  const portable = {
    kind: "skill" as const,
    name: "table-sample",
    description: "Use to test table checkpoint recovery.",
    main: "SKILL.md",
    files: sourceFiles.map((file) => ({ path: file.path, sha256: bytesHash(file.bytes) })),
  }
  for (const file of sourceFiles) objects.set(`objects/${bytesHash(file.bytes)}`, file.bytes)
  const intended = digest([
    portable.kind,
    portable.name,
    portable.description,
    portable.main,
    [...sourceFiles]
      .sort((a, b) => (a.path < b.path ? -1 : 1))
      .map((file) => [file.path, file.bytes.length, bytesHash(file.bytes)]),
  ])
  const marker = {
    version: 2 as const,
    operation_id: operationId,
    intended_hash: intended,
    state: "writing" as const,
  }
  const children = [
    { id: earlier, path: "references/a-earlier.md", title: "a-earlier.md", index: 1 },
    { id: owner, path: "references/b-owner.md", title: "b-owner.md", index: 3 },
    { id: later, path: "references/c-later.md", title: "c-later.md", index: 5 },
  ]
  const proof = (path: string, index: number, isRoot = false): CreationProof => ({
    version: 1,
    operation_token: id(100 + index),
    operation_id: operationId,
    intent_index: index,
    scope,
    database_id: database,
    data_source_id: dataSource,
    role: isRoot ? "content_root" : "reference",
    path,
    parent_type: isRoot ? "data_source_id" : "page_id",
    parent_id: isRoot ? dataSource : root,
    intended_hash: intended,
    source_sha256: portable.files.find((file) => file.path === path)!.sha256,
  })
  const rootCreation = proof("SKILL.md", 0, true)
  const rootFields: Record<string, unknown> = {
    Name: { id: "title", type: "title", title: textRich(portable.name) },
    Description: {
      id: "description",
      type: "rich_text",
      rich_text: textRich(portable.description),
    },
    Kind: { id: "kind", type: "select", select: { name: "skill" } },
    Publication: {
      id: "publication",
      type: "rich_text",
      rich_text: textRich(JSON.stringify({ ...marker, creation: rootCreation })),
    },
    References: {
      id: "references",
      type: "rich_text",
      rich_text: responseRich(referenceLinks(children)!.rich_text),
    },
    Files: { id: "files", type: "files", files: [] },
    Members: { id: "members", type: "relation", relation: [], has_more: false },
  }
  const rootPage = {
    object: "page",
    id: root,
    properties: rootFields,
    parent: { type: "data_source_id", data_source_id: dataSource, database_id: database },
    is_archived: false,
    in_trash: false,
    last_edited_time: oldTime,
  }
  raw.set(rootPath, rootPage)
  raw.set(
    `${rootPath}/markdown`,
    markdown(
      root,
      children
        .map(
          (child) =>
            `<page url="https://www.notion.so/${child.id.replaceAll("-", "")}">${child.title}</page>`,
        )
        .join("\n"),
    ),
  )
  raw.set(
    `v1/blocks/${root}/children?page_size=100`,
    inventory(
      children.map((child) => physical(child.id, root, "child_page", { title: child.title })),
    ),
  )
  raw.set(`${rootPath}/properties/references?page_size=100`, {
    object: "list",
    results: (property(rootFields.References).rich_text as unknown[]).map((rich_text) => ({
      object: "property_item",
      id: "references",
      type: "rich_text",
      rich_text,
    })),
    has_more: false,
    next_cursor: null,
  })
  raw.set(`v1/databases/${database}`, {
    id: database,
    database_type: "skills",
    title: [],
    data_sources: [{ id: dataSource, name: "Skills" }],
  })
  raw.set(`v1/data_sources/${dataSource}`, {
    id: dataSource,
    parent: { type: "database_id", database_id: database },
    properties: rootFields,
  })
  const intents: Receipt["intents"] = [
    {
      path: "v1/pages",
      method: "POST",
      status: "completed",
      response: { id: root },
      body: {
        parent: { type: "data_source_id", data_source_id: dataSource },
        properties: {
          title: { title: [{ text: { content: portable.name } }] },
          description: { rich_text: [{ text: { content: portable.description } }] },
          Kind: { select: { name: "skill" } },
          Publication: {
            rich_text: [
              { text: { content: JSON.stringify({ ...marker, creation: rootCreation }) } },
            ],
          },
        },
      },
    },
  ]
  const bodyIntents: Receipt["intents"] = []
  let target = ""
  for (const [ordinal, child] of children.entries()) {
    const creation = proof(child.path, child.index),
      childMarker = creationMarker(creation)
    intents.push({
      path: "v1/pages",
      method: "POST",
      status: "completed",
      response: { id: child.id },
      body: {
        parent: { type: "page_id", page_id: root },
        properties: { title: { title: [{ text: { content: child.title } }] } },
        children: [creationMarkerBlock(creation)],
      },
    })
    intents.push({
      path: rootPath,
      method: "PATCH",
      status: "completed",
      response: { id: root },
      body: { properties: { References: referenceLinks(children.slice(0, ordinal + 1)) } },
    })
    const source = new TextDecoder().decode(
      sourceFiles.find((file) => file.path === child.path)!.bytes,
    )
    const complete = `${childMarker}\n\n${source}`
    const childBody = child.id === later ? childMarker : complete
    if (child.id !== later)
      bodyIntents.push({
        path: `v1/pages/${child.id}/markdown`,
        method: "PATCH",
        status: "completed",
        response: { id: child.id },
        body: {
          markdown_version: "v2",
          type: "replace_content",
          replace_content: { new_str: complete },
        },
      })
    if (child.id === owner) target = complete
    raw.set(`v1/pages/${child.id}`, {
      object: "page",
      id: child.id,
      parent: { type: "page_id", page_id: root },
      properties: { title: { id: "title", type: "title", title: textRich(child.title) } },
      is_archived: false,
      in_trash: false,
      last_edited_time: child.id === owner ? newTime : oldTime,
    })
    raw.set(`v1/pages/${child.id}/markdown`, markdown(child.id, childBody))
    const roots = Lexer.lex(childBody)
      .filter((token) => token.type !== "space")
      .map((token, index) => {
        if (token.type === "table")
          return physical(tableId, child.id, "table", {
            table_width: 2,
            has_column_header: true,
            has_row_header: false,
          })
        if (token.type !== "paragraph" && token.type !== "heading")
          throw new Error("Unsupported fixture root")
        if (!Array.isArray(token.tokens)) throw new Error("Incomplete fixture inline tokens")
        const type = token.type === "heading" ? `heading_${token.depth}` : "paragraph"
        return physical(id(200 + ordinal * 20 + index), child.id, type, {
          rich_text: responseRich(markdownRichText(token.tokens)),
          color: "default",
          ...(type.startsWith("heading_") ? { is_toggleable: false } : {}),
        })
      })
    raw.set(`v1/blocks/${child.id}/children?page_size=100`, inventory(roots))
  }
  intents.push(...bodyIntents)
  const tableToken = Lexer.lex(ownerSource).find(
    (token): token is Tokens.Table => token.type === "table",
  )!
  const rows = [tableToken.header, ...tableToken.rows].map((cells, index) =>
    physical(
      index === 1 ? rowId : id(500 + index),
      tableId,
      "table_row",
      { cells: markdownTableCells(cells).map(responseRich) },
      index === 1 ? newTime : oldTime,
      "block_id",
    ),
  )
  raw.set(tableInventory, inventory(rows))
  raw.set(blockPath, rows[1])
  raw.set(
    tablePath,
    property(raw.get(ownerInventory)).results instanceof Array
      ? (property(raw.get(ownerInventory)).results as unknown[]).find(
          (item) => property(item).id === tableId,
        )
      : undefined,
  )
  const guards = Object.fromEntries(
    [...raw]
      .filter(
        ([path]) =>
          !path.startsWith("v1/databases/") &&
          !path.startsWith("v1/data_sources/") &&
          path !== "v1/users/me",
      )
      .map(([path, value]) => [path, observation(path, value)]),
  )
  guards[ownerPath] = { ...property(metadata(raw.get(ownerPath))), last_edited_time: oldTime }
  guards[bodyPath] = target.replaceAll(" + ", "  • ")
  const priorRow = structuredClone(rows[1]!)
  priorRow.last_edited_time = oldTime
  for (const cell of (priorRow.table_row as { cells: Array<Array<Record<string, unknown>>> }).cells)
    for (const span of cell) {
      const body = property(span.text)
      if (typeof body.content === "string") {
        body.content = body.content.replaceAll(" + ", "  • ")
        span.plain_text = body.content
      }
    }
  guards[blockPath] = blockObservation(priorRow)
  intents.push({
    path: blockPath,
    method: "PATCH",
    status: "completed",
    response: { id: rowId },
    guards: structuredClone(guards),
    body: { table_row: { cells: markdownTableCells(tableToken.rows[0]!) } },
  })
  const receipt = decode(PublicationReceiptSchema, {
    format: 1,
    operation_id: operationId,
    operation: "create",
    scope,
    database_id: database,
    data_source_id: dataSource,
    page_id: root,
    state: "failed",
    conflict: true,
    portable,
    guards,
    intents,
    stages: ["create_page", "references", "body:references/a-earlier.md"],
    failure: {
      code: "WRITE_PARTIAL",
      message: "Fixture GET failed after true row ACK.",
      details: {
        stage: "body:references/b-owner.md",
        cause_code: "NOTION_REQUEST_FAILED",
        cause_details: { path: blockPath },
      },
    },
  })
  json.set(receiptKey, receipt)
  json.set(integrityKey, { version: 1, operation_id: operationId, intended_hash: intended, marker })
  reads.clear()
  requests.length = 0
  return {
    run,
    store,
    raw,
    json,
    objects,
    requests,
    receipt: () => decode(PublicationReceiptSchema, structuredClone(json.get(receiptKey))),
    proof: () =>
      run(
        proveCompletedTableRowCheckpoint(
          decode(PublicationReceiptSchema, structuredClone(json.get(receiptKey))),
          transport,
        ).pipe(Effect.result),
      ),
    transform: (value: Transform | undefined) => {
      transform = value
    },
    changeReceipt: (change: (value: Receipt) => void) => {
      const value = decode(PublicationReceiptSchema, structuredClone(json.get(receiptKey)))
      change(value)
      json.set(receiptKey, value)
    },
    mutations: () => mutations,
    writes: () => writes,
    failNextWrite: () => {
      failWrite = true
    },
    resetReads: () => {
      reads.clear()
      requests.length = 0
    },
  }
}

test("the original terminal row ACK advances exactly three checkpoints and preserves every original effect", async () => {
  const f = await fixture(),
    before = f.receipt(),
    source = canonical([...f.objects])
  const result = await f.run(reconcilePublication(operationId))
  expect(result).toMatchObject({
    outcome: "needs_safe_resume",
    verified: false,
    unresolved: false,
    state: "running",
  })
  expect(result.next.argv).toEqual(["ntn-skills", "operation", "resume", operationId])
  const after = f.receipt(),
    history = after.conflict_history!.at(-1)!,
    certificate = history.completed_table_row_checkpoint!
  expect(f.requests.every((request) => request.method === "GET")).toBe(true)
  expect(f.mutations()).toBe(0)
  expect(f.writes()).toBe(1)
  expect(after.conflict).toBeUndefined()
  expect(after.owner).toBeUndefined()
  expect(after.result).toBeUndefined()
  expect(canonical(after.intents)).toBe(canonical(before.intents))
  expect(after.stages).toEqual(before.stages)
  expect(after.failure).toEqual(before.failure)
  expect(history.failure).toEqual(before.failure)
  expect(after.portable).toEqual(before.portable)
  expect(canonical([...f.objects])).toBe(source)
  expect(
    Object.keys(before.guards)
      .filter((path) => canonical(before.guards[path]) !== canonical(after.guards[path]))
      .sort(),
  ).toEqual([blockPath, ownerPath, bodyPath].sort())
  expect(certificate).toMatchObject({
    page_id: root,
    owner_page_id: owner,
    block_id: rowId,
    table_id: tableId,
    intent_index: before.intents.length - 1,
    acknowledged_body_intent_index: before.intents.length - 2,
    table_ordinal: 0,
    row_ordinal: 1,
    receipt_sha256: digest(before),
    journal_sha256: digest(before.intents),
    guards_sha256: digest(before.guards),
  })
  expect(certificate.checkpoints.map((item) => item.path).sort()).toEqual(
    [blockPath, ownerPath, bodyPath].sort(),
  )
  expect(
    certificate.metadata_brackets.every((item) => item.before_sha256 === item.after_sha256),
  ).toBe(true)
  expect((await f.run(f.store.integrity.inspect(operationId)))?.marker.state).toBe("writing")
})

for (const variant of [
  "source_main",
  "source_other",
  "ack_identity",
  "synthesized_ack",
  "payload_code",
  "body_source",
  "row_text",
  "row_format",
  "other_row",
  "owner_body",
  "owner_title",
  "other_reference",
  "extra_root",
  "root_annotation",
  "missing_root",
  "incomplete_inventory",
  "wrong_parent",
  "root_marker",
] as const) {
  test(`checkpoint refusal preserves the old fence for ${variant}`, async () => {
    const f = await fixture()
    if (variant === "source_main" || variant === "source_other") {
      const file = f
        .receipt()
        .portable.files.find((file) =>
          variant === "source_main" ? file.path === "SKILL.md" : file.path.endsWith("c-later.md"),
        )!
      f.objects.set(`objects/${file.sha256}`, encoder.encode("Changed frozen bytes"))
    } else if (
      variant === "ack_identity" ||
      variant === "synthesized_ack" ||
      variant === "payload_code" ||
      variant === "body_source"
    )
      f.changeReceipt((receipt) => {
        if (variant === "ack_identity") receipt.intents.at(-1)!.response = { id: id(999) }
        if (variant === "synthesized_ack")
          receipt.intents.at(-1)!.response = {
            id: rowId,
            prior_status: "unknown",
            recovery: "observed_applied",
          }
        if (variant === "payload_code") {
          const cells = property(property(receipt.intents.at(-1)!.body).table_row)
            .cells as unknown[][]
          property(cells[0]![1]).annotations = { code: false }
        }
        if (variant === "body_source")
          property(property(receipt.intents.at(-2)!.body).replace_content).new_str = String(
            property(property(receipt.intents.at(-2)!.body).replace_content).new_str,
          ).replace("A **kept**", "A **changed**")
      })
    else
      f.transform((path, raw) => {
        const value = property(raw)
        if (variant === "row_text" && path === blockPath)
          property((property(value.table_row).cells as unknown[][])[0]![0]).text = {
            content: "External edit ",
          }
        if (variant === "row_format" && path === tableInventory) {
          const row = property((value.results as unknown[])[1])
          property((property(row.table_row).cells as unknown[][])[0]![1]).annotations = {
            code: false,
          }
        }
        if (variant === "other_row" && path === tableInventory) {
          const row = property((value.results as unknown[])[2])
          property((property(row.table_row).cells as unknown[][])[0]![0]).text = {
            content: "Changed sibling",
          }
        }
        if (variant === "owner_body" && path === bodyPath)
          value.markdown = String(value.markdown).replace("A **kept**", "A **external**")
        if (variant === "owner_title" && path === ownerPath)
          property(property(value.properties).title).title = textRich("external.md")
        if (variant === "other_reference" && path === `v1/pages/${earlier}/markdown`)
          value.markdown = String(value.markdown) + "\nExternal edit\n"
        if (variant === "root_marker" && path === rootPath)
          property(property(value.properties).Publication).rich_text = textRich("{}")
        if (path === ownerInventory) {
          const roots = value.results as Array<Record<string, unknown>>
          if (variant === "extra_root")
            roots.push(physical(id(999), owner, "paragraph", { rich_text: [], color: "default" }))
          if (variant === "root_annotation") {
            const spans = property(roots[2]!.paragraph).rich_text as unknown[]
            property(spans[1]).annotations = {
              ...property(property(spans[1]).annotations),
              underline: true,
            }
          }
          if (variant === "missing_root") roots.splice(2, 1)
          if (variant === "incomplete_inventory") {
            value.has_more = true
            value.next_cursor = null
          }
          if (variant === "wrong_parent") roots[0]!.parent = { type: "page_id", page_id: earlier }
        }
        return value
      })
    const before = f.receipt(),
      result = await f.proof()
    expect(result._tag).toBe("Failure")
    expect(f.receipt()).toEqual(before)
    expect(f.writes()).toBe(0)
    expect(f.mutations()).toBe(0)
  })
}

test("an equal edit timestamp does not hide a body change during the final re-read", async () => {
  const f = await fixture(),
    before = f.receipt()
  f.transform((path, raw, count) =>
    path === bodyPath && count > 1
      ? { ...property(raw), markdown: String(property(raw).markdown) + "\nConcurrent edit\n" }
      : raw,
  )
  expect((await f.proof())._tag).toBe("Failure")
  expect(f.receipt()).toEqual(before)
  expect(f.writes()).toBe(0)
  expect(f.mutations()).toBe(0)
})

test("a durable receipt change cannot consume the previously sampled table proof", async () => {
  const f = await fixture()
  f.transform((path, raw) => {
    if (path === tableInventory)
      f.changeReceipt((receipt) => {
        receipt.stages.push("concurrent-local-change")
      })
    return raw
  })
  expect((await f.proof())._tag).toBe("Failure")
  expect(f.writes()).toBe(0)
  expect(f.mutations()).toBe(0)
  expect(f.receipt().conflict).toBe(true)
})

test("a page revision change across the physical read bracket preserves the original fence", async () => {
  const f = await fixture(),
    before = f.receipt()
  f.transform((path, raw, count) =>
    path === ownerPath && count > 1
      ? { ...property(raw), last_edited_time: "2026-10-20T15:40:00.000Z" }
      : raw,
  )
  expect((await f.proof())._tag).toBe("Failure")
  expect(f.receipt()).toEqual(before)
  expect(f.writes()).toBe(0)
  expect(f.mutations()).toBe(0)
})

test("a failed durable checkpoint write retains the original fence and all old guards", async () => {
  const f = await fixture(),
    before = f.receipt()
  f.failNextWrite()
  expect((await f.run(reconcilePublication(operationId).pipe(Effect.result)))._tag).toBe("Failure")
  expect(f.receipt()).toEqual(before)
  expect(f.writes()).toBe(0)
  expect(f.mutations()).toBe(0)
})

test("the audit certificate cannot be reused to adopt a subsequent edit or roll guards back", async () => {
  const f = await fixture()
  await f.run(reconcilePublication(operationId))
  const accepted = f.receipt()
  expect(completedTableRowCheckpointCandidate(accepted)).toBeUndefined()
  f.changeReceipt((receipt) => {
    receipt.conflict = true
    receipt.state = "failed"
  })
  f.transform((path, raw) =>
    path === bodyPath
      ? { ...property(raw), markdown: String(property(raw).markdown) + "\nLater change\n" }
      : raw,
  )
  const before = f.receipt()
  expect((await f.proof())._tag).toBe("Failure")
  expect(f.receipt().guards).toEqual(accepted.guards)
  expect(f.receipt()).toEqual(before)
  expect(f.writes()).toBe(1)
  expect(f.mutations()).toBe(0)
})
