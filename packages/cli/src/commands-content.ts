import { Clock, Context, Effect, FileSystem, Option, Path, Schema, Stdio, Stream } from "effect"
import { Argument, Command, Flag } from "effect/cli"

import {
  Notion,
  SkillsError,
  listViews,
  exportSkill,
  listSkill,
  readSkill,
  resolveSkillRef,
} from "@notion-skills-cli/core"

import { defineCommand, withConstraints } from "../../core/src/command-schema.ts"
import { fail } from "../../core/src/model.ts"
import { listSkills } from "../../core/src/catalog-consumption.ts"

import {
  filesConstraints,
  readConstraints,
  exportConstraints,
  validateConstraints,
  databaseFlag,
  singleton,
  requiredSingleton,
  switchFlag,
  readPolicyFlags,
  readPolicy,
  emit,
} from "./command-options.ts"
const requestMetricsFlag = switchFlag(
  "metrics",
  "Include measured request counts, payload bytes and elapsed time in JSON output",
)
function measuredOutput<A extends object>(value: A, enabled: boolean, startedAt: number) {
  return Effect.gen(function* () {
    if (!enabled) return value
    return {
      ...value,
      elapsed_ms: (yield* Clock.currentTimeMillis) - startedAt,
      request_metrics: (yield* Notion).requestMetrics?.(),
    }
  })
}
export const listCommand = defineCommand(
  "list",
  {
    database: databaseFlag,
    view: singleton(
      "view",
      "Select an exact Notion View ID or URL; cannot be combined with --default-view",
    ),
    defaultView: switchFlag(
      "default-view",
      "Use the bound Profile default, or the first View for the selected content database",
    ),
    profile: singleton(
      "profile",
      "Use this shared Profile default; requires --database, and an explicit --view takes precedence",
    ),
    ...readPolicyFlags,
    metrics: requestMetricsFlag,
    query: singleton("query", "Case-insensitive filter on Name, invocation alias and Description"),
    limit: singleton("limit", "Maximum metadata records, 1-500 (default 50)"),
    cursor: singleton("cursor", "Copy next_cursor from the same directory and query"),
    json: switchFlag("json", "Emit the structured JSON result (the default)"),
  },
  (config) =>
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis
      if (Option.isSome(config.view) && config.defaultView)
        return yield* Effect.fail(
          new SkillsError({
            code: "INVALID_ARGUMENT",
            message: "--view and --default-view are mutually exclusive.",
          }),
        )
      const options = {
        database: Option.getOrUndefined(config.database),
        ...(yield* readPolicy(config)),
      }
      const result = yield* listSkills({
        ...options,
        view: Option.getOrUndefined(config.view),
        defaultView: config.defaultView,
        profile: Option.getOrUndefined(config.profile),
        query: Option.getOrUndefined(config.query),
        limit: Option.isSome(config.limit) ? Number(config.limit.value) : undefined,
        cursor: Option.getOrUndefined(config.cursor),
      })
      yield* emit(yield* measuredOutput(result, config.metrics, startedAt))
    }),
).pipe(
  Command.withShortDescription("List available skills with names, descriptions and refs"),
  Command.withDescription(
    "Use --view ID/Notion-URL for an exact session View, or --default-view for the bound shared Profile default and otherwise the first View in API order; --view and --default-view are mutually exclusive. --profile ID --database ENTRY selects a shared Profile for this invocation. An explicit --view takes precedence over Profile rules. A machine binding is consulted only with --default-view; an explicit different database uses that database's first View. Default capability directories omit Prompts. Bare list discovers the accessible source scope, including Prompts, regardless of the machine binding. Output defaults to 50 records (maximum --limit 500); follow next_cursor with --cursor until has_more is false. count is this page and total_count is the filtered observation; neither upgrades source coverage. Copy the returned cursor unchanged with the same query and selection; changed observations return LIST_CURSOR_STALE. --json is explicit; structured JSON is the default. View membership uses the native query including quick filters, not an additional Default Context gate; Profile and View rules never grant access. List paginated lightweight metadata from current libraries with explicit successful-query coverage. Routers expose current Members; each Skill remains independently available. --query filters Name/alias/Description while retaining the database map. Catalog age defaults to 60s; --refresh validates online, --offline uses stored observations, --max-age overrides age. These policies are mutually exclusive. Cache freshness never improves discovery coverage; failed sources stay explicit. --database accepts one ID, URL or exact registered alias; Search is not workspace-exhaustive.",
  ),
  Command.withExamples([
    {
      command: "ntn-skills list",
      description: "Discover accessible skills before selecting a workflow",
    },
    {
      command: "ntn-skills list --query governance --refresh",
      description: "Filter current metadata by Name, alias or Description",
    },
    {
      command: "ntn-skills list --database DATABASE_ID",
      description: "Query a known Skills Database; replace DATABASE_ID with its ID or URL",
    },
    {
      command: "ntn-skills list --database LIBRARY_ENTRY",
      description: "Query current Skills from the exact Skills database entry",
    },
    {
      command: "ntn-skills list --profile daily --database LIBRARY_ID",
      description: "Use the shared daily Profile's default capability directory",
    },
  ]),
)

