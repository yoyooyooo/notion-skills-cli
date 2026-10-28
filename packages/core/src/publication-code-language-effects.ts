import { isDeepStrictEqual } from "node:util"
import { Lexer, type Tokens } from "marked"
import { codeLanguage, markdownStructure } from "./markdown.ts"
import type { Receipt } from "./publication-model.ts"

type Intent = Receipt["intents"][number]
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))

function originalPlainTextField(intent: Intent) {
  const body = record(intent.body),
    code = record(body?.code)
  if (
    intent.method !== "PATCH" ||
    !/^v1\/blocks\/[^/]+$/.test(intent.path) ||
    intent.recovery ||
    intent.typed_links ||
    intent.list_start_repair ||
    intent.artifact ||
    !body ||
    !exactKeys(body, ["code"]) ||
    !code ||
    !exactKeys(code, ["language"]) ||
    code.language !== "plain text"
  )
    return
  const before = record(intent.guards?.[intent.path]),
    parent = record(before?.parent)
  const saved = record(before?.code)
  if (
    !before ||
    before.id !== intent.path.split("/")[2] ||
    before.type !== "code" ||
    before.has_children !== false ||
    before.archived !== false ||
    before.in_trash !== false ||
    typeof before.last_edited_time !== "string" ||
    parent?.type !== "page_id" ||
    typeof parent.page_id !== "string" ||
    saved?.language !== "javascript" ||
    !Array.isArray(saved.rich_text)
  )
    return
  const ownerPath = `v1/pages/${parent.page_id}`,
    owner = record(intent.guards?.[ownerPath])
  if (
    !owner ||
    owner.id !== parent.page_id ||
    !record(owner.properties) ||
    typeof intent.guards?.[`${ownerPath}/markdown`] !== "string"
  )
    return
  let text = ""
  for (const raw of saved.rich_text) {
    const span = record(raw),
      content = record(span?.text)
    if (
      span?.type !== "text" ||
      typeof content?.content !== "string" ||
      content.link != null ||
      (span.plain_text !== undefined && span.plain_text !== content.content)
    )
      return
    text += content.content
  }
  return { page_id: parent.page_id, block_id: before.id, text }
}

function positionedCodes(markdown: string) {
  const tokens = Lexer.lex(markdown)
  if (tokens.map((token) => token.raw).join("") !== markdown) return
  let start = 0
  const result: Array<{ token: Tokens.Code; start: number; end: number }> = []
  for (const token of tokens) {
    const offset = start
    start += token.raw.length
    if (token.type === "code")
      result.push({ token: token as Tokens.Code, start: offset, end: start })
  }
  return result
}

/** A read-only effect proof, consumed only after generic block recovery has
 * proved the complete supplied block fields. It permits exactly the one raw
 * fence language line produced by that field; all other page bytes are exact.
 * It never supplies retry or mutation authority. */
export function exactPlainTextLanguageBodyEffect(intent: Intent, before: unknown, after: unknown) {
  if (
    !["pending", "unknown", "completed"].includes(intent.status) ||
    typeof before !== "string" ||
    typeof after !== "string" ||
    before === after
  )
    return false
  const field = originalPlainTextField(intent)
  if (!field || intent.guards?.[`v1/pages/${field.page_id}/markdown`] !== before) return false
  const original = positionedCodes(before),
    current = positionedCodes(after)
  if (!original || !current || original.length !== current.length) return false
  const matches = original.flatMap((row, index) => (row.token.text === field.text ? [index] : []))
  if (matches.length !== 1) return false
  const index = matches[0]!,
    left = original[index]!,
    right = current[index]!
  if (
    left.token.lang !== "javascript" ||
    codeLanguage(right.token.lang) !== "text" ||
    right.token.text !== field.text ||
    left.token.codeBlockStyle === "indented" ||
    right.token.codeBlockStyle === "indented"
  )
    return false
  const header = /^( {0,3})(`{3,}|~{3,})([^\n]*)\n/
  const oldHeader = header.exec(left.token.raw),
    newHeader = header.exec(right.token.raw)
  if (
    !oldHeader ||
    !newHeader ||
    oldHeader[1] !== newHeader[1] ||
    oldHeader[2] !== newHeader[2] ||
    oldHeader[3]!.trim() !== "javascript" ||
    !["", "text", "plain text"].includes(newHeader[3]!.trim()) ||
    left.token.raw.slice(oldHeader[0].length) !== right.token.raw.slice(newHeader[0].length) ||
    before.slice(0, left.start) !== after.slice(0, right.start) ||
    before.slice(left.end) !== after.slice(right.end)
  )
    return false
  const prior = markdownStructure(before),
    observed = markdownStructure(after)
  const code = (node: unknown): node is ["code", string, string] =>
    Array.isArray(node) &&
    node.length === 3 &&
    node[0] === "code" &&
    typeof node[1] === "string" &&
    typeof node[2] === "string"
  const matching: unknown[] = []
  const visit = (node: unknown) => {
    if (code(node)) {
      if (node[2] === field.text) matching.push(node)
    } else if (Array.isArray(node)) node.forEach(visit)
  }
  visit(prior)
  const root = prior.findIndex((node) => code(node) && node[2] === field.text)
  if (matching.length !== 1 || root < 0) return false
  const expected = prior.map((node, position) =>
    position === root ? ["code", "text", field.text] : node,
  )
  return isDeepStrictEqual(expected, observed)
}

/** Eligibility for continuing finite postprocessing only. The official retry
 * path must already have persisted the old no-effect disposition and a real
 * completed successor with the same complete preimage. The caller still reads
 * original source bytes, owner guards, full body and the complete root graph. */
export function hasOnlyCompletedOrRetriedPlainTextEffects(receipt: Receipt) {
  return receipt.intents.every((intent, index) => {
    if (intent.status === "completed") return true
    const field = originalPlainTextField(intent)
    if (!field) return false
    const visited = new Set<number>()
    let position = index
    while (position < receipt.intents.length) {
      if (visited.has(position)) return false
      visited.add(position)
      const entry = receipt.intents[position]!
      if (
        !originalPlainTextField(entry) ||
        entry.path !== intent.path ||
        !isDeepStrictEqual(entry.body, intent.body) ||
        !isDeepStrictEqual(entry.guards, intent.guards)
      )
        return false
      if (entry.status === "completed")
        return position > index && record(entry.response)?.id === field.block_id
      const response = record(entry.response)
      if (
        entry.status !== "failed" ||
        !response ||
        !exactKeys(response, ["prior_status", "recovery", "replayed_by_intent"]) ||
        !["pending", "unknown"].includes(String(response.prior_status)) ||
        response.recovery !== "known_not_applied" ||
        typeof response.replayed_by_intent !== "number" ||
        !Number.isSafeInteger(response.replayed_by_intent) ||
        response.replayed_by_intent <= position ||
        response.replayed_by_intent >= receipt.intents.length
      )
        return false
      position = response.replayed_by_intent
    }
    return false
  })
}
