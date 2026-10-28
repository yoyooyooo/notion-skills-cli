import { expect, test } from "bun:test"
import { Effect } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import { integrityRepositoryFixture, upstreamRepositoryFixture } from "./fixtures.ts"
import { retryEditableMetadata } from "../src/markdown-files-metadata-retry.ts"
import type { Receipt } from "../src/publication-model.ts"
import { Notion } from "../src/notion.ts"
import { Store } from "../src/store.ts"
import { fail } from "../src/model.ts"
import { publicationProperties } from "../src/publication-integrity.ts"
import { observation } from "../src/publication-observation.ts"

const owner = {
  subscription_id: "source",
  member_key: "member",
  mode: "tracked" as const,
  published_hash: "a".repeat(64),
  revision: "revision",
}
function receipt(): Receipt {
  return {
    format: 1,
    operation_id: "p_retry",
    operation: "create",
    state: "unknown",
    page_id: "page",
    context: { markdown_files: true, ownership: owner },
    portable: {
      kind: "skill",
      name: "Example",
      description: "Example instructions",
      main: "SKILL.md",
      files: [],
    },
    stages: [],
    guards: {},
    intents: [
      { path: "v1/pages", method: "POST", status: "completed" },
      {
        path: "v1/pages/page",
        method: "PATCH",
        status: "unknown",
        body: { properties: { arbitrary: { checkbox: true } } },
      },
    ],
  }
}
const api: Notion["Service"] = {
  version: Effect.succeed("fixture"),
  credentialIdentity: Effect.succeed("fixture"),
  request: (path) =>
    Effect.fail(
      fail("UNEXPECTED_REQUEST", "Rejected requests must not access remote content", { path }),
    ),
}
const unexpected = () =>
  Effect.fail(fail("UNEXPECTED_DEPENDENCY", "Refused input accessed an execution dependency"))
const store: Store["Service"] = {
  root: "/fixture",
  configRoot: "/fixture",
  cacheRoot: "/fixture",
  upstream: upstreamRepositoryFixture(),
  integrity: integrityRepositoryFixture(),
  reserveCacheGeneration: unexpected,
  listKeys: unexpected,
  retireKeys: unexpected,
  readJson: unexpected,
  writeJson: unexpected,
  readBytes: unexpected,
  writeBytes: unexpected,
  registerBindingWithBase: unexpected,
  advanceBaseAndReceipt: unexpected,
  backup: unexpected,
  output: unexpected,
}
for (const kind of [
  "append",
  "create",
  "foreign-page",
  "extra-body",
  "prior-unknown",
  "conflict",
] as const) {
  test(`explicit metadata retry refuses ${kind} before remote effects and leaves unknown history intact`, async () => {
    const r = receipt(),
      last = r.intents.at(-1)!
    if (kind === "append")
      r.intents[r.intents.length - 1] = { ...last, path: "v1/blocks/page/children" }
    if (kind === "create")
      r.intents[r.intents.length - 1] = { ...last, path: "v1/pages", method: "POST" }
    if (kind === "foreign-page")
      r.intents[r.intents.length - 1] = { ...last, path: "v1/pages/foreign" }
    if (kind === "extra-body")
      r.intents[r.intents.length - 1] = { ...last, body: { properties: {}, in_trash: true } }
    if (kind === "prior-unknown") r.intents[0]!.status = "unknown"
    if (kind === "conflict") r.conflict = true
    const before = JSON.stringify(r)
    const result = await Effect.runPromise(
      retryEditableMetadata(r, api).pipe(
        Effect.provideService(Store, store),
        Effect.provide(NodeServices.layer),
        Effect.provide(NodeHttpClient.layerFetch),
        Effect.result,
      ),
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure.code).toBe("PUBLICATION_UNRESOLVED")
    expect(JSON.stringify(r)).toBe(before)
  })
}

test("metadata retry cannot turn an arbitrary property patch into publication ownership", async () => {
  const r = receipt(),
    before = JSON.stringify(r)
  const result = await Effect.runPromise(
    retryEditableMetadata(r, api).pipe(
      Effect.provideService(Store, store),
      Effect.provide(NodeServices.layer),
      Effect.provide(NodeHttpClient.layerFetch),
      Effect.result,
    ),
  )
  expect(result._tag).toBe("Failure")
  if (result._tag === "Failure") expect(result.failure.code).toBe("PUBLICATION_UNRESOLVED")
  expect(JSON.stringify(r)).toBe(before)
})

test("a changed page property cannot be overwritten by explicit metadata retry", async () => {
  const r = receipt(),
    marker = {
      version: 2 as const,
      state: "writing" as const,
      operation_id: r.operation_id,
      intended_hash: "b".repeat(64),
    }
  const rich = (content: string) => ({ rich_text: [{ type: "text", text: { content } }] })
  r.intents[r.intents.length - 1] = {
    ...r.intents.at(-1)!,
    body: {
      properties: {
        Upstream: { relation: [{ id: owner.subscription_id }] },
        "Sync Mode": { select: { name: owner.mode } },
        "Upstream Key": rich(owner.member_key),
        "Upstream Revision": rich(owner.revision),
        "Published Hash": rich(owner.published_hash),
        "Fork Baseline": rich(""),
      },
    },
  }
  const root = {
    id: "page",
    parent: { data_source_id: "table" },
    last_edited_time: "original",
    properties: {
      Publication: { type: "rich_text", ...publicationProperties(marker).Publication },
      Description: { type: "rich_text", ...rich("Original description") },
    },
  }
  r.guards["v1/pages/page"] = observation("v1/pages/page", root)
  r.guards["v1/pages/page/markdown"] = "original body"
  const integrity = integrityRepositoryFixture()
  await Effect.runPromise(
    integrity.prepare({
      version: 1,
      operation_id: r.operation_id,
      intended_hash: marker.intended_hash,
      marker,
      page_id: "page",
    }),
  )
  const changedApi: Notion["Service"] = {
    ...api,
    request: () =>
      Effect.succeed({
        ...root,
        properties: {
          ...root.properties,
          Description: { type: "rich_text", ...rich("External change") },
        },
      }),
  }
  const before = JSON.stringify(r)
  const result = await Effect.runPromise(
    retryEditableMetadata(r, changedApi).pipe(
      Effect.provideService(Store, { ...store, integrity }),
      Effect.provide(NodeServices.layer),
      Effect.provide(NodeHttpClient.layerFetch),
      Effect.result,
    ),
  )
  expect(result._tag).toBe("Failure")
  if (result._tag === "Failure") expect(result.failure.code).toBe("WRITE_CONFLICT")
  expect(JSON.stringify(r)).toBe(before)
})
