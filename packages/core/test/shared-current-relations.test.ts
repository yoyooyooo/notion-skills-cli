import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { trashPath } from "../src/local-locks.ts"
import { property, text, type ContentKind } from "../src/model.ts"
import { skillIdentity } from "../src/shared-content.ts"
import { prepareCurrentRelations } from "../src/shared-current-relations.ts"
import { prepareCurrentSkillWrite, writeCurrentSkill } from "../src/shared-current-write.ts"
import { currentWriteFixture, id, library, testBytes } from "./shared-current-write-fixture.ts"

const parent = mkdtempSync(join(tmpdir(), "ntn-current-relations-"))
afterAll(async () => {
  if (process.platform === "darwin") await Effect.runPromise(trashPath(parent))
})
type Fixture = ReturnType<typeof currentWriteFixture>
const ref = (skill: string) => skillIdentity(library.library_id, skill)
const selection = (members?: readonly string[], requires?: readonly string[]) => ({
  version: 1 as const,
  ownership: "notion" as const,
  library_id: library.library_id,
  ...(members === undefined ? {} : { members: members.map(ref) }),
  ...(requires === undefined ? {} : { requires: requires.map(ref) }),
})
function seed(
  f: Fixture,
  skill: string,
  n: number,
  options: {
    kind?: ContentKind
    enabled?: boolean
    requires?: readonly string[]
    state?: string
  } = {},
) {
  const page = id(10000 + n),
    rich = (value: string) => ({
      type: "rich_text",
      rich_text: [{ type: "text", text: { content: value } }],
      has_more: false,
    })
  f.pages.set(page, {
    object: "page",
    id: page,
    parent: {
      type: "data_source_id",
      data_source_id: library.skills.data_source_id,
      database_id: library.skills.database_id,
    },
    in_trash: false,
    archived: false,
    last_edited_time: "2026-11-19T01:00:00.000Z",
    properties: Object.fromEntries(
      Object.entries({
        [library.skills.property_ids.Name!]: {
          type: "title",
          title: [{ type: "text", text: { content: skill } }],
        },
        description: rich("Current target"),
        kind: { type: "select", select: { name: options.kind ?? "skill" } },
        enabled: { type: "checkbox", checkbox: options.enabled ?? true },
        "default-context": { type: "checkbox", checkbox: false },
        "skill-id": rich(skill),
        "main-file-id": rich(`main-${skill}`),
        content: rich(JSON.stringify({ kind: "native", mode: "100644", frontmatter: "" })),
        "current-state": { type: "select", select: { name: options.state ?? "ready" } },
        operation: rich(options.state && options.state !== "ready" ? "another-operation" : ""),
        tags: { type: "multi_select", multi_select: [] },
        origin: { type: "relation", relation: [], has_more: false },
        members: { type: "relation", relation: [], has_more: false },
        requires: {
          type: "relation",
          relation: (options.requires ?? []).map((id) => ({ id })),
          has_more: false,
        },
      }).map(([key, value]) => [key, { id: key, ...value }]),
    ),
  })
  return page
}
const ownerInput = (relations?: ReturnType<typeof selection>, body = "# Owner\n") => ({
  skill_id: "owner",
  kind: "skill" as const,
  name: "Owner",
  description: "Current relations",
  relations,
  files: [{ path: "SKILL.md", bytes: testBytes(body) }],
})
function replaceRelation(
  f: Fixture,
  page: string,
  field: "members" | "requires",
  targets: readonly string[],
) {
  const props = property(f.pages.get(page)?.properties)
  props[field] = {
    id: field,
    type: "relation",
    relation: targets.map((id) => ({ id })),
    has_more: false,
  }
}
const relationWrites = (f: Fixture) =>
  f
    .mutations()
    .filter(
      (call) =>
        "members" in property(property(call.body).properties) ||
        "requires" in property(property(call.body).properties),
    )

