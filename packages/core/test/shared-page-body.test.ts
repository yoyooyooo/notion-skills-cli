import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Notion } from "../src/notion.ts"
import { observeSharedBody } from "../src/shared-page-body.ts"

const page = "11111111-1111-4111-8111-111111111111"
function run(response: unknown) {
  const requests: string[] = []
  const api = Layer.succeed(Notion, {
    version: Effect.succeed("controlled"),
    credentialIdentity: Effect.succeed("controlled"),
    request: (path: string) => {
      requests.push(path)
      return Effect.succeed(response)
    },
  })
  return {
    requests,
    result: Effect.runPromise(
      observeSharedBody(page).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, api))),
    ),
  }
}

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
