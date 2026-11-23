import { afterAll, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ConfigProvider, Effect, Fiber, Latch, Option, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { trashPath } from "../src/local-locks.ts"
import { fail, property, text, type SkillsError } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { RequestBudget } from "../src/request-budget.ts"
import { resolveCurrentSourceConsumption } from "../src/shared-current-consumption.ts"
import { readCurrentOperationIntent } from "../src/shared-current-operation.ts"
import {
  currentSourceConfigurationFingerprint,
  type checkCurrentSource,
  type CurrentSourceCheckResult,
} from "../src/shared-current-source-check.ts"
import {
  prepareCurrentSourceFromDiscovery,
  validateCurrentSourceInput,
  type prepareCurrentSource,
  type CurrentSourceDeclaration,
} from "../src/shared-current-source-input.ts"
import {
  queryCurrentSourceManagement,
  queryCurrentSourceManagementBatch,
} from "../src/shared-current-source-management.ts"
import { CurrentSourceSyncBatchSchema } from "../src/shared-current-source-sync-batch-model.ts"
import {
  CurrentSourceSyncObservationSchema,
  CurrentSourceSyncPendingSchema,
} from "../src/shared-current-source-sync-model.ts"
import {
  CurrentSourceSyncProvider,
  currentSourceSyncExitCode,
  syncCurrentSources,
  type CurrentSourceSyncRequest,
} from "../src/shared-current-source-sync.ts"
import { writePreparedCurrentSource } from "../src/shared-current-source-write.ts"
import { readCurrentSourceGitOrigin } from "../src/shared-current-source.ts"
import { Store } from "../src/store.ts"
import type { SourceSnapshot } from "../src/upstream-source.ts"
import { currentWriteFixture, id, library, testBytes } from "./shared-current-write-fixture.ts"

const parent = mkdtempSync(join(tmpdir(), "ntn-source-sync-batch-"))
afterAll(async () => {
  if (process.platform === "darwin") await Effect.runPromise(trashPath(parent))
})

const firstCommit = "a".repeat(40),
  nextCommit = "c".repeat(40),
  thirdCommit = "e".repeat(40),
  fourthCommit = "1".repeat(40),
  origin = "https://github.com/example/sync-batch",
  sourceQuery = `v1/data_sources/${library.sources.data_source_id}/query`

function declaration(name: string, shared: boolean): CurrentSourceDeclaration {
  return {
    version: 1,
    definition: {
      version: 1,
      source_id: `batch-${name}`,
      name: `Batch ${name}`,
      description: "Exact upstream batch fixture",
      enabled: true,
      policy: "manual",
      adapter: { type: "git", url: origin, ref: "main" },
      selection: { roots: [`skills/${name}`], include: [], exclude: [], mapping: {} },
      options: {},
    },
    contributions: [
      {
        member_key: `skills/${name}`,
        skill_id: shared ? "batch-shared" : `batch-skill-${name}`,
        mount_path: shared && name !== "alpha" ? "vendor" : "",
        mapping: {},
        exclude: [],
      },
    ],
  }
}

function snapshot(name: string, commit: string): SourceSnapshot {
  const root = `skills/${name}`,
    tree = (
      commit === firstCommit
        ? "b"
        : commit === nextCommit
          ? "d"
          : commit === thirdCommit
            ? "f"
            : "2"
    ).repeat(40),
    bytes = testBytes(
      `---\nname: ${name}\ndescription: Batch ${name}\n---\n# ${name}\n\n${commit}\n`,
    ),
    sha256 = createHash("sha256").update(bytes).digest("hex")
  return {
    revision: commit,
    provenance: { provider: "git", git_url: origin, resolved_ref: commit, tree_hash: tree },
    members: [
      {
        member_key: root,
        source_path: root,
        portable: {
          kind: "skill",
          name,
          description: `Batch ${name}`,
          main: "SKILL.md",
          files: [{ path: "SKILL.md", bytes, mode: "100644" }],
        },
        upstream_hash: sha256,
        content_hash: sha256,
        git_manifest: {
          commit,
          tree,
          root,
          files: [
            {
              path: "SKILL.md",
              source_path: `${root}/SKILL.md`,
              git_oid: createHash("sha1")
                .update(`blob ${bytes.length}\0`)
                .update(bytes)
                .digest("hex"),
              bytes: bytes.length,
              mode: "100644",
            },
          ],
        },
      },
    ],
  }
}

type BeforeCheck = (
  sourceId: string,
  budget: RequestBudget["Service"],
) => Effect.Effect<void, SkillsError>

/** Git observations and cold bytes are controlled; the batch, preparation,
 * current writer, finite operation kernel and local lock remain production code. */
async function batchFixture(names: readonly string[], shared = false) {
  const f = currentWriteFixture(parent)
  const declarations = names.map((name) => declaration(name, shared))
  const observations = new Map(
    names.map((name) => [
      `batch-${name}`,
      new Map(
        [firstCommit, nextCommit, thirdCommit, fourthCommit].map((commit) => [
          commit,
          snapshot(name, commit),
        ]),
      ),
    ]),
  )
  const bodies = new Map<string, Uint8Array>()
  for (const commits of observations.values())
    for (const observed of commits.values())
      for (const member of observed.members)
        for (const file of member.portable.files)
          bodies.set(
            `https://raw.githubusercontent.com/example/sync-batch/${observed.revision}/${member.member_key}/${file.path}`,
            file.bytes,
          )
  const http = HttpClient.make((request) => {
    const bytes = bodies.get(request.url)
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        bytes === undefined
          ? new Response(null, { status: 404 })
          : new Response(bytes.slice(), {
              headers: { "content-length": String(bytes.length) },
            }),
      ),
    )
  })
  const checks: { source_id: string; budget: RequestBudget["Service"] }[] = []
  const preparations: string[] = []
  let advertisedCommit = nextCommit
  let beforeCheck: BeforeCheck = () => Effect.void
  const boundary: { check: typeof checkCurrentSource; prepare: typeof prepareCurrentSource } = {
    prepare: (input, options) =>
      Effect.gen(function* () {
        const parsed = validateCurrentSourceInput(input)
        const sourceId = parsed.definition.source_id
        const observed = observations.get(sourceId)?.get(options?.exactCommit ?? advertisedCommit)
        if (observed === undefined)
          return yield* Effect.fail(fail("TEST_UNEXPECTED", "Unknown fixture observation."))
        preparations.push(sourceId)
        return yield* prepareCurrentSourceFromDiscovery(parsed, observed)
      }),
    check: (selectedLibrary, input) =>
      Effect.gen(function* () {
        const current = input.current,
          sourceId = current.declaration.definition.source_id
        const supplied = yield* Effect.serviceOption(RequestBudget)
        if (Option.isNone(supplied))
          return yield* Effect.fail(fail("TEST_UNEXPECTED", "The batch must supply its budget."))
        checks.push({ source_id: sourceId, budget: supplied.value })
        yield* beforeCheck(sourceId, supplied.value)
        const configuration_sha256 = yield* currentSourceConfigurationFingerprint(
          current.declaration,
        )
        const selected = yield* readCurrentSourceGitOrigin(selectedLibrary, {
          source_id: sourceId,
          page_id: current.page_id,
          revision: current.revision,
          content: current.content,
        })
        if (selected === undefined)
          return yield* Effect.fail(
            fail("TEST_UNEXPECTED", "The fixture requires a Git selection."),
          )
        const common = {
          source_id: sourceId,
          source_page_id: current.page_id,
          configuration_sha256,
          current_configuration_sha256: configuration_sha256,
          selected_commit: selected.commit,
          observation: {
            url: origin,
            ref: "main",
            resolved_ref: "refs/heads/main",
            resolved_commit: advertisedCommit,
            observed_at: 0,
          },
        }
        return selected.commit === advertisedCommit
          ? ({ ...common, status: "upstream_unchanged" } satisfies CurrentSourceCheckResult)
          : ({
              ...common,
              status: "update_available",
              reason: "upstream_changed",
            } satisfies CurrentSourceCheckResult)
      }),
  }
  const use = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(CurrentSourceSyncProvider, boundary),
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
    )
  for (const input of declarations) {
    const sourceId = input.definition.source_id
    const original = observations.get(sourceId)?.get(firstCommit)
    if (original === undefined) throw new Error("The fixture requires its initial commit.")
    const prepared = await f.run(prepareCurrentSourceFromDiscovery(input, original))
    await f.run(
      use(
        writePreparedCurrentSource(library, {
          prepared,
          operation_id: `seed-${sourceId}`,
        }),
      ),
    )
  }
  const request: CurrentSourceSyncRequest = {
    source_ids: declarations.map((input) => input.definition.source_id),
    manager_id: "batch-manager",
    execution_id: "batch-generation",
    mode: "full",
    projection: "none",
  }
  const selected = (sourceId: string) =>
    Effect.gen(function* () {
      const current = yield* queryCurrentSourceManagement(library, sourceId)
      if (current === undefined)
        return yield* Effect.fail(fail("TEST_UNEXPECTED", "The fixture Source disappeared."))
      return yield* readCurrentSourceGitOrigin(library, {
        source_id: sourceId,
        page_id: current.page_id,
        revision: current.revision,
        content: current.content,
      })
    })
  return {
    f,
    use,
    request,
    checks,
    preparations,
    selected,
    moveHead: (commit: string) => {
      if (![firstCommit, nextCommit, thirdCommit, fourthCommit].includes(commit))
        throw new Error("The fixture requires an existing exact commit.")
      advertisedCommit = commit
    },
    onCheck: (hook: BeforeCheck) => {
      beforeCheck = hook
    },
  }
}

