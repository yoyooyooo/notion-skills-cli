import { afterAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { fail, property, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { materializeRegisteredSource } from "../src/shared-source-materialization-management.ts"
import { trashPath } from "../src/local-locks.ts"
import {
  CurrentOperationIntentSchema,
  currentOperationOwnerState,
} from "../src/shared-current-operation.ts"
import {
  parseCurrentSourceRegistration,
  parseCurrentSourceManagement,
} from "../src/shared-current-source-management.ts"
import { legacySourceRegistration } from "../src/shared-current-source-legacy-registration.ts"
import { discoverRegisteredSourceMembers } from "../src/shared-source-member-discovery.ts"
import {
  parseMaterializationRegistration,
  readMaterializationRegistration,
  sourceRegistrationDigest,
} from "../src/shared-source-materialization-registration.ts"
import { inspectSourceSkillAdoption } from "../src/shared-current-source-adoption.ts"
import { writePreparedCurrentSource } from "../src/shared-current-source-write.ts"
import { resolveCurrentSourceContributions } from "../src/shared-current-source-input.ts"
import { queryCurrentSkillIndex } from "../src/shared-current-index.ts"
import { resolveCurrentSkillConsumption } from "../src/shared-current-consumption.ts"
import { sourceRich } from "../src/shared-source-definitions.ts"
import {
  commit,
  library,
  materializationFixture,
  sourceId,
} from "./shared-source-materialization-fixture.ts"

const root = mkdtempSync(join(tmpdir(), "source-legacy-registration-unit-"))
afterAll(async () => {
  if (process.platform === "darwin") await Effect.runPromise(trashPath(root))
})
const field = (row: unknown, name: string) => property(property(property(row).properties)[name])
function setLegacy(f: Awaited<ReturnType<typeof materializationFixture>>, revision = commit) {
  const raw = f.pages.get(f.sourcePage)!
  field(raw, library.sources.property_ids.Status!).select = { name: "applied" }
  field(raw, library.sources.property_ids.Content!).rich_text = []
  field(raw, library.sources.property_ids.Operation!).rich_text = []
  field(raw, library.sources.property_ids["Last Revision"]!).rich_text = sourceRich(revision)
  return raw
}
function sourceStatuses(f: Awaited<ReturnType<typeof materializationFixture>>) {
  return f.calls
    .filter((call) => call.method === "PATCH" && call.path === `v1/pages/${f.sourcePage}`)
    .map(
      (call) =>
        property(property(property(call.body).properties)[library.sources.property_ids.Status!])
          .select,
    )
    .filter((selected) => selected !== undefined)
    .map((selected) => property(selected).name)
}

test("legacy applied metadata is materializable while ordinary current parsers stay strict", async () => {
  const f = await materializationFixture(root)
  const raw = setLegacy(f)
  expect(() => parseCurrentSourceRegistration(library, raw)).toThrow()
  expect(() => parseCurrentSourceManagement(library, raw)).toThrow()
  expect(parseMaterializationRegistration(library, raw)).toMatchObject({
    state: { state: "uninitialized" },
    current: undefined,
    legacy_registration: {
      source_id: sourceId,
      source_page_id: f.sourcePage,
      last_revision: commit,
    },
  })
  const result = await f.run(discoverRegisteredSourceMembers(library, { query: "legacy-root" }))
  expect(result).toMatchObject({
    coverage: "complete",
    failures: [],
    effects: { remote_writes: "none" },
  })
  expect(result.candidates).toHaveLength(1)
  expect(result.candidates[0]).toMatchObject({
    readiness: "materializable",
    expected_source_commit: commit,
  })
  expect(result.candidates[0]!.expected_source_revision).toBeUndefined()
  expect(f.mutations()).toEqual([])
})

test("applied Source initializes through Record and applying, then ordinary consume returns complete files", async () => {
  const f = await materializationFixture(root)
  setLegacy(f)
  const initialSibling = structuredClone(f.pages.get(f.owners.get("sibling")!))
  let frozen: unknown[] = []
  f.rewrite((path, response) => {
    if (
      path === `v1/pages/${f.sourcePage}` &&
      property(field(response, library.sources.property_ids.Status!).select).name === "applying"
    )
      frozen = [...f.json.values()].map((value) => structuredClone(value))
    return response
  })
  const request = await f.request()
  const receipt = await f.materialize(request)
  expect(receipt).toMatchObject({
    status: "ready",
    effects: { remote_writes: "management", projection: "none" },
  })
  expect(sourceStatuses(f)).toEqual(["applying", "ready"])
  const firstOwnerWrite = f.calls.findIndex(
    (call) => call.method === "PATCH" && call.path === `v1/pages/${f.sourcePage}`,
  )
  expect(
    f.calls
      .slice(0, firstOwnerWrite)
      .some(
        (call) =>
          call.method === "POST" &&
          property(property(call.body).parent).data_source_id === library.records.data_source_id,
      ),
  ).toBe(true)
  const declaration = frozen
    .map((row) => property(property(row).intent).source_input)
    .map(property)
    .find((input) => input.kind === "declaration")
  expect(declaration).toMatchObject({
    resolved_commit: commit,
    materialization_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    legacy_registration: {
      source_id: sourceId,
      source_page_id: f.sourcePage,
      last_revision: commit,
    },
  })
  const current = await f.run(readMaterializationRegistration(library, sourceId))
  expect(current.current?.revision).toMatch(/^[a-f0-9]{64}$/u)
  expect(current.current?.revision).not.toBe(commit)
  expect(current.legacy_registration).toBeUndefined()
  const index = await f.run(queryCurrentSkillIndex(library, f.owners.get("root")!))
  const consumed = await f.runManaged(resolveCurrentSkillConsumption(library, index))
  expect(consumed.files.map((file) => file.path).sort()).toEqual(["SKILL.md", "run.sh"])
  expect(f.pages.get(f.owners.get("sibling")!)).toEqual(initialSibling)
  f.clearCalls()
  expect(await f.materialize({ ...request, request_id: "legacy-second-session" })).toMatchObject({
    status: "already_ready",
    effects: { remote_writes: "none" },
  })
  expect(f.mutations()).toEqual([])
})

test("source-only applied registration creates just the explicit member at the accepted commit", async () => {
  const f = await materializationFixture(root, "source-only")
  setLegacy(f)
  const assigned = await f.run(
    resolveCurrentSourceContributions({
      source_id: sourceId,
      members: ["skills/root"],
      overrides: [],
    }),
  )
  const request = await f.request("use", assigned[0]!.skill_id)
  const { expected_source_commit: _ignored, ...target } = request.target
  expect(await f.materialize({ ...request, target })).toMatchObject({ status: "ready" })
  expect(f.table("skills")).toHaveLength(1)
  const row = await f.run(readMaterializationRegistration(library, sourceId))
  expect(row.current?.content).toMatchObject({ plan: { base: { source: { commit } } } })
  expect(sourceStatuses(f)).toEqual(["applying", "ready"])
})

test("a newly selected commit cannot replace the legacy accepted Source commit", async () => {
  const f = await materializationFixture(root)
  setLegacy(f)
  const request = await f.request()
  expect(
    await f.materialize({
      ...request,
      target: { ...request.target, expected_source_commit: "f".repeat(40) },
    }),
  ).toMatchObject({
    status: "blocked",
    reason: "SOURCE_MATERIALIZATION_REVISION_CHANGED",
    effects: { remote_writes: "none" },
  })
  expect(f.preparedCount()).toBe(0)
  expect(f.mutations()).toEqual([])
})

test("legacy initialization resumes the frozen descriptor before Source Content exists", async () => {
  const f = await materializationFixture(root)
  setLegacy(f)
  const request = await f.request()
  let rejected = false
  const first = await f.runManaged(
    Effect.gen(function* () {
      const api = yield* Notion
      return yield* materializeRegisteredSource(library, request).pipe(
        Effect.provideService(Notion, {
          ...api,
          request: (path, body, options) => {
            if (
              !rejected &&
              path === `v1/pages/${f.sourcePage}` &&
              options?.method === "PATCH" &&
              property(property(body).properties)[library.sources.property_ids.Content!] !==
                undefined
            ) {
              rejected = true
              return Effect.fail(
                fail("REQUEST_BUDGET_EXHAUSTED", "Stopped before transport.", {
                  phase: "input_rejected",
                }),
              )
            }
            return api.request(path, body, options)
          },
        }),
      )
    }),
  )
  expect(first).toMatchObject({ records: [], reason: "REQUEST_BUDGET_EXHAUSTED" })
  expect(rejected).toBe(true)
  expect(
    text(field(f.pages.get(f.sourcePage), library.sources.property_ids.Content!).rich_text),
  ).toBe("")
  expect(
    text(
      field(f.pages.get(f.sourcePage), library.sources.property_ids["Last Revision"]!).rich_text,
    ),
  ).toBe(commit)
  expect(await f.materialize(request)).toMatchObject({ status: "ready" })
  expect(sourceStatuses(f).filter((state) => state === "ready")).toHaveLength(1)
})

test("unknown legacy Source PATCH remains pending and never replays from missing Content", async () => {
  const f = await materializationFixture(root)
  setLegacy(f)
  const request = await f.request()
  f.failNext({ kind: "source-properties", outcome: "absent" })
  const first = await f.materialize(request)
  expect(first).toMatchObject({ status: "pending", reason: "WRITE_OUTCOME_UNKNOWN", records: [] })
  f.clearCalls()
  expect(await f.materialize(request)).toMatchObject({
    status: "pending",
    operation_id: first.operation_id,
    reason: "CURRENT_OPERATION_UNRESOLVED",
    records: [],
  })
  expect(f.mutations()).toEqual([])
})

test("resumption refuses changed legacy revision without another semantic write", async () => {
  const f = await materializationFixture(root)
  setLegacy(f)
  const request = await f.request()
  f.failNext({ kind: "source-properties", outcome: "absent" })
  expect(await f.materialize(request)).toMatchObject({ status: "pending" })
  field(f.pages.get(f.sourcePage), library.sources.property_ids["Last Revision"]!).rich_text =
    sourceRich("b".repeat(40))
  f.clearCalls()
  expect(await f.materialize(request)).toMatchObject({
    status: "blocked",
    reason: "SOURCE_LEGACY_REGISTRATION_CHANGED",
    records: [],
  })
  expect(f.mutations()).toEqual([])
})

test("materialization writer requires the exact legacy descriptor in its frozen scope", async () => {
  const f = await materializationFixture(root)
  const raw = setLegacy(f)
  const registration = parseMaterializationRegistration(library, raw)
  const adoptions = []
  for (const name of ["root", "required", "sibling"])
    adoptions.push(
      await f.run(inspectSourceSkillAdoption(library, f.pages.get(f.owners.get(name)!))),
    )
  const scope = {
    source_page_id: f.sourcePage,
    registration_digest: await f.run(sourceRegistrationDigest(registration)),
    skill_ids: f.full.targets.map((target) => target.skill_id),
    adoptions,
  }
  for (const legacy of [
    undefined,
    { ...registration.legacy_registration!, last_revision: "f".repeat(40) },
  ]) {
    const result = await f.runManaged(
      writePreparedCurrentSource(library, {
        operation_id: "bad-legacy-scope",
        prepared: f.full,
        materialization: {
          ...scope,
          ...(legacy === undefined ? {} : { legacy_registration: legacy }),
        },
      }).pipe(Effect.result),
    )
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { code: "SOURCE_LEGACY_REGISTRATION_CHANGED" },
    })
    expect(f.mutations()).toEqual([])
  }
})

