import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import { fail, property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { inspectSharedResourceState } from "../src/shared-resource-state.ts"
import { registerSourceBinding } from "../src/shared-source-binding.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import { openSharedSnapshot } from "../src/shared-snapshot.ts"
import { prepareSharedMetadataWrite } from "../src/shared-metadata-write.ts"
import { prepareRetainedSourceRefresh as prepareSourceRefresh } from "../src/shared-source-refresh.ts"
import {
  prepareSharedSnapshotHistory,
  retainSharedSnapshotHistory,
} from "../src/shared-snapshot-history.ts"
import {
  digest,
  encode,
  id,
  library,
  rich,
  sharedSnapshotFixture,
  skillPage,
} from "./shared-snapshot-fixture.ts"
import { library as sourceLibrary, sourceRefreshFixture } from "./shared-source-refresh-fixture.ts"

const c1 = "1".repeat(40)
const originalGuide = "Reference C1\n"
const customGuide = "Notion N1\n"
const blobOid = (body: string) =>
  createHash("sha1")
    .update(`blob ${encode(body).length}\0`)
    .update(body)
    .digest("hex")

async function fixture() {
  const f = sharedSnapshotFixture({ fileCount: 2 })
  const mainBody = f.bodies.get(skillPage)
  const guide = f.files[0]
  if (mainBody === undefined || guide === undefined) throw new Error("Missing fixture body")
  const fixed = {
    url: "https://github.com/example/resource-state",
    commit: c1,
    root: "skills/demo",
    tree: "3".repeat(40),
    files: [
      {
        path: "SKILL.md",
        source_path: "skills/demo/SKILL.md",
        git_oid: blobOid(mainBody),
        bytes: encode(mainBody).length,
      },
      {
        path: "references/1.md",
        source_path: "skills/demo/references/1.md",
        git_oid: blobOid(originalGuide),
        bytes: encode(originalGuide).length,
      },
    ],
  }
  const source = await f.run(
    registerSourceBinding(library, { skillPageId: skillPage, mode: "create", fixedSource: fixed }),
  )
  property(f.main.properties).source = rich("source", source.binding.source_id)
  for (const [fileId, page, body] of [
    ["file-main", f.main, mainBody],
    ["file-1", guide, originalGuide],
  ] satisfies Array<[string, Record<string, unknown>, string]>) {
    const baseline = { normalization_version: 1, sha256: digest(body), source_revision: c1 }
    property(page.properties).projection = rich("projection", canonicalSharedJson(baseline))
    f.seedFact(
      {
        event_id: `project-${fileId}`,
        file_id: fileId,
        parents: [],
        kind: "projected",
        source_revision: c1,
        projection: { normalization_version: 1, sha256: digest(body) },
      },
      "file_event",
      fileId,
      `project-${fileId}`,
    )
  }
  f.bodies.set(guide.id, customGuide)
  const content = {
    object_id: `body-${digest(customGuide)}`,
    sha256: digest(customGuide),
    bytes: encode(customGuide).length,
  }
  const adopted = { file_id: "file-1", parents: ["project-file-1"], kind: "adopted", content }
  const adoptedId = `adopt-${digest(canonicalSharedJson({ version: 1, file_id: adopted.file_id, parents: adopted.parents, content }))}`
  f.seedFact({ ...adopted, event_id: adoptedId }, "file_event", "file-1", adoptedId)
  f.seedFact(
    { version: 1, kind: "normalized_markdown", normalization_version: 1, markdown: customGuide },
    "object",
    content.object_id,
    content.object_id,
  )
  f.clearCalls()
  return {
    ...f,
    source,
    mainBody,
    guide,
    fixedSource: {
      source_id: source.binding.source_id,
      revision: c1,
      files: [
        { path: "SKILL.md", bytes: encode(mainBody) },
        { path: "references/1.md", bytes: encode(originalGuide) },
      ],
    },
  }
}

test("metadata state separates selected C1 and custom N1 based on C1 without reading bodies", async () => {
  const f = await fixture()
  const before = canonicalSharedJson([...f.records.values()])
  const value = await f.run(inspectSharedResourceState(library, { target: skillPage }))
  expect(value.selected).toMatchObject({ kind: "selected", revision: c1 })
  expect(value.candidate.kind).toBe("unobserved")
  expect(value.session.kind).toBe("unobserved")
  expect(value.files[0]?.display.recorded).toMatchObject({ source_revision: c1 })
  expect(value.files[1]?.customization).toMatchObject({
    kind: "custom",
    based_on: { source_revision: c1 },
  })
  expect(value.files.every((file) => file.display.observation.kind === "unobserved")).toBe(true)
  expect(f.readBodyCount()).toBe(0)
  expect(f.writeCount()).toBe(0)
  expect(canonicalSharedJson([...f.records.values()])).toBe(before)
})

test("one state result keeps frozen C2, selected C1, recorded C1 and custom N1 ancestry independent", async () => {
  const f = await fixture()
  const upstream = await sourceRefreshFixture()
  const c2 = "2".repeat(40)
  const template = await upstream.run(
    prepareSourceRefresh(sourceLibrary, id(82), skillPage, () =>
      Effect.succeed({ ...upstream.snapshot, revision: c2 }),
    ),
  )
  const current = await f.open({ fixedSource: f.fixedSource })
  const fields = property(f.main.properties)
  for (const key of ["origin", "source_member", "members", "requires"])
    fields[key] = structuredClone(property(upstream.main.properties)[key])
  const before = canonicalSharedJson([...f.records.values()])
  f.clearCalls()
  const { state, tampered, inaccessible, inconsistent } = await f.run(
    Effect.gen(function* () {
      const original = yield* Notion
      return yield* Effect.gen(function* () {
        // Reuse prepare's complete candidate archive, with the exact C1 baseline
        // frozen by the same metadata-plan owner that source preparation uses.
        const selection = yield* prepareSharedMetadataWrite({
          library: sourceLibrary,
          skillPageId: skillPage,
          changes: [{ field: "Source", value: template.bundle_id }],
          expected: { values: [{ field: "Source", value: f.source.binding.source_id }] },
        })
        const { plan_id: _templateIdentity, ...frozen } = template
        const contents = {
          ...frozen,
          previous_pin: f.source.binding.source_id,
          current_snapshot: current.snapshot_id,
          selection,
        }
        const candidate = {
          ...contents,
          plan_id: `source-refresh-${digest(canonicalSharedJson(contents))}`,
        }
        const inconsistentContents = { ...contents, source_id: "another-stable-source" }
        const inconsistent = yield* inspectSharedResourceState(sourceLibrary, {
          target: skillPage,
          candidate: {
            ...inconsistentContents,
            plan_id: `source-refresh-${digest(canonicalSharedJson(inconsistentContents))}`,
          },
        })
        const state = yield* inspectSharedResourceState(sourceLibrary, {
          target: skillPage,
          candidate,
        })
        const tampered = yield* inspectSharedResourceState(sourceLibrary, {
          target: skillPage,
          candidate: { ...candidate, provider_revision: "unverified-provider-revision" },
        }).pipe(Effect.flip)
        const sourceApi = yield* Notion
        const inaccessible = yield* inspectSharedResourceState(sourceLibrary, {
          target: skillPage,
          candidate,
        }).pipe(
          Effect.provideService(Notion, {
            ...sourceApi,
            request: (path, body, options) =>
              path === `v1/pages/${upstream.source.id}`
                ? Effect.fail(fail("ACCESS_DENIED", "Controlled inaccessible Source origin"))
                : sourceApi.request(path, body, options),
          }),
        )
        return { state, tampered, inaccessible, inconsistent }
      }).pipe(
        Effect.provideService(Notion, {
          ...original,
          request: (path, body, options) =>
            path === `v1/pages/${upstream.source.id}`
              ? Effect.succeed(structuredClone(upstream.source))
              : path.startsWith(`v1/data_sources/${sourceLibrary.sources.data_source_id}/query`)
                ? Effect.succeed({
                    object: "list",
                    results: [structuredClone(upstream.source)],
                    has_more: false,
                    next_cursor: null,
                  })
                : original.request(path, body, options),
        }),
      )
    }),
  )
  expect(state.candidate).toMatchObject({
    kind: "frozen",
    provider_revision: c2,
    based_on: f.source.binding.source_id,
    selection_matches: true,
    source_binding_matches: true,
    application_readiness: "not_checked",
  })
  expect(state.source).toMatchObject({
    kind: "observed",
    source_id: "refresh-source",
    provider_checked: false,
  })
  expect(state.selected).toMatchObject({ kind: "selected", revision: c1 })
  expect(state.files[0]?.display.recorded).toMatchObject({ source_revision: c1 })
  expect(state.files[1]?.customization).toMatchObject({
    kind: "custom",
    based_on: { source_revision: c1 },
  })
  expect(state.session.kind).toBe("unobserved")
  expect(tampered.code).toBe("SOURCE_REFRESH_INVALID")
  expect(inconsistent.source).toMatchObject({ source_id: "refresh-source" })
  expect(inconsistent.candidate).toMatchObject({
    source_id: "another-stable-source",
    source_binding_matches: false,
  })
  expect(inaccessible.source).toMatchObject({ kind: "unavailable", access: "denied" })
  expect(inaccessible.candidate).toMatchObject({
    kind: "frozen",
    source_binding_matches: "unknown",
  })
  expect(f.readBodyCount()).toBe(0)
  expect(f.writeCount()).toBe(0)
  expect(canonicalSharedJson([...f.records.values()])).toBe(before)
})

test("observed body changes stay observational and do not adopt or advance Source", async () => {
  const f = await fixture()
  f.bodies.set(skillPage, "Uncommitted main edit\n")
  const before = canonicalSharedJson([...f.records.values()])
  const value = await f.run(
    inspectSharedResourceState(library, { target: skillPage, observe: true }),
  )
  expect(value.files[0]?.display.observation).toMatchObject({
    kind: "observed",
    ownership_comparison: "requires_observation_commit",
  })
  expect(value.files[0]?.resolution).toMatchObject({
    ownership: { kind: "following", source_revision: c1 },
  })
  expect(value.files[1]?.display.observation).toMatchObject({
    kind: "observed",
    ownership_comparison: "matches_recorded_owner",
  })
  expect(value.selected).toMatchObject({ source_id: f.source.binding.source_id })
  expect(f.readBodyCount()).toBe(2)
  expect(f.writeCount()).toBe(0)
  expect(canonicalSharedJson([...f.records.values()])).toBe(before)
})

test("display-name changes preserve identity while a multi-owner file fails", async () => {
  const f = await fixture()
  const fields = property(f.main.properties)
  f.main.properties = Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [`renamed_${key}`, value]),
  )
  expect((await f.run(inspectSharedResourceState(library, { target: skillPage }))).skill_id).toBe(
    "stable-skill",
  )
  property(property(f.guide.properties).skill).relation = [{ id: skillPage }, { id: id(99) }]
  const failure = await f.run(
    inspectSharedResourceState(library, { target: skillPage }).pipe(Effect.flip),
  )
  expect(failure.code).toBe("INVALID_FILE_INDEX")
  expect(f.writeCount()).toBe(0)
})

