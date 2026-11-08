import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Effect, Layer } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { fail, type SkillsError } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import type { SharedLibrary } from "../src/shared-library.ts"
import { observeSharedFile } from "../src/shared-file-observer.ts"
import type { FileEvent } from "../src/shared-file-state.ts"

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
const pageId = id(1)
const skillPageId = id(2)
const fileId = "readonly-observer-file"
const library: SharedLibrary = {
  version: 1,
  library_id: "readonly-observer",
  operation_id: "readonly-observer-init",
  parent_page_id: id(3),
  skills: { database_id: id(4), data_source_id: id(5), property_ids: {} },
  files: { database_id: id(6), data_source_id: id(7), property_ids: {} },
  records: {
    database_id: id(8),
    data_source_id: id(9),
    property_ids: {
      Name: "title",
      "Record ID": "record",
      Kind: "kind",
      "Entity ID": "entity",
      Hash: "hash",
      Payload: "payload",
      Skill: "skill",
    },
  },
}
const baseline = "upstream\n"
const projection: FileEvent = {
  event_id: "readonly-projection",
  file_id: fileId,
  parents: [],
  kind: "projected",
  source_revision: "git-c1",
  projection: {
    normalization_version: 1,
    sha256: createHash("sha256").update(baseline).digest("hex"),
  },
}

function fixture(markdown: string) {
  const calls: Array<{ path: string; method: string }> = []
  const service: Notion["Service"] = {
    version: Effect.succeed("controlled"),
    credentialIdentity: Effect.succeed("readonly-observer"),
    request: (path, _body, options) =>
      Effect.suspend((): Effect.Effect<unknown, SkillsError> => {
        const method = options?.method ?? (_body === undefined ? "GET" : "POST")
        calls.push({ path, method })
        if (path === `v1/pages/${pageId}/markdown?markdown_version=v2` && method === "GET")
          return Effect.succeed({ id: pageId, markdown, truncated: false, unknown_block_ids: [] })
        if (path === `v1/data_sources/${library.records.data_source_id}/query`)
          return Effect.succeed({ object: "list", results: [], has_more: false, next_cursor: null })
        return Effect.fail(
          fail("UNEXPECTED_FIXTURE_REQUEST", "An observation attempted another operation."),
        )
      }),
  }
  return {
    calls,
    observe: () =>
      Effect.runPromise(
        observeSharedFile({
          library,
          skillPageId,
          fileId,
          pageId,
          events: [projection],
          bodyWrites: [],
          plans: [],
          readOnly: true,
        }).pipe(
          Effect.result,
          Effect.provide(Layer.mergeAll(NodeServices.layer, Layer.succeed(Notion, service))),
        ),
      ),
  }
}

test("audit-style observation reports an unconfirmed edit without retaining or adopting it", async () => {
  const api = fixture("human edit after projection\n")
  const result = await api.observe()
  expect(result._tag).toBe("Failure")
  if (result._tag !== "Failure") throw new Error("Expected an observation-required result")
  expect(result.failure.code).toBe("SHARED_OBSERVATION_REQUIRED")
  expect(api.calls).toEqual([
    { path: `v1/pages/${pageId}/markdown?markdown_version=v2`, method: "GET" },
  ])
})

test("read-only observation returns an unchanged baseline without semantic writes", async () => {
  const api = fixture(baseline)
  const result = await api.observe()
  expect(result._tag).toBe("Success")
  if (result._tag !== "Success") throw new Error("Expected the existing projection")
  expect(result.success.changed).toBe(false)
  expect(result.success.state.ownership.kind).toBe("following")
  expect(api.calls).toEqual([
    { path: `v1/pages/${pageId}/markdown?markdown_version=v2`, method: "GET" },
  ])
})
