import { expect, test } from "bun:test"
import { prepareSharedBodyWrite } from "../src/shared-body-write.ts"
import {
  makeSharedBodyWritePlan,
  validateSharedBodyWritePlan,
} from "../src/shared-body-write-model.ts"
import {
  prepareSharedGitMainTakeover,
  executeSharedGitMainTakeover,
} from "../src/shared-git-main-takeover.ts"
import { property } from "../src/model.ts"
import { parseYaml } from "../src/yaml.ts"
import { Store } from "../src/store.ts"
import { Effect } from "effect"
import { rich } from "./shared-snapshot-fixture.ts"
import { gitMainFixture, library, sha } from "./shared-git-main-takeover-fixture.ts"
import { gitMainInput } from "../src/shared-git-main-initialization-model.ts"
import { completeNativeMainInput } from "../src/shared-complete-main-input.ts"

test("fixed Git main authoring retains repository-relative siblings and restores only its own native bindings", () => {
  const page = "00000000-0000-4000-8000-000000000002"
  const body = [
    "[Sibling](../other/SKILL.md#usage)",
    "[Guide](references/guide.md?view=1#details)",
    "[Named][sibling]",
    "",
    "[sibling]: ../other/references/guide%20one.md",
    "",
    "`😀 [example](../../../outside.md)`",
  ].join("\n")
  const input = {
    text: `---\nname: demo\ndescription: Demo\nlicense: MIT\n---\n\n${body}\n`,
    name: "demo",
    description: "Demo",
    path: "SKILL.md",
    bindings: [{ page_id: page, path: "references/guide.md" }],
  }
  const authored = gitMainInput({ ...input, source_member: "skills/demo" })
  expect(authored.body).toBe(
    `${body.replace("references/guide.md?view=1#details", `https://app.notion.com/p/${page.replaceAll("-", "")}?view=1#details`)}\n`,
  )
  expect(authored.frontmatter).toContain("license: MIT")
  expect(() => completeNativeMainInput(input)).toThrow()
})

test("Git main authoring cannot escape its frozen repository or substitute a noncanonical member", () => {
  const input = {
    text: "---\nname: demo\ndescription: Demo\n---\n\n[Sibling](../other/SKILL.md)\n",
    name: "demo",
    description: "Demo",
    path: "SKILL.md",
    bindings: [],
  }
  for (const source_member of [".", "", "../demo", "skills/../demo", "/skills/demo"])
    expect(() => gitMainInput({ ...input, source_member })).toThrow()
  for (const href of ["../../../outside.md", "%2e%2e/%2e%2e/%2e%2e/outside.md", "/outside.md"])
    expect(() =>
      gitMainInput({
        ...input,
        source_member: "skills/demo",
        text: input.text.replace("../other/SKILL.md", href),
      }),
    ).toThrow()
})

test("same-owner initial takeover preserves sibling hrefs through plan validation, insertion and a cold mixed snapshot", async () => {
  const f = await gitMainFixture()
  const snapshot = await f.read()
  const siblings = "[Sibling](../other/SKILL.md#usage) [Repository guide](../../shared/guide.md)"
  const markdown = new TextDecoder().decode(f.original.bytes) + `\n${siblings}\n`
  const prepared = await f.author(
    prepareSharedGitMainTakeover({ library, snapshot, path: "SKILL.md", markdown, mode: "100755" }),
  )
  expect(f.bodyWrites).toHaveLength(0)
  expect(prepared.plan.input_projection?.input_markdown).toContain(siblings)
  expect(prepared.plan.git_main_initialization?.authored_input).toBe(markdown)
  const header = (text: string) => /^---\n([\s\S]*?)\n---/u.exec(text)![1]!
  if (prepared.plan.candidate.content.kind === "resource")
    throw new Error("Expected the complete Markdown main, not a raw resource")
  expect(prepared.plan.candidate.content.frontmatter).toContain(header(markdown))
  await f.run(validateSharedBodyWritePlan(prepared.plan))
  const applied = await f.author(
    executeSharedGitMainTakeover({ library, plan: prepared.plan, mode: "create" }),
  )
  expect(applied.status).toBe("applied")
  expect(f.bodyWrites).toHaveLength(1)
  f.f.base.json.clear()
  f.f.base.objects.clear()
  const cold = await f.read()
  expect(cold.shared_acquisition?.version).toBe(4)
  expect(cold.shared_acquisition?.source).toEqual(snapshot.shared_acquisition?.source)
  expect(cold.record.locator).toEqual(snapshot.record.locator)
  expect(cold.file_bindings).toEqual(snapshot.file_bindings)
  const main = cold.files.find((file) => file.path === "SKILL.md")!
  expect(main.mode).toBe("100755")
  const bytes = await f.run(
    Effect.flatMap(Store, (store) => store.readBytes(`objects/${main.sha256}`)),
  )
  const rendered = new TextDecoder().decode(bytes)
  expect(rendered).toContain(siblings)
  expect(parseYaml(header(rendered))).toEqual(parseYaml(header(markdown)))
  for (const file of snapshot.files.filter((file) => file.path !== "SKILL.md"))
    expect(cold.files.find((current) => current.path === file.path)).toEqual(file)
})

