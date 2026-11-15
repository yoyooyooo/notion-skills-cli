import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { authScope } from "../src/catalog.ts"
import { decode, fail, property, text, type SkillsError } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { openSharedConsumer } from "../src/shared-consumer.ts"
import { withSharedAuthoringTarget } from "../src/shared-authoring-context.ts"
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

const skillPropertyIds: Readonly<Record<string, string>> = library.skills.property_ids

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
function retainedFixture(
  adapter = adapters[1]!,
  options: { readonly markdownImport?: true; readonly readback?: (wire: string) => string } = {},
) {
  const f = fixture([], { ...options, recovery: options.markdownImport === true })
  for (const [key, value] of Object.entries(
    sourceDefinitionPropertiesFor(library, {
      ...input,
      adapter,
      options: { ...input.options, storage: "retained" },
    }),
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
          // This suite owns the explicit retained compatibility/recovery path.
          // Default non-Git/converted input now needs a separate storage decision.
          storage: "retained",
          ...(options.markdownImport === true ? { markdownImport: true as const } : {}),
        })
      }),
    )
  return { ...f, snapshot, prepare }
}

describe("retained initial source projection in the original create kernel", () => {
  test("flattened presentation wrappers never replace retained raw template bytes in cold consumption", async () => {
    const source =
      '---\nmarp: true\ntheme: original\n---\n\n# Template\n\n<div class="c2"><span class="eyebrow">Keep layout</span></div>\n\nUse `<div class="meta">` literally.\n'
    const bytes = new TextEncoder().encode(source)
    const f = fixture([{ path: "assets/template.md", bytes, mode: "100644" }], {
      markdownImport: true,
      recovery: true,
      readback: (wire) =>
        wire.replace(
          '<div class="c2"><span class="eyebrow">Keep layout</span></div>',
          "Keep layout",
        ),
    })
    const plan = await f.run(
      Effect.gen(function* () {
        return yield* prepareSharedSourceProjection({
          library,
          definition: yield* readSourceDefinition(library, f.source.id),
          acquired: f.snapshot,
          member: "skills/demo",
          skillId: "layout-template-original",
          enabled: false,
          markdownImport: true,
          storage: "retained",
        })
      }),
    )
    const created = await f.run(executeSharedCreate(library, { plan, mode: "create" }))
    expect(created.verified).toBe(true)
    const file = [...f.files.values()].find(
      (row) => text(property(property(row.properties).path).rich_text) === "assets/template.md",
    )!
    expect(f.base.bodies.get(String(file.id))).not.toContain('<div class="c2">')
    f.base.objects.clear()
    f.base.json.clear()
    f.clear()
    const cold = await f.run(
      withSharedAuthoringTarget(
        created.skill_page_id,
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
      ),
    )
    const template = cold.files.find((file) => file.path === "assets/template.md")!
    expect(f.base.objects.get("objects/" + template.sha256)).toEqual(bytes)
    expect(f.writes()).toHaveLength(0)
    expect(
      await f.run(
        loadSharedCreatePlan(library, {
          skillPageId: created.skill_page_id,
          operationId: plan.operation_id,
        }),
      ),
    ).toEqual(plan)
  })
  test("an acknowledged main with rejected pre-manifest readback resumes the exact retained plan without another main POST", async () => {
    const f = retainedFixture(adapters[1], { markdownImport: true })
    const plan = await f.prepare(false)
    const frozen = canonicalSharedJson(plan)
    let rejected = true
    const run = () =>
      f.run(
        Effect.gen(function* () {
          const api = yield* Notion
          return yield* executeSharedCreate(library, { plan, mode: "create" }).pipe(
            Effect.provideService(Notion, {
              ...api,
              request: (path, body, options) =>
                api
                  .request(path, body, options)
                  .pipe(
                    Effect.flatMap((result) =>
                      rejected && path.includes("/markdown?")
                        ? Effect.fail(
                            fail(
                              "SHARED_CREATE_BODY_MISMATCH",
                              "Controlled previous validator rejected this unchanged readback.",
                              { component: "links" },
                            ),
                          )
                        : Effect.succeed(result),
                    ),
                  ),
            }),
          )
        }),
      )
    await expect(run()).rejects.toMatchObject({
      code: "SHARED_CREATE_BODY_MISMATCH",
      details: { stage: "manifest" },
    })
    const mainPage = [...f.skills.values()].find(
      (row) => text(property(property(row.properties).skill_id).rich_text) === plan.skill_id,
    )
    expect(mainPage).toBeDefined()
    const page = String(mainPage!.id)
    expect(f.nativeCreates()).toHaveLength(1)
    expect(f.base.records.size).toBe(0)
    const actual = f.base.bodies.get(page)
    f.clear()
    rejected = false
    const result = await run()
    expect(result).toMatchObject({
      verified: true,
      skill_page_id: page,
      operation_id: plan.operation_id,
    })
    expect(
      f
        .nativeCreates()
        .filter(
          (call) =>
            property(property(call.body).parent).data_source_id === library.skills.data_source_id,
        ),
    ).toHaveLength(0)
    expect(f.base.bodies.get(page)).toBe(actual)
    expect(
      f
        .writes()
        .filter(
          (call) =>
            call.method === "PATCH" &&
            property(property(property(call.body).properties)[skillPropertyIds.Enabled!])
              .checkbox === true,
        ),
    ).toHaveLength(0)
    expect(canonicalSharedJson(plan)).toBe(frozen)
    f.clear()
    expect((await run()).verified).toBe(true)
    expect(f.writes()).toHaveLength(0)
    f.base.json.clear()
    f.base.objects.clear()
    const cold = await f.run(
      withSharedAuthoringTarget(
        page,
        Effect.gen(function* () {
          return yield* openSharedConsumer({
            library,
            target: page,
            scope: yield* authScope,
            startedAt: Date.now(),
            forceFull: true,
            readOnly: true,
          })
        }),
      ),
    )
    expect(cold.files.map((file) => file.path)).toEqual(
      f.snapshot.members[0]!.portable.files.map((file) => file.path),
    )
    expect(f.writes()).toHaveLength(0)
  })

  test.each(["main_ack", "original_journal", "current_body"] as const)(
    "pre-manifest continuation refuses a missing or changed %s without any new write",
    async (guard) => {
      const f = retainedFixture(adapters[1], { markdownImport: true })
      const plan = await f.prepare(false)
      const rejected = await f.run(
        Effect.gen(function* () {
          const api = yield* Notion
          return yield* Effect.flip(executeSharedCreate(library, { plan, mode: "create" })).pipe(
            Effect.provideService(Notion, {
              ...api,
              request: (path, body, options) =>
                api
                  .request(path, body, options)
                  .pipe(
                    Effect.flatMap((result) =>
                      path.includes("/markdown?")
                        ? Effect.fail(
                            fail(
                              "SHARED_CREATE_BODY_MISMATCH",
                              "Original main readback was refused.",
                            ),
                          )
                        : Effect.succeed(result),
                    ),
                  ),
            }),
          )
        }),
      )
      const page = String(property(rejected.details).skill_page_id)
      expect(f.skills.has(page)).toBe(true)
      expect(f.base.records.size).toBe(0)
      if (guard === "main_ack") {
        const key = [...f.base.json.keys()].find(
          (key) =>
            key.includes("/source-ack-") &&
            property(property(f.base.json.get(key)).response).id === page,
        )
        expect(key).toBeDefined()
        f.base.json.delete(key!)
      } else if (guard === "original_journal") {
        const key = [...f.base.json.keys()].find(
          (key) =>
            key.startsWith("operations/shared-native-create/") &&
            key.endsWith(`/${plan.operation_id}.json`),
        )
        expect(key).toBeDefined()
        f.base.json.delete(key!)
      } else f.base.bodies.set(page, "# A different user-authored main\n")
      f.clear()
      const failure = await f.run(
        Effect.flip(executeSharedCreate(library, { plan, mode: "create" })),
      )
      expect(failure.code).toMatch(/SHARED_RECORD_UNRESOLVED|SHARED_CREATE_BODY_MISMATCH/)
      expect(f.writes()).toHaveLength(0)
      expect(f.nativeCreates()).toHaveLength(0)
    },
  )

  test("an immutable post-manifest failure stays review-required even after its body looks valid", async () => {
    const f = retainedFixture(adapters[1], { markdownImport: true })
    const plan = await f.prepare(false)
    f.onCreate((row, kind) => {
      if (kind === "file") f.base.bodies.set(String(row.id), "# Semantic damage in a reference\n")
    })
    const rejected = await f.run(
      Effect.flip(executeSharedCreate(library, { plan, mode: "create" })),
    )
    expect(rejected.code).toBe("SHARED_CREATE_BODY_MISMATCH")
    expect(String(property(rejected.details).stage)).toStartWith("body:")
    const page = String(property(rejected.details).skill_page_id)
    const rejectedFile = plan.files.find((file) => file.path !== plan.entrypoint)!
    const actualFilePage = [...f.files.values()].find(
      (row) => text(property(property(row.properties).file_id).rich_text) === rejectedFile.file_id,
    )
    expect(property(rejected.details)).toMatchObject({
      file_id: rejectedFile.file_id,
      path: rejectedFile.path,
      body_page_id: String(actualFilePage?.id),
      owner_page_id: page,
    })
    expect(JSON.stringify(rejected.details)).not.toContain("Semantic damage in a reference")
    // Use the declared original outcome entity rather than current page equality.
    const rows = await f.run(querySharedRecords(library, { skillPageId: page, kind: "operation" }))
    const failed = rows.find((row) => property(row.payload).kind === "skill_create_outcome")
    expect(failed).toBeDefined()
    expect(property(failed!.payload).status).toBe("needs_review")
    const preserved = canonicalSharedJson(failed)
    for (const file of f.files.values()) {
      const path = text(property(property(file.properties).path).rich_text)
      const original = plan.files.find((item) => item.path === path)
      if (original !== undefined) f.base.bodies.set(String(file.id), original.projection.markdown)
    }
    f.onCreate(() => {})
    f.clear()
    expect(
      (await f.run(Effect.flip(executeSharedCreate(library, { plan, mode: "create" })))).code,
    ).toBe("SHARED_CREATE_REVIEW_REQUIRED")
    expect(f.writes()).toHaveLength(0)
    const current = await f.run(
      querySharedRecords(library, {
        skillPageId: page,
        kind: "operation",
        recordId: failed!.record_id,
      }),
    )
    expect(canonicalSharedJson(current[0])).toBe(preserved)
  })

  test("a complete 100 KiB Markdown reference retains bounded input and body chunks and reconstructs the original plan cold", async () => {
    const originalText =
      "# Complete long reference\r\n\r\n" +
      Array.from(
        { length: 1400 },
        (_, index) =>
          `Paragraph ${index}: preserve 中文, quotes \"original\", slash \\ and every instruction without truncation.\r\n\r\n`,
      ).join("")
    const bytes = new TextEncoder().encode(originalText)
    expect(bytes.length).toBeGreaterThan(100 * 1024)
    const f = fixture([{ path: "references/large.md", bytes, mode: "100644" }], {
      markdownImport: true,
      recovery: true,
    })
    const plan = await f.run(
      Effect.gen(function* () {
        return yield* prepareSharedSourceProjection({
          library,
          definition: yield* readSourceDefinition(library, f.source.id),
          acquired: f.snapshot,
          member: "skills/demo",
          skillId: "long-retained-reference",
          enabled: false,
          markdownImport: true,
          storage: "retained",
        })
      }),
    )
    expect(f.writes()).toHaveLength(0)
    const result = await f.run(executeSharedCreate(library, { plan, mode: "create" }))
    expect(result.verified).toBe(true)
    const original = plan.files.find((file) => file.path === "references/large.md")!
    const inputs = await f.run(
      querySharedRecords(library, {
        skillPageId: result.skill_page_id,
        kind: "object",
        entityId: original.input.object_id,
      }),
    )
    expect(inputs[0]?.payload).toMatchObject({
      version: 2,
      kind: "chunked_utf8_input",
      bytes: bytes.length,
      sha256: original.input.sha256,
    })
    expect(new TextEncoder().encode(canonicalSharedJson(inputs[0]?.payload)).length).toBeLessThan(
      65536,
    )
    f.base.objects.clear()
    f.base.json.clear()
    f.clear()
    expect(
      await f.run(
        loadSharedCreatePlan(library, {
          skillPageId: result.skill_page_id,
          operationId: plan.operation_id,
        }),
      ),
    ).toEqual(plan)
    expect((await f.run(reconcileSharedCreate(library, plan))).verified).toBe(true)
    const cold = await f.run(
      withSharedAuthoringTarget(
        result.skill_page_id,
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
      ),
    )
    const large = cold.files.find((file) => file.path === "references/large.md")!
    expect(f.base.objects.get(`objects/${large.sha256}`)).toEqual(bytes)
    expect(f.writes()).toHaveLength(0)
    const chunks = property(inputs[0]?.payload).chunks
    if (!Array.isArray(chunks)) throw new Error("Expected retained input byte chunks")
    const chunk = property(chunks[0]).object_id
    for (const [id, row] of f.base.records)
      if (text(property(property(row.properties).record).rich_text) === chunk)
        f.base.records.delete(id)
    f.base.objects.clear()
    f.base.json.clear()
    await expect(
      f.run(
        loadSharedCreatePlan(library, {
          skillPageId: result.skill_page_id,
          operationId: plan.operation_id,
        }),
      ),
    ).rejects.toBeDefined()
    expect(f.writes()).toHaveLength(0)
  })

  test("a large retained member uses bounded manifest storage without dropping resources", async () => {
    const extra = Array.from({ length: 402 }, (_, index) => ({
      path: `assets/complete/${String(index).padStart(4, "0")}/${"retained-path-".repeat(6)}.json`,
      bytes: new TextEncoder().encode(JSON.stringify({ index, original: true }) + "\n"),
      mode: "100644" as const,
    }))
    const f = fixture(extra, { markdownImport: true, recovery: true })
    const plan = await f.run(
      Effect.gen(function* () {
        return yield* prepareSharedSourceProjection({
          library,
          definition: yield* readSourceDefinition(library, f.source.id),
          acquired: f.snapshot,
          member: "skills/demo",
          skillId: "large-retained-member",
          enabled: false,
          markdownImport: true,
          storage: "retained",
        })
      }),
    )
    expect(
      new TextEncoder().encode(canonicalSharedJson(sharedCreateManifest(plan))).length,
    ).toBeGreaterThan(64 * 1024)
    expect(await f.run(validateSharedCreatePlan(plan))).toEqual(plan)
    const result = await f.run(executeSharedCreate(library, { plan, mode: "create" }))
    expect(result.verified).toBe(true)
    f.base.objects.clear()
    f.base.json.clear()
    f.clear()
    const cold = await f.run(
      Effect.gen(function* () {
        return yield* withSharedAuthoringTarget(
          result.skill_page_id,
          openSharedConsumer({
            library,
            target: result.skill_page_id,
            scope: yield* authScope,
            startedAt: Date.now(),
            forceFull: true,
            readOnly: true,
          }),
        )
      }),
    )
    expect(cold.files).toHaveLength(407)
    for (const file of extra) {
      const actual = cold.files.find((item) => item.path === file.path)!
      expect(f.base.objects.get(`objects/${actual.sha256}`)).toEqual(file.bytes)
      expect(actual.mode).toBe(file.mode)
    }
    expect(
      await f.run(
        loadSharedCreatePlan(library, {
          skillPageId: result.skill_page_id,
          operationId: plan.operation_id,
        }),
      ),
    ).toEqual(plan)
    expect((await f.run(reconcileSharedCreate(library, plan))).verified).toBe(true)
    expect(f.writes()).toHaveLength(0)
  })

  test("explicit retained admission keeps a complete public Git member without an anonymous retrieval proof", async () => {
    const f = fixture()
    const plan = await f.run(
      Effect.gen(function* () {
        return yield* prepareSharedSourceProjection({
          library,
          definition: yield* readSourceDefinition(library, f.source.id),
          acquired: f.snapshot,
          member: "skills/demo",
          skillId: "explicit-retained-public-member",
          enabled: true,
          storage: "retained",
        })
      }),
    )
    expect(f.providerReads()).toBe(0)
    expect(plan.source_projection?.version).toBe(2)
    const created = await f.run(executeSharedCreate(library, { plan, mode: "create" }))
    expect(created.expected_source_projection?.source_id).toMatch(/^bundle-[a-f0-9]{64}$/u)
    expect(created.verified).toBe(true)
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
    expect(cold.files.map((file) => file.path)).toEqual(
      f.snapshot.members[0]!.portable.files.map((file) => file.path),
    )
    for (const original of f.snapshot.members[0]!.portable.files.filter(
      (file) => file.path !== "SKILL.md",
    )) {
      const actual = cold.files.find((file) => file.path === original.path)!
      expect(actual.mode).toBe(original.mode)
      expect(f.base.objects.get(`objects/${actual.sha256}`)).toEqual(original.bytes)
    }
    expect(f.providerReads()).toBe(0)
  })

  for (const adapter of adapters)
    test(`${adapter.type} import accepts reading-page formatting while cold consumers keep the retained source`, async () => {
      const f = retainedFixture(adapter, {
        markdownImport: true,
        readback: (wire) => wire.replace(/<h1>(.*?)<\/h1>/u, "### $1") + "\n",
      })
      const plan = await f.prepare()
      const frozen = canonicalSharedJson(plan)
      expect(plan.files.every((file) => file.projection.version === 14)).toBe(true)
      const created = await f.run(executeSharedCreate(library, { plan, mode: "create" }))
      expect(property(property(created).markdown_acceptance)).toMatchObject({
        policy: "notion_import_readback_v1",
        roundtrip_required: false,
      })
      expect(f.base.bodies.get(created.skill_page_id)).toContain("### Initial")
      const selection = created.expected_source_projection!
      expect(selection.source_revision).toBe(selection.source_id)
      expect(selection.source_id).toMatch(/^bundle-[a-f0-9]{64}$/u)
      const facts = await f.run(
        querySharedRecords(library, {
          skillPageId: created.skill_page_id,
          kind: "file_event",
        }),
      )
      for (const row of facts) {
        const event = decode(FileEventSchema, row.payload)
        expect(event.kind).toBe("projected")
        expect(resolveFileState(event.file_id, [event]).ownership.kind).toBe("following")
      }
      f.base.json.clear()
      f.base.objects.clear()
      f.clear()
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
      for (const original of f.snapshot.members[0]!.portable.files.filter(
        (file) => file.path !== "SKILL.md",
      )) {
        const file = snapshot.files.find((file) => file.path === original.path)!
        expect(file.mode).toBe(original.mode)
        expect(f.base.objects.get(`objects/${file.sha256}`)).toEqual(original.bytes)
      }
      const main = snapshot.files.find((file) => file.path === "SKILL.md")!
      const mainText = new TextDecoder().decode(f.base.objects.get(`objects/${main.sha256}`))
      expect(mainText).toContain("# Initial")
      expect(mainText).not.toContain("### Initial")
      expect(() => verifySharedCreatedSnapshot(snapshot, created)).not.toThrow()
      const restored = await f.run(
        loadSharedCreatePlan(library, {
          skillPageId: created.skill_page_id,
          operationId: plan.operation_id,
        }),
      )
      expect(canonicalSharedJson(restored)).toBe(frozen)
      expect((await f.run(reconcileSharedCreate(library, restored))).reused).toBe(true)
      expect(f.writes()).toHaveLength(0)
      expect(f.providerReads()).toBe(0)
      expect(canonicalSharedJson(plan)).toBe(frozen)
    })

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
