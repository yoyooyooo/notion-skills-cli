import { expect, test } from "bun:test"
import { Effect } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { discoverLinearSource, sourceDiscoveryInput } from "../src/shared-source-adapters.ts"
import { validateSourceDefinition } from "../src/shared-source-definitions.ts"
import type { SourceDefinitionInput } from "../src/shared-sources-model.ts"
const input: SourceDefinitionInput = {
  version: 1,
  source_id: "linear-case",
  name: "linear-review",
  description: "Read the attached checklist.",
  enabled: true,
  policy: "manual",
  adapter: {
    type: "linear",
    resources: [
      { kind: "issue", id: "TEST-1", path: "SKILL.md" },
      {
        kind: "document",
        id: "00000000-0000-4000-8000-000000000002",
        path: "references/checklist.md",
      },
    ],
  },
  selection: { roots: ["."], include: [], exclude: [], mapping: {} },
  options: {},
}
const run = <A, E, R>(e: Effect.Effect<A, E, R>) =>
  Effect.runPromise(e.pipe(Effect.provide(NodeServices.layer)) as Effect.Effect<A, E, never>)
test("Linear exact issue/document mappings produce complete portable resources and a content revision", async () => {
  const calls: string[] = []
  const result = await run(
    discoverLinearSource(input, (query, args) => {
      calls.push(query)
      const issue = args.id === "TEST-1"
      return Effect.succeed({
        data: {
          [issue ? "issue" : "document"]: {
            id: issue ? "00000000-0000-4000-8000-000000000001" : args.id,
            ...(issue ? { identifier: args.id } : {}),
            title: issue ? "Review" : "Checklist",
            [issue ? "description" : "content"]: issue
              ? "# Review\n\nRead [checklist](references/checklist.md).\n"
              : "# Checklist\n\nVerify rollback.\n",
            updatedAt: "2026-11-02T00:00:00Z",
          },
        },
      })
    }),
  )
  expect(calls).toHaveLength(2)
  expect(calls.every((x) => x.startsWith("query "))).toBe(true)
  expect(result.revision).toMatch(/^linear-[a-f0-9]{64}$/)
  expect(result.members[0]!.portable.files.map((f) => f.path)).toEqual([
    "SKILL.md",
    "references/checklist.md",
  ])
  expect(new TextDecoder().decode(result.members[0]!.portable.files[0]!.bytes)).toContain(
    "linear-review",
  )
})
test("GraphQL HTTP-success with partial errors fails instead of importing partial content", async () => {
  await expect(
    run(
      discoverLinearSource(input, () =>
        Effect.succeed({ errors: [{ message: "not authorized" }], data: { issue: { id: "x" } } }),
      ),
    ),
  ).rejects.toThrow("partial content")
})
test("missing resource content or wrong document identity fails closed", async () => {
  await expect(
    run(
      discoverLinearSource(input, () =>
        Effect.succeed({
          data: {
            issue: { id: "x", title: "x", description: null, updatedAt: "2026-11-02T00:00:00Z" },
            document: { id: "other", title: "x", content: "x", updatedAt: "2026-11-02T00:00:00Z" },
          },
        }),
      ),
    ),
  ).rejects.toThrow()
})
test("Linear cannot pretend to be a pinned server-side revision or execute arbitrary transforms", () => {
  expect(() => validateSourceDefinition({ ...input, policy: "pinned" })).toThrow("freeze")
  expect(() =>
    validateSourceDefinition({
      ...input,
      adapter: { type: "linear", resources: [{ kind: "issue", id: "TEST-1", path: "../outside" }] },
    }),
  ).toThrow()
})
test("GitLab discovery uses generic Git selection and preserves explicit patches", () => {
  const git = {
    ...input,
    adapter: {
      type: "git" as const,
      url: "https://gitlab.example.org/group/skills.git",
      ref: "main",
    },
    options: {
      patch: { version: 1, files: [{ path: "SKILL.md", replacements: [{ from: "a", to: "b" }] }] },
    },
  }
  expect(sourceDiscoveryInput(git)).toMatchObject({
    source: git.adapter,
    patch: git.options.patch,
    roots: ["."],
  })
})
test("unimplemented provider options fail explicitly rather than weakening existing selection", () => {
  expect(() =>
    sourceDiscoveryInput({
      ...input,
      adapter: { type: "git", url: "https://github.com/org/repo.git", ref: "main" },
      options: { external_assets: true },
    }),
  ).toThrow("explicit Markdown paths")
})

test("live Source observation fields are not passed to the strict provider configuration schema", () => {
  const observed = {
    ...input,
    adapter: { type: "git" as const, url: "https://gitlab.com/group/skills.git", ref: "main" },
    page_id: "00000000-0000-4000-8000-000000000010",
    fingerprint: "a".repeat(64),
    status: "ready",
    last_revision: "",
  }
  expect(sourceDiscoveryInput(observed).source).toEqual(observed.adapter)
  expect(() =>
    sourceDiscoveryInput({ ...observed, unexpected_configuration: true } as typeof observed),
  ).toThrow()
})
