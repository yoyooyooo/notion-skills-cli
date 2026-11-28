import { librarySchemaResponse } from "./library-schema-fixture.ts"
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Crypto, Effect, Layer, Schema } from "effect"
import { trashPath } from "../src/local-locks.ts"
import { fail, property, SkillsError, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import {
  withCurrentOperation,
  CurrentWritePendingSchema,
  cancelCurrentProjectionOperation,
  inspectCurrentOperation,
  readCurrentOperationIntent,
  type CurrentOperationIntent,
  type CurrentWriteMode,
  type CurrentOperationSession,
  type CurrentOperationAction,
  type CurrentProjectionCancellationSession,
} from "../src/shared-current-operation.ts"
import {
  authorizeCoordinatedSkillWrite,
  prepareCoordinatedSkillWrite,
} from "../src/shared-current-write.ts"
import type { SharedLibrary } from "../src/shared-library-model.ts"
import { currentLibrary } from "./shared-current-fixture.ts"
import { sha256, Store } from "../src/store.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"

const id = (n: number) => "00000000-0000-4000-8000-" + n.toString(16).padStart(12, "0")
const rich = (value: string) => [{ type: "text", text: { content: value } }]
const library: SharedLibrary = structuredClone(currentLibrary)
const intent = {
  operation_id: "write-example-1",
  owner: { kind: "skill" as const, id: "example" },
  input_sha256: "a".repeat(64),
}
const ownerId = id(20),
  productPath = "v1/blocks/" + ownerId + "/children"
const parent = mkdtempSync(join(tmpdir(), "ntn-current-operation-"))
afterAll(async () => {
  if (process.platform === "darwin") await Effect.runPromise(trashPath(parent))
})
function fields(input: unknown) {
  return Object.fromEntries(
    Object.entries(property(input)).map(([key, value]) => {
      const item = property(value)
      const type = ["title", "rich_text", "select", "relation", "files"].find(
        (name) => name in item,
      )
      return [
        key,
        {
          ...item,
          id: key,
          type,
          ...(type === "relation" || type === "rich_text" ? { has_more: false } : {}),
        },
      ]
    }),
  )
}
function matches(row: unknown, input: unknown): boolean {
  const filter = property(input)
  if (Array.isArray(filter.or)) return filter.or.some((value) => matches(row, value))
  if (Array.isArray(filter.and)) return filter.and.every((value) => matches(row, value))
  const value = property(property(property(row).properties)[String(filter.property)])
  if (filter.rich_text !== undefined)
    return text(value.rich_text) === property(filter.rich_text).equals
  return false
}
function fixture(
  options: {
    skillExists?: boolean
    sourceOwner?: Record<string, unknown>
    projection?: boolean
  } = {},
) {
  const sourceOwner = options.sourceOwner
  const projection = options.projection === true
  const root = mkdtempSync(join(parent, "case-")),
    json = new Map<string, unknown>()
  const records = new Map<string, Record<string, unknown>>(),
    files = new Map<string, Record<string, unknown>>(),
    values: string[] = []
  const calls: { path: string; body: unknown; method: string }[] = []
  const owner: Record<string, unknown> = {
    object: "page",
    id: ownerId,
    parent: { type: "data_source_id", data_source_id: library.skills.data_source_id },
    in_trash: false,
    properties: fields({
      "skill-id": { rich_text: rich(intent.owner.id) },
      state: { select: { name: "ready" } },
      operation: { rich_text: [] },
    }),
  }
  let count = 100
  let skillExists = options.skillExists ?? true
  let fault:
    | {
        target:
          | "product"
          | "record-create"
          | "retirement"
          | "record-replace"
          | "owner-rebind"
          | "owner-retirement"
          | "file-retirement"
        outcome: "visible" | "absent"
        error?: SkillsError
      }
    | undefined
  const api: Notion["Service"] = {
    version: Effect.succeed("2026-03-11"),
    credentialIdentity: Effect.succeed("current-operation-credential"),
    apiOrigin: "https://fixture.local",
    request: (path, body, options) =>
      Effect.gen(function* () {
        const method = options?.method ?? "GET",
          request = property(body)
        calls.push({ path, body, method })
        const schema = method === "GET" ? librarySchemaResponse(path, library) : undefined
        if (schema !== undefined) return schema
        if (path.startsWith("v1/data_sources/" + library.records.data_source_id + "/query"))
          return {
            object: "list",
            results: [...records.values()].filter(
              (row) => row.in_trash !== true && matches(row, request.filter),
            ),
            has_more: false,
            next_cursor: null,
          }
        if (path === "v1/pages" && method === "POST") {
          if (property(request.parent).data_source_id === library.skills.data_source_id) {
            expect(skillExists).toBe(false)
            skillExists = true
            owner.properties = fields(request.properties)
            return owner
          }
          const chosen = fault?.target === "record-create" ? fault : undefined
          if (chosen) fault = undefined
          const row = {
            object: "page",
            id: id(count++),
            parent: request.parent,
            properties: fields(request.properties),
            in_trash: false,
            last_edited_time: "2026-11-21T00:00:00.000Z",
          }
          if (chosen?.outcome !== "absent")
            (property(request.parent).data_source_id === library.files.data_source_id
              ? files
              : records
            ).set(row.id, row)
          if (chosen)
            return yield* Effect.fail(
              chosen.error ?? fail("WRITE_OUTCOME_UNKNOWN", "Record CREATE response lost."),
            )
          return row
        }
        if (path === productPath && method === (projection ? "PATCH" : "POST")) {
          const chosen = fault?.target === "product" ? fault : undefined
          if (chosen) fault = undefined
          expect(property(property(owner.properties).state).select).toEqual({
            name: projection ? "ready" : "applying",
          })
          if (chosen?.outcome !== "absent") values.push(String(request.value))
          if (chosen)
            return yield* Effect.fail(
              chosen.error ?? fail("WRITE_OUTCOME_UNKNOWN", "Product response lost."),
            )
          return { value: request.value }
        }
        if (sourceOwner !== undefined && path === "v1/pages/" + sourceOwner.id) {
          if (method === "PATCH")
            sourceOwner.properties = {
              ...property(sourceOwner.properties),
              ...fields(request.properties),
            }
          return sourceOwner
        }
        if (path === "v1/pages/" + ownerId) {
          if (!skillExists) return yield* Effect.fail(fail("NOT_FOUND", "Skill is not created."))
          if (method === "PATCH") {
            const chosen =
              (request.in_trash === true && fault?.target === "owner-retirement") ||
              (request.properties !== undefined && fault?.target === "owner-rebind")
                ? fault
                : undefined
            if (chosen) fault = undefined
            if (chosen?.outcome !== "absent") {
              if (request.in_trash === true) owner.in_trash = true
              if (request.properties !== undefined)
                owner.properties = { ...property(owner.properties), ...fields(request.properties) }
            }
            if (chosen)
              return yield* Effect.fail(
                chosen.error ?? fail("WRITE_OUTCOME_UNKNOWN", "Owner mutation response lost."),
              )
          }
          return owner
        }
        const row =
          records.get(path.replace("v1/pages/", "")) ?? files.get(path.replace("v1/pages/", ""))
        if (row !== undefined) {
          if (method === "PATCH") {
            const chosen =
              (request.in_trash === true && fault?.target === "retirement") ||
              (request.in_trash === true &&
                fault?.target === "file-retirement" &&
                files.has(String(row.id))) ||
              (request.properties !== undefined && fault?.target === "record-replace")
                ? fault
                : undefined
            if (chosen) fault = undefined
            if (chosen?.outcome !== "absent") {
              if (request.in_trash === true) row.in_trash = true
              if (request.properties !== undefined)
                row.properties = { ...property(row.properties), ...fields(request.properties) }
            }
            if (chosen)
              return yield* Effect.fail(
                chosen.error ?? fail("WRITE_OUTCOME_UNKNOWN", "Retirement response lost."),
              )
          }
          return row
        }
        if (path.startsWith("v1/pages/"))
          return yield* Effect.fail(fail("NOT_FOUND", "Page is unavailable."))
        return yield* Effect.fail(
          fail("UNEXPECTED", "Unexpected current operation request.", { path }),
        )
      }),
  }
  const store: Store["Service"] = {
    root,
    configRoot: root,
    cacheRoot: root,
    listKeys: (prefix) => Effect.succeed([...json.keys()].filter((key) => key.startsWith(prefix))),
    readJson: (key, schema) =>
      Effect.try({
        try: () =>
          json.has(key)
            ? Schema.decodeUnknownSync(schema)(structuredClone(json.get(key)))
            : undefined,
        catch: () => fail("STATE_CORRUPT", "Invalid current pending fixture."),
      }),
    writeJson: (key, value, options) =>
      Effect.try({
        try: () => {
          const previous = json.get(key)
          const before = property(previous),
            after = property(value)
          if (options !== undefined) {
            if (!("expectedCurrentWritePending" in options))
              throw fail(
                "INVALID_ARGUMENT",
                "This write fixture only models pending-operation guards.",
              )
            if (
              !/^operations\/current-write-pending\/[a-f0-9]{64}\/pending\.json$/u.test(key) ||
              previous === undefined ||
              canonicalSharedJson(previous) !==
                canonicalSharedJson(options.expectedCurrentWritePending) ||
              canonicalSharedJson(property(after.predecessor).intent) !==
                canonicalSharedJson(before.intent) ||
              canonicalSharedJson([
                before.version,
                before.scope,
                before.library_id,
                before.library,
                before.record_id,
                property(before.intent).owner,
              ]) !==
                canonicalSharedJson([
                  after.version,
                  after.scope,
                  after.library_id,
                  after.library,
                  after.record_id,
                  property(after.intent).owner,
                ])
            )
              throw fail("STATE_CONFLICT", "The fixture predecessor changed.")
          } else if (
            previous !== undefined &&
            key.startsWith("operations/current-write-pending/")
          ) {
            const identity = (row: Record<string, unknown>) =>
              canonicalSharedJson([
                row.version,
                row.scope,
                row.library_id,
                row.library,
                row.record_id,
                row.intent,
                row.completion,
                row.predecessor ?? null,
              ])
            if (identity(before) !== identity(after))
              throw fail("STATE_CONFLICT", "A fixture pending intent is immutable.")
          }
          json.set(key, structuredClone(value))
        },
        catch: () => fail("STATE_CONFLICT", "The current fixture state replacement was rejected."),
      }),
    retireKeys: (keys) =>
      Effect.sync(() =>
        keys.map((key) => {
          json.delete(key)
          return { key, retention_path: "current-cleared" }
        }),
      ),
    reserveCacheGeneration: () => Effect.die("Unexpected cache generation"),
    backup: () => Effect.die("Unexpected backup"),
    readBytes: () => Effect.die("Unexpected local bytes"),
    writeBytes: () => Effect.die("Unexpected local bytes"),
    output: () => Effect.die("Unexpected export"),
  }
  const layer = Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(Notion, api),
    Layer.succeed(Store, store),
  )
  const run = <A, E>(effect: Effect.Effect<A, E, Notion | Crypto.Crypto | Store>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)))
  const observerFreshness: boolean[] = []
  const action = (
    session: CurrentOperationSession,
    value = "first",
    replay: "never" | "idempotent" = "never",
  ) =>
    session.dispatch({
      key: "append:" + value,
      replay,
      request: {
        path: productPath,
        body: { value },
        options: { method: projection ? "PATCH" : "POST" },
      },
      observe: ({ fresh }) =>
        Effect.sync(() => {
          observerFreshness.push(fresh)
          return values.includes(value)
            ? { status: "complete" as const, value }
            : { status: "missing" as const }
        }),
      acknowledge: (response) =>
        Effect.try({
          try: () => {
            if (property(response).value !== value) throw new Error()
            return value
          },
          catch: () => fail("BAD_ACK", "Product ACK mismatched."),
        }),
    })
  const apply = (
    options: {
      mode?: CurrentWriteMode
      nextIntent?: CurrentOperationIntent
      values?: string[]
      replay?: "never" | "idempotent"
      verifyFailure?: boolean
      foreignOwner?: boolean
    } = {},
  ) =>
    withCurrentOperation(library, {
      intent: options.nextIntent ?? intent,
      ownerPageId: ownerId,
      mode: options.mode,
      run: (session) =>
        Effect.gen(function* () {
          for (const value of options.values ?? ["first"])
            yield* action(session, value, options.replay)
          return values.length
        }),
      verify: () =>
        Effect.gen(function* () {
          if (options.verifyFailure)
            return yield* Effect.fail(fail("CURRENT_TREE_INCOMPLETE", "Final scope is incomplete."))
          if (options.foreignOwner)
            owner.properties = {
              ...property(owner.properties),
              ...fields({
                state: { select: { name: "applying" } },
                operation: { rich_text: rich("another-operation") },
              }),
            }
          expect(values).toEqual(options.values ?? ["first"])
        }),
    })
  return {
    run,
    apply,
    action,
    values,
    calls,
    records,
    files,
    json,
    owner,
    observerFreshness,
    skillExists: () => skillExists,
    fault: (next: NonNullable<typeof fault>) => {
      fault = next
    },
    productRequests: () => calls.filter((call) => call.path === productPath).length,
    activeRecords: () => [...records.values()].filter((row) => row.in_trash !== true),
  }
}

