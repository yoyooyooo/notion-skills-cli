import { Clock, Effect, Option, Stdio, Stream } from "effect"
import { Argument, Command } from "effect/cli"
import { consume } from "../../core/src/consumer.ts"
import { defineCommand, withConstraints } from "../../core/src/command-schema.ts"
import { fail, property, SkillsError } from "../../core/src/model.ts"
import { catalog } from "../../core/src/catalog.ts"
import { isCurrentNameTarget, resolveCatalogReference } from "../../core/src/catalog-reference.ts"
import { parseTarget } from "../../core/src/ref.ts"
import { Notion } from "../../core/src/notion.ts"
import {
  databaseFlag,
  emit,
  filesConstraints,
  readPolicy,
  readPolicyFlags,
  switchFlag,
} from "./command-options.ts"

export const useCommand = defineCommand(
  "use",
  {
    selector: Argument.String("ref").pipe(
      Argument.withDescription("One Skill name, ID, or canonical skill:// entrypoint ref"),
    ),
    database: databaseFlag,
    ...readPolicyFlags,
    readOnly: switchFlag(
      "read-only",
      "Forbid every remote write, including internal history retention",
    ),
    json: switchFlag("json", "Return complete bodies and machine evidence as structured JSON"),
    metrics: switchFlag("metrics", "Include measured HTTP attempts and bytes; requires --json"),
  },
  (config) =>
    Effect.gen(function* () {
      if (config.metrics && !config.json)
        return yield* Effect.fail(fail("INVALID_ARGUMENT", "--metrics requires --json."))
      const startedAt = yield* Clock.currentTimeMillis
      const policy = yield* readPolicy(config)
      const target = yield* Effect.try({
        try: () => parseTarget(config.selector),
        catch: (error) =>
          error instanceof SkillsError
            ? error
            : fail("INVALID_ARGUMENT", "Invalid Skill reference."),
      })
      let selected = config.selector
      // Canonical and fixed refs are direct. Only human names need a metadata
      // lookup, and it must establish uniqueness before loading any body.
      if (isCurrentNameTarget(target)) {
        const directory = yield* catalog({
          ...policy,
          database: Option.getOrUndefined(config.database),
        })
        const selection = yield* Effect.try({
          try: () => resolveCatalogReference(config.selector, directory),
          catch: (error) =>
            error instanceof SkillsError
              ? error
              : fail("INVALID_ARGUMENT", "Invalid Skill selection."),
        })
        selected = selection.ref
      }
      const freshness = policy.offline
        ? { policy: "offline" as const }
        : policy.refresh
          ? { policy: "refresh" as const }
          : policy.maxAge !== undefined
            ? { policy: "max_age" as const, max_age_ms: policy.maxAge }
            : { policy: "default" as const }
      const result = yield* consume(
        { version: 1, targets: [selected], purpose: "use", freshness },
        {
          database: Option.getOrUndefined(config.database),
          metrics: config.metrics,
          readOnly: config.readOnly,
        },
      )
      if (result.status === "failed")
        return yield* Effect.fail(
          fail(result.error.code, result.error.message, {
            ...property(result.error.details),
            effects: result.effects,
          }),
        )
      if (result.status === "cancelled")
        return yield* Effect.fail(
          fail("CANCELLED", "Skill consumption was cancelled.", { effects: result.effects }),
        )
      if (config.json) {
        yield* emit(
          config.metrics
            ? {
                ...result,
                elapsed_ms: (yield* Clock.currentTimeMillis) - startedAt,
                request_metrics: (yield* Notion).requestMetrics?.(),
              }
            : result,
        )
        return
      }
      const effectsText =
        result.effects?.remote_writes === "none"
          ? "Effects: no remote writes."
          : result.effects?.remote_writes === "retained"
            ? "Effects: internal history retained; author content unchanged."
            : "Effects: remote write outcome unknown; do not report zero writes."
      const text =
        effectsText +
        "\n\n" +
        result.preparation.nodes
          .flatMap((node) => {
            if (node.state !== "prepared") return []
            const resources = node.files.filter((file) => file.path !== node.path)
            return [
              `## ${node.record.name}\nRef: ${node.ref}\n\n${node.content}`,
              ...(resources.length
                ? [
                    "Supporting files:\n" +
                      resources.map((file) => `- ${file.path}: ${file.ref}`).join("\n"),
                  ]
                : []),
              ...(node.candidates.length
                ? [
                    "Optional members (metadata only):\n" +
                      node.candidates
                        .map(
                          (entry) =>
                            `- ${entry.name} [${entry.availability}]: ${entry.description}\n  ${entry.ref}`,
                        )
                        .join("\n"),
                  ]
                : []),
              ...(node.references.length
                ? [
                    "References (metadata only):\n" +
                      node.references
                        .map(
                          (entry) =>
                            `- ${entry.name} [${entry.availability}]: ${entry.description}\n  ${entry.ref} (from ${entry.from})`,
                        )
                        .join("\n"),
                  ]
                : []),
              ...(node.unresolved_references.length
                ? [
                    "Unresolved references:\n" +
                      node.unresolved_references
                        .map(
                          (entry) => `- ${entry.href} [${entry.availability}] (from ${entry.from})`,
                        )
                        .join("\n"),
                  ]
                : []),
            ]
          })
          .join("\n\n") +
        "\n"
      yield* Stream.make(text).pipe(Stream.run((yield* Stdio.Stdio).stdout()))
    }),
).pipe(
  withConstraints(filesConstraints),
  Command.withShortDescription("Load one Skill and its complete Requires instructions"),
  Command.withDescription(
    "Use one entrypoint ref to load the root and complete Requires closure in one consumption. Member bodies stay lazy. Prepared content does not attest model delivery or activation. Copy returned canonical refs for supporting files; use read for an introduction or exact resource, files for file metadata, and export for a package. Compact text is the default; --json retains complete structured evidence. Cache and fixed-version policies are shared with read. Advanced graph, session and budget controls are available through ctl prepare.",
  ),
  Command.withExamples([
    {
      command: "ntn-skills use 'skill://review/SKILL.md'",
      description: "Load the root instructions and every required Skill once",
    },
  ]),
)
