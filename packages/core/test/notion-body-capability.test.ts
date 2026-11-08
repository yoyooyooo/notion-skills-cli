import { expect, test } from "bun:test"
import { SkillsError, property } from "../src/model.ts"
import { notionWriteCapabilities, requireSafeBodyReplacement } from "../src/shared-file-state.ts"

test("editable-page overwrite exposes a machine-readable unsupported capability", () => {
  expect(notionWriteCapabilities.conditional_body_replace).toBe(false)
  expect(notionWriteCapabilities.editable_projection_overwrite).toEqual({
    kind: "unsupported",
    provider: "notion",
    operation: "overwrite_editable_projection",
    reason: "atomic_content_precondition_unavailable",
    editing_isolation: "unverified",
    preparation_allowed: true,
    automatic_retry: false,
    content_match_is_revision_cas: false,
    ui_lock_blocks_api_writers: false,
  })
})

test.each([
  "manual_confirmation",
  "unchanged_timestamp",
  "single_local_writer",
  "ui_locked",
  "shared_running_field",
])("%s cannot authorize an existing editable projection overwrite", (observation) => {
  const input = {
    existing_editable_page: true,
    operation_id: "original-operation",
    retained_candidate_id: "frozen-candidate",
    observation,
  }
  let sent = false
  try {
    requireSafeBodyReplacement(input)
    sent = true
    throw new Error("The guard allowed an unsupported overwrite")
  } catch (error) {
    expect(error).toBeInstanceOf(SkillsError)
    if (!(error instanceof SkillsError)) throw error
    expect(error.code).toBe("BODY_REPLACEMENT_UNSAFE")
    expect(property(error.details).operation_id).toBe("original-operation")
    expect(property(error.details).candidate_id).toBe("frozen-candidate")
    expect(property(property(error.details).capability).kind).toBe("unsupported")
    expect(sent).toBe(false)
  }
})