async function sourceChildFixture() {
  const sourcePage = id(30)
  const sourceOwner: Record<string, unknown> = {
    object: "page",
    id: sourcePage,
    parent: { type: "data_source_id", data_source_id: library.sources.data_source_id },
    in_trash: false,
    properties: fields({
      "source-id": { rich_text: rich("provider") },
      status: { select: { name: "ready" } },
      operation: { rich_text: [] },
    }),
  }
  const f = fixture({ sourceOwner })
  f.owner.properties = {
    ...property(f.owner.properties),
    ...fields({
      state: { select: { name: "ready" } },
      content: {
        rich_text: rich(JSON.stringify({ kind: "native", mode: "100644", frontmatter: "" })),
      },
    }),
  }
  const selected = [
    {
      file_id: "existing-main",
      path: "SKILL.md",
      bytes: new TextEncoder().encode(
        "---\nname: example\ndescription: Source fixture.\n---\n\nRead the guide.\n",
      ),
    },
    {
      file_id: "existing-guide",
      path: "prompts/install-on-both-machines.md",
      bytes: new TextEncoder().encode("Keep both original files.\n"),
    },
  ]
  const revision = "d".repeat(64)
  const plan = await f.run(
    prepareCoordinatedSkillWrite({
      skill_id: intent.owner.id,
      kind: "skill",
      source: { source_id: "provider", revision },
      consumption_paths: selected.map((file) => file.path),
      consumption_sources: [{ source_id: "provider", revision }],
      create: { name: "Example", description: "Source fixture." },
      files: selected.map((file) => ({
        kind: "write",
        file: {
          ...file,
          authority: {
            kind: "source",
            source_id: "provider",
            revision,
            source_path: "skill/" + file.path,
          },
        },
      })),
    }),
  )
  const manifest = []
  for (const file of selected)
    manifest.push({
      path: "skill/" + file.path,
      sha256: await f.run(sha256(file.bytes)),
      bytes: file.bytes.byteLength,
      mode: "100644" as const,
    })
  const source = { source_id: "provider", page_id: sourcePage, revision, manifest }
  const parentIntent = {
    operation_id: "source-parent",
    owner: { kind: "source" as const, id: source.source_id },
    input_sha256: "b".repeat(64),
    source_input: {
      kind: "declaration" as const,
      configuration_sha256: "c".repeat(64),
      resolved_commit: "a".repeat(40),
      affected_skill_ids: [plan.skill_id],
      retirements: [],
    },
  }
  const childOperation =
    "source-target-" +
    (await f.run(sha256(canonicalSharedJson([parentIntent.operation_id, plan.skill_id]))))
  let childRuns = 0,
    childCompletedResumes = 0
  const verified = Effect.sync(() => {
    expect(f.values).toEqual(["first"])
    return "first"
  })
  const apply = (
    options: {
      mode?: "apply" | "resume"
      childCreateOutcome?: "visible" | "absent"
      stopAfterChild?: boolean
    } = {},
  ) =>
    withCurrentOperation(library, {
      intent: parentIntent,
      ownerPageId: sourcePage,
      mode: options.mode,
      verifyCompletedResume: () => verified,
      run: (parent) =>
        Effect.gen(function* () {
          const grant = yield* authorizeCoordinatedSkillWrite(parent, {
            plan,
            source,
            assertSourceCurrent: (raw) =>
              Effect.sync(() => {
                expect(property(raw).id).toBe(sourcePage)
                expect(
                  text(property(property(property(raw).properties)["source-id"]).rich_text),
                ).toBe(source.source_id)
              }),
          })
          if (options.childCreateOutcome !== undefined) {
            yield* parent.activate()
            f.fault({ target: "record-create", outcome: options.childCreateOutcome })
          }
          const value = yield* withCurrentOperation(library, {
            intent: {
              operation_id: childOperation,
              owner: { kind: "skill", id: plan.skill_id },
              input_sha256: plan.input_sha256,
              source: grant.source_intent,
            },
            ownerPageId: ownerId,
            mode: options.mode,
            assertScope: grant.assertCurrent,
            beforeMutation: grant.activate,
            afterActivate: grant.afterActivate,
            unstartedSourceChild: grant.unstarted ? grant.source_intent : undefined,
            verifyCompletedResume: () =>
              verified.pipe(Effect.tap(() => Effect.sync(() => childCompletedResumes++))),
            run: (child) =>
              Effect.gen(function* () {
                childRuns++
                yield* child.activate()
                expect(parent.sourceProgress).toEqual({ next_index: 0, child_started: true })
                expect(f.activeRecords()).toHaveLength(2)
                yield* grant.assertCurrent
                yield* child.assertCurrent()
                return yield* f.action(child)
              }),
            verify: () => Effect.asVoid(verified),
          })
          if (options.stopAfterChild)
            return yield* Effect.fail(fail("REQUEST_BUDGET_EXHAUSTED", "Stopped after child."))
          yield* parent.markSourceChildComplete(plan.skill_id)
          return value
        }),
      verify: () => Effect.asVoid(verified),
    })
  return {
    ...f,
    sourceChild: apply,
    sourceOwner,
    plan,
    childRuns: () => childRuns,
    childCompletedResumes: () => childCompletedResumes,
  }
}

describe("current Source-child operation", () => {
  test("a real parent grant activates the current child before product writes", async () => {
    const f = await sourceChildFixture()
    expect(await f.run(f.sourceChild())).toBe("first")
    expect(f.plan.files.map((file) => file.file_id)).toEqual(["existing-main", "existing-guide"])
    expect(property(property(f.owner.properties).state).select).toEqual({ name: "ready" })
    expect(property(property(f.sourceOwner.properties).status).select).toEqual({ name: "ready" })
    const mutations = f.calls.filter(
      (call) => call.method !== "GET" && !call.path.includes("/query"),
    )
    const parentApplying = mutations.findIndex(
      (call) =>
        property(property(property(property(call.body).properties).status).select).name ===
        "applying",
    )
    const childCreate = mutations.findIndex(
      (call, i) => i > parentApplying && call.path === "v1/pages" && call.method === "POST",
    )
    const childApplying = mutations.findIndex(
      (call) =>
        property(property(property(property(call.body).properties).state).select).name ===
        "applying",
    )
    expect(parentApplying).toBeGreaterThan(0)
    expect(childCreate).toBeGreaterThan(parentApplying)
    expect(childApplying).toBeGreaterThan(childCreate)
    expect(mutations.findIndex((call) => call.path === productPath)).toBeGreaterThan(childApplying)
    expect(f.activeRecords()).toEqual([])
    expect(f.json.size).toBe(0)
  })

  test.each(["visible", "absent"] as const)(
    "unknown child CREATE %s is never replayed",
    async (outcome) => {
      const f = await sourceChildFixture()
      expect(
        (await f.run(f.sourceChild({ childCreateOutcome: outcome }).pipe(Effect.result)))._tag,
      ).toBe("Failure")
      expect(f.productRequests()).toBe(0)
      expect(property(property(f.owner.properties).state).select).toEqual({ name: "ready" })
      const resumed = await f.run(f.sourceChild({ mode: "resume" }).pipe(Effect.result))
      if (outcome === "visible") expect(resumed._tag).toBe("Success")
      else
        expect(resumed).toMatchObject({
          _tag: "Failure",
          failure: { code: "CURRENT_OPERATION_UNRESOLVED" },
        })
      expect(
        f.calls.filter((call) => call.path === "v1/pages" && call.method === "POST"),
      ).toHaveLength(2)
    },
  )

  test("a completed child resumes the parent cursor without another child mutation", async () => {
    const f = await sourceChildFixture()
    expect(await f.run(f.sourceChild({ stopAfterChild: true }).pipe(Effect.result))).toMatchObject({
      _tag: "Failure",
      failure: { code: "REQUEST_BUDGET_EXHAUSTED" },
    })
    expect(property(property(f.owner.properties).state).select).toEqual({ name: "ready" })
    expect(f.activeRecords()).toHaveLength(1)
    expect(await f.run(f.sourceChild({ mode: "resume" }))).toBe("first")
    expect(f.childRuns()).toBe(1)
    expect(f.childCompletedResumes()).toBe(1)
    expect(f.productRequests()).toBe(1)
    expect(f.activeRecords()).toEqual([])
    const writes = f.calls.filter(
      (call) => call.method !== "GET" && !call.path.includes("/query"),
    ).length
    expect(await f.run(f.sourceChild({ mode: "resume" }))).toBe("first")
    expect(
      f.calls.filter((call) => call.method !== "GET" && !call.path.includes("/query")),
    ).toHaveLength(writes)
    expect(f.json.size).toBe(0)
  })
})

