import { afterAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { trashPath } from "../src/local-locks.ts"
import { fail, property, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { queryCurrentSkillIndex } from "../src/shared-current-index.ts"
import { CurrentWritePendingSchema, withCurrentOperation } from "../src/shared-current-operation.ts"
import { registerCurrentNotionSkill } from "../src/shared-current-skill-register.ts"
import { sourceRich } from "../src/shared-source-definitions.ts"
import { currentWriteFixture, id, library } from "./shared-current-write-fixture.ts"

const parent = mkdtempSync(join(tmpdir(), "ntn-current-skill-register-"))
afterAll(async () => {
  if (process.platform === "darwin") await Effect.runPromise(trashPath(parent))
})
type Fixture = ReturnType<typeof currentWriteFixture>
type Options = Parameters<typeof registerCurrentNotionSkill>[1]
const mainBody =
  "---\nname: Body metadata stays here\n---\n\n# Authored page\n\nRead [guide](notes/guide.md).\n"
const guideBody = "# Authored guide\n\nKeep this whole native body.\n"
const native = { kind: "native", frontmatter: "", mode: "100644" }

async function page(f: Fixture, role: "skills" | "files", fields: Record<string, unknown>) {
  const value = await f.run(
    Effect.flatMap(Notion, (api) =>
      api.request(
        "v1/pages",
        {
          parent: { type: "data_source_id", data_source_id: library[role].data_source_id },
          properties: fields,
        },
        { method: "POST" },
      ),
    ),
  )
  return String(property(value).id)
}
async function draft(f: Fixture, kind: "skill" | "router" | "prompt" | null = null) {
  const owner = await page(f, "skills", {
    title: { title: sourceRich("Authored workflow") },
    description: { rich_text: sourceRich("Use this authored workflow for a focused task.") },
    kind: { select: kind === null ? null : { name: kind } },
    "skill-id": { rich_text: [] },
    "main-file-id": { rich_text: [] },
    content: { rich_text: [] },
    "current-state": { select: null },
    operation: { rich_text: [] },
    enabled: { checkbox: false },
    "default-context": { checkbox: true },
    "custom-daily": { checkbox: true },
    "custom-delete": { checkbox: false },
  })
  const support = await page(f, "files", {
    title: { title: sourceRich("Authored guide") },
    skill: { relation: [{ id: owner }] },
    path: { rich_text: sourceRich("notes/guide.md") },
    "file-id": { rich_text: [] },
    content: { rich_text: [] },
  })
  await f.run(
    Effect.forEach(
      [
        [owner, mainBody],
        [support, guideBody],
      ],
      ([page, markdown]) =>
        Effect.flatMap(Notion, (api) =>
          api.request(
            `v1/pages/${page}/markdown`,
            { type: "replace_content", replace_content: { new_str: markdown } },
            { method: "PATCH" },
          ),
        ),
    ),
  )
  f.clearCalls()
  return { owner, support }
}
function field(f: Fixture, page: string, key: string) {
  return property(property(f.pages.get(page)?.properties)[key])
}
function set(f: Fixture, page: string, key: string, type: string, value: unknown) {
  property(f.pages.get(page)?.properties)[key] = { id: key, type, [type]: value }
}
function pending(f: Fixture) {
  return [...f.json.keys()].filter((key) => key.startsWith("operations/current-write-pending/"))
}
function liveOperations(f: Fixture) {
  return f
    .table("records")
    .filter((row) => property(property(property(row.properties).kind).select).name === "operation")
}
function bodyWrites(f: Fixture) {
  return f
    .mutations()
    .filter((call) => call.path.includes("/markdown") || call.path.startsWith("v1/blocks/"))
}
async function assertBodies(f: Fixture, owner: string, support: string) {
  const bodies = await f.run(
    Effect.forEach([owner, support], (page) =>
      Effect.flatMap(Notion, (api) => api.request(`v1/pages/${page}/markdown`)),
    ),
  )
  expect(property(bodies[0]).markdown).toBe(mainBody)
  expect(property(bodies[1]).markdown).toBe(guideBody)
  expect(bodyWrites(f)).toEqual([])
}

test("native registration dry-run admits draft main and supporting fields without allocating or editing bodies", async () => {
  const f = currentWriteFixture(parent),
    { owner, support } = await draft(f)
  const result = await f.run(registerCurrentNotionSkill(library, { target: owner, dry_run: true }))
  expect(result).toMatchObject({ status: "planned", remote_writes: 0, page_id: owner, files: 2 })
  expect(text(field(f, owner, "skill-id").rich_text)).toBe("")
  expect(field(f, owner, "current-state").select).toBeNull()
  expect(text(field(f, support, "content").rich_text)).toBe("")
  expect(f.mutations()).toEqual([])
  expect(pending(f)).toEqual([])
  expect(f.table("records")).toEqual([])
  await assertBodies(f, owner, support)
})

test("register fills stable native main and File metadata on the original pages, then repeats with zero writes", async () => {
  const f = currentWriteFixture(parent),
    { owner, support } = await draft(f)
  const result = await f.run(registerCurrentNotionSkill(library, { target: owner }))
  expect(result).toMatchObject({ status: "registered", state: "ready", page_id: owner, files: 2 })
  expect(result.skill_id).toBe("skill-" + owner.replaceAll("-", ""))
  const index = await f.run(queryCurrentSkillIndex(library, owner))
  expect(index.kind).toBe("skill")
  expect(index.enabled).toBe(true)
  expect(index.default_context).toBe(false)
  expect(index.main).toMatchObject({ page_id: owner, path: "SKILL.md", content: native })
  expect(index.files).toHaveLength(1)
  expect(index.files[0]).toMatchObject({
    page_id: support,
    path: "notes/guide.md",
    content: native,
  })
  expect(index.main.file_id).toMatch(/^file-[a-f0-9]{64}$/u)
  expect(index.files[0]!.file_id).toMatch(/^file-[a-f0-9]{64}$/u)
  expect(index.main.file_id).not.toBe(index.files[0]!.file_id)
  expect(field(f, owner, "custom-daily").checkbox).toBe(true)
  expect(field(f, owner, "custom-delete").checkbox).toBe(false)
  expect(f.table("skills")).toHaveLength(1)
  expect(f.table("files")).toHaveLength(1)
  expect(pending(f)).toEqual([])
  expect(liveOperations(f)).toEqual([])
  await assertBodies(f, owner, support)
  f.clearCalls()
  const repeated = await f.run(registerCurrentNotionSkill(library, { target: owner }))
  expect(repeated).toMatchObject({ status: "unchanged", state: "ready", remote_writes: 0 })
  expect(f.mutations()).toEqual([])
  expect(await f.run(queryCurrentSkillIndex(library, owner))).toEqual(index)
  await assertBodies(f, owner, support)
})

for (const kind of ["skill", "router", "prompt"] as const)
  test(`register retains a valid ${kind}, native metadata and explicit author policy with zero writes`, async () => {
    const f = currentWriteFixture(parent),
      { owner, support } = await draft(f, kind)
    set(f, owner, "skill-id", "rich_text", sourceRich("existing-" + kind))
    set(f, owner, "main-file-id", "rich_text", sourceRich("authored-main"))
    set(
      f,
      owner,
      "content",
      "rich_text",
      sourceRich(
        JSON.stringify({
          ...native,
          mode: "100755",
          frontmatter: "---\r\nname: Stored header\r\n---\r\n",
        }),
      ),
    )
    set(f, owner, "current-state", "select", { name: "ready" })
    set(f, support, "file-id", "rich_text", sourceRich("authored-guide"))
    set(f, support, "content", "rich_text", sourceRich(JSON.stringify(native)))
    const before = structuredClone([...f.pages])
    const result = await f.run(registerCurrentNotionSkill(library, { target: owner }))
    expect(result).toMatchObject({
      status: "unchanged",
      remote_writes: 0,
      skill_id: "existing-" + kind,
    })
    expect([...f.pages]).toEqual(before)
    expect(f.mutations()).toEqual([])
    expect(pending(f)).toEqual([])
    const index = await f.run(queryCurrentSkillIndex(library, owner))
    expect(index.kind).toBe(kind)
    expect(index.enabled).toBe(false)
    expect(index.default_context).toBe(true)
    expect(index.main.file_id).toBe("authored-main")
    expect(index.main.content).toMatchObject({
      kind: "native",
      mode: "100755",
      frontmatter: "---\r\nname: Stored header\r\n---\r\n",
    })
    await assertBodies(f, owner, support)
  })

test("register requires business metadata and accepts explicit author values without deriving them from body text", async () => {
  const f = currentWriteFixture(parent),
    { owner, support } = await draft(f)
  set(f, owner, "title", "title", [])
  set(f, owner, "description", "rich_text", [])
  await expect(f.run(registerCurrentNotionSkill(library, { target: owner }))).rejects.toBeDefined()
  expect(f.mutations()).toEqual([])
  const result = await f.run(
    registerCurrentNotionSkill(library, {
      target: owner,
      skill_id: "author-selected",
      name: "Explicit name",
      description: "Explicit business purpose.",
      enabled: false,
      default_context: true,
    }),
  )
  expect(result).toMatchObject({ status: "registered", skill_id: "author-selected" })
  expect(text(field(f, owner, "title").title)).toBe("Explicit name")
  expect(text(field(f, owner, "description").rich_text)).toBe("Explicit business purpose.")
  expect(field(f, owner, "enabled").checkbox).toBe(false)
  expect(field(f, owner, "default-context").checkbox).toBe(true)
  await assertBodies(f, owner, support)
})

for (const authority of ["resource", "source"] as const)
  for (const location of ["main", "support"] as const)
    test(`registration refuses ${authority} ${location} authority before any write`, async () => {
      const f = currentWriteFixture(parent),
        { owner, support } = await draft(f)
      const descriptor =
        authority === "resource"
          ? {
              kind: "resource",
              object_id: "resource-" + "a".repeat(64),
              sha256: "a".repeat(64),
              bytes: 4,
              mode: "100644",
            }
          : {
              kind: "source",
              source_id: "upstream",
              revision: "a".repeat(64),
              source_path: "member/SKILL.md",
              sha256: "b".repeat(64),
              bytes: 4,
              mode: "100644",
            }
      set(
        f,
        location === "main" ? owner : support,
        "content",
        "rich_text",
        sourceRich(JSON.stringify(descriptor)),
      )
      await expect(
        f.run(registerCurrentNotionSkill(library, { target: owner })),
      ).rejects.toMatchObject({ code: "CURRENT_AUTHORITY_CONFLICT" })
      expect(f.mutations()).toEqual([])
      expect(pending(f)).toEqual([])
      await assertBodies(f, owner, support)
    })

for (const problem of [
  "missing-description",
  "unknown-path",
  "foreign-page",
  "duplicate-id",
  "ambiguous-owner",
  "pending-state",
  "truncated-body",
] as const)
  test(`registration refuses ${problem} without mutating or allocating an intent`, async () => {
    const f = currentWriteFixture(parent),
      { owner, support } = await draft(f)
    if (problem === "missing-description") set(f, owner, "description", "rich_text", [])
    if (problem === "unknown-path") set(f, support, "path", "rich_text", [])
    if (problem === "foreign-page")
      f.pages.get(owner)!.parent = { type: "data_source_id", data_source_id: id(9000) }
    if (problem === "duplicate-id") {
      const duplicate = structuredClone(f.pages.get(owner)!)
      duplicate.id = id(9001)
      property(duplicate.properties)["skill-id"] = {
        id: "skill-id",
        type: "rich_text",
        rich_text: sourceRich("skill-" + owner.replaceAll("-", "")),
      }
      f.pages.set(id(9001), duplicate)
    }
    if (problem === "ambiguous-owner")
      set(f, support, "skill", "relation", [{ id: owner }, { id: id(9002) }])
    if (problem === "pending-state") {
      set(f, owner, "current-state", "select", { name: "applying" })
      set(f, owner, "operation", "rich_text", sourceRich("someone-else"))
    }
    if (problem === "truncated-body")
      f.rewrite((path, raw) =>
        path.split("?")[0]!.endsWith("/markdown") ? { ...raw, truncated: true } : raw,
      )
    await expect(
      f.run(registerCurrentNotionSkill(library, { target: owner })),
    ).rejects.toBeDefined()
    expect(f.mutations()).toEqual([])
    expect(pending(f)).toEqual([])
    expect(liveOperations(f)).toEqual([])
    await assertBodies(f, owner, support)
  })

type AckPhase = "seed" | "file" | "bind" | "ready" | "retire"
function loseRegistrationAck(
  f: Fixture,
  options: Options,
  owner: string,
  support: string,
  phase: AckPhase,
  outcome: "accepted" | "absent" = "accepted",
) {
  let lost = false
  return f.run(
    Effect.gen(function* () {
      const api = yield* Notion
      const wrapped: Notion["Service"] = {
        ...api,
        request: (path, body, requestOptions) => {
          const fields = property(property(body).properties)
          const state = property(property(fields["current-state"]).select).name
          const ownerBinding = property(fields.skill).relation
          const matches =
            requestOptions?.method === "PATCH" &&
            ((phase === "seed" &&
              path === `v1/pages/${owner}` &&
              fields["skill-id"] !== undefined) ||
              (phase === "file" &&
                path === `v1/pages/${support}` &&
                fields.content !== undefined) ||
              (phase === "bind" && Array.isArray(ownerBinding) && ownerBinding.length === 1) ||
              (phase === "ready" && path === `v1/pages/${owner}` && state === "ready") ||
              (phase === "retire" && property(body).in_trash === true))
          if (lost || !matches) return api.request(path, body, requestOptions)
          lost = true
          const failure = Effect.fail(
            fail("WRITE_OUTCOME_UNKNOWN", `Registration ${phase} outcome is unknown.`, {
              phase: "outcome_unknown",
            }),
          )
          return outcome === "absent"
            ? failure
            : api.request(path, body, requestOptions).pipe(Effect.andThen(failure))
        },
      }
      return yield* registerCurrentNotionSkill(library, options).pipe(
        Effect.provideService(Notion, wrapped),
      )
    }),
  )
}

for (const outcome of ["accepted", "absent"] as const)
  for (const phase of ["seed", "file", "bind", "ready", "retire"] as readonly AckPhase[])
    test(`registration only releases an ${outcome} ${phase} PATCH with a unique control witness`, async () => {
      const f = currentWriteFixture(parent),
        { owner, support } = await draft(f)
      const options = { target: owner }
      await expect(
        loseRegistrationAck(f, options, owner, support, phase, outcome),
      ).rejects.toMatchObject({
        code: "WRITE_OUTCOME_UNKNOWN",
      })
      expect(pending(f)).toHaveLength(1)
      if (outcome === "absent") {
        if (phase === "seed") expect(text(field(f, owner, "skill-id").rich_text)).toBe("")
        if (phase === "file") expect(text(field(f, support, "content").rich_text)).toBe("")
        if (phase === "ready")
          expect(property(field(f, owner, "current-state").select).name).toBe("applying")
        if (phase === "retire") expect(liveOperations(f)).toHaveLength(1)
      }
      await assertBodies(f, owner, support)
      f.clearCalls()
      if (outcome !== "accepted" || (phase !== "bind" && phase !== "retire")) {
        await expect(f.run(registerCurrentNotionSkill(library, options))).rejects.toMatchObject({
          code: "CURRENT_OPERATION_UNRESOLVED",
        })
        expect(f.mutations()).toEqual([])
        expect(pending(f)).toHaveLength(1)
        await assertBodies(f, owner, support)
        return
      }
      const result = await f.run(registerCurrentNotionSkill(library, options))
      expect(result).toMatchObject({ status: "registered", state: "ready", page_id: owner })
      expect(f.table("skills")).toHaveLength(1)
      expect(f.table("files")).toHaveLength(1)
      expect(liveOperations(f)).toEqual([])
      expect(pending(f)).toEqual([])
      expect(text(field(f, owner, "operation").rich_text)).toBe("")
      expect(property(field(f, owner, "current-state").select).name).toBe("ready")
      await assertBodies(f, owner, support)
      f.clearCalls()
      expect(await f.run(registerCurrentNotionSkill(library, options))).toMatchObject({
        status: "unchanged",
        remote_writes: 0,
      })
      expect(f.mutations()).toEqual([])
    })

test("registration with an unbound accepted seed preserves a later foreign operation marker", async () => {
  const f = currentWriteFixture(parent),
    { owner, support } = await draft(f)
  const options = { target: owner }
  await expect(loseRegistrationAck(f, options, owner, support, "seed")).rejects.toMatchObject({
    code: "WRITE_OUTCOME_UNKNOWN",
  })
  expect(pending(f)).toHaveLength(1)
  const pendingKey = pending(f)[0]!
  const frozen = structuredClone(f.json.get(pendingKey))
  expect(Schema.decodeUnknownSync(CurrentWritePendingSchema)(frozen).owner_page_id).toBeNull()
  set(f, owner, "current-state", "select", { name: "applying" })
  set(f, owner, "operation", "rich_text", sourceRich("foreign-operation"))
  const before = structuredClone([...f.pages])
  f.clearCalls()
  await expect(f.run(registerCurrentNotionSkill(library, options))).rejects.toMatchObject({
    code: "CURRENT_SKILL_REGISTER_CONFLICT",
  })
  expect(f.mutations()).toEqual([])
  expect([...f.pages]).toEqual(before)
  expect(pending(f)).toEqual([pendingKey])
  expect(f.json.get(pendingKey)).toEqual(frozen)
  expect(text(field(f, owner, "operation").rich_text)).toBe("foreign-operation")
  expect(property(field(f, owner, "current-state").select).name).toBe("applying")
  await assertBodies(f, owner, support)
})

for (const action of ["body", "foreign-owner"] as const)
  test(`a registration seed cannot write ${action} before binding its exact owner`, async () => {
    const captured = currentWriteFixture(parent)
    const original = await draft(captured)
    await expect(
      loseRegistrationAck(
        captured,
        { target: original.owner },
        original.owner,
        original.support,
        "seed",
        "absent",
      ),
    ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
    const frozen = Schema.decodeUnknownSync(CurrentWritePendingSchema)(
      captured.json.get(pending(captured)[0]!),
    ).intent
    const f = currentWriteFixture(parent),
      { owner, support } = await draft(f)
    expect(owner).toBe(original.owner)
    expect(support).toBe(original.support)
    await expect(
      f.run(
        withCurrentOperation(library, {
          intent: frozen,
          ownerPageId: null,
          run: (session) =>
            action === "foreign-owner"
              ? session.bindOwner(support)
              : session.dispatch({
                  key: "forbidden-body",
                  replay: "idempotent",
                  request: {
                    path: `v1/pages/${owner}/markdown`,
                    options: { method: "PATCH" },
                    body: { type: "replace_content", replace_content: { new_str: "Wrong body" } },
                  },
                  observe: () => Effect.succeed({ status: "missing" as const }),
                }),
          verify: () => Effect.void,
        }),
      ),
    ).rejects.toMatchObject({ code: "CURRENT_OPERATION_INVALID" })
    expect(f.mutations()).toEqual([])
    expect(pending(f)).toEqual([])
    expect(liveOperations(f)).toEqual([])
    await assertBodies(f, owner, support)
  })

test("registration refuses a different unfinished owner intent without clearing its state", async () => {
  const f = currentWriteFixture(parent),
    { owner, support } = await draft(f)
  const registered = await f.run(registerCurrentNotionSkill(library, { target: owner }))
  await expect(
    f.run(
      withCurrentOperation(library, {
        intent: {
          owner: { kind: "skill", id: registered.skill_id },
          operation_id: "other-content-work",
          input_sha256: "c".repeat(64),
        },
        ownerPageId: owner,
        run: (session) =>
          session
            .activate()
            .pipe(
              Effect.andThen(
                Effect.fail(fail("TEST_PAUSE", "Leave real content work unfinished.")),
              ),
            ),
        verify: () => Effect.void,
      }),
    ),
  ).rejects.toMatchObject({ code: "TEST_PAUSE" })
  expect(pending(f)).toHaveLength(1)
  f.clearCalls()
  await expect(f.run(registerCurrentNotionSkill(library, { target: owner }))).rejects.toMatchObject(
    { code: "CURRENT_OPERATION_PENDING" },
  )
  expect(f.mutations()).toEqual([])
  expect(pending(f)).toHaveLength(1)
  expect(text(field(f, owner, "operation").rich_text)).toBe("other-content-work")
  await assertBodies(f, owner, support)
})
