import { test } from "node:test"
import assert from "node:assert/strict"
import { contentAdoptionPropertyComparison as compare } from "../src/publication-content-adoption-metadata.ts"

const before = "2026-10-21T00:00:00.000Z",
  after = "2026-10-21T00:01:00.000Z"
const field = (revision) => ({
  id: "updated-id",
  type: "last_edited_time",
  last_edited_time: revision,
  label: "keep exact",
})

test("automatic values move only with their own exact root revision", () => {
  assert.deepEqual(compare(field(before), before), compare(field(after), after))
  assert.deepEqual(compare(field(after), after), {
    mode: "root_edit_time",
    value: { id: "updated-id", type: "last_edited_time", label: "keep exact" },
  })
})
test("a stale or independently changed property stays exact", () => {
  for (const revision of [before, "foreign revision", null, undefined, 0, { time: after }]) {
    const value = { ...field(after), last_edited_time: revision }
    assert.deepEqual(compare(value, after), { mode: "exact", value })
    assert.notDeepEqual(compare(value, after), compare(field(before), before))
  }
})
test("absent, empty and non-string root revisions cannot authorize a projection", () => {
  for (const revision of ["", undefined, null, 0, {}, []]) {
    const value = field(revision)
    assert.deepEqual(compare(value, revision), { mode: "exact", value })
  }
})
test("the property ID, type and every extra key remain exact", () => {
  const expected = compare(field(before), before)
  for (const change of [
    { id: "different-id" },
    { label: "changed" },
    { extra: "added" },
    { last_edited_by: "changed" },
  ])
    assert.notDeepEqual(compare({ ...field(after), ...change }, after), expected)
  for (const id of ["", " ", undefined, null, 1]) {
    const value = { ...field(after), id }
    assert.deepEqual(compare(value, after), { mode: "exact", value })
  }
})
test("last_edited_by, created_time, custom dates and malformed fields stay exact", () => {
  for (const type of ["last_edited_by", "created_time", "date", "rich_text", undefined]) {
    const value = { ...field(after), type }
    assert.deepEqual(compare(value, after), { mode: "exact", value })
  }
  for (const value of [null, undefined, [], "value", 1])
    assert.deepEqual(compare(value, after), { mode: "exact", value })
})
test("missing values and values imitating the comparison tag cannot collapse into valid evidence", () => {
  const { last_edited_time: _time, ...missing } = field(after)
  const projected = compare(field(before), before)
  assert.notDeepEqual(compare(missing, after), projected)
  assert.notDeepEqual(compare(projected, after), projected)
  assert.notDeepEqual(
    compare({ ...field(after), last_edited_time: "<root-edit-time>" }, after),
    projected,
  )
})
test("inherited identity, type or time fields cannot supply root-derived evidence", () => {
  const inherited = Object.create(field(after))
  assert.deepEqual(compare(inherited, after), { mode: "exact", value: inherited })
})
test("comparison does not mutate its input or erase an unrelated nested value", () => {
  const value = { ...field(before), details: { color: "blue" } },
    original = structuredClone(value)
  const output = compare(value, before)
  assert.deepEqual(value, original)
  assert.deepEqual(output.value.details, { color: "blue" })
  assert.notEqual(output.value, value)
})
