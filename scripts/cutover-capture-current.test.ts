import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { parseArguments, validateSelection, verifyCapturedBody } from "./cutover-capture-current.ts"

const page = "41c5636c-236e-81cb-88ab-d54a7d55fc54"
const selected = {
  page_id: page,
  owner_page_id: page,
  file_id: "main",
  path: "SKILL.md",
  reason: "native",
}
describe("one-time current-body capture admission", () => {
  test("rejects a duplicate physical page before any transport", () => {
    expect(() => validateSelection([selected, { ...selected, reason: "other" }])).toThrow(
      "repeats a physical page",
    )
  })
  test("keeps explicitly missing main identity without fabricating one", () => {
    expect(validateSelection([{ ...selected, file_id: null }])[0]?.file_id).toBeNull()
  })
  test("rejects a tampered checkpoint body even when its size still matches", () => {
    const bytes = Buffer.from("current\n")
    const capture = {
      page_id: page,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      observed_at: 123,
      alias_completion: false,
    }
    expect(verifyCapturedBody(capture, bytes).sha256).toBe(capture.sha256)
    expect(() => verifyCapturedBody(capture, Buffer.from("changed\n"))).toThrow(
      "differs from its recorded",
    )
    expect(() => verifyCapturedBody({ ...capture, bytes: bytes.length + 1 }, bytes)).toThrow(
      "differs from its recorded",
    )
  })
  test("requires explicit total budgets and absolute paths", () => {
    const args = [
      "--selection",
      "/tmp/selection.json",
      "--output",
      "/tmp/pages",
      "--max-requests",
      "500",
      "--max-bytes",
      "50000000",
      "--timeout",
      "600000",
    ]
    expect(parseArguments(args).limits.requests).toBe(500)
    expect(() => parseArguments(args.slice(0, -2))).toThrow("--timeout")
    expect(() => parseArguments([...args, "--max-requests", "900"])).toThrow("exactly once")
  })
})