describe("exact Skill restoration permission", () => {
  const restoreIntent = {
    ...intent,
    restore: { page_id: ownerId, policy: { include: ["**/*.md"], exclude: [] } },
  }
  test("restoration cannot create, retire, supersede or select a different owner", async () => {
    for (const options of [
      { ownerPageId: id(900) },
      { completion: "retired" as const },
      { mode: { kind: "supersede" as const, operation_id: "old" } },
    ]) {
      const f = fixture()
      await expect(
        f.run(
          withCurrentOperation(library, {
            intent: restoreIntent,
            ownerPageId: null,
            ...options,
            run: () => Effect.void,
            verify: () => Effect.void,
          }),
        ),
      ).rejects.toMatchObject({ code: "CURRENT_OPERATION_INVALID" })
      expect(f.calls).toEqual([])
    }
  })
  test("restoration permits only the exact idempotent in_trash false request", async () => {
    for (const request of [
      { path: "v1/pages/" + ownerId, body: { in_trash: false, properties: {} } },
      { path: "v1/pages/" + ownerId, body: { in_trash: true } },
      { path: "v1/pages/" + id(900), body: { in_trash: false } },
      { path: productPath, body: { children: [] } },
      { path: "v1/pages", body: { parent: { data_source_id: library.skills.data_source_id } } },
    ]) {
      const f = fixture()
      await expect(
        f.run(
          withCurrentOperation(library, {
            intent: restoreIntent,
            ownerPageId: null,
            run: (session) =>
              session.dispatch({
                key: "$owner.restore",
                replay: "idempotent",
                request: { ...request, options: { method: "PATCH" } },
                observe: () => Effect.succeed({ status: "missing" as const }),
              }),
            verify: () => Effect.void,
          }),
        ),
      ).rejects.toMatchObject({ code: "CURRENT_OPERATION_INVALID" })
      expect(
        f.calls.filter((call) => call.method !== "GET" && !call.path.includes("/query")),
      ).toEqual([])
      expect(f.json.size).toBe(0)
    }
  })
})

