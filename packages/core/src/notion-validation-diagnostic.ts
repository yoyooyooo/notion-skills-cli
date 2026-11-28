import { Schema } from "effect"
import { property } from "./model.ts"

const fields = [
  "markdown",
  "markdown_version",
  "properties",
  "parent",
  "children",
  "content",
  "icon",
  "cover",
  "template",
] as const
export const NotionValidationDiagnosticSchema = Schema.Struct({
  version: Schema.Literal(1),
  category: Schema.Literals(["body_schema", "markdown_syntax", "unclassified"]),
  constraint: Schema.optionalKey(Schema.Literal("standalone_image")),
  fields: Schema.Array(Schema.Literals(fields)).check(Schema.isMaxLength(fields.length)),
  line: Schema.optionalKey(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 999999 })),
  ),
  column: Schema.optionalKey(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 999999 })),
  ),
  raw_message_retained: Schema.Literal(false),
})

/** Diagnostic hints are not write/retry authority. Emit only finite categories,
 * public schema field names and bounded positions, never a provider sentence,
 * caller property name, URL, submitted value or source-body fragment. */
export function notionValidationDiagnostic(input: unknown) {
  if (typeof input !== "string") return undefined
  const message = input.slice(0, 65536)
  // v2 documents this prefix; preserve only structural hints, never source excerpts.
  const syntax =
    /^(?:(?:unable|failed) to parse (?:notion[- ]flavored )?markdown\b|Markdown errors blocked parsing\b)/iu.test(
      message,
    )
  const category = /^body failed validation\b/iu.test(message)
    ? ("body_schema" as const)
    : syntax
      ? ("markdown_syntax" as const)
      : ("unclassified" as const)
  const selected =
    category === "body_schema"
      ? fields.filter((field) =>
          new RegExp(`\\bbody\\.${field}(?=[.\\[\\s:]|$)`, "u").test(message),
        )
      : syntax
        ? ["markdown" as const]
        : []
  const position = (name: "line" | "column") => {
    if (!syntax) return undefined
    const value = new RegExp(`\\b${name}\\s+([1-9][0-9]{0,5})(?![0-9])`, "iu").exec(message)?.[1]
    return value === undefined ? undefined : Number(value)
  }
  const line = position("line"),
    column = position("column")
  const standaloneImage =
    syntax &&
    /^Markdown errors blocked parsing:\s*Images must be standalone blocks and cannot be mixed with paragraph text or other images\./u.test(
      message,
    )
  return {
    version: 1 as const,
    category,
    fields: selected,
    ...(standaloneImage ? { constraint: "standalone_image" as const } : {}),
    ...(line === undefined ? {} : { line }),
    ...(column === undefined ? {} : { column }),
    raw_message_retained: false as const,
  }
}

export const NotionSafeRequestIdSchema = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/u),
)

/** The transport already removes credential-bearing metadata. This boundary
 * also rejects unexpected diagnostic shapes before persisting an old outcome. */
export function retainedNotionRejectionDiagnostics(input: unknown) {
  const value = property(input)
  let requestId: string | undefined
  let validation: typeof NotionValidationDiagnosticSchema.Type | undefined
  try {
    requestId = Schema.decodeUnknownSync(NotionSafeRequestIdSchema)(value.request_id)
  } catch {
    /* Optional unknown request identity. */
  }
  try {
    validation = Schema.decodeUnknownSync(NotionValidationDiagnosticSchema)(value.validation, {
      onExcessProperty: "error",
    })
  } catch {
    /* Never retain raw or unfamiliar diagnostics. */
  }
  return {
    ...(requestId === undefined ? {} : { request_id: requestId }),
    ...(validation === undefined ? {} : { validation }),
  }
}
