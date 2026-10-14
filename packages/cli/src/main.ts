#!/usr/bin/env node
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Cause, Effect, Layer, Option, Stdio, Stream } from "effect"
import { Argument, CliConfig, CliError, CliOutput, Command, Flag, GlobalFlag } from "effect/cli"
import {
  Notion,
  NotionLive,
  StoreLive,
  SkillsError,
  addSource,
  catalog,
  configuredSources,
  configuration,
  publicConfiguration,
  setToken,
  createSkill,
  discoverDatabases,
  explicitSource,
  importSkill,
  exportSkill,
  setDefaultDatabase,
  writeSkill,
  fail,
  listSkill,
  targetSnapshot,
  parseTarget,
  readSkill,
  resolveRef,
  snapshotInfo,
} from "@notion-skills-cli/core"
import { version } from "../package.json"

const requiredDatabaseFlag = Flag.String("database").pipe(
  Flag.between(1, 1),
  Flag.map((values) => values[0]!),
  Flag.withDescription(
    "One Skills Database ID, URL or exact registered alias; repeated --database is rejected",
  ),
)
const databaseFlag = Flag.String("database").pipe(
  Flag.atMost(1),
  Flag.map((values) => Option.fromUndefinedOr(values[0])),
  Flag.withDescription(
    "Restrict to one Skills Database ID, URL or exact registered alias; repeated --database is rejected",
  ),
)
const refreshFlag = Flag.Boolean("refresh").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Bypass the 60-second metadata cache"),
)

function emit(value: object) {
  return Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    yield* Stream.make(JSON.stringify({ ok: true, ...value }) + "\n").pipe(
      Stream.run(stdio.stdout()),
    )
  })
}

const listCommand = Command.make(
  "list",
  {
    database: databaseFlag,
    refresh: refreshFlag,
    query: Flag.String("query").pipe(
      Flag.optional,
      Flag.withDescription("Case-insensitive filter on Name, invocation alias and Description"),
    ),
  },
  (config) =>
    Effect.gen(function* () {
      const result = yield* catalog({
        database: Option.getOrUndefined(config.database),
        refresh: config.refresh,
      })
      const query = Option.getOrUndefined(config.query)?.toLocaleLowerCase()
      const skills = query
        ? result.skills.filter((s) =>
            `${s.name}\n${s.alias}\n${s.description}`.toLocaleLowerCase().includes(query),
          )
        : result.skills
      yield* emit({
        scope: result.scope,
        fetched_at: result.fetched_at,
        databases: result.databases,
        skills,
        count: skills.length,
        coverage: result.coverage,
      })
    }),
).pipe(
  Command.withShortDescription("List available skills with names, descriptions and refs"),
  Command.withDescription(
    "List lightweight Skill metadata; follows all Search and data-source pages automatically. Returns databases (ID, title, registered alias and data sources), skills, count and coverage without bodies or file manifests. --query filters Skill Name/alias/Description only and retains the queried database map. --database selects one ID, URL or exact registered alias; repeated values fail. --refresh bypasses the 60-second metadata cache. Failed queries include owning database ID/alias/title and data_source_id in coverage.failed_sources. Search cannot prove workspace-wide completeness.",
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
        "Query the database previously registered with source add frontend --database DATABASE_ID",
    },
  ]),
)

const databaseList = Command.make("list", { database: databaseFlag }, (config) =>
  Effect.gen(function* () {
    const explicit = Option.getOrUndefined(config.database)
    const result =
      explicit !== undefined
        ? { databases: [yield* explicitSource(explicit)], failures: [] }
        : yield* discoverDatabases()
    yield* emit({
      databases: result.databases,
      count: result.databases.length,
      coverage: {
        method: explicit !== undefined ? "explicit_database" : "search_and_registered",
        exhaustive: explicit !== undefined,
        failed_sources: result.failures,
        search_index_limited: explicit === undefined,
      },
    })
  }),
).pipe(
  Command.withShortDescription("List Skills Databases without querying Skill rows"),
  Command.withDescription(
    "Discover database IDs, titles, registered aliases and data sources online without querying Skill rows or downloading bodies. --database validates one ID, URL or exact registered alias; titles are display labels only. Repeated --database values fail. Search is not exhaustive; inspect coverage.failed_sources for database ID/alias/title.",
  ),
)
const databaseCommand = Command.make("database").pipe(
  Command.withShortDescription("Discover Skills Databases"),
  Command.withSubcommands([databaseList]),
)

