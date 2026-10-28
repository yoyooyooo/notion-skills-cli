import { expect, test } from "bun:test"
import { decode, property } from "../src/model.ts"
import { PublicationReceiptSchema, type Receipt } from "../src/publication-model.ts"
import {
  blockObservation,
  blockPatchRecovery,
  copy,
  metadata,
  observation,
  publicationGuardRoles,
  publicationMarkdownMatches,
} from "../src/publication-observation.ts"

const page = "11111111-1111-4111-8111-111111111111"
const block = "22222222-2222-4222-8222-222222222222"
const parent = "33333333-3333-4333-8333-333333333333"
const dependency = "44444444-4444-4444-8444-444444444444"
const blockPath = `v1/blocks/${block}`
const pagePath = `v1/pages/${page}`
const originalURL = `https://www.notion.so/${dependency.replaceAll("-", "")}`
const expectedURL = `${originalURL}#ntn-skills-path=references%2Fguide.md`

function rawBlock(url = originalURL) {
  return {
    object: "block",
    id: block,
    type: "paragraph",
    parent: { type: "page_id", page_id: page },
    created_time: "created",
    created_by: { id: "author" },
    last_edited_time: "before",
    last_edited_by: { id: "author" },
    has_children: false,
    archived: false,
    in_trash: false,
    paragraph: {
      color: "default",
      rich_text: [
        {
          type: "text",
          text: { content: "Guide", link: { url } },
          plain_text: "Guide",
          href: url,
          annotations: {
            bold: false,
            italic: false,
            strikethrough: false,
            underline: false,
            code: false,
            color: "default",
          },
        },
        { type: "text", text: { content: " unchanged", link: null }, plain_text: " unchanged" },
      ],
    },
  }
}

function fixture() {
  const guards: Record<string, unknown> = {
    [blockPath]: observation(blockPath, rawBlock()),
    [pagePath]: metadata({
      id: page,
      parent: { type: "data_source_id", data_source_id: "ds" },
      properties: {},
      last_edited_time: "before",
    }),
    [`${pagePath}/markdown`]: `[Guide](${originalURL}) unchanged`,
  }
  const receipt: Receipt = {
    format: 1,
    operation_id: "p_block-recovery",
    operation: "write",
    scope: "scope",
    database_id: "database",
    data_source_id: "ds",
    page_id: page,
    state: "unknown",
    portable: {
      kind: "skill",
      name: "sample",
      description: "Use for tests.",
      main: "SKILL.md",
      files: [],
    },
    guards,
    intents: [],
    stages: [],
  }
  const intent: Receipt["intents"][number] = {
    path: blockPath,
    method: "PATCH",
    body: {
      paragraph: {
        rich_text: [
          { type: "text", text: { content: "Guide", link: { url: expectedURL } } },
          { type: "text", text: { content: " unchanged" } },
        ],
      },
    },
    guards: copy(guards),
    status: "unknown",
  }
  receipt.intents.push(intent)
  const actual = copy(guards)
  actual[blockPath] = observation(blockPath, {
    ...rawBlock(expectedURL),
    last_edited_time: "after",
  })
  actual[pagePath] = { ...property(guards[pagePath]), last_edited_time: "after" }
  return { receipt, intent, actual }
}

test("individual block observation ignores envelopes but retains link URL and content authority", () => {
  const before = blockObservation(rawBlock())
  const changedEnvelope = blockObservation({
    ...rawBlock(),
    created_time: "other",
    request_id: "new",
  })
  expect(changedEnvelope).toEqual(before)
  expect(blockObservation(rawBlock(expectedURL))).not.toEqual(before)
  expect(property(property(before.paragraph).rich_text).plain_text).toBeUndefined()
  expect(before.paragraph).toEqual({
    color: "default",
    rich_text: [
      { type: "text", text: { content: "Guide", link: { url: originalURL } } },
      { type: "text", text: { content: " unchanged" } },
    ],
  })
})

test("unknown block PATCH settles only exact whole supplied fields and leaves original intent intact", () => {
  const f = fixture()
  const retained = copy(f.intent)
  const recovery = blockPatchRecovery(f.intent, f.receipt, f.actual)
  expect(recovery.outcome).toBe("success")
  if (recovery.outcome !== "success") throw new Error("Expected exact block convergence")
  expect(recovery.ownerPath).toBe(pagePath)
  expect(recovery.guards[blockPath]).toEqual(f.actual[blockPath])
  expect(recovery.guards[pagePath]).toEqual(f.actual[pagePath])
  expect(f.intent).toEqual(retained)
})

test("unchanged original block stays unknown rather than authorizing a blind replay", () => {
  const f = fixture()
  f.actual[blockPath] = f.intent.guards![blockPath]
  expect(blockPatchRecovery(f.intent, f.receipt, f.actual).outcome).toBe("unknown")
  expect(f.intent.status).toBe("unknown")
})

