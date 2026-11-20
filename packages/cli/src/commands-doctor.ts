import { Effect, Option } from "effect"
import { Command } from "effect/cli"

import { Notion, catalog } from "@notion-skills-cli/core"

import { defineCommand } from "../../core/src/command-schema.ts"
import { inspectSharedRelationSchema } from "../../core/src/shared-library-relations.ts"

import { databaseFlag, emit } from "./command-options.ts"
export const doctorCommand = defineCommand("doctor", { database: databaseFlag }, (options) =>
  Effect.gen(function* () {
    const api = yield* Notion
    const version = yield* api.version
    yield* api.connectionIdentity ?? api.request("v1/users/me")
    const database = Option.getOrUndefined(options.database)
    if (database === undefined) {
      yield* emit({
        transport: "direct_http",
        notion_api_version: version,
        authentication: "available",
        discovery: { checked: false, reason: "Select --database to inspect one catalog." },
        skill_read: { checked: false, reason: "No database selected." },
      })
      return
    }
    const result = yield* catalog({ database, refresh: true })
    const nativeRelations = yield* Effect.forEach(
      result.databases.flatMap((source) =>
        source.shared_library === undefined ? [] : [source.shared_library],
      ),
      inspectSharedRelationSchema,
    )
    yield* emit({
      transport: "direct_http",
      notion_api_version: version,
      authentication: "available",
      discovery: { checked: true },
      skills_databases: result.databases.length,
      skill_count: result.records.length,
      skill_read: {
        checked: false,
        reason: "Doctor checks metadata only. Use read with an explicit target to verify content.",
      },
      coverage: result.coverage,
      native_relations: nativeRelations,
    })
  }),
).pipe(
  Command.withShortDescription(
    "Check direct Notion API authentication and an optional selected catalog",
  ),
  Command.withDescription(
    "Validate the project's direct Notion API connection. Authentication priority is config.token > NOTION_API_TOKEN; use ctl config set-token --stdin to configure a token. Without --database this checks authentication only. With --database, inspect the selected catalog metadata and registered schema. Inspect coverage.failed_sources and native_relations for incomplete discovery or schema health. Skill content is not read; use read with an explicit target to verify it. Does not modify Notion content.",
  ),
  Command.withExamples([
    {
      command: "ntn-skills ctl doctor --database DATABASE_ID",
      description: "Diagnose the existing connection before online operations",
    },
  ]),
)
