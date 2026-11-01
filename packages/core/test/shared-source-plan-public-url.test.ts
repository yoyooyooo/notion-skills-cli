import { expect, test } from "bun:test"
import { SkillsError } from "../src/model.ts"
import { validateSharedSourcePlan } from "../src/shared-source-plan.ts"

test("shared initial retrieval addresses exclude query credentials; signed URLs stay in machine overrides", () => {
  let caught: unknown
  try {
    validateSharedSourcePlan({
      version: 1,
      kind: "composition",
      base: {
        kind: "http",
        manifest: { version: 1, files: [{ path: "file.bin", sha256: "1".repeat(64), bytes: 4 }] },
        locations: [
          {
            sha256: "1".repeat(64),
            url: "https://resources.example.com/file?signature=private-value",
          },
        ],
      },
      mounts: [],
    })
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(SkillsError)
  if (!(caught instanceof SkillsError))
    throw new Error("Expected an explicit shared URL validation failure")
  expect(caught.code).toBe("INVALID_SOURCE_PLAN")
  expect(JSON.stringify(caught)).not.toContain("private-value")
})
