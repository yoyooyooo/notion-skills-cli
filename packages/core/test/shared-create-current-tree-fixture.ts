import assert from "node:assert/strict"
import { Effect } from "effect"
import { property } from "../src/model.ts"
import { makeSharedCreatePlan } from "../src/shared-create-model.ts"
import { executeSharedCreate } from "../src/shared-create.ts"
import { canonicalSharedJson, querySharedRecords } from "../src/shared-records.ts"
import { sharedCreateFixture } from "./shared-create-fixture.ts"

const encode = (value: string) => new TextEncoder().encode(value)
export const currentTreePortable = () => ({
  kind: "skill" as const,
  name: "Complete legacy tree",
  description: "Accept an observed tree without inventing its old acknowledgement",
  main: "SKILL.md",
  files: [
    {
      path: "SKILL.md",
      mode: "100644" as const,
      bytes: encode(
        "---\nname: Complete legacy tree\ndescription: Accept an observed tree without inventing its old acknowledgement\nlicense: MIT\nuser-invokable: false\nmetadata:\n  version: 7\n---\n# Main\n\nKeep [reference](references/guide.md), `exact code` and all raw resources.\n",
      ),
    },
    {
      path: "references/guide.md",
      mode: "100644" as const,
      bytes: encode(
        "# Guide\n\nKeep [destination](https://example.test/original?q=1#part) and `a + b`.\n",
      ),
    },
    {
      path: "agents/openai.yaml",
      mode: "100644" as const,
      bytes: encode("display_name: Example\n"),
    },
    {
      path: "scripts/smoke.sh",
      mode: "100755" as const,
      bytes: encode("#!/bin/sh\n# Never execute this fixture.\nprintf 'retained\\n'\n"),
    },
  ],
})
export async function failedCurrentTreeOriginal() {
  const f = sharedCreateFixture({
    readback: (wire) =>
      wire
        .replace(/^<h1>([^\n]*)<\/h1>/u, "# $1")
        .replace(/`([^`]+)`/gu, "<code>$1</code>")
        .replace(/^# scripts\/smoke.sh/u, "# scripts/[smoke.sh](http://smoke.sh)"),
  })
  f.onCreate((row, kind) => {
    if (kind === "file" && f.base.bodies.get(String(row.id))?.startsWith("# scripts/"))
      f.base.bodies.set(
        String(row.id),
        f.base.bodies.get(String(row.id)) + "\nUnreviewed extra note",
      )
  })
  const plan = await f.run(
    makeSharedCreatePlan(
      f.library,
      { portable: currentTreePortable(), enabled: false, completeResources: true },
      13,
    ),
  )
  const error = await f.run(Effect.flip(executeSharedCreate(f.library, { plan, mode: "create" })))
  assert.equal(error.code, "SHARED_CREATE_BODY_MISMATCH", JSON.stringify(error))
  const page = String(property(error.details).skill_page_id)
  const rows = await f.run(
    querySharedRecords(f.library, {
      skillPageId: page,
      kind: "operation",
      recordId: "outcome-" + plan.operation_id,
    }),
  )
  assert.equal(property(rows[0]?.payload).status, "needs_review", JSON.stringify(error))
  assert.equal((property(rows[0]?.payload).bindings as unknown[]).length, 4)
  const originalFailure = canonicalSharedJson(rows[0])
  for (const [id, body] of f.base.bodies)
    if (body.endsWith("\nUnreviewed extra note"))
      f.base.bodies.set(id, body.slice(0, -"\nUnreviewed extra note".length))
  f.onCreate(() => {})
  // This is the actual missing-original-Store boundary. No ACK is transferred
  // to the new author; only the shared original input and known failure remain.
  f.base.json.clear()
  f.base.objects.clear()
  f.clear()
  f.credential("independent-current-tree-author")
  return {
    f,
    plan,
    page,
    originalFailure,
    selected: { entry: f.library.skills.database_id, plan, target: page },
  }
}
