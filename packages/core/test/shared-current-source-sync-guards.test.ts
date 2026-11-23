import { afterAll, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ConfigProvider, Effect, Option, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { trashPath } from "../src/local-locks.ts"
import { fail, property, text } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { RequestBudget } from "../src/request-budget.ts"
import { queryCurrentSkillIndex } from "../src/shared-current-index.ts"
import { readCurrentOperationIntent } from "../src/shared-current-operation.ts"
import { readCurrentBodyBlocks } from "../src/shared-current-projection.ts"
import { projectCurrentSkill } from "../src/shared-current-projection-write.ts"
import {
  prepareCurrentSourceFromDiscovery,
  validateCurrentSourceInput,
  type prepareCurrentSource,
  type CurrentSourceDeclaration,
} from "../src/shared-current-source-input.ts"
import {
  currentSourceConfigurationFingerprint,
  type checkCurrentSource,
  type CurrentSourceCheckResult,
} from "../src/shared-current-source-check.ts"
import { queryCurrentSourceManagement } from "../src/shared-current-source-management.ts"
import { writePreparedCurrentSource } from "../src/shared-current-source-write.ts"
import { readCurrentSourceGitOrigin } from "../src/shared-current-source.ts"
import { CurrentSourceSyncBatchSchema } from "../src/shared-current-source-sync-batch-model.ts"
import {
  currentSourceSyncExitCode,
  CurrentSourceSyncProvider,
  syncCurrentSources,
  type CurrentSourceSyncRequest,
  type CurrentSourceSyncResult,
} from "../src/shared-current-source-sync.ts"
import { sourceRich } from "../src/shared-source-definitions.ts"
import { Store } from "../src/store.ts"
import type { SourceSnapshot } from "../src/upstream-source.ts"
import { currentWriteFixture, library, testBytes } from "./shared-current-write-fixture.ts"

const parent = mkdtempSync(join(tmpdir(), "ntn-source-sync-guards-"))
afterAll(async () => {
  if (process.platform === "darwin") await Effect.runPromise(trashPath(parent))
})

const firstCommit = "a".repeat(40),
  secondCommit = "c".repeat(40),
  thirdCommit = "e".repeat(40)
const sourceId = "sync-guard-source"
const declaration: CurrentSourceDeclaration = {
  version: 1,
  definition: {
    version: 1,
    source_id: sourceId,
    name: "Source sync guards",
    description: "Controlled exact upstream files",
    enabled: true,
    policy: "manual",
    adapter: { type: "git", url: "https://github.com/example/sync-guards", ref: "main" },
    selection: { roots: ["skills"], include: [], exclude: [], mapping: {} },
    options: {},
  },
  contributions: ["alpha", "beta"].map((name) => ({
    member_key: `skills/${name}`,
    skill_id: `sync-guard-${name}`,
    mount_path: "",
    mapping: {},
    exclude: [],
  })),
}

function snapshot(commit: string, names: readonly string[]): SourceSnapshot {
  const tree = (commit === firstCommit ? "b" : commit === secondCommit ? "d" : "f").repeat(40)
  return {
    revision: commit,
    provenance: {
      provider: "git",
      git_url: "https://github.com/example/sync-guards",
      resolved_ref: commit,
      tree_hash: tree,
    },
    members: names.map((name): SourceSnapshot["members"][number] => {
      const root = `skills/${name}`
      const bytes = testBytes(
        `---\nname: ${name}\ndescription: Exact source ${name}\n---\n# ${name}\n\nCommit ${commit}.\n`,
      )
      const sha256 = createHash("sha256").update(bytes).digest("hex")
      return {
        member_key: root,
        source_path: root,
        portable: {
          kind: "skill",
          name,
          description: `Exact source ${name}`,
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
      }
    }),
  }
}

/** Only transport is controlled. The Source/projection coordinators and finite
 * operation kernel execute the production path against the same current rows. */
function provider(observations: readonly SourceSnapshot[]) {
  const bodies = new Map<string, Uint8Array>()
  for (const observed of observations)
    for (const member of observed.members)
      for (const file of member.portable.files)
        bodies.set(
          `https://raw.githubusercontent.com/example/sync-guards/${observed.revision}/${member.member_key}/${file.path}`,
          file.bytes,
        )
  return <A, E, R>(effect: Effect.Effect<A, E, R>) => {
    const client = HttpClient.make((request) => {
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
    return effect.pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
    )
  }
}

function skillPage(f: ReturnType<typeof currentWriteFixture>, skillId: string) {
  const field = library.skills.property_ids["Skill ID"]
  if (field === undefined) throw new Error("The fixture requires the registered Skill ID field.")
  const page = f
    .table("skills")
    .find((row) => text(property(property(row.properties)[field]).rich_text) === skillId)
  if (page === undefined) throw new Error(`The fixture did not create ${skillId}.`)
  return String(page.id)
}

test("Source sync guard fences the removed owner's unfinished projection before any Source mutation", async () => {
  const f = currentWriteFixture(parent)
  const original = snapshot(firstCommit, ["alpha", "beta"])
  const updated = snapshot(secondCommit, ["alpha"])
  const http = provider([original, updated])
  const beforeInput = await f.run(prepareCurrentSourceFromDiscovery(declaration, original))
  await f.run(
    http(
      writePreparedCurrentSource(library, {
        prepared: beforeInput,
        operation_id: "sync-guard-seed",
      }),
    ),
  )
  const before = await f.run(queryCurrentSourceManagement(library, sourceId))
  if (before === undefined) throw new Error("The seeded Source must be visible.")
  const removed = skillPage(f, "sync-guard-beta")
  f.failNext({ kind: "append", outcome: "accepted" })
  await expect(
    f.run(
      http(
        projectCurrentSkill(library, {
          target: removed,
          operation_id: "original-removed-projection",
        }),
      ),
    ),
  ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
  expect(
    await f.run(
      readCurrentOperationIntent(library, {
        kind: "skill",
        id: "sync-guard-beta",
      }),
    ),
  ).toMatchObject({ intent: { operation_id: "original-removed-projection", projection: true } })

  const desired = await f.run(prepareCurrentSourceFromDiscovery(declaration, updated))
  expect(desired.targets.map((target) => target.skill_id)).not.toContain("sync-guard-beta")
  f.clearCalls()
  let failure: unknown
  try {
    await f.run(
      http(
        writePreparedCurrentSource(library, {
          prepared: desired,
          operation_id: "sync-guard-update",
        }),
      ),
    )
  } catch (error) {
    failure = error
  }
  // Check actual mutation history before the error code: a later child refusal
  // cannot repair a Source manifest that was already advanced.
  expect(f.mutations()).toEqual([])
  expect(failure).toMatchObject({ code: "CURRENT_OPERATION_PENDING" })
  expect(await f.run(queryCurrentSourceManagement(library, sourceId))).toMatchObject({
    revision: before.revision,
    state: { state: "ready" },
  })
  expect(
    await f.run(readCurrentOperationIntent(library, { kind: "source", id: sourceId })),
  ).toBeUndefined()
  expect(
    await f.run(
      readCurrentOperationIntent(library, {
        kind: "skill",
        id: "sync-guard-beta",
      }),
    ),
  ).toMatchObject({ intent: { operation_id: "original-removed-projection" } })
})

const request: CurrentSourceSyncRequest = {
  source_ids: [sourceId],
  manager_id: "sync-guard-manager",
  execution_id: "sync-guard-generation",
  mode: "full",
  projection: "none",
}

function single(result: CurrentSourceSyncResult) {
  expect(result.results).toHaveLength(1)
  const item = result.results[0]
  if (item === undefined) throw new Error("The selected Source requires one result.")
  return item
}

const pendingSyncKeys = (f: ReturnType<typeof currentWriteFixture>) =>
  [...f.json.keys()].filter((key) => key.startsWith("operations/current-source-sync/"))

async function syncFixture() {
  const f = currentWriteFixture(parent)
  const observations = [firstCommit, secondCommit, thirdCommit].map((commit) =>
    snapshot(commit, ["alpha", "beta"]),
  )
  const snapshots = new Map(observations.map((observed) => [observed.revision, observed]))
  const transport = provider(observations)
  let head = firstCommit
  let afterCheck: (() => void) | undefined
  const checks: string[] = []
  const preparations: { commit: string; exact: string | null }[] = []
  const boundary: { prepare: typeof prepareCurrentSource; check: typeof checkCurrentSource } = {
    prepare: (input, options) =>
      Effect.gen(function* () {
        const parsed = validateCurrentSourceInput(input)
        const commit = options?.exactCommit ?? head
        const observed = snapshots.get(commit)
        if (observed === undefined)
          return yield* Effect.fail(fail("TEST_UNEXPECTED", "Unknown fixture commit."))
        preparations.push({ commit, exact: options?.exactCommit ?? null })
        const include = parsed.definition.selection.include
        return yield* prepareCurrentSourceFromDiscovery(parsed, {
          ...observed,
          members:
            include.length === 0
              ? observed.members
              : observed.members.filter((member) => include.includes(member.member_key)),
        })
      }),
    check: (selectedLibrary, input) =>
      Effect.gen(function* () {
        const observedCommit = head
        checks.push(observedCommit)
        const current = input.current
        const configuration_sha256 = yield* currentSourceConfigurationFingerprint(
          current.declaration,
        )
        const selected = yield* readCurrentSourceGitOrigin(selectedLibrary, {
          source_id: current.declaration.definition.source_id,
          page_id: current.page_id,
          revision: current.revision,
          content: current.content,
        })
        if (selected === undefined)
          return yield* Effect.fail(
            fail("TEST_UNEXPECTED", "The fixture requires a Git selection."),
          )
        const common = {
          source_id: current.declaration.definition.source_id,
          source_page_id: current.page_id,
          configuration_sha256,
          current_configuration_sha256: configuration_sha256,
          selected_commit: selected.commit,
          observation: {
            url: "https://github.com/example/sync-guards",
            ref: "main",
            resolved_ref: "refs/heads/main",
            resolved_commit: observedCommit,
            observed_at: 0,
          },
        }
        afterCheck?.()
        return observedCommit === selected.commit
          ? ({ ...common, status: "upstream_unchanged" } satisfies CurrentSourceCheckResult)
          : ({
              ...common,
              status: "update_available",
              reason: "upstream_changed",
            } satisfies CurrentSourceCheckResult)
      }),
  }
  const use = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    transport(effect.pipe(Effect.provideService(CurrentSourceSyncProvider, boundary)))
  const original = snapshots.get(firstCommit)
  if (original === undefined) throw new Error("The fixture requires its initial commit.")
  const initial = await f.run(prepareCurrentSourceFromDiscovery(declaration, original))
  await f.run(
    use(
      writePreparedCurrentSource(library, { prepared: initial, operation_id: "sync-fixture-seed" }),
    ),
  )
  return {
    f,
    use,
    checks,
    preparations,
    moveHead: (commit: string) => {
      if (!snapshots.has(commit)) throw new Error("Select an existing fixture commit.")
      head = commit
    },
    afterCheck: (callback?: () => void) => {
      afterCheck = callback
    },
    selected: () =>
      f.run(
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
        }),
      ),
  }
}

test("Source sync guard resolves a ready pending intent before an unchanged upstream decision", async () => {
  const h = await syncFixture()
  expect((await h.f.run(h.use(syncCurrentSources(library, request)))).status).toBe("complete")
  const page = h.f.pages.get(skillPage(h.f, "sync-guard-beta"))
  const origin = library.skills.property_ids.Origin
  if (page === undefined || origin === undefined)
    throw new Error("The fixture requires the beta owner and Origin.")
  property(page.properties)[origin] = {
    ...property(property(page.properties)[origin]),
    relation: [],
  }
  h.f.failNext({ kind: "source-ready", outcome: "accepted" })
  const interrupted = await h.f.run(h.use(syncCurrentSources(library, request)))
  expect(single(interrupted).error).toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
  expect(await h.f.run(queryCurrentSourceManagement(library, sourceId))).toMatchObject({
    state: { state: "ready" },
  })
  expect(pendingSyncKeys(h.f)).toHaveLength(1)
  const originalOperation = single(interrupted).operation_id
  expect(originalOperation).not.toBeNull()
  const checked = h.checks.length

  const resumed = await h.f.run(h.use(syncCurrentSources(library, { ...request, mode: "changed" })))
  expect(resumed.status).toBe("complete")
  expect(single(resumed)).toMatchObject({ status: "reconciled", operation_id: originalOperation })
  expect(h.checks).toHaveLength(checked)
  expect(pendingSyncKeys(h.f)).toEqual([])
  expect(
    await h.f.run(readCurrentOperationIntent(library, { kind: "source", id: sourceId })),
  ).toBeUndefined()
  expect(await h.selected()).toMatchObject({ commit: firstCommit })
})

test("Source sync guard freezes the observed commit before the branch moves during preparation", async () => {
  const h = await syncFixture()
  h.moveHead(secondCommit)
  h.afterCheck(() => h.moveHead(thirdCommit))
  const result = await h.f.run(h.use(syncCurrentSources(library, request)))
  expect(result.status).toBe("complete")
  expect(single(result).content).toMatchObject({
    status: "published",
    resolved_commit: secondCommit,
  })
  expect(h.checks).toEqual([secondCommit])
  expect(h.preparations).toEqual([{ commit: secondCommit, exact: secondCommit }])
  expect(await h.selected()).toMatchObject({ commit: secondCommit })
})

test("Source sync guard resumes its frozen commit without checking a newer branch after a lost Source response", async () => {
  const h = await syncFixture()
  h.moveHead(secondCommit)
  h.f.failNext({ kind: "source-properties", outcome: "accepted" })
  const interrupted = await h.f.run(h.use(syncCurrentSources(library, request)))
  expect(single(interrupted).error).toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
  expect(pendingSyncKeys(h.f)).toHaveLength(1)
  const operation = single(interrupted).operation_id
  h.moveHead(thirdCommit)
  const checked = h.checks.length
  const resumed = await h.f.run(h.use(syncCurrentSources(library, { ...request, mode: "changed" })))
  expect(resumed.status).toBe("complete")
  expect(single(resumed)).toMatchObject({
    operation_id: operation,
    content: { status: "published", resolved_commit: secondCommit },
  })
  expect(h.checks).toHaveLength(checked)
  expect(h.preparations.at(-1)).toEqual({ commit: secondCommit, exact: secondCommit })
  expect(await h.selected()).toMatchObject({ commit: secondCommit })
  expect(pendingSyncKeys(h.f)).toEqual([])
})

test("Source sync guard reconciles changed configuration at the same commit instead of reusing a stale no-op receipt", async () => {
  const h = await syncFixture()
  expect((await h.f.run(h.use(syncCurrentSources(library, request)))).status).toBe("complete")
  const current = await h.f.run(queryCurrentSourceManagement(library, sourceId))
  const selection = library.sources.property_ids.Selection
  if (current === undefined || selection === undefined)
    throw new Error("The fixture requires a current Source selection.")
  const row = h.f.pages.get(current.page_id)
  if (row === undefined) throw new Error("The Source row must exist.")
  property(row.properties)[selection] = {
    ...property(property(row.properties)[selection]),
    rich_text: sourceRich(
      JSON.stringify({ roots: ["skills"], include: ["skills/alpha"], exclude: [], mapping: {} }),
    ),
  }
  const beta = skillPage(h.f, "sync-guard-beta")
  const result = await h.f.run(h.use(syncCurrentSources(library, { ...request, mode: "changed" })))
  expect(single(result).error).toBeNull()
  expect(result.status).toBe("complete")
  expect(single(result).status).not.toBe("upstream_unchanged")
  expect(single(result).content).toMatchObject({
    status: "published",
    resolved_commit: firstCommit,
  })
  expect(h.f.pages.get(beta)).toMatchObject({ in_trash: true })
  expect(h.f.table("skills").map((page) => page.id)).not.toContain(beta)
  expect(await h.selected()).toMatchObject({ commit: firstCommit })
})

test("Source sync full repairs generated body drift at the same commit after changed mode skips it", async () => {
  const h = await syncFixture()
  const withProjection = { ...request, projection: "markdown" } satisfies CurrentSourceSyncRequest
  expect((await h.f.run(h.use(syncCurrentSources(library, withProjection)))).status).toBe(
    "complete",
  )
  const page = skillPage(h.f, "sync-guard-alpha")
  const before = await h.f.run(queryCurrentSkillIndex(library, page))
  const selected = await h.selected()
  const readingBody = async () =>
    (await h.f.run(readCurrentBodyBlocks(page))).map(({ value }) => ({
      type: value.type,
      content: value[String(value.type)],
    }))
  const originalBody = await readingBody()
  const drifted = structuredClone(h.f.blocks.get(page))
  const paragraph = drifted?.find((block) => block.type === "paragraph")
  if (drifted === undefined || paragraph === undefined)
    throw new Error("The completed Source projection requires an existing paragraph.")
  property(paragraph.paragraph).rich_text = sourceRich("External reading-only edit.")
  h.f.blocks.set(page, drifted)
  const driftedBody = await readingBody()
  expect(driftedBody).not.toEqual(originalBody)
  const prepared = h.preparations.length
  h.f.clearCalls()

  const unchanged = await h.f.run(
    h.use(syncCurrentSources(library, { ...withProjection, mode: "changed" })),
  )
  expect(unchanged.status).toBe("complete")
  expect(single(unchanged)).toMatchObject({
    status: "upstream_unchanged",
    projection: { status: "not_started" },
  })
  expect(h.preparations).toHaveLength(prepared)
  expect(h.f.mutations()).toEqual([])
  expect(await readingBody()).toEqual(driftedBody)
  h.f.clearCalls()

  const repaired = await h.f.run(h.use(syncCurrentSources(library, withProjection)))
  expect(repaired.status).toBe("complete")
  expect(single(repaired)).toMatchObject({
    content: { status: "published", resolved_commit: firstCommit },
    projection: { status: "complete", skill_ids: ["sync-guard-alpha", "sync-guard-beta"] },
  })
  expect(h.f.mutations().some((call) => call.path === `v1/pages/${page}/markdown`)).toBe(true)
  expect(await readingBody()).toEqual(originalBody)
  const after = await h.f.run(queryCurrentSkillIndex(library, page))
  expect(after.main).toMatchObject({
    file_id: before.main.file_id,
    page_id: before.main.page_id,
    skill_page_id: before.main.skill_page_id,
    path: before.main.path,
    content: before.main.content,
  })
  expect(await h.selected()).toEqual(selected)
  expect(pendingSyncKeys(h.f)).toEqual([])
  h.f.clearCalls()

  const repeated = await h.f.run(h.use(syncCurrentSources(library, withProjection)))
  expect(repeated.status).toBe("complete")
  expect(single(repeated).projection.status).toBe("complete")
  expect(h.f.mutations()).toEqual([])
  expect(await readingBody()).toEqual(originalBody)
  expect(await h.selected()).toEqual(selected)
  expect(pendingSyncKeys(h.f)).toEqual([])
})

test.each([
  { manager_id: "another-manager", execution_id: request.execution_id },
  { manager_id: request.manager_id, execution_id: "another-generation" },
])(
  "Source sync guard refuses a different manager or execution before touching the owned pending input: %j",
  async (identity) => {
    const h = await syncFixture()
    h.moveHead(secondCommit)
    h.f.failNext({ kind: "source-properties", outcome: "accepted" })
    const interrupted = await h.f.run(h.use(syncCurrentSources(library, request)))
    expect(single(interrupted).error).toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
    const before = structuredClone(
      [...h.f.json.entries()].filter(([key]) => key.startsWith("operations/current-source-sync/")),
    )
    const checked = h.checks.length,
      prepared = h.preparations.length
    h.f.clearCalls()
    const refused = await h.f.run(h.use(syncCurrentSources(library, { ...request, ...identity })))
    expect(refused.status).toBe("blocked")
    expect(single(refused)).toMatchObject({
      retryable: false,
      error: { code: "CURRENT_SOURCE_SYNC_CONFLICT" },
    })
    expect(h.f.mutations()).toEqual([])
    expect(h.checks).toHaveLength(checked)
    expect(h.preparations).toHaveLength(prepared)
    expect(
      [...h.f.json.entries()].filter(([key]) => key.startsWith("operations/current-source-sync/")),
    ).toEqual(before)
    expect((await h.f.run(h.use(syncCurrentSources(library, request)))).status).toBe("complete")
  },
)

test("Source sync guard keeps published content ready when projection fails and settles it before another upstream check", async () => {
  const h = await syncFixture()
  h.moveHead(secondCommit)
  h.f.failNext({ kind: "append", outcome: "accepted" })
  const withProjection = { ...request, projection: "markdown" } satisfies CurrentSourceSyncRequest
  const interrupted = await h.f.run(h.use(syncCurrentSources(library, withProjection)))
  expect(single(interrupted)).toMatchObject({
    content: { status: "published", resolved_commit: secondCommit },
    projection: { status: "pending" },
    error: { code: "WRITE_OUTCOME_UNKNOWN" },
  })
  expect(await h.f.run(queryCurrentSourceManagement(library, sourceId))).toMatchObject({
    state: { state: "ready" },
  })
  expect(await h.selected()).toMatchObject({ commit: secondCommit })
  expect(pendingSyncKeys(h.f)).toHaveLength(1)
  const checked = h.checks.length
  h.moveHead(thirdCommit)
  const resumed = await h.f.run(
    h.use(syncCurrentSources(library, { ...withProjection, mode: "changed" })),
  )
  expect(resumed.status).toBe("complete")
  expect(single(resumed)).toMatchObject({
    operation_id: single(interrupted).operation_id,
    content: { status: "published", resolved_commit: secondCommit },
    projection: { status: "complete", skill_ids: ["sync-guard-alpha", "sync-guard-beta"] },
  })
  expect(h.checks).toHaveLength(checked)
  expect(await h.selected()).toMatchObject({ commit: secondCommit })
  expect(pendingSyncKeys(h.f)).toEqual([])
})

test("Source sync guard verifies a completed writer after lost local phase advancement without overwriting later metadata", async () => {
  const h = await syncFixture()
  h.moveHead(secondCommit)
  let injected = false
  const interrupted = await h.f.run(
    h.use(
      Effect.gen(function* () {
        const store = yield* Store
        return yield* syncCurrentSources(library, request).pipe(
          Effect.provideService(Store, {
            ...store,
            writeJson: (key, value, options) => {
              if (
                !injected &&
                key.startsWith("operations/current-source-sync/") &&
                property(value).phase === "projection"
              ) {
                injected = true
                return Effect.fail(
                  fail("STATE_IO", "Controlled loss before saving the completed content phase."),
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
  expect(single(interrupted)).toMatchObject({
    content: { status: "published", resolved_commit: secondCommit },
    error: { code: "STATE_IO" },
  })
  const keys = pendingSyncKeys(h.f)
  expect(keys).toHaveLength(1)
  const key = keys[0]
  if (key === undefined) throw new Error("The unfinished phase must remain durable.")
  const frozen = structuredClone(h.f.json.get(key))
  expect(frozen).toMatchObject({ phase: "content" })
  expect(
    await h.f.run(readCurrentOperationIntent(library, { kind: "source", id: sourceId })),
  ).toBeUndefined()
  expect(await h.selected()).toMatchObject({ commit: secondCommit })
  const page = h.f.pages.get(skillPage(h.f, "sync-guard-alpha"))
  const main = library.skills.property_ids.Content
  if (page === undefined || main === undefined)
    throw new Error("The fixture requires an authoritative main binding.")
  const originalMain = structuredClone(property(page.properties)[main])
  const originalDescriptor: unknown = JSON.parse(text(property(originalMain).rich_text))
  expect(originalDescriptor).toMatchObject({ kind: "source", source_path: "skills/alpha/SKILL.md" })
  const driftMain = {
    ...property(originalMain),
    rich_text: sourceRich(
      JSON.stringify({ ...property(originalDescriptor), source_path: "skills/beta/SKILL.md" }),
    ),
  }
  property(page.properties)[main] = driftMain
  const checked = h.checks.length
  h.f.clearCalls()

  const refused = await h.f.run(h.use(syncCurrentSources(library, request)))
  expect(refused.status).toBe("blocked")
  expect(single(refused).error).toMatchObject({ code: "CURRENT_SOURCE_WRITE_CONFLICT" })
  expect(h.f.mutations()).toEqual([])
  expect(property(page.properties)[main]).toEqual(driftMain)
  expect(h.f.json.get(key)).toEqual(frozen)
  expect(h.checks).toHaveLength(checked)
  expect(
    await h.f.run(readCurrentOperationIntent(library, { kind: "source", id: sourceId })),
  ).toBeUndefined()

  property(page.properties)[main] = originalMain
  h.f.clearCalls()
  const completed = await h.f.run(h.use(syncCurrentSources(library, request)))
  expect(completed.status).toBe("complete")
  expect(single(completed)).toMatchObject({
    operation_id: single(interrupted).operation_id,
    status: "reconciled",
  })
  expect(h.f.mutations()).toEqual([])
  expect(pendingSyncKeys(h.f)).toEqual([])
})

/** Exhaust the actual shared invocation budget just before the second target's
 * projection reads. Metadata/provider responses remain the controlled fixture;
 * this is a progress proof, not a claim about production HTTP request cost. */
async function pausedProjectionPrefix() {
  const h = await syncFixture()
  h.moveHead(secondCommit)
  const alpha = skillPage(h.f, "sync-guard-alpha")
  const beta = skillPage(h.f, "sync-guard-beta")
  const selected = {
    ...request,
    mode: "changed",
    projection: "markdown",
  } satisfies CurrentSourceSyncRequest
  let exhausted = false
  const paused = await h.f.run(
    h.use(
      Effect.gen(function* () {
        const api = yield* Notion
        return yield* syncCurrentSources(library, selected).pipe(
          Effect.provideService(Notion, {
            ...api,
            request: (path, body, options) =>
              Effect.gen(function* () {
                if (
                  !exhausted &&
                  path.split("?")[0] === `v1/blocks/${beta}/children` &&
                  (options?.method === undefined || options.method === "GET")
                ) {
                  exhausted = true
                  const supplied = yield* Effect.serviceOption(RequestBudget)
                  if (Option.isNone(supplied))
                    return yield* Effect.fail(
                      fail(
                        "TEST_UNEXPECTED",
                        "The invocation must supply its shared request budget.",
                      ),
                    )
                  const budget = supplied.value
                  const before = yield* budget.snapshot
                  for (let index = before.attempts; index < before.limits.requests; index++)
                    yield* budget.admit(0)
                  yield* budget.check
                }
                return yield* api.request(path, body, options)
              }),
          }),
        )
      }),
    ),
  )
  expect(exhausted).toBe(true)
  expect(paused.status).toBe("retryable")
  expect(paused.budget.exhausted).toBe("requests")
  expect(single(paused)).toMatchObject({
    content: { status: "published", resolved_commit: secondCommit },
    projection: { status: "pending", completed_skill_ids: ["sync-guard-alpha"] },
  })
  const keys = pendingSyncKeys(h.f)
  expect(keys).toHaveLength(1)
  const key = keys[0]
  if (key === undefined) throw new Error("The paused projection must retain its finite input.")
  const saved = structuredClone(h.f.json.get(key))
  expect(saved).toMatchObject({ phase: "projection", next_index: 1 })
  return { ...h, selected, alpha, beta, key, saved, paused }
}

test("Source sync progress resumes only remaining projections after the shared budget stops a completed prefix", async () => {
  const h = await pausedProjectionPrefix()
  const alphaBody = structuredClone(h.f.blocks.get(h.alpha))
  const checked = h.checks.length
  h.moveHead(thirdCommit)
  h.f.clearCalls()
  const resumed = await h.f.run(h.use(syncCurrentSources(library, h.selected)))
  expect(resumed.status).toBe("complete")
  expect(single(resumed)).toMatchObject({
    operation_id: single(h.paused).operation_id,
    content: { status: "published", resolved_commit: secondCommit },
    projection: { status: "complete", skill_ids: ["sync-guard-alpha", "sync-guard-beta"] },
  })
  expect(h.checks).toHaveLength(checked)
  expect(
    h.f.calls.filter((call) => call.path.split("?")[0] === `v1/blocks/${h.alpha}/children`),
  ).toEqual([])
  expect(h.f.blocks.get(h.alpha)).toEqual(alphaBody)
  expect(pendingSyncKeys(h.f)).toEqual([])
})

test("Source sync progress refuses even the original projection ID when a completed prefix gains another pending intent", async () => {
  const h = await pausedProjectionPrefix()
  const operation = property(property(h.saved).input).operation_id
  if (typeof operation !== "string")
    throw new Error("The projection prefix must retain its original Source operation.")
  const originalProjection =
    "source-projection-" +
    createHash("sha256")
      .update(JSON.stringify([operation, "sync-guard-alpha"]))
      .digest("hex")
  h.f.blocks.set(h.alpha, [])
  h.f.failNext({ kind: "append", outcome: "accepted" })
  await expect(
    h.f.run(
      h.use(
        projectCurrentSkill(library, {
          target: h.alpha,
          operation_id: originalProjection,
        }),
      ),
    ),
  ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
  expect(
    await h.f.run(readCurrentOperationIntent(library, { kind: "skill", id: "sync-guard-alpha" })),
  ).toMatchObject({ intent: { operation_id: originalProjection } })
  h.f.clearCalls()
  const refused = await h.f.run(h.use(syncCurrentSources(library, h.selected)))
  expect(refused.status).toBe("blocked")
  expect(single(refused).error).toMatchObject({ code: "CURRENT_SOURCE_SYNC_CONFLICT" })
  expect(h.f.mutations()).toEqual([])
  expect(h.f.json.get(h.key)).toEqual(h.saved)
  expect(
    await h.f.run(readCurrentOperationIntent(library, { kind: "skill", id: "sync-guard-alpha" })),
  ).toMatchObject({ intent: { operation_id: originalProjection } })
})

test("Source sync progress keeps its projection cursor bound to the original Source configuration", async () => {
  const h = await pausedProjectionPrefix()
  const current = await h.f.run(queryCurrentSourceManagement(library, sourceId))
  const selection = library.sources.property_ids.Selection
  if (current === undefined || selection === undefined)
    throw new Error("The Source selection must remain available.")
  const row = h.f.pages.get(current.page_id)
  if (row === undefined) throw new Error("The original Source page must remain available.")
  const original = structuredClone(property(row.properties)[selection])
  property(row.properties)[selection] = {
    ...property(original),
    rich_text: sourceRich(
      JSON.stringify({ roots: ["skills"], include: ["skills/alpha"], exclude: [], mapping: {} }),
    ),
  }
  h.f.clearCalls()
  const refused = await h.f.run(h.use(syncCurrentSources(library, h.selected)))
  expect(refused.status).toBe("blocked")
  expect(single(refused).error).toMatchObject({ code: "CURRENT_SOURCE_SYNC_CONFLICT" })
  expect(h.f.mutations()).toEqual([])
  expect(h.f.json.get(h.key)).toEqual(h.saved)
  property(row.properties)[selection] = original
  expect((await h.f.run(h.use(syncCurrentSources(library, h.selected)))).status).toBe("complete")
})

test("Source sync progress does not advance a projection cursor before its durable save succeeds", async () => {
  const h = await syncFixture()
  h.moveHead(secondCommit)
  const selected = {
    ...request,
    mode: "changed",
    projection: "markdown",
  } satisfies CurrentSourceSyncRequest
  let injected = false
  const interrupted = await h.f.run(
    h.use(
      Effect.gen(function* () {
        const store = yield* Store
        return yield* syncCurrentSources(library, selected).pipe(
          Effect.provideService(Store, {
            ...store,
            writeJson: (key, value, options) => {
              if (
                !injected &&
                key.startsWith("operations/current-source-sync/") &&
                property(value).phase === "projection" &&
                property(value).next_index === 1
              ) {
                injected = true
                return Effect.fail(
                  fail("STATE_IO", "Controlled loss before saving the first verified target."),
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
  expect(single(interrupted)).toMatchObject({
    content: { status: "published", resolved_commit: secondCommit },
    projection: { status: "pending", completed_skill_ids: [] },
    error: { code: "STATE_IO" },
  })
  const keys = pendingSyncKeys(h.f)
  expect(keys).toHaveLength(1)
  const key = keys[0]
  if (key === undefined) throw new Error("The uncommitted target must retain its original cursor.")
  expect(h.f.json.get(key)).toMatchObject({ phase: "projection", next_index: 0 })
  const alpha = skillPage(h.f, "sync-guard-alpha")
  const alphaBody = structuredClone(h.f.blocks.get(alpha))
  h.f.clearCalls()
  const completed = await h.f.run(h.use(syncCurrentSources(library, selected)))
  expect(completed.status).toBe("complete")
  expect(
    h.f.mutations().filter((call) => call.path.split("?")[0] === `v1/blocks/${alpha}/children`),
  ).toEqual([])
  expect(h.f.blocks.get(alpha)).toEqual(alphaBody)
  expect(pendingSyncKeys(h.f)).toEqual([])
})

/** Lose only local child retirement after the real Source and projection writers
 * completed and their exact result was saved in the existing full batch. */
async function completedChildAwaitingRetirement() {
  const h = await syncFixture()
  h.moveHead(secondCommit)
  const command = { ...request, projection: "markdown" } satisfies CurrentSourceSyncRequest
  let interrupted = false
  const stopped = await h.f.run(
    h.use(
      Effect.gen(function* () {
        const store = yield* Store
        return yield* syncCurrentSources(library, command).pipe(
          Effect.provideService(Store, {
            ...store,
            retireKeys: (keys) => {
              if (
                !interrupted &&
                keys.some((key) => key.startsWith("operations/current-source-sync/"))
              ) {
                const batch = [...h.f.json].find(([key]) =>
                  key.startsWith("operations/current-source-sync-batch/"),
                )
                const results = batch === undefined ? undefined : property(batch[1]).results
                if (!Array.isArray(results) || results.length !== 1)
                  return Effect.fail(
                    fail("TEST_UNEXPECTED", "The parent must checkpoint before child retirement."),
                  )
                interrupted = true
                return Effect.fail(
                  fail(
                    "STATE_BUSY",
                    "Controlled loss after parent completion but before child retirement.",
                  ),
                )
              }
              return store.retireKeys(keys)
            },
          }),
        )
      }),
    ),
  )
  expect(interrupted).toBe(true)
  expect(stopped.status).toBe("retryable")
  expect(currentSourceSyncExitCode(stopped)).toBe(75)
  expect(single(stopped)).toMatchObject({
    content: { status: "published", resolved_commit: secondCommit },
    projection: { status: "complete", skill_ids: ["sync-guard-alpha", "sync-guard-beta"] },
    error: { code: "STATE_BUSY" },
  })
  const sourceKeys = pendingSyncKeys(h.f)
  expect(sourceKeys).toHaveLength(1)
  const sourceKey = sourceKeys[0]
  const parentEntry = [...h.f.json].find(([key]) =>
    key.startsWith("operations/current-source-sync-batch/"),
  )
  if (sourceKey === undefined || parentEntry === undefined)
    throw new Error("Both parent completion and the unfinished local child must remain.")
  const child = structuredClone(h.f.json.get(sourceKey))
  const parent = Schema.decodeUnknownSync(CurrentSourceSyncBatchSchema)(
    structuredClone(parentEntry[1]),
  )
  const results = parent.results
  if (results.length !== 1) throw new Error("The parent requires one exact terminal result.")
  const terminal = results[0]
  if (
    terminal === undefined ||
    (terminal.status !== "applied" && terminal.status !== "reconciled") ||
    terminal.error !== null
  )
    throw new Error("The protected parent must contain the successful Source completion.")
  expect(child).toMatchObject({ phase: "projection", next_index: 2 })
  expect(terminal).toMatchObject({
    status: "applied",
    retryable: false,
    error: null,
    operation_id: single(stopped).operation_id,
    content: { status: "published", resolved_commit: secondCommit },
    projection: { status: "complete", skill_ids: ["sync-guard-alpha", "sync-guard-beta"] },
  })
  return { ...h, command, sourceKey, parentKey: parentEntry[0], child, parent, terminal, stopped }
}

test("Source sync progress uses the exact saved parent completion to finish child cleanup before reporting full success", async () => {
  const h = await completedChildAwaitingRetirement()
  const checks = h.checks.length,
    preparations = h.preparations.length
  h.moveHead(thirdCommit)
  h.f.clearCalls()
  const finished = await h.f.run(h.use(syncCurrentSources(library, h.command)))
  expect(finished.status).toBe("complete")
  expect(currentSourceSyncExitCode(finished)).toBe(0)
  expect(single(finished)).toEqual(h.terminal)
  expect(h.checks).toHaveLength(checks)
  expect(h.preparations).toHaveLength(preparations)
  expect(h.f.calls).toEqual([])
  expect(pendingSyncKeys(h.f)).toEqual([])
  expect(h.f.json.has(h.parentKey)).toBe(false)
})

test("Source sync progress rejects a mismatched parent completion and lets changed retire only the exactly completed child", async () => {
  const h = await completedChildAwaitingRetirement()
  const checks = h.checks.length,
    preparations = h.preparations.length
  const selected = { ...h.command, mode: "changed" } satisfies CurrentSourceSyncRequest
  const content = property(h.terminal.content)
  const mismatches = [
    { ...h.terminal, operation_id: "different-source-operation" },
    { ...h.terminal, content: { ...content, resolved_commit: thirdCommit } },
    { ...h.terminal, content: { ...content, configuration_sha256: "1".repeat(64) } },
    { ...h.terminal, content: { ...content, revision: "2".repeat(64) } },
    { ...h.terminal, projection: { status: "complete", skill_ids: ["sync-guard-alpha"] } },
  ]
  h.moveHead(thirdCommit)
  for (const item of mismatches) {
    for (const command of [h.command, selected]) {
      const corrupted = { ...h.parent, results: [item] }
      h.f.json.set(h.parentKey, corrupted)
      h.f.clearCalls()
      const blocked = await h.f.run(h.use(syncCurrentSources(library, command)))
      expect(blocked.status).toBe("blocked")
      expect(single(blocked).error).toMatchObject({ code: "CURRENT_SOURCE_SYNC_CONFLICT" })
      expect(h.f.mutations()).toEqual([])
      expect(h.f.calls.some((call) => call.path.startsWith("v1/blocks/"))).toBe(false)
      expect(h.checks).toHaveLength(checks)
      expect(h.preparations).toHaveLength(preparations)
      expect(h.f.json.get(h.sourceKey)).toEqual(h.child)
      expect(h.f.json.get(h.parentKey)).toEqual(corrupted)
    }
  }
  h.f.json.set(h.parentKey, h.parent)
  h.f.clearCalls()
  const cleaned = await h.f.run(h.use(syncCurrentSources(library, selected)))
  expect(cleaned.status).toBe("complete")
  expect(single(cleaned)).toEqual({ ...h.terminal, status: "reconciled" })
  expect(h.f.mutations()).toEqual([])
  expect(h.f.calls.some((call) => call.path.startsWith("v1/blocks/"))).toBe(false)
  expect(h.checks).toHaveLength(checks)
  expect(h.preparations).toHaveLength(preparations)
  expect(pendingSyncKeys(h.f)).toEqual([])
  expect(h.f.json.get(h.parentKey)).toEqual(h.parent)
  h.f.clearCalls()
  const acknowledged = await h.f.run(h.use(syncCurrentSources(library, h.command)))
  expect(acknowledged.status).toBe("complete")
  expect(single(acknowledged)).toEqual(h.terminal)
  expect(h.f.calls).toEqual([])
  expect(h.f.json.has(h.parentKey)).toBe(false)
})
