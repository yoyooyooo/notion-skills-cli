# Notion Markdown conversion

This private workspace package restores Notion's enhanced Markdown for local
consumers and compares a complete readback against the submitted Markdown. It
contains pure functions, depends only on `marked`, and performs no I/O.

```ts
import { fromNotionMarkdown, sameNotionMarkdown } from "@notion-skills-cli/markdown"

const localMarkdown = fromNotionMarkdown(readback)
const matches = sameNotionMarkdown(readback, submitted)
```

## Comparison contract

The comparison accepts supported representation changes: block spacing, prose
line breaks, HTML table serialization, details/summary wrappers, split emphasis
and links, and a bare domain becoming an automatic link. It restores repeated
tab-indented fences and paragraphs within a list item without discarding code
indentation. Normalization is idempotent.

Words, heading/list structure, explicit link destinations, and fenced code
contents remain significant. Both sides having explicit links never permits a
scheme, port, query, fragment, or destination change. Unknown HTML is retained
and compared rather than silently discarded. Ambiguous/unclosed list fences are
left unchanged instead of borrowing another item's close.

The comparator is directional: its first argument is the readback. Existing
Notion compatibility includes a default `javascript` code language for an
unlabeled authored fence, and `<br>` wrapping inside inline code. Fenced code
does not use either prose cleanup or inline-code break normalization.

`markdownStructure` and `sameMarkdownStructure` let an application apply its own
document projection before using the same syntax comparison. In this repository,
core owns Notion page URL aliases, `<page>` mentions, `skill://` identities,
typed-link order, and publication conflicts. None of those policies belong here.

`fromNotionMarkdown` can receive projected block boundaries to disambiguate
quote/paragraph boundaries. Core validates and projects the Notion API inventory;
this package only consumes those plain data hints. Missing or contradictory hints
do not authorize guessed boundaries.

`visibleMarkdownText` uses the same syntax tree for link correspondence and omits
fenced/indented code. `visibleNotionText` projects the documented wrappers and
break artifacts from already-decoded rich text without parsing it as Markdown.
These visible-text projections are not a replacement for complete-body comparison.

## Verification

```sh
bun test packages/markdown/test packages/core/test/markdown.test.ts
node node_modules/vitest/vitest.mjs run --config vitest.config.ts packages/core/test/typed-links.node.test.ts
```

The retained `brand-marks` fixtures omit publication operation markers. Tests
check the entire body, repeated fences, code tabs/blank lines, idempotence, and
changed words, commands, destinations, and literal characters.

Official format references:

- https://developers.notion.com/guides/data-apis/working-with-markdown-content
- https://developers.notion.com/guides/data-apis/enhanced-markdown
- https://developers.notion.com/reference/retrieve-page-markdown