test("one batch shares its budget and retains completed work when a provider exhausts it", async () => {
  const h = await batchFixture(["alpha", "beta", "gamma"])
  h.onCheck((sourceId, budget) =>
    sourceId === "batch-beta"
      ? // This is a controlled transport fault, not a fabricated Notion request count.
        Effect.fail(budget.exhaust("requests"))
      : Effect.void,
  )
  const result = await h.f.run(h.use(syncCurrentSources(library, h.request)))
  expect(result.status).toBe("retryable")
  expect(currentSourceSyncExitCode(result)).toBe(75)
  expect(result.budget.exhausted).toBe("requests")
  expect(h.checks.map((check) => check.source_id)).toEqual(["batch-alpha", "batch-beta"])
  expect(h.checks[0]?.budget).toBe(h.checks[1]?.budget)
  expect(h.checks[0]?.budget.identity).toBe(h.checks[1]?.budget.identity)
  expect(h.preparations).toEqual(["batch-alpha"])
  expect(result.results).toMatchObject([
    {
      source_id: "batch-alpha",
      status: "applied",
      content: { status: "published", resolved_commit: nextCommit },
    },
    { source_id: "batch-beta", retryable: true, error: { code: "REQUEST_BUDGET_EXHAUSTED" } },
    {
      source_id: "batch-gamma",
      status: "not_started",
      operation_id: null,
      content: { status: "not_started" },
      error: { code: "REQUEST_BUDGET_EXHAUSTED" },
    },
  ])
  expect(await h.f.run(h.selected("batch-alpha"))).toMatchObject({ commit: nextCommit })
  for (const sourceId of ["batch-beta", "batch-gamma"]) {
    expect(await h.f.run(h.selected(sourceId))).toMatchObject({ commit: firstCommit })
    expect(
      await h.f.run(readCurrentOperationIntent(library, { kind: "source", id: sourceId })),
    ).toBeUndefined()
  }
  // A fresh invocation has a fresh allowance, but resumes the finite full
  // traversal after alpha instead of spending it on the same completed prefix.
  h.onCheck(() => Effect.void)
  const resumed = await h.f.run(
    h.use(syncCurrentSources(library, { ...h.request, limits: { requests: 500 } })),
  )
  expect(resumed.status).toBe("complete")
  expect(resumed.results[0]).toEqual(result.results[0])
  expect(h.checks.map((check) => check.source_id)).toEqual([
    "batch-alpha",
    "batch-beta",
    "batch-beta",
    "batch-gamma",
  ])
  expect(h.preparations).toEqual(["batch-alpha", "batch-beta", "batch-gamma"])
  expect(h.checks[2]?.budget.identity).not.toBe(h.checks[0]?.budget.identity)
  expect(
    [...h.f.json.keys()].filter((key) => key.startsWith("operations/current-source-sync-batch/")),
  ).toEqual([])
})

