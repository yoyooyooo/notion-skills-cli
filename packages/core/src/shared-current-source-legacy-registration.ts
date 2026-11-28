import { Schema } from "effect"
import { fail, property, text } from "./model.ts"
import { pageId } from "./ref.ts"
import { CurrentSourceIdSchema } from "./shared-current-file.ts"
import type { SharedLibrary } from "./shared-library-model.ts"

const Page = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u),
)
/** Historical applied Sources recorded a Git commit, before current Content
 * existed. This evidence permits one initialization; it is never a plan revision. */
export const LegacySourceRegistrationSchema = Schema.Struct({
  source_id: CurrentSourceIdSchema,
  source_page_id: Page,
  last_revision: Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40})?$/u)),
})
export type LegacySourceRegistration = typeof LegacySourceRegistrationSchema.Type

const invalid = () =>
  fail(
    "SOURCE_LEGACY_REGISTRATION_CHANGED",
    "The exact uninitialized Git Source registration changed.",
  )

export function legacySourceRegistration(
  library: SharedLibrary,
  input: unknown,
  operationId?: string,
): LegacySourceRegistration | undefined {
  const row = property(input),
    parent = property(row.parent)
  const field = (name: string, kind: string) => {
    const id = library.sources.property_ids[name]
    if (!id) throw invalid()
    const values = Object.entries(property(row.properties)).flatMap(([key, raw]) =>
      key === id || property(raw).id === id ? [property(raw)] : [],
    )
    const value = values[0]
    if (values.length !== 1 || value?.type !== kind || value.has_more === true) throw invalid()
    return value
  }
  const rich = (name: string) => {
    const value = field(name, "rich_text").rich_text
    if (!Array.isArray(value) || value.length > 100) throw invalid()
    for (const part of value) {
      const item = property(part)
      const content =
        typeof item.plain_text === "string" ? item.plain_text : property(item.text).content
      if (typeof content !== "string" || content.length > 2000) throw invalid()
    }
    return text(value)
  }
  const state = property(field("Status", "select").select).name
  const initial = state === "applied"
  const resuming = operationId !== undefined && (state === "applying" || state === "attention")
  if (!initial && !resuming) return undefined
  if (resuming && rich("Content") !== "") return undefined
  const page = typeof row.id === "string" ? pageId(row.id) : undefined
  if (
    !page ||
    row.object !== "page" ||
    row.archived === true ||
    row.is_archived === true ||
    row.in_trash === true ||
    parent.type !== "data_source_id" ||
    typeof parent.data_source_id !== "string" ||
    pageId(parent.data_source_id) !== pageId(library.sources.data_source_id) ||
    (parent.database_id !== undefined &&
      (typeof parent.database_id !== "string" ||
        pageId(parent.database_id) !== pageId(library.sources.database_id))) ||
    property(field("Provider", "select").select).name !== "git" ||
    rich("Content") !== "" ||
    rich("Operation") !== (initial ? "" : operationId)
  )
    throw invalid()
  const last_revision = rich("Last Revision")
  if (last_revision !== "" && !/^[a-f0-9]{40}$/u.test(last_revision))
    throw fail(
      "SOURCE_LEGACY_REVISION_UNSUPPORTED",
      "The legacy Git observation is not an exact accepted commit.",
    )
  return Schema.decodeUnknownSync(LegacySourceRegistrationSchema)({
    source_id: rich("Source ID"),
    source_page_id: page,
    last_revision,
  })
}

export function sameLegacySourceRegistration(
  left: LegacySourceRegistration | undefined,
  right: LegacySourceRegistration | undefined,
): boolean {
  return left === undefined || right === undefined
    ? left === right
    : left.source_id === right.source_id &&
        left.source_page_id === right.source_page_id &&
        left.last_revision === right.last_revision
}
