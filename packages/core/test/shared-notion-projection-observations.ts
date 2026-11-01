// Sanitized direct Notion API observations, captured 2026-11-01.
// This fixture is independent of the authoring projector.
export const notionV2Observations = [
  {
    case: "native-create-observed-v2",
    markdown_version: "v2",
    notion_version: "2026-03-11",
    request_markdown:
      "# Native acceptance\n\nAcceptance marker NativeCanaryAlpha20261101.\n\nRead the supporting file at `references/guide.md`.",
    response_markdown:
      "Acceptance marker NativeCanaryAlpha20261101.\n\nRead the supporting file at <code>references/guide.md</code>.",
    truncated: false,
    unknown_block_ids: [],
    warnings: [],
  },
  {
    case: "prefix-probe",
    markdown_version: "v2",
    notion_version: "2026-03-11",
    request_markdown:
      "# Transport title\n\n# Preserved heading\n\nParagraph with `references/guide.md` and **bold** and *italic*.\n\n## Subheading\n\n- First item\n- Second item\n\n```js\nconst value = 1\n```",
    response_markdown:
      "# Transport title\n\n# Preserved heading\n\nParagraph with <code>references/guide.md</code> and <b>bold</b> and <i>italic</i>.\n\n## Subheading\n\n- First item\n- Second item\n\n```javascript\nconst value = 1\n```",
    truncated: false,
    unknown_block_ids: [],
    warnings: [],
  },
  {
    case: "datasource-probe",
    markdown_version: "v2",
    notion_version: "2026-03-11",
    request_markdown:
      "# Native acceptance\n\nAcceptance marker NativeCanaryAlpha20261101.\n\nRead the supporting file at `references/guide.md`.",
    response_markdown:
      "Acceptance marker NativeCanaryAlpha20261101.\n\nRead the supporting file at <code>references/guide.md</code>.",
    truncated: false,
    unknown_block_ids: [],
    warnings: [],
  },
  {
    case: "double-h1-ds",
    markdown_version: "v2",
    notion_version: "2026-03-11",
    request_markdown:
      "# Transport title\n\n# Native acceptance\n\nParagraph with `references/guide.md` and **bold `code` bold** and *italic* and ~~strike~~.\n\nCode with symbols: `a < b & c > d` and ``a`b``.\n\n[External](https://example.com) and [Local](references/guide.md).\n\n## Subheading\n\n- First item\n- Second item\n\n- [ ] Todo item\n- [x] Done item\n\n1. First numbered\n2. Second numbered\n\n```js\nconst value = 1\n```\n\n```\nliteral <angle> & text\n```\n\n| Key | Value |\n| --- | --- |\n| Name | Value |",
    response_markdown:
      "# Transport title\n\n# Native acceptance\n\nParagraph with <code>references/guide.md</code> and <b>bold </b><b><code>code</code></b><b> bold</b> and <i>italic</i> and <s>strike</s>.\n\nCode with symbols: <code>a < b & c > d</code> and <code>a`b</code>.\n\n[External](https://example.com) and [Local](references/guide.md).\n\n## Subheading\n\n- First item\n- Second item\n\n- [ ] Todo item\n- [x] Done item\n\n1. First numbered\n2. Second numbered\n\n```javascript\nconst value = 1\n```\n\n```javascript\nliteral <angle> & text\n```\n\n| Key | Value |\n| --- | --- |\n| Name | Value |",
    truncated: false,
    unknown_block_ids: [],
    warnings: [],
  },
  {
    case: "xml-h1-ds",
    markdown_version: "v2",
    notion_version: "2026-03-11",
    request_markdown:
      "<h1>Native acceptance</h1>\n\nParagraph with `references/guide.md` and **bold `code` bold** and *italic* and ~~strike~~.\n\nCode with symbols: `a < b & c > d` and ``a`b``.\n\n[External](https://example.com) and [Local](references/guide.md).\n\n## Subheading\n\n- First item\n- Second item\n\n- [ ] Todo item\n- [x] Done item\n\n1. First numbered\n2. Second numbered\n\n```js\nconst value = 1\n```\n\n```\nliteral <angle> & text\n```\n\n| Key | Value |\n| --- | --- |\n| Name | Value |",
    response_markdown:
      "# Native acceptance\n\nParagraph with <code>references/guide.md</code> and <b>bold </b><b><code>code</code></b><b> bold</b> and <i>italic</i> and <s>strike</s>.\n\nCode with symbols: <code>a < b & c > d</code> and <code>a`b</code>.\n\n[External](https://example.com) and [Local](references/guide.md).\n\n## Subheading\n\n- First item\n- Second item\n\n- [ ] Todo item\n- [x] Done item\n\n1. First numbered\n2. Second numbered\n\n```javascript\nconst value = 1\n```\n\n```javascript\nliteral <angle> & text\n```\n\n| Key | Value |\n| --- | --- |\n| Name | Value |",
    truncated: false,
    unknown_block_ids: [],
    warnings: [],
  },
  {
    case: "explicit-languages-ds",
    markdown_version: "v2",
    notion_version: "2026-03-11",
    request_markdown:
      "<h1>Explicit languages</h1>\n\n```text\nliteral <angle> & text\n```\n\n```plaintext\nliteral <angle> & text\n```\n\n```plain text\nliteral <angle> & text\n```",
    response_markdown:
      "# Explicit languages\n\n```txt\nliteral <angle> & text\n```\n\n```txt\nliteral <angle> & text\n```\n\n```txt\nliteral <angle> & text\n```",
    truncated: false,
    unknown_block_ids: [],
    warnings: [],
  },
] as const
