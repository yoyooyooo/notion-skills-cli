import { readFileSync } from "node:fs"
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { projectNotionBlocks, samePublishedMarkdown } from "../src/markdown.ts"
import { fail } from "../src/model.ts"
import type { Notion } from "../src/notion.ts"
import type { Receipt } from "../src/publication-model.ts"
import { publicationExternalLinksMatch } from "../src/publication-markdown.ts"
import {
  publicationReadPhase,
  readPublicationMarkdownMatches,
} from "../src/publication-observation.ts"
import { rewritePageLinks } from "../src/references.ts"

const page = "11111111-1111-4111-8111-111111111111"
const pagePath = "v1/pages/" + page
const markdownPath = pagePath + "/markdown"
const inventoryPath = "v1/blocks/" + page + "/children?page_size=100"
const local = (markdown: string) => rewritePageLinks(markdown, "", [], "local")
const mapping = {
  local,
  preserveExternal: (markdown: string) =>
    rewritePageLinks(markdown, "", [], "local", [], { preserveExternalUrls: true }),
}
const actualWaza = readFileSync(
  new URL("./fixtures/waza-reviewer-live.md", import.meta.url),
  "utf8",
)
const authoredWaza = readFileSync(
  new URL("./fixtures/waza-reviewer-target.md", import.meta.url),
  "utf8",
)

function intent(target: string): Receipt["intents"][number] {
  return {
    path: markdownPath,
    method: "PATCH",
    status: "completed",
    body: { type: "replace_content", replace_content: { new_str: target } },
  }
}

function reader(actual: string, rejectInventory = false, roots: readonly unknown[] = []) {
  const calls: string[] = []
  const api: Notion["Service"] = {
    version: Effect.succeed("test"),
    credentialIdentity: Effect.succeed("test"),
    request: (path, body, options) =>
      Effect.gen(function* () {
        expect(body).toBeUndefined()
        expect(options?.method).toBeUndefined()
        calls.push(path)
        if (path === pagePath)
          return {
            id: page,
            object: "page",
            last_edited_time: "2026-10-20T00:00:00.000Z",
            archived: false,
            in_trash: false,
            properties: {},
          }
        if (path === markdownPath)
          return {
            object: "page_markdown",
            markdown: actual,
            truncated: false,
            unknown_block_ids: [],
          }
        if (path === inventoryPath) {
          if (rejectInventory)
            return yield* Effect.fail(fail("INVALID_RESPONSE", "Root inventory unavailable."))
          return { results: roots, has_more: false, next_cursor: null }
        }
        return yield* Effect.fail(fail("INVALID_RESPONSE", "Unexpected publication read."))
      }),
  }
  return { api, calls }
}

test("publication reuse preserves the Waza filename autolink before local URL rewriting", async () => {
  expect(samePublishedMarkdown(actualWaza, authoredWaza)).toBe(true)
  expect(samePublishedMarkdown(local(actualWaza), local(authoredWaza))).toBe(false)
  const f = reader(actualWaza)
  const matches = await Effect.runPromise(
    readPublicationMarkdownMatches(
      intent(authoredWaza),
      actualWaza,
      local(authoredWaza),
      f.api,
      publicationReadPhase(),
      mapping,
    ),
  )
  expect(matches).toBe(true)
  expect(f.calls).toEqual([])
})

for (const [name, actual, target] of [
  ["an authored HTTP link disappearing", "Read SKILL.md.", "Read [SKILL.md](http://SKILL.md)."],
  ["an authored relative link disappearing", "Read SKILL.md.", "Read [SKILL.md](SKILL.md)."],
  ["an explicit relative link becoming bare text", "Read [SKILL.md](SKILL.md).", "Read SKILL.md."],
  ["a different autolink URL", "Read [SKILL.md](http://OTHER.md).", "Read SKILL.md."],
  [
    "a changed explicit destination",
    "Read [SKILL.md](https://other.example/guide).",
    "Read [SKILL.md](http://SKILL.md).",
  ],
  ["changed Waza prose", actualWaza.replace("Deep depth only", "Every depth"), authoredWaza],
] satisfies Array<[string, string, string]>) {
  test("publication reuse rejects " + name + " after local URL rewriting", async () => {
    const f = reader(actual)
    const matches = await Effect.runPromise(
      readPublicationMarkdownMatches(
        intent(target),
        actual,
        local(target),
        f.api,
        publicationReadPhase(),
        mapping,
      ),
    )
    expect(matches).toBe(false)
    expect(f.calls).toContain(inventoryPath)
  })
}