test("only the admitted management intent can activate the exact legacy Source owner", async () => {
  const f = await materializationFixture(root)
  const raw = setLegacy(f)
  const legacy = legacySourceRegistration(library, raw)!
  const base = {
    operation_id: "legacy-admission",
    owner: { kind: "source" as const, id: sourceId },
    input_sha256: "a".repeat(64),
    source_input: {
      kind: "declaration" as const,
      configuration_sha256: "b".repeat(64),
      resolved_commit: commit,
      affected_skill_ids: ["legacy-root"],
      retirements: [],
      materialization_sha256: "c".repeat(64),
      legacy_registration: legacy,
    },
  }
  const intent = Schema.decodeUnknownSync(CurrentOperationIntentSchema)(base)
  expect(currentOperationOwnerState(library, intent, f.sourcePage, raw)).toEqual({ state: "ready" })
  const {
    legacy_registration: _legacy,
    materialization_sha256: _scope,
    ...ordinary
  } = base.source_input
  expect(() =>
    currentOperationOwnerState(library, { ...base, source_input: ordinary }, f.sourcePage, raw),
  ).toThrow()
  expect(() =>
    Schema.decodeUnknownSync(CurrentOperationIntentSchema)({
      ...base,
      source_input: { ...ordinary, legacy_registration: legacy },
    }),
  ).toThrow()
  expect(() =>
    Schema.decodeUnknownSync(CurrentOperationIntentSchema)({
      ...base,
      source_input: { ...base.source_input, resolved_commit: "d".repeat(40) },
    }),
  ).toThrow()
  for (const mutate of [
    (copy: Record<string, unknown>) => {
      copy.id = "00000000-0000-4000-8000-000000000099"
    },
    (copy: Record<string, unknown>) => {
      copy.parent = { type: "data_source_id", data_source_id: library.skills.data_source_id }
    },
    (copy: Record<string, unknown>) => {
      field(copy, library.sources.property_ids["Source ID"]!).rich_text =
        sourceRich("another-source")
    },
    (copy: Record<string, unknown>) => {
      field(copy, library.sources.property_ids.Provider!).select = { name: "zip" }
    },
    (copy: Record<string, unknown>) => {
      field(copy, library.sources.property_ids.Content!).rich_text = sourceRich("{}")
    },
    (copy: Record<string, unknown>) => {
      field(copy, library.sources.property_ids.Operation!).rich_text = sourceRich("someone-else")
    },
    (copy: Record<string, unknown>) => {
      field(copy, library.sources.property_ids["Last Revision"]!).rich_text = sourceRich(
        "b".repeat(40),
      )
    },
  ]) {
    const copy = structuredClone(raw)
    mutate(copy)
    expect(() => currentOperationOwnerState(library, intent, f.sourcePage, copy)).toThrow()
  }
})

