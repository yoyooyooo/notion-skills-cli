import { expect, test } from "bun:test"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect } from "effect"
import type { Snapshot } from "../src/model.ts"
import { canonicalMain, type PortableSkill } from "../src/portable.ts"
import { referencePagesMatch } from "../src/reference-mutation.ts"
import type { NotionBlockBoundary } from "../src/markdown.ts"
import { creationMarker, type CreationProof } from "../src/publication-create-identity.ts"

const root = "11111111-1111-4111-8111-111111111111"
const name = "Page comparison"
const description = "Verify the complete submitted page graph."
const encode = (value: string) => new TextEncoder().encode(value)
const run = <A, E>(operation: Effect.Effect<A, E, NodeServices.NodeServices>) =>
  Effect.runPromise(operation.pipe(Effect.provide(NodeServices.layer)))

function fixture(body: string, references: Readonly<Record<string, string>> = {}) {
  const portable: PortableSkill = {
    kind: "skill",
    name,
    description,
    main: "SKILL.md",
    files: [
      canonicalMain(name, description, body, {
        path: "SKILL.md",
        bytes: new Uint8Array(),
      }),
      ...Object.entries(references).map(([path, content]) => ({
        path,
        bytes: encode(content),
      })),
    ],
  }
  const snapshot: Snapshot = {
    snapshot_id: "s_reference_comparison",
    scope: "test",
    version_id: "test",
    created_at: 0,
    entrypoint: "SKILL.md",
    record: {
      id: `notion_page:${root}`,
      kind: "skill",
      locator: {
        type: "notion_page",
        page_id: root,
        database_id: "db",
        data_source_id: "ds",
      },
      name,
      alias: "page-comparison",
      description,
      default_context: false,
      entrypoint: "SKILL.md",
      ref: `skill://${root}/SKILL.md`,
    },
    files: [],
    references: [
      { id: root, path: "SKILL.md", markdown: body },
      ...Object.entries(references).map(([path, markdown], index) => ({
        id: `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`,
        path,
        markdown,
      })),
    ],
  }
  return { portable, snapshot }
}

async function expectDifferent(snapshot: Snapshot, portable: PortableSkill) {
  const result = await run(referencePagesMatch(snapshot, portable).pipe(Effect.result))
  expect(result._tag).toBe("Failure")
  if (result._tag === "Failure") expect(result.failure.code).toBe("WRITE_VERIFICATION_FAILED")
}

test("final reference comparison accepts the complete unchanged authored graph", async () => {
  const f = fixture("# Instructions\n\nKeep the complete graph.\n", {
    "references/guide.md": "# Guide\n\nKeep this unlinked reference.\n",
  })
  expect(await run(referencePagesMatch(f.snapshot, f.portable))).toBe(true)
})

test("final reference comparison preserves the original terminal line break of indented code", async () => {
  const f = fixture("Introduction.\n\n    keep code literal\n")
  expect(await run(referencePagesMatch(f.snapshot, f.portable))).toBe(true)
  await expectDifferent(
    {
      ...f.snapshot,
      references: f.snapshot.references!.map((page) => ({
        ...page,
        markdown: "Introduction.\n    keep code literal\n",
      })),
    },
    f.portable,
  )
})

const referenceProof: CreationProof = {
  version: 1,
  operation_token: "44444444-4444-4444-8444-444444444444",
  operation_id: "p_reference_creation_framing",
  intent_index: 1,
  scope: "test",
  database_id: "db",
  data_source_id: "ds",
  role: "reference",
  path: "references/review.md",
  parent_type: "page_id",
  parent_id: root,
  intended_hash: "a".repeat(64),
  source_sha256: "b".repeat(64),
}
const markerSpan = (text: string, bold = false) => ({ text, link: null, bold, code: false })

