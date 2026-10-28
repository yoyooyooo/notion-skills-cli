import { expect, test } from "bun:test"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect } from "effect"
import type { Snapshot } from "../src/model.ts"
import { canonicalMain, type PortableSkill } from "../src/portable.ts"
import { referencePagesMatch } from "../src/reference-mutation.ts"

const root = "11111111-1111-4111-8111-111111111111"
const child = "22222222-2222-4222-8222-222222222222"
const name = "Final comparison diagnostics",
  description = "Identify the actual failing authored page."
const body = "# Instructions\n\nKeep the complete instructions.\n"
const guide = "# Guide\n\nKeep the complete reference.\n"
const portable: PortableSkill = {
  kind: "skill",
  name,
  description,
  main: "SKILL.md",
  files: [
    canonicalMain(name, description, body, { path: "SKILL.md", bytes: new Uint8Array() }),
    { path: "references/guide.md", bytes: new TextEncoder().encode(guide) },
  ],
}
const snapshot: Snapshot = {
  snapshot_id: "s_final_diagnostic",
  scope: "test",
  version_id: "test",
  created_at: 0,
  entrypoint: "SKILL.md",
  files: [],
  record: {
    id: `notion_page:${root}`,
    kind: "skill",
    name,
    description,
    alias: "final-diagnostic",
    locator: { type: "notion_page", page_id: root, database_id: "db", data_source_id: "ds" },
    default_context: false,
    entrypoint: "SKILL.md",
    ref: `skill://${root}/SKILL.md`,
  },
  references: [
    { id: root, path: "SKILL.md", markdown: body },
    { id: child, path: "references/guide.md", markdown: guide },
  ],
}

for (const [path, id] of [
  ["SKILL.md", root],
  ["references/guide.md", child],
]) {
  test(`final comparison identifies ${path} without relabeling the bundle entrypoint`, async () => {
    const changed: Snapshot = {
      ...snapshot,
      references: snapshot.references!.map((page) =>
        page.path === path
          ? { ...page, markdown: `${page.markdown}\nUnrequested extra instructions.\n` }
          : page,
      ),
    }
    const before = JSON.stringify(changed)
    const result = await Effect.runPromise(
      referencePagesMatch(changed, portable).pipe(
        Effect.provide(NodeServices.layer),
        Effect.result,
      ),
    )
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") throw new Error("Changed authored content must still fail")
    expect(result.failure.code).toBe("WRITE_VERIFICATION_FAILED")
    expect(result.failure.details).toMatchObject({ page_id: id, path, main: "SKILL.md" })
    expect(JSON.stringify(changed)).toBe(before)
  })
}
