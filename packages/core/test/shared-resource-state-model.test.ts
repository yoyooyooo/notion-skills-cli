import { expect, test } from "bun:test"
import type { FileEvent } from "../src/shared-file-state.ts"
import { describeSharedResourceFile } from "../src/shared-resource-state-model.ts"

const c1 = "1".repeat(40)
const c2 = "2".repeat(40)
const original = "a".repeat(64)
const custom = "b".repeat(64)
const binding = {
  file_id: "reference",
  page_id: "00000000-0000-4000-8000-000000000001",
  skill_page_id: "00000000-0000-4000-8000-000000000002",
  path: "references/guide.md",
  last_edited_time: "2026-11-08T01:00:00Z",
}
const projected = {
  event_id: "project-c1",
  file_id: binding.file_id,
  parents: [],
  kind: "projected",
  source_revision: c1,
  projection: { normalization_version: 1, sha256: original },
} satisfies FileEvent
const adopted = {
  event_id: "adopt-n1",
  file_id: binding.file_id,
  parents: [projected.event_id],
  kind: "adopted",
  content: { object_id: "n1", sha256: custom, bytes: 12 },
} satisfies FileEvent

test("custom ancestry remains C1 while current selection is C2 and display is not observed", () => {
  const value = describeSharedResourceFile({
    binding,
    events: [adopted, projected],
    selectedRevision: c2,
    observation: { kind: "unobserved" },
  })
  expect(value.customization).toMatchObject({ kind: "custom", based_on: { source_revision: c1 } })
  expect(value.display).toMatchObject({
    recorded: { source_revision: c1 },
    selected_comparison: "different_revision",
    observation: { kind: "unobserved" },
  })
  expect(value.resolution).toMatchObject({
    ownership: { kind: "custom", content: adopted.content },
  })
})

test("current body drift is reported without changing its recorded ownership", () => {
  const value = describeSharedResourceFile({
    binding,
    events: [projected],
    selectedRevision: c1,
    observation: {
      kind: "observed",
      body: {
        page_id: binding.page_id,
        markdown: "changed",
        bytes: 7,
        downloaded_at: 1,
        fingerprint: { normalization_version: 1, sha256: custom },
      },
    },
  })
  expect(value.display.observation).toMatchObject({
    kind: "observed",
    projection_comparison: "differs_from_recorded_projection",
    ownership_comparison: "requires_observation_commit",
  })
  expect(value.resolution).toMatchObject({ ownership: { kind: "following", source_revision: c1 } })
})

test("a timestamp or projection-property mirror cannot create missing ownership or ancestry", () => {
  const value = describeSharedResourceFile({
    binding: { ...binding, baseline: { ...projected.projection, source_revision: c2 } },
    events: [],
    selectedRevision: c2,
    observation: { kind: "unobserved" },
  })
  expect(value.resolution).toEqual({ kind: "uninitialized" })
  expect(value.customization).toEqual({ kind: "unknown" })
  expect(value.display.recorded.kind).toBe("unknown")
  expect(value.display.projection_property).toMatchObject({ kind: "recorded", source_revision: c2 })
  expect(value.display.selected_comparison).toBe("unknown")
})

test("repeated native edits retain the original projected base, even after body returns to C1", () => {
  const next: FileEvent = {
    ...adopted,
    event_id: "adopt-n2",
    parents: [adopted.event_id],
    content: { object_id: "n2", sha256: original, bytes: 15 },
  }
  const value = describeSharedResourceFile({
    binding,
    events: [projected, adopted, next],
    selectedRevision: c2,
    observation: { kind: "unobserved" },
  })
  expect(value.customization).toMatchObject({ kind: "custom", based_on: { source_revision: c1 } })
})

test("equivalent custom heads with different projected ancestors preserve both possible bases", () => {
  const otherBase: FileEvent = { ...projected, event_id: "project-c2", source_revision: c2 }
  const otherCustom: FileEvent = { ...adopted, event_id: "same-n1", parents: [otherBase.event_id] }
  const value = describeSharedResourceFile({
    binding,
    events: [projected, adopted, otherBase, otherCustom],
    selectedRevision: c2,
    observation: { kind: "unobserved" },
  })
  expect(value.display.recorded).toMatchObject({ kind: "ambiguous" })
  expect(value.customization).toMatchObject({ kind: "custom", based_on: { kind: "ambiguous" } })
})

test.each(["parallel", "merged"] as const)(
  "%s equal custom branches cannot borrow missing projection ancestry",
  (shape) => {
    const nativeRoot: FileEvent = { ...adopted, event_id: "native-n1", parents: [] }
    const merged: FileEvent = {
      ...adopted,
      event_id: "merged-n1",
      parents: [adopted.event_id, nativeRoot.event_id],
    }
    const value = describeSharedResourceFile({
      binding,
      events: [projected, adopted, nativeRoot, ...(shape === "merged" ? [merged] : [])],
      selectedRevision: c1,
      observation: { kind: "unobserved" },
    })
    expect(value.resolution).toMatchObject({
      ownership: { kind: "custom", content: adopted.content },
    })
    expect(value.customization).toMatchObject({
      kind: "custom",
      based_on: {
        kind: "unknown",
        reason: "incomplete_projection_ancestry",
        unknown_root_event_ids: [nativeRoot.event_id],
        candidates: [{ event_id: projected.event_id, source_revision: c1 }],
      },
    })
    expect(value.display.recorded.kind).toBe("unknown")
    expect(value.display.selected_comparison).toBe("unknown")
  },
)

test("conflicting owners still fail instead of selecting a projection or timestamp winner", () => {
  const competing: FileEvent = {
    ...adopted,
    event_id: "other",
    content: { ...adopted.content, sha256: original },
  }
  expect(() =>
    describeSharedResourceFile({
      binding,
      events: [projected, adopted, competing],
      selectedRevision: c2,
      observation: { kind: "unobserved" },
    }),
  ).toThrow("Concurrent file changes")
})

test("inaccessible current body remains unknown rather than deleted or equal to the baseline", () => {
  const value = describeSharedResourceFile({
    binding,
    events: [projected],
    selectedRevision: c1,
    observation: { kind: "unavailable", access: "unknown", code: "NOT_FOUND" },
  })
  expect(value.display.observation).toEqual({
    kind: "unavailable",
    access: "unknown",
    code: "NOT_FOUND",
  })
  expect(value.resolution).toMatchObject({ ownership: { kind: "following" } })
})