function creationFramedReference() {
  const source =
    "# Review\n\nKeep the context.\n\n0. **Check structure.** Keep it simple.\n\n1. **Check proof.** Keep it exact.\n\n## Result\n\nPreserve every instruction.\n"
  const actual =
    "# Review\nKeep the context.\n0. **Check structure.** Keep it simple.\n1. **Check proof.** Keep it exact.\n## Result\nPreserve every instruction.\n"
  const f = fixture("# Main\n", { [referenceProof.path]: source })
  const marker = creationMarker(referenceProof)
  // Notion may split the marker into several plain spans and escape its colons.
  const blocks: readonly NotionBlockBoundary[] = [
    {
      id: "creation-marker",
      type: "paragraph",
      has_children: false,
      text: marker,
      rich_text: [
        markerSpan("ntn-skills-create"),
        markerSpan(":v1:"),
        markerSpan(marker.slice("ntn-skills-create:v1:".length)),
      ],
    },
    {
      id: "review-heading",
      type: "heading_1",
      has_children: false,
      text: "Review",
      rich_text: [markerSpan("Review")],
    },
    {
      id: "context",
      type: "paragraph",
      has_children: false,
      text: "Keep the context.",
      rich_text: [markerSpan("Keep the context.")],
    },
    {
      id: "zero",
      type: "paragraph",
      has_children: false,
      text: "0. Check structure. Keep it simple.",
      rich_text: [
        markerSpan("0. "),
        markerSpan("Check structure.", true),
        markerSpan(" Keep it simple."),
      ],
    },
    {
      id: "one",
      type: "paragraph",
      has_children: false,
      text: "1. Check proof. Keep it exact.",
      rich_text: [
        markerSpan("1. "),
        markerSpan("Check proof.", true),
        markerSpan(" Keep it exact."),
      ],
    },
    {
      id: "result-heading",
      type: "heading_2",
      has_children: false,
      text: "Result",
      rich_text: [markerSpan("Result")],
    },
    {
      id: "result",
      type: "paragraph",
      has_children: false,
      text: "Preserve every instruction.",
      rich_text: [markerSpan("Preserve every instruction.")],
    },
  ]
  const snapshot: Snapshot = {
    ...f.snapshot,
    references: f.snapshot.references!.map((page) =>
      page.path === referenceProof.path
        ? { ...page, markdown: `${marker.replaceAll(":", "\\:")}\n${actual}`, blocks }
        : page,
    ),
  }
  const withReference = (
    update: (
      page: NonNullable<Snapshot["references"]>[number],
    ) => NonNullable<Snapshot["references"]>[number],
  ): Snapshot => ({
    ...snapshot,
    references: snapshot.references!.map((page) =>
      page.path === referenceProof.path ? update(page) : page,
    ),
  })
  return { ...f, snapshot, marker, withReference }
}

test("reference creation framing preserves source-bound zero-list readback and every source byte", async () => {
  const f = creationFramedReference()
  const before = JSON.stringify({ snapshot: f.snapshot, portable: f.portable })
  expect(await run(referencePagesMatch(f.snapshot, f.portable))).toBe(true)
  expect(JSON.stringify({ snapshot: f.snapshot, portable: f.portable })).toBe(before)
  await expectDifferent(
    f.withReference((page) => ({ ...page, blocks: undefined })),
    f.portable,
  )
})

test("reference creation framing requires the complete matching flat marker paragraph", async () => {
  const f = creationFramedReference()
  const wrongMarker = creationMarker({ ...referenceProof, operation_id: "p_another_operation" })
  const invalidFirst = [
    { text: wrongMarker, rich_text: [markerSpan(wrongMarker)] },
    { type: "quote" },
    { has_children: true },
    { rich_text: undefined },
    { rich_text: [markerSpan(f.marker.slice(0, -1))] },
    { rich_text: [{ ...markerSpan(f.marker), link: "https://example.com" }] },
    { rich_text: [markerSpan(f.marker, true)] },
  ] satisfies ReadonlyArray<Partial<NotionBlockBoundary>>
  for (const change of invalidFirst) {
    await expectDifferent(
      f.withReference((page) => ({
        ...page,
        blocks: page.blocks!.map((block, index) => (index === 0 ? { ...block, ...change } : block)),
      })),
      f.portable,
    )
  }
})