test("whole rich-text comparison rejects truncated arrays, changed text, annotations and extra fields", () => {
  for (const edit of ["truncated", "text", "annotation", "color", "parent"] as const) {
    const f = fixture()
    const raw = rawBlock(expectedURL)
    if (edit === "truncated") raw.paragraph.rich_text.pop()
    if (edit === "text") raw.paragraph.rich_text[1]!.text.content = " foreign edit"
    if (edit === "annotation") raw.paragraph.rich_text[0]!.annotations!.bold = true
    if (edit === "color") raw.paragraph.color = "red"
    if (edit === "parent") raw.parent.page_id = dependency
    f.actual[blockPath] = observation(blockPath, raw)
    expect(blockPatchRecovery(f.intent, f.receipt, f.actual).outcome).toBe("conflict")
  }
})

test("non-default annotations normalize defaults without dropping edit authority", () => {
  const f = fixture()
  const raw = rawBlock(expectedURL)
  raw.paragraph.rich_text[0]!.annotations!.bold = true
  const body = copy(property(f.intent.body))
  const richText = property(body.paragraph).rich_text as Array<Record<string, unknown>>
  richText[0]!.annotations = { bold: true }
  const intent = { ...f.intent, body }
  f.actual[blockPath] = observation(blockPath, raw)
  expect(blockPatchRecovery(intent, f.receipt, f.actual).outcome).toBe("success")
})

test("original owner body and unrequested metadata remain mandatory guards", () => {
  for (const edit of [
    "body",
    "metadata",
    "missing-body",
    "missing-guard",
    "missing-readback",
  ] as const) {
    const f = fixture()
    if (edit === "body") f.actual[`${pagePath}/markdown`] = "External body edit"
    if (edit === "metadata")
      f.actual[pagePath] = { ...property(f.actual[pagePath]), archived: true }
    if (edit === "missing-body") delete f.actual[`${pagePath}/markdown`]
    const intent = edit === "missing-guard" ? { ...f.intent, guards: undefined } : f.intent
    if (edit === "missing-readback") delete f.actual[blockPath]
    expect(blockPatchRecovery(intent, f.receipt, f.actual).outcome).toBe(
      edit === "body" || edit === "metadata" ? "conflict" : "unknown",
    )
  }
})

test("nested ownership requires retained ancestor blocks without broadening child inventory", () => {
  const f = fixture()
  const parentPath = `v1/blocks/${parent}`
  const nested = { ...rawBlock(), parent: { type: "block_id", block_id: parent } }
  const ancestor = { ...rawBlock(), id: parent, has_children: true }
  const guards = f.intent.guards! as Record<string, unknown>
  guards[blockPath] = observation(blockPath, nested)
  guards[parentPath] = observation(parentPath, ancestor)
  f.actual[blockPath] = observation(blockPath, {
    ...nested,
    paragraph: rawBlock(expectedURL).paragraph,
  })
  f.actual[parentPath] = observation(parentPath, { ...ancestor, last_edited_time: "after" })
  expect(blockPatchRecovery(f.intent, f.receipt, f.actual).outcome).toBe("success")
  delete f.actual[parentPath]
  expect(blockPatchRecovery(f.intent, f.receipt, f.actual).outcome).toBe("unknown")
  expect(
    observation(`v1/blocks/${page}/children?page_size=100`, {
      results: [rawBlock(), { id: dependency, type: "child_page", child_page: { title: "Guide" } }],
      has_more: false,
      next_cursor: null,
    }),
  ).toEqual({
    results: [{ id: dependency, type: "child_page", child_page: { title: "Guide" } }],
    has_more: false,
    next_cursor: null,
  })
})

test("a read-only dependency block cannot gain mutation authority from individual GETs", () => {
  const f = fixture()
  const receipt = { ...f.receipt, context: { members: [dependency] } }
  const nested = { ...rawBlock(), parent: { type: "page_id", page_id: dependency } }
  const guards = f.intent.guards! as Record<string, unknown>
  guards[blockPath] = observation(blockPath, nested)
  f.actual[blockPath] = observation(blockPath, {
    ...nested,
    paragraph: rawBlock(expectedURL).paragraph,
  })
  expect(publicationGuardRoles(receipt).ownedMutationTargets.has(`v1/pages/${dependency}`)).toBe(
    false,
  )
  expect(blockPatchRecovery(f.intent, receipt, f.actual).outcome).toBe("unknown")
})

test("receipt schema retains pending typed repair with original markdown and immutable mutation body", () => {
  const f = fixture()
  f.intent.typed_links = {
    page_id: page,
    markdown: "[Guide](references/guide.md)",
    state: "pending",
  }
  const decoded = decode(PublicationReceiptSchema, f.receipt)
  expect(decoded.intents[0]!.typed_links).toEqual(f.intent.typed_links)
  expect(decoded.intents[0]!.body).toEqual(f.intent.body)
  expect(decoded.intents[0]!.guards).toEqual(f.intent.guards)
})

