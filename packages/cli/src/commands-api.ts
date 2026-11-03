import { Effect } from "effect"
import { Argument, Command } from "effect/cli"
import { Notion, fail } from "@notion-skills-cli/core"
import { defineCommand } from "../../core/src/command-schema.ts"
import { emit } from "./command-options.ts"

export const apiCommand = defineCommand(
  "api",
  { path: Argument.String("relative-path") },
  ({ path }) =>
    Effect.gen(function* () {
      if (!/^v1\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+(?:\?[^#\s]*)?$/u.test(path))
        return yield* Effect.fail(
          fail(
            "INVALID_ARGUMENT",
            "Use a relative v1 API path without an origin or path traversal.",
          ),
        )
      const api = yield* Notion
      const response = yield* api.request(path, undefined, { method: "GET" })
      yield* emit({ response, request_metrics: api.requestMetrics?.() })
    }),
).pipe(
  Command.withShortDescription("Read one exact Notion API resource through the project connection"),
  Command.withDescription(
    "GET one relative v1 API path through the same project credentials, scheduler and HTTP engine as content reads. Query parameters are supported; origins, path traversal, request bodies and write methods are rejected. This diagnostic response is a raw Notion read, not a Skill snapshot or an ownership receipt. Use the normal content commands for discovery and authoring.",
  ),
)
