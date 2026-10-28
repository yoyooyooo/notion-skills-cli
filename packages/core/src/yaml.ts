import { parseDocument } from "yaml"

function rejectRecursiveAliases(value: unknown, ancestors = new Set<object>()): void {
  if (typeof value !== "object" || value === null) return
  if (ancestors.has(value)) throw new SyntaxError("Recursive YAML aliases are not supported.")
  ancestors.add(value)
  for (const child of Object.values(value)) rejectRecursiveAliases(child, ancestors)
  ancestors.delete(value)
}

/** Skill frontmatter includes multiline YAML flow collections from upstream repositories. */
export function parseYaml(source: string): unknown {
  const document = parseDocument(source, {
    version: "1.2",
    schema: "core",
    stringKeys: true,
    uniqueKeys: true,
    strict: true,
    prettyErrors: false,
  })
  if (document.errors.length || document.warnings.length)
    throw new SyntaxError("Invalid or unsupported YAML frontmatter.")
  const value: unknown = document.toJS({ maxAliasCount: 100 })
  rejectRecursiveAliases(value)
  return value
}