describe("finite reading projection", () => {
  const projectionIntent = {
    ...intent,
    projection: true as const,
    policy: { include: ["**/*.md"], exclude: [] },
  }
  const cancellationAction = (
    f: ReturnType<typeof fixture>,
    replay: "never" | "idempotent" = "never",
  ): CurrentOperationAction<void> => ({
    key: "append:first",
    replay,
    request: { path: productPath, body: { value: "first" }, options: { method: "PATCH" } },
    observe: ({ fresh }) =>
      Effect.sync(() => {
        f.observerFreshness.push(fresh)
        return f.values.includes("first")
          ? { status: "complete" as const, value: undefined }
          : { status: "missing" as const }
      }),
    acknowledge: () => Effect.die("Cancellation must not acknowledge a new body request"),
  })
  const cancel = (
    f: ReturnType<typeof fixture>,
    reconcile = (session: CurrentProjectionCancellationSession) =>
      session.reconcilePendingAction(cancellationAction(f)),
  ) =>
    cancelCurrentProjectionOperation(library, {
      intent: projectionIntent,
      ownerPageId: ownerId,
      reconcile,
    })
  const ready = (f: ReturnType<typeof fixture>) => {
    expect(property(property(f.owner.properties).state).select).toEqual({ name: "ready" })
    expect(text(property(property(f.owner.properties).operation).rich_text)).toBe("")
    expect(
      f.calls.filter((call) => call.path === "v1/pages/" + ownerId && call.method === "PATCH"),
    ).toEqual([])
  }

  test("generated bodies use one finite intent without changing owner metadata or readiness", async () => {
    const f = fixture({ projection: true })
    const before = structuredClone(f.owner)
    expect(
      await f.run(
        withCurrentOperation(library, {
          intent: projectionIntent,
          ownerPageId: ownerId,
          run: (session) =>
            Effect.gen(function* () {
              yield* session.activate()
              yield* session.assertCurrent()
              yield* f.action(session)
              yield* session.assertCurrent()
              return "first"
            }),
          verify: () => Effect.void,
        }),
      ),
    ).toBe("first")
    ready(f)
    expect(f.owner).toEqual(before)
    expect(f.activeRecords()).toEqual([])
    expect(f.json.size).toBe(0)
    const writes = f.calls.filter(
      (call) => call.method !== "GET" && !call.path.includes("/query"),
    ).length
    expect(await f.run(f.apply({ nextIntent: projectionIntent }))).toBe(1)
    expect(
      f.calls.filter((call) => call.method !== "GET" && !call.path.includes("/query")),
    ).toHaveLength(writes)
  })

  test("unknown accepted append preserves consumption and excludes content writers until exact resume", async () => {
    const f = fixture({ projection: true })
    f.fault({ target: "product", outcome: "visible" })
    expect(
      await f.run(f.apply({ nextIntent: projectionIntent }).pipe(Effect.result)),
    ).toMatchObject({ _tag: "Failure", failure: { code: "WRITE_OUTCOME_UNKNOWN" } })
    ready(f)
    expect(f.activeRecords()).toHaveLength(1)
    const current = await f.run(inspectCurrentOperation(library, intent.owner))
    expect(current).toMatchObject({
      intent: projectionIntent,
      owner_state: { state: "ready" },
      in_flight: { key: "append:first", replay: "never" },
    })
    for (const mode of ["apply", { kind: "supersede", operation_id: intent.operation_id }] as const)
      expect(
        await f.run(
          f
            .apply({ mode, nextIntent: { ...intent, operation_id: "content-next" } })
            .pipe(Effect.result),
        ),
      ).toMatchObject({
        _tag: "Failure",
        failure: { code: "CURRENT_OPERATION_PENDING", details: { projection: true } },
      })
    expect(f.productRequests()).toBe(1)
    ready(f)
    expect(await f.run(f.apply({ nextIntent: projectionIntent, mode: "resume" }))).toBe(1)
    expect(f.productRequests()).toBe(1)
    expect(f.activeRecords()).toEqual([])
    expect(f.json.size).toBe(0)
    ready(f)
  })

  test("unknown absent append is never replayed and leaves the Skill consumable", async () => {
    const f = fixture({ projection: true })
    f.fault({ target: "product", outcome: "absent" })
    await f.run(f.apply({ nextIntent: projectionIntent }).pipe(Effect.result))
    expect(
      await f.run(f.apply({ nextIntent: projectionIntent, mode: "resume" }).pipe(Effect.result)),
    ).toMatchObject({ _tag: "Failure", failure: { code: "CURRENT_OPERATION_UNRESOLVED" } })
    expect(f.productRequests()).toBe(1)
    expect(f.activeRecords()).toHaveLength(1)
    ready(f)
  })

  test("cancellation observes only the accepted pending action and never finishes the remaining plan", async () => {
    const f = fixture({ projection: true })
    const before = structuredClone(f.owner)
    f.fault({ target: "product", outcome: "visible" })
    await f.run(
      f.apply({ nextIntent: projectionIntent, values: ["first", "remaining"] }).pipe(Effect.result),
    )
    const previousObservations = f.observerFreshness.length
    expect(
      await f.run(
        cancel(f, (session) => {
          expect(Object.hasOwn(session, "dispatch")).toBe(false)
          expect(Object.hasOwn(session, "activate")).toBe(false)
          expect(session.pendingActionKey).toBe("append:first")
          return session.reconcilePendingAction(cancellationAction(f))
        }),
      ),
    ).toEqual({
      status: "cancelled",
      operation_id: intent.operation_id,
      input_sha256: intent.input_sha256,
    })
    expect(f.observerFreshness.slice(previousObservations)).toEqual([true])
    expect(f.values).toEqual(["first"])
    expect(f.productRequests()).toBe(1)
    expect(f.activeRecords()).toEqual([])
    expect(f.json.size).toBe(0)
    expect(f.owner).toEqual(before)
    ready(f)
    const writes = f.calls.filter(
      (call) => call.method !== "GET" && !call.path.includes("/query"),
    ).length
    expect(await f.run(cancel(f, () => Effect.die("No pending action exists")))).toMatchObject({
      status: "not_found",
      operation_id: intent.operation_id,
    })
    expect(
      f.calls.filter((call) => call.method !== "GET" && !call.path.includes("/query")),
    ).toHaveLength(writes)
    expect(f.json.size).toBe(0)
  })

  test("cancellation without an in-flight action retires only the existing Record", async () => {
    const f = fixture({ projection: true })
    await f.run(
      withCurrentOperation(library, {
        intent: projectionIntent,
        ownerPageId: ownerId,
        run: (session) =>
          session
            .activate()
            .pipe(Effect.andThen(Effect.fail(fail("CANCELLED", "Stopped before body dispatch")))),
        verify: () => Effect.void,
      }).pipe(Effect.result),
    )
    expect(f.activeRecords()).toHaveLength(1)
    expect(await f.run(cancel(f, () => Effect.die("No action needs observation")))).toMatchObject({
      status: "cancelled",
    })
    expect(f.productRequests()).toBe(0)
    expect(f.activeRecords()).toEqual([])
    expect(f.json.size).toBe(0)
    ready(f)
  })

  test("a matching not-dispatched proof cancels without observing or retrying the rejected request", async () => {
    const f = fixture({ projection: true })
    f.fault({
      target: "product",
      outcome: "absent",
      error: fail("REQUEST_BUDGET_EXHAUSTED", "Budget refused dispatch."),
    })
    await f.run(f.apply({ nextIntent: projectionIntent }).pipe(Effect.result))
    expect(
      [...f.json.values()].some(
        (value) => property(property(value).not_dispatched).key === "append:first",
      ),
    ).toBe(true)
    expect(
      await f.run(cancel(f, () => Effect.die("Rejected request needs no observation"))),
    ).toMatchObject({ status: "cancelled" })
    expect(f.productRequests()).toBe(1)
    expect(f.values).toEqual([])
    expect(f.activeRecords()).toEqual([])
    expect(f.json.size).toBe(0)
    ready(f)
  })

  test.each(["never", "idempotent"] as const)(
    "cancellation never dispatches an absent %s action",
    async (replay) => {
      const f = fixture({ projection: true })
      f.fault({ target: "product", outcome: "absent" })
      await f.run(f.apply({ nextIntent: projectionIntent, replay }).pipe(Effect.result))
      const pending = structuredClone([...f.json.entries()])
      const calls = f.calls.length
      expect(
        await f.run(
          cancel(f, (session) =>
            session.reconcilePendingAction(cancellationAction(f, replay)),
          ).pipe(Effect.result),
        ),
      ).toMatchObject({
        _tag: "Failure",
        failure: { code: "CURRENT_OPERATION_UNRESOLVED" },
      })
      expect(
        f.calls
          .slice(calls)
          .filter((call) => call.method !== "GET" && !call.path.includes("/query")),
      ).toEqual([])
      expect([...f.json.entries()]).toEqual(pending)
      expect(f.activeRecords()).toHaveLength(1)
      expect(f.productRequests()).toBe(1)
      ready(f)
    },
  )

  test.each(["key", "request", "replay"] as const)(
    "cancellation rejects a different pending %s before observation",
    async (changed) => {
      const f = fixture({ projection: true })
      f.fault({ target: "product", outcome: "visible" })
      await f.run(f.apply({ nextIntent: projectionIntent }).pipe(Effect.result))
      const original = cancellationAction(f)
      const altered: CurrentOperationAction<void> = {
        ...original,
        ...(changed === "key" ? { key: "append:remaining" } : {}),
        ...(changed === "request"
          ? { request: { ...original.request, body: { value: "different" } } }
          : {}),
        ...(changed === "replay" ? { replay: "idempotent" } : {}),
        observe: () => Effect.die("A different marker must not be observed"),
      }
      const calls = f.calls.length
      expect(
        await f.run(
          cancel(f, (session) => session.reconcilePendingAction(altered)).pipe(Effect.result),
        ),
      ).toMatchObject({
        _tag: "Failure",
        failure: { code: "CURRENT_OPERATION_CONFLICT" },
      })
      expect(
        f.calls
          .slice(calls)
          .filter((call) => call.method !== "GET" && !call.path.includes("/query")),
      ).toEqual([])
      expect(f.activeRecords()).toHaveLength(1)
      expect(f.json.size).toBe(1)
      ready(f)
    },
  )

  test("an incomplete or mismatched observed prefix keeps the cancellation pending", async () => {
    const f = fixture({ projection: true })
    f.fault({ target: "product", outcome: "visible" })
    await f.run(f.apply({ nextIntent: projectionIntent }).pipe(Effect.result))
    const calls = f.calls.length
    expect(
      await f.run(
        cancel(f, (session) =>
          session.reconcilePendingAction({
            ...cancellationAction(f),
            observe: () =>
              Effect.fail(
                fail("CURRENT_PROJECTION_CONFLICT", "The visible batch is partial or differs."),
              ),
          }),
        ).pipe(Effect.result),
      ),
    ).toMatchObject({
      _tag: "Failure",
      failure: { code: "CURRENT_PROJECTION_CONFLICT" },
    })
    expect(
      f.calls.slice(calls).filter((call) => call.method !== "GET" && !call.path.includes("/query")),
    ).toEqual([])
    expect(f.activeRecords()).toHaveLength(1)
    expect(f.json.size).toBe(1)
    ready(f)
  })

  test.each(["visible", "absent"] as const)(
    "cancel retirement %s recovers without observing or writing a body again",
    async (outcome) => {
      const f = fixture({ projection: true })
      f.fault({ target: "product", outcome: "visible" })
      await f.run(f.apply({ nextIntent: projectionIntent }).pipe(Effect.result))
      f.fault({ target: "retirement", outcome })
      expect(await f.run(cancel(f).pipe(Effect.result))).toMatchObject({
        _tag: "Failure",
        failure: { code: "WRITE_OUTCOME_UNKNOWN" },
      })
      expect([...f.json.values()]).toMatchObject([{ lifecycle: { phase: "retiring" } }])
      if (outcome === "absent") {
        const writes = f.calls.filter(
          (call) => call.method !== "GET" && !call.path.includes("/query"),
        ).length
        await expect(f.run(cancel(f))).rejects.toMatchObject({
          code: "CURRENT_OPERATION_UNRESOLVED",
        })
        expect(
          f.calls.filter((call) => call.method !== "GET" && !call.path.includes("/query")),
        ).toHaveLength(writes)
        expect(f.json.size).toBe(1)
        return
      }
      expect(
        await f.run(cancel(f, () => Effect.die("Retiring intent has no new body work"))),
      ).toMatchObject({ status: "cancelled" })
      expect(f.activeRecords()).toEqual([])
      expect(f.json.size).toBe(0)
      expect(f.productRequests()).toBe(1)
      ready(f)
    },
  )

  test("cancellation cannot retire its Record after the owner becomes unready", async () => {
    const f = fixture({ projection: true })
    f.fault({ target: "product", outcome: "visible" })
    await f.run(f.apply({ nextIntent: projectionIntent }).pipe(Effect.result))
    expect(
      await f.run(
        cancel(f, (session) =>
          session.reconcilePendingAction({
            ...cancellationAction(f),
            observe: () =>
              Effect.sync(() => {
                f.owner.properties = {
                  ...property(f.owner.properties),
                  ...fields({
                    state: { select: { name: "applying" } },
                    operation: { rich_text: rich("another-operation") },
                  }),
                }
                return { status: "complete" as const, value: undefined }
              }),
          }),
        ).pipe(Effect.result),
      ),
    ).toMatchObject({
      _tag: "Failure",
      failure: { code: "CURRENT_OPERATION_CONFLICT" },
    })
    expect(f.activeRecords()).toHaveLength(1)
    expect(f.json.size).toBe(1)
    expect(f.productRequests()).toBe(1)
    expect(
      f.calls.filter((call) => call.path === "v1/pages/" + ownerId && call.method === "PATCH"),
    ).toEqual([])
  })

  test("content intents have no cancellation route", async () => {
    const f = fixture()
    expect(
      await f.run(
        cancelCurrentProjectionOperation(library, {
          // @ts-expect-error A content writer cannot call projection cancellation.
          intent,
          ownerPageId: ownerId,
          reconcile: () => Effect.die("A content cancellation must fail before reconciliation"),
        }).pipe(Effect.result),
      ),
    ).toMatchObject({
      _tag: "Failure",
      failure: { code: "CURRENT_OPERATION_INVALID" },
    })
    expect(f.calls).toEqual([])
    expect(f.json.size).toBe(0)
  })

  test("failed full readback preserves ready and resumes its existing generated body", async () => {
    const f = fixture({ projection: true })
    expect(
      await f.run(
        f.apply({ nextIntent: projectionIntent, verifyFailure: true }).pipe(Effect.result),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { code: "CURRENT_TREE_INCOMPLETE" } })
    ready(f)
    expect(await f.run(f.apply({ nextIntent: projectionIntent, mode: "resume" }))).toBe(1)
    expect(f.productRequests()).toBe(1)
    expect(f.activeRecords()).toEqual([])
    expect(f.json.size).toBe(0)
    ready(f)
  })

  test("lost Record retirement acknowledgement resumes without any owner ready write", async () => {
    const f = fixture({ projection: true })
    f.fault({ target: "retirement", outcome: "visible" })
    expect(
      await f.run(f.apply({ nextIntent: projectionIntent }).pipe(Effect.result)),
    ).toMatchObject({ _tag: "Failure", failure: { code: "WRITE_OUTCOME_UNKNOWN" } })
    expect(f.json.size).toBe(1)
    ready(f)
    expect(await f.run(f.apply({ nextIntent: projectionIntent, mode: "resume" }))).toBe(1)
    expect(f.productRequests()).toBe(1)
    expect(f.json.size).toBe(0)
    ready(f)
  })

  test("projection rejects owner creation, retirement and supersede before remote work", async () => {
    for (const options of [
      { ownerPageId: null },
      { completion: "retired" as const },
      { mode: { kind: "supersede" as const, operation_id: "previous" } },
    ]) {
      const f = fixture({ projection: true })
      expect(
        await f.run(
          withCurrentOperation(library, {
            intent: projectionIntent,
            ownerPageId: ownerId,
            ...options,
            run: () => Effect.void,
            verify: () => Effect.void,
          }).pipe(Effect.result),
        ),
      ).toMatchObject({ _tag: "Failure", failure: { code: "CURRENT_OPERATION_INVALID" } })
      expect(f.calls).toEqual([])
    }
  })

  test("projection dispatch cannot mutate owner metadata and cannot rebind its owner", async () => {
    for (const action of ["metadata", "binding"] as const) {
      const f = fixture({ projection: true })
      expect(
        await f.run(
          withCurrentOperation(library, {
            intent: projectionIntent,
            ownerPageId: ownerId,
            run: (session) =>
              action === "binding"
                ? session.bindOwner(ownerId)
                : session.dispatch({
                    key: "metadata",
                    replay: "idempotent",
                    request: {
                      path: "v1/pages/" + ownerId,
                      body: { properties: { state: { select: { name: "applying" } } } },
                      options: { method: "PATCH" },
                    },
                    observe: () => Effect.succeed({ status: "missing" as const }),
                  }),
            verify: () => Effect.void,
          }).pipe(Effect.result),
        ),
      ).toMatchObject({ _tag: "Failure", failure: { code: "CURRENT_OPERATION_INVALID" } })
      expect(f.activeRecords()).toEqual([])
      expect(f.json.size).toBe(0)
      ready(f)
    }
  })

  const sourceContent = {
    kind: "source" as const,
    source_id: "reading-source",
    source_path: "skills/example/references/guide.md",
    revision: "c".repeat(64),
    sha256: "d".repeat(64),
    bytes: 12,
    mode: "100644" as const,
  }
  const fileProperties = () => ({
    [library.files.property_ids.Name!]: { title: rich("references/guide.md") },
    [library.files.property_ids["File ID"]!]: { rich_text: rich("reading-guide") },
    [library.files.property_ids.Path!]: { rich_text: rich("references/guide.md") },
    [library.files.property_ids.Skill!]: { relation: [{ id: ownerId }] },
    [library.files.property_ids.Content!]: { rich_text: rich(JSON.stringify(sourceContent)) },
  })
  const seedFile = (f: ReturnType<typeof fixture>) => {
    const row = {
      object: "page",
      id: id(40),
      parent: { type: "data_source_id", data_source_id: library.files.data_source_id },
      in_trash: false,
      last_edited_time: "2026-11-21T00:00:00.000Z",
      properties: fields(fileProperties()),
    }
    f.files.set(row.id, row)
    return row
  }
  const fileAction = (
    f: ReturnType<typeof fixture>,
    request: CurrentOperationAction<void>["request"],
  ): CurrentOperationAction<void> => ({
    key: "reading-file:" + request.path,
    replay: request.options?.method === "POST" ? "never" : "idempotent",
    request,
    observe: () =>
      Effect.sync(() => {
        const row =
          request.path === "v1/pages"
            ? [...f.files.values()].find(
                (row) =>
                  text(
                    property(property(row.properties)[library.files.property_ids["File ID"]!])
                      .rich_text,
                  ) === "reading-guide",
              )
            : f.files.get(request.path.replace("v1/pages/", ""))
        const wanted = property(request.body)
        const complete =
          row !== undefined &&
          (request.path === "v1/pages" ||
            (wanted.in_trash === true
              ? row.in_trash === true
              : Object.entries(property(wanted.properties)).every(
                  ([key, value]) =>
                    text(property(property(row.properties)[key]).rich_text) ===
                    text(property(value).rich_text),
                )))
        return complete
          ? { status: "complete" as const, value: undefined }
          : { status: "missing" as const }
      }),
  })
  const writeFile = (
    f: ReturnType<typeof fixture>,
    action: CurrentOperationAction<void>,
    mode?: CurrentWriteMode,
  ) =>
    withCurrentOperation(library, {
      intent: projectionIntent,
      ownerPageId: ownerId,
      mode,
      run: (session) => session.dispatch(action),
      verify: () => Effect.void,
    })

  test("projection can create and remap one source File without changing its owner or binding", async () => {
    const f = fixture({ projection: true })
    await f.run(
      writeFile(
        f,
        fileAction(f, {
          path: "v1/pages",
          options: { method: "POST" },
          body: {
            parent: { type: "data_source_id", data_source_id: library.files.data_source_id },
            properties: fileProperties(),
          },
        }),
      ),
    )
    const before = structuredClone([...f.files.values()][0]!)
    const next = {
      ...sourceContent,
      source_id: "replacement-source",
      source_path: "new/guide.md",
      revision: "e".repeat(64),
    }
    await f.run(
      writeFile(
        f,
        fileAction(f, {
          path: `v1/pages/${before.id}`,
          options: { method: "PATCH" },
          body: {
            properties: {
              [library.files.property_ids.Content!]: { rich_text: rich(JSON.stringify(next)) },
            },
          },
        }),
      ),
    )
    const after = f.files.get(String(before.id))!
    expect(
      JSON.parse(
        text(property(property(after.properties)[library.files.property_ids.Content!]).rich_text),
      ),
    ).toEqual(next)
    for (const name of ["Name", "File ID", "Path", "Skill"])
      expect(property(after.properties)[library.files.property_ids[name]!]).toEqual(
        property(before.properties)[library.files.property_ids[name]!],
      )
    expect(f.activeRecords()).toEqual([])
    expect(f.json.size).toBe(0)
    ready(f)
  })

  test.each([
    "foreign-parent",
    "foreign-owner",
    "native",
    "resource",
    "extra-property",
    "changed-path",
  ] as const)(
    "projection rejects a %s File mutation before any remote mutation",
    async (change) => {
      const f = fixture({ projection: true }),
        row = seedFile(f)
      const native = { kind: "native", frontmatter: "", mode: "100644" }
      if (change === "foreign-parent") row.parent.data_source_id = library.skills.data_source_id
      if (change === "foreign-owner")
        property(row.properties[library.files.property_ids.Skill!]).relation = [{ id: id(90) }]
      if (change === "native" || change === "resource")
        property(row.properties[library.files.property_ids.Content!]).rich_text = rich(
          JSON.stringify(
            change === "native"
              ? native
              : {
                  kind: "resource",
                  object_id: "resource-" + "f".repeat(64),
                  sha256: "f".repeat(64),
                  bytes: 12,
                  mode: "100644",
                },
          ),
        )
      const properties: Record<string, unknown> = {
        [library.files.property_ids.Content!]: {
          rich_text: rich(JSON.stringify({ ...sourceContent, revision: "e".repeat(64) })),
        },
      }
      if (change === "extra-property") properties["daily"] = { checkbox: true }
      if (change === "changed-path")
        properties[library.files.property_ids.Path!] = { rich_text: rich("different.md") }
      const result = await f.run(
        writeFile(
          f,
          fileAction(f, {
            path: `v1/pages/${row.id}`,
            options: { method: "PATCH" },
            body: { properties },
          }),
        ).pipe(Effect.result),
      )
      expect(result._tag).toBe("Failure")
      expect(
        f.calls.filter((call) => call.method !== "GET" && !call.path.includes("/query")),
      ).toEqual([])
      expect(f.json.size).toBe(0)
      ready(f)
    },
  )

  test("projection rejects File takeover between observation and metadata dispatch", async () => {
    const f = fixture({ projection: true }),
      row = seedFile(f)
    const action = fileAction(f, {
      path: `v1/pages/${row.id}`,
      options: { method: "PATCH" },
      body: { in_trash: true },
    })
    const result = await f.run(
      writeFile(f, {
        ...action,
        observe: () =>
          Effect.sync(() => {
            property(row.properties[library.files.property_ids.Content!]).rich_text = rich(
              JSON.stringify({ kind: "native", frontmatter: "", mode: "100644" }),
            )
            return { status: "missing" as const }
          }),
      }).pipe(Effect.result),
    )
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { code: "CURRENT_OPERATION_INVALID" },
    })
    expect(
      f.calls.filter((call) => call.path === `v1/pages/${row.id}` && call.method === "PATCH"),
    ).toEqual([])
    expect(row.in_trash).toBe(false)
    ready(f)
  })

  test("projection keeps an ambiguous archive pending even when its target is currently archived", async () => {
    const f = fixture({ projection: true }),
      row = seedFile(f)
    const action = fileAction(f, {
      path: `v1/pages/${row.id}`,
      options: { method: "PATCH" },
      body: { in_trash: true },
    })
    f.fault({ target: "file-retirement", outcome: "visible" })
    expect(await f.run(writeFile(f, action).pipe(Effect.result))).toMatchObject({
      _tag: "Failure",
      failure: { code: "WRITE_OUTCOME_UNKNOWN" },
    })
    expect(row.in_trash).toBe(true)
    await expect(f.run(writeFile(f, action, "resume"))).rejects.toMatchObject({
      code: "CURRENT_OPERATION_UNRESOLVED",
    })
    expect(
      f.calls.filter((call) => call.path === `v1/pages/${row.id}` && call.method === "PATCH"),
    ).toHaveLength(1)
    expect(f.activeRecords()).toHaveLength(1)
    expect(f.json.size).toBe(1)
    ready(f)
  })

  test("an owner becoming unready during projection cannot be republished by completion", async () => {
    const f = fixture({ projection: true })
    expect(
      await f.run(
        f.apply({ nextIntent: projectionIntent, foreignOwner: true }).pipe(Effect.result),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { code: "CURRENT_OPERATION_CONFLICT" } })
    expect(property(property(f.owner.properties).state).select).toEqual({ name: "applying" })
    expect(text(property(property(f.owner.properties).operation).rich_text)).toBe(
      "another-operation",
    )
    expect(
      f.calls.filter((call) => call.path === "v1/pages/" + ownerId && call.method === "PATCH"),
    ).toEqual([])
    expect(f.activeRecords()).toHaveLength(1)
  })
})

