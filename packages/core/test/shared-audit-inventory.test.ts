import { expect, test } from "bun:test"
import { Effect } from "effect"
import { property } from "../src/model.ts"
import {
  readAuditInventory,
  auditRelationIds,
  inspectAuditInventory,
} from "../src/shared-audit-inventory.ts"
import { emptyAuditInventory } from "../src/shared-audit-model.ts"
import { auditFixture } from "./shared-audit-fixture.ts"
import { id, library, rich, skillPage } from "./shared-snapshot-fixture.ts"

const relation = (name: string, ids: readonly string[], more = false) => ({
  id: name,
  type: "relation",
  relation: ids.map((id) => ({ id })),
  has_more: more,
})

test("reverse census keeps 105 physical rows including malformed IDs and fully expands a 30-target relation", async () => {
  const f = await auditFixture(2)
  const rows = Array.from({ length: 105 }, (_, i) => ({
    ...structuredClone(f.files[0]!),
    id: id(100 + i),
    properties: {
      ...structuredClone(f.files[0]!.properties),
      file_id: rich("file_id", i === 104 ? "" : `file-${i}`),
      path: rich("path", `references/${i}.md`),
      skill: relation(
        "skill",
        i === 0 ? Array.from({ length: 25 }, (_, j) => id(400 + j)) : [skillPage],
        i === 0,
      ),
    },
  }))
  const relationIds = Array.from({ length: 30 }, (_, i) => id(400 + i))
  f.intercept((path, body) => {
    if (path.startsWith(`v1/data_sources/${library.files.data_source_id}/query?`)) {
      const offset = property(body).start_cursor === "more" ? 100 : 0
      return Effect.succeed({
        object: "list",
        results: rows.slice(offset, offset + 100),
        has_more: offset === 0,
        next_cursor: offset === 0 ? "more" : null,
      })
    }
    if (path.startsWith(`v1/pages/${id(100)}/properties/skill?`)) {
      const second = path.includes("start_cursor=relation-more")
      return Effect.succeed({
        object: "list",
        type: "property_item",
        results: relationIds.slice(second ? 25 : 0, second ? 30 : 25).map((id) => ({
          object: "property_item",
          id: "skill",
          type: "relation",
          relation: { id },
        })),
        has_more: !second,
        next_cursor: second ? null : "relation-more",
        property_item: {
          id: "skill",
          type: "relation",
          next_url: second ? null : "https://api.notion.com/next",
        },
      })
    }
    return undefined
  })
  const inventory = await f.run(readAuditInventory(library, "files"))
  expect(inventory).toHaveLength(105)
  expect(auditRelationIds(inventory[0], library.files, "Skill")).toEqual(relationIds)
  expect(f.ledger.filter((call) => call.path.includes("/properties/skill?"))).toHaveLength(2)
  expect(
    f.ledger
      .filter((call) => call.path.includes("/data_sources/"))
      .every((call) => property(call.body).filter === undefined),
  ).toBe(true)
  const findings = inspectAuditInventory(library, { ...emptyAuditInventory(), files: inventory })
  expect(
    findings.some(
      (finding) => finding.code === "FILE_MULTIPLE_OWNERS" && finding.object_id === id(100),
    ),
  ).toBe(true)
  expect(
    findings.some(
      (finding) => finding.code === "BUSINESS_ID_INVALID" && finding.object_id === id(204),
    ),
  ).toBe(true)
  expect(f.writeCount()).toBe(0)
})

