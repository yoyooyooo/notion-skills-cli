import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { authScope } from "../src/catalog.ts"
import { decode, fail, property, text, type SkillsError } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { openSharedConsumer } from "../src/shared-consumer.ts"
import {
  executeSharedCreate,
  loadSharedCreatePlan,
  reconcileSharedCreate,
} from "../src/shared-create.ts"
import {
  validateSharedCreatePlan,
  sharedCreateManifest,
  makeSharedCreatePlan,
} from "../src/shared-create-model.ts"
import { verifySharedCreatedSnapshot } from "../src/shared-create-verification.ts"
import { FileEventSchema, resolveFileState } from "../src/shared-file-state.ts"
import { canonicalSharedJson, querySharedRecords } from "../src/shared-records.ts"
import {
  readSourceDefinition,
  sourceDefinitionPropertiesFor,
} from "../src/shared-source-definitions.ts"
import { prepareSharedSourceProjection } from "../src/shared-source-projection.ts"
import type { SourceDefinitionInput } from "../src/shared-sources-model.ts"
import type { SourceSnapshot } from "../src/upstream-source.ts"
import { fixture, library, input } from "./shared-source-projection-fixture.ts"

const adapters: readonly SourceDefinitionInput["adapter"][] = [
  { type: "git", url: "https://git.example.test/team/private", ref: "v1" },
  {
    type: "registry",
    base_url: "https://registry.example.test",
    owner: "team",
    slug: "skill",
    version: "1.2.3",
  },
  { type: "github-market", url: "https://skills.sh/team/repository/skill" },
  { type: "linear", resources: [{ kind: "issue", id: "OWNED-1", path: "SKILL.md" }] },
]
function retainedFixture(adapter = adapters[1]!) {
  const f = fixture()
  for (const [key, value] of Object.entries(
    sourceDefinitionPropertiesFor(library, { ...input, adapter }),
  ))
    f.source.properties[key] = { ...property(f.source.properties[key]), ...property(value) }
  const { git_manifest: _git, ...member } = f.snapshot.members[0]!
  const snapshot: SourceSnapshot = {
    ...f.snapshot,
    revision: `${adapter.type}-provider-revision-1`,
    provenance: { provider: adapter.type },
    members: [member],
  }
  const prepare = (enabled = true) =>
    f.run(
      Effect.gen(function* () {
        return yield* prepareSharedSourceProjection({
          library,
          definition: yield* readSourceDefinition(library, f.source.id),
          acquired: snapshot,
          member: "skills/demo",
          skillId: "retained-initial-skill",
          enabled,
        })
      }),
    )
  return { ...f, snapshot, prepare }
}

