import { Clock, Effect, Schema } from "effect"
import { decode, fail, SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import { pageId } from "./ref.ts"
import { sha256 } from "./store.ts"
import { normalizeObservedBody, type BodyFingerprint } from "./shared-file-state.ts"

const MarkdownBodySchema = Schema.Struct({
  id: Schema.String,
  markdown: Schema.String,
  truncated: Schema.Boolean,
  unknown_block_ids: Schema.Array(Schema.String),
})

export function observeSharedBody(page: string) {
  return Effect.gen(function* () {
    const id = pageId(page)
    if (!id)
      return yield* Effect.fail(fail("INVALID_ARGUMENT", "Observe an exact Notion body page."))
    const raw = yield* (yield* Notion).request(`v1/pages/${id}/markdown?markdown_version=v2`)
    const body = yield* Effect.try({
      try: () => decode(MarkdownBodySchema, raw),
      catch: () => fail("BODY_INCOMPLETE", "Notion did not return a complete Markdown response."),
    })
    if (pageId(body.id) !== id || body.truncated || body.unknown_block_ids.length)
      return yield* Effect.fail(
        fail(
          "BODY_INCOMPLETE",
          "A partial or unavailable body cannot establish ownership or a complete snapshot.",
          { page_id: id, truncated: body.truncated, unknown_block_ids: body.unknown_block_ids },
        ),
      )
    const markdown = yield* Effect.try({
      try: () => normalizeObservedBody(body.markdown),
      catch: (error) =>
        error instanceof SkillsError
          ? error
          : fail("BODY_INCOMPLETE", "The body could not be normalized."),
    })
    const bytes = new TextEncoder().encode(markdown)
    const fingerprint: BodyFingerprint = { normalization_version: 1, sha256: yield* sha256(bytes) }
    return {
      page_id: id,
      markdown,
      fingerprint,
      bytes: bytes.length,
      downloaded_at: yield* Clock.currentTimeMillis,
    }
  })
}
