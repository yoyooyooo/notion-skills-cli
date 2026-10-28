import test from "node:test"
import assert from "node:assert/strict"
import { markdownStructure, sameMarkdownStructure } from "../src/index.ts"

const compare = (actual, source) =>
  sameMarkdownStructure(markdownStructure(actual), markdownStructure(source), (a, b) => a === b)
const linked = (href = "http://localhost", label = "localhost", title = "") =>
  `[${label}](${href}${title ? ` "${title}"` : ""})`

test("exact localhost autolinks can stand for the same source bare text", () => {
  for (const url of [
    "http://localhost",
    "http://localhost/",
    "https://localhost",
    "https://localhost/",
  ])
    assert.equal(
      compare(`Use ${linked(url)} or \`127.0.0.1\`.`, "Use localhost or `127.0.0.1`."),
      true,
    )
})
test("the complete source table and every surrounding inline node remain bound", () => {
  const source =
    "| Key | Meaning |\n| --- | --- |\n| local | Use localhost or `127.0.0.1` for this example. |\n"
  const actual = source.replace("localhost", linked())
  assert.equal(compare(actual, source), true)
  assert.equal(compare(actual.replace("this example", "another example"), source), false)
  assert.equal(compare(actual.replace("127.0.0.1", "127.0.0.2"), source), false)
})
test("two explicit localhost destinations still compare complete original URLs", () => {
  assert.equal(compare(linked(), linked()), true)
  for (const url of [
    "https://localhost",
    "http://localhost/",
    "http://localhost:80",
    "http://localhost/?q=1",
  ])
    assert.equal(compare(linked(url), linked()), false)
})
test("ports, paths, query strings, fragments and user info cannot become bare source text", () => {
  for (const url of [
    "http://localhost:80",
    "http://localhost:8080",
    "http://localhost/a",
    "http://localhost?q=1",
    "http://localhost#part",
    "http://user@localhost",
    "http://user:pass@localhost",
  ])
    assert.equal(compare(linked(url), "localhost"), false)
})
test("only the exact reserved hostname spelling is eligible", () => {
  for (const url of [
    "http://%6cocalhost",
    "http://localhost.",
    "http://localhost.invalid",
    "//localhost",
    "ftp://localhost",
    "http:localhost",
    "http:/localhost",
    "http:///localhost",
  ])
    assert.equal(compare(linked(url), "localhost"), false)
  for (const label of ["machine", "127.0.0.1", "intranet", "local"])
    assert.equal(compare(linked(`http://${label}`, label), label), false)
})
test("titles, code and images cannot be discarded through localhost folding", () => {
  assert.equal(compare(linked(undefined, undefined, "authored title"), "localhost"), false)
  assert.equal(compare(linked(), "`localhost`"), false)
  assert.equal(compare(`!${linked()}`, "localhost"), false)
  assert.equal(compare("<http://localhost>", "localhost"), false)
})
test("host case normalization preserves the source label bytes and is directional", () => {
  assert.equal(compare(linked("HTTP://LOCALHOST", "LOCALHOST"), "LOCALHOST"), true)
  assert.equal(compare(linked("HTTP://LOCALHOST", "LOCALHOST"), "localhost"), false)
  assert.equal(compare("localhost", linked()), false)
})
test("existing dotted bare-host behavior remains unchanged", () => {
  assert.equal(
    compare(linked("https://example.invalid/", "example.invalid"), "example.invalid"),
    true,
  )
  assert.equal(
    compare(linked("https://other.invalid/", "example.invalid"), "example.invalid"),
    false,
  )
})
