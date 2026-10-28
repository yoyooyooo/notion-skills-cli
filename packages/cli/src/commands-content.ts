import { Context, Effect, Option, Stdio, Stream } from "effect"
import { Argument, Command, Flag } from "effect/cli"

import {
  Notion,
  SkillsError,
  catalog,
  viewCatalog,
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

import {
  filesConstraints,
  readConstraints,
  exportConstraints,
  exactTargetConstraint,
  memberConstraint,
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
} from "./command-options.ts"
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
      "Use the first View returned for the selected content database",
    ),
    ...readPolicyFlags,
    query: singleton("query", "Case-insensitive filter on Name, invocation alias and Description"),
  },
  (config) =>
    Effect.gen(function* () {
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
      const result =
        Option.isSome(config.view) || config.defaultView
          ? yield* viewCatalog({ ...options, view: Option.getOrUndefined(config.view) })
          : yield* catalog(options)
      const query = Option.getOrUndefined(config.query)?.toLocaleLowerCase()
      const skills = query
        ? result.records.filter((s) =>
            `${s.name}\n${s.alias}\n${s.description}`.toLocaleLowerCase().includes(query),
          )
        : result.records
      yield* emit({
        scope: result.scope,
        fetched_at: result.fetched_at,
        databases: result.databases,
        records: skills,
        count: skills.length,
        coverage: result.coverage,
        source: result.source,
        freshness: result.freshness,
        ...("view" in result
          ? {
              view: result.view,
              view_selection: result.view_selection,
              view_query: result.view_query,
            }
          : {}),
      })
    }),
).pipe(
  Command.withShortDescription("List available skills with names, descriptions and refs"),
  Command.withDescription(
    "Use --view ID/Notion-URL for a saved Notion View, or --default-view for the first View in API order; these options are mutually exclusive. View membership uses the native query including quick filters, not an additional Default Context gate. Without either option, list retains the complete explicit discovery scope. List paginated lightweight content metadata with role-tagged content/upstream database maps and successful-query coverage. Automatic subscription Routers require at least two verified published active Skills; individual Skill records remain independently available. Subscription Router locators belong to upstream sources; --database constrains their content target. --query filters Name/alias/Description while retaining the database map. Catalog age defaults to 60s; --refresh validates online, --offline uses stored observations, --max-age overrides age. These policies are mutually exclusive. Cache freshness never improves discovery coverage; failed sources stay explicit. --database accepts one ID, URL or exact registered alias; Search is not workspace-exhaustive.",
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
      } else yield* emit(result)
    }),
).pipe(
  Command.withShortDescription("Read one file with bounded cache freshness or a pinned snapshot"),
  Command.withDescription(
    "Read one file, defaulting to the selected record's entrypoint: SKILL.md, ROUTER.md or PROMPT.md. Names/aliases/page IDs/URLs/unpinned refs reuse complete eligible observations for 5m; --refresh validates complete bodies/resources online, --offline reads local observations, --max-age overrides age (explicit 0 also requires complete validation). Ordinary aligned native Skills may revalidate page metadata and reuse their verified source files, reporting freshness.validation=metadata; same-timestamp edits may be missed. Policies are mutually exclusive. Pinned targets (including relative --from pinned refs) stay immutable/offline and reject refresh/max-age. --path supplies a file only when the target has no path. Relative --from rejects --path. JSON includes source/freshness, identity, pinned ref, version, range and has_more. --lines uses inclusive 1-based ranges. --output writes exact bytes with identical reuse and differing-output rejection; --raw emits successful text only. Missing cached versions require a new current read; arbitrary historical versions cannot be fetched.",
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
    ...readPolicyFlags,
  },
  (config) =>
    Effect.gen(function* () {
      yield* validateConstraints(filesConstraints, config)
      yield* emit(
        yield* listSkill(config.selector, {
          path: Option.getOrUndefined(config.path),
          database: Option.getOrUndefined(config.database),
          ...(yield* readPolicy(config)),
        }),
      )
    }),
).pipe(
  Command.withShortDescription("List snapshot files and their pinned refs"),
  Command.withDescription(
    "List pinned file refs from one complete snapshot. Current targets follow the 5m content policy; use mutually exclusive --refresh, --offline or --max-age. Ordinary aligned native Skills may revalidate metadata and reuse their complete file set (freshness.validation=metadata); --refresh or explicit --max-age 0 requires complete body/resource validation. Pinned refs/snapshot IDs work offline and reject refresh/max-age. --path filters one file/directory when the target has no path; a file ref filters itself, a pathless ref lists every file. Source/freshness describe the selected observation, not current access when cached.",
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
          dryRun: config.dryRun,
          ...(yield* publicationOptions(config.progress)),
        }),
      )
    }),
).pipe(
  withConstraints([memberConstraint]),
  Command.withShortDescription("Create a new Skill, Router or Prompt from local input"),
  Command.withDescription(
    'Create one new Skill, Router or Prompt; an existing invocation name returns CREATE_CONFLICT before mutation. For Prompt, stage a folder with root .ntn-skills.json containing {"format":"ntn-skills","version":2,"kind":"prompt","name":"Review Prompt","description":"Requirements for a review","main":"PROMPT.md"} and a UTF-8 PROMPT.md body containing \'Review the change and explain its risks.\'. For Router, use {"format":"ntn-skills","version":2,"kind":"router","name":"Review Router","description":"Select a review Skill","main":"ROUTER.md"} and a UTF-8 ROUTER.md body containing \'Select the relevant member Skill for this review.\'. kind must be skill, router or prompt; filenames/frontmatter never select kind. Without a manifest, ZIP/folder uses SKILL.md or unique top-level Markdown and kind defaults to skill; a single Markdown file is also a Skill regardless of filename. Portable v1 is unsupported. main must name an existing normalized relative source file (arbitrary filename allowed); published entrypoints are SKILL.md, ROUTER.md and PROMPT.md respectively. Manifest name must be nonblank without control characters; description must be nonblank and at most 2000 Unicode code points, even when overridden. --name/--description override manifest metadata, which overrides body frontmatter; ordinary Skill name falls back from frontmatter to filename and requires a description from frontmatter or --description. Router Members use repeatable --member with exact current accessible Skill page IDs or unpinned entrypoint refs in the same database AND data source. Nested Routers, Prompts, resource refs and pinned refs are invalid Members; do not copy member bodies or invent manifest members. References Markdown becomes editable child pages and relative links become Notion URLs. Optional Files preserves original bytes, extra frontmatter and other assets; without Files only main/reference Markdown is accepted and export is normalized. Database priority: --database > configured default > sole discovered skill database. --dry-run performs online authentication/database/name/member preflight and reports action=create without uploads or mutation; it is not offline or proof of successful publication. Success returns a verified snapshot, pinned refs and content_id. Insert, Update and Read content are required. Use --progress for stage/timing JSONL on stderr. Preserve operation_id and use operation resume OPERATION_ID after interruption; unproven writes remain unresolved.',
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
    "Submit only changed files in --input and explicit deletions with repeated --remove. Omitted files remain unchanged; deleting the main file is rejected. Optional metadata changes join the same publication. The target must be a pinned main ref or snapshot ID from a prior read; stale content fails before writing. A request without changes is rejected. Use --dry-run to validate and preview. Success retains the existing replace publication result and adds changes.files/changes.removed; keep operation_id and use operation resume OPERATION_ID after interruption.",
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
    "Requires --target identifying an exact page or pinned snapshot. Names never select replacement and missing targets never create. Pinned versions enforce a current-version check. Omitted files leave the logical file set. Use --dry-run to preview.",
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
    "Export every content file and a versioned portable manifest. --projection source (default) preserves portable source files; --projection snapshot exports the materialized read view, including the Router Members index. Current inputs follow the 5m content policy; use mutually exclusive --refresh, --offline or --max-age. Ordinary aligned native Skills may revalidate metadata and reuse verified source files (freshness.validation=metadata); --refresh or explicit --max-age 0 requires complete body/resource validation. Pinned refs and snapshot IDs are immutable/offline and reject refresh/max-age. References links become relative paths; optional Files preserves source bytes, while page-only output is normalized. ZIP entries sort deterministically with fixed timestamps. --output is required; .zip selects ZIP, otherwise directory; --format overrides it. Identical output returns reused=true; differing output returns OUTPUT_CONFLICT. Cache policy changes input selection only, never output overwrite permission. Export never mutates Notion.",
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
    "Replace one Skill file using shared targets, default SKILL.md. --path supplies a path only when the target has none. Pinned refs and snapshot IDs are online version baselines; stale main or reference-page content returns WRITE_CONFLICT. Main frontmatter stays file content: Name, Description and Default Context change only through update. notion_page_id must match. Other logical files stay intact. Identical input returns action=unchanged without mutation. --dry-run validates and previews. Success returns a verified snapshot, pinned ref and previous_version_id. Use --progress for stage/timing JSONL and operation resume OPERATION_ID for guarded continuation.",
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
      command: "ntn-skills resolve ../assets/template.md --from 'PINNED_REF'",
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
    description: singleton(
      "description",
      "New Description; nonblank, at most 2000 Unicode characters",
    ),
    dryRun: dryRunFlag,
    ...memberFlags,
    defaultContext: Flag.Boolean("default-context").pipe(
      Flag.atMost(1),
      Flag.map((values) => Option.fromUndefinedOr(values[0])),
    ),
  },
  (config) =>
    Effect.gen(function* () {
      yield* validateConstraints([memberConstraint], config)
      yield* emit(
        yield* updateSkill(config.target, {
          database: Option.getOrUndefined(config.database),
          name: Option.getOrUndefined(config.name),
          description: Option.getOrUndefined(config.description),
          defaultContext: Option.getOrUndefined(config.defaultContext),
          members: config["clear-members"] ? [] : config.member.length ? config.member : undefined,
          dryRun: config.dryRun,
        }),
      )
    }),
).pipe(
  withConstraints([memberConstraint]),
  Command.withDescription(
    "Update Name, Description, Default Context or Router Members on an exact target. Repeat --member with exact content Skill IDs/refs in the same database, or use --clear-members to clear the relation. Omit both to preserve Members. SyncMode requires its dedicated conversion workflow and cannot be changed here. Pinned snapshots enforce their version baseline.",
  ),
)