const openCommand = Command.make(
  "open",
  {
    selector: Argument.String("target").pipe(
      Argument.withDescription(
        "Name, invocation alias, page ID/URL, skill:// ref, or cached snapshot ID",
      ),
    ),
    database: databaseFlag,
  },
  (config) =>
    Effect.gen(function* () {
      const target = yield* Effect.try({
        try: () => parseTarget(config.selector),
        catch: (e) => e as SkillsError,
      })
      yield* emit(
        snapshotInfo(
          yield* targetSnapshot(target, { database: Option.getOrUndefined(config.database) }),
        ),
      )
    }),
).pipe(
  Command.withShortDescription("Download a skill into an immutable snapshot"),
  Command.withDescription(
    "Return complete snapshot metadata and pinned file refs without contents. Uses the shared target syntax: names, aliases, page IDs/URLs and unpinned refs obtain the current export online; pinned refs and snapshot IDs use cached content offline. Normal reads obtain their own snapshot; open is optional. Scripts are never executed.",
  ),
  Command.withExamples([
    {
      command: "ntn-skills open resource-tag-governance",
      description: "Download a current skill and retain its snapshot_id for local reads",
    },
  ]),
)

const readCommand = Command.make(
  "read",
  {
    selector: Argument.String("target").pipe(
      Argument.withDescription(
        "Name, invocation alias, page ID/URL, skill:// ref, cached snapshot ID, or relative path with --from",
      ),
    ),
    path: Flag.String("path").pipe(
      Flag.optional,
      Flag.withDescription("Skill-relative file path; target must not already contain a path"),
    ),
    database: databaseFlag,
    from: Flag.String("from").pipe(
      Flag.optional,
      Flag.withDescription(
        "Resolve the first argument relative to this containing-file skill:// ref; preserve its snapshot when pinned",
      ),
    ),
    lines: Flag.String("lines").pipe(
      Flag.optional,
      Flag.withDescription(
        "Inclusive 1-based range START-END or one line START; returns range and has_more; incompatible with --output",
      ),
    ),
    output: Flag.String("output").pipe(
      Flag.optional,
      Flag.withDescription(
        "Write exact bytes to a local path; reuse identical content, reject differing output; incompatible with --lines/--raw",
      ),
    ),
    raw: Flag.Boolean("raw").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Emit successful UTF-8 text only; failures remain JSON; retain snapshot/ref separately; incompatible with --output",
      ),
    ),
  },
  (config) =>
    Effect.gen(function* () {
      if (config.raw && Option.isSome(config.output))
        return yield* Effect.fail(
          fail("INVALID_ARGUMENT", "--raw cannot be combined with --output."),
        )
      const result = yield* readSkill(config.selector, {
        path: Option.getOrUndefined(config.path),
        database: Option.getOrUndefined(config.database),
        from: Option.getOrUndefined(config.from),
        lines: Option.getOrUndefined(config.lines),
        output: Option.getOrUndefined(config.output),
      })
      if (config.raw) {
        const stdio = yield* Stdio.Stdio
        yield* Stream.make("content" in result ? result.content : "").pipe(
          Stream.run(stdio.stdout()),
        )
      } else yield* emit(result)
    }),
).pipe(
  Command.withShortDescription("Read one file online or from a pinned snapshot"),
  Command.withDescription(
    "Read one file, default SKILL.md. Accepts names, invocation aliases, page IDs/URLs, skill:// refs and snapshot IDs. Pinned refs and snapshot IDs read cached content offline; other targets check the current export online. --path supplies a file only when the target has no path. Relative reads use read relative-path --from containing-file-ref; --from cannot combine with --path. JSON includes content, identity, pinned ref, version, range and has_more. --lines uses inclusive 1-based ranges; --output returns exact bytes, output and reused, rejecting differing local files. --raw emits text only. FILE_NOT_FOUND: inspect files; SNAPSHOT_MISSING: read the current target online; arbitrary historical versions cannot be fetched.",
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

const filesCommand = Command.make(
  "files",
  {
    selector: Argument.String("target").pipe(
      Argument.withDescription(
        "Name, invocation alias, page ID/URL, skill:// ref, or cached snapshot ID",
      ),
    ),
    path: Flag.String("path").pipe(
      Flag.optional,
      Flag.withDescription(
        "File/directory filter; omit for every file; cannot replace a ref's path",
      ),
    ),
    database: databaseFlag,
  },
  (config) =>
    Effect.gen(function* () {
      yield* emit(
        yield* listSkill(config.selector, {
          path: Option.getOrUndefined(config.path),
          database: Option.getOrUndefined(config.database),
        }),
      )
    }),
).pipe(
  Command.withShortDescription("List snapshot files and their pinned refs"),
  Command.withDescription(
    "List pinned file refs without contents using the shared target syntax. Names, aliases, page IDs/URLs and unpinned refs obtain the current export online; pinned refs and snapshot IDs work offline. --path filters one file/directory when the target has no path. A file ref filters its own path; a pathless ref lists every file.",
  ),
  Command.withExamples([
    {
      command: "ntn-skills files SNAPSHOT_ID --path references",
      description: "Find attachment paths in the same snapshot",
    },
  ]),
)

const dryRunFlag = Flag.Boolean("dry-run").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Validate inputs and show the target without uploading or changing Notion"),
)
const createCommand = Command.make(
  "create",
  {
    input: Argument.String("input").pipe(
      Argument.withDescription("Local ZIP, Skill folder or Markdown file"),
    ),
    database: databaseFlag,
    name: Flag.String("name").pipe(
      Flag.optional,
      Flag.withDescription("English display title overriding source metadata"),
    ),
    description: Flag.String("description").pipe(
      Flag.optional,
      Flag.withDescription("Override Description; required if source has none"),
    ),
    dryRun: dryRunFlag,
  },
  (config) =>
    Effect.gen(function* () {
      yield* emit(
        yield* createSkill(config.input, {
          database: Option.getOrUndefined(config.database),
          name: Option.getOrUndefined(config.name),
          description: Option.getOrUndefined(config.description),
          dryRun: config.dryRun,
        }),
      )
    }),
).pipe(
  Command.withShortDescription("Create a new Skill from ZIP, folder or Markdown"),
  Command.withDescription(
    "Create one new Skill; an existing invocation name returns CREATE_CONFLICT before mutation. Shares the same input and preservation rules as import: ZIP, folder or any Markdown filename; portable manifest or SKILL.md/unique Markdown entrypoint; --name/--description override metadata. Extra frontmatter, original bytes and nested paths are retained in a source ZIP. Database priority: --database > configured default > sole discovered Skills Database. --dry-run validates and reports action=create without upload. Success returns a verified snapshot, pinned refs and content_id. Insert, Update and Read content are required. Inspect partial/unknown outcomes before retrying.",
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
  ]),
)

