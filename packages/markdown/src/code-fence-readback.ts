import type { Token, Tokens } from "marked"
import type { NotionBlockBoundary } from "./index.ts"

interface Range {
  readonly start: number
  readonly end: number
}
interface Part extends Range {
  readonly token: Token
}
type Structure = (markdown: string) => readonly unknown[]
type Language = (value: string | undefined) => string
type Proves = (firstIndex: number, ranges: readonly Range[]) => boolean

interface CodeWrapper extends Range {
  readonly blockIndex: number
  readonly body: string
  readonly language: string
  readonly marker: string
  readonly openingLength: number
  readonly closingLength: number
  readonly openingSuffix: string
  readonly closingSuffix: string
  readonly needsRepair: boolean
  readonly safeLength: number
}

function originalCodeWrappers(
  markdown: string,
  block: NotionBlockBoundary,
  blockIndex: number,
  language: Language,
) {
  const evidence = block.code
  if (block.type !== "code" || block.has_children || !evidence || evidence.text.includes("\r"))
    return []
  const candidates: CodeWrapper[] = []
  let start = 0
  for (const line of markdown.split("\n")) {
    const open = /^(`{3,}|~{3,})([^\r\n]*)$/.exec(line)
    if (
      open &&
      !(open[1]![0] === "`" && open[2]!.includes("`")) &&
      language(open[2]) === language(evidence.language)
    ) {
      const bodyStart = start + line.length + 1
      const bodyEnd = bodyStart + evidence.text.length
      if (markdown.slice(bodyStart, bodyEnd) === evidence.text && markdown[bodyEnd] === "\n") {
        const closeStart = bodyEnd + 1
        const followingNewline = markdown.indexOf("\n", closeStart)
        const end = followingNewline < 0 ? markdown.length : followingNewline
        const close = /^(`{3,}|~{3,})([ ]*)$/.exec(markdown.slice(closeStart, end))
        if (close && close[1]![0] === open[1]![0] && close[1]!.length >= open[1]!.length) {
          let needsRepair = false
          let longest = open[1]!.length - 1
          for (const literal of evidence.text.split("\n")) {
            const run = /^ {0,3}(`{3,}|~{3,})/.exec(literal)
            if (!run || run[1]![0] !== open[1]![0]) continue
            longest = Math.max(longest, run[1]!.length)
            if (run[1]!.length >= open[1]!.length && /^[ \t]*$/.test(literal.slice(run[0].length)))
              needsRepair = true
          }
          candidates.push({
            blockIndex,
            start,
            end,
            body: evidence.text,
            language: open[2]!.trim(),
            marker: open[1]![0]!,
            openingLength: open[1]!.length,
            closingLength: close[1]!.length,
            openingSuffix: open[2]!,
            closingSuffix: close[2]!,
            needsRepair,
            safeLength: Math.max(longest + 1, open[1]!.length, close[1]!.length),
          })
        }
      }
    }
    start += line.length + 1
  }
  return candidates
}

// Bind the complete original code inventory before considering a delimiter edit.
// Distinct occurrences remain ambiguous unless the original ordering resolves them.
function uniqueCodeSequence(choices: readonly (readonly CodeWrapper[])[]) {
  const memo = new Map<string, { count: number; path?: readonly CodeWrapper[] }>()
  const visit = (
    index: number,
    previousEnd: number,
  ): { count: number; path?: readonly CodeWrapper[] } => {
    if (index === choices.length) return { count: 1, path: [] }
    const key = `${index}:${previousEnd}`
    const known = memo.get(key)
    if (known) return known
    let count = 0
    let path: readonly CodeWrapper[] | undefined
    for (const candidate of choices[index]!) {
      if (candidate.start < previousEnd) continue
      const following = visit(index + 1, candidate.end)
      if (!following.count) continue
      if (count === 0 && following.count === 1 && following.path)
        path = [candidate, ...following.path]
      count = Math.min(2, count + following.count)
      if (count > 1) {
        path = undefined
        break
      }
    }
    const result = { count, path }
    memo.set(key, result)
    return result
  }
  return visit(0, 0)
}

// The raw ranges and exact bodies exist before any repair. Segment only at the
// already-bound wrappers; no replacement text is used as positional evidence.
function tokensAroundCode(
  markdown: string,
  wrappers: readonly CodeWrapper[],
  positioned: (markdown: string) => Part[] | undefined,
) {
  const result: Part[] = []
  let offset = 0
  for (const wrapper of wrappers) {
    const gap = positioned(markdown.slice(offset, wrapper.start))
    if (!gap) return
    result.push(
      ...gap.map((part) => ({ ...part, start: part.start + offset, end: part.end + offset })),
    )
    const token: Tokens.Code = {
      type: "code",
      raw: markdown.slice(wrapper.start, wrapper.end),
      lang: wrapper.language,
      text: wrapper.body,
    }
    result.push({ token, start: wrapper.start, end: wrapper.end })
    offset = wrapper.end
  }
  const tail = positioned(markdown.slice(offset))
  if (!tail) return
  result.push(
    ...tail.map((part) => ({ ...part, start: part.start + offset, end: part.end + offset })),
  )
  return result
}

// The raw code and ordered roots bind delimiter edits before conversion.
// Callers still compare the complete candidate under their original URL policy.
function codeFenceReadbackCandidate(
  actual: string,
  target: string,
  boundaries: readonly NotionBlockBoundary[],
  structure: Structure,
  language: Language,
  positioned: (markdown: string) => Part[] | undefined,
  proof: (
    markdown: string,
    tokens: readonly Part[],
    boundaries: readonly NotionBlockBoundary[],
  ) => Proves,
) {
  if (actual.includes("\r") || target.includes("\r")) return
  const original = boundaries.flatMap((block, index) =>
    block.type === "code" ? [{ block, index }] : [],
  )
  const expected = structure(target).flatMap((node) =>
    Array.isArray(node) &&
    node[0] === "code" &&
    typeof node[1] === "string" &&
    typeof node[2] === "string"
      ? [{ language: node[1], text: node[2] }]
      : [],
  )
  if (!original.length || original.length !== expected.length) return
  if (
    original.some(
      ({ block }, index) =>
        block.has_children ||
        !block.code ||
        block.code.text !== expected[index]!.text ||
        language(block.code.language) !== expected[index]!.language,
    )
  )
    return
  const choices = original.map(({ block, index }) =>
    originalCodeWrappers(actual, block, index, language),
  )
  if (choices.some((choice) => !choice.length)) return
  const sequence = uniqueCodeSequence(choices)
  if (sequence.count !== 1 || !sequence.path) return
  const wrappers = sequence.path
  const requested = wrappers.filter((wrapper) => wrapper.needsRepair)
  if (!requested.length) return
  const tokens = tokensAroundCode(actual, wrappers, positioned)
  if (!tokens) return
  const proves = proof(actual, tokens, boundaries)
  if (requested.some((wrapper) => !proves(wrapper.blockIndex, [wrapper]))) return
  let candidate = actual
  for (const wrapper of [...requested].reverse()) {
    const marker = wrapper.marker.repeat(wrapper.safeLength)
    const closeStart = wrapper.end - wrapper.closingLength - wrapper.closingSuffix.length
    const replacement =
      marker +
      actual.slice(wrapper.start + wrapper.openingLength, closeStart) +
      marker +
      wrapper.closingSuffix
    candidate = candidate.slice(0, wrapper.start) + replacement + candidate.slice(wrapper.end)
  }
  return candidate
}

export function codeFenceCandidate(
  actual: string,
  target: string,
  boundaries: readonly NotionBlockBoundary[],
  structure: Structure,
  language: Language,
  positioned: (markdown: string) => Part[] | undefined,
  proof: (
    markdown: string,
    tokens: readonly Part[],
    boundaries: readonly NotionBlockBoundary[],
  ) => Proves,
) {
  return codeFenceReadbackCandidate(
    actual,
    target,
    boundaries,
    structure,
    language,
    positioned,
    proof,
  )
}
