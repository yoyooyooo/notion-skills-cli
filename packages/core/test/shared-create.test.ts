import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { authScope } from "../src/catalog.ts"
import { decode, property } from "../src/model.ts"
import type { PortableSkill } from "../src/portable.ts"
import {
  createSharedNative,
  executeSharedCreate,
  hasPendingSharedCreate,
  loadPendingSharedCreates,
  loadSharedCreatePlan,
  pendingSharedCreatePlans,
  prepareSharedCreate,
  reconcileSharedCreate,
} from "../src/shared-create.ts"
import {
  makeSharedCreatePlan,
  sharedCreateManifest,
  validateSharedCreatePlan,
} from "../src/shared-create-model.ts"
import { FileEventSchema, resolveFileState } from "../src/shared-file-state.ts"
import { canonicalSharedJson, querySharedRecords } from "../src/shared-records.ts"
import {
  projectSharedNotionMarkdown,
  sharedNotionMarkdownWire,
} from "../src/shared-notion-projection.ts"
import { querySharedSkillIndex } from "../src/shared-skill-index.ts"
import {
  createLibrary,
  createRelationsLibrary,
  sharedCreateFixture,
} from "./shared-create-fixture.ts"
import { digest, encode, id, skillPage } from "./shared-snapshot-fixture.ts"

function portable(
  options: {
    readonly kind?: PortableSkill["kind"]
    readonly name?: string
    readonly files?: PortableSkill["files"]
  } = {},
): PortableSkill {
  const kind = options.kind ?? "skill",
    main = kind === "router" ? "ROUTER.md" : kind === "prompt" ? "PROMPT.md" : "SKILL.md"
  return {
    kind,
    name: options.name ?? "Native new",
    description: "A complete native creation fixture.",
    main,
    files: options.files ?? [
      { path: main, bytes: encode("# Native\n\n[Reference](references/a.md)\n") },
      { path: "references/a.md", bytes: encode("# Reference\r\n\r\n") },
    ],
  }
}
function facts(f: ReturnType<typeof sharedCreateFixture>, page: string) {
  return f.run(
    querySharedRecords(createLibrary, { skillPageId: page, kind: "file_event" }).pipe(
      Effect.map((rows) => rows.map((row) => decode(FileEventSchema, row.payload))),
    ),
  )
}