const importCommand = Command.make(
  "import",
  {
    input: Argument.String("input").pipe(
      Argument.withDescription("Local ZIP path, Skill folder, or Markdown file with any filename"),
    ),
    database: databaseFlag,
    name: Flag.String("name").pipe(
      Flag.optional,
      Flag.withDescription("English display title overriding the imported name or filename"),
    ),
    description: Flag.String("description").pipe(
      Flag.optional,
      Flag.withDescription(
        "Description overriding frontmatter; required when frontmatter has none",
      ),
    ),
    dryRun: dryRunFlag,
  },
  (config) =>
    Effect.gen(function* () {
      yield* emit(
        yield* importSkill(config.input, {
          database: Option.getOrUndefined(config.database),
          name: Option.getOrUndefined(config.name),
          description: Option.getOrUndefined(config.description),
          dryRun: config.dryRun,
        }),
      )
    }),
).pipe(
  Command.withShortDescription("Import a Skill, replacing same-name content"),
  Command.withDescription(
    "Import one ZIP, folder or Markdown file. No matching invocation name creates a page; identical content returns action=reuse and reused=true; different content returns action=update and replaces the existing page body, metadata and entire file set while retaining its page ID. Multiple matches fail with SKILL_AMBIGUOUS. Overwrite checks a fresh remote version before changing content and again before committing uploaded files. Inputs use a portable manifest or SKILL.md/unique top-level Markdown after wrapper removal. --name/--description override metadata; missing descriptions require --description. All source bytes, extra frontmatter, filenames and nested paths are retained in a source ZIP (20 MiB including manifest); input ZIP max 32 MiB, expanded max 128 MiB/10,000 entries. Imported page IDs never choose a target. Database priority: --database > configured default > sole discovered Skills Database. --dry-run reports create/reuse/update without mutation. Success returns a verified snapshot and content_id. Read back partial/unknown outcomes before retrying.",
  ),
  Command.withExamples([
    {
      command: "ntn-skills import ./my-skill.zip --dry-run",
      description: "Preview a ZIP import using the default creation database",
    },
    {
      command: "ntn-skills import ./my-skill",
      description: "Import a local Skill folder and its supporting files",
    },
    {
      command:
        "ntn-skills import ./workflow.md --name 'My Workflow' --description 'When to use this workflow'",
      description: "Import any Markdown filename, providing missing metadata explicitly",
    },
  ]),
)