describe("one finite current write", () => {
  test("a complete current scope remains a true remote and local no-op", async () => {
    const f = fixture()
    f.values.push("first")
    expect(await f.run(f.apply())).toBe(1)
    expect(
      f.calls.filter((call) => call.method !== "GET" && !call.path.includes("/query")),
    ).toHaveLength(0)
    expect(f.records.size).toBe(0)
    expect(f.json.size).toBe(0)
  })
  test("writes through applying, verifies the actual result, then clears owner and current intent", async () => {
    const f = fixture()
    expect(await f.run(f.apply())).toBe(1)
    expect(f.productRequests()).toBe(1)
    expect(f.activeRecords()).toHaveLength(0)
    expect(f.json.size).toBe(0)
    expect(property(property(f.owner.properties).state).select).toEqual({ name: "ready" })
    expect(text(property(property(f.owner.properties).operation).rich_text)).toBe("")
    expect([...f.records.values()]).toHaveLength(1)
  })
  test("new Skill creation binds its current intent before any content write", async () => {
    const f = fixture({ skillExists: false })
    const result = withCurrentOperation(library, {
      intent,
      ownerPageId: null,
      run: (session) =>
        Effect.gen(function* () {
          const page = yield* session.dispatch<string, never>({
            key: "create-skill",
            replay: "never",
            request: {
              path: "v1/pages",
              options: { method: "POST" },
              body: {
                parent: { type: "data_source_id", data_source_id: library.skills.data_source_id },
                properties: {
                  "skill-id": { rich_text: rich(intent.owner.id) },
                  state: { select: { name: "applying" } },
                  operation: { rich_text: rich(intent.operation_id) },
                },
              },
            },
            observe: () =>
              Effect.succeed(
                f.skillExists()
                  ? { status: "complete" as const, value: ownerId }
                  : { status: "missing" as const },
              ),
            acknowledge: () => Effect.succeed(ownerId),
          })
          yield* session.bindOwner(page)
          expect(session.ownerPageId).toBe(ownerId)
          expect(session.pendingActionKey).toBeUndefined()
          return yield* f.action(session)
        }),
      verify: () =>
        Effect.sync(() => {
          expect(f.values).toEqual(["first"])
        }),
    })
    expect(await f.run(result)).toBe("first")
    expect(f.json.size).toBe(0)
    const record = [...f.records.values()][0]
    expect(property(property(record?.properties).skill).relation).toEqual([{ id: ownerId }])
    expect(f.activeRecords()).toHaveLength(0)
    expect(property(property(f.owner.properties).state).select).toEqual({ name: "ready" })
  })
  test("a pending multipart request binds the part number as well as its exact bytes", async () => {
    const f = fixture()
    const attempt = (partNumber: number, mode: "apply" | "resume") =>
      withCurrentOperation(library, {
        intent,
        ownerPageId: ownerId,
        mode,
        run: (session) =>
          session.dispatch({
            key: "upload:part",
            replay: "never",
            fileSha256: "c".repeat(64),
            request: {
              path: productPath,
              body: { value: "part" },
              options: { method: "POST", file: "/fixture/part", partNumber },
            },
            observe: () => Effect.succeed({ status: "missing" as const }),
          }),
        verify: () => Effect.void,
      })
    f.fault({ target: "product", outcome: "absent" })
    await f.run(attempt(1, "apply").pipe(Effect.result))
    const changed = await f.run(attempt(2, "resume").pipe(Effect.result))
    expect(changed._tag).toBe("Failure")
    if (changed._tag === "Failure") expect(changed.failure.code).toBe("CURRENT_OPERATION_CONFLICT")
    expect(f.productRequests()).toBe(1)
  })
  test("observes an unknown accepted append and never repeats it", async () => {
    const f = fixture()
    f.fault({ target: "product", outcome: "visible" })
    expect((await f.run(f.apply().pipe(Effect.result)))._tag).toBe("Failure")
    expect(f.productRequests()).toBe(1)
    expect(f.activeRecords()).toHaveLength(1)
    expect(await f.run(f.apply({ mode: "resume" }))).toBe(1)
    expect(f.productRequests()).toBe(1)
    expect(f.observerFreshness).toContain(true)
    expect(f.json.size).toBe(0)
  })
  test("unknown invisible append stays actionable and rejects changed input", async () => {
    const f = fixture()
    f.fault({ target: "product", outcome: "absent" })
    await f.run(f.apply().pipe(Effect.result))
    const resumed = await f.run(f.apply({ mode: "resume" }).pipe(Effect.result))
    expect(resumed._tag).toBe("Failure")
    if (resumed._tag === "Failure") {
      expect(resumed.failure.code).toBe("CURRENT_OPERATION_UNRESOLVED")
      expect(property(resumed.failure.details).next).toBe("reconcile_current")
      expect(property(resumed.failure.details).input_sha256).toBe(intent.input_sha256)
    }
    const changed = await f.run(
      f.apply({ nextIntent: { ...intent, input_sha256: "b".repeat(64) } }).pipe(Effect.result),
    )
    expect(changed._tag).toBe("Failure")
    expect(f.productRequests()).toBe(1)
    expect(f.json.size).toBe(1)
  })
  test.each(["absent", "visible"] as const)(
    "unknown idempotent action %s is neither replayed nor settled by current equality",
    async (outcome) => {
      const f = fixture()
      f.fault({ target: "product", outcome })
      await expect(f.run(f.apply({ replay: "idempotent" }))).rejects.toMatchObject({
        code: "WRITE_OUTCOME_UNKNOWN",
      })
      const writes = f.calls.filter(
        (call) => call.method !== "GET" && !call.path.includes("/query"),
      ).length
      await expect(f.run(f.apply({ mode: "resume", replay: "idempotent" }))).rejects.toMatchObject({
        code: "CURRENT_OPERATION_UNRESOLVED",
      })
      expect(
        f.calls.filter((call) => call.method !== "GET" && !call.path.includes("/query")),
      ).toHaveLength(writes)
      expect(f.productRequests()).toBe(1)
      expect(f.json.size).toBe(1)
    },
  )

  test("completed earlier actions do not clear a different unresolved marker", async () => {
    const f = fixture()
    f.values.push("first")
    f.fault({ target: "product", outcome: "visible" })
    await f.run(f.apply({ values: ["first", "second"] }).pipe(Effect.result))
    expect(await f.run(f.apply({ mode: "resume", values: ["first", "second"] }))).toBe(2)
    expect(f.productRequests()).toBe(1)
    expect(f.values).toEqual(["first", "second"])
  })
  test("a new native wire spelling cannot replace an unknown original request", async () => {
    const f = fixture()
    const original = "skill://router"
    f.fault({ target: "product", outcome: "visible" })
    await expect(
      f.run(f.apply({ values: [original], replay: "idempotent" })),
    ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
    const pending = await f.run(readCurrentOperationIntent(library, intent.owner))
    const calls = f.calls.length
    await expect(
      f.run(
        withCurrentOperation(library, {
          intent,
          ownerPageId: ownerId,
          mode: "resume",
          run: (session) =>
            session.dispatch({
              key: "append:" + original,
              replay: "idempotent",
              request: {
                path: productPath,
                body: { value: "skill://router/entrypoint.md/.." },
                options: { method: "POST" },
              },
              observe: () => Effect.die("A changed pending request must fail before observation"),
              acknowledge: () => Effect.die("A changed pending request must never be sent"),
            }),
          verify: () => Effect.void,
        }),
      ),
    ).rejects.toMatchObject({ code: "CURRENT_OPERATION_UNRESOLVED" })
    expect(
      f.calls.slice(calls).filter((call) => call.method !== "GET" && !call.path.includes("/query")),
    ).toEqual([])
    expect(await f.run(readCurrentOperationIntent(library, intent.owner))).toEqual(pending)
    expect(f.productRequests()).toBe(1)
    await expect(
      f.run(f.apply({ mode: "resume", values: [original], replay: "idempotent" })),
    ).rejects.toMatchObject({ code: "CURRENT_OPERATION_UNRESOLVED" })
    expect(f.productRequests()).toBe(1)
    expect(f.json.size).toBe(1)
  })
  test("a failed final scope stays attention and can finish without another append", async () => {
    const f = fixture()
    const first = await f.run(f.apply({ verifyFailure: true }).pipe(Effect.result))
    expect(first._tag).toBe("Failure")
    expect(property(property(f.owner.properties).state).select).toEqual({ name: "attention" })
    expect(await f.run(f.apply({ mode: "resume" }))).toBe(1)
    expect(f.productRequests()).toBe(1)
  })
  test("budget rejection starts no attention write and preserves a not-sent action for resume", async () => {
    const f = fixture()
    f.fault({
      target: "product",
      outcome: "absent",
      error: fail("REQUEST_BUDGET_EXHAUSTED", "Budget refused dispatch."),
    })
    await f.run(f.apply().pipe(Effect.result))
    expect(property(property(f.owner.properties).state).select).toEqual({ name: "applying" })
    expect(await f.run(f.apply({ mode: "resume" }))).toBe(1)
    expect(f.productRequests()).toBe(2)
  })
  test("a rejected next control checkpoint retains the previous action acknowledgement", async () => {
    const f = fixture()
    let rejectCheckpoint = true
    const attempt = (mode: "apply" | "resume") =>
      withCurrentOperation(library, {
        intent,
        ownerPageId: ownerId,
        mode,
        run: (session) =>
          Effect.gen(function* () {
            yield* f.action(session, "first", "idempotent")
            if (rejectCheckpoint) {
              rejectCheckpoint = false
              f.fault({
                target: "record-replace",
                outcome: "absent",
                error: fail("REQUEST_BUDGET_EXHAUSTED", "Budget refused the next checkpoint."),
              })
            }
            yield* f.action(session, "second", "idempotent")
            return f.values.length
          }),
        verify: () => Effect.sync(() => expect(f.values).toEqual(["first", "second"])),
      })
    await expect(f.run(attempt("apply"))).rejects.toMatchObject({
      code: "REQUEST_BUDGET_EXHAUSTED",
    })
    expect(f.values).toEqual(["first"])
    expect(f.productRequests()).toBe(1)
    expect(await f.run(attempt("resume"))).toBe(2)
    expect(f.productRequests()).toBe(2)
    expect(f.activeRecords()).toEqual([])
    expect(f.json.size).toBe(0)
  })
  test("a definitive Notion rate limit stops all follow-up requests and retains the rejected action for explicit resume", async () => {
    const f = fixture()
    f.fault({
      target: "product",
      outcome: "absent",
      error: fail("RATE_LIMITED", "Notion refused this current write.", {
        phase: "definitive_rejection",
        http_status: 429,
        rate_limit_reason: "public_api_request_blocked",
      }),
    })
    const result = await f.run(f.apply().pipe(Effect.result))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure.code).toBe("RATE_LIMITED")
    expect(f.productRequests()).toBe(1)
    expect(f.calls.at(-1)?.path).toBe(productPath)
    expect(property(property(f.owner.properties).state).select).toEqual({ name: "applying" })
    expect(f.activeRecords()).toHaveLength(1)
    expect(
      [...f.json.values()].some(
        (value) => property(property(value).not_dispatched).key === "append:first",
      ),
    ).toBe(true)
    expect(await f.run(f.apply({ mode: "resume" }))).toBe(1)
    expect(f.productRequests()).toBe(2)
    expect(f.json.size).toBe(0)
  })
  test("foreign owner operation is never cleared during finalization", async () => {
    const f = fixture()
    const result = await f.run(f.apply({ foreignOwner: true }).pipe(Effect.result))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure.code).toBe("CURRENT_OPERATION_CONFLICT")
    expect(text(property(property(f.owner.properties).operation).rich_text)).toBe(
      "another-operation",
    )
    expect(f.activeRecords()).toHaveLength(1)
  })
  test("unknown Operation create uses its stable identity before any product mutation", async () => {
    const f = fixture()
    f.fault({ target: "record-create", outcome: "visible" })
    await f.run(f.apply().pipe(Effect.result))
    expect(f.productRequests()).toBe(0)
    expect(await f.run(f.apply({ mode: "resume" }))).toBe(1)
    expect([...f.records.values()]).toHaveLength(1)
  })
  test("missing unknown Operation create cannot be replaced by another POST", async () => {
    const f = fixture()
    f.fault({ target: "record-create", outcome: "absent" })
    await f.run(f.apply().pipe(Effect.result))
    const result = await f.run(f.apply({ mode: "resume" }).pipe(Effect.result))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure.code).toBe("CURRENT_OPERATION_UNRESOLVED")
    expect(
      f.calls.filter((call) => call.path === "v1/pages" && call.method === "POST"),
    ).toHaveLength(1)
    expect(f.productRequests()).toBe(0)
  })
  test("a legacy pending control write cannot be replayed or upgraded from matching remote values", async () => {
    const f = fixture()
    f.fault({ target: "record-replace", outcome: "absent" })
    await expect(f.run(f.apply())).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
    const original = f.calls.findLast(
      (call) => call.method === "PATCH" && f.records.has(call.path.replace("v1/pages/", "")),
    )!
    const [key, value] = [...f.json.entries()][0]!
    const legacy = structuredClone(property(value))
    delete legacy.dispatch_protocol
    delete legacy.control_write
    delete legacy.settled_action
    f.json.set(key, legacy)
    const writes = f.calls.filter(
      (call) => call.method !== "GET" && !call.path.includes("/query"),
    ).length
    await expect(f.run(f.apply({ mode: "resume" }))).rejects.toMatchObject({
      code: "CURRENT_OPERATION_UNRESOLVED",
      details: { reason: "legacy_dispatch_protocol" },
    })
    const row = f.records.get(original.path.replace("v1/pages/", ""))!
    row.properties = { ...property(row.properties), ...fields(property(original.body).properties) }
    await expect(f.run(f.apply({ mode: "resume" }))).rejects.toMatchObject({
      code: "CURRENT_OPERATION_UNRESOLVED",
      details: { reason: "legacy_dispatch_protocol" },
    })
    await expect(
      f.run(
        f.apply({
          mode: { kind: "supersede", operation_id: intent.operation_id },
          nextIntent: { ...intent, operation_id: "legacy-successor", input_sha256: "b".repeat(64) },
        }),
      ),
    ).rejects.toMatchObject({ code: "CURRENT_OPERATION_UNRESOLVED" })
    expect(
      f.calls.filter((call) => call.method !== "GET" && !call.path.includes("/query")),
    ).toHaveLength(writes)
    expect(f.json.get(key)).toEqual(legacy)
    expect(f.productRequests()).toBe(0)
  })

  test("unknown control PATCH is dispatched once and only its original write witness releases the intent", async () => {
    const f = fixture()
    f.fault({ target: "record-replace", outcome: "absent" })
    await expect(f.run(f.apply())).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
    const original = f.calls.findLast(
      (call) => call.method === "PATCH" && f.records.has(call.path.replace("v1/pages/", "")),
    )!
    const pending = structuredClone([...f.json.values()][0])
    Schema.decodeUnknownSync(CurrentWritePendingSchema)(pending)
    expect(pending).toMatchObject({
      dispatch_protocol: 1,
      control_write: { kind: "record", write_id: expect.any(String) },
    })
    const writes = f.calls.filter(
      (call) => call.method !== "GET" && !call.path.includes("/query"),
    ).length
    await expect(f.run(f.apply({ mode: "resume" }))).rejects.toMatchObject({
      code: "CURRENT_OPERATION_UNRESOLVED",
    })
    await expect(
      f.run(
        f.apply({
          mode: { kind: "supersede", operation_id: intent.operation_id },
          nextIntent: { ...intent, operation_id: "next", input_sha256: "b".repeat(64) },
        }),
      ),
    ).rejects.toMatchObject({ code: "CURRENT_OPERATION_UNRESOLVED" })
    expect(
      f.calls.filter((call) => call.method !== "GET" && !call.path.includes("/query")),
    ).toHaveLength(writes)
    expect(f.productRequests()).toBe(0)
    const row = f.records.get(original.path.replace("v1/pages/", ""))!
    row.properties = { ...property(row.properties), ...fields(property(original.body).properties) }
    await f.run(f.apply({ mode: "resume" }))
    expect(f.productRequests()).toBe(1)
    expect(f.json.size).toBe(0)
  })

  test("unknown control retirement is never replayed before the original physical Record becomes retired", async () => {
    const f = fixture()
    f.fault({ target: "retirement", outcome: "absent" })
    await expect(f.run(f.apply())).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
    const writes = f.calls.filter(
      (call) => call.method !== "GET" && !call.path.includes("/query"),
    ).length
    await expect(f.run(f.apply({ mode: "resume" }))).rejects.toMatchObject({
      code: "CURRENT_OPERATION_UNRESOLVED",
    })
    expect(
      f.calls.filter((call) => call.method !== "GET" && !call.path.includes("/query")),
    ).toHaveLength(writes)
    const row = f.activeRecords()[0]!
    row.in_trash = true
    await f.run(f.apply({ mode: "resume" }))
    expect(
      f.calls.filter((call) => call.method !== "GET" && !call.path.includes("/query")),
    ).toHaveLength(writes)
    expect(f.json.size).toBe(0)
  })

  test("unknown successful retirement resumes with no product or owner write", async () => {
    const f = fixture()
    f.fault({ target: "retirement", outcome: "visible" })
    const first = await f.run(f.apply().pipe(Effect.result))
    expect(first._tag).toBe("Failure")
    expect(f.activeRecords()).toHaveLength(0)
    expect(f.json.size).toBe(1)
    const before = f.calls.filter(
      (call) => call.method !== "GET" && !call.path.includes("/query"),
    ).length
    expect(await f.run(f.apply({ mode: "resume" }))).toBe(1)
    const after = f.calls.filter(
      (call) => call.method !== "GET" && !call.path.includes("/query"),
    ).length
    expect(after).toBe(before)
    expect(f.json.size).toBe(0)
  })
  test("a new input clears only a confirmed retired prior locator before starting", async () => {
    const f = fixture()
    f.fault({ target: "retirement", outcome: "visible" })
    await f.run(f.apply().pipe(Effect.result))
    expect(f.json.size).toBe(1)
    expect(
      await f.run(
        f.apply({
          nextIntent: { ...intent, operation_id: "write-next", input_sha256: "b".repeat(64) },
          values: ["first", "second"],
        }),
      ),
    ).toBe(2)
    expect(f.values).toEqual(["first", "second"])
    expect(f.productRequests()).toBe(2)
    expect(f.json.size).toBe(0)
    expect(f.activeRecords()).toHaveLength(0)
  })
  test.each(["same-input", "new-input"] as const)(
    "an empty Operation query plus inaccessible retired page cannot erase the %s locator",
    async (request) => {
      const f = fixture()
      f.fault({ target: "retirement", outcome: "visible" })
      await f.run(f.apply().pipe(Effect.result))
      f.records.clear()
      const before = f.calls.filter(
        (call) => call.method !== "GET" && !call.path.includes("/query"),
      ).length
      const result = await f.run(
        f
          .apply(
            request === "same-input"
              ? { mode: "resume" }
              : {
                  nextIntent: {
                    ...intent,
                    operation_id: "write-next",
                    input_sha256: "b".repeat(64),
                  },
                  values: ["first", "second"],
                },
          )
          .pipe(Effect.result),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure.code).toBe("NOT_FOUND")
      expect(
        f.calls.filter((call) => call.method !== "GET" && !call.path.includes("/query")),
      ).toHaveLength(before)
      expect(f.json.size).toBe(1)
      expect(f.values).toEqual(["first"])
    },
  )
})