describe("retained initial source projection in the original create kernel", () => {
  for (const adapter of adapters)
    test(`the complete ${adapter.type} member derives its real page-bound bundle only after allocation`, async () => {
      const f = retainedFixture(adapter),
        plan = await f.prepare()
      expect(plan.source_projection?.version).toBe(2)
      expect(plan.files.every((file) => file.event.kind === "source_projection_pending")).toBe(true)
      expect(canonicalSharedJson(sharedCreateManifest(plan))).not.toContain("archive_base64")
      expect(f.writes()).toHaveLength(0)
      expect(f.nativeCreates()).toHaveLength(0)
      expect(f.providerReads()).toBe(0)
      const created = await f.run(executeSharedCreate(library, { plan, mode: "create" }))
      const first = property(property(f.nativeCreates()[0]?.body).properties)
      expect(property(first.enabled).checkbox).toBe(false)
      expect(text(property(first.source).rich_text)).toBe("")
      expect(text(property(first.projection).rich_text)).toBe("")
      const selected = created.expected_source_projection!
      expect(selected.source_id).toMatch(/^bundle-[a-f0-9]{64}$/u)
      expect(selected.source_revision).toBe(selected.source_id)
      expect(selected.source_revision).not.toBe(f.snapshot.revision)
      const facts = await f.run(
        querySharedRecords(library, { skillPageId: created.skill_page_id, kind: "file_event" }),
      )
      for (const row of facts) {
        const event = decode(FileEventSchema, row.payload)
        expect(event.kind).toBe("projected")
        expect(property(event).source_revision).toBe(selected.source_id)
        expect(resolveFileState(event.file_id, [event]).ownership.kind).toBe("following")
      }
      f.base.objects.clear()
      f.base.json.clear()
      const snapshot = await f.run(
        Effect.gen(function* () {
          return yield* openSharedConsumer({
            library,
            target: created.skill_page_id,
            scope: yield* authScope,
            startedAt: Date.now(),
            forceFull: true,
            readOnly: true,
          })
        }),
      )
      expect(snapshot.files.map((file) => file.path)).toEqual(
        f.snapshot.members[0]!.portable.files.map((file) => file.path),
      )
      for (const original of f.snapshot.members[0]!.portable.files.filter(
        (file) => file.path !== "SKILL.md",
      )) {
        const actual = snapshot.files.find((file) => file.path === original.path)!
        expect(actual.mode).toBe(original.mode)
        expect(f.base.objects.get(`objects/${actual.sha256}`)).toEqual(original.bytes)
      }
      expect(() => verifySharedCreatedSnapshot(snapshot, created)).not.toThrow()
      expect(f.providerReads()).toBe(0)
      const restored = await f.run(
        loadSharedCreatePlan(library, {
          skillPageId: created.skill_page_id,
          operationId: plan.operation_id,
        }),
      )
      expect(canonicalSharedJson(restored)).toBe(canonicalSharedJson(plan))
      f.clear()
      expect((await f.run(reconcileSharedCreate(library, restored))).reused).toBe(true)
      expect(f.writes()).toHaveLength(0)
    })

  test("unknown original source selection cannot infer an ACK or repeat its metadata PATCH", async () => {
    const f = retainedFixture(),
      plan = await f.prepare()
    f.unknown("source_selection", true)
    await expect(
      f.run(executeSharedCreate(library, { plan, mode: "create" })),
    ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
    const before = f.writes().length
    expect(f.nativeCreates()).toHaveLength(1)
    await expect(f.run(executeSharedCreate(library, { plan, mode: "create" }))).rejects.toThrow()
    expect(f.writes()).toHaveLength(before)
    expect(f.nativeCreates()).toHaveLength(1)
    expect(f.pending()).toHaveLength(1)
    expect(
      f.calls.filter(
        (call) =>
          call.method === "PATCH" &&
          property(property(property(call.body).properties).enabled).checkbox === true,
      ),
    ).toHaveLength(0)
  })

  test("an acknowledged source selection with interrupted readback resumes only the original remaining stages", async () => {
    const f = retainedFixture(),
      plan = await f.prepare(false)
    let failed = false,
      sourcePatched = false
    const first = await f.run(
      Effect.gen(function* () {
        const api = yield* Notion
        return yield* executeSharedCreate(library, { plan, mode: "create" }).pipe(
          Effect.provideService(Notion, {
            ...api,
            request: (path, body, options) =>
              Effect.suspend((): Effect.Effect<unknown, SkillsError> => {
                if (
                  sourcePatched &&
                  !failed &&
                  body === undefined &&
                  /^v1\/pages\/[a-f0-9-]{36}$/u.test(path)
                ) {
                  failed = true
                  return Effect.fail(
                    fail(
                      "READ_INTERRUPTED",
                      "Controlled original source ACK readback interruption",
                    ),
                  )
                }
                return api.request(path, body, options).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      if (
                        options?.method === "PATCH" &&
                        property(property(body).properties).source !== undefined
                      )
                        sourcePatched = true
                    }),
                  ),
                )
              }),
          }),
          Effect.result,
        )
      }),
    )
    expect(first._tag).toBe("Failure")
    expect(f.nativeCreates()).toHaveLength(1)
    const created = await f.run(executeSharedCreate(library, { plan, mode: "create" }))
    expect(created.operation_id).toBe(plan.operation_id)
    expect(f.nativeCreates()).toHaveLength(2)
    expect(f.calls.filter((call) => call.method === "PATCH")).toHaveLength(1)
    expect(created.expected_metadata.enabled).toBe(false)
  })

  test("forged retained bytes or a provider revision substituted for the derived event cannot publish", async () => {
    const f = retainedFixture(),
      plan = await f.prepare()
    if (plan.source_projection?.version !== 2) throw new Error("Expected retained projection")
    const forged = {
      ...plan,
      source_projection: {
        ...plan.source_projection,
        retained: { ...plan.source_projection.retained, archive_base64: "AAAA" },
      },
    }
    await expect(f.run(validateSharedCreatePlan(forged))).rejects.toThrow()
    const event = plan.files[0]!.event
    const changed = {
      ...plan,
      files: plan.files.map((file, i) =>
        i === 0
          ? {
              ...file,
              event: { ...event, kind: "projected", source_revision: f.snapshot.revision },
            }
          : file,
      ),
    }
    await expect(f.run(validateSharedCreatePlan(changed))).rejects.toThrow()
    expect(f.writes()).toHaveLength(0)
  })

  test("equal local retained input may declare same-library relations without creating custom ownership", async () => {
    const f = retainedFixture()
    const plan = await f.run(
      Effect.gen(function* () {
        return yield* prepareSharedSourceProjection({
          library,
          definition: yield* readSourceDefinition(library, f.source.id),
          acquired: f.snapshot,
          member: "skills/demo",
          local: {
            baseline: f.snapshot,
            files: f.snapshot.members[0]!.portable.files,
            relations: {
              version: 1,
              ownership: "notion",
              library_id: library.library_id,
              members: [],
            },
          },
        })
      }),
    )
    expect(plan.files.every((file) => file.event.kind === "source_projection_pending")).toBe(true)
    expect(plan.members).toEqual([])
    expect(f.writes()).toHaveLength(0)
  })

  test("a retained Skill member cannot silently change its canonical entrypoint through a different content kind", async () => {
    const f = retainedFixture(),
      member = f.snapshot.members[0]!
    const prepared = await f.prepare()
    if (prepared.source_projection?.version !== 2) throw new Error("Expected retained projection")
    const outcome = await f.run(
      makeSharedCreatePlan(library, {
        portable: {
          ...member.portable,
          kind: "prompt",
          files: member.portable.files.filter((file) => /\.(md|markdown)$/iu.test(file.path)),
        },
        sourceProjection: prepared.source_projection,
      }).pipe(Effect.result),
    )
    expect(outcome._tag).toBe("Failure")
    expect(f.writes()).toHaveLength(0)
  })

  test("unspecified provider modes use an explicit new regular-file conversion while known executable modes remain exact", async () => {
    const f = retainedFixture(),
      member = f.snapshot.members[0]!
    const files: SourceSnapshot["members"][number]["portable"]["files"] = member.portable.files.map(
      (file) => {
        const { mode: _unknown, ...withoutMode } = file
        return file.path === "scripts/run.js" ? file : withoutMode
      },
    )
    const acquired = {
      ...f.snapshot,
      members: [{ ...member, portable: { ...member.portable, files } }],
    }
    const plan = await f.run(
      Effect.gen(function* () {
        return yield* prepareSharedSourceProjection({
          library,
          definition: yield* readSourceDefinition(library, f.source.id),
          acquired,
          member: "skills/demo",
          enabled: true,
          local: {
            baseline: acquired,
            files: files.map((file) => ({ ...file, mode: file.mode ?? ("100644" as const) })),
          },
        })
      }),
    )
    if (plan.source_projection?.version !== 2) throw new Error("Expected retained projection")
    expect(plan.source_projection.retained.mode_policy).toBe("regular_file_when_unspecified")
    expect(plan.source_projection.retained.mode_defaulted_paths).toEqual([
      "SKILL.md",
      "assets/icon.png",
      "data/options.json",
      "references/a.md",
    ])
    expect(plan.files.every((file) => file.content.mode === "100644")).toBe(true)
    const created = await f.run(executeSharedCreate(library, { plan, mode: "create" }))
    f.base.objects.clear()
    f.base.json.clear()
    const cold = await f.run(
      Effect.gen(function* () {
        return yield* openSharedConsumer({
          library,
          target: created.skill_page_id,
          scope: yield* authScope,
          startedAt: Date.now(),
          forceFull: true,
          readOnly: true,
        })
      }),
    )
    expect(cold.files.map((file) => [file.path, file.mode])).toEqual(
      member.portable.files.map((file) => [file.path, file.mode]),
    )
    expect(() => verifySharedCreatedSnapshot(cold, created)).not.toThrow()
    const restored = await f.run(
      loadSharedCreatePlan(library, {
        skillPageId: created.skill_page_id,
        operationId: plan.operation_id,
      }),
    )
    expect(canonicalSharedJson(restored)).toBe(canonicalSharedJson(plan))
  })
})