test("a full traversal retains an earlier hard failure when a later budget retry completes", async () => {
  const h = await batchFixture(["alpha", "beta", "gamma"])
  h.onCheck((sourceId, budget) => {
    if (sourceId === "batch-alpha")
      return Effect.fail(fail("CURRENT_SOURCE_SYNC_CONFLICT", "Controlled foreign Source owner."))
    return sourceId === "batch-beta" ? Effect.fail(budget.exhaust("requests")) : Effect.void
  })
  const first = await h.f.run(h.use(syncCurrentSources(library, h.request)))
  expect(first.results[0]).toMatchObject({
    source_id: "batch-alpha",
    status: "blocked",
    retryable: false,
    error: { code: "CURRENT_SOURCE_SYNC_CONFLICT" },
  })
  h.onCheck(() => Effect.void)
  const resumed = await h.f.run(h.use(syncCurrentSources(library, h.request)))
  expect(resumed.status).toBe("partial")
  expect(currentSourceSyncExitCode(resumed)).toBe(1)
  expect(resumed.results[0]).toEqual(first.results[0])
  expect(resumed.results.slice(1).map((item) => item.status)).toEqual(["applied", "applied"])
  expect(h.preparations).toEqual(["batch-beta", "batch-gamma"])
  expect(await h.f.run(h.selected("batch-alpha"))).toMatchObject({ commit: firstCommit })
  expect(
    [...h.f.json.keys()].filter((key) => key.startsWith("operations/current-source-sync-batch/")),
  ).toEqual([])
})

