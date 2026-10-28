import { expect, test } from "bun:test"
import { sourceRichTextRepairInlineMatches } from "../src/source-rich-text-repair-readback.ts"

const before = {
  actual:
    "**Built-ins available**: `this.helpers.httpRequest()` (no auth — the bare `$helpers` global is **undefined** in the task-runner sandbox, so `$helpers.httpRequest()` throws `ReferenceError: $helpers is not defined`), DateTime (Luxon), $`jmespath(). **Not available**: `this.helpers.httpRequestWithAuthentication` (deny-listed),`$env (when N8N_BLOCK_ENV_ACCESS_IN_NODE=true), require() (unless allowlisted). For anything beyond a trivial unauthenticated GET (auth, pagination, retries), prefer the **HTTP Request node** and keep Code nodes for pure logic.",
  spans: [
    {
      annotations: {
        bold: true,
        code: false,
        color: "default",
        italic: false,
        strikethrough: false,
        underline: false,
      },
      href: null,
      plain_text: "Built-ins available",
      text: {
        content: "Built-ins available",
        link: null,
      },
      type: "text",
    },
    {
      annotations: {
        bold: false,
        code: false,
        color: "default",
        italic: false,
        strikethrough: false,
        underline: false,
      },
      href: null,
      plain_text: ": ",
      text: {
        content: ": ",
        link: null,
      },
      type: "text",
    },
    {
      annotations: {
        bold: false,
        code: true,
        color: "default",
        italic: false,
        strikethrough: false,
        underline: false,
      },
      href: null,
      plain_text: "this.helpers.httpRequest()",
      text: {
        content: "this.helpers.httpRequest()",
        link: null,
      },
      type: "text",
    },
    {
      annotations: {
        bold: false,
        code: false,
        color: "default",
        italic: false,
        strikethrough: false,
        underline: false,
      },
      href: null,
      plain_text: " (no auth — the bare ",
      text: {
        content: " (no auth — the bare ",
        link: null,
      },
      type: "text",
    },
    {
      annotations: {
        bold: false,
        code: true,
        color: "default",
        italic: false,
        strikethrough: false,
        underline: false,
      },
      href: null,
      plain_text: "$helpers",
      text: {
        content: "$helpers",
        link: null,
      },
      type: "text",
    },
    {
      annotations: {
        bold: false,
        code: false,
        color: "default",
        italic: false,
        strikethrough: false,
        underline: false,
      },
      href: null,
      plain_text: " global is ",
      text: {
        content: " global is ",
        link: null,
      },
      type: "text",
    },
    {
      annotations: {
        bold: true,
        code: false,
        color: "default",
        italic: false,
        strikethrough: false,
        underline: false,
      },
      href: null,
      plain_text: "undefined",
      text: {
        content: "undefined",
        link: null,
      },
      type: "text",
    },
    {
      annotations: {
        bold: false,
        code: false,
        color: "default",
        italic: false,
        strikethrough: false,
        underline: false,
      },
      href: null,
      plain_text: " in the task-runner sandbox, so ",
      text: {
        content: " in the task-runner sandbox, so ",
        link: null,
      },
      type: "text",
    },
    {
      annotations: {
        bold: false,
        code: true,
        color: "default",
        italic: false,
        strikethrough: false,
        underline: false,
      },
      href: null,
      plain_text: "$helpers.httpRequest()",
      text: {
        content: "$helpers.httpRequest()",
        link: null,
      },
      type: "text",
    },
    {
      annotations: {
        bold: false,
        code: false,
        color: "default",
        italic: false,
        strikethrough: false,
        underline: false,
      },
      href: null,
      plain_text: " throws ",
      text: {
        content: " throws ",
        link: null,
      },
      type: "text",
    },
    {
      annotations: {
        bold: false,
        code: true,
        color: "default",
        italic: false,
        strikethrough: false,
        underline: false,
      },
      href: null,
      plain_text: "ReferenceError: $helpers is not defined",
      text: {
        content: "ReferenceError: $helpers is not defined",
        link: null,
      },
      type: "text",
    },
    {
      annotations: {
        bold: false,
        code: false,
        color: "default",
        italic: false,
        strikethrough: false,
        underline: false,
      },
      href: null,
      plain_text: "), DateTime (Luxon), ",
      text: {
        content: "), DateTime (Luxon), ",
        link: null,
      },
      type: "text",
    },
    {
      annotations: {
        bold: false,
        code: false,
        color: "default",
        italic: false,
        strikethrough: false,
        underline: false,
      },
      equation: {
        expression:
          "jmespath(). **Not available**: `this.helpers.httpRequestWithAuthentication` (deny-listed), ",
      },
      href: null,
      plain_text:
        "jmespath(). **Not available**: `this.helpers.httpRequestWithAuthentication` (deny-listed), ",
      type: "equation",
    },
    {
      annotations: {
        bold: false,
        code: false,
        color: "default",
        italic: false,
        strikethrough: false,
        underline: false,
      },
      href: null,
      plain_text:
        "env (when N8N_BLOCK_ENV_ACCESS_IN_NODE=true), require() (unless allowlisted). For anything beyond a trivial unauthenticated GET (auth, pagination, retries), prefer the ",
      text: {
        content:
          "env (when N8N_BLOCK_ENV_ACCESS_IN_NODE=true), require() (unless allowlisted). For anything beyond a trivial unauthenticated GET (auth, pagination, retries), prefer the ",
        link: null,
      },
      type: "text",
    },
    {
      annotations: {
        bold: true,
        code: false,
        color: "default",
        italic: false,
        strikethrough: false,
        underline: false,
      },
      href: null,
      plain_text: "HTTP Request node",
      text: {
        content: "HTTP Request node",
        link: null,
      },
      type: "text",
    },
    {
      annotations: {
        bold: false,
        code: false,
        color: "default",
        italic: false,
        strikethrough: false,
        underline: false,
      },
      href: null,
      plain_text: " and keep Code nodes for pure logic.",
      text: {
        content: " and keep Code nodes for pure logic.",
        link: null,
      },
      type: "text",
    },
  ],
}
const matches = (actual = before.actual, spans: readonly unknown[] = before.spans) =>
  sourceRichTextRepairInlineMatches(actual, spans, "literal_dollar_equation")

