import assert from "node:assert/strict"
import { test } from "node:test"
import { defaults, Lexer } from "marked"
import { SourceLexer } from "../src/source-lexer.ts"

const shape = (tokens) => tokens.map((token) => [token.type, token.text])

test("a literal tilde does not consume the following inline code delimiter", () => {
  const source =
    "`heading-0`~`heading-4` / `normal`(14px) / `notation`(12px) 等；可在 `config.style.text_size` 自定义 pc/mobile 字号"
  const tokens = SourceLexer.lexInline(source)
  assert.deepEqual(shape(tokens), [
    ["codespan", "heading-0"],
    ["text", "~"],
    ["codespan", "heading-4"],
    ["text", " / "],
    ["codespan", "normal"],
    ["text", "(14px) / "],
    ["codespan", "notation"],
    ["text", "(12px) 等；可在 "],
    ["codespan", "config.style.text_size"],
    ["text", " 自定义 pc/mobile 字号"],
  ])
  assert.equal(tokens.map((token) => token.raw).join(""), source)
})

test("the same parser is used for complete table cells without changing other cells", () => {
  const source =
    "| field | value |\n|---|---|\n| `size` | `h0`~`h4` / `normal` |\n| link | [label](https://example.test/a?x=1#part) |\n"
  const table = SourceLexer.lex(source)[0]
  assert.equal(table.type, "table")
  assert.deepEqual(shape(table.rows[0][1].tokens), [
    ["codespan", "h0"],
    ["text", "~"],
    ["codespan", "h4"],
    ["text", " / "],
    ["codespan", "normal"],
  ])
  assert.deepEqual(table.header, Lexer.lex(source)[0].header)
  assert.deepEqual(table.rows[0][0], Lexer.lex(source)[0].rows[0][0])
  assert.deepEqual(table.rows[1], Lexer.lex(source)[0].rows[1])
  assert.equal(table.raw, source)
})

test("valid single and double tilde deletion keep their original grammar", () => {
  for (const source of [
    "~deleted~",
    "~~deleted~~",
    "~`code`~",
    "~~`code`~~",
    "word~deleted~word",
    "**~`code`~**",
  ])
    assert.deepEqual(SourceLexer.lexInline(source), Lexer.lexInline(source), source)
})

test("escaped tildes and escaped code delimiters remain literal", () => {
  for (const source of [
    "\\~\\`text",
    "\\~`code`",
    "~\\`literal\\`",
    "\\`~text\\`",
    "text \\~ `code`",
  ]) {
    assert.deepEqual(SourceLexer.lexInline(source), Lexer.lexInline(source), source)
  }
})

test("code contents and unmatched code runs remain unchanged", () => {
  for (const source of ["`x~y`", "`` `x`~`y` ``", "`~`", "```~`x`", "~`unclosed"])
    assert.deepEqual(SourceLexer.lexInline(source), Lexer.lexInline(source), source)
  assert.deepEqual(shape(SourceLexer.lexInline("~`` `literal` ``")), [
    ["text", "~"],
    ["codespan", "`literal`"],
  ])
})

test("tilde fences, fenced bodies and raw HTML text are not reinterpreted", () => {
  for (const source of ["~~~md\n`a`~`b`\n~~~\n", "```md\n`a`~`b`\n```\n", "<pre>~`code`</pre>\n"])
    assert.deepEqual(SourceLexer.lex(source), Lexer.lex(source), source)
  assert.deepEqual(
    SourceLexer.lexInline("<code>~`code`</code>"),
    Lexer.lexInline("<code>~`code`</code>"),
  )
})

test("explicit link and image destinations are preserved byte for byte", () => {
  for (const source of [
    "[~`label`](https://Example.test:8443/p?q=1#part)",
    '![~`label`](images/a~b.png "title")',
  ]) {
    const actual = SourceLexer.lexInline(source)[0],
      original = Lexer.lexInline(source)[0]
    assert.equal(actual.type, original.type)
    assert.equal(actual.href, original.href)
    assert.equal(actual.title, original.title)
    assert.equal(actual.raw, original.raw)
    assert.deepEqual(shape(actual.tokens), [
      ["text", "~"],
      ["codespan", "label"],
    ])
  }
  for (const source of [
    "https://example.test/a~b",
    "<https://example.test/a~b>",
    "[label](https://example.test/a~b)",
  ])
    assert.deepEqual(SourceLexer.lexInline(source), Lexer.lexInline(source), source)
})

test("calls neither mutate global defaults nor retain another lexer's link state", () => {
  const originalTokenizer = defaults.tokenizer
  const originalTokens = Lexer.lexInline("`x`~`y`")
  const first = SourceLexer.lex("[label][ref]\n\n[ref]: https://one.test/a\n")
  const second = SourceLexer.lex("[label][ref]\n")
  assert.equal(first[0].tokens[0].href, "https://one.test/a")
  assert.equal(
    second[0].tokens.some((token) => token.type === "link"),
    false,
  )
  assert.equal(defaults.tokenizer, originalTokenizer)
  assert.deepEqual(Lexer.lexInline("`x`~`y`"), originalTokens)
})