describe("native shared creation", () => {
  test("an unrelated unregistered draft does not block creation or get modified", async () => {
    const f = sharedCreateFixture()
    const draft = f.seedSkill(id(811), "", "Work in progress", "skill", false)
    const original = structuredClone(draft)
    const result = await f.run(createSharedNative(createLibrary, { portable: portable() }))
    expect(result.status).toBe("created")
    expect(draft).toEqual(original)
    expect(
      f.calls.some((call) => call.method === "PATCH" && call.path === `v1/pages/${id(811)}`),
    ).toBe(false)
  })

  test("an unregistered draft reserves its name and alias before any create write", async () => {
    const f = sharedCreateFixture()
    f.seedSkill(id(812), "", "Native new", "skill", false)
    const result = await f.run(
      prepareSharedCreate(createLibrary, { portable: portable({ name: "native-new" }) }).pipe(
        Effect.result,
      ),
    )
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure")
      throw new Error("Expected the existing draft name to remain reserved")
    expect(result.failure.code).toBe("NAME_CONFLICT")
    expect(result.failure.details).toEqual({
      name: "native-new",
      page_id: id(812),
      state: "unregistered",
    })
    expect(f.writes()).toHaveLength(0)
  })

  test("ordinary H1 and rich Markdown use frozen native request and exact observed candidates", async () => {
    const main =
      "# Native acceptance\n\nAcceptance marker NativeCanaryAlpha20261101.\n\nRead the supporting file at `references/guide.md`."
    const supporting = "# Supporting\n\n**bold `code` bold** and *italic* and ~~strike~~."
    const responses = new Map([
      [
        "<h1>Native acceptance</h1>\n\nAcceptance marker NativeCanaryAlpha20261101.\n\nRead the supporting file at `references/guide.md`.",
        "# Native acceptance\n\nAcceptance marker NativeCanaryAlpha20261101.\n\nRead the supporting file at <code>references/guide.md</code>.",
      ],
      [
        "<h1>Supporting</h1>\n\n**bold `code` bold** and *italic* and ~~strike~~.",
        "# Supporting\n\n<b>bold </b><b><code>code</code></b><b> bold</b> and <i>italic</i> and <s>strike</s>.",
      ],
    ])
    const f = sharedCreateFixture({
      readback: (wire) => {
        const observed = responses.get(wire)
        if (observed === undefined)
          throw new Error("Unexpected request outside captured native Markdown contract")
        return observed
      },
    })
    const input = portable({
      files: [
        { path: "SKILL.md", bytes: encode(main + "\n") },
        { path: "references/guide.md", bytes: encode(supporting + "\n") },
      ],
    })
    const plan = await f.run(prepareSharedCreate(createLibrary, { portable: input }))
    for (const file of plan.files) {
      expect(file.projection.version).toBe(8)
      const expected = responses.get(sharedNotionMarkdownWire(file.projection))
      if (expected === undefined) throw new Error("Missing independent native readback")
      expect(file.projection.markdown).toBe(expected)
      expect(file.input.text).toBe(file.path === "SKILL.md" ? main + "\n" : supporting + "\n")
    }
    const result = await f.run(executeSharedCreate(createLibrary, { plan, mode: "create" }))
    expect(result.status).toBe("created")
    expect(f.nativeCreates()).toHaveLength(2)
    expect(f.enablePatches()).toHaveLength(1)
    expect(f.calls.some((call) => call.method === "PATCH" && call.path.includes("/markdown"))).toBe(
      false,
    )
  })

  test("a failed v1 H1 create retains its original expected bytes and cannot be replayed under a new policy", async () => {
    const main = "# Native acceptance\n\nRead `references/guide.md`."
    const f = sharedCreateFixture({ readback: () => "Read <code>references/guide.md</code>." })
    const input = portable({ files: [{ path: "SKILL.md", bytes: encode(main) }] })
    const old = await f.run(makeSharedCreatePlan(createLibrary, { portable: input }, 1))
    const original = canonicalSharedJson(old)
    expect(
      (await f.run(Effect.flip(executeSharedCreate(createLibrary, { plan: old, mode: "create" }))))
        .code,
    ).toBe("SHARED_CREATE_BODY_MISMATCH")
    expect(canonicalSharedJson(await f.run(validateSharedCreatePlan(old)))).toBe(original)
    expect(old.files[0]!.projection.markdown).toBe(main)
    expect(sharedNotionMarkdownWire(old.files[0]!.projection)).toBe(main)
    f.clear()
    expect((await f.run(Effect.flip(reconcileSharedCreate(createLibrary, old)))).code).toBe(
      "SHARED_CREATE_REVIEW_REQUIRED",
    )
    expect(
      (await f.run(Effect.flip(createSharedNative(createLibrary, { portable: input })))).code,
    ).toBe("SHARED_CREATE_PENDING")
    expect(f.writes()).toHaveLength(0)
    expect(f.pending()).toHaveLength(1)
    expect(canonicalSharedJson(old)).toBe(original)
  })

  test("a retained v2 creation remains valid when policy 3 rejects its inline literal backtick", async () => {
    const f = sharedCreateFixture()
    const main = "Native <code>a`b</code>.\n\nNext paragraph.\n"
    const input = portable({ files: [{ path: "SKILL.md", bytes: encode(main) }] })
    const retained = await f.run(makeSharedCreatePlan(createLibrary, { portable: input }, 2))
    const original = canonicalSharedJson(retained)
    expect(retained.files[0]!.projection.version).toBe(2)
    expect(sharedNotionMarkdownWire(retained.files[0]!.projection)).toBe(main.slice(0, -1))
    expect(sharedCreateManifest(retained).files[0]!.projection.version).toBe(2)
    expect(canonicalSharedJson(await f.run(validateSharedCreatePlan(retained)))).toBe(original)
    expect(
      (await f.run(Effect.flip(makeSharedCreatePlan(createLibrary, { portable: input })))).code,
    ).toBe("SHARED_MARKDOWN_PROJECTION_UNSUPPORTED")
    expect(new TextDecoder().decode(input.files[0]!.bytes)).toBe(main)
    expect(canonicalSharedJson(retained)).toBe(original)
    expect(f.calls).toHaveLength(0)
  })

  test("a retained v1 manifest reconstructs under its original policy, including previously accepted frontmatter", async () => {
    const f = sharedCreateFixture()
    const input = portable({
      files: [
        { path: "SKILL.md", bytes: encode("---\nlicense: MIT\n---\n\nA retained v1 body.\n") },
      ],
    })
    const old = await f.run(makeSharedCreatePlan(createLibrary, { portable: input }, 1))
    const created = await f.run(executeSharedCreate(createLibrary, { plan: old, mode: "create" }))
    f.credential("different-v1-reader")
    f.clear()
    const loaded = await f.run(
      loadSharedCreatePlan(createLibrary, {
        skillPageId: created.skill_page_id,
        operationId: old.operation_id,
      }),
    )
    expect(canonicalSharedJson(loaded)).toBe(canonicalSharedJson(old))
    expect(loaded.files[0]!.projection.version).toBe(1)
    expect(f.writes()).toHaveLength(0)
    expect(
      (await f.run(Effect.flip(makeSharedCreatePlan(createLibrary, { portable: input })))).code,
    ).toBe("SHARED_FRONTMATTER_UNSUPPORTED")
  })

  test("one creation cannot mix projection versions or substitute a body-write wire", async () => {
    const f = sharedCreateFixture()
    const plan = await f.run(makeSharedCreatePlan(createLibrary, { portable: portable() }))
    for (const projection of [
      projectSharedNotionMarkdown("# Reference", { version: 1 }),
      projectSharedNotionMarkdown("# Reference", { purpose: "body_write" }),
    ]) {
      const changed = {
        ...plan,
        files: plan.files.map((file) =>
          file.path === "references/a.md" ? { ...file, projection } : file,
        ),
      }
      expect((await f.run(Effect.flip(validateSharedCreatePlan(changed)))).code).toBe(
        "SHARED_CREATE_INVALID",
      )
    }
    expect(f.calls).toHaveLength(0)
  })

  test("v1 reconstruction retains the original native-code reference counts in its identity", async () => {
    const f = sharedCreateFixture()
    const input = portable({
      files: [
        { path: "SKILL.md", bytes: encode("<code>[example](references/a.md)</code>") },
        { path: "references/a.md", bytes: encode("Retained supporting file") },
      ],
    })
    const old = await f.run(makeSharedCreatePlan(createLibrary, { portable: input }, 1))
    expect(old.reference_check).toEqual({ checked_files: 2, local_references: 1 })
    expect(canonicalSharedJson(await f.run(validateSharedCreatePlan(old)))).toBe(
      canonicalSharedJson(old),
    )
    const current = await f.run(makeSharedCreatePlan(createLibrary, { portable: input }))
    expect(current.reference_check).toEqual({ checked_files: 2, local_references: 0 })
    expect(current.operation_id).not.toBe(old.operation_id)
    expect(f.calls).toHaveLength(0)
  })

  test("same exact input freezes the same stable identities and preserves original versus projected bytes", async () => {
    const f = sharedCreateFixture(),
      original = portable()
    const a = await f.run(makeSharedCreatePlan(createLibrary, { portable: original }))
    const b = await f.run(
      makeSharedCreatePlan(createLibrary, {
        portable: { ...original, files: [...original.files].reverse() },
      }),
    )
    expect(canonicalSharedJson(a)).toBe(canonicalSharedJson(b))
    expect(f.calls).toHaveLength(0)
    const file = a.files.find((file) => file.path === "references/a.md")!
    expect(file.input.text).toBe("# Reference\r\n\r\n")
    expect(file.input.sha256).toBe(digest("# Reference\r\n\r\n"))
    expect(file.projection.markdown).toBe("# Reference")
    expect(file.projection.removed_terminal_lfs).toBe(2)
    expect(file.content.sha256).toBe(digest("# Reference"))
    const tampered = structuredClone(a)
    const wrong = {
      ...tampered,
      files: tampered.files.map((item, index) =>
        index === 0
          ? {
              ...item,
              projection: { ...item.projection, markdown: item.projection.markdown + "\n" },
            }
          : item,
      ),
    }
    expect((await f.run(Effect.flip(validateSharedCreatePlan(wrong)))).code).toBe(
      "SHARED_CREATE_INVALID",
    )
  })

  test("complete native tree is retained and verified before the only Enabled PATCH", async () => {
    const f = sharedCreateFixture(),
      old = [...f.base.bodies.entries()]
    const plan = await f.run(
      prepareSharedCreate(createLibrary, { portable: portable(), defaultContext: true }),
    )
    f.clear()
    const created = await f.run(executeSharedCreate(createLibrary, { plan, mode: "create" }))
    expect(created.status).toBe("created")
    expect(created.reused).toBe(false)
    expect(f.nativeCreates()).toHaveLength(2)
    expect(f.enablePatches()).toHaveLength(1)
    expect(f.pending()).toHaveLength(0)
    expect(f.retired.size).toBe(1)
    const index = await f.run(querySharedSkillIndex(createLibrary, created.skill_page_id))
    expect(index.enabled).toBe(true)
    expect(index.default_context).toBe(true)
    expect(index.source_reference).toBe("")
    expect(index.files.map((file) => file.path)).toEqual(["references/a.md"])
    for (const [page, body] of old) expect(f.base.bodies.get(page)).toBe(body)
    const events = await facts(f, created.skill_page_id)
    for (const file of plan.files) {
      expect(
        resolveFileState(
          file.file_id,
          events.filter((event) => event.file_id === file.file_id),
        ).ownership,
      ).toEqual({ kind: "custom", content: file.content })
      const input = await f.run(
        querySharedRecords(createLibrary, {
          skillPageId: created.skill_page_id,
          kind: "object",
          recordId: file.input.object_id,
          entityId: file.input.object_id,
        }),
      )
      expect(property(input[0]?.payload).text).toBe(file.input.text)
    }
    const enabledAt = f.calls.findIndex((call) => call.method === "PATCH")
    expect(
      f.calls.slice(0, enabledAt).filter((call) => call.path.includes("/markdown")),
    ).toHaveLength(4)
    expect(
      f.calls.some((call) => /(?:publications|skills\/|file_uploads|blocks\/)/u.test(call.path)),
    ).toBe(false)
  })

  test("dry-run creates no dispatch, native page, retained record or enabled flag", async () => {
    const f = sharedCreateFixture()
    const result = await f.run(
      createSharedNative(createLibrary, { portable: portable(), dryRun: true }),
    )
    expect(result.status).toBe("planned")
    expect(f.writes()).toHaveLength(0)
    expect(f.pending()).toHaveLength(0)
    expect(f.base.records.size).toBe(0)
  })

  test("binary input, legacy projection authority and broken references fail before writes", async () => {
    const f = sharedCreateFixture(),
      base = portable()
    const binary = {
      ...base,
      files: [...base.files, { path: "asset.bin", bytes: new Uint8Array([0, 255, 1]) }],
    }
    expect(
      (await f.run(Effect.flip(createSharedNative(createLibrary, { portable: binary })))).code,
    ).toBe("SHARED_NATIVE_CREATE_BINARY_UNSUPPORTED")
    const legacy = {
      ...base,
      projection: {
        name: base.name,
        description: base.description,
        body: "# Alternative",
        references: { "references/a.md": id(99) },
      },
    }
    expect(
      (await f.run(Effect.flip(createSharedNative(createLibrary, { portable: legacy })))).code,
    ).toBe("SHARED_NATIVE_CREATE_PROJECTION_UNSUPPORTED")
    const broken = {
      ...base,
      files: [{ path: base.main, bytes: encode("[Missing](missing.md)\n") }],
    }
    expect(
      (await f.run(Effect.flip(createSharedNative(createLibrary, { portable: broken })))).code,
    ).toBe("SHARED_REFERENCE_BROKEN")
    const extraMetadata = {
      ...base,
      files: [{ path: base.main, bytes: encode("---\nlicense: MIT\n---\n\n# Complete input\n") }],
    }
    expect(
      (await f.run(Effect.flip(createSharedNative(createLibrary, { portable: extraMetadata }))))
        .code,
    ).toBe("SHARED_FRONTMATTER_UNSUPPORTED")
    const bomMetadata = {
      ...base,
      files: [
        {
          path: base.main,
          bytes: encode(
            "\uFEFF---\nname: Native new\ndescription: A complete native creation fixture.\nlicense: MIT\n---\n\n# Complete input\n",
          ),
        },
      ],
    }
    expect(
      (await f.run(Effect.flip(createSharedNative(createLibrary, { portable: bomMetadata })))).code,
    ).toBe("SHARED_FRONTMATTER_UNSUPPORTED")
    expect(f.writes()).toHaveLength(0)
    expect(f.pending()).toHaveLength(0)
  })

  test("manifest indexes many bounded objects instead of embedding every original body", async () => {
    const f = sharedCreateFixture()
    const large = portable({
      files: [
        { path: "SKILL.md", bytes: encode("# Main\n") },
        ...["a", "b", "c"].map((name) => ({
          path: `${name}.md`,
          bytes: encode(name.repeat(30_000) + "\n"),
        })),
      ],
    })
    const plan = await f.run(makeSharedCreatePlan(createLibrary, { portable: large }))
    expect(encode(canonicalSharedJson(plan)).length).toBeGreaterThan(64 * 1024)
    expect(encode(canonicalSharedJson(sharedCreateManifest(plan))).length).toBeLessThan(64 * 1024)
    const oversized = portable({
      files: [
        { path: "SKILL.md", bytes: encode("# Main\n") },
        { path: "large.md", bytes: encode("x".repeat(65_536)) },
      ],
    })
    expect(
      (await f.run(Effect.flip(makeSharedCreatePlan(createLibrary, { portable: oversized })))).code,
    ).toBe("SHARED_RECORD_TOO_LARGE")
    expect(f.writes()).toHaveLength(0)
  })

  test("same-library name and alias conflicts cannot be bypassed by new create identity", async () => {
    const f = sharedCreateFixture()
    f.seedSkill(id(80), "another-stable-skill", "NATIVE NEW")
    expect(
      (await f.run(Effect.flip(createSharedNative(createLibrary, { portable: portable() })))).code,
    ).toBe("NAME_CONFLICT")
    expect(f.writes()).toHaveLength(0)
    expect(f.pending()).toHaveLength(0)
  })

  test("unknown first Skill POST is never replayed, whether its page is visible or absent", async () => {
    for (const visible of [true, false]) {
      const f = sharedCreateFixture(),
        plan = await f.run(prepareSharedCreate(createLibrary, { portable: portable() }))
      f.unknown("skill", visible)
      expect(
        (await f.run(Effect.flip(executeSharedCreate(createLibrary, { plan, mode: "create" }))))
          .code,
      ).toBe("WRITE_OUTCOME_UNKNOWN")
      expect(f.nativeCreates()).toHaveLength(1)
      expect(f.pending()).toHaveLength(1)
      f.clear()
      expect(
        (await f.run(Effect.flip(executeSharedCreate(createLibrary, { plan, mode: "create" }))))
          .code,
      ).toBe(visible ? "SHARED_RECORD_UNRESOLVED" : "SHARED_CREATE_UNRESOLVED")
      expect(f.writes()).toHaveLength(0)
      expect(f.currentBodies()).toHaveLength(0)
      expect(f.pending()).toHaveLength(1)
    }
  })

  test("unknown supporting File create leaves a disabled preserved Skill and original plan", async () => {
    const f = sharedCreateFixture(),
      plan = await f.run(prepareSharedCreate(createLibrary, { portable: portable() }))
    f.unknown("file", true)
    expect(
      (await f.run(Effect.flip(executeSharedCreate(createLibrary, { plan, mode: "create" })))).code,
    ).toBe("WRITE_OUTCOME_UNKNOWN")
    const selected = [...f.skills.values()].find(
      (row) =>
        String(property(property(row.properties).skill_id).type) === "rich_text" &&
        property(property(row.properties).skill_id).rich_text !== undefined &&
        String(row.id) !== skillPage,
    )!
    expect(property(property(selected.properties).enabled).checkbox).toBe(false)
    expect(f.enablePatches()).toHaveLength(0)
    f.clear()
    f.credential("other-authorized-machine")
    expect(
      (await f.run(Effect.flip(executeSharedCreate(createLibrary, { plan, mode: "create" })))).code,
    ).toBe("SHARED_CREATE_UNRESOLVED")
    expect(f.writes()).toHaveLength(0)
    expect(f.currentBodies()).toHaveLength(0)
  })

  test("changed input under an unresolved local name cannot create a fresh operation after invisible first POST", async () => {
    const f = sharedCreateFixture(),
      plan = await f.run(prepareSharedCreate(createLibrary, { portable: portable() }))
    f.unknown("skill", false)
    expect(
      (await f.run(Effect.flip(executeSharedCreate(createLibrary, { plan, mode: "create" })))).code,
    ).toBe("WRITE_OUTCOME_UNKNOWN")
    const next = portable({
      name: "NATIVE NEW",
      files: [{ path: "SKILL.md", bytes: encode("# Different intent\n") }],
    })
    f.clear()
    const error = await f.run(Effect.flip(createSharedNative(createLibrary, { portable: next })))
    expect(error.code).toBe("SHARED_CREATE_PENDING")
    expect(property(error.details).native_create_operation_id).toBe(plan.operation_id)
    expect(f.writes()).toHaveLength(0)
    expect(f.pending()).toHaveLength(1)
  })

  test("local pending lookup is scoped to exact credential/library/Skill and needs no network", async () => {
    const f = sharedCreateFixture(),
      plan = await f.run(prepareSharedCreate(createLibrary, { portable: portable() }))
    f.unknown("skill", false)
    await f.run(Effect.flip(executeSharedCreate(createLibrary, { plan, mode: "create" })))
    const scope = await f.run(authScope)
    f.clear()
    expect(
      await f.run(hasPendingSharedCreate(scope, createLibrary.library_id, plan.skill_id)),
    ).toBe(true)
    expect(
      await f.run(hasPendingSharedCreate(scope, createLibrary.library_id, "other-skill")),
    ).toBe(false)
    expect(
      await f.run(
        pendingSharedCreatePlans("f".repeat(64), createLibrary.library_id, plan.skill_id),
      ),
    ).toEqual([])
    expect(f.calls).toHaveLength(0)
  })

  test("matching enabled pages and adoption events do not replace an unknown original enable receipt", async () => {
    const f = sharedCreateFixture(),
      plan = await f.run(prepareSharedCreate(createLibrary, { portable: portable() }))
    f.unknown("enable", true)
    expect(
      (await f.run(Effect.flip(executeSharedCreate(createLibrary, { plan, mode: "create" })))).code,
    ).toBe("WRITE_OUTCOME_UNKNOWN")
    expect(f.enablePatches()).toHaveLength(1)
    f.clear()
    expect((await f.run(Effect.flip(reconcileSharedCreate(createLibrary, plan)))).code).toBe(
      "SHARED_CREATE_UNRESOLVED",
    )
    expect(f.writes()).toHaveLength(0)
    expect(f.currentBodies()).toHaveLength(0)
    expect(f.pending()).toHaveLength(1)
  })

  test("only the exact visible applied outcome retires an unknown original result", async () => {
    for (const visible of [true, false]) {
      const f = sharedCreateFixture(),
        plan = await f.run(prepareSharedCreate(createLibrary, { portable: portable() }))
      f.unknown("outcome", visible)
      expect(
        (await f.run(Effect.flip(executeSharedCreate(createLibrary, { plan, mode: "create" }))))
          .code,
      ).toBe("WRITE_OUTCOME_UNKNOWN")
      expect(f.pending()).toHaveLength(1)
      f.clear()
      if (visible) {
        const result = await f.run(reconcileSharedCreate(createLibrary, plan))
        expect(result.reused).toBe(true)
        expect(f.pending()).toHaveLength(0)
      } else {
        expect((await f.run(Effect.flip(reconcileSharedCreate(createLibrary, plan)))).code).toBe(
          "SHARED_CREATE_UNRESOLVED",
        )
        expect(f.pending()).toHaveLength(1)
      }
      expect(f.writes()).toHaveLength(0)
      expect(f.currentBodies()).toHaveLength(0)
    }
  })

  test("a different native response remains review-required and never changes the frozen expected hash", async () => {
    const f = sharedCreateFixture(),
      plan = await f.run(prepareSharedCreate(createLibrary, { portable: portable() }))
    f.onCreate((row, kind) => {
      if (kind === "skill") f.base.bodies.set(String(row.id), "Different native content")
    })
    expect(
      (await f.run(Effect.flip(executeSharedCreate(createLibrary, { plan, mode: "create" })))).code,
    ).toBe("SHARED_CREATE_BODY_MISMATCH")
    expect(f.nativeCreates()).toHaveLength(1)
    expect(f.enablePatches()).toHaveLength(0)
    expect(f.pending()).toHaveLength(1)
    f.clear()
    expect((await f.run(Effect.flip(reconcileSharedCreate(createLibrary, plan)))).code).toBe(
      "SHARED_CREATE_REVIEW_REQUIRED",
    )
    expect(f.writes()).toHaveLength(0)
  })

  test("shared manifest plus original objects reconstructs the same plan on another machine", async () => {
    const f = sharedCreateFixture(),
      plan = await f.run(prepareSharedCreate(createLibrary, { portable: portable() }))
    const created = await f.run(executeSharedCreate(createLibrary, { plan, mode: "create" }))
    f.credential("another-authorized-credential")
    f.clear()
    const loaded = await f.run(
      loadSharedCreatePlan(createLibrary, {
        skillPageId: created.skill_page_id,
        operationId: plan.operation_id,
      }),
    )
    expect(canonicalSharedJson(loaded)).toBe(canonicalSharedJson(plan))
    const reused = await f.run(reconcileSharedCreate(createLibrary, loaded))
    expect(reused.reused).toBe(true)
    expect(f.writes()).toHaveLength(0)
    expect(f.currentBodies()).toHaveLength(0)
  })

  test("completed create gate uses compact metadata and rejects completion without its original events", async () => {
    const f = sharedCreateFixture(),
      plan = await f.run(prepareSharedCreate(createLibrary, { portable: portable() }))
    const created = await f.run(executeSharedCreate(createLibrary, { plan, mode: "create" })),
      events = await facts(f, created.skill_page_id)
    f.clear()
    expect(
      await f.run(
        loadPendingSharedCreates(createLibrary, { skillPageId: created.skill_page_id, events }),
      ),
    ).toEqual([])
    expect(f.calls.some((call) => call.content === "body")).toBe(false)
    expect(f.currentBodies()).toHaveLength(0)
    expect(f.writes()).toHaveLength(0)
    expect(
      (
        await f.run(
          Effect.flip(
            loadPendingSharedCreates(createLibrary, {
              skillPageId: created.skill_page_id,
              events: [],
            }),
          ),
        )
      ).code,
    ).toBe("SHARED_CREATE_UNRESOLVED")
  })

  test.each(["skill", "router"] as const)(
    "%s creation freezes exact enabled Members/Requires and keeps Prompt metadata distinct",
    async (kind) => {
      const f = sharedCreateFixture({ relations: true }),
        plan = await f.run(
          prepareSharedCreate(createRelationsLibrary, {
            portable: portable({ kind }),
            members: [skillPage],
            requires: [skillPage],
          }),
        )
      expect(plan.members).toEqual([skillPage])
      expect(plan.requires).toEqual([skillPage])
      const created = await f.run(
        executeSharedCreate(createRelationsLibrary, { plan, mode: "create" }),
      )
      expect(created.record.kind).toBe(kind)
      expect(created.entrypoint).toBe(kind === "router" ? "ROUTER.md" : "SKILL.md")
      const prompt = id(81)
      f.seedSkill(prompt, "prompt-member", "Prompt member", "prompt")
      expect(
        (
          await f.run(
            Effect.flip(
              prepareSharedCreate(createRelationsLibrary, {
                portable: portable({ kind: "router", name: "Other router" }),
                members: [prompt],
              }),
            ),
          )
        ).code,
      ).toBe("INVALID_MEMBERS")
    },
  )
})