describe("explicit current intent succession and terminal removal", () => {
  const successor = { ...intent, operation_id: "write-successor", input_sha256: "b".repeat(64) }
  const supersede = { kind: "supersede", operation_id: intent.operation_id } as const
  const unfinished = async (f: ReturnType<typeof fixture>) => {
    f.fault({
      target: "product",
      outcome: "absent",
      error: fail("REQUEST_BUDGET_EXHAUSTED", "No mutation was admitted.", {
        phase: "input_rejected",
      }),
    })
    await expect(f.run(f.apply())).rejects.toMatchObject({ code: "REQUEST_BUDGET_EXHAUSTED" })
  }
  const recordCreates = (f: ReturnType<typeof fixture>) =>
    f.calls.filter(
      (call) =>
        call.path === "v1/pages" &&
        property(property(call.body).parent).data_source_id === library.records.data_source_id,
    )

  test("supersede replaces one current Record after the original mutation was definitively rejected", async () => {
    const f = fixture()
    await unfinished(f)
    const before = await f.run(inspectCurrentOperation(library, intent.owner))
    expect(before).toMatchObject({
      intent,
      owner_page_id: ownerId,
      record_observed: true,
      completion: "ready",
      local_lifecycle: { phase: "active" },
      in_flight: { key: "append:first" },
    })
    await f.run(f.apply({ mode: supersede, nextIntent: successor, values: ["second"] }))
    expect(recordCreates(f)).toHaveLength(1)
    expect(
      f.calls.filter((call) => call.path === productPath).map((call) => property(call.body).value),
    ).toEqual(["first", "second"])
    expect(f.values).toEqual(["second"])
    expect(f.activeRecords()).toEqual([])
    expect(f.json.size).toBe(0)
    expect(await f.run(inspectCurrentOperation(library, intent.owner))).toBeUndefined()
  })

  test.each([
    ["record-replace", "visible"],
    ["record-replace", "absent"],
    ["owner-rebind", "visible"],
    ["owner-rebind", "absent"],
  ] as const)(
    "lost %s %s handoff resumes the same successor without a second CREATE",
    async (target, outcome) => {
      const f = fixture()
      await unfinished(f)
      f.fault({ target, outcome })
      await expect(
        f.run(f.apply({ mode: supersede, nextIntent: successor, values: ["second"] })),
      ).rejects.toMatchObject({
        code: "WRITE_OUTCOME_UNKNOWN",
        details: { operation_id: successor.operation_id, input_sha256: successor.input_sha256 },
      })
      expect(f.productRequests()).toBe(1)
      const during = await f.run(inspectCurrentOperation(library, intent.owner))
      expect(await f.run(readCurrentOperationIntent(library, intent.owner))).toMatchObject({
        intent: successor,
        owner_page_id: ownerId,
      })
      expect(during).toMatchObject({
        intent: successor,
        owner_page_id: ownerId,
        local_lifecycle: { phase: "replacing" },
        predecessor: { intent },
      })
      if (outcome === "absent") {
        const writes = f.calls.filter(
          (call) => call.method !== "GET" && !call.path.includes("/query"),
        ).length
        await expect(
          f.run(f.apply({ mode: "resume", nextIntent: successor, values: ["second"] })),
        ).rejects.toMatchObject({ code: "CURRENT_OPERATION_UNRESOLVED" })
        expect(
          f.calls.filter((call) => call.method !== "GET" && !call.path.includes("/query")),
        ).toHaveLength(writes)
        const original = f.calls.findLast(
          (call) => call.method === "PATCH" && property(call.body).properties !== undefined,
        )!
        const row =
          target === "owner-rebind"
            ? f.owner
            : f.records.get(original.path.replace("v1/pages/", ""))!
        row.properties = {
          ...property(row.properties),
          ...fields(property(original.body).properties),
        }
      }
      await f.run(f.apply({ mode: "resume", nextIntent: successor, values: ["second"] }))
      expect(recordCreates(f)).toHaveLength(1)
      expect(f.values).toEqual(["second"])
      expect(f.productRequests()).toBe(2)
      expect(f.activeRecords()).toEqual([])
      expect(f.json.size).toBe(0)
    },
  )

  test("an unknown Operation CREATE cannot be abandoned to admit a successor", async () => {
    const f = fixture()
    f.fault({ target: "record-create", outcome: "absent" })
    await expect(f.run(f.apply())).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
    const original = recordCreates(f)[0]!
    await expect(
      f.run(f.apply({ mode: supersede, nextIntent: successor, values: ["second"] })),
    ).rejects.toMatchObject({ code: "CURRENT_OPERATION_UNRESOLVED" })
    expect(recordCreates(f)).toHaveLength(1)
    expect(f.productRequests()).toBe(0)
    expect([...f.json.values()][0]).toMatchObject({ intent, control_write: { kind: "record" } })
    // Only the unique original witness arriving later can settle the CREATE.
    f.records.set(id(998), {
      object: "page",
      id: id(998),
      in_trash: false,
      parent: property(original.body).parent,
      properties: fields(property(original.body).properties),
    })
    await f.run(f.apply({ mode: "resume" }))
    expect(recordCreates(f)).toHaveLength(1)
    expect(f.values).toEqual(["first"])
  })

  test("a successor is refused while the original target request may still arrive", async () => {
    const f = fixture()
    f.fault({ target: "product", outcome: "absent" })
    await expect(f.run(f.apply())).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
    const writes = f.calls.filter(
      (call) => call.method !== "GET" && !call.path.includes("/query"),
    ).length
    await expect(
      f.run(f.apply({ mode: supersede, nextIntent: successor, values: ["second"] })),
    ).rejects.toMatchObject({ code: "CURRENT_OPERATION_UNRESOLVED" })
    expect(
      f.calls.filter((call) => call.method !== "GET" && !call.path.includes("/query")),
    ).toHaveLength(writes)
    expect(f.values).toEqual([])
    expect([...f.json.values()][0]).toMatchObject({ intent })
  })

  test("ordinary supersede cannot steal a Source-bound child", async () => {
    const f = fixture()
    const source = {
      source_id: "provider",
      source_page_id: id(21),
      operation_id: "source-parent",
      input_sha256: "c".repeat(64),
      authorization_sha256: "d".repeat(64),
    }
    f.fault({ target: "product", outcome: "absent" })
    await expect(f.run(f.apply({ nextIntent: { ...intent, source } }))).rejects.toMatchObject({
      code: "WRITE_OUTCOME_UNKNOWN",
    })
    const mutations = f.calls.filter(
      (call) => call.method !== "GET" && !/\/query(?:\?|$)/u.test(call.path),
    ).length
    await expect(
      f.run(f.apply({ mode: supersede, nextIntent: successor, values: ["second"] })),
    ).rejects.toMatchObject({ code: "CURRENT_SOURCE_MANAGEMENT_REQUIRED" })
    expect(
      f.calls.filter((call) => call.method !== "GET" && !/\/query(?:\?|$)/u.test(call.path)),
    ).toHaveLength(mutations)
    expect([...f.json.values()][0]).toMatchObject({ intent: { ...intent, source } })
  })

  const remove = (f: ReturnType<typeof fixture>, mode: CurrentWriteMode = "apply") =>
    withCurrentOperation(library, {
      intent,
      ownerPageId: ownerId,
      mode,
      completion: "retired",
      run: (session) => Effect.succeed({ retiredAlready: session.ownerRetired }),
      verify: () => Effect.void,
    })
  test.each(["visible", "absent"] as const)(
    "unknown terminal owner archive %s stays pending without a new write",
    async (outcome) => {
      const f = fixture()
      f.fault({ target: "owner-retirement", outcome })
      await expect(f.run(remove(f))).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
      const writes = f.calls.filter(
        (call) => call.method !== "GET" && !call.path.includes("/query"),
      ).length
      await expect(f.run(remove(f, "resume"))).rejects.toMatchObject({
        code: "CURRENT_OPERATION_UNRESOLVED",
      })
      expect(
        f.calls.filter((call) => call.method !== "GET" && !call.path.includes("/query")),
      ).toHaveLength(writes)
      expect(f.owner.in_trash).toBe(outcome === "visible")
      expect(f.activeRecords()).toHaveLength(1)
      expect(f.json.size).toBe(1)
    },
  )

  test("terminal owner and retired Record lost response leave only an exact removable breadcrumb", async () => {
    const f = fixture()
    f.fault({ target: "retirement", outcome: "visible" })
    await expect(f.run(remove(f))).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
    expect(f.owner.in_trash).toBe(true)
    expect(f.activeRecords()).toEqual([])
    expect([...f.json.values()][0]).toMatchObject({
      completion: "retired",
      owner_page_id: ownerId,
      lifecycle: { phase: "retiring" },
    })
    const writes = f.calls.filter(
      (call) => call.method !== "GET" && !/\/query(?:\?|$)/u.test(call.path),
    ).length
    await f.run(remove(f, "resume"))
    expect(
      f.calls.filter((call) => call.method !== "GET" && !/\/query(?:\?|$)/u.test(call.path)),
    ).toHaveLength(writes)
    expect(f.json.size).toBe(0)
  })
})

