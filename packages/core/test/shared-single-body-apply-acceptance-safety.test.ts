import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { property, text } from "../src/model.ts"
import { updateSkill } from "../src/command-operations.ts"
import { openSkill } from "../src/snapshot.ts"
import { parseTarget } from "../src/ref.ts"
import { withSharedAuthoringTarget } from "../src/shared-authoring-context.ts"
import { writeSharedSkillFile } from "../src/shared-authoring.ts"
import { applySharedSkillChanges } from "../src/shared-skill-apply-authoring.ts"
import { normalizeObservedBody } from "../src/shared-file-state.ts"
import { querySharedSkillIndex } from "../src/shared-skill-index.ts"
import { observeAcceptedSingleBodyApply } from "../src/shared-single-body-apply-acceptance.ts"
import {
  makeSharedSkillApplyPlan,
  sharedSkillApplyPlansEntity,
} from "../src/shared-skill-apply-model.ts"
import { storedSharedOperationPlan } from "../src/shared-plan-storage.ts"
import {
  prepareSharedMetadataWrite,
  executeSharedMetadataWriteWithJournal,
} from "../src/shared-metadata-write.ts"
import { prepareSharedFileManagement } from "../src/shared-file-management.ts"
import { prepareSharedResourceAuthoring } from "../src/shared-resource-authoring.ts"
import { sharedMetadataEntity } from "../src/shared-metadata-write-model.ts"
import {
  retainPendingFileOperation,
  sharedPendingObservationPrefix,
} from "../src/shared-pending-file-operations.ts"
import {
  authoringRead,
  coldClient,
  digest,
  failure,
  library,
  payloads,
  pendingKeys,
  pendingSingleBody,
  selected,
  skillPage,
  withNativeWrites,
  withRequestHook,
} from "./shared-single-body-apply-acceptance-fixture.ts"
import { rich, sharedSnapshotFixture } from "./shared-snapshot-fixture.ts"
import {
  fixture as sourceFixture,
  library as sourceLibrary,
} from "./shared-source-projection-fixture.ts"

type Case = Awaited<ReturnType<typeof pendingSingleBody>>
function replaceEvent(input: Case, changed: Record<string, unknown>) {
  for (const [key, row] of input.f.records)
    if (text(property(property(row.properties).record).rich_text) === input.child.event.event_id)
      input.f.records.delete(key)
  input.f.seedFact(changed, "file_event", input.child.file_id, String(changed.event_id))
}
const read = () =>
  withSharedAuthoringTarget(
    skillPage,
    openSkill(skillPage, { ...selected, refresh: true, sharedReadOnly: true }),
  )