test("the retained target cannot authorize a different caller target", async () => {
  const f = reader(actualWaza)
  const different = authoredWaza.replace("Deep depth only", "Every depth")
  const matches = await Effect.runPromise(
    readPublicationMarkdownMatches(
      intent(authoredWaza),
      actualWaza,
      local(different),
      f.api,
      publicationReadPhase(),
      mapping,
    ),
  )
  expect(matches).toBe(false)
})

test("an unchanged explicit relative filename still uses the existing local mapping", async () => {
  const actual = "Read [SKILL.md](http://SKILL.md)."
  const target = "Read [SKILL.md](SKILL.md)."
  expect(samePublishedMarkdown(actual, target)).toBe(false)
  const f = reader(actual)
  expect(
    await Effect.runPromise(
      readPublicationMarkdownMatches(
        intent(target),
        actual,
        local(target),
        f.api,
        publicationReadPhase(),
        mapping,
      ),
    ),
  ).toBe(true)
})

test("typed page mentions still converge through the original local destination mapping", async () => {
  const targetURL =
    "https://www.notion.so/22222222222242228222222222222222#ntn-skills-path=references%2Fguide.md"
  const actual = '<mention-page url="' + targetURL + '">Guide</mention-page>'
  const target = "[Guide](" + targetURL + ")"
  expect(samePublishedMarkdown(actual, target)).toBe(false)
  const saved: Receipt["intents"][number] = {
    ...intent(target),
    typed_links: { page_id: page, markdown: target, state: "completed" },
  }
  const f = reader(actual)
  expect(
    await Effect.runPromise(
      readPublicationMarkdownMatches(
        saved,
        actual,
        local(target),
        f.api,
        publicationReadPhase(),
        mapping,
      ),
    ),
  ).toBe(true)
})

test("retained raw spelling cannot bypass a required root structure proof", async () => {
  const f = reader(actualWaza, true)
  const result = await Effect.runPromise(
    readPublicationMarkdownMatches(
      intent(authoredWaza),
      actualWaza,
      local(authoredWaza),
      f.api,
      publicationReadPhase(),
      mapping,
      true,
    ).pipe(Effect.result),
  )
  expect(result).toMatchObject({ _tag: "Failure", failure: { code: "INVALID_RESPONSE" } })
  expect(f.calls).toContain(inventoryPath)
})

const proofModes = ["fast", "cached", "structure"] as const

const evidenceActual =
  "Before text.\n\\<!-- independent note --\\>\n```text\nexact code\n```\nRead [site](http://SKILL.md)."
const evidenceTarget =
  "Before text.\n\n<!-- independent note -->\n```text\nexact code\n```\n\nRead [site](http://SKILL.md)."
const evidenceRoots = [
  {
    id: "before",
    type: "paragraph",
    has_children: false,
    paragraph: { rich_text: [{ type: "text", text: { content: "Before text." } }] },
  },
  {
    id: "comment",
    type: "paragraph",
    has_children: false,
    paragraph: { rich_text: [{ type: "text", text: { content: "<!-- independent note -->" } }] },
  },
  {
    id: "code",
    type: "code",
    has_children: false,
    code: { language: "text", rich_text: [{ type: "text", text: { content: "exact code" } }] },
  },
  {
    id: "after",
    type: "paragraph",
    has_children: false,
    paragraph: {
      rich_text: [
        {
          type: "text",
          text: { content: "Read ", link: null },
          annotations: { bold: false, code: false },
        },
        {
          type: "text",
          text: { content: "site", link: { url: "http://SKILL.md" } },
          annotations: { bold: false, code: false },
        },
        {
          type: "text",
          text: { content: ".", link: null },
          annotations: { bold: false, code: false },
        },
      ],
    },
  },
].map((block) => ({ ...block, parent: { type: "page_id", page_id: page } }))