test("duplicate logical Skill claims fail before any current body read", async () => {
  const f = await fixture()
  const duplicate = structuredClone(f.main)
  duplicate.id = id(91)
  const result = await f.run(
    Effect.gen(function* () {
      const original = yield* Notion
      return yield* inspectSharedResourceState(library, { target: skillPage, observe: true }).pipe(
        Effect.provideService(Notion, {
          ...original,
          request: (path, body, options) =>
            path.startsWith(`v1/data_sources/${library.skills.data_source_id}/query`)
              ? Effect.succeed({
                  object: "list",
                  results: [f.main, duplicate],
                  has_more: false,
                  next_cursor: null,
                })
              : original.request(path, body, options),
        }),
        Effect.flip,
      )
    }),
  )
  expect(result.code).toBe("SHARED_SKILL_ID_CONFLICT")
  expect(f.readBodyCount()).toBe(0)
  expect(f.writeCount()).toBe(0)
})

test("404 current body preserves permission uncertainty and existing ownership", async () => {
  const f = await fixture()
  const result = await f.run(
    Effect.gen(function* () {
      const original = yield* Notion
      return yield* inspectSharedResourceState(library, { target: skillPage, observe: true }).pipe(
        Effect.provideService(Notion, {
          ...original,
          request: (path, body, options) =>
            path.startsWith(`v1/pages/${f.guide.id}/markdown`)
              ? Effect.fail(fail("NOT_FOUND", "Owned negative fixture"))
              : original.request(path, body, options),
        }),
      )
    }),
  )
  expect(result.files[1]?.display.observation).toEqual({
    kind: "unavailable",
    access: "unknown",
    code: "NOT_FOUND",
  })
  expect(result.files[1]?.resolution).toMatchObject({ ownership: { kind: "custom" } })
  expect(f.writeCount()).toBe(0)
})