test("file authority succession accepts the exact target and rejects a different file before handoff", async () => {
  const f = fixture()
  f.owner.parent = { type: "data_source_id", data_source_id: library.sources.data_source_id }
  f.owner.properties = fields({
    [library.sources.property_ids["Source ID"]!]: { rich_text: rich("provider") },
    [library.sources.property_ids.Status!]: { select: { name: "ready" } },
    [library.sources.property_ids.Operation!]: { rich_text: [] },
  })
  const original = {
    operation_id: "source-file-prior",
    input_sha256: "1".repeat(64),
    owner: { kind: "source", id: "provider" },
    source_input: {
      kind: "file_authority",
      configuration_sha256: "2".repeat(64),
      affected_skill_ids: ["example"],
      source_page_id: ownerId,
      revision: "3".repeat(64),
      before_configuration_sha256: "4".repeat(64),
      source_content_sha256: "5".repeat(64),
      request: {
        source_path: "references/guide.md",
        skill_id: "example",
        file_id: "guide",
        action: { kind: "takeover", to: "resource" },
      },
      target: {
        skill_page_id: id(21),
        page_id: id(22),
        path: "references/guide.md",
        content_sha256: "6".repeat(64),
        native_sha256: null,
      },
      selected: { sha256: "7".repeat(64), bytes: 10, mode: "100644" },
    },
  } satisfies CurrentOperationIntent
  await expect(
    f.run(
      withCurrentOperation(library, {
        intent: original,
        ownerPageId: ownerId,
        run: (session) =>
          session
            .activate()
            .pipe(Effect.andThen(Effect.fail(fail("PAUSED", "Stop before the child.")))),
        verify: () => Effect.void,
      }),
    ),
  ).rejects.toMatchObject({ code: "PAUSED" })
  const successor = { ...original, operation_id: "source-file-next", input_sha256: "8".repeat(64) }
  const mutations = () =>
    f.calls.filter((call) => call.method !== "GET" && !/\/query(?:\?|$)/u.test(call.path))
  const before = mutations().length
  await expect(
    f.run(
      withCurrentOperation(library, {
        intent: {
          ...successor,
          source_input: {
            ...successor.source_input,
            request: { ...successor.source_input.request, file_id: "foreign-file" },
          },
        },
        ownerPageId: ownerId,
        mode: { kind: "supersede", operation_id: original.operation_id },
        run: () => Effect.void,
        verify: () => Effect.void,
      }),
    ),
  ).rejects.toMatchObject({ code: "CURRENT_OPERATION_INVALID" })
  expect(mutations()).toHaveLength(before)
  await f.run(
    withCurrentOperation(library, {
      intent: successor,
      ownerPageId: ownerId,
      mode: { kind: "supersede", operation_id: original.operation_id },
      run: (session) =>
        Effect.gen(function* () {
          expect(session.predecessor?.intent).toEqual(original)
          expect(session.predecessor?.source_progress).toEqual({
            next_index: 0,
            child_started: false,
          })
          yield* session.markSourceChildComplete("example")
        }),
      verify: () => Effect.void,
    }),
  )
  expect(f.activeRecords()).toEqual([])
  expect(f.json.size).toBe(0)
  expect(
    property(property(f.owner.properties)[library.sources.property_ids.Status!]).select,
  ).toEqual({ name: "ready" })
})

test("terminal retirement rechecks the caller scope after the final owner observation", async () => {
  const f = fixture()
  let verified = 0
  await expect(
    f.run(
      withCurrentOperation(library, {
        intent,
        ownerPageId: ownerId,
        completion: "retired",
        run: (session) => session.activate(),
        verify: () =>
          Effect.gen(function* () {
            verified++
            if (verified === 2)
              return yield* Effect.fail(
                fail("CURRENT_REFERENCE_CHANGED", "A new current reference appeared."),
              )
          }),
      }),
    ),
  ).rejects.toMatchObject({ code: "CURRENT_REFERENCE_CHANGED" })
  expect(verified).toBe(2)
  expect(f.owner.in_trash).toBe(false)
  expect(
    f.calls.filter(
      (call) => call.path === "v1/pages/" + ownerId && property(call.body).in_trash === true,
    ),
  ).toEqual([])
  expect(f.json.size).toBe(1)
})
