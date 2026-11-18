import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import {
  acceptCurrentSharedBodyWrite,
  completedSharedBodyCurrentAcceptance,
  observeSharedBodyCurrentAcceptance,
} from "../src/shared-body-current-acceptance.ts"
import {
  executeSharedBodyWrite,
  loadPendingSharedBodyWrites,
  prepareSharedBodyWrite,
  reconcileSharedBodyWrite,
} from "../src/shared-body-write.ts"
import {
  bodyWriteOutcomeId,
  makeSharedBodyWritePlan,
  type SharedBodyWritePlan,
} from "../src/shared-body-write-model.ts"
import { querySharedOperationIndex } from "../src/shared-operation-index.ts"
import { canonicalSharedJson, querySharedRecords } from "../src/shared-records.ts"
import { querySharedSkillIndex } from "../src/shared-skill-index.ts"
import { FileEventSchema } from "../src/shared-file-state.ts"
import type { SharedLibrary } from "../src/shared-library-model.ts"
import { sourceDefinitionPropertiesFor } from "../src/shared-source-definitions.ts"
import { sourceDefinitionLayout } from "../src/shared-sources-model.ts"
import { property } from "../src/model.ts"
import { projectSharedNotionMarkdown } from "../src/shared-notion-projection.ts"
import { makeSourceBinding } from "../src/shared-source-binding.ts"
import { Notion } from "../src/notion.ts"
import { openSharedSnapshot } from "../src/shared-snapshot.ts"
import { sharedSnapshotFixture } from "./shared-snapshot-fixture.ts"
import {
  candidate,
  original,
  client,
  creates,
  eventRows,
  fileId,
  failure,
  hash,
  id,
  library,
  patches,
  payloadFor,
  prepare,
  remote,
  rowRecordId,
  seed,
  skillPage,
} from "./shared-body-write-review-fixture.ts"

const scope = hash("current-acceptance-scope")
const accept = (
  plan: SharedBodyWritePlan,
  options: {
    dryRun?: boolean
    mode?: "create" | "reconcile"
    accepted?: string
    library?: SharedLibrary
  } = {},
) =>
  acceptCurrentSharedBodyWrite({
    library: options.library ?? library,
    skillPageId: skillPage,
    originalOperationId: plan.operation_id,
    acceptedObservedSha256: options.accepted ?? hash(candidate),
    scope,
    dryRun: options.dryRun ?? false,
    mode: options.mode ?? "create",
  })

const sourceLayout = sourceDefinitionLayout(
  library.skills.data_source_id,
  library.records.data_source_id,
)
const sourceIds = Object.fromEntries(
  Object.keys(sourceLayout).map((name, i) => [name, `source-${i}`]),
)
const restoreLibrary: SharedLibrary = {
  ...library,
  skills: {
    ...library.skills,
    property_ids: { ...library.skills.property_ids, Origin: "origin", "Source Member": "member" },
  },
  sources: { database_id: id(80), data_source_id: id(81), property_ids: sourceIds },
}
const acceptRestore = (plan: SharedBodyWritePlan, options: Parameters<typeof accept>[1] = {}) =>
  accept(plan, { accepted: hash(original), ...options, library: restoreLibrary })
const restoreMetadata = {
  mode: "100644" as const,
  frontmatter:
    "---\nname: Write fixture\ndescription: Whole-file write fixture\nlicense: MIT\n---\n",
}

function attachRestoreSource(shared: ReturnType<typeof remote>) {
  const props = sourceDefinitionPropertiesFor(restoreLibrary, {
    version: 1,
    source_id: "origin-fixture",
    name: "Fixture source",
    description: "Fixed source",
    enabled: true,
    policy: "pinned",
    adapter: { type: "git", url: "https://github.com/owner/repo", ref: "c".repeat(40) },
    selection: { roots: ["skill"], include: [], exclude: [], mapping: {} },
    options: { storage: "fixed-git" },
  })
  const source = {
    object: "page",
    id: id(82),
    parent: { data_source_id: restoreLibrary.sources!.data_source_id },
    properties: Object.fromEntries(
      Object.entries(sourceLayout).map(([name, shape]) => {
        const key = sourceIds[name]!,
          type = Object.keys(shape)[0]!
        return [
          key,
          {
            id: key,
            type,
            ...(props[key] ??
              (type === "rich_text"
                ? { rich_text: [] }
                : type === "relation"
                  ? { relation: [], has_more: false }
                  : type === "select"
                    ? { select: null }
                    : { date: null })),
          },
        ]
      }),
    ),
  }
  shared.pages = new Map([[source.id, source]])
  shared.skillProperties = {
    origin: { relation: [{ id: source.id }] },
    member: { rich_text: [{ type: "text", text: { content: "skill" } }] },
  }
  return source
}

