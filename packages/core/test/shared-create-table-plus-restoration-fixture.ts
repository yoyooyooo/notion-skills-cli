import assert from "node:assert/strict"
import { Effect } from "effect"
import { property } from "../src/model.ts"
import type { PortableSkill } from "../src/portable.ts"
import { prepareSharedCreate, executeSharedCreate } from "../src/shared-create.ts"
import { reviewSharedCreateRestoration } from "../src/shared-create-restoration.ts"
import { sharedCreateOutcomeId } from "../src/shared-create-outcome.ts"
import { normalizeObservedBody } from "../src/shared-file-state.ts"
import { canonicalSharedJson, querySharedRecords } from "../src/shared-records.ts"
import { sharedCreateFixture } from "./shared-create-fixture.ts"

const encode = (value: string) => new TextEncoder().encode(value)
export const tablePlusPath = "references/capabilities.md"
export function tablePlusCreateFixture() {
  return sharedCreateFixture({
    bodyPatch: true,
    readback: (wire) =>
      normalizeObservedBody(
        wire
          .replace(/^<h1>([^\n]*)<\/h1>(?=\n|$)/u, "# $1")
          .split("\n")
          .map((line) => (line.startsWith("|") ? line.replace(/ \+ /gu, "  • ") : line))
          .join("\n"),
      ),
  })
}
export const tablePlusPortable = (): PortableSkill => ({
  kind: "skill" as const,
  name: "Original table literal",
  description: "Recover one known supporting-file literal without losing the original tree",
  main: "SKILL.md",
  files: [
    {
      path: "SKILL.md",
      mode: "100644",
      bytes: encode(
        "---\nname: Original table literal\ndescription: Recover one known supporting-file literal without losing the original tree\nlicense: MIT\nuser-invokable: false\n---\n# Root\n\nKeep all supporting documents and raw resources.\n",
      ),
    },
    {
      path: "references/a-keep.md",
      mode: "100644",
      bytes: encode(
        "# Already acknowledged\n\nKeep [the explicit target](https://example.test/original?q=1#part) and `exact code`.\n",
      ),
    },
    {
      path: tablePlusPath,
      mode: "100644",
      bytes: encode(
        "# CSS+HTML\n\nKeep `a + b`, literal prose + signs, and [the authored link](https://example.test/capabilities).\n\n| Selector | Handler |\n| --- | --- |\n| `:focus` | `.track_focus()` + `on_focus()` / `on_blur()` |\n\nNo other text may be lost.\n",
      ),
    },
    {
      path: "references/z-tail.md",
      mode: "100644",
      bytes: encode(
        "# Unattempted suffix\n\nThis page must be created only after the repaired literal is strictly verified.\n",
      ),
    },
    {
      path: "scripts/tool.mjs",
      mode: "100755",
      bytes: encode(
        "#!/usr/bin/env node\n// Preserve bytes and executable mode; never execute this fixture.\nprocess.stdout.write('retained\\n');\n",
      ),
    },
  ],
})

export async function failedTablePlusOriginal() {
  const f = tablePlusCreateFixture()
  const portable = tablePlusPortable()
  const plan = await f.run(
    prepareSharedCreate(f.library, {
      portable,
      enabled: false,
      completeResources: true,
      markdownImport: true,
    }),
  )
  const failure = await f.run(Effect.flip(executeSharedCreate(f.library, { plan, mode: "create" })))
  assert.equal(failure.code, "SHARED_CREATE_BODY_MISMATCH", JSON.stringify(failure))
  const page = String(property(failure.details).skill_page_id)
  const originalRows = await f.run(
    querySharedRecords(f.library, {
      skillPageId: page,
      kind: "operation",
      recordId: sharedCreateOutcomeId(plan.operation_id),
    }),
  )
  assert.equal(originalRows.length, 1)
  const originalFailure = canonicalSharedJson(originalRows[0])
  const selected = {
    entry: f.library.skills.database_id,
    plan,
    target: page,
    repairTablePlus: tablePlusPath,
  }
  f.clear()
  const review = await f.run(reviewSharedCreateRestoration(selected))
  assert.equal(review.version, 4)
  assert.equal(f.writes().length, 0)
  assert.equal(review.bindings.length, 3)
  const apply = { entry: selected.entry, plan, review, reviewId: review.review_id }
  return { f, portable, plan, page, selected, review, apply, originalFailure }
}
