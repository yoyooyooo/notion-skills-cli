import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { property } from "../src/model.ts"
import { openSkill } from "../src/snapshot.ts"
import { showSharedMaintenanceOperation } from "../src/shared-maintenance-operations.ts"
import { resumeSharedSkillApply } from "../src/shared-skill-apply.ts"
import { updateSkill } from "../src/command-operations.ts"
import { writeSharedSkillFile } from "../src/shared-authoring.ts"
import { withSharedAuthoringTarget } from "../src/shared-authoring-context.ts"
import { prepareSharedFileManagement } from "../src/shared-file-management.ts"
import {
  authoringRead,
  coldClient,
  failure,
  library,
  payloads,
  pendingKeys,
  pendingSingleBody,
  selected,
  skillPage,
  withNativeWrites,
} from "./shared-single-body-apply-acceptance-fixture.ts"

describe("independently accepted sole-body parent consumption", () => {
  test("a cold Store can read the accepted main but cannot start another standalone body write", async () => {
    const { f, accept } = await pendingSingleBody()
    await f.run(accept())
    const cold = coldClient(f)
    expect(cold.json.size).toBe(0)
    expect(cold.objects.size).toBe(0)
    const snapshot = await authoringRead(cold)
    expect(property(snapshot.record.locator).page_id).toBe(skillPage)
    expect(pendingKeys(cold)).toEqual([])
    cold.clearCalls()
    const result = await cold.run(
      withSharedAuthoringTarget(
        skillPage,
        writeSharedSkillFile({
          snapshot,
          path: "SKILL.md",
          bytes: new TextEncoder().encode(
            "---\nname: Managed Name\ndescription: Managed description\n---\n\n# New body\n",
          ),
          dryRun: true,
        }),
      ).pipe(Effect.result),
    )
    expect(failure(result).code).toBe("SHARED_PENDING_OPERATION")
    expect(cold.calls.some((call) => call.method === "PATCH" || call.path === "v1/pages")).toBe(
      false,
    )
    expect(pendingKeys(cold)).toEqual([])
  })

  test("a cold Store cannot use the readable accepted main to prepare a new file lifecycle", async () => {
    const { f, accept } = await pendingSingleBody()
    await f.run(accept())
    const cold = coldClient(f)
    const snapshot = await authoringRead(cold)
    cold.clearCalls()
    const result = await cold.run(
      withSharedAuthoringTarget(
        skillPage,
        prepareSharedFileManagement({
          library,
          snapshot,
          action: "add",
          path: "references/new.md",
          markdown: "# New supporting file\n",
        }),
      ).pipe(Effect.result),
    )
    expect(failure(result).code).toBe("SHARED_FILE_MANAGEMENT_PENDING")
    expect(cold.calls.some((call) => call.method === "PATCH" || call.path === "v1/pages")).toBe(
      false,
    )
  })

  test("only a separate Enabled false-to-true update can cross the retained exact pair", async () => {
    const { f, accept } = await pendingSingleBody()
    const originalPending = pendingKeys(f)
    await f.run(accept())
    const preview = await f.run(
      updateSkill(skillPage, { ...selected, enabled: true, dryRun: true }),
    )
    expect(property(preview).action).toBe("planned")
    expect(property(property(f.main.properties).enabled).checkbox).toBe(false)
    f.clearCalls()
    const result = await f.run(
      withNativeWrites(f, updateSkill(skillPage, { ...selected, enabled: true })),
    )
    expect(property(result).action).toBe("updated")
    expect(result.verified).toBe(true)
    expect(f.calls.filter((call) => call.method === "PATCH").map((call) => call.path)).toEqual([
      `v1/pages/${skillPage}`,
    ])
    expect(pendingKeys(f)).toEqual(originalPending)
    const current = await f.run(
      openSkill(skillPage, { ...selected, refresh: true, sharedReadOnly: true }),
    )
    expect(property(current.record).enabled).toBe(true)
    expect(
      payloads(f).some((value) =>
        ["body_write_outcome", "skill_apply_outcome"].includes(String(property(value).kind)),
      ),
    ).toBe(false)
  })

  test("a disabled authoring read uses the accepted version while original parent and child stay unknown", async () => {
    const { f, plan, child, accept } = await pendingSingleBody()
    const originalPending = pendingKeys(f)
    expect(originalPending).toHaveLength(2)
    expect((await f.run(accept())).decision).toBe("accepted_current")
    expect(
      failure(
        await f.run(
          openSkill(skillPage, { ...selected, refresh: true, sharedReadOnly: true }).pipe(
            Effect.result,
          ),
        ),
      ).code,
    ).toBe("CONTENT_DISABLED")
    f.clearCalls()
    const current = await authoringRead(f)
    expect(property(current.record.locator).page_id).toBe(skillPage)
    expect(property(current.record).enabled).toBe(false)
    expect(pendingKeys(f)).toEqual(originalPending)
    expect(
      payloads(f).some((value) =>
        ["body_write_outcome", "skill_apply_outcome"].includes(String(property(value).kind)),
      ),
    ).toBe(false)
    const shown = await f.run(showSharedMaintenanceOperation({ operationId: plan.operation_id }))
    expect(shown.progress?.completion).toBe("unknown")
    expect(shown.resume_supported).toBe(false)
    expect((await f.run(resumeSharedSkillApply(library, plan).pipe(Effect.result)))._tag).toBe(
      "Failure",
    )
    expect(f.calls.some((call) => call.method === "PATCH" || call.path === "v1/pages")).toBe(false)
    expect(f.bodies.get(skillPage)).toBe(child.candidate.markdown)
  })
})