function observeRestore(plan: SharedBodyWritePlan) {
  return Effect.gen(function* () {
    const index = yield* querySharedSkillIndex(restoreLibrary, skillPage)
    const headers = yield* querySharedOperationIndex(restoreLibrary, skillPage)
    const rows = yield* querySharedRecords(restoreLibrary, {
      kind: "file_event",
      skillPageId: skillPage,
      entityId: fileId,
    })
    const events = rows.map((row) => Schema.decodeUnknownSync(FileEventSchema)(row.payload))
    return yield* observeSharedBodyCurrentAcceptance(restoreLibrary, plan, {
      index,
      headers,
      events,
    })
  })
}

async function delayedEvent(markdown = candidate, projected = false) {
  const shared = remote()
  const projection = projectSharedNotionMarkdown(markdown, { version: 15, purpose: "body_write" })
  const api = client(shared, {
    ...(projected ? { readback: () => projection.markdown } : {}),
    afterRecord(kind, id) {
      if (kind !== "file_event") return
      const row = [...shared.rows.values()].find((value) => rowRecordId(value) === id)
      if (row !== undefined) shared.hidden.add(String(row.id))
    },
  })
  const plan = await api.run(
    projected
      ? prepareSharedBodyWrite({
          library,
          skillPageId: skillPage,
          fileId,
          candidateMarkdown: projection.markdown,
          inputProjection: projection,
          action: "write",
        })
      : prepare(markdown),
  )
  const result = await api.run(
    executeSharedBodyWrite(library, { plan, mode: "create" }).pipe(Effect.result),
  )
  expect(failure(result).code).toBe("SHARED_BODY_WRITE_UNRESOLVED")
  expect(patches(api)).toHaveLength(1)
  expect(payloadFor(shared, bodyWriteOutcomeId(plan.operation_id))).toBeUndefined()
  shared.hidden.clear()
  return { shared, plan }
}

async function delayedRestore(
  options: { sameBody?: boolean; visible?: boolean; unknownEvent?: boolean } = {},
) {
  const metadata = restoreMetadata
  const shared = remote(original, metadata)
  const source = attachRestoreSource(shared)
  const api = client(shared, {
    ...(options.unknownEvent ? { unknownRecord: "file_event" as const } : {}),
    afterRecord(kind, recordId) {
      if (kind !== "file_event") return
      const row = [...shared.rows.values()].find((value) => rowRecordId(value) === recordId)
      if (row !== undefined) shared.hidden.add(String(row.id))
    },
  })
  const markdown = options.sameBody === false ? candidate : original
  const fixed = await api.run(
    makeSourceBinding({
      url: "https://github.com/owner/repo",
      commit: "c".repeat(40),
      tree: "d".repeat(40),
      root: "skill",
      files: [
        {
          path: "SKILL.md",
          source_path: "skill/SKILL.md",
          git_oid: "e".repeat(40),
          bytes: markdown.length,
          mode: "100644",
        },
      ],
    }),
  )
  seed(shared, "source", fixed.source_id, `register-${fixed.source_id}`, fixed.source_id, fixed)
  shared.source = fixed.source_id
  const plan = await api.run(
    prepareSharedBodyWrite({
      library: restoreLibrary,
      skillPageId: skillPage,
      fileId,
      action: "restore_follow",
      candidateMarkdown: markdown,
      source: { source_id: fixed.source_id, revision: fixed.commit, path: "SKILL.md", ...metadata },
    }),
  )
  const result = await api.run(
    executeSharedBodyWrite(restoreLibrary, { plan, mode: "create" }).pipe(Effect.result),
  )
  expect(failure(result).code).toBe(
    options.unknownEvent ? "WRITE_OUTCOME_UNKNOWN" : "SHARED_BODY_WRITE_UNRESOLVED",
  )
  expect(patches(api)).toHaveLength(options.sameBody === false ? 1 : 0)
  expect(payloadFor(shared, bodyWriteOutcomeId(plan.operation_id))).toBeUndefined()
  if (options.visible !== false) shared.hidden.clear()
  return { shared, plan, source }
}

