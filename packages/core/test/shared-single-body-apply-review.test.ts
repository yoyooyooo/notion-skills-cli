import { expect, test } from "bun:test"
import { property, text } from "../src/model.ts"
import { writeSharedSkillFile } from "../src/shared-authoring.ts"
import { withSharedAuthoringTarget } from "../src/shared-authoring-context.ts"
import { updateSkill } from "../src/command-operations.ts"
import { openSkill } from "../src/snapshot.ts"
import { Store } from "../src/store.ts"
import { Crypto, Effect } from "effect"
import { reviewSharedBodyWrite } from "../src/shared-body-write-review.ts"
import { prepareSharedMetadataWrite } from "../src/shared-metadata-write.ts"
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
import { rich } from "./shared-snapshot-fixture.ts"

const correction =
  "# Milestone\n\nRead [Skeleton](https://www.notion.so/4135636c236e81918226d828c7b44b39) (`skill://4135636c-236e-8191-8226-d828c7b44b39/SKILL.md`) before implementation.\n"
const nativeCorrection =
  "# Milestone\n\nRead [Skeleton](https://app.notion.com/p/4135636c236e81918226d828c7b44b39) (<code>skill://4135636c-236e-8191-8226-d828c7b44b39/SKILL.md</code>) before implementation."
const completeCorrection = new TextEncoder().encode(
  `---\nname: Managed Name\ndescription: Managed description\n---\n\n${correction}`,
)

function review(input: Awaited<ReturnType<typeof pendingSingleBody>>, dryRun = false) {
  return reviewSharedBodyWrite({
    library,
    skillPageId: skillPage,
    originalOperationId: input.child.operation_id,
    acceptedObservedSha256: digest(input.f.bodies.get(skillPage)!),
    scope: input.plan.snapshot_scope,
    mode: "create",
    dryRun,
  })
}

test("explicit known-observed review can retain a disabled main without enabling or declaring the failed write applied", async () => {
  const original = await pendingSingleBody("known-mismatch")
  const { f, child } = original
  expect(child.candidate.markdown).toContain(
    "](skill://4135636c-236e-8191-8226-d828c7b44b39/SKILL.md)",
  )
  expect(f.bodies.get(skillPage)).not.toContain("skill://")
  expect((await f.run(review(original, true))).status).toBe("planned")
  expect((await f.run(review(original))).decision).toBe("accepted_observed")
  expect(property(property(f.main.properties).enabled).checkbox).toBe(false)
  expect(payloads(f).some((value) => property(value).kind === "skill_apply_outcome")).toBe(false)
  expect(
    payloads(f)
      .filter((value) => property(value).kind === "body_write_outcome")
      .map((value) => property(value).status),
  ).toEqual(["needs_review"])
})

test("a complete sole-main known review supplies a fresh readonly authoring baseline while the original parent stays unresolved", async () => {
  const original = await pendingSingleBody("known-mismatch")
  const { f } = original
  property(property(f.main.properties).enabled).checkbox = true
  await f.run(review(original))
  property(property(f.main.properties).enabled).checkbox = false
  f.clearCalls()
  const snapshot = await authoringRead(f)
  expect(property(snapshot.record.locator).page_id).toBe(skillPage)
  expect(f.calls.some((call) => call.method === "PATCH" || call.path === "v1/pages")).toBe(false)
  expect(payloads(f).some((value) => property(value).kind === "skill_apply_outcome")).toBe(false)
})

