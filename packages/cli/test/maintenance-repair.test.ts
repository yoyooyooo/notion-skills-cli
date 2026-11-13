import { describe, expect, test } from "bun:test"
import { commandSchema } from "../../core/src/command-schema.ts"
import { recognizeRepairOperation } from "../../core/src/shared-native-repair.ts"
import { repairCommand } from "../src/commands-maintenance-repair.ts"

describe("maintenance repair command", () => {
  test("schema exposes plan, apply, show and reconcile without a handwritten record", () => {
    const schema = commandSchema(repairCommand) as {
      name: string
      commands: { name: string; parameters: { name: string; required?: boolean }[] }[]
    }
    expect(schema.name).toBe("repair")
    const names = schema.commands.map((command) => command.name).sort()
    expect(names).toEqual(["apply", "plan", "reconcile", "show"])
    const plan = schema.commands.find((command) => command.name === "plan")
    expect(plan?.parameters.map((parameter) => parameter.name).sort()).toEqual([
      "database",
      "dry-run",
      "entry",
      "owner",
      "page",
      "path",
    ])
    const apply = schema.commands.find((command) => command.name === "apply")
    const input = apply?.parameters.find((parameter) => parameter.name === "input")
    expect(input?.required).toBe(false)
    expect(apply?.parameters.find((parameter) => parameter.name === "operation")?.required).toBe(
      true,
    )
    expect(recognizeRepairOperation(`skill-repair-main-${"ab".repeat(32)}`)?.family).toBe(
      "maintenance-repair",
    )
    expect(recognizeRepairOperation("skill-create-" + "ab".repeat(32))).toBeUndefined()
  })
})