test("complete malformed-equation BEFORE keeps its real plain bold spans and ASCII identifier underscores", () => {
  expect(matches()).toBe(true)
  expect(
    sourceRichTextRepairInlineMatches(before.actual, before.spans, "literal_file_line_link"),
  ).toBe(false)
})
test("the serializer still consumes every physical byte and actual bold delimiter", () => {
  expect(matches(before.actual.replace("HTTP Request node", "Changed Request node"))).toBe(false)
  expect(matches(before.actual.replace("**Built-ins available**", "Built-ins available"))).toBe(
    false,
  )
  expect(matches(before.actual.replace("N8N_BLOCK", "N8N\\_BLOCK"))).toBe(false)
  const physical = structuredClone(before.spans)
  physical[0]!.annotations.bold = false
  expect(matches(before.actual, physical)).toBe(false)
  physical[0]!.plain_text += " changed"
  expect(matches(before.actual, physical)).toBe(false)
})
test("bold code, links, italic and unknown styling remain outside this finite BEFORE form", () => {
  for (const change of [
    (span: (typeof before.spans)[number]) => {
      span.annotations.code = true
    },
    (span: (typeof before.spans)[number]) => {
      span.annotations.italic = true
    },
    (span: (typeof before.spans)[number]) => {
      span.annotations.underline = true
    },
    (span: (typeof before.spans)[number]) => {
      span.annotations.strikethrough = true
    },
    (span: (typeof before.spans)[number]) => {
      span.annotations.color = "red"
    },
  ]) {
    const physical = structuredClone(before.spans)
    change(physical[0]!)
    expect(matches(before.actual, physical)).toBe(false)
  }
  const physical: unknown[] = structuredClone(before.spans)
  physical[0] = {
    ...before.spans[0],
    href: "https://example.test/",
    text: {
      content: "Built-ins available",
      link: { url: "https://example.test/" },
    },
  }
  expect(matches(before.actual, physical)).toBe(false)
})
test("a missing or changed malformed equation is never supplied by source text", () => {
  const physical = structuredClone(before.spans)
  const equation = physical.find((span) => span.type === "equation")
  if (!equation || !("equation" in equation) || !equation.equation)
    throw new Error("The complete physical fixture needs its actual equation")
  equation.equation.expression += "x"
  equation.plain_text += "x"
  expect(matches(before.actual, physical)).toBe(false)
  expect(
    matches(
      before.actual,
      before.spans.filter((span) => span.type !== "equation"),
    ),
  ).toBe(false)
})

test("a multiline currency equation matches only its exact physical serializer form", () => {
  const expression = '0.09", "+10,100 (+0.20%)"). No space after the currency sign (one screen\'s "'
  const actual = '**Fixed**: change ("-$`' + expression + '`$ 89.00"<br>beside "\\$15.00").'
  const spans = [
    before.spans[0]!,
    {
      ...before.spans[1],
      plain_text: ': change ("-',
      text: { content: ': change ("-', link: null },
    },
    {
      type: "equation",
      equation: { expression },
      plain_text: expression,
      href: null,
      annotations: { ...before.spans[1]!.annotations },
    },
    {
      ...before.spans[1],
      plain_text: ' 89.00"\nbeside "$15.00").',
      text: { content: ' 89.00"\nbeside "$15.00").', link: null },
    },
  ]
  spans[0] = { ...spans[0], plain_text: "Fixed", text: { content: "Fixed", link: null } }
  expect(sourceRichTextRepairInlineMatches(actual, spans, "literal_dollar_equation")).toBe(true)
  const altered = structuredClone(spans),
    alteredEquation = altered[2]!
  if (!("equation" in alteredEquation) || !alteredEquation.equation)
    throw new Error("Expected the altered currency equation")
  alteredEquation.equation.expression = expression + " "
  alteredEquation.plain_text += " "
  expect(sourceRichTextRepairInlineMatches(actual, altered, "literal_dollar_equation")).toBe(false)
  expect(
    sourceRichTextRepairInlineMatches(
      actual.replace("<br>", "\n"),
      spans,
      "literal_dollar_equation",
    ),
  ).toBe(false)
  expect(
    sourceRichTextRepairInlineMatches(
      actual.replace("<br>", "\r\n"),
      spans,
      "literal_dollar_equation",
    ),
  ).toBe(false)
  expect(sourceRichTextRepairInlineMatches(actual, spans, "literal_file_line_link")).toBe(false)
})