describe("independent acceptance of an unchanged-body restore", () => {
  test("an acknowledged restore event delayed in query can be explicitly accepted without claiming the original completed", async () => {
    const { shared, plan } = await delayedRestore()
    const api = client(shared)
    expect(plan.source_context?.definition?.page_id).toBe(id(82))
    const preview = await api.run(acceptRestore(plan, { dryRun: true }))
    expect(preview.status).toBe("planned")
    expect(preview.original_write_outcome).toBe("unknown")
    expect(creates(api)).toHaveLength(0)
    const result = await api.run(acceptRestore(plan))
    expect(result.status).toBe("reviewed")
    expect(result.original_write_outcome).toBe("unknown")
    expect(result.event).toEqual(plan.event)
    expect(creates(api)).toHaveLength(1)
    expect(patches(api)).toHaveLength(0)
    expect(payloadFor(shared, bodyWriteOutcomeId(plan.operation_id))).toBeUndefined()
    const coldState = {
      ...shared,
      local: new Map<string, unknown>(),
      retired: new Map<string, unknown>(),
    }
    const cold = client(coldState)
    const observed = await cold.run(observeRestore(plan))
    expect(coldState.local.size).toBe(0)
    expect(observed?.acceptance.decision).toBe("accepted_current")
    expect(observed?.acceptance.original_write_outcome).toBe("unknown")
    expect(observed?.observation.state.ownership).toEqual({
      kind: "following",
      source_revision: plan.restore_source!.revision,
      projection: { normalization_version: 1, sha256: hash(original) },
      ...restoreMetadata,
    })
    expect(observed?.observation.body.markdown).toBe(original)
    expect((await cold.run(reconcileSharedBodyWrite(restoreLibrary, plan))).status).toBe("reviewed")
    expect(creates(cold)).toHaveLength(0)
    expect(patches(cold)).toHaveLength(0)
  })

  test.each([false, true])(
    "a still-invisible restore event cannot be inferred from the unchanged body (unknown POST: %s)",
    async (unknownEvent) => {
      const { shared, plan } = await delayedRestore({ visible: false, unknownEvent })
      const api = client(shared)
      expect(failure(await api.run(acceptRestore(plan).pipe(Effect.result))).code).toBe(
        "SHARED_CURRENT_ACCEPTANCE_INELIGIBLE",
      )
      expect(creates(api)).toHaveLength(0)
      expect(patches(api)).toHaveLength(0)
    },
  )

  test("a restore that dispatched a body PATCH cannot use unchanged-body acceptance", async () => {
    const { shared, plan } = await delayedRestore({ sameBody: false })
    const api = client(shared)
    expect(
      failure(await api.run(acceptRestore(plan, { accepted: hash(candidate) }).pipe(Effect.result)))
        .code,
    ).toBe("SHARED_CURRENT_ACCEPTANCE_INELIGIBLE")
    expect(creates(api)).toHaveLength(0)
    expect(patches(api)).toHaveLength(0)
  })

  test("a fully visible exact event after an unknown POST permits only an independent decision", async () => {
    const { shared, plan } = await delayedRestore({ unknownEvent: true })
    const api = client(shared)
    expect(
      failure(await api.run(reconcileSharedBodyWrite(restoreLibrary, plan).pipe(Effect.result)))
        .code,
    ).toBe("SHARED_BODY_WRITE_UNRESOLVED")
    expect(creates(api)).toHaveLength(0)
    const result = await api.run(acceptRestore(plan))
    expect(result.original_status).toBe("unknown")
    expect(result.decision).toBe("accepted_current")
    expect(payloadFor(shared, bodyWriteOutcomeId(plan.operation_id))).toBeUndefined()
    expect(creates(api)).toHaveLength(1)
    expect(patches(api)).toHaveLength(0)
  })

  test("a public cold snapshot requires the independent decision and preserves the complete following file", async () => {
    const { shared, plan } = await delayedRestore()
    const read = () => {
      const cold = sharedSnapshotFixture({ fileCount: 1 })
      const transport = client({ ...shared, local: new Map(), retired: new Map() })
      const effect = openSharedSnapshot({
        library: restoreLibrary,
        target: skillPage,
        scope,
        startedAt: Date.now(),
        forceFull: true,
        readOnly: true,
        fixedSource: {
          source_id: shared.source,
          revision: plan.restore_source!.revision,
          files: [
            {
              path: "SKILL.md",
              bytes: new TextEncoder().encode(restoreMetadata.frontmatter + original),
              mode: restoreMetadata.mode,
            },
          ],
        },
      }).pipe(Effect.provideService(Notion, transport.api))
      expect(cold.json.size).toBe(0)
      expect(cold.objects.size).toBe(0)
      return { cold, transport, effect }
    }
    const pending = read()
    expect(failure(await pending.cold.run(pending.effect.pipe(Effect.result))).code).toBe(
      "SHARED_BODY_WRITE_UNRESOLVED",
    )
    expect(creates(pending.transport)).toHaveLength(0)
    await client(shared).run(acceptRestore(plan))
    const accepted = read()
    const snapshot = await accepted.cold.run(accepted.effect)
    expect(snapshot.files.map((file) => file.path)).toEqual(["SKILL.md"])
    expect(snapshot.files[0]?.mode).toBe("100644")
    const body = new TextDecoder().decode(
      accepted.cold.objects.get(`objects/${snapshot.files[0]!.sha256}`),
    )
    expect(body).toBe(
      '---\n"description": "Whole-file write fixture"\n"license": "MIT"\n"name": "Write fixture"\n---\n\n' +
        original,
    )
    expect(creates(accepted.transport)).toHaveLength(0)
    expect(patches(accepted.transport)).toHaveLength(0)
    expect(payloadFor(shared, bodyWriteOutcomeId(plan.operation_id))).toBeUndefined()
    const decisionRow = [...shared.rows.values()].find((row) =>
      rowRecordId(row).startsWith("accept-current-"),
    )!
    const decisionId = rowRecordId(decisionRow)
    const decision = property(payloadFor(shared, decisionId))
    shared.rows.delete(String(decisionRow.id))
    seed(shared, "operation", decisionId, decisionId, fileId, {
      ...decision,
      original_plan_sha256: "f".repeat(64),
    })
    const altered = read()
    expect(failure(await altered.cold.run(altered.effect.pipe(Effect.result))).code).toBe(
      "SHARED_CURRENT_ACCEPTANCE_INVALID",
    )
    expect(creates(altered.transport)).toHaveLength(0)
    expect(patches(altered.transport)).toHaveLength(0)
  })

  test("an older restore without frozen Source context is not eligible", async () => {
    const { shared, plan } = await delayedRestore()
    const api = client(shared)
    const legacy = await api.run(
      makeSharedBodyWritePlan({
        ...plan,
        source_context: undefined,
        candidateMarkdown: plan.candidate.markdown,
        parents: plan.event.parents,
      }),
    )
    seed(shared, "operation", legacy.operation_id, legacy.operation_id, fileId, legacy)
    expect(failure(await api.run(acceptRestore(legacy).pipe(Effect.result))).code).toBe(
      "SHARED_CURRENT_ACCEPTANCE_INELIGIBLE",
    )
    expect(creates(api)).toHaveLength(0)
    expect(patches(api)).toHaveLength(0)
  })

  test.each([
    "selection",
    "definition",
    "member",
    "body",
    "raw_body",
    "header",
    "mode",
    "name",
    "description",
    "frontier",
  ] as const)(
    "changed %s refuses both a new decision and cold current consumption",
    async (change) => {
      const { shared, plan, source } = await delayedRestore()
      const preview = await client(shared).run(acceptRestore(plan, { dryRun: true }))
      if (preview.status !== "planned") throw new Error("Expected acceptance preview")
      if (change === "selection") shared.source = "source-" + "f".repeat(64)
      if (change === "definition")
        property(source.properties[sourceIds.Ref!]).rich_text = [
          { text: { content: "f".repeat(40) } },
        ]
      if (change === "member")
        shared.skillProperties!.member = { rich_text: [{ text: { content: "other-member" } }] }
      if (change === "body") shared.markdown += "Concurrent user edit.\n"
      if (change === "raw_body") shared.markdown = original.replace(/\n/g, "\r\n")
      if (change === "name")
        shared.skillProperties!.name = { title: [{ text: { content: "Renamed fixture" } }] }
      if (change === "description")
        shared.skillProperties!.description = {
          rich_text: [{ text: { content: "Changed description" } }],
        }
      if (change === "header" || change === "mode") {
        for (const [key, row] of shared.rows)
          if (rowRecordId(row) === plan.event.event_id) shared.rows.delete(key)
        const altered = {
          ...plan.event,
          ...(change === "header"
            ? { frontmatter: "---\nname: other\n---\n" }
            : { mode: "100755" }),
        }
        seed(shared, "file_event", plan.event.event_id, plan.event.event_id, fileId, altered)
      }
      if (change === "frontier")
        seed(shared, "file_event", "later-event", "later-event", fileId, {
          event_id: "later-event",
          file_id: fileId,
          parents: [plan.event.event_id],
          kind: "adopted",
          content: plan.candidate.content,
        })
      const api = client(shared)
      expect((await api.run(acceptRestore(plan).pipe(Effect.result)))._tag).toBe("Failure")
      expect(creates(api)).toHaveLength(0)
      expect(patches(api)).toHaveLength(0)
      expect(shared.local.size).toBe(0)
      seed(
        shared,
        "operation",
        preview.operation_id,
        preview.operation_id,
        fileId,
        preview.decision_record,
      )
      const cold = client({ ...shared, local: new Map(), retired: new Map() })
      expect((await cold.run(observeRestore(plan).pipe(Effect.result)))._tag).toBe("Failure")
      expect(creates(cold)).toHaveLength(0)
      expect(patches(cold)).toHaveLength(0)
      expect(payloadFor(shared, bodyWriteOutcomeId(plan.operation_id))).toBeUndefined()
    },
  )

  test("an acceptance cannot release a different original operation sharing the same event", async () => {
    const { shared, plan } = await delayedRestore()
    const api = client(shared)
    await api.run(acceptRestore(plan))
    const other = await api.run(
      makeSharedBodyWritePlan({
        ...plan,
        before: { ...plan.before, downloaded_at: plan.before.downloaded_at + 1 },
        candidateMarkdown: plan.candidate.markdown,
        parents: plan.event.parents,
      }),
    )
    expect(other.event).toEqual(plan.event)
    expect(other.operation_id).not.toBe(plan.operation_id)
    seed(shared, "operation", other.operation_id, other.operation_id, fileId, other)
    const cold = client({ ...shared, local: new Map(), retired: new Map() })
    expect(
      await cold.run(completedSharedBodyCurrentAcceptance(restoreLibrary, other)),
    ).toBeUndefined()
    expect(
      await cold.run(
        Effect.gen(function* () {
          return yield* loadPendingSharedBodyWrites(restoreLibrary, {
            skillPageId: skillPage,
            events: eventRows(shared),
            headers: yield* querySharedOperationIndex(restoreLibrary, skillPage),
          })
        }),
      ),
    ).toEqual([other])
    expect(creates(cold)).toHaveLength(0)
    expect(patches(cold)).toHaveLength(0)
  })
})

