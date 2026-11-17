import { expect, test } from "bun:test"
import { commandSchema, selectCommand } from "../../core/src/command-schema.ts"
import { property } from "../../core/src/model.ts"
import { libraryCommand } from "../src/commands-library.ts"

test("formal file takeover exposes explicit complete-input initialization of the existing Git main", () => {
  const selected = selectCommand(libraryCommand, ["file", "takeover"])
  if (!selected) throw new Error("Missing formal takeover command")
  const schema = property(commandSchema(selected))
  expect(schema.parameters).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "input", required: false, max_occurrences: 1 }),
      expect.objectContaining({ name: "header-input", required: false, max_occurrences: 1 }),
    ]),
  )
  expect(JSON.stringify(schema.description)).toContain("Git-only")
  expect(JSON.stringify(schema.description)).toContain("frontmatter")
  expect(JSON.stringify(schema.description)).toContain("no body or property PATCH")
})