for (const mode of proofModes) {
  test(
    "target-directed syntax proof retains block evidence and URL identity through " + mode,
    async () => {
      for (const [actual, expected] of [
        [evidenceActual, true],
        [evidenceActual.replace("independent note", "other note"), false],
        [evidenceActual.replace("exact code", "other code"), false],
        [evidenceActual.replace("http://SKILL.md", "https://SKILL.md"), false],
      ] satisfies Array<[string, boolean]>) {
        const f = reader(actual, false, evidenceRoots)
        const phase = publicationReadPhase()
        if (mode === "cached")
          phase.proofs.set(page, {
            actual,
            blocks: projectNotionBlocks(evidenceRoots)!,
            strict_structure: true,
          })
        const matches = await Effect.runPromise(
          readPublicationMarkdownMatches(
            intent(evidenceTarget),
            actual,
            local(evidenceTarget),
            f.api,
            phase,
            mapping,
            mode !== "fast",
          ),
        )
        expect(matches).toBe(expected)
        if (mode === "cached") expect(f.calls).toEqual([])
        else expect(f.calls).toContain(inventoryPath)
      }
    },
  )
}

test("target-directed publication proof refuses a caller target unrelated to the retained intent", async () => {
  const f = reader(evidenceActual, false, evidenceRoots)
  const other = evidenceTarget.replace("http://SKILL.md", "https://SKILL.md")
  const phase = publicationReadPhase()
  phase.proofs.set(page, {
    actual: evidenceActual,
    blocks: projectNotionBlocks(evidenceRoots)!,
    strict_structure: true,
  })
  expect(
    await Effect.runPromise(
      readPublicationMarkdownMatches(
        intent(other),
        evidenceActual,
        local(evidenceTarget),
        f.api,
        phase,
        mapping,
        true,
      ),
    ),
  ).toBe(false)
})

test("the external URL proof uses the same block-backed syntax comparison", () => {
  const blocks = projectNotionBlocks(evidenceRoots)!
  expect(
    publicationExternalLinksMatch(evidenceActual, evidenceTarget, mapping.preserveExternal, blocks),
  ).toBe(true)
  expect(
    publicationExternalLinksMatch(
      evidenceActual.replace("http://SKILL.md", "https://SKILL.md"),
      evidenceTarget,
      mapping.preserveExternal,
      blocks,
    ),
  ).toBe(false)
  expect(
    publicationExternalLinksMatch(evidenceActual, evidenceTarget, mapping.preserveExternal),
  ).toBe(false)
  expect(
    publicationExternalLinksMatch(
      evidenceActual,
      evidenceTarget,
      mapping.preserveExternal,
      blocks.slice(1),
    ),
  ).toBe(false)
})

function proofPhase(mode: (typeof proofModes)[number], actual: string) {
  const phase = publicationReadPhase()
  if (mode === "cached") phase.proofs.set(page, { actual, blocks: [], strict_structure: true })
  return phase
}

for (const mode of proofModes) {
  for (const [name, actual, target] of [
    [
      "an explicit filename scheme change",
      "Read [SKILL.md](https://SKILL.md).",
      "Read [SKILL.md](http://SKILL.md).",
    ],
    [
      "a correct later URL hiding a changed earlier link",
      "[example.com](https://example.com) [example.com](http://example.com)",
      "[example.com](http://example.com) example.com",
    ],
  ] satisfies Array<[string, string, string]>) {
    test("external URL proof rejects " + name + " through " + mode, async () => {
      expect(samePublishedMarkdown(actual, target)).toBe(false)
      expect(samePublishedMarkdown(local(actual), local(target))).toBe(true)
      const f = reader(actual)
      const phase = proofPhase(mode, actual)
      const matches = await Effect.runPromise(
        readPublicationMarkdownMatches(
          intent(target),
          actual,
          local(target),
          f.api,
          phase,
          mapping,
          mode !== "fast",
        ),
      )
      expect(matches).toBe(false)
      if (mode === "cached") expect(f.calls).toEqual([])
      else expect(f.calls).toContain(inventoryPath)
    })
  }
}

