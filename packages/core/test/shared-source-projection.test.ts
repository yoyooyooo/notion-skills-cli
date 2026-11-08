import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { decode, property, text } from "../src/model.ts"
import { authScope } from "../src/catalog.ts"
import { openSharedConsumer } from "../src/shared-consumer.ts"
import { verifySharedCreatedSnapshot } from "../src/shared-create-verification.ts"
import {
  executeSharedCreate,
  loadSharedCreatePlan,
  reconcileSharedCreate,
  previewSharedCreate,
} from "../src/shared-create.ts"
import { sharedCreateManifest, validateSharedCreatePlan } from "../src/shared-create-model.ts"
import { FileEventSchema, resolveFileState } from "../src/shared-file-state.ts"
import { canonicalSharedJson, querySharedRecords } from "../src/shared-records.ts"
import { querySharedSkillIndex } from "../src/shared-skill-index.ts"
import { fixture, library, ids } from "./shared-source-projection-fixture.ts"
import { id, rich } from "./shared-snapshot-fixture.ts"

describe("initial fixed-source native projections", () => {
  test("a complete 407-path source is prepared, created and reconstructed without dropping raw resources", async () => {
    const extras = Array.from({ length: 402 }, (_, index) => ({
      path:
        index < 33
          ? `references/complete-${String(index).padStart(3, "0")}.md`
          : `scripts/complete/${String(index).padStart(3, "0")}/${"kept-path-".repeat(5)}.ts`,
      bytes: new TextEncoder().encode(
        index < 33
          ? `# Complete ${index}\n\nOriginal instructions.\n`
          : `// Complete unexecuted source resource ${index}\n`,
      ),
      mode: index % 2 === 0 ? ("100644" as const) : ("100755" as const),
    }))
    const f = fixture(extras)
    const plan = await f.prepare()
    expect(plan.source_projection.binding.files).toHaveLength(407)
    expect(plan.files).toHaveLength(35)
    expect(
      new TextEncoder().encode(canonicalSharedJson(sharedCreateManifest(plan))).length,
    ).toBeGreaterThan(64 * 1024)
    expect(await f.run(validateSharedCreatePlan(plan))).toEqual(plan)
    expect(f.writes()).toHaveLength(0)
    const result = await f.run(executeSharedCreate(library, { plan, mode: "create" }))
    const restored = await f.run(
      loadSharedCreatePlan(library, {
        skillPageId: result.skill_page_id,
        operationId: plan.operation_id,
      }),
    )
    expect(restored).toEqual(plan)
    expect(restored.source_projection?.version).toBe(1)
    expect(f.nativeCreates()).toHaveLength(35)
    f.clear()
    expect((await f.run(reconcileSharedCreate(library, plan))).reused).toBe(true)
    expect(f.writes()).toHaveLength(0)
  })

  test("the complete resource manifest validates native links while only Markdown receives readable pages", async () => {
    const f = fixture(),
      plan = await f.prepare()
    expect(plan.enabled).toBe(false)
    expect(plan.source_projection?.provider_committed_at).toBe("2026-11-08T00:00:00Z")
    expect(plan.skill_id).toBe("fixed-initial-skill")
    expect(plan.files.map((file) => file.path)).toEqual(["SKILL.md", "references/a.md"])
    expect(plan.source_projection?.binding.files.map((file) => file.path)).toEqual(
      f.snapshot.members[0]!.portable.files.map((file) => file.path),
    )
    expect(plan.files.every((file) => file.event.kind === "projected")).toBe(true)
    expect(plan.files[0]?.input.text).toContain("license: MIT")
    expect(plan.files[0]?.projection.markdown).toContain("scripts/run.js")
    expect(plan.reference_check.local_references).toBe(4)
    expect(f.writes()).toHaveLength(0)
    expect(await f.run(validateSharedCreatePlan(plan))).toEqual(plan)
    expect((await f.run(previewSharedCreate(library, plan))).requested_enabled).toBe(false)
    expect(f.pending()).toHaveLength(0)
    expect(f.nativeCreates()).toHaveLength(0)
  })

  test.each([false, true])(
    "complete creation keeps original projected provenance and enables only explicit intent (%s)",
    async (enabled) => {
      const f = fixture(),
        plan = await f.prepare(enabled)
      const result = await f.run(executeSharedCreate(library, { plan, mode: "create" }))
      expect(result.expected_metadata.enabled).toBe(enabled)
      expect(f.nativeCreates()).toHaveLength(2)
      expect(f.enablePatches()).toHaveLength(enabled ? 1 : 0)
      const index = await f.run(querySharedSkillIndex(library, result.skill_page_id))
      expect(index.enabled).toBe(enabled)
      expect(index.source_reference).toBe(plan.source_projection!.binding.source_id)
      expect(index.files[0]?.display_status).toBe("following")
      const facts = await f.run(
        querySharedRecords(library, { skillPageId: result.skill_page_id, kind: "file_event" }),
      )
      const events = facts.map((fact) => decode(FileEventSchema, fact.payload))
      for (const file of plan.files)
        expect(
          resolveFileState(
            file.file_id,
            events.filter((event) => event.file_id === file.file_id),
          ).ownership.kind,
        ).toBe("following")
      if (enabled) {
        const consumed = await f.run(
          Effect.gen(function* () {
            return yield* openSharedConsumer({
              library,
              target: result.skill_page_id,
              scope: yield* authScope,
              startedAt: Date.now(),
              forceFull: true,
              readOnly: true,
            })
          }),
        )
        expect(consumed.files.map((file) => file.path)).toEqual(
          f.snapshot.members[0]!.portable.files.map((file) => file.path),
        )
        const icon = consumed.files.find((file) => file.path === "assets/icon.png")
        expect(f.base.objects.get(`objects/${icon?.sha256}`)).toEqual(
          new Uint8Array([137, 80, 78, 71, 0, 255]),
        )
        expect(consumed.files.find((file) => file.path === "scripts/run.js")?.mode).toBe("100755")
        const main = consumed.files.find((file) => file.path === "SKILL.md")
        expect(new TextDecoder().decode(f.base.objects.get(`objects/${main?.sha256}`))).toContain(
          '"license": "MIT"',
        )
        expect(() => verifySharedCreatedSnapshot(consumed, result)).not.toThrow()
      }
      expect(
        await f.run(
          loadSharedCreatePlan(library, {
            skillPageId: result.skill_page_id,
            operationId: plan.operation_id,
          }),
        ),
      ).toEqual(plan)
      f.clear()
      expect((await f.run(reconcileSharedCreate(library, plan))).reused).toBe(true)
      expect(f.writes()).toHaveLength(0)
    },
  )

  test("a disabled existing member blocks admission before acquisition and a concurrent different-name binding blocks dispatch", async () => {
    const bind = (f: ReturnType<typeof fixture>) => {
      const row = f.seedSkill(id(333), "another-id", "Another name", "skill", false)
      property(row.properties).origin = {
        id: "origin",
        type: "relation",
        relation: [{ id: id(82) }],
        has_more: false,
      }
      property(row.properties).source_member = rich("source_member", "skills/demo")
    }
    const f = fixture()
    bind(f)
    await expect(f.prepare()).rejects.toMatchObject({ code: "SOURCE_MEMBER_ALREADY_BOUND" })
    expect(f.providerReads()).toBe(0)
    expect(f.writes()).toHaveLength(0)
    const g = fixture(),
      plan = await g.prepare()
    bind(g)
    await expect(g.run(previewSharedCreate(library, plan))).rejects.toMatchObject({
      code: "SOURCE_MEMBER_ALREADY_BOUND",
    })
    await expect(
      g.run(executeSharedCreate(library, { plan, mode: "create" })),
    ).rejects.toMatchObject({ code: "SOURCE_MEMBER_ALREADY_BOUND" })
    expect(g.writes()).toHaveLength(0)
  })

  test("source configuration drift stops before creation and an unknown first page cannot be replayed", async () => {
    const f = fixture(),
      plan = await f.prepare()
    f.source.properties[ids.Description!] = rich(ids.Description!, "Changed source configuration")
    await expect(
      f.run(executeSharedCreate(library, { plan, mode: "create" })),
    ).rejects.toMatchObject({ code: "SHARED_CREATE_SOURCE_CHANGED" })
    expect(f.writes()).toHaveLength(0)
    const g = fixture(),
      original = await g.prepare()
    g.unknown("skill", true)
    await expect(
      g.run(executeSharedCreate(library, { plan: original, mode: "create" })),
    ).rejects.toThrow()
    expect(g.nativeCreates()).toHaveLength(1)
    expect(g.enablePatches()).toHaveLength(0)
    const writes = g.writes().length
    await expect(
      g.run(executeSharedCreate(library, { plan: original, mode: "create" })),
    ).rejects.toThrow()
    expect(g.writes()).toHaveLength(writes)
    const created = [...g.skills.values()].find(
      (row) => text(property(property(row.properties).skill_id).rich_text) === original.skill_id,
    )
    expect(property(property(created?.properties).enabled).checkbox).toBe(false)
  })

  test("missing resources, forged Markdown bytes and raw mode changes do not become another valid projection", async () => {
    const f = fixture(),
      plan = await f.prepare()
    const missing = structuredClone(plan)
    if (missing.source_projection === undefined) throw new Error("Missing projection")
    const invalid = {
      ...missing,
      source_projection: {
        ...missing.source_projection,
        binding: {
          ...missing.source_projection.binding,
          files: missing.source_projection.binding.files.slice(0, -1),
        },
      },
    }
    await expect(f.run(validateSharedCreatePlan(invalid))).rejects.toThrow()
    const modeChanged = {
      ...missing,
      source_projection: {
        ...missing.source_projection,
        binding: {
          ...missing.source_projection.binding,
          files: missing.source_projection.binding.files.map((file) =>
            file.path === "scripts/run.js" ? { ...file, mode: "100644" as const } : file,
          ),
        },
      },
    }
    await expect(f.run(validateSharedCreatePlan(modeChanged))).rejects.toThrow()
    const changed = {
      ...plan,
      files: plan.files.map((file, index) =>
        index === 0
          ? { ...file, input: { ...file.input, text: file.input.text + "forged" } }
          : file,
      ),
    }
    await expect(f.run(validateSharedCreatePlan(changed))).rejects.toThrow()
    expect(canonicalSharedJson(plan)).not.toContain('"kind":"adopted"')
    expect(f.writes()).toHaveLength(0)
  })
})
