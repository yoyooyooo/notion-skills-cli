import { codeLanguage, markdownStructure, projectNotionBlocks } from "./markdown.ts"

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

interface Code {
  readonly language: string
  readonly text: string
}

function topLevelCodes(markdown: string): readonly Code[] | undefined {
  const structure = markdownStructure(markdown)
  const code = (node: unknown): node is readonly ["code", string, string] =>
    Array.isArray(node) &&
    node.length === 3 &&
    node[0] === "code" &&
    typeof node[1] === "string" &&
    typeof node[2] === "string"
  const all: Code[] = []
  const visit = (node: unknown) => {
    if (code(node)) all.push({ language: node[1], text: node[2] })
    else if (Array.isArray(node)) for (const part of node) visit(part)
  }
  visit(structure)
  const roots = structure.filter(code).map((node) => ({ language: node[1], text: node[2] }))
  return roots.length === all.length ? roots : undefined
}

export interface AcknowledgedCodeLanguageField {
  readonly block_id: string
  readonly root_index: number
  readonly code_index: number
  readonly before: string
  readonly language: string
  readonly text: string
}

export interface AcknowledgedCodeLanguages {
  readonly page_id: string
  readonly codes: readonly AcknowledgedCodeLanguageField[]
  readonly changes: readonly AcknowledgedCodeLanguageField[]
}

/** Derive field candidates, not write authority. The caller must also prove the
 * original page/source identity, complete Markdown, URLs and retained guards.
 * Only Notion's default JavaScript for authored plain text is in this scope. */
export function acknowledgedCodeLanguages(
  pageId: string,
  target: string,
  source: string,
  roots: readonly unknown[],
): AcknowledgedCodeLanguages | undefined {
  const expected = topLevelCodes(target)
  const authored = topLevelCodes(source)
  if (
    !expected ||
    !authored ||
    expected.length > 1000 ||
    JSON.stringify(expected) !== JSON.stringify(authored)
  )
    return
  const ids = new Set<string>()
  for (const raw of roots) {
    const root = record(raw)
    const parent = record(root?.parent)
    if (
      !root ||
      typeof root.id !== "string" ||
      !root.id ||
      ids.has(root.id) ||
      typeof root.type !== "string" ||
      typeof root.has_children !== "boolean" ||
      typeof root.last_edited_time !== "string" ||
      parent?.type !== "page_id" ||
      parent.page_id !== pageId ||
      root.archived === true ||
      root.in_trash === true
    )
      return
    ids.add(root.id)
  }
  const boundaries = projectNotionBlocks(roots)
  if (!boundaries) return
  const saved = boundaries.flatMap((block, root_index) =>
    block.type === "code" ? [{ block, root_index }] : [],
  )
  if (saved.length !== expected.length) return
  const codes: AcknowledgedCodeLanguageField[] = []
  const changes: AcknowledgedCodeLanguageField[] = []
  for (const [code_index, row] of saved.entries()) {
    const wanted = expected[code_index]!
    const actual = row.block.code
    if (row.block.has_children || !actual || actual.text !== wanted.text) return
    const language = codeLanguage(wanted.language)
    const field = {
      block_id: row.block.id,
      root_index: row.root_index,
      code_index,
      before: actual.language,
      language: language === "text" ? "plain text" : language,
      text: actual.text,
    }
    codes.push(field)
    if (codeLanguage(actual.language) === language) continue
    if (
      actual.language !== "javascript" ||
      language !== "text" ||
      expected.filter((item) => item.text === wanted.text).length !== 1
    )
      return
    changes.push(field)
  }
  return { page_id: pageId, codes, changes }
}