for (const [name, actual, target] of [
  [
    "an explicit domain scheme change",
    "Read [example.com](https://example.com).",
    "Read [example.com](http://example.com).",
  ],
  [
    "a changed explicit port",
    "Read [example.com](https://example.com:8443).",
    "Read [example.com](https://example.com).",
  ],
  [
    "an explicit domain link disappearing",
    "Read example.com.",
    "Read [example.com](https://example.com).",
  ],
  [
    "a reference-style destination change",
    "Read [guide][ref].\n\n[ref]: https://SKILL.md",
    "Read [guide][ref].\n\n[ref]: http://SKILL.md",
  ],
] satisfies Array<[string, string, string]>) {
  test("external URL proof rejects " + name + " after a lossy mapped match", async () => {
    expect(samePublishedMarkdown(local(actual), local(target))).toBe(true)
    const f = reader(actual)
    expect(
      await Effect.runPromise(
        readPublicationMarkdownMatches(
          intent(target),
          actual,
          local(target),
          f.api,
          publicationReadPhase(),
          mapping,
        ),
      ),
    ).toBe(false)
  })
}

const typedURL =
  "https://www.notion.so/22222222222242228222222222222222#ntn-skills-path=references%2Fguide.md"
const mixedActual =
  '<mention-page url="' +
  typedURL +
  '">Guide</mention-page>\n\n' +
  "Keep [SKILL.md](http://SKILL.md), [reference](https://README.md), and [example.com](http://example.com)."
const mixedTarget =
  "[Guide](" +
  typedURL +
  ")\n\n" +
  "Keep [SKILL.md](http://SKILL.md), [reference](README.md), and example.com."

for (const mode of proofModes) {
  test(
    "external URL proof preserves mixed typed, relative and automatic links through " + mode,
    async () => {
      expect(samePublishedMarkdown(mixedActual, mixedTarget)).toBe(false)
      expect(samePublishedMarkdown(local(mixedActual), local(mixedTarget))).toBe(true)
      const f = reader(mixedActual)
      const phase = proofPhase(mode, mixedActual)
      const saved: Receipt["intents"][number] = {
        ...intent(mixedTarget),
        typed_links: { page_id: page, markdown: mixedTarget, state: "pending" },
      }
      expect(
        await Effect.runPromise(
          readPublicationMarkdownMatches(
            saved,
            mixedActual,
            local(mixedTarget),
            f.api,
            phase,
            mapping,
            mode !== "fast",
          ),
        ),
      ).toBe(true)
      if (mode === "structure") expect(f.calls).toContain(inventoryPath)
      else expect(f.calls).toEqual([])
    },
  )

  test(
    "external URL proof binds the retained path to the caller target through " + mode,
    async () => {
      const saved = intent(mixedTarget)
      const differentTarget = mixedTarget.replace("(README.md)", "(other.md)")
      const actual = mixedActual.replace("(https://README.md)", "(https://other.md)")
      expect(local(differentTarget)).not.toBe(local(mixedTarget))
      expect(samePublishedMarkdown(local(actual), local(differentTarget))).toBe(true)
      const f = reader(actual)
      expect(
        await Effect.runPromise(
          readPublicationMarkdownMatches(
            saved,
            actual,
            local(differentTarget),
            f.api,
            proofPhase(mode, actual),
            mapping,
            mode !== "fast",
          ),
        ),
      ).toBe(false)
    },
  )
}

