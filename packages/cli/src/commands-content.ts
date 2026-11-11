import { Clock, Context, Effect, Option, Stdio, Stream } from "effect"
import { Argument, Command, Flag } from "effect/cli"

import {
  Notion,
  SkillsError,
  listViews,
  createSkill,
  applySkill,
  replaceSkill,
  exportSkill,
  writeSkill,
  listSkill,
  readSkill,
  resolveSkillRef,
  updateSkill,
} from "@notion-skills-cli/core"

import { defineCommand, withConstraints } from "../../core/src/command-schema.ts"
import { listSkills } from "../../core/src/catalog-consumption.ts"

import {
  filesConstraints,
  readConstraints,
  exportConstraints,
  exactTargetConstraint,
  memberConstraint,
  requiredConstraint,
  validateConstraints,
  databaseFlag,
  singleton,
  requiredSingleton,
  switchFlag,
  readPolicyFlags,
  readPolicy,
  emit,
  progressFlag,
  publicationOptions,
  dryRunFlag,
  memberFlags,
  requiredFlags,
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
    json: switchFlag(
      "json",
      "Emit the stable JSON result (currently also the compatibility default)",
    ),
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
    "Use --view ID/Notion-URL for an exact session View, or --default-view for the bound shared Profile default and otherwise the first View in API order; --view and --default-view are mutually exclusive. --profile ID --database ENTRY selects a shared Profile for this invocation. An explicit --view takes precedence over Profile rules. A machine binding is consulted only with --default-view; an explicit different database uses that database's first View. Default capability directories omit Prompts. Bare list discovers the accessible source scope, including Prompts, regardless of the machine binding. Output defaults to 50 records (maximum --limit 500); follow next_cursor with --cursor until has_more is false. count is this page and total_count is the filtered observation; neither upgrades source coverage. Copy the returned cursor unchanged with the same query and selection; changed observations return LIST_CURSOR_STALE. --json is explicit and currently also the compatibility default. View membership uses the native query including quick filters, not an additional Default Context gate; Profile and View rules never grant access. List paginated lightweight content metadata with role-tagged content/upstream database maps and successful-query coverage. Automatic subscription Routers require at least two verified published active Skills; individual Skill records remain independently available. Subscription Router locators belong to upstream sources; --database constrains their content target. --query filters Name/alias/Description while retaining the database map. Catalog age defaults to 60s; --refresh validates online, --offline uses stored observations, --max-age overrides age. These policies are mutually exclusive. Cache freshness never improves discovery coverage; failed sources stay explicit. --database accepts one ID, URL or exact registered alias; Search is not workspace-exhaustive.",
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
      command: "ntn-skills list --database frontend",
      description:
        "Query the database previously registered with ctl database register frontend --database DATABASE_ID",
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
    readOnly: switchFlag(
      "read-only",
      "Forbid every remote write, including internal history retention",
    ),
    authoring: switchFlag(
      "authoring",
      "Inspect one exact current native page for editing, including disabled content; always validates online without qualifying disabled consumer reuse",
    ),
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
        authoring: config.authoring,
        readOnly: config.readOnly,
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
    "Read one file, defaulting to the selected record's entrypoint: SKILL.md, ROUTER.md or PROMPT.md. --authoring inspects one exact native page ID/URL for editing, including disabled drafts: it always validates the complete current tree online and returns a fixed author pin without qualifying disabled content for current consumer reuse. It rejects offline/max-age/from and pinned targets; initialize an unregistered native draft with adopt first. Names/aliases/page IDs/URLs/unpinned refs otherwise reuse eligible observations for 5m; --refresh validates native bodies and the fixed source manifest online, while supporting raw bytes are acquired when selected. --offline requires the selected bytes locally; --max-age overrides age (explicit 0 also requires online validation). Shared Skills revalidate flat file metadata and immutable ownership facts; an independent 24-hour full-body deadline bounds same-timestamp edits. Notion native content is retained before whole-file custom adoption. Legacy aligned native Skills may reuse verified files after metadata checks. Both report freshness.validation=metadata when bodies were reused. Policies are mutually exclusive. Pinned targets (including relative --from pinned refs) select immutable versions and reject refresh/max-age. Missing selected bytes may be acquired only through the pin's frozen source or retained history; --offline forbids this acquisition. --path supplies a file only when the target has no path. Relative --from rejects --path. JSON includes source/freshness, identity, pinned ref, version, range and has_more. --lines uses inclusive 1-based ranges. --output writes exact bytes with identical reuse and differing-output rejection; --raw emits successful text only. An absent snapshot requires a new current read; arbitrary historical versions cannot be fetched.",
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

export const createCommand = defineCommand(
  "create",
  {
    input: Argument.String("input").pipe(
      Argument.withDescription(
        "Local ZIP/folder (portable v2 for Prompt/Router) or ordinary Skill Markdown file",
      ),
    ),
    database: databaseFlag,
    name: singleton(
      "name",
      "Exact human title override; nonempty Unicode without control characters",
    ),
    description: singleton(
      "description",
      "Override Description; nonblank, at most 2000 Unicode characters; required if source has none",
    ),
    storage: Flag.Literals("storage", ["markdown_files", "notion_blocks"]).pipe(
      Flag.optional,
      Flag.withDescription(
        "markdown_files stores editable LF UTF-8 files without Markdown parsing (rejects CR/NUL/binary); notion_blocks uses native rich text",
      ),
    ),
    dryRun: dryRunFlag,
    progress: progressFlag,
    ...memberFlags,
    ...requiredFlags,
  },
  (config) =>
    Effect.gen(function* () {
      yield* emit(
        yield* createSkill(config.input, {
          database: Option.getOrUndefined(config.database),
          name: Option.getOrUndefined(config.name),
          description: Option.getOrUndefined(config.description),
          storage: Option.getOrUndefined(config.storage),
          members: config["clear-members"] ? [] : config.member.length ? config.member : undefined,
          requires: config["clear-requires"]
            ? []
            : config.require.length
              ? config.require
              : undefined,
          dryRun: config.dryRun,
          ...(yield* publicationOptions(config.progress)),
        }),
      )
    }),
).pipe(
  withConstraints([memberConstraint, requiredConstraint]),
  Command.withShortDescription("Create a new Skill, Router or Prompt from local input"),
  Command.withDescription(
    'Create one new Skill, Router or Prompt in the selected database. Ordinary Skill folders with SKILL.md and supporting files, ZIPs, or a single Markdown file need no hand-authored manifest; use --name/--description for explicit metadata overrides. Database priority is --database, configured default, then one unambiguous discovered library. In a shared library, the CLI freezes all input, creates native Skills/Files identities, and enables the new Skill only after the complete body set verifies. Native creation supports UTF-8 text; binary, unsupported projection and size failures stop before page creation without omitting files. Omit --storage for this path; markdown_files is a legacy storage mode and is rejected for shared entries. A name collision never permits overwriting another Skill. Shared success returns a verified snapshot, pinned refs and create_operation_id. Preserve the exact input and original operation after an unknown response; repeating the same intent reconciles it without blindly repeating page creates. --dry-run performs online preflight but sends no Notion writes and is not proof of a completed create. For Prompt, stage a folder with root .ntn-skills.json containing {"format":"ntn-skills","version":2,"kind":"prompt","name":"Review Prompt","description":"Requirements for a review","main":"PROMPT.md"} and a UTF-8 PROMPT.md body containing \'Review the change and explain its risks.\'. For Router, use {"format":"ntn-skills","version":2,"kind":"router","name":"Review Router","description":"Select a review Skill","main":"ROUTER.md"} and a UTF-8 ROUTER.md body containing \'Select the relevant member Skill for this review.\'. kind must be skill, router or prompt; filenames/frontmatter never select kind. Without a manifest, ZIP/folder uses SKILL.md or unique top-level Markdown and kind defaults to skill; a single Markdown file is also a Skill regardless of filename. Portable v1 is unsupported. main must name an existing normalized relative source file (arbitrary filename allowed); published entrypoints are SKILL.md, ROUTER.md and PROMPT.md respectively. Manifest name must be nonblank without control characters; description must be nonblank and at most 2000 Unicode code points, even when overridden. --name/--description override manifest metadata, which overrides body frontmatter; ordinary Skill name falls back from frontmatter to filename and requires a description from frontmatter or --description. Shared Skills and Routers accept repeatable --member and --require with exact current enabled Skill page IDs or unpinned entrypoint refs in the same library and data source. Requires is for unconditional prerequisites; member bodies remain lazy. Nested Routers, Prompts, resource refs and pinned refs are invalid relation targets. Each explicit relation write supports at most 100 targets and rejects larger replacements before writing. For legacy entries, References Markdown becomes editable child pages and optional Files preserves original bytes; those targets retain content_id, --progress and ctl operation resume OPERATION_ID publication recovery. Shared operation IDs do not use that legacy resume path. Insert, Update and Read content permissions are required.',
  ),
  Command.withExamples([
    {
      command: "ntn-skills create ./my-skill --dry-run",
      description: "Preview creation using the configured default or the only discovered database",
    },
    {
      command: "ntn-skills create ./my-skill",
      description: "Create the Skill and return its exported snapshot",
    },
    {
      command: "ntn-skills create ./my-skill --database DATABASE_ID --name 'My Skill'",
      description: "Override the database and display title explicitly",
    },
    {
      command: "ntn-skills create ./review-prompt --database DATABASE_ID --dry-run",
      description:
        "Online preview of the Prompt folder containing the full v2 manifest and PROMPT.md shown above; omit --dry-run to publish",
    },
    {
      command:
        "ntn-skills create ./review-router --database DATABASE_ID --member SKILL_PAGE_ID --member 'skill://OTHER_SKILL_PAGE_ID/SKILL.md' --dry-run",
      description:
        "Online preview of the Router folder shown above with exact existing same-library Skills; omit --dry-run to publish",
    },
  ]),
)

export const applyCommand = defineCommand(
  "apply",
  {
    target: Argument.String("target").pipe(
      Argument.withDescription(
        "Pinned main ref or snapshot ID from read; names and current page IDs are not a version baseline",
      ),
    ),
    input: singleton(
      "input",
      "Sparse directory containing only the files to add or change; relative paths are retained",
    ),
    remove: Flag.String("remove").pipe(
      Flag.atLeast(0),
      Flag.withDescription(
        "Exact relative file path to remove from the selected snapshot; repeat for multiple files",
      ),
    ),
    database: databaseFlag,
    name: singleton("name", "Exact new human title; preserves page identity"),
    description: singleton(
      "description",
      "New Description; nonblank, at most 2000 Unicode characters",
    ),
    defaultContext: Flag.Boolean("default-context").pipe(
      Flag.withDescription(
        "Optional View-filter metadata only; does not enable the Skill or auto-load its instructions",
      ),
      Flag.atMost(1),
      Flag.map((values) => Option.fromUndefinedOr(values[0])),
    ),
    ...memberFlags,
    dryRun: dryRunFlag,
    progress: progressFlag,
  },
  (config) =>
    Effect.gen(function* () {
      yield* validateConstraints([memberConstraint], config)
      yield* emit(
        yield* applySkill(config.target, {
          input: Option.getOrUndefined(config.input),
          remove: config.remove,
          database: Option.getOrUndefined(config.database),
          name: Option.getOrUndefined(config.name),
          description: Option.getOrUndefined(config.description),
          defaultContext: Option.getOrUndefined(config.defaultContext),
          members: config["clear-members"] ? [] : config.member.length ? config.member : undefined,
          dryRun: config.dryRun,
          ...(yield* publicationOptions(config.progress)),
        }),
      )
    }),
).pipe(
  withConstraints([memberConstraint]),
  Command.withShortDescription("Apply one content change to an exact pinned baseline"),
  Command.withDescription(
    "Submit changed files in --input and explicit deletions with --remove. Omitted files remain unchanged; deleting the main file is rejected. The target must be a pinned main ref or snapshot ID from a prior read; a stale baseline fails before writing. In a shared library, existing bound UTF-8 body changes and explicitly nominated metadata form one frozen sequential batch. Every proposed input and complete-tree reference is checked before dispatch; the batch is not atomic and a later failure retains earlier verified edits plus the original remaining intent. One isolated add/delete is supported; mixed or multiple layout changes fail before writes. Use ctl library file for individual lifecycle changes. Shared success reports status=applied, verified=true, apply_operation_id and changes.files/changes.removed; identical input reports unchanged. --dry-run sends no Notion writes. Preserve original errors and use a fresh exact current read for shared reconciliation; unknown work is never replayed. Legacy targets retain their existing publication recovery and ctl operation resume OPERATION_ID.",
  ),
)

export const replaceCommand = defineCommand(
  "replace",
  {
    input: Argument.String("input").pipe(
      Argument.withDescription("Local ZIP path, Skill folder, or Markdown file with any filename"),
    ),
    database: databaseFlag,
    name: singleton("name", "Exact human title override; preserves page identity"),
    description: singleton(
      "description",
      "Override Description; nonblank, at most 2000 Unicode characters; required if source has none",
    ),
    storage: Flag.Literals("storage", ["markdown_files", "notion_blocks"]).pipe(
      Flag.optional,
      Flag.withDescription(
        "Choose editable LF UTF-8 files (no CR/NUL/binary) or native rich text; existing editable-file pages retain their storage",
      ),
    ),
    target: requiredSingleton(
      "target",
      "Exact page ID/URL, page-ID ref or pinned snapshot; names cannot select replacement",
    ),
    dryRun: dryRunFlag,
    progress: progressFlag,
    ...memberFlags,
  },
  (config) =>
    Effect.gen(function* () {
      yield* validateConstraints([exactTargetConstraint, memberConstraint], config)
      yield* emit(
        yield* replaceSkill(config.input, {
          database: Option.getOrUndefined(config.database),
          name: Option.getOrUndefined(config.name),
          description: Option.getOrUndefined(config.description),
          storage: Option.getOrUndefined(config.storage),
          members: config["clear-members"] ? [] : config.member.length ? config.member : undefined,
          dryRun: config.dryRun,
          target: config.target,
          ...(yield* publicationOptions(config.progress)),
        }),
      )
    }),
).pipe(
  withConstraints([exactTargetConstraint, memberConstraint]),
  Command.withShortDescription("Replace the complete file set of one exact existing Skill"),
  Command.withDescription(
    "Requires --target identifying an exact page or pinned snapshot. Names never select replacement and missing targets never create. Pinned versions enforce a current-version check. Omitted input files are requested removals. A shared target uses the same frozen sequential native operations as apply: existing bound UTF-8 files and nominated metadata are supported; mixed or multiple layout changes fail before any write. Shared replacement preserves the original kind and does not accept hidden legacy projection authority. Inspect the exact original result after an interruption; do not start a replacement to bypass pending work. Existing legacy targets retain their complete replacement publication. Use --dry-run to preview.",
  ),
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
    projection: Flag.String("projection").pipe(
      Flag.atMost(1),
      Flag.map((values) => values[0] ?? "source"),
      Flag.withDescription(
        "source preserves portable source files (default); snapshot exports the materialized read view",
      ),
    ),
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
          projection: config.projection as "source" | "snapshot",
          database: Option.getOrUndefined(config.database),
          ...(yield* readPolicy(config)),
        }),
      )
    }),
).pipe(
  Command.withShortDescription("Export a complete reversible Skill as ZIP or folder"),
  Command.withDescription(
    "Export every content file and a versioned portable manifest. --projection source (default) preserves portable source files; --projection snapshot exports the materialized read view, including the native Skill or Router Members index. Current inputs follow the 5m content policy; use mutually exclusive --refresh, --offline or --max-age. Ordinary aligned native Skills may revalidate metadata and reuse verified source files (freshness.validation=metadata); --refresh or explicit --max-age 0 requires complete body/resource validation. Pinned refs and snapshot IDs select immutable versions and reject refresh/max-age. Export acquires any missing bytes only from the pin's frozen source or retained history; --offline requires every exported byte locally. References links become relative paths; optional Files preserves source bytes, while page-only output is normalized. ZIP entries sort deterministically with fixed timestamps. --output is required; .zip selects ZIP, otherwise directory; --format overrides it. Identical output returns reused=true; differing output returns OUTPUT_CONFLICT. Cache policy changes input selection only, never output overwrite permission. Export never mutates Notion.",
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
export const writeCommand = defineCommand(
  "write",
  {
    target: Argument.String("skill-or-ref").pipe(
      Argument.withDescription(
        "Name, invocation alias, page ID/URL, skill:// file ref or snapshot ID; pinned targets are version baselines",
      ),
    ),
    path: singleton("path", "Skill-relative file path, default SKILL.md; omit for a file ref"),
    input: requiredSingleton("input", "Local file containing the full replacement content"),
    database: databaseFlag,
    dryRun: dryRunFlag,
    progress: progressFlag,
  },
  (config) =>
    Effect.gen(function* () {
      yield* emit(
        yield* writeSkill(config.target, {
          path: Option.getOrUndefined(config.path),
          input: config.input,
          database: Option.getOrUndefined(config.database),
          dryRun: config.dryRun,
          ...(yield* publicationOptions(config.progress)),
        }),
      )
    }),
).pipe(
  Command.withShortDescription("Write one Skill file to Notion"),
  Command.withDescription(
    "Replace one complete file, defaulting to the selected record entrypoint. --path supplies a path only when the target has none. Pinned refs and snapshot IDs are online version baselines; stale content fails before writing. In a shared library, only an existing exact native file binding can be written. Main Name and Description remain native Notion properties; nominate their changes through update or apply. Complete existing main and supporting headers are retained separately from the editable body. A submitted header must preserve existing extra main fields and the exact supporting header; adding, changing or omitting those fields is rejected. Body-only input retains the existing header. notion_page_id must match. Native input normalizes CRLF and terminal line feeds before the candidate is frozen; other Notion rendering differences must pass exact verification. Other logical files stay intact. Identical input returns action=unchanged without mutation; --dry-run validates without writes. Shared success returns a verified current snapshot, pinned ref, previous_version_id and body_write_operation_id. Preserve this original operation after an unknown result and read the exact current Skill for reconciliation; do not pass shared IDs to legacy ctl operation resume. Legacy targets retain their earlier full-file publication, --progress and guarded ctl operation resume workflow.",
  ),
  Command.withExamples([
    {
      command: "ntn-skills write 'PINNED_REF' --input ./SKILL.md --dry-run",
      description: "Preview a write using the exact ref returned by read",
    },
    {
      command: "ntn-skills write 'skill://resource-tag-governance/SKILL.md' --input ./SKILL.md",
      description: "Write the current Skill body while preserving page properties",
    },
    {
      command: "ntn-skills write 'PINNED_ATTACHMENT_REF' --input ./vocabulary.md",
      description: "Replace an attachment using its returned pinned file ref",
    },
    {
      command:
        "ntn-skills write 'Resource Tag Governance' --path vocabulary.md --input ./vocabulary.md",
      description: "Select a Skill by display Name and a separate file path",
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
    "Resolve a path relative to a containing-file skill:// ref. Member-local resolution remains a pure offline transformation preserving its snapshot. A path crossing the member root authenticates the containing snapshot and resolves through its exact active source/member/resource manifest; missing or stale maps fail explicitly. Returns JSON with ref. Replace PINNED_REF with the containing file's returned ref.",
  ),
  Command.withExamples([
    {
      command: "ntn-skills ctl resolve ../assets/template.md --from 'PINNED_REF'",
      description: "Resolve from a nested reference file and retain its fixed version",
    },
  ]),
)

export const updateCommand = defineCommand(
  "update",
  {
    target: Argument.String("target"),
    database: databaseFlag,
    name: singleton("name", "Exact new human title; preserves page identity"),
    enabled: singleton("enabled", "Set the native shared Skill's enabled state: true or false"),
    description: singleton(
      "description",
      "New Description; nonblank, at most 2000 Unicode characters",
    ),
    dryRun: dryRunFlag,
    ...memberFlags,
    ...requiredFlags,
    defaultContext: Flag.Boolean("default-context").pipe(
      Flag.withDescription(
        "Optional View-filter metadata only; does not enable the Skill or auto-load its instructions",
      ),
      Flag.atMost(1),
      Flag.map((values) => Option.fromUndefinedOr(values[0])),
    ),
  },
  (config) =>
    Effect.gen(function* () {
      yield* validateConstraints([memberConstraint, requiredConstraint], config)
      const enabled = Option.getOrUndefined(config.enabled)
      if (enabled !== undefined && enabled !== "true" && enabled !== "false")
        return yield* Effect.fail(
          new SkillsError({
            code: "INVALID_ARGUMENT",
            message: "--enabled must be exactly true or false.",
          }),
        )
      yield* emit(
        yield* updateSkill(config.target, {
          database: Option.getOrUndefined(config.database),
          name: Option.getOrUndefined(config.name),
          description: Option.getOrUndefined(config.description),
          defaultContext: Option.getOrUndefined(config.defaultContext),
          enabled: enabled === undefined ? undefined : enabled === "true",
          members: config["clear-members"] ? [] : config.member.length ? config.member : undefined,
          requires: config["clear-requires"]
            ? []
            : config.require.length
              ? config.require
              : undefined,
          dryRun: config.dryRun,
        }),
      )
    }),
).pipe(
  withConstraints([memberConstraint, requiredConstraint]),
  Command.withDescription(
    "Update only nominated Name, Description, Default Context, Enabled, Members or Requires on an exact target; omitted fields and native file bodies remain unchanged. Exact native pages and retained author pins support disabled drafts without an extra flag. --enabled true|false applies only to shared native records; enabling first verifies the complete current tree and all original-operation barriers. Shared Skills and Routers accept --member/--clear-members and --require/--clear-requires independently. Relation targets must be exact accessible enabled Skill page IDs or unpinned entrypoint refs in the same library/data source. Requires is for unconditional prerequisites. Relation reads paginate completely; explicit replacement writes above 100 targets fail before dispatch because Notion arrays do not append. Pinned snapshots enforce their version baseline. A shared library uses registered native property IDs and the common original-operation journal; metadata uses native last-writer behavior, not compare-and-swap. Shared success reports action=updated, verified=true and metadata_operation_id. Unknown results retain their original plan for read-only reconciliation. Select a shared fixed Source with ctl library source select; update does not accept a Source or ownership override. Existing legacy SyncMode conversion remains a separate workflow.",
  ),
)
