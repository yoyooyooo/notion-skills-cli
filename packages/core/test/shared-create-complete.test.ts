import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { authScope } from "../src/catalog.ts"
import { fail, property, text, type SkillsError } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { openSharedConsumer } from "../src/shared-consumer.ts"
import {
  executeSharedCreate,
  loadSharedCreatePlan,
  prepareSharedCreate,
  reconcileSharedCreate,
} from "../src/shared-create.ts"
import { makeSharedCreatePlan, validateSharedCreatePlan } from "../src/shared-create-model.ts"
import { prepareSharedCreateLocal } from "../src/shared-create-local.ts"
import { verifySharedCreatedSnapshot } from "../src/shared-create-verification.ts"
import { LIBRARY_MARKER } from "../src/shared-library.ts"
import { canonicalSharedJson } from "../src/shared-records.ts"
import { createLibrary, sharedCreateFixture } from "./shared-create-fixture.ts"
import { encode } from "./shared-snapshot-fixture.ts"
import {
  fixture as sourceFixture,
  library as withSourcesLibrary,
} from "./shared-source-projection-fixture.ts"

function portable() {
  return {
    kind: "skill" as const,
    name: "Complete native",
    description: "Exact complete native import",
    main: "SKILL.md",
    files: [
      {
        path: "SKILL.md",
        mode: "100755" as const,
        bytes: encode(
          "---\nname: Complete native\ndescription: Exact complete native import\nlicense: MIT\nallowed-tools: [Read, Bash]\n---\n\n# Complete\n\n[Guide](references/a.md) [Script](scripts/run.js) ![Image](assets/icon.png)\n",
        ),
      },
      {
        path: "references/a.md",
        mode: "100755" as const,
        bytes: encode("# Guide\n\n[Config](../data/options.json)\n"),
      },
      {
        path: "scripts/run.js",
        mode: "100755" as const,
        bytes: encode("#!/usr/bin/env node\r\nconsole.log('must not execute')\r\n"),
      },
      { path: "data/options.json", mode: "100644" as const, bytes: encode('{"raw":true}\r\n') },
      {
        path: "assets/icon.png",
        mode: "100644" as const,
        bytes: new Uint8Array([137, 80, 78, 71, 0, 255, 10]),
      },
    ],
  }
}