test("reference creation framing keeps every remaining physical root in the source proof", async () => {
  const f = creationFramedReference()
  const extra: NotionBlockBoundary = {
    id: "unsubmitted-physical-root",
    type: "paragraph",
    has_children: false,
    text: "Extra content.",
    rich_text: [markerSpan("Extra content.")],
  }
  for (const beforeMarker of [false, true]) {
    await expectDifferent(
      f.withReference((page) => ({
        ...page,
        blocks: beforeMarker ? [extra, ...page.blocks!] : [...page.blocks!, extra],
      })),
      f.portable,
    )
  }
  await expectDifferent(
    f.withReference((page) => ({
      ...page,
      blocks: page.blocks!.map((block, index) =>
        index === 1 ? { ...block, id: page.blocks![0]!.id } : block,
      ),
    })),
    f.portable,
  )
})

test("reference creation framing cannot hide changed prose or a changed literal zero", async () => {
  const f = creationFramedReference()
  for (const [before, after] of [
    ["Keep it simple.", "Drop the instruction."],
    ["0. ", "1. "],
  ]) {
    await expectDifferent(
      f.withReference((page) => ({
        ...page,
        markdown: page.markdown.replace(before!, after!),
        blocks: page.blocks!.map((block) => ({
          ...block,
          text: block.text?.replace(before!, after!),
          rich_text: block.rich_text?.map((span) => ({
            ...span,
            text: span.text.replace(before!, after!),
          })),
        })),
      })),
      f.portable,
    )
  }
})

test("a valid creation marker still permits ordinary reference comparison without block evidence", async () => {
  const f = fixture("# Main\n", { [referenceProof.path]: "Keep the complete reference.\n" })
  const snapshot: Snapshot = {
    ...f.snapshot,
    references: f.snapshot.references!.map((page) =>
      page.path === referenceProof.path
        ? { ...page, markdown: `${creationMarker(referenceProof)}\n\n${page.markdown}` }
        : page,
    ),
  }
  expect(await run(referencePagesMatch(snapshot, f.portable))).toBe(true)
})

for (const path of ["SKILL.md", "references/guide.md"]) {
  for (const [label, actual, target] of [
    [
      "an explicit filename URL changing scheme",
      "Read [SKILL.md](https://SKILL.md).\n",
      "Read [SKILL.md](http://SKILL.md).\n",
    ],
    [
      "an explicit host URL becoming plain text",
      "Read example.com.\n",
      "Read [example.com](https://example.com).\n",
    ],
  ] satisfies Array<[string, string, string]>) {
    test(`final reference comparison rejects ${label} in ${path}`, async () => {
      const f = fixture(path === "SKILL.md" ? target : "Read the guide.\n", {
        ...(path === "SKILL.md" ? {} : { [path]: target }),
      })
      const snapshot: Snapshot = {
        ...f.snapshot,
        references: f.snapshot.references!.map((page) =>
          page.path === path ? { ...page, markdown: actual } : page,
        ),
      }
      await expectDifferent(snapshot, f.portable)
    })
  }
}

test("final reference comparison rejects an expected unlinked reference missing from live pages", async () => {
  const f = fixture("Read the instructions.\n", {
    "references/guide.md": "# Guide\n\nThis reference must exist.\n",
  })
  await expectDifferent(
    { ...f.snapshot, references: f.snapshot.references!.slice(0, 1) },
    f.portable,
  )
})

test("final reference comparison rejects an unexpected live reference", async () => {
  const f = fixture("Read the instructions.\n")
  await expectDifferent(
    {
      ...f.snapshot,
      references: [
        ...f.snapshot.references!,
        {
          id: "33333333-3333-4333-8333-333333333333",
          path: "references/extra.md",
          markdown: "Extra.\n",
        },
      ],
    },
    f.portable,
  )
})

test("final reference comparison rejects duplicate live paths even when both bodies match", async () => {
  const f = fixture("Read the instructions.\n", {
    "references/guide.md": "# Guide\n",
  })
  await expectDifferent(
    {
      ...f.snapshot,
      references: [
        ...f.snapshot.references!,
        {
          ...f.snapshot.references![1]!,
          id: "33333333-3333-4333-8333-333333333333",
        },
      ],
    },
    f.portable,
  )
})