test("a cached structure proof rechecks the external target on every comparison", async () => {
  const f = reader(mixedActual)
  const phase = publicationReadPhase()
  expect(
    await Effect.runPromise(
      readPublicationMarkdownMatches(
        intent(mixedTarget),
        mixedActual,
        local(mixedTarget),
        f.api,
        phase,
        mapping,
        true,
      ),
    ),
  ).toBe(true)
  expect(phase.proofs.get(page)?.strict_structure).toBe(true)
  const readCount = f.calls.length
  const changedTarget = mixedTarget.replace("(http://SKILL.md)", "(https://SKILL.md)")
  expect(local(changedTarget)).toBe(local(mixedTarget))
  expect(
    await Effect.runPromise(
      readPublicationMarkdownMatches(
        intent(changedTarget),
        mixedActual,
        local(changedTarget),
        f.api,
        phase,
        mapping,
        true,
      ),
    ),
  ).toBe(false)
  expect(f.calls).toHaveLength(readCount)
})

test("a whole-body update must retain its exact before guard for the external proof", async () => {
  const target = "Read [SKILL.md](http://SKILL.md)."
  const actual = "Read [SKILL.md](https://SKILL.md)."
  const saved: Receipt["intents"][number] = {
    path: markdownPath,
    method: "PATCH",
    status: "completed",
    body: {
      type: "update_content",
      update_content: { content_updates: [{ old_str: "Before.", new_str: target }] },
    },
    guards: { [markdownPath]: "Before." },
  }
  for (const candidate of [saved, { ...saved, guards: { [markdownPath]: "Different before." } }]) {
    const f = reader(actual)
    expect(
      await Effect.runPromise(
        readPublicationMarkdownMatches(
          candidate,
          actual,
          local(target),
          f.api,
          publicationReadPhase(),
          mapping,
        ),
      ),
    ).toBe(false)
  }
  const f = reader(target)
  expect(
    await Effect.runPromise(
      readPublicationMarkdownMatches(
        saved,
        target,
        local(target),
        f.api,
        publicationReadPhase(),
        mapping,
      ),
    ),
  ).toBe(true)
})

test("external preservation is an explicit comparison option and keeps typed page mapping", () => {
  const markdown = "[SKILL.md](http://SKILL.md) and [example.com](https://example.com)"
  expect(local(markdown)).toBe("[SKILL.md](SKILL.md) and example.com")
  expect(mapping.preserveExternal(markdown)).toBe(markdown)
  const mention = '<mention-page url="' + typedURL + '">Guide</mention-page>'
  expect(mapping.preserveExternal(mention)).toBe(local(mention))
  expect(mapping.preserveExternal(mention)).not.toBe(mention)
})

test("the shared external proof preserves a raw horizontal rule without erasing URL or body changes", () => {
  const target = "Before\n\n****\n\nAfter\n\n[site](https://example.test/x)"
  expect(samePublishedMarkdown(target, target)).toBe(true)
  expect(publicationExternalLinksMatch(target, target, mapping.preserveExternal)).toBe(true)
  expect(
    publicationExternalLinksMatch(
      target.replace("https://example.test/x", "http://example.test/x"),
      target,
      mapping.preserveExternal,
    ),
  ).toBe(false)
  expect(
    publicationExternalLinksMatch(target.replace("\n\n****", ""), target, mapping.preserveExternal),
  ).toBe(false)
})

for (const target of [
  "Read ![guide](http://SKILL.md).",
  "Read ![example.com](http://example.com).",
  "<a href=http://SKILL.md>Read</a>",
  "<img src=http://SKILL.md>",
]) {
  test("external URL proof protects image or HTML destinations: " + target, async () => {
    const actual = target.replace("http://", "https://")
    expect(samePublishedMarkdown(actual, target)).toBe(false)
    expect(samePublishedMarkdown(local(actual), local(target))).toBe(true)
    expect(publicationExternalLinksMatch(target, target, mapping.preserveExternal)).toBe(true)
    expect(publicationExternalLinksMatch(actual, target, mapping.preserveExternal)).toBe(false)
    const f = reader(actual)
    expect(
      await Effect.runPromise(
        readPublicationMarkdownMatches(
          intent(target),
          actual,
          local(target),
          f.api,
          publicationReadPhase(),
          mapping,
        ),
      ),
    ).toBe(false)
  })
}