test("the original Store can dispatch a new exact-main correction and independently enable it while cold readers retain the known failure history", async () => {
  const original = await pendingSingleBody("known-mismatch")
  const { f, plan, child } = original
  await f.run(review(original))
  const snapshot = await authoringRead(f)
  const write = (dryRun = false) =>
    withSharedAuthoringTarget(
      skillPage,
      writeSharedSkillFile({ snapshot, path: "SKILL.md", bytes: completeCorrection, dryRun }),
    )
  expect((await f.run(write(true))).status).toBe("planned")
  f.clearCalls()
  const written = await f.run(withNativeWrites(f, write(), nativeCorrection))
  expect(written.status).toBe("applied")
  expect(written.operation_id).not.toBe(child.operation_id)
  expect(f.calls.filter((call) => call.method === "PATCH")).toHaveLength(1)
  expect(f.bodies.get(skillPage)).toBe(nativeCorrection)
  expect(pendingKeys(f)).toHaveLength(1)
  expect(
    property(await f.run(updateSkill(skillPage, { ...selected, enabled: true, dryRun: true })))
      .action,
  ).toBe("planned")
  await f.run(withNativeWrites(f, updateSkill(skillPage, { ...selected, enabled: true })))
  const cold = coldClient(f)
  const current = await cold.run(
    openSkill(skillPage, { ...selected, refresh: true, sharedReadOnly: true }),
  )
  const main = current.files.find((file) => file.path === "SKILL.md")!
  const bytes = await cold.run(
    Effect.flatMap(Store, (store) => store.readBytes(`objects/${main.sha256}`)),
  )
  expect(new TextDecoder().decode(bytes)).toContain(nativeCorrection)
  expect(cold.calls.some((call) => call.method === "PATCH" || call.path === "v1/pages")).toBe(false)
  expect(payloads(f).some((value) => property(value).kind === "skill_apply_outcome")).toBe(false)
  expect(
    payloads(f).find(
      (value) =>
        property(value).operation_id === child.operation_id &&
        property(value).kind === "body_write_outcome",
    ),
  ).toMatchObject({ status: "needs_review" })
  expect(
    payloads(f).some(
      (value) =>
        property(value).operation_id === plan.operation_id &&
        property(value).kind === "skill_apply",
    ),
  ).toBe(true)
})

test("review alone neither enables the lost-link version nor gives a cold Store new write authority", async () => {
  const original = await pendingSingleBody("known-mismatch")
  await original.f.run(review(original))
  const cold = coldClient(original.f)
  const snapshot = await authoringRead(cold)
  cold.clearCalls()
  const result = await cold.run(
    withSharedAuthoringTarget(
      skillPage,
      writeSharedSkillFile({ snapshot, path: "SKILL.md", bytes: completeCorrection, dryRun: true }),
    ).pipe(Effect.result),
  )
  expect(failure(result).code).toBe("SHARED_PENDING_OPERATION")
  expect(
    failure(
      await original.f.run(
        updateSkill(skillPage, { ...selected, enabled: true, dryRun: true }).pipe(Effect.result),
      ),
    ).code,
  ).toBe("SHARED_PENDING_OPERATION")
  expect(cold.calls.some((call) => call.method === "PATCH" || call.path === "v1/pages")).toBe(false)
  expect(pendingKeys(cold)).toEqual([])
})

for (const drift of [
  "body",
  "raw-newlines",
  "source",
  "binding",
  "name",
  "description",
  "head",
  "mode",
  "frontmatter",
] as const)
  test(`a reviewed original cannot release current ${drift} drift`, async () => {
    const original = await pendingSingleBody("known-mismatch")
    const { f } = original
    const accepted = await f.run(review(original))
    if (accepted.status !== "reviewed" || accepted.event.kind !== "adopted")
      throw new Error("Expected a complete review")
    const props = property(f.main.properties)
    if (drift === "body") f.bodies.set(skillPage, "# Concurrent unreviewed text")
    if (drift === "raw-newlines")
      f.bodies.set(skillPage, f.bodies.get(skillPage)!.replaceAll("\n", "\r\n"))
    if (drift === "source") props.source = rich("source", `source-${"f".repeat(64)}`)
    if (drift === "binding") props.main_file_id = rich("main_file_id", "another-main")
    if (drift === "name")
      props.title = { id: "title", type: "title", title: [{ plain_text: "Changed name" }] }
    if (drift === "description") props.description = rich("description", "Changed description")
    if (drift === "head")
      f.seedFact(
        { ...accepted.event, event_id: "unproven-later-head", parents: [accepted.event.event_id] },
        "file_event",
        original.child.file_id,
        "unproven-later-head",
      )
    if (drift === "mode" || drift === "frontmatter") {
      for (const [key, row] of f.records)
        if (text(property(property(row.properties).record).rich_text) === accepted.event.event_id)
          f.records.delete(key)
      const changed = {
        ...accepted.event,
        content: {
          ...accepted.event.content,
          ...(drift === "mode"
            ? { mode: "100755" }
            : { frontmatter: "---\nname: Replaced\n---\n" }),
        },
      }
      f.seedFact(
        changed,
        "file_event",
        original.child.file_id,
        accepted.event.event_id,
        accepted.operation_id,
      )
    }
    f.clearCalls()
    await expect(authoringRead(f)).rejects.toMatchObject({ _tag: "SkillsError" })
    expect(f.calls.some((call) => call.method === "PATCH" || call.path === "v1/pages")).toBe(false)
  })