test("pending typed repairs can recognize stripped Markdown without claiming final typed-link verification", () => {
  const f = fixture()
  const target = `[Guide](${expectedURL}) unchanged`
  const actual = `[Guide](https://www.notion.so/${dependency.replaceAll("-", "")}) unchanged`
  f.intent.typed_links = { page_id: page, markdown: target, state: "pending" }
  expect(publicationMarkdownMatches(f.intent, actual, target)).toBe(true)
  expect(publicationMarkdownMatches(f.intent, actual.replace("Guide", "Foreign"), target)).toBe(
    false,
  )
  expect(
    publicationMarkdownMatches(f.intent, `[Guide](${originalURL}#wrong) unchanged`, target),
  ).toBe(false)
  f.intent.typed_links.state = "completed"
  expect(publicationMarkdownMatches(f.intent, actual, target)).toBe(false)
})

test("provisional transport matching preserves URL queries and distinguishes authored paths to the same page", () => {
  const f = fixture()
  const otherURL = `${originalURL}#ntn-skills-path=references%2Fother.md`
  const target = `[Guide](${expectedURL}) [Other](${otherURL})`
  f.intent.typed_links = { page_id: page, markdown: target, state: "pending" }
  expect(
    publicationMarkdownMatches(f.intent, `[Guide](${originalURL}) [Other](${originalURL})`, target),
  ).toBe(true)
  expect(
    publicationMarkdownMatches(f.intent, `[Guide](${otherURL}) [Other](${expectedURL})`, target),
  ).toBe(false)
  expect(
    publicationMarkdownMatches(
      f.intent,
      `[Guide](${originalURL}?foreign=yes) [Other](${originalURL})`,
      target,
    ),
  ).toBe(false)
})

test("exact original block permits a separately journaled retry only after every original guard matches", () => {
  const f = fixture()
  Object.assign(f.actual, copy(f.intent.guards!))
  const recovery = blockPatchRecovery(f.intent, f.receipt, f.actual, true)
  expect(recovery.outcome).toBe("retry")
  if (recovery.outcome !== "retry") throw new Error("Expected guarded retry")
  expect(recovery.skip).toBe(false)
  expect(f.intent.status).toBe("unknown")
  f.actual[pagePath] = { ...property(f.actual[pagePath]), last_edited_time: "foreign" }
  expect(blockPatchRecovery(f.intent, f.receipt, f.actual, true).outcome).toBe("conflict")
})

test("obsolete code language alias is known not applied and skipped rather than claimed applied", () => {
  const f = fixture()
  const raw = { ...rawBlock(), type: "code", code: { language: "markdown", rich_text: [] } }
  const guards = f.intent.guards! as Record<string, unknown>
  guards[blockPath] = observation(blockPath, raw)
  Object.assign(f.actual, copy(guards))
  const intent = { ...f.intent, body: { code: { language: "md" } } }
  const recovery = blockPatchRecovery(intent, f.receipt, f.actual, true)
  expect(recovery.outcome).toBe("retry")
  if (recovery.outcome !== "retry") throw new Error("Expected obsolete alias classification")
  expect(recovery.skip).toBe(true)
  expect(intent.status).toBe("unknown")
})

test("official Markdown code language and prose pipe escaping preserve pending transport identity", () => {
  const f = fixture()
  const target = `[A](${expectedURL}) | [B](${expectedURL})\n\n\`\`\`md\n[B](skill://example/assets/data.txt)\n\`\`\``
  const actual = `[A](${originalURL}) \\| [B](${originalURL})\n\n\`\`\`markdown\n[B](skill://example/assets/data.txt)\n\`\`\``
  f.intent.typed_links = { page_id: page, markdown: target, state: "pending" }
  expect(publicationMarkdownMatches(f.intent, actual, target)).toBe(true)
  expect(
    publicationMarkdownMatches(f.intent, actual.replace("data.txt", "foreign.txt"), target),
  ).toBe(false)
})

test("Notion's default javascript label matches an unlabeled fence and nothing else", () => {
  const f = fixture()
  const target = "```\noutline\n```\n\n```bash\necho ready\n```"
  expect(
    publicationMarkdownMatches(
      f.intent,
      "```javascript\noutline\n```\n\n```bash\necho ready\n```",
      target,
    ),
  ).toBe(true)
  expect(
    publicationMarkdownMatches(
      f.intent,
      "```javascript\nother\n```\n\n```bash\necho ready\n```",
      target,
    ),
  ).toBe(false)
  expect(
    publicationMarkdownMatches(
      f.intent,
      "```javascript\noutline\n```\n\n```python\necho ready\n```",
      target,
    ),
  ).toBe(false)
  expect(
    publicationMarkdownMatches(
      f.intent,
      "```\nconst value = 1\n```",
      "```javascript\nconst value = 1\n```",
    ),
  ).toBe(false)
})