test("an unresolved original observation is listed without replay or reconciliation", async () => {
  const f = await fixture()
  f.bodies.set(skillPage, "Body changed before lost acceptance\n")
  f.unknownRecord("file_event", false)
  const interrupted = await f.run(fixedOpen(f).pipe(Effect.result))
  expect(interrupted._tag).toBe("Failure")
  if (interrupted._tag !== "Failure") throw new Error("Expected lost original write response")
  expect(interrupted.failure.code).toBe("WRITE_OUTCOME_UNKNOWN")
  f.clearCalls()
  const before = canonicalSharedJson([...f.records.values()])
  const metadata = await f.run(inspectSharedResourceState(library, { target: skillPage }))
  expect(metadata.operations.shared_headers.length).toBeGreaterThan(0)
  expect(metadata.operations.families.file_observations.kind).toBe("unobserved")
  expect(f.readBodyCount()).toBe(0)
  const value = await f.run(
    inspectSharedResourceState(library, { target: skillPage, observe: true }),
  )
  expect(value.operations.families.file_observations.kind).toBe("observed")
  if (value.operations.families.file_observations.kind !== "observed")
    throw new Error("Missing observation result")
  expect(value.operations.families.file_observations.pending).toHaveLength(1)
  expect(value.operations.reconciled).toBe(false)
  expect(f.writeCount()).toBe(0)
  expect(canonicalSharedJson([...f.records.values()])).toBe(before)
})