export const viewsCommand = defineCommand(
  "views",
  { database: databaseFlag, ...readPolicyFlags },
  (config) =>
    Effect.gen(function* () {
      yield* emit(
        yield* listViews({
          database: Option.getOrUndefined(config.database),
          ...(yield* readPolicy(config)),
        }),
      )
    }),
).pipe(
  Command.withDescription(
    "List Notion Views in API order, without reading Skill bodies. Use --database for an ID, URL or registered alias; without it the content library must be unambiguous. View names are display labels, IDs are identities. --refresh, --offline and --max-age follow the catalog observation policy.",
  ),
)

export const readCommand = defineCommand(
  "read",
  {
    selector: Argument.String("target").pipe(
      Argument.withDescription(
        "Name, invocation alias, page ID/URL, skill:// ref, cached snapshot ID, or relative path with --from",
      ),
    ),
    path: singleton("path", "Skill-relative file path; target must not already contain a path"),
    database: databaseFlag,
    metrics: requestMetricsFlag,
    json: switchFlag("json", "Emit the stable JSON result; incompatible with --raw"),
    ...readPolicyFlags,
    from: singleton(
      "from",
      "Resolve the first argument relative to this containing-file skill:// ref; preserve its snapshot when pinned",
    ),
    lines: singleton(
      "lines",
      "Inclusive 1-based range START-END or one line START; incompatible with --output",
    ),
    output: singleton(
      "output",
      "Write exact bytes to a local path; reuse identical content, reject differing output; incompatible with --lines/--raw",
    ),
    raw: switchFlag(
      "raw",
      "Emit successful UTF-8 text only; failures remain JSON; incompatible with --output",
    ),
  },
  (config) =>
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis
      if (config.raw && config.metrics)
        return yield* Effect.fail(
          new SkillsError({
            code: "INVALID_ARGUMENT",
            message: "--metrics requires JSON output; omit --raw.",
          }),
        )
      yield* validateConstraints(readConstraints, config)
      const result = yield* readSkill(config.selector, {
        path: Option.getOrUndefined(config.path),
        database: Option.getOrUndefined(config.database),
        from: Option.getOrUndefined(config.from),
        lines: Option.getOrUndefined(config.lines),
        output: Option.getOrUndefined(config.output),
        ...(yield* readPolicy(config)),
      })
      if (config.raw) {
        const stdio = yield* Stdio.Stdio
        yield* Stream.make("content" in result ? result.content : "").pipe(
          Stream.run(stdio.stdout()),
        )
      } else yield* emit(yield* measuredOutput(result, config.metrics, startedAt))
    }),
).pipe(
  Command.withShortDescription("Read one file with bounded cache freshness or a pinned snapshot"),
  Command.withDescription(
    "Read SKILL.md, ROUTER.md, PROMPT.md or an exact selected path. Current reads validate complete Files metadata and current Content descriptors. Native edits are read directly into local cache; Source and resource content keep exact bytes. All consumption forbids semantic Notion writes. Eligible current observations may be reused within the freshness policy; --refresh reads native bodies again, --offline requires local selected bytes, and --max-age overrides age. Native bodies also have an independent 24-hour deadline. A local selected ref preserves its complete directory and bytes while available. Missing bytes use only an unchanged current declared Source/resource route; otherwise select current content again. No historical retrieval or adoption runs. --from resolves within the containing file; cross-root links require an explicit current Skill ref. --lines is an inclusive range, --output writes exact bytes and refuses conflicting output, and --raw emits successful text only. Disabled content and access errors remain explicit.",
  ),
  Command.withExamples([
    {
      command: "ntn-skills read 'skill://resource-tag-governance/SKILL.md'",
      description: "Read the current entrypoint by invocation name",
    },
    {
      command: "ntn-skills read 'Resource Tag Governance'",
      description: "Read the default SKILL.md by display Name",
    },
    {
      command: "ntn-skills read SNAPSHOT_ID --path references/guide.md --lines 10-30",
      description: "Read an attachment from a local fixed version",
    },
    {
      command: "ntn-skills read vocabulary.md --from 'PINNED_REF'",
      description: "Resolve an attachment relative to the returned containing-file ref",
    },
    {
      command: "ntn-skills read SNAPSHOT_ID --path assets/image.png --output ./image.png",
      description: "Export a binary asset for a host viewer; identical output is reused",
    },
  ]),
)

