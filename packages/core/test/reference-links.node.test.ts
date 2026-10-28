import assert from "node:assert/strict"
import { test } from "vitest"
import { decodeReferenceLinks, referenceLinks, referencePathsFit } from "../src/reference-links.ts"
import type { ReferenceLink } from "../src/reference-links.ts"

const pages = (count: number): ReferenceLink[] =>
  Array.from({ length: count }, (_, index) => ({
    path: `references/guide-${String(index).padStart(3, "0")}.md`,
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  }))
const legacy = (input: readonly ReferenceLink[]) => ({
  rich_text: input.flatMap((page, index) => [
    ...(index ? [{ type: "text", text: { content: "\n" } }] : []),
    {
      type: "text",
      text: {
        content: page.path,
        link: { url: `https://www.notion.so/${page.id.replaceAll("-", "")}` },
      },
    },
  ]),
})
const clone = <A>(value: A): A => JSON.parse(JSON.stringify(value))
const json = (value: unknown) => JSON.stringify(value)

test("every valid size through 50 preserves exact legacy JSON request bytes", () => {
  for (let count = 0; count <= 50; count++) {
    const input = pages(count)
    const before = json(input)
    const value = referenceLinks(input)
    assert.equal(json(value), json(legacy(input)))
    assert.equal(json(input), before)
    assert.equal(decodeReferenceLinks(value)?.bindings.length, count)
  }
})

for (const count of [51, 60, 100])
  test(`compact ${count} references retain every path, URL, order and visible LF`, () => {
    const input = pages(count)
    const value = referenceLinks(input)!
    assert.equal(value.rich_text.length, count)
    assert.ok(value.rich_text.length <= 100)
    assert.equal(
      value.rich_text.map((entry) => entry.text.content).join(""),
      legacy(input)
        .rich_text.map((entry) => entry.text.content)
        .join(""),
    )
    const decoded = decodeReferenceLinks(clone(value))!
    assert.equal(decoded.representation, "compact")
    assert.deepEqual(
      decoded.bindings,
      input.map((page) => ({
        ...page,
        url: `https://www.notion.so/${page.id.replaceAll("-", "")}`,
      })),
    )
    assert.ok(value.rich_text.every((entry) => entry.text.content.length <= 2000))
  })

test("old 101 elements are read only when explicitly requested as historical legacy", () => {
  const value = legacy(pages(51))
  const before = json(value)
  assert.equal(value.rich_text.length, 101)
  assert.equal(decodeReferenceLinks(value), undefined)
  const historical = decodeReferenceLinks(value, { oversizedLegacy: true })!
  assert.equal(historical.representation, "legacy")
  assert.equal(historical.bindings.length, 51)
  assert.equal(referenceLinks(historical.bindings)!.rich_text.length, 51)
  assert.equal(json(value), before)
})

test("readback accepts only exact response metadata and default annotations", () => {
  const value = referenceLinks(pages(60))!
  const readback = {
    rich_text: value.rich_text.map((entry) => ({
      ...entry,
      plain_text: entry.text.content,
      href: entry.text.link?.url ?? null,
      annotations: {
        bold: false,
        italic: false,
        strikethrough: false,
        underline: false,
        code: false,
        color: "default",
      },
    })),
  }
  assert.deepEqual(decodeReferenceLinks(readback, { readback: true }), decodeReferenceLinks(value))
  assert.equal(decodeReferenceLinks(readback), undefined)
  const legacyReadback = {
    rich_text: legacy(pages(2)).rich_text.map((entry) => ({
      ...entry,
      text: { ...entry.text, link: "link" in entry.text ? entry.text.link : null },
    })),
  }
  assert.equal(decodeReferenceLinks(legacyReadback, { readback: true })?.bindings.length, 2)
})

test("Unicode, spaces and URL case are preserved as data without trimming", () => {
  const input = pages(51)
  input[3] = {
    ...input[3]!,
    path: "references/嵌套/guide 📝 with spaces.md",
    id: "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF",
  }
  const value = referenceLinks(input)!
  const binding = decodeReferenceLinks(value)!.bindings[3]!
  assert.equal(binding.path, input[3]!.path)
  assert.equal(binding.url, "https://www.notion.so/ABCDEFABCDEF4ABC8DEFABCDEFABCDEF")
  assert.equal(binding.id, input[3]!.id.toLowerCase())
})

test("text and reference count limits reject before an oversized request can be constructed", () => {
  assert.equal(referenceLinks(pages(101)), undefined)
  assert.equal(decodeReferenceLinks(legacy(pages(101)), { oversizedLegacy: true }), undefined)
  const path = (size: number) => `references/${"a".repeat(size - "references/.md".length)}.md`
  assert.equal(
    referenceLinks([{ ...pages(1)[0]!, path: path(2000) }])!.rich_text[0]!.text.content.length,
    2000,
  )
  assert.equal(referencePathsFit([path(2001)]), false)
  const compact = pages(51)
  compact[1] = { ...compact[1]!, path: path(1999) }
  assert.equal(referenceLinks(compact)!.rich_text[1]!.text.content.length, 2000)
  compact[1] = { ...compact[1]!, path: path(2000) }
  assert.equal(referenceLinks(compact), undefined)
})