function fixedOpen(f: Awaited<ReturnType<typeof fixture>>) {
  return openSharedSnapshot({
    library,
    target: skillPage,
    scope: digest("shared-fixture-scope"),
    startedAt: Date.now(),
    fixedSource: f.fixedSource,
  })
}

test("explicit session history stays fixed while later current-body edits are observed", async () => {
  const f = await fixture()
  const snapshot = await f.open({ fixedSource: f.fixedSource })
  const plan = await f.run(prepareSharedSnapshotHistory(library, snapshot))
  await f.run(retainSharedSnapshotHistory(library, { mode: "create", plan }))
  f.bodies.set(f.guide.id, "Later Notion N2\n")
  f.clearCalls()
  const value = await f.run(
    inspectSharedResourceState(library, {
      target: skillPage,
      observe: true,
      sessionPin: plan.pin_id,
    }),
  )
  expect(value.session).toMatchObject({
    kind: "pinned",
    pin_id: plan.pin_id,
    version_id: snapshot.version_id,
    availability: "manifest_only",
  })
  expect(value.files[1]?.display.observation).toMatchObject({
    kind: "observed",
    ownership_comparison: "requires_observation_commit",
  })
  expect(value.selected).toMatchObject({ kind: "selected", revision: c1 })
  expect(f.writeCount()).toBe(0)
  expect(
    f.calls.some(
      (call) => call.method !== "GET" && !(call.method === "POST" && call.path.includes("/query")),
    ),
  ).toBe(false)
})