for (const drift of ["body", "third-local", "third-remote"] as const)
  test(`a new correction rechecks ${drift} after its own plan is retained and before PATCH`, async () => {
    const original = await pendingSingleBody("known-mismatch")
    const { f, plan } = original
    await f.run(review(original))
    const snapshot = await authoringRead(f)
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
    let inserted = false
    const store = await f.run(Store),
      crypto = await f.run(Crypto.Crypto)
    f.clearCalls()
    const action = withSharedAuthoringTarget(
      skillPage,
      withNativeWrites(
        f,
        writeSharedSkillFile({ snapshot, path: "SKILL.md", bytes: completeCorrection }),
        nativeCorrection,
      ),
    )
    const result = await f.run(
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
            Effect.gen(function* () {
              inserted = true
              if (drift === "body")
                f.bodies.set(skillPage, "# New text during correction retention")
              if (drift === "third-remote")
                f.seedFact(other, "operation", sharedMetadataEntity, other.operation_id)
              if (drift === "third-local")
                yield* retainPendingFileOperation(
                  {
                    prefix: yield* sharedPendingObservationPrefix(
                      plan.snapshot_scope,
                      library.library_id,
                      plan.skill_id,
                    ),
                    scope: plan.snapshot_scope,
                    library_id: library.library_id,
                    skill_id: plan.skill_id,
                    skill_page_id: skillPage,
                  },
                  other,
                )
            }).pipe(
              Effect.provideService(Store, store),
              Effect.provideService(Crypto.Crypto, crypto),
            ),
          ),
        )
      }).pipe(Effect.result),
    )
    expect(inserted).toBe(true)
    expect(result._tag).toBe("Failure")
    expect(f.calls.some((call) => call.method === "PATCH")).toBe(false)
    expect(payloads(f).some((value) => property(value).kind === "skill_apply_outcome")).toBe(false)
  })

test("an unknown new correction never inherits the known original review or retries the body", async () => {
  const original = await pendingSingleBody("known-mismatch")
  const { f } = original
  await f.run(review(original))
  const snapshot = await authoringRead(f)
  const write = () =>
    withSharedAuthoringTarget(
      skillPage,
      withNativeWrites(
        f,
        writeSharedSkillFile({ snapshot, path: "SKILL.md", bytes: completeCorrection }),
        nativeCorrection,
      ),
    )
  f.unknownEvent()
  f.clearCalls()
  expect(failure(await f.run(write().pipe(Effect.result))).code).toBe("WRITE_OUTCOME_UNKNOWN")
  expect(f.calls.filter((call) => call.method === "PATCH")).toHaveLength(1)
  f.clearCalls()
  await expect(authoringRead(f)).rejects.toMatchObject({ code: "SHARED_BODY_WRITE_UNRESOLVED" })
  expect((await f.run(write().pipe(Effect.result)))._tag).toBe("Failure")
  expect(
    (
      await f.run(
        updateSkill(skillPage, { ...selected, enabled: true, dryRun: true }).pipe(Effect.result),
      )
    )._tag,
  ).toBe("Failure")
  expect(f.calls.some((call) => call.method === "PATCH")).toBe(false)
  expect(
    payloads(f)
      .filter((value) => property(value).kind === "body_write_outcome")
      .map((value) => property(value).status),
  ).toEqual(["needs_review"])
  expect(payloads(f).some((value) => property(value).kind === "skill_apply_outcome")).toBe(false)
})
