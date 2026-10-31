import { expect, test } from "bun:test"
import { Schema } from "effect"
import { decode, listSchema } from "../src/model.ts"

test("has_more false does not certify a server-truncated data-source query", () => {
  expect(() =>
    decode(listSchema(Schema.Unknown), {
      results: [{ id: "one" }],
      has_more: false,
      next_cursor: null,
      request_status: { type: "incomplete", incomplete_reason: "query_result_limit_reached" },
    }),
  ).toThrow()
})

test("an incomplete reason is never silently discarded by metadata decoding", () => {
  expect(() =>
    decode(listSchema(Schema.Unknown), {
      results: [],
      has_more: false,
      next_cursor: null,
      request_status: { type: "complete", incomplete_reason: "permission_limited" },
    }),
  ).toThrow()
})

test("a complete page without the optional status remains compatible", () => {
  expect(
    decode(listSchema(Schema.Unknown), { results: [], has_more: false, next_cursor: null }).results,
  ).toEqual([])
})
