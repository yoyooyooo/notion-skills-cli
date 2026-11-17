import { expect, test } from "bun:test"
import { Effect } from "effect"
import { property, text } from "../src/model.ts"
import {
  prepareSharedGitMainTakeover,
  executeSharedGitMainTakeover,
} from "../src/shared-git-main-takeover.ts"
import { reviewSharedBodyWrite } from "../src/shared-body-write-review.ts"
import { Store } from "../src/store.ts"
import { parseYaml } from "../src/yaml.ts"
import { gitMainFixture, library, sha } from "./shared-git-main-takeover-fixture.ts"
import { rich } from "./shared-snapshot-fixture.ts"

const body =
  "# Initial\n\n1. **Identify the source context**:\n   - What was it designed for originally?\n   - What assumptions were made?\n\n2. **Understand target context**:\n   - **Device**: Mobile, tablet, desktop?\n"
const observed =
  "# Initial\n\n1. <b>Identify the source context</b>:\n\t- What was it designed for originally?\n\t- What assumptions were made?\n2. <b>Understand target context</b>:\n\t- <b>Device</b>: Mobile, tablet, desktop?"

async function prepared() {
  const f = await gitMainFixture()
  const snapshot = await f.read()
  const original = new TextDecoder().decode(f.original.bytes)
  const markdown = original.slice(0, original.indexOf("# Initial")) + body
  const { plan } = await f.author(
    prepareSharedGitMainTakeover({
      library,
      snapshot,
      path: "SKILL.md",
      markdown,
      mode: "100755",
    }),
  )
  f.renderNative(() => observed)
  return { f, plan, markdown }
}

function review(input: Awaited<ReturnType<typeof prepared>>, dryRun = false) {
  return reviewSharedBodyWrite({
    library,
    skillPageId: input.f.target,
    originalOperationId: input.plan.operation_id,
    acceptedObservedSha256: sha(input.f.markdown()),
    scope: input.plan.git_main_initialization!.snapshot_scope,
    mode: "create",
    dryRun,
  })
}

test("first native import keeps nested input intact and uses an explicit, semantically checked known readback review", async () => {
  const input = await prepared()
  const { f, plan, markdown } = input
  expect(plan.input_projection).toMatchObject({
    version: 17,
    purpose: "data_source_create",
    input_markdown: body,
  })
  expect(plan.git_main_initialization?.authored_input).toBe(markdown)
  expect(plan.git_main_initialization?.source_input).toBe(
    new TextDecoder().decode(f.original.bytes),
  )
  expect(f.bodyWrites).toHaveLength(0)
  await expect(
    f.author(executeSharedGitMainTakeover({ library, plan, mode: "create" })),
  ).rejects.toMatchObject({ code: "SHARED_BODY_WRITE_REVIEW_REQUIRED" })
  expect(f.markdown()).toBe(observed)
  expect((await f.author(review(input, true))).status).toBe("planned")
  const accepted = await f.author(review(input))
  expect(accepted.decision).toBe("accepted_observed")
  expect(accepted.original_status).toBe("needs_review")
  expect(f.bodyWrites).toHaveLength(1)
  const originalOutcomes = [...f.f.base.records.values()]
    .map(
      (row) =>
        property(JSON.parse(text(property(property(row.properties).payload).rich_text))).payload,
    )
    .filter((value) => property(value).kind === "body_write_outcome")
  expect(originalOutcomes.map((value) => property(value).status)).toEqual(["needs_review"])
  f.f.base.json.clear()
  f.f.base.objects.clear()
  const cold = await f.read()
  const main = cold.files.find((file) => file.path === "SKILL.md")!
  expect(main.mode).toBe("100755")
  const bytes = await f.run(
    Effect.flatMap(Store, (store) => store.readBytes(`objects/${main.sha256}`)),
  )
  const full = new TextDecoder().decode(bytes)
  expect(parseYaml(/^---\n([\s\S]*?)\n---\n/u.exec(full)![1]!)).toEqual({
    name: "initial-source",
    description: "Initial complete member",
    license: "MIT",
    args: ["target"],
    "user-invokable": true,
  })
  expect(full).toContain(observed)
  expect(cold.shared_acquisition?.version).toBe(3)
  for (const original of f.member.portable.files.filter((file) => file.path !== "SKILL.md")) {
    const sibling = cold.files.find((file) => file.path === original.path)!
    expect(sibling.sha256).toBe(sha(original.bytes))
    expect(sibling.mode).toBe(original.mode)
  }
  expect(f.bodyWrites).toHaveLength(1)
})

for (const change of ["text", "code", "link", "source", "concurrent"] as const)
  test(`initial import review refuses ${change} loss or drift`, async () => {
    const input = await prepared()
    const { f, plan } = input
    if (change === "text") f.renderNative(() => observed.replace("originally", "incorrectly"))
    if (change === "code") f.renderNative(() => observed + "\n\n<code>Unsubmitted code</code>")
    if (change === "link")
      f.renderNative(() => observed + "\n\n[Unsubmitted link](https://example.invalid/)")
    if (change === "concurrent") f.appendConcurrently("# Concurrent native addition\n\n")
    await expect(
      f.author(executeSharedGitMainTakeover({ library, plan, mode: "create" })),
    ).rejects.toMatchObject({ code: "SHARED_BODY_WRITE_REVIEW_REQUIRED" })
    if (change === "source")
      property(f.f.source.properties)[library.sources!.property_ids.Ref!] = rich(
        library.sources!.property_ids.Ref!,
        "b".repeat(40),
      )
    await expect(f.author(review(input))).rejects.toMatchObject({ _tag: "SkillsError" })
    expect(f.bodyWrites).toHaveLength(1)
    await expect(f.read()).rejects.toMatchObject({ _tag: "SkillsError" })
  })

test("an unknown initial import cannot use equal current text as the missing original ACK", async () => {
  const input = await prepared()
  input.f.loseAck(true)
  await expect(
    input.f.author(executeSharedGitMainTakeover({ library, plan: input.plan, mode: "create" })),
  ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
  await expect(input.f.author(review(input))).rejects.toMatchObject({
    code: "SHARED_BODY_REVIEW_INELIGIBLE",
  })
  expect(input.f.bodyWrites).toHaveLength(1)
})