test("final reference comparison accepts actual Notion page links for the submitted relative file", async () => {
  const f = fixture("Read [guide](./references/guide.md).\n", {
    "references/guide.md": "# Guide\n",
  })
  const reference = f.snapshot.references![1]!
  expect(
    await run(
      referencePagesMatch(
        {
          ...f.snapshot,
          references: f.snapshot.references!.map((page) =>
            page.path === "SKILL.md"
              ? {
                  ...page,
                  markdown: `Read [guide](https://www.notion.so/${reference.id.replaceAll("-", "")}).\n`,
                }
              : page,
          ),
        },
        f.portable,
      ),
    ),
  ).toBe(true)
})

test("per-page fallback keeps relative paths equivalent when a different page changes the global identity", async () => {
  const f = fixture("Read SKILL.md.\n", {
    "references/guide.md": "Read [policy](policy.md).\n",
    "references/policy.md": "# Policy\n",
  })
  const policy = f.snapshot.references![2]!
  expect(
    await run(
      referencePagesMatch(
        {
          ...f.snapshot,
          references: f.snapshot.references!.map((page) => ({
            ...page,
            markdown:
              page.path === "SKILL.md"
                ? "Read [SKILL.md](http://SKILL.md).\n"
                : page.path === "references/guide.md"
                  ? `Read [policy](https://app.notion.com/p/${policy.id.replaceAll("-", "")}).\n`
                  : page.markdown,
          })),
        },
        f.portable,
      ),
    ),
  ).toBe(true)
})

test("final comparison preserves filename autolinks alongside a mapped reference on the same page", async () => {
  const body = "Read SKILL.md and EXTEND.md, then [guide](./references/guide.md).\n"
  const f = fixture(body, { "references/guide.md": "# Guide\n" })
  const reference = f.snapshot.references![1]!
  const href = `https://app.notion.com/p/${reference.id.replaceAll("-", "")}`
  const actual = `Read [SKILL.md](http://SKILL.md) and [EXTEND.md](http://EXTEND.md), then [guide](${href}).\n`
  const changed = (markdown: string): Snapshot => ({
    ...f.snapshot,
    references: f.snapshot.references!.map((page) =>
      page.path === "SKILL.md" ? { ...page, markdown } : page,
    ),
  })
  expect(await run(referencePagesMatch(changed(actual), f.portable))).toBe(true)
  await expectDifferent(
    changed(actual.replace(href, `https://www.notion.so/${root.replaceAll("-", "")}`)),
    f.portable,
  )

  const explicit = fixture(body.replace("SKILL.md", "[SKILL.md](https://SKILL.md)"), {
    "references/guide.md": "# Guide\n",
  })
  await expectDifferent(changed(actual), explicit.portable)
})

test("final comparison retains a relative filename alias together with a proved comment boundary", async () => {
  const authored =
    "Read [guide](UNKNOWN.md).\n\nKeep this note.\n\n<!-- workflow:ready -->\n```text\nkeep code literal\n```\n"
  const f = fixture(authored)
  const markdown =
    "Read [guide](http://UNKNOWN.md).\n\nKeep this note.\n\\<!-- workflow:ready --\\>\n```javascript\nkeep code literal\n```\n"
  const blocks = [
    {
      id: "paragraph",
      type: "paragraph",
      has_children: false,
      rich_text: [
        { text: "Read ", link: null, bold: false, code: false },
        { text: "guide", link: "http://UNKNOWN.md", bold: false, code: false },
        { text: ".", link: null, bold: false, code: false },
      ],
    },
    { id: "note", type: "paragraph", has_children: false, text: "Keep this note." },
    { id: "comment", type: "paragraph", has_children: false, text: "<!-- workflow:ready -->" },
    { id: "code", type: "code", has_children: false },
  ]
  const snapshot: Snapshot = {
    ...f.snapshot,
    references: [{ ...f.snapshot.references![0]!, markdown, blocks }],
  }
  expect(await run(referencePagesMatch(snapshot, f.portable))).toBe(true)
  await expectDifferent(
    {
      ...snapshot,
      references: [
        {
          ...snapshot.references![0]!,
          markdown: markdown.replace("workflow:ready", "workflow:changed"),
        },
      ],
    },
    f.portable,
  )
})