test("changed records its completed full prefix before later current versions replace the observation", async () => {
  const h = await batchFixture(["alpha"])
  const updated = await h.f.run(
    prepareCurrentSourceFromDiscovery(declaration("alpha", false), snapshot("alpha", nextCommit)),
  )
  const current = await h.f.run(queryCurrentSourceManagement(library, "batch-alpha"))
  const revisionField = library.sources.property_ids["Last Revision"],
    stateField = library.sources.property_ids.Status
  if (current === undefined || revisionField === undefined || stateField === undefined)
    throw new Error("The fixture requires the original Source metadata.")
  let activeBudget: RequestBudget["Service"] | undefined
  let interrupted = false
  h.onCheck((_sourceId, budget) =>
    Effect.sync(() => {
      activeBudget = budget
    }),
  )
  h.f.rewrite((path, response) => {
    const fields = property(response.properties)
    if (
      !interrupted &&
      path === `v1/pages/${current.page_id}` &&
      text(property(fields[revisionField]).rich_text) === updated.prepared_source.revision &&
      property(property(fields[stateField]).select).name === "ready"
    ) {
      if (activeBudget === undefined) throw new Error("The invocation must own its budget.")
      activeBudget.exhaust("requests")
      interrupted = true
    }
    return response
  })
  const stopped = await h.f.run(
    h.use(
      Effect.gen(function* () {
        const api = yield* Notion
        return yield* syncCurrentSources(library, h.request).pipe(
          Effect.provideService(Notion, {
            ...api,
            request: (path, body, options) =>
              Effect.gen(function* () {
                // The in-memory fixture does not perform transport admission;
                // preserve the real transport's budget gate for this interruption.
                yield* (yield* RequestBudget).check
                return yield* api.request(path, body, options)
              }),
          }),
        )
      }),
    ),
  )
  expect(interrupted).toBe(true)
  expect(stopped.status).toBe("retryable")
  const batchEntry = [...h.f.json].find(([key]) =>
    key.startsWith("operations/current-source-sync-batch/"),
  )
  const pendingEntry = [...h.f.json].find(([key]) =>
    key.startsWith("operations/current-source-sync/"),
  )
  if (batchEntry === undefined || pendingEntry === undefined)
    throw new Error("The unfinished traversal and Source must remain durable.")
  const batch = Schema.decodeUnknownSync(CurrentSourceSyncBatchSchema)(batchEntry[1])
  const pending = Schema.decodeUnknownSync(CurrentSourceSyncPendingSchema)(pendingEntry[1])
  expect(batch.results).toEqual([])
  expect(pending.full_batch).toEqual({ scope: batch.scope, batch_id: batch.batch_id })

  h.f.rewrite()
  const changed = await h.f.run(
    h.use(syncCurrentSources(library, { ...h.request, mode: "changed" })),
  )
  expect(changed.status).toBe("complete")
  expect(changed.results[0]?.status).toBe("reconciled")
  expect(h.checks).toHaveLength(1)
  expect(h.f.json.has(pendingEntry[0])).toBe(false)
  expect(
    Schema.decodeUnknownSync(CurrentSourceSyncBatchSchema)(h.f.json.get(batchEntry[0])).results,
  ).toEqual(changed.results)

  // Hourly current updates may replace the disposable observation repeatedly
  // before the next daily full traversal resumes. Its completed prefix survives.
  for (const commit of [thirdCommit, fourthCommit]) {
    h.moveHead(commit)
    const updated = await h.f.run(
      h.use(syncCurrentSources(library, { ...h.request, mode: "changed" })),
    )
    expect(updated.status).toBe("complete")
    expect(updated.results[0]?.content).toMatchObject({
      status: "published",
      resolved_commit: commit,
    })
    expect(
      Schema.decodeUnknownSync(CurrentSourceSyncBatchSchema)(h.f.json.get(batchEntry[0])).results,
    ).toEqual(changed.results)
  }
  const receiptEntry = [...h.f.json].find(([key]) => key.startsWith("cache/current-source-sync/"))
  if (receiptEntry === undefined) throw new Error("Completed work must retain its observation.")
  const receipt = Schema.decodeUnknownSync(CurrentSourceSyncObservationSchema)(receiptEntry[1])
  expect(receipt.resolved_commit).toBe(fourthCommit)
  const checkedBeforeFull = h.checks.length,
    preparedBeforeFull = h.preparations.length

  // A backwards observation timestamp cannot invalidate the protected parent
  // completion, which reports B at its processing time even though D is current.
  h.f.json.set(receiptEntry[0], { ...receipt, completed_at: 0 })
  const resumed = await h.f.run(h.use(syncCurrentSources(library, h.request)))
  expect(resumed.status).toBe("complete")
  expect(resumed.results).toEqual(changed.results)
  expect(h.checks).toHaveLength(checkedBeforeFull)
  expect(h.preparations).toHaveLength(preparedBeforeFull)
  expect(h.f.json.has(batchEntry[0])).toBe(false)

  // A future observation timestamp cannot skip a new full traversal of D.
  h.f.json.set(receiptEntry[0], { ...receipt, completed_at: Number.MAX_SAFE_INTEGER })
  const fresh = await h.f.run(h.use(syncCurrentSources(library, h.request)))
  expect(fresh.status).toBe("complete")
  expect(fresh.results[0]?.content).toMatchObject({
    status: "published",
    resolved_commit: fourthCommit,
  })
  expect(h.preparations).toHaveLength(preparedBeforeFull + 1)
  expect(h.checks).toHaveLength(checkedBeforeFull + 1)
}, 15_000)

