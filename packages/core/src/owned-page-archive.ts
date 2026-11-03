import { Effect, Schema } from "effect"
import { authScope } from "./catalog.ts"
import { withLocalLocks } from "./local-locks.ts"
import { fail, property } from "./model.ts"
import { Notion } from "./notion.ts"
import { PublicationReceiptSchema } from "./publication-model.ts"
import { pageId } from "./ref.ts"
import { loadSharedCreateOwnership } from "./shared-create-ownership.ts"
import { Store } from "./store.ts"

const ArchiveReceiptSchema = Schema.Struct({
  version: Schema.Literal(1),
  scope: Schema.String,
  operation_id: Schema.String,
  page_id: Schema.String,
  state: Schema.Literals(["unknown", "rejected", "acknowledged", "archived"]),
  attempts: Schema.Number,
  failure_code: Schema.optional(Schema.String),
})
type ArchiveReceipt = typeof ArchiveReceiptSchema.Type

/** Archive only exact pages acknowledged by a completed original creation. */
export function archiveOwnedPage(
  target: string,
  operationId: string,
  options: { readonly dryRun?: boolean } = {},
) {
  return Effect.gen(function* () {
    const page = pageId(target)
    if (!page || !/^(?:p_[A-Za-z0-9-]{1,100}|skill-create-[a-f0-9]{64})$/u.test(operationId))
      return yield* Effect.fail(
        fail(
          "INVALID_ARGUMENT",
          "Select an exact created page ID and its original create operation ID.",
        ),
      )
    const store = yield* Store
    const api = yield* Notion
    const scope = yield* authScope
    let ownedPages: readonly string[]
    const refused = () =>
      fail(
        "ARCHIVE_OWNERSHIP_REQUIRED",
        "The completed original creation does not prove ownership of this page in the selected credential scope.",
        { operation_id: operationId, page_id: page },
      )
    if (operationId.startsWith("p_")) {
      const original = yield* store.readJson(
        `publications/${operationId}.json`,
        PublicationReceiptSchema,
      )
      if (
        !original ||
        original.operation_id !== operationId ||
        original.operation !== "create" ||
        original.state !== "completed" ||
        original.scope !== scope ||
        original.intents.some(
          (intent) => intent.status === "pending" || intent.status === "unknown",
        ) ||
        !original.intents.some(
          (intent) =>
            intent.method === "POST" &&
            intent.path === "v1/pages" &&
            intent.status === "completed" &&
            pageId(String(property(intent.response).id ?? "")) === page,
        )
      )
        return yield* Effect.fail(refused())
      ownedPages = original.intents.flatMap((intent) => {
        const id = pageId(String(property(intent.response).id ?? ""))
        return intent.method === "POST" &&
          intent.path === "v1/pages" &&
          intent.status === "completed" &&
          id
          ? [id]
          : []
      })
    } else {
      const original = yield* loadSharedCreateOwnership(scope, operationId)
      if (
        !original ||
        original.scope !== scope ||
        original.operation_id !== operationId ||
        !original.created_pages.some((item) => item.page_id === page)
      )
        return yield* Effect.fail(refused())
      ownedPages = original.created_page_ids
    }
    const prefix = `operations/owned-page-archive/${scope}/${operationId}/${page}`
    return yield* withLocalLocks(
      store.root,
      [`owned-page-archive:${scope}:${page}`],
      Effect.gen(function* () {
        const keys = [...(yield* store.listKeys(prefix))].sort()
        const eventKey = (index: number) => `${prefix}/${String(index).padStart(20, "0")}.json`
        if (keys.some((key, index) => key !== eventKey(index)))
          return yield* Effect.fail(
            fail("STATE_CORRUPT", "The original archive event sequence is incomplete."),
          )
        const prior = keys.length
          ? yield* store.readJson(keys[keys.length - 1]!, ArchiveReceiptSchema)
          : undefined
        if (keys.length && prior === undefined)
          return yield* Effect.fail(fail("STATE_CORRUPT", "The latest archive event is missing."))
        let nextEvent = keys.length
        // Every transition is immutable, including the pre-dispatch fence.
        const append = (receipt: ArchiveReceipt) => store.writeJson(eventKey(nextEvent++), receipt)
        if (
          prior &&
          (prior.scope !== scope || prior.operation_id !== operationId || prior.page_id !== page)
        )
          return yield* Effect.fail(
            fail("STATE_CORRUPT", "The archive receipt differs from its exact owner."),
          )
        const readback = Effect.gen(function* () {
          const observed = property(yield* api.request(`v1/pages/${page}`))
          if (
            pageId(String(observed.id ?? "")) !== page ||
            typeof (observed.in_trash ?? observed.archived) !== "boolean"
          )
            return yield* Effect.fail(
              fail(
                "INVALID_RESPONSE",
                "Archive readback did not identify the exact page and archive state.",
              ),
            )
          return (observed.in_trash ?? observed.archived) === true
        })
        const observed = yield* readback
        const saved: ArchiveReceipt = prior ?? {
          version: 1,
          scope,
          operation_id: operationId,
          page_id: page,
          state: "unknown",
          attempts: 0,
        }
        const identity = {
          operation_id: operationId,
          page_id: page,
          receipt_path: `sqlite:${prefix}`,
        }
        if (options.dryRun)
          return {
            ...identity,
            dry_run: true,
            archived: observed,
            verified: true,
            owned_page_ids: [...new Set(ownedPages)],
          }
        if (observed) {
          if (prior?.state !== "archived") yield* append({ ...saved, state: "archived" })
          return { ...identity, archived: true, verified: true, reused: true }
        }
        if (prior && prior.state !== "rejected")
          return yield* Effect.fail(
            fail(
              "ARCHIVE_OUTCOME_UNKNOWN",
              "The original archive is not confirmed. Its write will not be repeated; retain the original receipt and inspect this page.",
              identity,
            ),
          )
        const intent: ArchiveReceipt = { ...saved, state: "unknown", attempts: saved.attempts + 1 }
        // Durable dispatch fence precedes the only permitted mutation.
        yield* append(intent)
        const attempt = yield* api
          .request(`v1/pages/${page}`, { in_trash: true }, { method: "PATCH" })
          .pipe(Effect.result)
        if (attempt._tag === "Failure") {
          const phase = property(attempt.failure.details).phase
          const rejected = ["input_rejected", "not_sent", "definitive_rejection"].includes(
            String(phase),
          )
          yield* append({
            ...intent,
            state: rejected ? "rejected" : "unknown",
            failure_code: attempt.failure.code,
          })
          if (rejected) return yield* Effect.fail(attempt.failure)
        } else yield* append({ ...intent, state: "acknowledged" })
        const after = yield* readback.pipe(Effect.result)
        if (after._tag === "Success" && after.success) {
          yield* append({ ...intent, state: "archived" })
          return { ...identity, archived: true, verified: true, reused: false }
        }
        return yield* Effect.fail(
          fail(
            "ARCHIVE_OUTCOME_UNKNOWN",
            "The archive result is unconfirmed. Inspect the original receipt; rerunning this command only reads the original unknown attempt.",
            identity,
          ),
        )
      }),
    )
  })
}