test("final reference comparison does not let a matching body authorize changed metadata", async () => {
  const f = fixture("Keep the instructions.\n")
  await expectDifferent(
    {
      ...f.snapshot,
      record: { ...f.snapshot.record, name: "Changed title" },
    },
    f.portable,
  )
})

test("final reference comparison carries complete block evidence into target-bound comment recovery", async () => {
  const f = fixture("Keep this note.\n\n<!-- retained note -->\n```text\nkeep code literal\n```\n")
  const snapshot: Snapshot = {
    ...f.snapshot,
    references: [
      {
        id: root,
        path: "SKILL.md",
        markdown:
          "Keep this note.\n\\<!-- retained note --\\>\n```javascript\nkeep code literal\n```\n",
        blocks: [
          {
            id: "paragraph-before",
            type: "paragraph",
            has_children: false,
            text: "Keep this note.",
          },
          {
            id: "paragraph-comment",
            type: "paragraph",
            has_children: false,
            text: "<!-- retained note -->",
          },
          { id: "code-after", type: "code", has_children: false },
        ],
      },
    ],
  }
  expect(await run(referencePagesMatch(snapshot, f.portable))).toBe(true)
  await expectDifferent(
    {
      ...snapshot,
      references: snapshot.references!.map((page) => ({
        ...page,
        blocks: page.blocks!.map((block) =>
          block.id === "paragraph-comment" ? { ...block, text: "<!-- changed note -->" } : block,
        ),
      })),
    },
    f.portable,
  )
  await expectDifferent(
    {
      ...snapshot,
      references: snapshot.references!.map((page) => ({
        ...page,
        markdown: page.markdown.replace("retained note", "changed note"),
        blocks: page.blocks!.map((block) =>
          block.id === "paragraph-comment" ? { ...block, text: "<!-- changed note -->" } : block,
        ),
      })),
    },
    f.portable,
  )
})

test("final reference comparison retains the exact reference header with ordered divider evidence", async () => {
  const f = fixture("# Main\n", {
    "references/setup.md": "---\nalpha: first\nbeta: second\n---\n\n# Setup\n",
  })
  const snapshot: Snapshot = {
    ...f.snapshot,
    references: f.snapshot.references!.map((page) =>
      page.path === "references/setup.md"
        ? {
            ...page,
            markdown: "---\nalpha: first<br>beta: second\n---\n# Setup\n",
            blocks: [
              { id: "divider-before", type: "divider", has_children: false },
              {
                id: "header-lines",
                type: "paragraph",
                has_children: false,
                text: "alpha: first\nbeta: second",
              },
              { id: "divider-after", type: "divider", has_children: false },
              { id: "heading-after", type: "heading_1", has_children: false },
            ],
          }
        : page,
    ),
  }
  expect(await run(referencePagesMatch(snapshot, f.portable))).toBe(true)
  await expectDifferent(
    {
      ...snapshot,
      references: snapshot.references!.map((page) =>
        page.path === "references/setup.md"
          ? {
              ...page,
              markdown: page.markdown.replace("beta: second", "beta: changed"),
            }
          : page,
      ),
    },
    f.portable,
  )
})

test("raw block recovery keeps filename autolinks intact until the authored comparison", async () => {
  const f = fixture("Read README.md.\n\nKeep this note.\n\n---\n\n# Next\n")
  const snapshot: Snapshot = {
    ...f.snapshot,
    references: [
      {
        id: root,
        path: "SKILL.md",
        markdown: "Read [README.md](http://README.md).\nKeep this note.\n---\n# Next\n",
        blocks: [
          { id: "linked-paragraph", type: "paragraph", has_children: false },
          {
            id: "note-paragraph",
            type: "paragraph",
            has_children: false,
            text: "Keep this note.",
          },
          { id: "divider-after-note", type: "divider", has_children: false },
          { id: "next-heading", type: "heading_1", has_children: false },
        ],
      },
    ],
  }
  expect(await run(referencePagesMatch(snapshot, f.portable))).toBe(true)
  await expectDifferent(
    {
      ...snapshot,
      references: snapshot.references!.map((page) => ({
        ...page,
        markdown: page.markdown.replace("http://README.md", "http://WRONG.md"),
      })),
    },
    f.portable,
  )
})