test("legacy read rejects unknown revision formats and populated current authority", async () => {
  const f = await materializationFixture(root)
  const raw = setLegacy(f)
  for (const revision of ["old-tag", "a".repeat(64)]) {
    field(raw, library.sources.property_ids["Last Revision"]!).rich_text = sourceRich(revision)
    expect(() => parseMaterializationRegistration(library, raw)).toThrow()
  }
  setLegacy(f, "")
  expect(await f.materialize(await f.request("inspect"))).toMatchObject({ status: "ready" })
  field(raw, library.sources.property_ids.Status!).select = { name: "applied" }
  expect(() => parseMaterializationRegistration(library, raw)).toThrow()
})

test("a legacy revision race after planning cannot activate the Source owner", async () => {
  const f = await materializationFixture(root)
  setLegacy(f)
  const request = await f.request()
  let changed = false
  f.rewrite((path, response) => {
    if (
      !changed &&
      path === `v1/pages/${f.sourcePage}` &&
      property(field(response, library.sources.property_ids.Status!).select).name === "applied" &&
      [...f.json.keys()].some((key) => key.startsWith("operations/current-source-materialization/"))
    ) {
      changed = true
      field(response, library.sources.property_ids["Last Revision"]!).rich_text = sourceRich(
        "b".repeat(40),
      )
      field(f.pages.get(f.sourcePage), library.sources.property_ids["Last Revision"]!).rich_text =
        sourceRich("b".repeat(40))
    }
    return response
  })
  expect(await f.materialize(request)).toMatchObject({
    status: "blocked",
    reason: "SOURCE_LEGACY_REGISTRATION_CHANGED",
    records: [],
  })
  expect(changed).toBe(true)
  expect(sourceStatuses(f)).toEqual([])
  expect(f.mutations()).toEqual([])
})