test("a failed parent checkpoint keeps its completed Source pending until the original completion is saved", async () => {
  const h = await batchFixture(["alpha"])
  let injected = false
  const stopped = await h.f.run(
    h.use(
      Effect.gen(function* () {
        const store = yield* Store
        return yield* syncCurrentSources(library, h.request).pipe(
          Effect.provideService(Store, {
            ...store,
            writeJson: (key, value, options) => {
              const results = property(value).results
              if (
                !injected &&
                key.startsWith("operations/current-source-sync-batch/") &&
                Array.isArray(results) &&
                results.length > 0
              ) {
                injected = true
                return Effect.fail(
                  fail("STATE_BUSY", "Controlled failure before the parent checkpoint."),
                )
              }
              return store.writeJson(key, value, options)
            },
          }),
        )
      }),
    ),
  )
  expect(injected).toBe(true)
  expect(stopped.status).toBe("retryable")
  expect(currentSourceSyncExitCode(stopped)).toBe(75)
  expect(stopped.results[0]).toMatchObject({
    content: { status: "published", resolved_commit: nextCommit },
    error: { code: "STATE_BUSY" },
  })
  const batchEntry = [...h.f.json].find(([key]) =>
    key.startsWith("operations/current-source-sync-batch/"),
  )
  const pendingEntry = [...h.f.json].find(([key]) =>
    key.startsWith("operations/current-source-sync/"),
  )
  if (batchEntry === undefined || pendingEntry === undefined)
    throw new Error("An unsaved parent completion must retain the original Source pending.")
  const batch = Schema.decodeUnknownSync(CurrentSourceSyncBatchSchema)(batchEntry[1])
  const pending = Schema.decodeUnknownSync(CurrentSourceSyncPendingSchema)(pendingEntry[1])
  expect(batch.results).toEqual([])
  expect(pending.phase).toBe("projection")
  expect(pending.full_batch).toEqual({ scope: batch.scope, batch_id: batch.batch_id })

  h.moveHead(thirdCommit)
  const resumed = await h.f.run(
    h.use(syncCurrentSources(library, { ...h.request, mode: "changed" })),
  )
  expect(resumed.status).toBe("complete")
  expect(resumed.results[0]).toMatchObject({
    operation_id: pending.input.operation_id,
    status: "reconciled",
    content: { status: "published", resolved_commit: nextCommit },
  })
  expect(h.checks).toHaveLength(1)
  expect(h.preparations).toEqual(["batch-alpha"])
  expect(h.f.json.has(pendingEntry[0])).toBe(false)
  expect(
    Schema.decodeUnknownSync(CurrentSourceSyncBatchSchema)(h.f.json.get(batchEntry[0])).results,
  ).toEqual(resumed.results)
  const finished = await h.f.run(h.use(syncCurrentSources(library, h.request)))
  expect(finished.status).toBe("complete")
  expect(finished.results).toEqual(resumed.results)
  expect(h.checks).toHaveLength(1)
  expect(h.f.json.has(batchEntry[0])).toBe(false)
})

