import { Context, Effect, Option, Stream } from "effect"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http"
import { fail } from "./model.ts"
import { withinRequestBudget, type RequestBudget } from "./request-budget.ts"

// A current original is at most 64 MiB; its supported one-file ZIP may add 64 KiB.
export const BUDGETED_PROVIDER_RESPONSE_LIMIT = 64 * 1024 * 1024 + 64 * 1024
const budgetedClients = new WeakMap<
  HttpClient.HttpClient,
  { readonly client: HttpClient.HttpClient; readonly budget: RequestBudget["Service"] }
>()

/** Optional diagnostics run after admission, immediately before the provider transport. */
export class ProviderRequestAdmission extends Context.Service<
  ProviderRequestAdmission,
  { readonly admitted: () => void }
>()("ntn-skills/ProviderRequestAdmission") {}

/** Provider GETs use the same invocation permits as Notion attempts. The Notion
 * transport has already captured its own client, so it is not double charged.
 * Buffering one admitted provider response preserves existing checksum owners;
 * it also records actual streamed bytes before any provider error mapping. */
export function requestBudgetHttpClient(
  client: HttpClient.HttpClient,
  budget: RequestBudget["Service"],
) {
  const existing = budgetedClients.get(client)
  if (existing?.budget === budget) return client
  const base = existing?.client ?? client
  const wrapped = HttpClient.transform(base, (response, request) =>
    Effect.gen(function* () {
      if (request.body._tag !== "Empty" && request.body._tag !== "Uint8Array")
        return yield* Effect.fail(
          fail(
            "REQUEST_BODY_UNMEASURED",
            "The bounded invocation requires an empty or exactly measured request body.",
          ),
        )
      yield* budget.admit(request.body._tag === "Uint8Array" ? request.body.body.byteLength : 0)
      const observer = yield* Effect.serviceOption(ProviderRequestAdmission)
      if (Option.isSome(observer)) observer.value.admitted()
      const result = yield* response
      let size = 0
      const chunks = yield* result.stream.pipe(
        Stream.mapEffect((chunk) => {
          size += chunk.byteLength
          budget.responseBytes(chunk.byteLength)
          return size > BUDGETED_PROVIDER_RESPONSE_LIMIT
            ? Effect.fail(
                fail(
                  "REQUEST_RESPONSE_LIMIT",
                  "A provider response exceeded the invocation response bound.",
                ),
              )
            : Effect.succeed(chunk)
        }),
        Stream.runCollect,
      )
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      return HttpClientResponse.fromWeb(
        request,
        new Response(bytes, { status: result.status, headers: result.headers }),
      )
    }).pipe(
      budget.withPermit,
      (effect) => withinRequestBudget(effect, budget),
      Effect.mapError((error) =>
        error instanceof HttpClientError.HttpClientError
          ? error
          : new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request, cause: error }),
            }),
      ),
    ),
  )
  budgetedClients.set(wrapped, { client: base, budget })
  return wrapped
}
