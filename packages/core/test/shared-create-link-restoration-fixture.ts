import { expect } from "bun:test"
import { Effect } from "effect"
import { property } from "../src/model.ts"
import { prepareSharedCreate, executeSharedCreate } from "../src/shared-create.ts"
import { reviewSharedCreateRestoration } from "../src/shared-create-restoration.ts"
import { sharedCreateOutcomeId } from "../src/shared-create-outcome.ts"
import { normalizeObservedBody } from "../src/shared-file-state.ts"
import { canonicalSharedJson, querySharedRecords } from "../src/shared-records.ts"
import { mapMarkdownLinks } from "../src/typed-links.ts"
import { sharedCreateFixture } from "./shared-create-fixture.ts"

const encode = (text: string) => new TextEncoder().encode(text)
export async function failedLinkedOriginal(policy: 14 | 15 = 14) {
  const f = sharedCreateFixture({
    bodyPatch: true,
    readback: (wire) =>
      normalizeObservedBody(
        mapMarkdownLinks(wire.replace(/^<h1>([^\n]*)<\/h1>(?=\n|$)/u, "# $1"), (href) =>
          /^[^./:#?][^/:?#]*\.md$/u.test(href) ? `https://${href}` : href,
        ),
      ),
  })
  const resources = Array.from({ length: 4 }, (_, at) => ({
    path: `scripts/tool-${at}.py`,
    bytes: encode(`# retained script ${at}\nprint(${at})\n`),
    mode: at % 2 === 0 ? ("100755" as const) : ("100644" as const),
  }))
  const plan = await f.run(
    prepareSharedCreate(f.library, {
      portable: {
        kind: "skill",
        name: "Linked original",
        description: "Complete original cyclic skill",
        main: "SKILL.md",
        files: [
          {
            path: "SKILL.md",
            bytes: encode(
              "# Root\n\nRead [First](references/first.md) and [Second](references/second.md).\n",
            ),
          },
          {
            path: "references/first.md",
            bytes: encode(
              "# First\n\nRead [Second](second.md). Keep `second.md` as code and [External](https://example.test/second.md).\n",
            ),
          },
          {
            path: "references/second.md",
            bytes: encode("# Second\n\nRead [First](first.md) and [Root](../SKILL.md).\n"),
          },
          ...resources,
        ],
      },
      completeResources: true,
      ...(policy === 14 ? { markdownImport: true as const } : {}),
    }),
  )
  const failure = await f.run(Effect.flip(executeSharedCreate(f.library, { plan, mode: "create" })))
  expect(failure.code).toBe("SHARED_CREATE_BODY_MISMATCH")
  const page = String(property(failure.details).skill_page_id)
  const rows = await f.run(
    querySharedRecords(f.library, {
      skillPageId: page,
      kind: "operation",
      recordId: sharedCreateOutcomeId(plan.operation_id),
    }),
  )
  expect(rows).toHaveLength(1)
  const originalFailure = canonicalSharedJson(rows[0])
  const selected = {
    entry: f.library.skills.database_id,
    plan,
    target: page,
    repairLocalLinks: true,
  }
  f.clear()
  const review = await f.run(reviewSharedCreateRestoration(selected))
  expect(review.version).toBe(3)
  expect(f.writes()).toHaveLength(0)
  const apply = { entry: selected.entry, plan, review, reviewId: review.review_id }
  return { f, plan, page, selected, review, apply, originalFailure, resources }
}
