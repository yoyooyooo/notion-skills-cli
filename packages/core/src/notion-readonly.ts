import { Context, Effect } from "effect"
import { fail, type SkillsError } from "./model.ts"
import { Notion } from "./notion.ts"
import { isCoalescibleNotionRead } from "./shared-read-coalescing.ts"

type RequestOptions = NonNullable<Parameters<Notion["Service"]["request"]>[2]>
type ReadOptions = Omit<RequestOptions, "method" | "file">

function relativeNotionPath(path: string): boolean {
  if (!path.startsWith("v1/") || /[\s#\\]/u.test(path) || /%(?![\da-f]{2})/iu.test(path))
    return false
  try {
    const url = new URL(path, "https://readonly.invalid/")
    return url.origin === "https://readonly.invalid" && url.pathname === `/${path.split("?", 1)[0]}`
  } catch {
    return false
  }
}

/** Audit consumers receive reads and semantic queries, never a mutation method. */
export class NotionReadOnly extends Context.Service<
  NotionReadOnly,
  {
    readonly get: (path: string, options?: ReadOptions) => Effect.Effect<unknown, SkillsError>
    readonly query: (
      path: string,
      body: unknown,
      options?: ReadOptions,
    ) => Effect.Effect<unknown, SkillsError>
  }
>()("ntn-skills/NotionReadOnly") {}

/** The original transport is closed over; rejected calls never reach its scheduler. */
export function readOnlyNotion(api: Notion["Service"]): Notion["Service"] {
  return {
    ...api,
    request: (path, body, options) =>
      Effect.suspend(() => {
        const method = options?.method ?? (body === undefined ? "GET" : "POST")
        // Stable Notion property IDs can contain percent-encoded punctuation.
        // Preserve those IDs while rejecting origins and URL-normalized traversal.
        if (
          !relativeNotionPath(path) ||
          (method === "GET" && body !== undefined) ||
          !isCoalescibleNotionRead({ key: "readonly", path, method, file: options?.file })
        )
          return Effect.fail(
            fail(
              "NOTION_READ_ONLY",
              "This observation has no Notion mutation capability. Use a separate explicit update or recovery operation.",
              { phase: "input_rejected", reason: "semantic_write_forbidden", method, path },
            ),
          )
        return api.request(path, body, options)
      }),
  }
}

/**
 * Restrict the complete descendant call chain, including existing helpers that
 * still depend on Notion. Pending reconciliation cannot regain the outer writer.
 */
export function withReadOnlyNotion<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const api = readOnlyNotion(yield* Notion)
    return yield* effect.pipe(
      Effect.provideService(Notion, api),
      Effect.provideService(NotionReadOnly, {
        get: (path, options) => api.request(path, undefined, { ...options, method: "GET" }),
        query: (path, body, options) => api.request(path, body, { ...options, method: "POST" }),
      }),
    )
  })
}
