import { Effect } from "effect"
import { fail, property, SkillsError } from "./model.ts"
import type { Receipt } from "./publication-model.ts"

/** GET failure is missing evidence, not evidence of an external edit. Policy
 * refusals and byte mismatches keep their separate, non-retryable meaning. */
export function readResignedAdoptionAttachment(
  fetch: typeof globalThis.fetch,
  url: string,
  name: string,
) {
  return Effect.gen(function* () {
    for (let attempt = 0; ; attempt++) {
      const result = yield* Effect.tryPromise({
        try: () => fetch(url, { method: "GET", signal: AbortSignal.timeout(60000) }),
        catch: (error) =>
          error instanceof SkillsError
            ? error
            : fail("DOWNLOAD_FAILED", "A re-signed Files download failed.", {
                path: name,
                reason: property(error).name === "TimeoutError" ? "timeout" : "network",
              }),
      }).pipe(
        Effect.flatMap((response) =>
          response.status >= 200 && response.status < 300
            ? Effect.void
            : Effect.fail(
                fail("DOWNLOAD_FAILED", "A re-signed Files download failed.", {
                  path: name,
                  status: response.status,
                }),
              ),
        ),
        Effect.result,
      )
      if (result._tag === "Success") return
      const error = result.failure,
        status = property(error.details).status
      if (
        error.code !== "DOWNLOAD_FAILED" ||
        attempt >= 3 ||
        (typeof status === "number" && status !== 429 && status < 500)
      )
        return yield* Effect.fail(error)
      yield* Effect.sleep(`${2 ** attempt} seconds`)
    }
  })
}

/** The old catch mislabeled a post-attachment GET exception as a conflict.
 * This only selects its exact four-ACK, source-only shape. The caller must
 * still prove the original native authority, whole graph, every guard and
 * every frozen archive byte before it can record a correction. */
export function contentAdoptionDownloadFenceCandidate(receipt: Receipt) {
  const rootPath = `v1/pages/${receipt.page_id}`
  if (
    !receipt.page_id ||
    !receipt.context?.content_adoption ||
    receipt.operation !== "replace" ||
    receipt.state !== "failed" ||
    receipt.conflict !== true ||
    receipt.owner ||
    receipt.result ||
    (receipt.conflict_history?.length ?? 0) !== 0 ||
    receipt.stages.length !== 1 ||
    receipt.stages[0] !== "source_bundle" ||
    receipt.intents.length !== 4 ||
    receipt.failure?.code !== "WRITE_CONFLICT" ||
    receipt.failure.message !== "A re-signed Files download failed." ||
    receipt.failure.details !== undefined ||
    receipt.intents.some(
      (intent) =>
        intent.status !== "completed" ||
        intent.recovery ||
        intent.typed_links ||
        intent.list_start_repair ||
        intent.zero_list_repair,
    )
  )
    return undefined
  const intent = receipt.intents[3]!,
    response = property(intent.response)
  if (
    intent.method !== "PATCH" ||
    intent.path !== rootPath ||
    intent.artifact ||
    response.id !== receipt.page_id ||
    Object.keys(response).some((key) => key !== "id" && key !== "status")
  )
    return undefined
  const acknowledged = property(receipt.guards[rootPath])
  if (
    acknowledged.id !== receipt.page_id ||
    typeof acknowledged.last_edited_time !== "string" ||
    !acknowledged.last_edited_time ||
    !acknowledged.properties
  )
    return undefined
  return { rootPath, acknowledged }
}