test("overlapping sync on the same Store and library reports retryable without a second write", async () => {
  const h = await batchFixture(["alpha", "beta"])
  const entered = Latch.makeUnsafe(false),
    release = Latch.makeUnsafe(false)
  h.onCheck(() => entered.open.pipe(Effect.andThen(release.await)))
  h.f.clearCalls()
  const first = await h.f.run(
    h.use(
      Effect.scoped(
        Effect.gen(function* () {
          const running = yield* Effect.forkChild(syncCurrentSources(library, h.request), {
            startImmediately: true,
          })
          return yield* Effect.gen(function* () {
            yield* entered.await
            const overlapping = yield* syncCurrentSources(library, h.request)
            expect(overlapping.status).toBe("retryable")
            expect(currentSourceSyncExitCode(overlapping)).toBe(75)
            expect(overlapping.results).toHaveLength(2)
            for (const item of overlapping.results)
              expect(item).toMatchObject({
                status: "not_started",
                operation_id: null,
                retryable: true,
                content: { status: "not_started" },
                error: { code: "SYNC_LOCKED" },
              })
            expect(h.checks.map((check) => check.source_id)).toEqual(["batch-alpha"])
            expect(h.preparations).toEqual([])
            expect(h.f.mutations()).toEqual([])
            yield* release.open
            return yield* Fiber.join(running)
          }).pipe(Effect.ensuring(release.open))
        }),
      ),
    ),
  )
  expect(first.status).toBe("complete")
  for (const sourceId of h.request.source_ids)
    expect(await h.f.run(h.selected(sourceId))).toMatchObject({ commit: nextCommit })
})

