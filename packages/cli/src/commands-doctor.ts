import { Effect } from "effect"
import { Command } from "effect/cli"

import { Notion, catalog, openSkill } from "@notion-skills-cli/core"

import { defineCommand } from "../../core/src/command-schema.ts"

import { emit } from "./command-options.ts"
export const doctorCommand = defineCommand("doctor", {}, () =>
  Effect.gen(function* () {
    const api = yield* Notion
    const version = yield* api.version
    const result = yield* catalog({ refresh: true })
    let readStatus: unknown = {
      checked: false,
      reason: "No skill is present in the discovered list.",
    }
    if (result.records[0]) {
      const snapshot = yield* openSkill(result.records[0].id, { refresh: true })
      readStatus = {
        checked: true,
        available: true,
        storage: snapshot.markdown_files
          ? "markdown_files"
          : snapshot.references
            ? "references"
            : "native_skills",
      }
    }
    yield* emit({
      ntn_version: version,
      authentication: "available",
      skills_databases: result.databases.filter((database) => database.role !== "upstream").length,
      skill_count: result.records.length,
      skill_read: readStatus,
      coverage: result.coverage,
    })
  }),
).pipe(
  Command.withShortDescription("Check ntn, authentication, discovery and Skill reading"),
  Command.withDescription(
    "Check ntn version, existing authentication, discovery coverage and reading one current Skill. The read caches its files. Does not start login. Authentication priority: config.token > NOTION_API_TOKEN > existing ntn login. Use config set-token --stdin to configure a token. Inspect coverage.failed_sources and skill_read; checked=false means no Skill was available to probe.",
  ),
  Command.withExamples([
    {
      command: "ntn-skills doctor",
      description: "Diagnose the existing connection before online operations",
    },
  ]),
)
