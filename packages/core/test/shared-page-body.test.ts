import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Notion } from "../src/notion.ts"
import { observeSharedBody } from "../src/shared-page-body.ts"
import { createHash } from "node:crypto"
import { nativeObservedObjectIdentity } from "../src/shared-native-body-completion.ts"

const page = "11111111-1111-4111-8111-111111111111"
function run(response: unknown, blocks?: (path: string) => unknown) {
  const requests: string[] = []
  const api = Layer.succeed(Notion, {
    version: Effect.succeed("controlled"),
    credentialIdentity: Effect.succeed("controlled"),
    request: (path: string) => {
      requests.push(path)
      return Effect.succeed(path.includes("/markdown?") ? response : blocks?.(path))
    },
  })
  return {
    requests,
    result: Effect.runPromise(
      observeSharedBody(page).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, api))),
    ),
  }
}

const aliasId = "22222222-2222-4222-8222-222222222222"
const targetId = "33333333-3333-4333-8333-333333333333"
const paragraphId = "44444444-4444-4444-8444-444444444444"
const compact = (id: string) => id.replaceAll("-", "")
const aliasHref = `https://app.notion.com/p/${compact(page)}#${compact(aliasId)}`
const aliasMarkdown = `Before\r\n\r\n<unknown url="${aliasHref}" alt="alias" />`
const paragraphBlock = {
  object: "block",
  id: paragraphId,
  parent: { type: "page_id", page_id: page },
  type: "paragraph",
  has_children: false,
  paragraph: { rich_text: [{ type: "text", text: { content: "Before" }, plain_text: "Before" }] },
}
const aliasBlock = {
  object: "block",
  id: aliasId,
  parent: { type: "page_id", page_id: page },
  type: "link_to_page",
  has_children: false,
  link_to_page: { type: "page_id", page_id: targetId },
}
const aliasResponse = {
  id: page,
  markdown: aliasMarkdown,
  truncated: true,
  unknown_block_ids: [aliasId],
}
const complete = (results: readonly unknown[]) => ({
  object: "list",
  results,
  has_more: false,
  next_cursor: null,
})

test("an actual Link to page completes only its exact unknown placeholder after full physical pagination", async () => {
  const observed = run(aliasResponse, (path) =>
    path.includes("start_cursor=")
      ? complete([aliasBlock])
      : { object: "list", results: [paragraphBlock], has_more: true, next_cursor: "next" },
  )
  const result = await observed.result
  expect(observed.requests).toEqual([
    `v1/pages/${page}/markdown?markdown_version=v2`,
    `v1/blocks/${page}/children?page_size=100`,
    `v1/blocks/${page}/children?page_size=100&start_cursor=next`,
  ])
  const raw = aliasMarkdown.replace(/\r\n/g, "\n")
  expect(result.markdown).toBe(raw)
  expect(result.fingerprint.sha256).toBe(createHash("sha256").update(raw).digest("hex"))
  expect(result.native_body_completion).toMatchObject({
    page_id: page,
    body_sha256: result.fingerprint.sha256,
    truncated: true,
    unknown_block_ids: [aliasId],
    inventory: [{ id: paragraphId }, { id: aliasId, target_page_id: targetId }],
  })
})

for (const [name, response, inventory] of [
  ["unknown bookmark", aliasResponse, [paragraphBlock, { ...aliasBlock, type: "bookmark" }]],
  [
    "alias with unread children",
    aliasResponse,
    [paragraphBlock, { ...aliasBlock, has_children: true }],
  ],
  [
    "wrong owner",
    aliasResponse,
    [paragraphBlock, { ...aliasBlock, parent: { type: "page_id", page_id: targetId } }],
  ],
  ["missing actual alias", aliasResponse, [paragraphBlock]],
  [
    "other unknown mixed in",
    { ...aliasResponse, unknown_block_ids: [aliasId, paragraphId] },
    [paragraphBlock, aliasBlock],
  ],
  [
    "unknown placeholder absent",
    { ...aliasResponse, markdown: "Before" },
    [paragraphBlock, aliasBlock],
  ],
  [
    "unreported unknown placeholder",
    {
      ...aliasResponse,
      markdown: aliasMarkdown + '\n<unknown url="https://example.com" alt="private" />',
    },
    [paragraphBlock, aliasBlock],
  ],
  ["duplicate alias identity", aliasResponse, [paragraphBlock, aliasBlock, aliasBlock]],
  ["inaccessible block", aliasResponse, [paragraphBlock, { ...aliasBlock, in_trash: true }]],
  [
    "unread synced subtree",
    aliasResponse,
    [{ ...paragraphBlock, type: "synced_block", has_children: true }, aliasBlock],
  ],
  [
    "real truncation with no explained nodes",
    { ...aliasResponse, unknown_block_ids: [] },
    [paragraphBlock, aliasBlock],
  ],
] as const)
  test(`native alias completion rejects ${name}`, async () => {
    await expect(run(response, () => complete(inventory)).result).rejects.toThrow()
  })

test("a broken terminal cursor never establishes an alias completion proof", async () => {
  await expect(
    run(aliasResponse, () => ({
      ...complete([paragraphBlock, aliasBlock]),
      next_cursor: "unread",
    })).result,
  ).rejects.toThrow()
})

test("identical raw alias bytes with a changed target retain different proof identities", async () => {
  const first = await run(aliasResponse, () => complete([paragraphBlock, aliasBlock])).result
  const second = await run(aliasResponse, () =>
    complete([
      paragraphBlock,
      { ...aliasBlock, link_to_page: { type: "page_id", page_id: paragraphId } },
    ]),
  ).result
  expect(second.fingerprint).toEqual(first.fingerprint)
  const runIdentity = (body: typeof first) =>
    Effect.runPromise(
      nativeObservedObjectIdentity(body.fingerprint.sha256, body.native_body_completion).pipe(
        Effect.provide(NodeServices.layer),
      ),
    )
  expect((await runIdentity(first)).object_id).not.toBe((await runIdentity(second)).object_id)
})

test("one fixed-version Markdown request establishes the actual projected fingerprint", async () => {
  const response = {
    id: page,
    markdown: "# Steps\r\n\r\nKeep [link](https://example.com).\n",
    truncated: false,
    unknown_block_ids: [],
  }
  const observed = run(response)
  const result = await observed.result
  expect(observed.requests).toEqual([`v1/pages/${page}/markdown?markdown_version=v2`])
  expect(result.markdown).toBe("# Steps\n\nKeep [link](https://example.com).\n")
  expect(result.fingerprint.sha256).toMatch(/^[a-f0-9]{64}$/)
})

for (const invalid of [
  { truncated: true, unknown_block_ids: [] },
  { truncated: false, unknown_block_ids: ["hidden"] },
  { truncated: false, unknown_block_ids: [], markdown: '<unknown url="hidden"/>' },
  { truncated: false, unknown_block_ids: [], id: "22222222-2222-4222-8222-222222222222" },
])
  test(`incomplete or foreign body is rejected: ${JSON.stringify(invalid)}`, async () => {
    await expect(run({ id: page, markdown: "body", ...invalid }).result).rejects.toThrow()
  })