describe("sole-body current acceptance safety boundaries", () => {
  test("valid multi-body v1 and layout v2 plans are outside this read exception before IO", async () => {
    const f = sharedSnapshotFixture({ fileCount: 2 })
    await f.target(parseTarget(skillPage), selected)
    const snapshot = await authoringRead(f)
    for (const path of ["references/1.md", "references/new.md"]) {
      const preview = await f.run(
        applySharedSkillChanges(snapshot, {
          files: [
            {
              path: "SKILL.md",
              bytes: new TextEncoder().encode(
                "---\nname: Managed Name\ndescription: Managed description\n---\n\n# Main candidate\n",
              ),
            },
            { path, bytes: new TextEncoder().encode("# Supporting candidate\n") },
          ],
          dryRun: true,
        }),
      )
      if (preview.status !== "planned" || preview.kind !== "skill_apply")
        throw new Error("Expected the complete public apply plan")
      expect(preview.plan.version).toBe(path === "references/1.md" ? 1 : 2)
      if (preview.plan.version === 1) expect(preview.plan.bodies).toHaveLength(2)
      f.clearCalls()
      expect(await f.run(observeAcceptedSingleBodyApply(library, preview.plan))).toBeUndefined()
      expect(f.calls).toHaveLength(0)
    }
  })

  for (const drift of ["metadata", "head"] as const)
    test(`previous graph observations cannot replace the fresh ${drift} proof`, async () => {
      const { f, plan, child, accept } = await pendingSingleBody()
      await f.run(accept())
      const proof = await f.run(observeAcceptedSingleBodyApply(library, plan))
      if (proof === undefined) throw new Error("Expected the exact initial current proof")
      const index = await f.run(querySharedSkillIndex(library, skillPage))
      if (drift === "metadata")
        property(f.main.properties).description = rich(
          "description",
          "Changed after the graph read",
        )
      else
        f.seedFact(
          { ...child.event, event_id: "later-current-head", parents: [child.event.event_id] },
          "file_event",
          child.file_id,
          "later-current-head",
        )
      const result = await f.run(
        observeAcceptedSingleBodyApply(library, plan, {
          index,
          headers: proof.headers,
          events: proof.events,
        }).pipe(Effect.result),
      )
      expect(result._tag).toBe("Failure")
    })

  test("a newly pending foreign parent is rechecked after standalone retention and before the body PATCH", async () => {
    const cold = sharedSnapshotFixture({ fileCount: 1 })
    await cold.target(parseTarget(skillPage), selected)
    const snapshot = await authoringRead(cold)
    const bytes = (body: string) =>
      new TextEncoder().encode(
        `---\nname: Managed Name\ndescription: Managed description\n---\n\n${body}\n`,
      )
    const preview = await cold.run(
      withSharedAuthoringTarget(
        skillPage,
        applySharedSkillChanges(snapshot, {
          files: [{ path: "SKILL.md", bytes: bytes("# Concurrent parent intent") }],
          dryRun: true,
        }),
      ),
    )
    if (preview.status !== "planned" || preview.kind !== "skill_apply")
      throw new Error("Expected the independently prepared foreign parent")
    let inserted = false
    cold.clearCalls()
    const action = withSharedAuthoringTarget(
      skillPage,
      withNativeWrites(
        cold,
        writeSharedSkillFile({
          snapshot,
          path: "SKILL.md",
          bytes: bytes("# Standalone intent"),
        }),
        "# Standalone intent",
      ),
    )
    const result = await cold.run(
      withRequestHook(action, (path, body, method, next) => {
        const payload = text(property(property(property(body).properties).payload).rich_text)
        if (
          inserted ||
          path !== "v1/pages" ||
          method !== "POST" ||
          !payload ||
          property(property(JSON.parse(payload)).payload).kind !== "body_write"
        )
          return next()
        return next().pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              inserted = true
              cold.seedFact(
                property(storedSharedOperationPlan(preview.plan)),
                "operation",
                sharedSkillApplyPlansEntity,
                preview.plan.operation_id,
              )
            }),
          ),
        )
      }).pipe(Effect.result),
    )
    expect(inserted).toBe(true)
    expect(failure(result).code).toBe("SHARED_PENDING_OPERATION")
    expect(cold.calls.some((call) => call.method === "PATCH")).toBe(false)
  })

  test("a live Origin/member cannot reuse an acceptance that froze only the unbound Source", async () => {
    const { f, plan, accept } = await pendingSingleBody()
    await f.run(accept())
    const source = sourceFixture().source
    const boundLibrary = {
      ...library,
      sources: sourceLibrary.sources,
      skills: {
        ...library.skills,
        property_ids: {
          ...library.skills.property_ids,
          Origin: "origin",
          "Source Member": "source_member",
        },
      },
    }
    property(f.main.properties).origin = {
      id: "origin",
      type: "relation",
      relation: [{ id: source.id }],
      has_more: false,
    }
    property(f.main.properties).source_member = rich("source_member", "skills/demo")
    const result = await f.run(
      withRequestHook(
        observeAcceptedSingleBodyApply(boundLibrary, plan),
        (path, _body, _method, next) =>
          path === `v1/pages/${source.id}` ? Effect.succeed(structuredClone(source)) : next(),
      ).pipe(Effect.result),
    )
    expect(failure(result).code).toBe("SHARED_CURRENT_ACCEPTANCE_STALE")
  })

  test("one independent child decision cannot release two unresolved parents", async () => {
    const { f, plan, accept } = await pendingSingleBody()
    await f.run(accept())
    const { version: _version, kind: _kind, operation_id: _operation, ...description } = plan
    const second = await f.run(
      makeSharedSkillApplyPlan({
        ...description,
        snapshot_id: `s_${digest("another exact baseline")}`,
      }),
    )
    f.seedFact(
      property(storedSharedOperationPlan(second)),
      "operation",
      sharedSkillApplyPlansEntity,
      second.operation_id,
    )
    expect(await f.run(observeAcceptedSingleBodyApply(library, plan))).toBeUndefined()
    expect((await f.run(read().pipe(Effect.result)))._tag).toBe("Failure")
  })

  for (const which of ["parent", "child"] as const)
    test(`a changed ${which} stored-envelope hash is not replaced by current matching bytes`, async () => {
      const { f, plan, child, accept } = await pendingSingleBody()
      await f.run(accept())
      const operation = which === "parent" ? plan.operation_id : child.operation_id
      const row = [...f.records.values()].find(
        (value) => text(property(property(value.properties).record).rich_text) === operation,
      )!
      property(row.properties).hash = rich("hash", "f".repeat(64))
      f.clearCalls()
      expect((await f.run(read().pipe(Effect.result)))._tag).toBe("Failure")
      expect(f.calls.some((call) => call.method === "PATCH" || call.path === "v1/pages")).toBe(
        false,
      )
    })

  test("ordinary accepted consumption cannot adopt a changed supporting body", async () => {
    const { f, accept } = await pendingSingleBody("event", 2)
    await f.run(accept())
    property(property(f.main.properties).enabled).checkbox = true
    f.bodies.set(f.files[0]!.id, "# Concurrent supporting edit")
    const before = f.records.size
    const cold = coldClient(f)
    const result = await cold.run(
      openSkill(skillPage, { ...selected, refresh: true }).pipe(Effect.result),
    )
    expect(result._tag).toBe("Failure")
    expect(cold.records.size).toBe(before)
    expect(cold.calls.some((call) => call.method === "PATCH" || call.path === "v1/pages")).toBe(
      false,
    )
  })

  test("cold removal and resource authoring retain the unresolved parent gate", async () => {
    const { f, accept } = await pendingSingleBody("event", 2)
    await f.run(accept())
    const cold = coldClient(f)
    const snapshot = await authoringRead(cold)
    const removed = await cold.run(
      withSharedAuthoringTarget(
        skillPage,
        prepareSharedFileManagement({
          library,
          snapshot,
          action: "delete",
          fileId: "file-1",
        }),
      ).pipe(Effect.result),
    )
    expect(failure(removed).code).toBe("SHARED_FILE_MANAGEMENT_PENDING")
    const resource = await cold.run(
      withSharedAuthoringTarget(
        skillPage,
        prepareSharedResourceAuthoring({
          library,
          snapshot,
          action: "add",
          path: "scripts/new.sh",
          bytes: new TextEncoder().encode("#!/bin/sh\nexit 0\n"),
          mode: "100755",
        }),
      ).pipe(Effect.result),
    )
    expect(failure(resource).code).toBe("SHARED_RESOURCE_AUTHORING_PENDING")
    expect(cold.calls.some((call) => call.method === "PATCH" || call.path === "v1/pages")).toBe(
      false,
    )
  })

  test("a current matching body without an independent decision remains blocked", async () => {
    const input = await pendingSingleBody()
    const cold = coldClient(input.f)
    cold.clearCalls()
    expect((await cold.run(read().pipe(Effect.result)))._tag).toBe("Failure")
    expect(cold.calls.some((call) => call.method === "PATCH" || call.path === "v1/pages")).toBe(
      false,
    )
  })

  test("a parent with a metadata child is outside the sole-body exception", async () => {
    const { f, plan, accept } = await pendingSingleBody()
    await f.run(accept())
    const metadata = await f.run(
      withSharedAuthoringTarget(
        skillPage,
        prepareSharedMetadataWrite({
          library,
          skillPageId: skillPage,
          changes: [{ field: "Description", value: "A different description" }],
        }),
      ),
    )
    const { version: _version, kind: _kind, operation_id: _operation, ...description } = plan
    const mixed = await f.run(makeSharedSkillApplyPlan({ ...description, metadata }))
    f.clearCalls()
    expect(await f.run(observeAcceptedSingleBodyApply(library, mixed))).toBeUndefined()
    expect(f.calls).toHaveLength(0)
  })

  for (const field of ["name", "description", "source", "binding"] as const)
    test(`current native ${field} drift invalidates the exact accepted version`, async () => {
      const { f, plan, accept } = await pendingSingleBody()
      await f.run(accept())
      const properties = property(f.main.properties)
      if (field === "name")
        properties.title = { id: "title", type: "title", title: [{ plain_text: "Changed name" }] }
      if (field === "description")
        properties.description = rich("description", "Changed description")
      if (field === "source") properties.source = rich("source", `source-${"a".repeat(64)}`)
      if (field === "binding") properties.main_file_id = rich("main_file_id", "different-main")
      f.clearCalls()
      expect(
        (await f.run(observeAcceptedSingleBodyApply(library, plan).pipe(Effect.result)))._tag,
      ).toBe("Failure")
      expect(f.calls.some((call) => call.method === "PATCH" || call.path === "v1/pages")).toBe(
        false,
      )
    })

  for (const field of ["mode", "frontmatter", "head"] as const)
    test(`accepted bytes cannot hide current ${field} drift`, async () => {
      const input = await pendingSingleBody()
      await input.f.run(input.accept())
      if (field === "head")
        input.f.seedFact(
          {
            ...input.child.event,
            event_id: "later-same-content",
            parents: [input.child.event.event_id],
          },
          "file_event",
          input.child.file_id,
          "later-same-content",
        )
      else
        replaceEvent(input, {
          ...input.child.event,
          content: {
            ...input.child.candidate.content,
            ...(field === "mode"
              ? { mode: "100755" }
              : { frontmatter: "---\nname: Changed\n---\n" }),
          },
        })
      input.f.clearCalls()
      expect((await input.f.run(read().pipe(Effect.result)))._tag).toBe("Failure")
      expect(
        input.f.calls.some((call) => call.method === "PATCH" || call.path === "v1/pages"),
      ).toBe(false)
    })

  test("raw newline drift fails even when normalized body hashes still match", async () => {
    const { f, child, accept } = await pendingSingleBody()
    await f.run(accept())
    const original = f.bodies.get(skillPage)!
    const changed = original.replaceAll("\n", "\r\n")
    expect(digest(normalizeObservedBody(changed))).toBe(child.candidate.content.sha256)
    expect(digest(changed)).not.toBe(digest(original))
    f.bodies.set(skillPage, changed)
    expect(failure(await f.run(read().pipe(Effect.result))).code).toBe(
      "SHARED_CURRENT_ACCEPTANCE_STALE",
    )
  })

  test("the snapshot reuses its one verified body observation without a second GET or adoption", async () => {
    const { f, child, accept } = await pendingSingleBody()
    await f.run(accept())
    const before = f.records.size
    let bodies = 0
    f.clearCalls()
    const snapshot = await f.run(
      withRequestHook(read(), (path, _body, method, next) => {
        if (method !== "GET" || !path.includes("/markdown")) return next()
        bodies++
        return next().pipe(
          Effect.tap(() => Effect.sync(() => f.bodies.set(skillPage, "# Later unaccepted edit"))),
        )
      }),
    )
    expect(bodies).toBe(1)
    const main = snapshot.files.find((file) => file.path === "SKILL.md")!
    expect(new TextDecoder().decode(f.objects.get(`objects/${main.sha256}`))).toContain(
      child.candidate.markdown,
    )
    expect(f.records.size).toBe(before)
    expect(f.calls.some((call) => call.method === "PATCH" || call.path === "v1/pages")).toBe(false)
    expect((await f.run(read().pipe(Effect.result)))._tag).toBe("Failure")
  })

  test("neither a cold Store nor a broader metadata request gains the enable exception", async () => {
    const { f, accept } = await pendingSingleBody()
    await f.run(accept())
    const cold = coldClient(f)
    await authoringRead(cold)
    for (const [client, options] of [
      [cold, { enabled: true }],
      [f, { enabled: true, description: "Unaccepted metadata" }],
    ] as const) {
      client.clearCalls()
      const result = await client.run(
        updateSkill(skillPage, { ...selected, ...options, dryRun: true }).pipe(Effect.result),
      )
      expect(failure(result).code).toBe("SHARED_PENDING_OPERATION")
      expect(client.calls.some((call) => call.method === "PATCH" || call.path === "v1/pages")).toBe(
        false,
      )
    }
  })

  for (const drift of ["body", "third-local", "third-remote"] as const)
    test(`independent enable rechecks ${drift} after retaining its own plan and before PATCH`, async () => {
      const { f, plan: parent, accept } = await pendingSingleBody()
      const originalKeys = pendingKeys(f)
      await f.run(accept())
      const plan = await f.run(
        withSharedAuthoringTarget(
          skillPage,
          prepareSharedMetadataWrite({
            library,
            skillPageId: skillPage,
            changes: [{ field: "Enabled", value: true }],
          }),
        ),
      )
      const other = await f.run(
        withSharedAuthoringTarget(
          skillPage,
          prepareSharedMetadataWrite({
            library,
            skillPageId: skillPage,
            changes: [{ field: "Description", value: "Another pending intent" }],
          }),
        ),
      )
      let checks = 0
      f.clearCalls()
      const result = await f.run(
        withSharedAuthoringTarget(
          skillPage,
          withNativeWrites(
            f,
            executeSharedMetadataWriteWithJournal({
              library,
              plan,
              mode: "create",
              beforeDispatch: () =>
                Effect.gen(function* () {
                  if (++checks !== 2) return
                  if (drift === "body") f.bodies.set(skillPage, "# A concurrent unaccepted edit")
                  if (drift === "third-remote")
                    f.seedFact(other, "operation", sharedMetadataEntity, other.operation_id)
                  if (drift === "third-local")
                    yield* retainPendingFileOperation(
                      {
                        prefix: yield* sharedPendingObservationPrefix(
                          parent.snapshot_scope,
                          library.library_id,
                          parent.skill_id,
                        ),
                        scope: parent.snapshot_scope,
                        library_id: library.library_id,
                        skill_id: parent.skill_id,
                        skill_page_id: skillPage,
                      },
                      other,
                    )
                }),
            }),
          ),
        ).pipe(Effect.result),
      )
      expect(result._tag).toBe("Failure")
      expect(checks).toBe(2)
      expect(f.calls.some((call) => call.method === "PATCH")).toBe(false)
      expect(property(property(f.main.properties).enabled).checkbox).toBe(false)
      expect(originalKeys.every((key) => f.json.has(key))).toBe(true)
      expect(
        payloads(f).some((value) =>
          ["body_write_outcome", "skill_apply_outcome"].includes(String(property(value).kind)),
        ),
      ).toBe(false)
    })

  test("complete child outcomes without a parent completion keep the existing ordinary metadata path", async () => {
    const { f } = await pendingSingleBody("parent-outcome")
    const cold = coldClient(f)
    expect(payloads(cold).some((value) => property(value).kind === "body_write_outcome")).toBe(true)
    expect(payloads(cold).some((value) => property(value).kind === "skill_apply_outcome")).toBe(
      false,
    )
    const result = await cold.run(
      updateSkill(skillPage, {
        ...selected,
        description: "Ordinary metadata update",
        dryRun: true,
      }),
    )
    expect(property(result).action).toBe("planned")
    expect(pendingKeys(cold)).toEqual([])
    expect(cold.calls.some((call) => call.method === "PATCH" || call.path === "v1/pages")).toBe(
      false,
    )
  })
})