describe("complete resource creation in the original native journal", () => {
  test.each(["references/a.md", "references/a.markdown"])(
    "a complete supporting header remains exact through native creation and cold reconstruction: %s",
    async (path) => {
      const f = sharedCreateFixture(),
        input = portable()
      const header =
        "---\r\nname: nested-reference\r\nlicense: Complete terms in LICENSE.txt\r\nmetadata: '[opaque label](unresolved.md)'\r\n---\r\n\r\n"
      const reference = input.files.find((file) => file.path === "references/a.md")!
      reference.path = path
      input.files[0]!.bytes = encode(
        new TextDecoder().decode(input.files[0]!.bytes).replace("references/a.md", path),
      )
      reference.bytes = encode(header + "# Guide\r\n\r\n[Config](../data/options.json)\r\n")
      const plan = await f.run(
        prepareSharedCreate(createLibrary, { portable: input, completeResources: true }),
      )
      const projected = plan.files.find((file) => file.path === reference.path)!
      expect(projected.input.text).toBe(new TextDecoder().decode(reference.bytes))
      expect(property(projected.content).frontmatter).toBe(header)
      expect(projected.content.mode).toBe("100755")
      expect(projected.projection.markdown).toBe("# Guide\n\n[Config](../data/options.json)")
      const created = await f.run(executeSharedCreate(createLibrary, { plan, mode: "create" }))
      f.base.objects.clear()
      f.base.json.clear()
      const snapshot = await f.run(
        Effect.gen(function* () {
          return yield* openSharedConsumer({
            library: createLibrary,
            target: created.skill_page_id,
            scope: yield* authScope,
            startedAt: Date.now(),
            readOnly: true,
            forceFull: true,
          })
        }),
      )
      const actual = snapshot.files.find((file) => file.path === reference.path)!
      expect(actual.mode).toBe("100755")
      expect(new TextDecoder().decode(f.base.objects.get(`objects/${actual.sha256}`))).toBe(
        header + "# Guide\n\n[Config](../data/options.json)",
      )
      expect(() => verifySharedCreatedSnapshot(snapshot, created)).not.toThrow()
      const reconstructed = await f.run(
        loadSharedCreatePlan(createLibrary, {
          skillPageId: created.skill_page_id,
          operationId: plan.operation_id,
        }),
      )
      expect(canonicalSharedJson(reconstructed)).toBe(canonicalSharedJson(plan))
    },
  )

  test.each(["", "\uFEFF"])(
    "a supporting local N1 keeps complete C1 header ancestry and its separately authored header and mode: prefix %j",
    async (prefix) => {
      const path = "references/nested/SKILL.md"
      const c1Header = prefix + "---\nname: nested-reference\nlicense: MIT\n---\n\n"
      const n1Header = prefix + "---\nname: nested-reference\nlicense: Apache-2.0\n---\n\n"
      const f = sourceFixture([{ path, bytes: encode(c1Header + "# Original\n"), mode: "100755" }])
      const original = await f.prepare()
      const source = original.source_projection
      const baseline = f.snapshot.members[0]!.portable
      const files = baseline.files.map((file) =>
        file.path === path
          ? { ...file, bytes: encode(n1Header + "# Local N1\n"), mode: "100644" as const }
          : file,
      )
      const local = await f.run(
        prepareSharedCreateLocal({
          baseline: source.binding,
          baselineFiles: baseline.files,
          files,
          selected: source.binding,
        }),
      )
      const plan = await f.run(
        makeSharedCreatePlan(withSourcesLibrary, {
          portable: { ...baseline, files: files.filter((file) => /\.md$/u.test(file.path)) },
          sourceProjection: { ...source, local },
          completeResources: true,
          enabled: true,
        }),
      )
      const projected = plan.files.find((file) => file.path === path)!
      expect(projected.ancestors).toHaveLength(1)
      expect(projected.ancestors?.[0]).toMatchObject({
        kind: "projected",
        source_revision: f.snapshot.revision,
        frontmatter: c1Header,
        mode: "100755",
      })
      expect(projected.baseline_body?.markdown).toBe("# Original")
      expect(property(projected.baseline_body?.content).frontmatter).toBe(c1Header)
      expect(projected.event).toMatchObject({
        kind: "adopted",
        parents: [projected.ancestors![0]!.event_id],
      })
      expect(projected.content).toMatchObject({ frontmatter: n1Header, mode: "100644" })
      expect(projected.input.text).toBe(n1Header + "# Local N1\n")
      const created = await f.run(executeSharedCreate(withSourcesLibrary, { plan, mode: "create" }))
      f.base.objects.clear()
      f.base.json.clear()
      const snapshot = await f.run(
        Effect.gen(function* () {
          return yield* openSharedConsumer({
            library: withSourcesLibrary,
            target: created.skill_page_id,
            scope: yield* authScope,
            startedAt: Date.now(),
            readOnly: true,
            forceFull: true,
          })
        }),
      )
      const actual = snapshot.files.find((file) => file.path === path)!
      expect(actual.mode).toBe("100644")
      expect(
        new TextDecoder("utf-8", { ignoreBOM: true }).decode(
          f.base.objects.get(`objects/${actual.sha256}`),
        ),
      ).toBe(n1Header + "# Local N1")
      expect(() => verifySharedCreatedSnapshot(snapshot, created)).not.toThrow()
      const reconstructed = await f.run(
        loadSharedCreatePlan(withSourcesLibrary, {
          skillPageId: created.skill_page_id,
          operationId: plan.operation_id,
        }),
      )
      expect(canonicalSharedJson(reconstructed)).toBe(canonicalSharedJson(plan))
    },
  )

  test("raw bytes, Markdown modes and extra main frontmatter survive cold consumption and original reconstruction", async () => {
    const f = sharedCreateFixture(),
      input = portable()
    const plan = await f.run(
      prepareSharedCreate(createLibrary, { portable: input, completeResources: true }),
    )
    expect(plan.files.map((file) => file.path)).toEqual(["SKILL.md", "references/a.md"])
    expect(plan.resources?.map((file) => file.path)).toEqual([
      "assets/icon.png",
      "data/options.json",
      "scripts/run.js",
    ])
    expect(plan.files[0]?.content.mode).toBe("100755")
    expect(property(plan.files[0]?.content).frontmatter).toContain("allowed-tools")
    const created = await f.run(executeSharedCreate(createLibrary, { plan, mode: "create" }))
    expect(f.nativeCreates()).toHaveLength(5)
    expect(f.enablePatches()).toHaveLength(1)
    expect(property(property(f.nativeCreates()[0]?.body).properties).enabled).toEqual({
      checkbox: false,
    })
    expect(
      f.calls.filter((call) => call.path.includes("/markdown") && call.method !== "GET"),
    ).toHaveLength(0)
    f.base.objects.clear()
    const snapshot = await f.run(
      Effect.gen(function* () {
        return yield* openSharedConsumer({
          library: createLibrary,
          target: created.skill_page_id,
          scope: yield* authScope,
          startedAt: Date.now(),
          readOnly: true,
          forceFull: true,
        })
      }),
    )
    expect(snapshot.files.map((file) => file.path)).toEqual(
      input.files.map((file) => file.path).sort(),
    )
    for (const original of input.files.filter((file) => !file.path.endsWith(".md"))) {
      const actual = snapshot.files.find((file) => file.path === original.path)!
      expect(actual.mode).toBe(original.mode)
      expect(f.base.objects.get(`objects/${actual.sha256}`)).toEqual(original.bytes)
    }
    for (const path of ["SKILL.md", "references/a.md"])
      expect(snapshot.files.find((file) => file.path === path)?.mode).toBe("100755")
    const main = snapshot.files.find((file) => file.path === "SKILL.md")!
    const composed = new TextDecoder().decode(f.base.objects.get(`objects/${main.sha256}`))
    expect(composed).toContain('"license": "MIT"')
    expect(composed).toContain('"allowed-tools"')
    expect(() => verifySharedCreatedSnapshot(snapshot, created)).not.toThrow()
    const restored = await f.run(
      loadSharedCreatePlan(createLibrary, {
        skillPageId: created.skill_page_id,
        operationId: plan.operation_id,
      }),
    )
    expect(canonicalSharedJson(restored)).toBe(canonicalSharedJson(plan))
    f.clear()
    expect((await f.run(reconcileSharedCreate(createLibrary, restored))).reused).toBe(true)
    expect(f.writes()).toHaveLength(0)
  })

  test("a durable original POST ACK survives failed readback and only unstarted stages continue", async () => {
    const f = sharedCreateFixture(),
      plan = await f.run(
        prepareSharedCreate(createLibrary, {
          portable: portable(),
          completeResources: true,
          enabled: false,
        }),
      )
    let failed = false
    const first = await f.run(
      Effect.gen(function* () {
        const api = yield* Notion
        return yield* executeSharedCreate(createLibrary, { plan, mode: "create" }).pipe(
          Effect.provideService(Notion, {
            ...api,
            request: (path, body, options) =>
              Effect.suspend((): Effect.Effect<unknown, SkillsError> => {
                if (
                  !failed &&
                  body === undefined &&
                  /^v1\/pages\//u.test(path) &&
                  f.nativeCreates().length === 1
                ) {
                  failed = true
                  return Effect.fail(
                    fail("READ_INTERRUPTED", "Controlled acknowledged allocation readback failure"),
                  )
                }
                return api.request(path, body, options)
              }),
          }),
          Effect.result,
        )
      }),
    )
    expect(first._tag).toBe("Failure")
    expect(f.nativeCreates()).toHaveLength(1)
    expect(f.pending()).toHaveLength(1)
    const ack = [...f.base.json.keys()].filter((key) => key.includes("/source-ack-"))
    expect(ack).toHaveLength(1)
    const created = await f.run(executeSharedCreate(createLibrary, { plan, mode: "create" }))
    expect(created.operation_id).toBe(plan.operation_id)
    expect(f.nativeCreates()).toHaveLength(5)
    expect(f.enablePatches()).toHaveLength(0)
    expect(f.pending()).toHaveLength(0)
    expect(
      [...f.skills.values()].filter(
        (row) => text(property(property(row.properties).skill_id).rich_text) === plan.skill_id,
      ),
    ).toHaveLength(1)
  })

  test("raw payload or known mode changes cannot be substituted into an original frozen plan", async () => {
    const f = sharedCreateFixture(),
      plan = await f.run(
        prepareSharedCreate(createLibrary, { portable: portable(), completeResources: true }),
      )
    const content = structuredClone(plan)
    const raw = content.resources?.[0]
    if (raw === undefined) throw new Error("Missing raw resource")
    const forged = {
      ...content,
      resources: content.resources!.map((file, index) =>
        index === 0
          ? {
              ...file,
              prepared: { ...file.prepared, content: { ...file.prepared.content, mode: "100755" } },
            }
          : file,
      ),
    }
    await expect(f.run(validateSharedCreatePlan(forged))).rejects.toThrow()
    const changed = {
      ...plan,
      resources: plan.resources!.map((file, index) =>
        index === 0
          ? {
              ...file,
              prepared: {
                ...file.prepared,
                objects: file.prepared.objects.map((object, at) =>
                  at === 0 ? { ...object, payload: { ...object.payload, data: "AAAA" } } : object,
                ),
              },
            }
          : file,
      ),
    }
    await expect(f.run(validateSharedCreatePlan(changed))).rejects.toThrow()
    expect(f.writes()).toHaveLength(0)
  })

  test("additive registered properties do not replace the original library descriptor or plan hash", async () => {
    const f = sharedCreateFixture(),
      plan = await f.run(
        prepareSharedCreate(createLibrary, {
          portable: portable(),
          completeResources: true,
          enabled: false,
        }),
      )
    const current = {
      ...createLibrary,
      skills: {
        ...createLibrary.skills,
        property_ids: { ...createLibrary.skills.property_ids, "Displayed Revision": "new_display" },
      },
    }
    const reconstructed = await f.run(
      Effect.gen(function* () {
        const api = yield* Notion
        return yield* Effect.gen(function* () {
          const created = yield* executeSharedCreate(current, { plan, mode: "create" })
          return yield* loadSharedCreatePlan(current, {
            skillPageId: created.skill_page_id,
            operationId: plan.operation_id,
          })
        }).pipe(
          Effect.provideService(Notion, {
            ...api,
            request: (path, body, options) =>
              path === `v1/databases/${current.skills.database_id}`
                ? api.request(path, body, options).pipe(
                    Effect.map((raw) => ({
                      ...property(raw),
                      description: [{ plain_text: LIBRARY_MARKER + JSON.stringify(current) }],
                    })),
                  )
                : api.request(path, body, options),
          }),
        )
      }),
    )
    expect(reconstructed).toEqual(plan)
    expect(plan.library.skills.property_ids["Displayed Revision"]).toBeUndefined()
  })

  test("adding Sources after an unknown invisible POST cannot move the original ACK scope and replay creation", async () => {
    const f = sharedCreateFixture(),
      plan = await f.run(
        prepareSharedCreate(createLibrary, {
          portable: portable(),
          completeResources: true,
          enabled: false,
        }),
      )
    expect(plan.library.sources).toBeUndefined()
    f.unknown("skill", false)
    await expect(
      f.run(executeSharedCreate(createLibrary, { plan, mode: "create" })),
    ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
    const writes = f.writes().length
    const result = await f.run(
      Effect.gen(function* () {
        const api = yield* Notion
        return yield* executeSharedCreate(withSourcesLibrary, { plan, mode: "create" }).pipe(
          Effect.provideService(Notion, {
            ...api,
            request: (path, body, options) =>
              path === `v1/databases/${withSourcesLibrary.skills.database_id}`
                ? api.request(path, body, options).pipe(
                    Effect.map((raw) => ({
                      ...property(raw),
                      description: [
                        { plain_text: LIBRARY_MARKER + JSON.stringify(withSourcesLibrary) },
                      ],
                    })),
                  )
                : api.request(path, body, options),
          }),
          Effect.result,
        )
      }),
    )
    expect(result._tag).toBe("Failure")
    expect(f.nativeCreates()).toHaveLength(1)
    expect(f.writes()).toHaveLength(writes)
    expect(f.pending()).toHaveLength(1)
  })

  test("rotating a credential in the same store cannot replay an invisible original POST", async () => {
    const f = sharedCreateFixture(),
      plan = await f.run(
        prepareSharedCreate(createLibrary, {
          portable: portable(),
          completeResources: true,
          enabled: false,
        }),
      )
    f.unknown("skill", false)
    await expect(
      f.run(executeSharedCreate(createLibrary, { plan, mode: "create" })),
    ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
    const writes = f.writes().length
    f.credential("rotated-original-create-credential")
    const result = await f.run(
      executeSharedCreate(createLibrary, { plan, mode: "create" }).pipe(Effect.result),
    )
    expect(f.nativeCreates()).toHaveLength(1)
    expect(f.writes()).toHaveLength(writes)
    expect(result._tag).toBe("Failure")
    expect(f.pending()).toHaveLength(1)
  })

  test("an exact completed original outcome remains readable under a different authorized credential without creation writes", async () => {
    const f = sharedCreateFixture(),
      plan = await f.run(
        prepareSharedCreate(createLibrary, {
          portable: portable(),
          completeResources: true,
          enabled: false,
        }),
      )
    const created = await f.run(executeSharedCreate(createLibrary, { plan, mode: "create" }))
    f.credential("another-authorized-completion-reader")
    f.clear()
    const observed = await f.run(executeSharedCreate(createLibrary, { plan, mode: "create" }))
    expect(observed.reused).toBe(true)
    expect(observed.operation_id).toBe(created.operation_id)
    expect(observed.skill_page_id).toBe(created.skill_page_id)
    expect(f.writes()).toHaveLength(0)
  })
})
