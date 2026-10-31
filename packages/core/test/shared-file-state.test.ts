import { expect, test } from "bun:test"
import {
  decideObservedBody,
  normalizeObservedBody,
  requireSafeBodyReplacement,
  resolveFileState,
  type FileEvent,
} from "../src/shared-file-state.ts"

const a = "a".repeat(64),
  b = "b".repeat(64)
const base: FileEvent = {
  event_id: "base",
  file_id: "file",
  parents: [],
  kind: "projected",
  source_revision: "git:fixed",
  projection: { normalization_version: 1, sha256: a },
}
const adopt: FileEvent = {
  event_id: "adopt",
  file_id: "file",
  parents: ["base"],
  kind: "adopted",
  content: { object_id: "object", sha256: b, bytes: 7 },
}

test("shared events rebuild persistent whole-file ownership without any local state", () => {
  const state = resolveFileState("file", JSON.parse(JSON.stringify([adopt, base])))
  expect(state.ownership.kind).toBe("custom")
  expect(decideObservedBody(state.ownership, { normalization_version: 1, sha256: a })).toEqual({
    kind: "adopt",
    previous: "custom",
  })
  expect(decideObservedBody(state.ownership, { normalization_version: 1, sha256: b })).toEqual({
    kind: "unchanged",
  })
})

test("metadata-only observation cannot take ownership and projected source changes cannot release it", () => {
  const state = resolveFileState("file", [base])
  expect(decideObservedBody(state.ownership, base.projection)).toEqual({ kind: "unchanged" })
  expect(() =>
    resolveFileState("file", [base, adopt, { ...base, event_id: "bad", parents: ["adopt"] }]),
  ).toThrow("cannot release")
})

test("restoring follow retains custom bytes first and takes an explicit new event", () => {
  const restore: FileEvent = {
    event_id: "restore",
    file_id: "file",
    parents: ["adopt"],
    kind: "following_restored",
    source_revision: "git:next",
    projection: base.projection,
    retained: adopt.content,
  }
  expect(resolveFileState("file", [restore, adopt, base]).ownership.kind).toBe("following")
  expect(() =>
    resolveFileState("file", [
      base,
      adopt,
      { ...restore, retained: { ...adopt.content, sha256: a } },
    ]),
  ).toThrow("exact custom")
})

test("concurrent incompatible heads preserve both candidates and refuse a winner", () => {
  const peer: FileEvent = { ...adopt, event_id: "peer", content: { ...adopt.content, sha256: a } }
  expect(() => resolveFileState("file", [base, adopt, peer])).toThrow("Concurrent file changes")
  expect(resolveFileState("file", [base, adopt, { ...adopt, event_id: "same" }]).heads).toEqual([
    "adopt",
    "same",
  ])
})

test("missing parents, cycles, identity reuse and missing baselines cannot become success", () => {
  expect(() => resolveFileState("file", [])).toThrow("No shared file baseline")
  expect(() => resolveFileState("file", [adopt])).toThrow("parent is unavailable")
  expect(() => resolveFileState("file", [base, { ...base, source_revision: "other" }])).toThrow(
    "different immutable payloads",
  )
  expect(() => resolveFileState("file", [{ ...base, parents: ["adopt"] }, adopt])).toThrow("cycle")
})

test("normalization preserves instructions, code, links and meaningful whitespace", () => {
  expect(normalizeObservedBody("a\r\nb\n")).toBe("a\nb\n")
  expect(normalizeObservedBody("[x](https://a)\n```sh\necho '  x'\n```\n")).not.toBe(
    normalizeObservedBody("[x](https://b)\n```sh\necho ' x'\n```\n"),
  )
  expect(() => normalizeObservedBody('<unknown url="hidden"/>')).toThrow("unavailable body")
})

test("a read-then-write timestamp check does not authorize replacing an editable body", () => {
  expect(() =>
    requireSafeBodyReplacement({
      existing_editable_page: true,
      operation_id: "op",
      retained_candidate_id: "candidate",
    }),
  ).toThrow("cannot conditionally replace")
  expect(() =>
    requireSafeBodyReplacement({
      existing_editable_page: false,
      operation_id: "op",
      retained_candidate_id: "candidate",
    }),
  ).not.toThrow()
})