test("Sources sharing a target finish one publication before observing the next Source", async () => {
  const h = await batchFixture(["alpha", "beta"], true)
  const updated = await h.f.run(
    prepareCurrentSourceFromDiscovery(declaration("alpha", true), snapshot("alpha", nextCommit)),
  )
  const current = await h.f.run(queryCurrentSourceManagement(library, "batch-alpha"))
  const revisionField = library.sources.property_ids["Last Revision"],
    stateField = library.sources.property_ids.Status
  if (current === undefined || revisionField === undefined || stateField === undefined)
    throw new Error("The fixture requires its current Source metadata.")
  let observedAfterPublication = false
  h.onCheck((sourceId) =>
    Effect.sync(() => {
      if (sourceId !== "batch-beta") return
      const fields = property(h.f.pages.get(current.page_id)?.properties)
      expect(text(property(fields[revisionField]).rich_text)).toBe(updated.prepared_source.revision)
      expect(property(property(fields[stateField]).select).name).toBe("ready")
      observedAfterPublication = true
    }),
  )
  const result = await h.f.run(h.use(syncCurrentSources(library, h.request)))
  expect(result.status).toBe("complete")
  expect(observedAfterPublication).toBe(true)
  expect(h.f.table("skills")).toHaveLength(1)
  const consumed = await h.f.run(resolveCurrentSourceConsumption(library, "batch-shared"))
  expect(consumed.files.map((file) => file.path)).toEqual(["SKILL.md", "vendor/SKILL.md"])
  expect(new Set(consumed.files.map((file) => file.content.source_id))).toEqual(
    new Set(h.request.source_ids),
  )
  for (const sourceId of h.request.source_ids) {
    expect(await h.f.run(h.selected(sourceId))).toMatchObject({ commit: nextCommit })
    expect(
      await h.f.run(readCurrentOperationIntent(library, { kind: "source", id: sourceId })),
    ).toBeUndefined()
  }
  expect(
    await h.f.run(readCurrentOperationIntent(library, { kind: "skill", id: "batch-shared" })),
  ).toBeUndefined()
})

test("explicit Source selection completes pagination before returning its inventory", async () => {
  const h = await batchFixture(["alpha", "beta"])
  let page = 0
  h.f.rewrite((path, response) => {
    if (path !== sourceQuery || page++ !== 0) return response
    if (!Array.isArray(response.results)) throw new Error("Expected a Source list response.")
    return { ...response, results: response.results.slice(0, 1), has_more: true, next_cursor: "1" }
  })
  h.f.clearCalls()
  const selected = await h.f.run(queryCurrentSourceManagementBatch(library, h.request.source_ids))
  expect([...selected.keys()].sort()).toEqual([...h.request.source_ids])
  expect(
    h.f.calls
      .filter((call) => call.path === sourceQuery)
      .map((call) => property(call.body).start_cursor ?? null),
  ).toEqual([null, "1"])
  expect(h.f.mutations()).toEqual([])
})

test.each(["duplicate", "incomplete"] as const)(
  "an %s Source inventory prevents the entire batch from starting",
  async (fault) => {
    const h = await batchFixture(["alpha", "beta"])
    if (fault === "duplicate") {
      const current = await h.f.run(queryCurrentSourceManagement(library, "batch-alpha"))
      const row = current === undefined ? undefined : h.f.pages.get(current.page_id)
      if (row === undefined) throw new Error("The fixture requires its initial Source page.")
      h.f.pages.set(id(9000), { ...structuredClone(row), id: id(9000) })
    } else
      h.f.rewrite((path, response) =>
        path === sourceQuery ? { ...response, has_more: true, next_cursor: null } : response,
      )
    h.f.clearCalls()
    const result = await h.f.run(h.use(syncCurrentSources(library, h.request)))
    expect(currentSourceSyncExitCode(result)).toBe(1)
    expect(result.results).toHaveLength(2)
    for (const item of result.results)
      expect(item).toMatchObject({
        status: "not_started",
        operation_id: null,
        retryable: false,
        error: { code: "CURRENT_SOURCE_MANAGEMENT_INVALID" },
      })
    expect(h.checks).toEqual([])
    expect(h.preparations).toEqual([])
    expect(h.f.mutations()).toEqual([])
  },
)