async function preparedInitial() {
  const f = await gitMainFixture()
  const snapshot = await f.read()
  const markdown = new TextDecoder()
    .decode(f.original.bytes)
    .replace("Keep all source documents.", "The complete local main is now customized.")
  const prepared = await f.author(
    prepareSharedGitMainTakeover({ library, snapshot, path: "SKILL.md", markdown, mode: "100644" }),
  )
  return { f, snapshot, markdown, plan: prepared.plan }
}

test("ordinary body write reproduces the source-only main BASELINE_MISSING without inventing an empty file event", async () => {
  const f = await gitMainFixture()
  const snapshot = await f.read()
  expect(snapshot.shared_acquisition?.version).toBe(4)
  expect(snapshot.files.find((file) => file.path === "SKILL.md")?.bytes).toBe(
    f.original.bytes.length,
  )
  await expect(
    f.author(
      prepareSharedBodyWrite({
        library,
        skillPageId: f.target,
        fileId: f.fileId,
        action: "write",
        candidateMarkdown: "# Complete local main\n",
      }),
    ),
  ).rejects.toMatchObject({ code: "BASELINE_MISSING" })
  expect(f.bodyWrites).toHaveLength(0)
})

for (const visible of [false, true])
  test(`initial append with lost ACK (visible=${visible}) never replays or adopts equal current text`, async () => {
    const { f, plan } = await preparedInitial()
    f.loseAck(visible)
    await expect(
      f.author(executeSharedGitMainTakeover({ library, plan, mode: "create" })),
    ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" })
    expect(f.bodyWrites).toHaveLength(1)
    expect(f.markdown().length > 0).toBe(visible)
    await expect(
      f.author(executeSharedGitMainTakeover({ library, plan, mode: "create" })),
    ).rejects.toMatchObject({ code: "SHARED_BODY_WRITE_UNRESOLVED" })
    f.f.base.json.clear()
    f.f.base.objects.clear()
    await expect(
      f.author(executeSharedGitMainTakeover({ library, plan, mode: "reconcile" })),
    ).rejects.toMatchObject({ code: "SHARED_BODY_WRITE_UNRESOLVED" })
    await expect(f.read()).rejects.toMatchObject({ code: "SHARED_BODY_WRITE_UNRESOLVED" })
    expect(f.bodyWrites).toHaveLength(1)
  })

test("a concurrent native addition is preserved and requires the existing explicit mismatch review", async () => {
  const { f, plan } = await preparedInitial()
  f.appendConcurrently("# User text entered after the empty observation\n\n")
  await expect(
    f.author(executeSharedGitMainTakeover({ library, plan, mode: "create" })),
  ).rejects.toMatchObject({ code: "SHARED_BODY_WRITE_REVIEW_REQUIRED" })
  expect(f.markdown()).toStartWith("# User text entered after the empty observation")
  expect(f.markdown()).toContain("The complete local main is now customized.")
  await expect(
    f.author(executeSharedGitMainTakeover({ library, plan, mode: "reconcile" })),
  ).rejects.toMatchObject({ code: "SHARED_BODY_WRITE_REVIEW_REQUIRED" })
  await expect(f.read()).rejects.toMatchObject({ code: "SHARED_BODY_WRITE_REVIEW_REQUIRED" })
  expect(f.bodyWrites).toHaveLength(1)
})

test("the empty native premise is checked again after retaining the original plan", async () => {
  const { f, plan } = await preparedInitial()
  f.afterFirstRecord(() => f.changeMarkdown("# User edit while the plan was retained\n"))
  await expect(
    f.author(executeSharedGitMainTakeover({ library, plan, mode: "create" })),
  ).rejects.toMatchObject({ code: "SHARED_BODY_WRITE_STALE" })
  expect(f.bodyWrites).toHaveLength(0)
  expect(f.markdown()).toBe("# User edit while the plan was retained\n")
  const original = await f.author(
    executeSharedGitMainTakeover({ library, plan, mode: "reconcile" }),
  )
  expect(original.status).toBe("not_applied")
  expect(f.bodyWrites).toHaveLength(0)
})

test("cold current equality and a visible adopted event cannot replace a missing original completion", async () => {
  const { f, plan } = await preparedInitial()
  await f.author(executeSharedGitMainTakeover({ library, plan, mode: "create" }))
  f.f.removeCompletion(plan.operation_id)
  f.f.base.json.clear()
  f.f.base.objects.clear()
  await expect(f.read()).rejects.toMatchObject({ code: "SHARED_BODY_WRITE_UNRESOLVED" })
  await expect(
    f.author(executeSharedGitMainTakeover({ library, plan, mode: "reconcile" })),
  ).rejects.toMatchObject({ code: "SHARED_BODY_WRITE_UNRESOLVED" })
  expect(f.bodyWrites).toHaveLength(1)
})

for (const change of ["body", "description", "binding", "source", "member"] as const)
  test(`initial takeover rejects changed ${change} before any native insertion`, async () => {
    const { f, plan } = await preparedInitial()
    const props = property(f.row.properties)
    if (change === "body") f.changeMarkdown("# A real existing native edit\n")
    if (change === "description")
      props.description = rich("description", "Someone changed metadata")
    if (change === "binding") props.main_file_id = rich("main_file_id", "file-other-main")
    if (change === "source") props.source = rich("source", `source-${"f".repeat(64)}`)
    if (change === "member") props.source_member = rich("source_member", "skills/another-member")
    await expect(
      f.author(executeSharedGitMainTakeover({ library, plan, mode: "create" })),
    ).rejects.toMatchObject({
      code:
        change === "body"
          ? "SHARED_BODY_WRITE_STALE"
          : change === "member"
            ? "GIT_ONLY_SCOPE"
            : "SHARED_FILE_MANAGEMENT_STALE",
    })
    expect(f.bodyWrites).toHaveLength(0)
  })

test("a complete already-native main cannot be initialized again", async () => {
  const { f, plan, markdown } = await preparedInitial()
  await f.author(executeSharedGitMainTakeover({ library, plan, mode: "create" }))
  const current = await f.read()
  await expect(
    f.author(
      prepareSharedGitMainTakeover({
        library,
        snapshot: current,
        path: "SKILL.md",
        markdown,
        mode: "100644",
      }),
    ),
  ).rejects.toMatchObject({ code: "SHARED_GIT_MAIN_SCOPE" })
  expect(f.bodyWrites).toHaveLength(1)
})

test("the original Source definition cannot drift while its selected immutable version stays the same", async () => {
  const { f, plan } = await preparedInitial()
  const key = library.sources!.property_ids.Ref!
  property(f.f.source.properties)[key] = rich(key, "b".repeat(40))
  await expect(
    f.author(executeSharedGitMainTakeover({ library, plan, mode: "create" })),
  ).rejects.toMatchObject({ code: "SHARED_BODY_WRITE_STALE" })
  expect(f.bodyWrites).toHaveLength(0)
})

test("self-consistent forged Git preimage and mutated frontmatter/mode cannot replace the original source proof", async () => {
  const { f, plan } = await preparedInitial()
  const badOriginal = "---\nname: invented\n---\n# Not the selected Git file\n"
  const forged = await f.run(
    makeSharedBodyWritePlan({
      ...plan,
      candidateMarkdown: plan.candidate.markdown,
      parents: plan.event.parents,
      git_main_initialization: {
        ...plan.git_main_initialization!,
        source_input: badOriginal,
        source_file: {
          ...plan.git_main_initialization!.source_file,
          sha256: sha(badOriginal),
          bytes: new TextEncoder().encode(badOriginal).length,
        },
      },
    }),
  )
  await expect(
    f.author(executeSharedGitMainTakeover({ library, plan: forged, mode: "create" })),
  ).rejects.toMatchObject({ code: "SHARED_BODY_WRITE_STALE" })
  for (const metadata of [{ mode: "100755" }, { frontmatter: "---\nname: replaced\n---\n" }]) {
    await expect(
      f.run(
        validateSharedBodyWritePlan({
          ...plan,
          candidate: { ...plan.candidate, content: { ...plan.candidate.content, ...metadata } },
        }),
      ),
    ).rejects.toMatchObject({ code: "SHARED_BODY_WRITE_INVALID" })
  }
  expect(f.bodyWrites).toHaveLength(0)
})

test("complete YAML cannot silently conflict with native metadata or drop a runtime-only field", async () => {
  const { f, snapshot, markdown } = await preparedInitial()
  await expect(
    f.author(
      prepareSharedGitMainTakeover({
        library,
        snapshot,
        path: "SKILL.md",
        markdown: markdown.replace(
          "description: Initial complete member",
          "description: Different local description",
        ),
        mode: "100644",
      }),
    ),
  ).rejects.toMatchObject({ code: "SHARED_METADATA_CONFLICT" })
  await expect(
    f.author(
      prepareSharedGitMainTakeover({
        library,
        snapshot,
        path: "SKILL.md",
        markdown: markdown.replace("license: MIT", `license: MIT\nnotion_page_id: ${f.target}`),
        mode: "100644",
      }),
    ),
  ).rejects.toMatchObject({ code: "SHARED_FRONTMATTER_UNSUPPORTED" })
  expect(f.bodyWrites).toHaveLength(0)
})

test("explicit same-owner takeover preserves complete local YAML and mode while other fixed Git files and the old pin stay exact", async () => {
  const f = await gitMainFixture()
  property(f.row.properties).description = rich("description", "Local description")
  property(f.row.properties).enabled = { id: "enabled", type: "checkbox", checkbox: false }
  const snapshot = await f.read()
  const markdown = new TextDecoder()
    .decode(f.original.bytes)
    .replace("description: Initial complete member", "description: Local description")
    .replace(
      "user-invokable: true",
      "user-invokable: false\ncustom:\n  nested: [one, two]\n  enabled: true",
    )
    .replace("Keep all source documents.", "Keep every local instruction and all source documents.")
  const prepared = await f.author(
    prepareSharedGitMainTakeover({ library, snapshot, path: "SKILL.md", markdown, mode: "100755" }),
  )
  expect(f.bodyWrites).toHaveLength(0)
  expect(prepared.plan.git_main_initialization?.source_input).toBe(
    new TextDecoder().decode(f.original.bytes),
  )
  expect(prepared.plan.event.parents).toEqual([])
  expect(prepared.plan.before.raw_markdown).toBe("")
  const applied = await f.author(
    executeSharedGitMainTakeover({ library, plan: prepared.plan, mode: "create" }),
  )
  expect(applied.status).toBe("applied")
  expect(f.bodyWrites).toHaveLength(1)
  expect(property(f.bodyWrites[0]).type).toBe("insert_content")
  f.f.base.json.clear()
  f.f.base.objects.clear()
  const cold = await f.read()
  expect(cold.record.locator).toEqual(snapshot.record.locator)
  expect(cold.file_bindings).toEqual(snapshot.file_bindings)
  expect(cold.shared_acquisition?.source).toEqual(snapshot.shared_acquisition?.source)
  for (const original of snapshot.files.filter((file) => file.path !== "SKILL.md"))
    expect(cold.files.find((file) => file.path === original.path)).toEqual(original)
  const main = cold.files.find((file) => file.path === "SKILL.md")!
  expect(main.mode).toBe("100755")
  const bytes = await f.run(
    Effect.flatMap(Store, (store) => store.readBytes(`objects/${main.sha256}`)),
  )
  expect(sha(bytes)).toBe(main.sha256)
  const rendered = new TextDecoder().decode(bytes)
  const header = (text: string) => parseYaml(/^---\n([\s\S]*?)\n---/u.exec(text)![1]!)
  expect(header(rendered)).toEqual(header(markdown))
  expect(rendered).toContain("Keep every local instruction and all source documents.")
  expect(cold.shared_acquisition?.files.some((file) => file.path === "SKILL.md")).toBe(false)
  const repeated = await f.author(
    executeSharedGitMainTakeover({ library, plan: prepared.plan, mode: "create" }),
  )
  expect(repeated.status).toBe("applied")
  expect(f.bodyWrites).toHaveLength(1)
  expect(snapshot.files.find((file) => file.path === "SKILL.md")?.sha256).toBe(
    sha(f.original.bytes),
  )
})
