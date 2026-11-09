import { expect, test } from "bun:test"
import { Context, Option } from "effect"
import {
  commandSchema,
  Constraints,
  enforceConstraint,
  selectCommand,
} from "../../core/src/command-schema.ts"
import { property } from "../../core/src/model.ts"
import { libraryCommand } from "../src/commands-library.ts"

function reviewCommand() {
  const selected = selectCommand(libraryCommand, ["file", "review"])
  if (selected === undefined)
    throw new Error("The public library file review command is not registered")
  return selected
}

test("public file review exposes exact original-operation and singleton acceptance parameters with explicit help", () => {
  const schema = property(commandSchema(reviewCommand()))
  expect(schema.name).toBe("review")
  expect(schema.parameters).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "target",
        required: true,
        min_occurrences: 1,
        max_occurrences: 1,
      }),
      expect.objectContaining({
        name: "original-operation",
        required: true,
        min_occurrences: 1,
        max_occurrences: 1,
      }),
      expect.objectContaining({
        name: "entry",
        required: true,
        min_occurrences: 1,
        max_occurrences: 1,
      }),
      expect.objectContaining({
        name: "accept-observed-sha256",
        required: true,
        min_occurrences: 1,
        max_occurrences: 1,
      }),
      expect.objectContaining({
        name: "dry-run",
        required: false,
        min_occurrences: 0,
        max_occurrences: 1,
        default: false,
      }),
      expect.objectContaining({
        name: "reconcile",
        required: false,
        min_occurrences: 0,
        max_occurrences: 1,
        default: false,
      }),
    ]),
  )
  const help = JSON.stringify(schema.description)
  expect(help).toContain("needs_review")
  expect(help).toContain("accepted_observed")
  expect(help).toContain("--accept-observed-sha256")
  expect(help).toContain("main or a supporting file")
  expect(help).toContain("frozen native mode and complete frontmatter")
  expect(help).toContain("Existing version 1 review facts")
})

test("public review declares and enforces mutually exclusive dry-run and reconcile intent", () => {
  const constraints = Context.getOption(reviewCommand().annotations, Constraints).pipe(
    Option.getOrElse(() => []),
  )
  const constraint = constraints.find((item) => item.kind === "mutually_exclusive")
  if (constraint === undefined)
    throw new Error("The public review is missing its declared conflict constraint")
  expect(constraint).toEqual({ kind: "mutually_exclusive", flags: ["dryRun", "reconcile"] })
  expect(enforceConstraint(constraint, { dryRun: false, reconcile: false })).toBe(true)
  expect(enforceConstraint(constraint, { dryRun: true, reconcile: false })).toBe(true)
  expect(enforceConstraint(constraint, { dryRun: false, reconcile: true })).toBe(true)
  expect(enforceConstraint(constraint, { dryRun: true, reconcile: true })).toBe(false)
})