const exportCommand = Command.make(
  "export",
  {
    selector: Argument.String("skill-or-ref-or-snapshot").pipe(
      Argument.withDescription("Skill name, page ID/URL, skill:// ref, or cached snapshot ID"),
    ),
    output: Flag.String("output").pipe(
      Flag.withDescription(
        "Destination ZIP path or directory; identical output is reused, differing output is never overwritten",
      ),
    ),
    format: Flag.Literals("format", ["zip", "directory"]).pipe(
      Flag.optional,
      Flag.withDescription("Default: zip for .zip output paths, directory otherwise"),
    ),
    database: databaseFlag,
  },
  (config) =>
    Effect.gen(function* () {
      yield* emit(
        yield* exportSkill(config.selector, {
          output: config.output,
          format: Option.getOrUndefined(config.format),
          database: Option.getOrUndefined(config.database),
        }),
      )
    }),
).pipe(
  Command.withShortDescription("Export a complete reversible Skill as ZIP or folder"),
  Command.withDescription(
    "Export every Skill file and a versioned .ntn-skills.json manifest. Uses shared targets; pinned refs and snapshot IDs work offline. Original bytes and paths remain exact until current body or metadata edits replace the preserved main file. ZIP entries sort deterministically with fixed timestamps; payload excludes generated remote identities. --output is required; .zip selects ZIP, otherwise directory; --format overrides it. Identical output returns reused=true; differing output returns OUTPUT_CONFLICT. Importing the export reuses identical content or replaces a different same-name Skill. Export never mutates Notion.",
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
const writeCommand = Command.make(
  "write",
  {
    target: Argument.String("skill-or-ref").pipe(
      Argument.withDescription(
        "Name, invocation alias, page ID/URL, skill:// file ref or snapshot ID; pinned targets are version baselines",
      ),
    ),
    path: Flag.String("path").pipe(
      Flag.optional,
      Flag.withDescription("Skill-relative file path, default SKILL.md; omit for a file ref"),
    ),
    input: Flag.String("input").pipe(
      Flag.withDescription("Required local file containing the full replacement content"),
    ),
    database: databaseFlag,
    dryRun: dryRunFlag,
  },
  (config) =>
    Effect.gen(function* () {
      yield* emit(
        yield* writeSkill(config.target, {
          path: Option.getOrUndefined(config.path),
          input: config.input,
          database: Option.getOrUndefined(config.database),
          dryRun: config.dryRun,
        }),
      )
    }),
).pipe(
  Command.withShortDescription("Write one Skill file to Notion"),
  Command.withDescription(
    "Replace one Skill file using the shared target syntax, default SKILL.md. --path supplies a path only when the target has none. Pinned refs and snapshot IDs are online version baselines; stale versions return WRITE_CONFLICT. Unpinned targets capture the current version. Entry point name/description update properties; notion_page_id must match. Extra frontmatter and nested/binary attachments are retained in the source ZIP; other logical files stay intact. Identical input returns action=unchanged and unchanged=true without upload or mutation. --dry-run reports the target. Success returns a verified snapshot, pinned file ref and previous_version_id. Body, properties and files are separate requests; read back WRITE_PARTIAL/WRITE_OUTCOME_UNKNOWN before retrying.",
  ),
  Command.withExamples([
    {
      command: "ntn-skills write 'PINNED_REF' --input ./SKILL.md --dry-run",
      description: "Preview a write using the exact ref returned by read",
    },
    {
      command: "ntn-skills write 'skill://resource-tag-governance/SKILL.md' --input ./SKILL.md",
      description: "Write the current Skill body and metadata using the protocol",
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
const configShow = Command.make("show", {}, () =>
  Effect.gen(function* () {
    yield* emit({ config: publicConfiguration(yield* configuration) })
  }),
).pipe(
  Command.withShortDescription("Show local configuration with token presence only"),
  Command.withDescription(
    "Read local configuration offline. Token values are omitted; token_configured reports a non-empty configured token. Authentication priority: config.token > NOTION_API_TOKEN > existing ntn login. The default database affects create/import only.",
  ),
)
const configSetDefault = Command.make(
  "set-default",
  {
    database: Argument.String("database").pipe(
      Argument.withDescription(
        "Skills Database ID, Notion URL or exact registered alias; validated online and saved as an ID",
      ),
    ),
  },
  (config) =>
    Effect.gen(function* () {
      yield* emit({ config: publicConfiguration(yield* setDefaultDatabase(config.database)) })
    }),
).pipe(
  Command.withShortDescription("Set the default Skills Database for create/import"),
  Command.withDescription(
    "Validate a non-trashed Skills Database online and save its canonical ID as default_database. Preserves source registrations; writes local configuration only.",
  ),
  Command.withExamples([
    {
      command: "ntn-skills config set-default DATABASE_ID",
      description: "Choose the database for future create/import commands",
    },
  ]),
)
const configClearDefault = Command.make("clear-default", {}, () =>
  Effect.gen(function* () {
    yield* emit({ config: publicConfiguration(yield* setDefaultDatabase()) })
  }),
).pipe(
  Command.withShortDescription("Clear the default creation database"),
  Command.withDescription(
    "Remove default_database from local configuration offline, preserving source registrations. Create/import will then use the only discovered database or --database.",
  ),
)
const configSetToken = Command.make(
  "set-token",
  {
    stdin: Flag.Boolean("stdin").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Required: read the token from piped standard input, never command arguments",
      ),
    ),
  },
  (config) =>
    Effect.gen(function* () {
      const stdio = yield* Stdio.Stdio
      if (!config.stdin || (yield* stdio.stdinIsTerminal))
        return yield* Effect.fail(
          fail("INVALID_ARGUMENT", "Pipe the token into config set-token --stdin."),
        )
      const input = yield* stdio.stdin.pipe(
        Stream.decodeText(),
        Stream.runFold(
          () => "",
          (text, chunk) => text + chunk,
        ),
        Effect.mapError(() =>
          fail("INPUT_FAILED", "Could not read the token from standard input."),
        ),
      )
      yield* emit({ config: yield* setToken(input) })
    }),
).pipe(
  Command.withShortDescription("Store the token from standard input in local configuration"),
  Command.withDescription(
    "Read one token from piped stdin with --stdin; trim surrounding whitespace and reject empty/multiple values. Store config.token with private file permissions while preserving sources/default_database. Works offline; no Notion request or credential validation. Output only reports token_configured. Config token takes priority over NOTION_API_TOKEN and existing ntn login.",
  ),
  Command.withExamples([
    {
      command: "ntn-skills config set-token --stdin",
      description:
        "Pipe one token from a trusted secret source into this command; do not put it in arguments",
    },
  ]),
)
const configClearToken = Command.make("clear-token", {}, () =>
  Effect.gen(function* () {
    yield* emit({ config: yield* setToken() })
  }),
).pipe(
  Command.withShortDescription("Remove config.token and use environment/ntn login fallback"),
  Command.withDescription(
    "Remove only the configured token offline, preserving sources/default_database. Future online requests use NOTION_API_TOKEN or existing ntn login. Output never includes a token.",
  ),
  Command.withExamples([
    {
      command: "ntn-skills config clear-token",
      description: "Remove the configuration token and restore environment/login fallback",
    },
  ]),
)
const configCommand = Command.make("config").pipe(
  Command.withShortDescription("Manage local authentication and database preferences"),
  Command.withDescription(
    "Configuration: NTN_SKILLS_CONFIG_HOME > XDG_CONFIG_HOME/ntn-skills > ~/.config/ntn-skills. Set config.token via set-token --stdin; clear-token restores environment/login fallback. All output omits token values. default_database applies to create/import. No Notion writes.",
  ),
  Command.withSubcommands([
    configShow,
    configSetToken,
    configClearToken,
    configSetDefault,
    configClearDefault,
  ]),
)

const sourceAdd = Command.make(
  "add",
  {
    alias: Argument.String("alias").pipe(
      Argument.withDescription(
        "Exact local database selection alias; independent of Skill invocation names",
      ),
    ),
    database: requiredDatabaseFlag,
  },
  (config) =>
    Effect.gen(function* () {
      yield* emit({ source: yield* addSource(config.alias, config.database) })
    }),
).pipe(
  Command.withShortDescription("Register a Skills Database in local configuration"),
  Command.withDescription(
    "Validate one Skills Database ID, URL or existing registered alias online and persist its registration in ~/.config/ntn-skills/config.json (or NTN_SKILLS_CONFIG_HOME / XDG_CONFIG_HOME). Use the new alias with --database or config set-default. Exact aliases select one database; database titles are display labels only. Writes local configuration only; registrations supplement discovery. Re-registering a database changes its alias; an alias already used for another database fails.",
  ),
  Command.withExamples([
    {
      command: "ntn-skills source add personal --database DATABASE_ID",
      description: "Register a known database; replace DATABASE_ID with its ID or URL",
    },
  ]),
)
const sourceList = Command.make("list", {}, () =>
  Effect.gen(function* () {
    yield* emit({ sources: yield* configuredSources })
  }),
).pipe(
  Command.withShortDescription("List locally registered database sources"),
  Command.withDescription(
    "Read database registrations from ~/.config/ntn-skills/config.json (or NTN_SKILLS_CONFIG_HOME / XDG_CONFIG_HOME). Works offline. If new configuration is absent, migrates valid legacy state configuration once and preserves a .migrated backup.",
  ),
  Command.withExamples([
    {
      command: "ntn-skills source list",
      description: "Inspect local registrations without authentication",
    },
  ]),
)
const sourceCommand = Command.make("source").pipe(
  Command.withShortDescription("Manage local database registrations"),
  Command.withDescription(
    "Manage local Skills Database registrations. Configuration: NTN_SKILLS_CONFIG_HOME > XDG_CONFIG_HOME/ntn-skills > ~/.config/ntn-skills. NTN_SKILLS_HOME controls cached state only. No Notion writes.",
  ),
  Command.withSubcommands([sourceAdd, sourceList]),
)
const resolveCommand = Command.make(
  "resolve",
  {
    relative: Argument.String("relative-path").pipe(
      Argument.withDescription(
        "File path relative to the containing file named by --from; cannot escape the skill root",
      ),
    ),
    from: Flag.String("from").pipe(
      Flag.withDescription(
        "Required containing-file skill:// ref; a pinned snapshot is preserved in the returned ref",
      ),
    ),
  },
  (config) =>
    Effect.gen(function* () {
      const ref = yield* Effect.try({
        try: () => resolveRef(config.from, config.relative),
        catch: (e) => e as SkillsError,
      })
      yield* emit({ ref })
    }),
).pipe(
  Command.withShortDescription("Resolve relative file refs without network access"),
  Command.withDescription(
    "Resolve a file path relative to a containing-file skill:// ref and preserve its snapshot. Pure local transformation: no authentication or download, and no file-existence check. Returns JSON with ref. Replace PINNED_REF with the containing file's returned ref.",
  ),
  Command.withExamples([
    {
      command: "ntn-skills resolve ../assets/template.md --from 'PINNED_REF'",
      description: "Resolve from a nested reference file and retain its fixed version",
    },
  ]),
)

const doctorCommand = Command.make("doctor", {}, () =>
  Effect.gen(function* () {
    const api = yield* Notion
    const version = yield* api.version
    const result = yield* catalog({ refresh: true })
    let exportStatus: unknown = {
      checked: false,
      reason: "No skill is present in the discovered list.",
    }
    if (result.skills[0]) {
      const exported = yield* api.request(`v1/ai/skills/${result.skills[0].id}`)
      exportStatus = {
        checked: true,
        available: Boolean(exported && typeof exported === "object" && "version_id" in exported),
      }
    }
    yield* emit({
      ntn_version: version,
      authentication: "available",
      skills_databases: result.databases.length,
      skill_count: result.skills.length,
      skills_api: exportStatus,
      coverage: result.coverage,
    })
  }),
).pipe(
  Command.withShortDescription("Check ntn, authentication, discovery and export API"),
  Command.withDescription(
    "Check ntn version, existing authentication, discovery coverage and export API availability. Does not download bodies or start login. Authentication priority: config.token > NOTION_API_TOKEN > existing ntn login. Use config set-token --stdin to configure a token. Inspect coverage.failed_sources and skills_api; checked=false means no Skill was available to probe.",
  ),
  Command.withExamples([
    {
      command: "ntn-skills doctor",
      description: "Diagnose the existing connection before online operations",
    },
  ]),
)

const root = Command.make("ntn-skills").pipe(
  Command.withDescription(
    "Discover and read: list [--query text] returns paginated Skill metadata, database ID/title/alias/data-source maps and coverage. read TARGET [--path file] obtains its own complete snapshot; files TARGET lists supporting paths. Follow the returned pinned ref with read relative-path --from REF. open/resolve are optional advanced helpers. Targets accept Name, invocation alias, page ID/URL, skill:// ref or snapshot ID. Pinned reads/files/exports work offline. --refresh belongs to list metadata only.\n\nDatabase selection: --database accepts one ID, URL or exact registered alias; repeated values fail. Register with source add frontend --database DATABASE_ID, then use list --database frontend or read NAME --database frontend. Titles are display labels only. Different databases may contain the same Skill name; name ambiguity reports candidates and their database maps. No --database means broad read discovery. Config set-default accepts the same selector and stores its canonical ID for create/import only.\n\nModify and move: create INPUT creates a new Skill and rejects an existing name in the selected database; import INPUT creates, reuses identical content or replaces same-name content in that database. Both accept ZIP, folder or Markdown and preserve source files/extra frontmatter/nested paths. write TARGET --input FILE replaces one file; unchanged input performs no mutation. export TARGET --output PATH writes a complete ZIP or folder, reuses identical output and rejects different output. Use --dry-run for create/import/write. Database priority for create/import: --database > config.default_database > sole discovered database.\n\nSettings and diagnosis: database list discovers databases without querying Skill rows; source list/add manages registrations; config show/set-default/clear-default owns the creation default. config set-token --stdin/clear-token manages a global plaintext token with private file permissions. Pipe a token from a trusted secret source; never put it in command arguments. Config output exposes token_configured only. doctor checks runtime/auth/API.\n\nOutput: one JSON value on stdout; check ok/error.code. Exit 0 success, 1 operation failure, 2 invalid arguments. Help/version are text; read --raw changes successful content only. No implicit script execution or login. Online access needs Bun and official ntn. Authentication priority: non-empty config.token > NOTION_API_TOKEN > existing ntn login. Clear a stale config token to restore environment/login fallback.\n\nNotion Name uses English letters and single spaces, max 64 characters; lowercase/hyphens yield the invocation alias. Configuration: NTN_SKILLS_CONFIG_HOME > XDG_CONFIG_HOME/ntn-skills > ~/.config/ntn-skills. State: NTN_SKILLS_HOME > XDG_STATE_HOME/ntn-skills > ~/.local/state/ntn-skills.\n\nRecovery: ambiguity requires an explicit page/database; CREATE_CONFLICT means use import to replace or select a new name; OUTPUT_CONFLICT needs a different destination; CATALOG_INCOMPLETE requires fixing failed sources; WRITE_CONFLICT requires a fresh read; WRITE_PARTIAL/WRITE_OUTCOME_UNKNOWN requires readback before retry. Help runs offline without writable configuration. Use ntn-skills COMMAND --help for flags and examples.",
  ),
  Command.withExamples([
    {
      command: "ntn-skills list",
      description: "Discover skill names, descriptions and refs without loading bodies",
    },
    {
      command: "ntn-skills read 'skill://resource-tag-governance/SKILL.md'",
      description: "Activate one skill and retain the returned pinned ref",
    },
    {
      command: "ntn-skills read vocabulary.md --from 'PINNED_REF'",
      description: "Read an attachment; replace PINNED_REF with the previous read's ref",
    },
  ]),
  Command.withSubcommands([
    listCommand,
    databaseCommand,
    openCommand,
    readCommand,
    filesCommand,
    createCommand,
    importCommand,
    exportCommand,
    writeCommand,
    configCommand,
    sourceCommand,
    resolveCommand,
    doctorCommand,
  ]),
)
const platform = Layer.mergeAll(
  NodeServices.layer,
  NodeHttpClient.layerFetch,
  StoreLive.pipe(Layer.provide(NodeServices.layer)),
)
const live = NotionLive.pipe(Layer.provideMerge(platform))
const args = process.argv.length > 2 ? process.argv.slice(2) : ["--help"]
const formatter = CliOutput.defaultFormatter({ colors: false })
const requestedHelp = args.includes("--help") || args.includes("-h") || args.length === 0
const cliConfiguration = Layer.mergeAll(
  CliConfig.layer({ builtIns: [GlobalFlag.Help, GlobalFlag.Version, GlobalFlag.Completions] }),
  CliOutput.layer({
    ...formatter,
    formatHelpDoc: (doc) => (requestedHelp ? formatter.formatHelpDoc(doc) : ""),
  }),
)

const program = Command.runWith(root, { version, renderErrors: false })(args).pipe(
  Effect.catchCause((cause) =>
    Effect.gen(function* () {
      const error = Cause.squash(cause)
      const code =
        error instanceof SkillsError
          ? error.code
          : CliError.isCliError(error)
            ? "INVALID_ARGUMENT"
            : "INTERNAL_ERROR"
      const parseErrors =
        CliError.isCliError(error) && error._tag === "ShowHelp" ? error.errors : []
      const message = parseErrors.length
        ? parseErrors.map((e) => e.message).join("; ")
        : error instanceof SkillsError || CliError.isCliError(error)
          ? error.message
          : "An unexpected implementation failure occurred."
      const details =
        error instanceof SkillsError
          ? error.details
          : parseErrors.map((e) => ({ code: e._tag, message: e.message }))
      const stdio = yield* Stdio.Stdio
      yield* Stream.make(
        JSON.stringify({
          ok: false,
          error: { code, message, ...(details === undefined ? {} : { details }) },
        }) + "\n",
      ).pipe(Stream.run(stdio.stdout()))
      process.exitCode = code === "INVALID_ARGUMENT" ? 2 : 1
    }),
  ),
  Effect.provide(Layer.mergeAll(live, cliConfiguration)),
)
NodeRuntime.runMain(program, { disableErrorReporting: true })