export const filesCommand = defineCommand(
  "files",
  {
    selector: Argument.String("target").pipe(
      Argument.withDescription(
        "Name, invocation alias, page ID/URL, skill:// ref, or cached snapshot ID",
      ),
    ),
    path: singleton(
      "path",
      "File/directory filter; omit for every file; cannot replace a ref's path",
    ),
    database: databaseFlag,
    metrics: requestMetricsFlag,
    ...readPolicyFlags,
  },
  (config) =>
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis
      yield* validateConstraints(filesConstraints, config)
      const result = yield* listSkill(config.selector, {
        path: Option.getOrUndefined(config.path),
        database: Option.getOrUndefined(config.database),
        ...(yield* readPolicy(config)),
      })
      yield* emit(yield* measuredOutput(result, config.metrics, startedAt))
    }),
).pipe(
  Command.withShortDescription("List snapshot files and their pinned refs"),
  Command.withDescription(
    "List pinned file refs from one complete snapshot. Current targets follow the 5m content policy; use mutually exclusive --refresh, --offline or --max-age. Ordinary aligned native Skills may revalidate metadata and reuse their complete file set (freshness.validation=metadata); --refresh or explicit --max-age 0 validates current native bodies and the fixed source manifest without downloading every supporting raw resource. Pinned refs/snapshot IDs preserve the immutable manifest and reject refresh/max-age. Listing does not establish local readiness of every file; read a selected path or export to acquire its exact bytes. --path filters one file/directory when the target has no path; a file ref filters itself, a pathless ref lists every file. Source/freshness describe the selected observation, not current access when cached.",
  ),
  Command.withExamples([
    {
      command: "ntn-skills files SNAPSHOT_ID --path references",
      description: "Find attachment paths in the same snapshot",
    },
  ]),
)

export const exportCommand = defineCommand(
  "export",
  {
    selector: Argument.String("skill-or-ref-or-snapshot").pipe(
      Argument.withDescription("Skill name, page ID/URL, skill:// ref, or cached snapshot ID"),
    ),
    output: requiredSingleton(
      "output",
      "Destination ZIP or directory; identical content is reused, differing output is never overwritten",
    ),
    format: singleton("format", "zip or directory; default: zip for .zip outputs"),
    database: databaseFlag,
    ...readPolicyFlags,
  },
  (config) =>
    Effect.gen(function* () {
      const format = Option.getOrUndefined(config.format)
      yield* validateConstraints(exportConstraints, config)
      yield* emit(
        yield* exportSkill(config.selector, {
          output: config.output,
          format: format as "zip" | "directory" | undefined,
          database: Option.getOrUndefined(config.database),
          ...(yield* readPolicy(config)),
        }),
      )
    }),
).pipe(
  Command.withShortDescription("Export a complete reversible Skill as ZIP or folder"),
  Command.withDescription(
    "Export the complete currently selected file tree as a directory or deterministic ZIP. Exact Source/resource bytes and executable modes are preserved; native files use their explicit current frontmatter and normalized body. Notion is never changed. The destination must be new or byte-for-byte identical. A local selected ref may be used while its manifest and required bytes remain available; missing exact bytes can only use an unchanged current declared location, otherwise select current content again. --offline requires every byte locally. Use read --path PATH --output FILE for one file. A portable manifest describes this export; no remote content version or history is created.",
  ),
  Command.withExamples([
    {
      command: "ntn-skills export 'My Workflow' --output ./my-workflow.zip",
      description: "Export an importable deterministic ZIP",
    },
    {
      command: "ntn-skills export 'PINNED_REF' --output ./my-workflow",
      description: "Export one immutable snapshot as a complete folder",
    },
  ]),
)
export const resolveCommand = defineCommand(
  "resolve",
  {
    relative: Argument.String("relative-path").pipe(
      Argument.withDescription(
        "File path relative to --from; source-member crossings require the exact active source publication map",
      ),
    ),
    from: requiredSingleton(
      "from",
      "Containing-file skill:// ref; a pinned snapshot is preserved in the returned ref",
    ),
  },
  (config) =>
    Effect.gen(function* () {
      const ref = yield* resolveSkillRef(config.from, config.relative)
      yield* emit({ ref })
    }),
).pipe(
  Command.withShortDescription("Resolve relative resource refs using exact source identity"),
  Command.withDescription(
    "Resolve a path within the containing Skill from its returned skill:// file ref. This pure offline transformation preserves the local selected snapshot. A path cannot cross the Skill root; use an explicit current Skill ref for another owner. Returns JSON with ref. Replace PINNED_REF with the containing file's returned ref.",
  ),
  Command.withExamples([
    {
      command: "ntn-skills ctl resolve ../assets/template.md --from 'PINNED_REF'",
      description: "Resolve from a nested reference file and retain its fixed version",
    },
  ]),
)