test("terminal pagination and relation failures remain incomplete instead of a short healthy census", async () => {
  const f = await auditFixture(2)
  f.intercept((path) =>
    path.startsWith(`v1/data_sources/${library.files.data_source_id}/query?`)
      ? Effect.succeed({ object: "list", results: f.files, has_more: true, next_cursor: "same" })
      : undefined,
  )
  const incomplete = await f.run(readAuditInventory(library, "files").pipe(Effect.flip))
  expect(incomplete.code).toBe("AUDIT_INVENTORY_INCOMPLETE")
  const row = {
    ...f.files[0]!,
    properties: { ...f.files[0]!.properties, skill: relation("skill", [skillPage], true) },
  }
  f.intercept((path) =>
    path.startsWith(`v1/data_sources/${library.files.data_source_id}/query?`)
      ? Effect.succeed({ object: "list", results: [row], has_more: false, next_cursor: null })
      : path.includes("/properties/skill?")
        ? Effect.succeed({
            object: "list",
            type: "property_item",
            results: [],
            has_more: false,
            next_cursor: null,
            property_item: { id: "skill", type: "relation", next_url: "unexpected-next" },
          })
        : undefined,
  )
  const retained = await f.run(readAuditInventory(library, "files"))
  expect(retained).toHaveLength(1)
  const findings = inspectAuditInventory(library, { ...emptyAuditInventory(), files: retained })
  expect(
    findings.some(
      (finding) => finding.code === "RELATION_UNOBSERVED" && finding.coverage === "partial",
    ),
  ).toBe(true)
  expect(findings.some((finding) => finding.code === "FILE_OWNER_MISSING")).toBe(false)
})

test("duplicate IDs, path collisions and Requires cycles preserve every physical identity", async () => {
  const f = await auditFixture(2)
  const extended = {
    ...library,
    skills: {
      ...library.skills,
      property_ids: { ...library.skills.property_ids, Requires: "requires" },
    },
  }
  const first = {
    ...f.main,
    properties: { ...property(f.main.properties), requires: relation("requires", [id(90)]) },
  }
  const second = {
    ...structuredClone(first),
    id: id(90),
    properties: {
      ...structuredClone(first.properties),
      skill_id: rich("skill_id", "other-skill"),
      requires: relation("requires", [skillPage]),
    },
  }
  const duplicate = { ...structuredClone(f.files[0]!), id: id(91) }
  const findings = inspectAuditInventory(extended, {
    ...emptyAuditInventory(),
    skills: [first, second],
    files: [f.files[0]!, duplicate],
  })
  expect(
    findings
      .filter((finding) => finding.code === "DUPLICATE_BUSINESS_ID")
      .map((finding) => finding.object_id),
  ).toEqual(expect.arrayContaining([f.files[0]!.id, id(91)]))
  expect(findings.filter((finding) => finding.code === "DUPLICATE_FILE_PATH")).toHaveLength(2)
  expect(findings.some((finding) => finding.code === "REQUIRES_CYCLE")).toBe(true)
  expect(findings.every((finding) => finding.key.length > 0)).toBe(true)
})

test("Records identities are owner-scoped and equivalent physical copies are distinct from conflicting facts", async () => {
  const f = await auditFixture(1)
  const template = [...f.records.values()].find(
    (row) => property(property(property(row.properties).kind).select).name === "object",
  )
  if (template === undefined) throw new Error("Expected retained object fixture")
  const otherSkill = {
    ...structuredClone(f.main),
    id: id(90),
    properties: { ...property(f.main.properties), skill_id: rich("skill_id", "other-skill") },
  }
  const first = structuredClone(template)
  const otherOwner = {
    ...structuredClone(first),
    id: id(91),
    properties: { ...property(first.properties), skill: relation("skill", [id(90)]) },
  }
  const base = {
    ...emptyAuditInventory(),
    skills: [f.main, otherSkill],
    records: [first, otherOwner],
  }
  expect(
    inspectAuditInventory(library, base).filter((finding) =>
      ["DUPLICATE_BUSINESS_ID", "RECORD_DUPLICATE_COPY"].includes(finding.code),
    ),
  ).toEqual([])
  const copy = { ...structuredClone(first), id: id(92) }
  const copies = inspectAuditInventory(library, { ...base, records: [first, copy, otherOwner] })
  expect(copies.filter((finding) => finding.code === "RECORD_DUPLICATE_COPY")).toHaveLength(2)
  expect(copies.some((finding) => finding.code === "DUPLICATE_BUSINESS_ID")).toBe(false)
  const conflict = {
    ...structuredClone(copy),
    properties: { ...property(property(copy).properties), hash: rich("hash", "f".repeat(64)) },
  }
  const conflicts = inspectAuditInventory(library, { ...base, records: [first, conflict] })
  expect(conflicts.filter((finding) => finding.code === "DUPLICATE_BUSINESS_ID")).toHaveLength(2)
})