describe("current native relation round-trip", () => {
  test("omission preserves and explicit empty clears without changing relation targets", async () => {
    const f = currentWriteFixture(parent),
      target = seed(f, "target", 1)
    const first = await f.run(
      prepareCurrentSkillWrite(ownerInput(selection(["target"], ["target"]))),
    )
    const written = await f.run(
      writeCurrentSkill(library, { plan: first, operation_id: "relations-first" }),
    )
    expect(written.library).toEqual({
      library_id: library.library_id,
      database_id: library.skills.database_id,
      data_source_id: library.skills.data_source_id,
    })
    const previousTarget = structuredClone(f.pages.get(target))
    f.clearCalls()
    await f.run(
      writeCurrentSkill(library, {
        plan: await f.run(prepareCurrentSkillWrite(ownerInput(undefined, "# Edited\n"))),
        operation_id: "preserve",
      }),
    )
    expect(relationWrites(f)).toEqual([])
    expect(property(property(f.pages.get(written.page_id)?.properties).members).relation).toEqual([
      { id: target },
    ])
    await f.run(
      writeCurrentSkill(library, {
        plan: await f.run(prepareCurrentSkillWrite(ownerInput(selection([], []), "# Edited\n"))),
        operation_id: "clear",
      }),
    )
    expect(property(property(f.pages.get(written.page_id)?.properties).members).relation).toEqual(
      [],
    )
    expect(property(property(f.pages.get(written.page_id)?.properties).requires).relation).toEqual(
      [],
    )
    expect(f.pages.get(target)).toEqual(previousTarget)
  })
  test("a 30-target replacement completes the truncated ACK using property pagination", async () => {
    const f = currentWriteFixture(parent),
      names = Array.from({ length: 30 }, (_, n) => `target-${n}`)
    names.forEach((name, n) => seed(f, name, n))
    const result = await f.run(
      writeCurrentSkill(library, {
        plan: await f.run(prepareCurrentSkillWrite(ownerInput(selection(names, [])))),
        operation_id: "thirty",
      }),
    )
    expect(result.relations).toEqual({
      members: { action: "replace", targets: 30 },
      requires: { action: "retain", targets: 0 },
    })
    expect(relationWrites(f)).toHaveLength(1)
    expect(
      f.calls.some((call) => call.path.includes(`/pages/${result.page_id}/properties/members?`)),
    ).toBe(true)
    expect(
      f.calls
        .filter((call) => call.path.includes("/blocks/") && !(call.method === "GET" && call.path.split("?")[0] === `v1/blocks/${library.library_id}/children`))
        .every((call) => call.path.includes(result.page_id)),
    ).toBe(true)
  })
  test("101 current targets are fully paginated and preserved with zero writes; changing them fails before content writes", async () => {
    const f = currentWriteFixture(parent),
      names = Array.from({ length: 101 }, (_, n) => `large-${n}`)
    const pages = names.map((name, n) => seed(f, name, n))
    const result = await f.run(
      writeCurrentSkill(library, {
        plan: await f.run(prepareCurrentSkillWrite(ownerInput())),
        operation_id: "base",
      }),
    )
    replaceRelation(f, result.page_id, "members", pages)
    f.clearCalls()
    expect(
      await f.run(
        writeCurrentSkill(library, {
          plan: await f.run(prepareCurrentSkillWrite(ownerInput(selection(names)))),
          operation_id: "retain-large",
        }),
      ),
    ).toMatchObject({
      status: "unchanged",
      relations: { members: { action: "retain", targets: 101 } },
    })
    expect(f.mutations()).toEqual([])
    expect(
      f.calls.some(
        (call) => call.path.includes("properties/members?") && call.path.includes("start_cursor="),
      ),
    ).toBe(true)
    replaceRelation(f, result.page_id, "members", [])
    f.clearCalls()
    await expect(
      f.run(
        writeCurrentSkill(library, {
          plan: await f.run(prepareCurrentSkillWrite(ownerInput(selection(names), "# Changed\n"))),
          operation_id: "too-many",
        }),
      ),
    ).rejects.toMatchObject({ code: "CURRENT_RELATION_WRITE_LIMIT" })
    expect(f.mutations()).toEqual([])
  })
  test.each(["accepted", "absent", "partial"] as const)(
    "an unknown %s relation PATCH resumes the same action without duplicate application",
    async (outcome) => {
      const f = currentWriteFixture(parent)
      seed(f, "target", 1)
      const plan = await f.run(
        prepareCurrentSkillWrite(ownerInput(selection(["target"], ["target"]))),
      )
      f.failNext({ kind: "relations", outcome })
      await expect(
        f.run(writeCurrentSkill(library, { plan, operation_id: "pending-relations" })),
      ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
      expect(relationWrites(f)).toHaveLength(1)
      expect(
        await f.run(
          writeCurrentSkill(library, { plan, operation_id: "pending-relations", mode: "resume" }),
        ),
      ).toMatchObject({ state: "ready" })
      expect(relationWrites(f)).toHaveLength(outcome === "accepted" ? 1 : 2)
      f.clearCalls()
      expect(
        await f.run(writeCurrentSkill(library, { plan, operation_id: "same-complete-selection" })),
      ).toMatchObject({ status: "unchanged" })
      expect(f.mutations()).toEqual([])
    },
  )
  test.each(["missing", "duplicate", "router", "disabled", "attention", "foreign-table"] as const)(
    "%s target fails before any business mutation",
    async (bad) => {
      const f = currentWriteFixture(parent)
      if (bad !== "missing") {
        const page = seed(f, "target", 1, {
          kind: bad === "router" ? "router" : "skill",
          enabled: bad !== "disabled",
          state: bad === "attention" ? "attention" : "ready",
        })
        if (bad === "duplicate") seed(f, "target", 2)
        if (bad === "foreign-table")
          f.pages.get(page)!.parent = { type: "data_source_id", data_source_id: id(999) }
      }
      await expect(
        f.run(
          writeCurrentSkill(library, {
            plan: await f.run(prepareCurrentSkillWrite(ownerInput(selection(["target"])))),
            operation_id: `invalid-${bad}`,
          }),
        ),
      ).rejects.toBeDefined()
      expect(f.mutations()).toEqual([])
    },
  )
  test("resume rechecks the dependency closure after an accepted unknown relation replacement", async () => {
    const f = currentWriteFixture(parent),
      target = seed(f, "target", 1)
    const plan = await f.run(prepareCurrentSkillWrite(ownerInput(selection(undefined, ["target"]))))
    f.failNext({ kind: "relations", outcome: "accepted" })
    await expect(
      f.run(writeCurrentSkill(library, { plan, operation_id: "accepted-requires" })),
    ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
    const owner = f
      .table("skills")
      .find((row) => text(property(property(row.properties)["skill-id"]).rich_text) === "owner")!
    const pendingState = property(property(property(owner.properties)["current-state"]).select).name
    expect(pendingState).not.toBe("ready")
    replaceRelation(f, target, "requires", [String(owner.id)])
    f.clearCalls()
    await expect(
      f.run(
        writeCurrentSkill(library, { plan, operation_id: "accepted-requires", mode: "resume" }),
      ),
    ).rejects.toMatchObject({
      code: "CURRENT_REQUIRES_CYCLE",
      details: {
        operation_id: "accepted-requires",
        skill_id: "owner",
        skill_page_id: owner.id,
        input_sha256: plan.input_sha256,
        next: "reconcile_current",
      },
    })
    expect(f.mutations()).toEqual([])
    expect(property(property(property(owner.properties)["current-state"]).select).name).toBe(
      pendingState,
    )
  })
  test("a pending relation action cannot resume with another physical target for the same logical ID", async () => {
    const f = currentWriteFixture(parent),
      target = seed(f, "target", 1)
    const plan = await f.run(prepareCurrentSkillWrite(ownerInput(selection(["target"]))))
    f.failNext({ kind: "relations", outcome: "accepted" })
    await expect(
      f.run(writeCurrentSkill(library, { plan, operation_id: "bound-relation" })),
    ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
    f.pages.get(target)!.in_trash = true
    seed(f, "target", 2)
    f.clearCalls()
    await expect(
      f.run(writeCurrentSkill(library, { plan, operation_id: "bound-relation", mode: "resume" })),
    ).rejects.toMatchObject({ code: "CURRENT_OPERATION_CONFLICT" })
    expect(relationWrites(f)).toEqual([])
  })
  test("a dual or cross-table relation schema is refused before any write", async () => {
    for (const change of [{ type: "dual_property" }, { data_source_id: id(999) }]) {
      const f = currentWriteFixture(parent)
      seed(f, "target", 1)
      f.rewrite((path, response) => {
        if (path === `v1/data_sources/${library.skills.data_source_id}`) {
          const props = property(response.properties),
            members = property(props.Members)
          members.relation = { ...property(members.relation), ...change }
        }
        return response
      })
      await expect(
        f.run(
          writeCurrentSkill(library, {
            plan: await f.run(prepareCurrentSkillWrite(ownerInput(selection(["target"])))),
            operation_id: "invalid-schema",
          }),
        ),
      ).rejects.toMatchObject({ code: "CURRENT_RELATION_SCHEMA" })
      expect(f.mutations()).toEqual([])
    }
  })
  test("changed Requires detects an existing dependency cycle without reading target bodies", async () => {
    const f = currentWriteFixture(parent),
      a = seed(f, "a", 1),
      b = seed(f, "b", 2)
    replaceRelation(f, a, "requires", [b])
    replaceRelation(f, b, "requires", [a])
    await expect(
      f.run(
        writeCurrentSkill(library, {
          plan: await f.run(prepareCurrentSkillWrite(ownerInput(selection(undefined, ["a"])))),
          operation_id: "cycle",
        }),
      ),
    ).rejects.toMatchObject({ code: "CURRENT_REQUIRES_CYCLE" })
    expect(f.mutations()).toEqual([])
    expect(f.calls.some((call) => /\/blocks\/|\/markdown/u.test(call.path))).toBe(false)
  })
  test("changed Requires detects a path back to the owner beyond the inline relation prefix", async () => {
    const f = currentWriteFixture(parent),
      owner = seed(f, "owner", 1)
    const children = Array.from({ length: 26 }, (_, n) => seed(f, `leaf-${n}`, 10 + n))
    seed(f, "target", 2, { requires: [...children, owner] })
    await expect(
      f.run(
        prepareCurrentRelations(library, {
          skill_id: "owner",
          kind: "skill",
          relations: selection(undefined, ["target"]),
          owner: { page_id: owner, raw: f.pages.get(owner) },
        }),
      ),
    ).rejects.toMatchObject({ code: "CURRENT_REQUIRES_CYCLE" })
    expect(f.mutations()).toEqual([])
    expect(f.calls.some((call) => call.path.includes("/properties/requires?"))).toBe(true)
  })
  test("incomplete target metadata pagination is never treated as a complete selection", async () => {
    const f = currentWriteFixture(parent)
    seed(f, "target", 1)
    f.rewrite((path, response) =>
      path.includes("/query?filter_properties=")
        ? { ...response, has_more: true, next_cursor: null }
        : response,
    )
    await expect(
      f.run(
        writeCurrentSkill(library, {
          plan: await f.run(prepareCurrentSkillWrite(ownerInput(selection(["target"])))),
          operation_id: "truncated",
        }),
      ),
    ).rejects.toMatchObject({ code: "CURRENT_RELATION_INVALID" })
    expect(f.mutations()).toEqual([])
  })
  test.each(["binding", "requires"] as const)(
    "final %s drift prevents marking the owner ready",
    async (change) => {
      const f = currentWriteFixture(parent),
        selected = seed(f, "target", 1),
        leaf = seed(f, "leaf", 2)
      let changed = false
      f.rewrite((path, response) => {
        const values = property(property(response.properties).requires).relation
        if (
          !changed &&
          path.startsWith("v1/pages/") &&
          Array.isArray(values) &&
          values.some((value) => property(value).id === selected)
        ) {
          changed = true
          if (change === "requires") replaceRelation(f, selected, "requires", [leaf])
          else {
            f.pages.get(selected)!.in_trash = true
            seed(f, "target", 3)
          }
        }
        return response
      })
      await expect(
        f.run(
          writeCurrentSkill(library, {
            plan: await f.run(
              prepareCurrentSkillWrite(ownerInput(selection(undefined, ["target"]))),
            ),
            operation_id: `drift-${change}`,
          }),
        ),
      ).rejects.toMatchObject({ code: "CURRENT_RELATION_INVALID" })
      const owner = f
        .table("skills")
        .find((row) => text(property(property(row.properties)["skill-id"]).rich_text) === "owner")!
      expect(property(property(property(owner.properties)["current-state"]).select).name).toBe(
        "attention",
      )
    },
  )
})