describe("independent current acceptance after an acknowledged event was not visible", () => {
  test("a legal complete original keeps its actual full-envelope identity", async () => {
    const { shared, plan } = await delayedEvent(
      "# Changed\n\n" + "Retained instructions.\n".repeat(200),
      true,
    )
    expect(property(payloadFor(shared, plan.operation_id)).storage).toBeUndefined()
    const full = canonicalSharedJson({ version: 1, operation_id: plan.operation_id, payload: plan })
    expect(new TextEncoder().encode(full).byteLength).toBeLessThanOrEqual(64 * 1024)
    const api = client(shared)
    const preview = await api.run(accept(plan, { dryRun: true, accepted: hash(shared.markdown) }))
    if (preview.status !== "planned") throw new Error("Expected the exact full-storage preview")
    expect(preview.decision_record.original_plan_sha256).toBe(hash(full))
    expect(creates(api)).toHaveLength(0)
  })

  test("acceptance does not bypass the record limit for an oversized full payload", async () => {
    const { shared, plan } = await delayedEvent(
      "# Changed\n\n" + "Retained instructions.\n".repeat(1400),
      true,
    )
    for (const [key, row] of shared.rows)
      if (rowRecordId(row) === plan.operation_id) shared.rows.delete(key)
    seed(shared, "operation", plan.operation_id, plan.operation_id, plan.file_id, plan)
    const api = client(shared)
    const result = await api.run(
      accept(plan, { dryRun: true, accepted: hash(shared.markdown) }).pipe(Effect.result),
    )
    expect(failure(result).code).toBe("SHARED_RECORD_TOO_LARGE")
    expect(creates(api)).toHaveLength(0)
  })

  test("explicit acceptance can review a disabled exact target without enabling it", async () => {
    const { shared, plan } = await delayedEvent()
    shared.enabled = false
    const api = client(shared)
    expect((await api.run(accept(plan, { dryRun: true }))).status).toBe("planned")
    expect(creates(api)).toHaveLength(0)
    const result = await api.run(accept(plan))
    expect(result.status).toBe("reviewed")
    expect(result.original_write_outcome).toBe("unknown")
    expect(shared.enabled).toBe(false)
    expect(patches(api)).toHaveLength(0)
    expect(creates(api)).toHaveLength(1)
    expect(payloadFor(shared, bodyWriteOutcomeId(plan.operation_id))).toBeUndefined()
  })

  test("a derived-text original is checked in its stored encoding and the decision binds the complete plan", async () => {
    const markdown = `# Changed\n\n${"Retained instructions.\n".repeat(1400)}`
    const { shared, plan } = await delayedEvent(markdown, true)
    const accepted = hash(shared.markdown)
    expect(property(payloadFor(shared, plan.operation_id)).storage).toBe("derived-text-v1")
    const api = client(shared)
    const preview = await api.run(accept(plan, { dryRun: true, accepted }))
    expect(preview.status).toBe("planned")
    if (preview.status !== "planned") throw new Error("Expected current acceptance preview")
    expect(preview.decision_record.original_plan_sha256).toBe(
      hash(canonicalSharedJson({ version: 1, operation_id: plan.operation_id, payload: plan })),
    )
    expect(preview.decision_record.original_plan_sha256).not.toBe(
      hash(
        canonicalSharedJson({
          version: 1,
          operation_id: plan.operation_id,
          payload: payloadFor(shared, plan.operation_id),
        }),
      ),
    )
    expect(creates(api)).toHaveLength(0)
    expect(patches(api)).toHaveLength(0)
    const result = await api.run(accept(plan, { accepted }))
    expect(result.status).toBe("reviewed")
    expect(result.original_write_outcome).toBe("unknown")
    expect((await client(shared).run(reconcileSharedBodyWrite(library, plan))).status).toBe(
      "reviewed",
    )
    expect(payloadFor(shared, bodyWriteOutcomeId(plan.operation_id))).toBeUndefined()
  })

  test("preview is read-only; acceptance retains unknown and releases only its exact original fence", async () => {
    const { shared, plan } = await delayedEvent()
    const api = client(shared)
    const beforeRows = shared.rows.size
    const preview = await api.run(accept(plan, { dryRun: true }))
    expect(preview.status).toBe("planned")
    expect(preview.original_write_outcome).toBe("unknown")
    expect(shared.local.size).toBe(0)
    expect(shared.rows.size).toBe(beforeRows)
    const result = await api.run(accept(plan))
    expect(result.status).toBe("reviewed")
    expect(result.decision).toBe("accepted_current")
    expect(result.original_write_outcome).toBe("unknown")
    expect(creates(api)).toHaveLength(1)
    expect(patches(api)).toHaveLength(0)
    expect(eventRows(shared)).toHaveLength(2)
    expect(payloadFor(shared, bodyWriteOutcomeId(plan.operation_id))).toBeUndefined()
    expect((await api.run(reconcileSharedBodyWrite(library, plan))).status).toBe("reviewed")
    seed(shared, "file_event", "support-event", "support-event", "support-file", {
      event_id: "support-event",
      file_id: "support-file",
      parents: [],
      kind: "adopted",
      content: { object_id: `body-${hash("support")}`, sha256: hash("support"), bytes: 7 },
    })
    expect(
      await api.run(
        Effect.gen(function* () {
          return yield* loadPendingSharedBodyWrites(library, {
            skillPageId: skillPage,
            events: eventRows(shared),
            headers: yield* querySharedOperationIndex(library, skillPage),
          })
        }),
      ),
    ).toEqual([])
  })

  test("unknown acceptance keeps one frozen dispatch and never repeats its POST", async () => {
    const { shared, plan } = await delayedEvent()
    const first = client(shared, {
      unknownRecord: "operation",
      unknownRecordPrefix: "accept-current-",
      invisible: true,
    })
    expect((await first.run(accept(plan).pipe(Effect.result)))._tag).toBe("Failure")
    expect(creates(first)).toHaveLength(1)
    const second = client(shared)
    expect((await second.run(accept(plan).pipe(Effect.result)))._tag).toBe("Failure")
    expect(creates(second)).toHaveLength(0)
    expect(
      (await second.run(accept(plan, { accepted: hash("another") }).pipe(Effect.result)))._tag,
    ).toBe("Failure")
    shared.hidden.clear()
    const result = await second.run(accept(plan, { mode: "reconcile" }))
    expect(result.original_write_outcome).toBe("unknown")
    expect(creates(second)).toHaveLength(0)
    expect(patches(second)).toHaveLength(0)
  })

  test("a missing acceptance event cannot be inferred from equal current bytes", async () => {
    const shared = remote()
    const api = client(shared, { unknownBody: true })
    const plan = await api.run(prepare())
    expect(
      (await api.run(executeSharedBodyWrite(library, { plan, mode: "create" }).pipe(Effect.result)))
        ._tag,
    ).toBe("Failure")
    expect(shared.markdown).toBe(candidate)
    const review = client(shared)
    expect(failure(await review.run(accept(plan).pipe(Effect.result))).code).toBe(
      "SHARED_CURRENT_ACCEPTANCE_INELIGIBLE",
    )
    expect(creates(review)).toHaveLength(0)
    expect(shared.local.size).toBe(0)
  })

  test("changed current content and a wrong explicit hash are rejected before dispatch", async () => {
    const { shared, plan } = await delayedEvent()
    const api = client(shared)
    expect(
      failure(await api.run(accept(plan, { accepted: hash("wrong") }).pipe(Effect.result))).code,
    ).toBe("SHARED_CURRENT_ACCEPTANCE_HASH_MISMATCH")
    shared.markdown = candidate + "Later edit.\n"
    expect(failure(await api.run(accept(plan).pipe(Effect.result))).code).toBe(
      "SHARED_CURRENT_ACCEPTANCE_STALE",
    )
    expect(creates(api)).toHaveLength(0)
    expect(shared.local.size).toBe(0)
  })

  test("identity and Source changes fail without creating a review", async () => {
    const { shared, plan } = await delayedEvent()
    shared.source = "another-source"
    const api = client(shared)
    expect(failure(await api.run(accept(plan).pipe(Effect.result))).code).toBe(
      "SHARED_CURRENT_ACCEPTANCE_STALE",
    )
    expect(creates(api)).toHaveLength(0)
  })

  test("an existing definitive outcome must use the established workflow", async () => {
    const shared = remote(),
      api = client(shared)
    const plan = await api.run(prepare())
    await api.run(executeSharedBodyWrite(library, { plan, mode: "create" }))
    const review = client(shared)
    expect(failure(await review.run(accept(plan).pipe(Effect.result))).code).toBe(
      "SHARED_CURRENT_ACCEPTANCE_INELIGIBLE",
    )
    expect(creates(review)).toHaveLength(0)
  })
})