const requestChanges: ReadonlyArray<readonly [string, (value: any) => void]> = [
  [
    "missing compact separator",
    (v) => {
      v.rich_text[1].text.content = v.rich_text[1].text.content.slice(1)
    },
  ],
  [
    "extra separator",
    (v) => {
      v.rich_text[1].text.content = `\n${v.rich_text[1].text.content}`
    },
  ],
  [
    "CRLF separator",
    (v) => {
      v.rich_text[1].text.content = `\r${v.rich_text[1].text.content}`
    },
  ],
  [
    "first leading separator",
    (v) => {
      v.rich_text[0].text.content = `\n${v.rich_text[0].text.content}`
    },
  ],
  [
    "trailing whitespace",
    (v) => {
      v.rich_text[1].text.content += " "
    },
  ],
  [
    "mixed legacy separator",
    (v) => {
      v.rich_text.splice(1, 0, { type: "text", text: { content: "\n" } })
    },
  ],
  [
    "duplicate path",
    (v) => {
      v.rich_text[1].text.content = `\n${v.rich_text[0].text.content}`
    },
  ],
  [
    "duplicate destination",
    (v) => {
      v.rich_text[1].text.link.url = v.rich_text[0].text.link.url
    },
  ],
  [
    "wrong scheme",
    (v) => {
      v.rich_text[1].text.link.url = v.rich_text[1].text.link.url.replace("https:", "http:")
    },
  ],
  [
    "wrong hostname",
    (v) => {
      v.rich_text[1].text.link.url = v.rich_text[1].text.link.url.replace(
        "www.notion.so",
        "evil.test",
      )
    },
  ],
  [
    "extra port",
    (v) => {
      v.rich_text[1].text.link.url = v.rich_text[1].text.link.url.replace(".so/", ".so:443/")
    },
  ],
  [
    "extra query",
    (v) => {
      v.rich_text[1].text.link.url += "?view=changed"
    },
  ],
  [
    "extra fragment",
    (v) => {
      v.rich_text[1].text.link.url += "#changed"
    },
  ],
  [
    "extra field",
    (v) => {
      v.rich_text[1].text.link.append = true
    },
  ],
  [
    "append semantics",
    (v) => {
      v.append = true
    },
  ],
  [
    "mention replacement",
    (v) => {
      v.rich_text[1] = { type: "mention", mention: { type: "page", page: { id: pages(2)[1]!.id } } }
    },
  ],
]
for (const [name, change] of requestChanges)
  test(`rejects ${name} in a full compact property`, () => {
    const value = clone(referenceLinks(pages(60)))
    change(value)
    assert.equal(decodeReferenceLinks(value), undefined)
    assert.equal(decodeReferenceLinks(value, { oversizedLegacy: true }), undefined)
  })

const readbackChanges: ReadonlyArray<readonly [string, (entry: any) => void]> = [
  [
    "changed plain_text",
    (entry) => {
      entry.plain_text = "changed"
    },
  ],
  [
    "changed href",
    (entry) => {
      entry.href = "https://www.notion.so/00000000000040008000000000000099"
    },
  ],
  [
    "null href on linked text",
    (entry) => {
      entry.href = null
    },
  ],
  [
    "bold annotation",
    (entry) => {
      entry.annotations = { bold: true }
    },
  ],
  [
    "unknown annotation",
    (entry) => {
      entry.annotations = { future: false }
    },
  ],
  [
    "extra response field",
    (entry) => {
      entry.unproven = true
    },
  ],
]
for (const [name, change] of readbackChanges)
  test(`rejects readback with ${name}`, () => {
    const value = clone(referenceLinks(pages(60)))!
    change(value.rich_text[1])
    assert.equal(decodeReferenceLinks(value, { readback: true }), undefined)
  })

test("legacy separators must be exactly one unlinked LF at the expected positions", () => {
  for (const content of ["", "\n\n", " ", "\r\n"]) {
    const value = legacy(pages(2))
    value.rich_text[1]!.text.content = content
    assert.equal(decodeReferenceLinks(value), undefined)
  }
  const linked = legacy(pages(2))
  Object.assign(linked.rich_text[1]!.text, { link: { url: linked.rich_text[0]!.text.link!.url } })
  assert.equal(decodeReferenceLinks(linked), undefined)
})

test("unsafe or duplicate source paths and page identities cannot construct a value", () => {
  for (const path of [
    "references/../guide.md",
    "references//guide.md",
    "references/a\nb.md",
    "references/a\rb.md",
    "references/a\0b.md",
    "references\\guide.md",
  ]) {
    assert.equal(referenceLinks([{ ...pages(1)[0]!, path }]), undefined)
  }
  assert.equal(referenceLinks([pages(1)[0]!, pages(1)[0]!]), undefined)
  assert.equal(referenceLinks([{ ...pages(1)[0]!, id: "not-a-page" }]), undefined)
})
