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
  openSkill,
  parseDuration,
  cacheStatus,
  clearCache,
  configureCachePolicy,
  effectiveCachePolicy,
  clearCachePolicy,
  SyncLocalLive,
  bindSync,
  syncStatus,
  planSync,
  applySync,
  reconcileSync,
  unbindSync,
  type ReadPolicyOptions,
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
const singleton = (name: string, description: string) =>
  Flag.String(name).pipe(
    Flag.atMost(1),
    Flag.map((values) => Option.fromUndefinedOr(values[0])),
    Flag.withDescription(description),
  )
const requiredSingleton = (name: string, description: string) =>
  Flag.String(name).pipe(
    Flag.between(1, 1),
    Flag.map((values) => values[0]!),
    Flag.withDescription(description),
  )
const switchFlag = (name: string, description: string) =>
  Flag.Boolean(name).pipe(
    Flag.atMost(1),
    Flag.map((values) => values[0] ?? false),
    Flag.withDescription(description),
  )
const refreshFlag = switchFlag("refresh", "Validate online regardless of cache age")
const readPolicyFlags = {
  refresh: refreshFlag,
  offline: switchFlag("offline", "Read local observations only, including expired content"),
  maxAge: singleton(
    "max-age",
    "Maximum observation age: 0, Ns, Nm, Nh or Nd; default 5m (list 60s)",
  ),
}
function readPolicy(config: { refresh: boolean; offline: boolean; maxAge: Option.Option<string> }) {
  return Effect.try({
    try: (): ReadPolicyOptions => {
      const maxAge = Option.getOrUndefined(config.maxAge)
      if (Number(config.refresh) + Number(config.offline) + Number(maxAge !== undefined) > 1)
        throw fail("INVALID_ARGUMENT", "--refresh, --offline and --max-age are mutually exclusive.")
      return {
        refresh: config.refresh,
        offline: config.offline,
        ...(maxAge === undefined ? {} : { maxAge: parseDuration(maxAge) }),
      }
    },
    catch: (error) => error as SkillsError,
  })
}

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
    ...readPolicyFlags,
    query: singleton("query", "Case-insensitive filter on Name, invocation alias and Description"),
  },
  (config) =>
    Effect.gen(function* () {
      const result = yield* catalog({
        database: Option.getOrUndefined(config.database),
        ...(yield* readPolicy(config)),
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
        source: result.source,
        freshness: result.freshness,
      })
    }),
).pipe(
  Command.withShortDescription("List available skills with names, descriptions and refs"),
  Command.withDescription(
    "List paginated lightweight Skill metadata with database maps and coverage. --query filters Name/alias/Description while retaining the database map. Catalog age defaults to 60s; --refresh validates online, --offline uses stored observations, --max-age overrides age. These policies are mutually exclusive. Cache freshness never improves discovery coverage; failed sources stay explicit. --database accepts one ID, URL or exact registered alias; Search is not workspace-exhaustive.",
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
    ...readPolicyFlags,
  },
  (config) =>
    Effect.gen(function* () {
      const target = yield* Effect.try({
        try: () => parseTarget(config.selector),
        catch: (e) => e as SkillsError,
      })
      yield* emit(
        snapshotInfo(
          yield* targetSnapshot(target, {
            database: Option.getOrUndefined(config.database),
            ...(yield* readPolicy(config)),
          }),
        ),
      )
    }),
).pipe(
  Command.withShortDescription("Download a skill into an immutable snapshot"),
  Command.withDescription(
    "Return complete snapshot metadata and pinned file refs without contents. Current targets reuse complete eligible observations for 5m by default. --refresh validates online, --offline reads local observations, --max-age overrides age. Pinned refs and snapshot IDs remain immutable and offline; they reject refresh/max-age. Expired online reads wait for validation and never silently fall back to stale content. Normal reads obtain their own snapshot; open is optional. Scripts are never executed.",
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
    "Read one file, default SKILL.md. Names/aliases/page IDs/URLs/unpinned refs reuse complete eligible observations for 5m; --refresh validates online, --offline reads local observations, --max-age overrides age. Policies are mutually exclusive. Pinned targets (including relative --from pinned refs) stay immutable/offline and reject refresh/max-age. --path supplies a file only when the target has no path. Relative --from rejects --path. JSON includes source/freshness, identity, pinned ref, version, range and has_more. --lines uses inclusive 1-based ranges. --output writes exact bytes with identical reuse and differing-output rejection; --raw emits successful text only. Missing cached versions require a new current read; arbitrary historical versions cannot be fetched.",
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
    path: singleton(
      "path",
      "File/directory filter; omit for every file; cannot replace a ref's path",
    ),
    database: databaseFlag,
    ...readPolicyFlags,
  },
  (config) =>
    Effect.gen(function* () {
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
    "List pinned file refs from one complete snapshot. Current targets follow the 5m content policy; use mutually exclusive --refresh, --offline or --max-age. Pinned refs/snapshot IDs work offline and reject refresh/max-age. --path filters one file/directory when the target has no path; a file ref filters itself, a pathless ref lists every file. Source/freshness describe the selected observation, not current access when cached.",
  ),
  Command.withExamples([
    {
      command: "ntn-skills files SNAPSHOT_ID --path references",
      description: "Find attachment paths in the same snapshot",
    },
  ]),
)

const dryRunFlag = switchFlag(
  "dry-run",
  "Validate inputs and show the decision without content or configuration writes",
)
const createCommand = Command.make(
  "create",
  {
    input: Argument.String("input").pipe(
      Argument.withDescription("Local ZIP, Skill folder or Markdown file"),
    ),
    database: databaseFlag,
    name: singleton("name", "English display title overriding source metadata"),
    description: singleton("description", "Override Description; required if source has none"),
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
    "Create one new Skill; an existing invocation name returns CREATE_CONFLICT before mutation. Accepts ZIP, folder or Markdown with a portable manifest or SKILL.md/unique Markdown entrypoint; --name/--description override metadata. References Markdown becomes editable child pages and relative links become Notion URLs. Optional Files preserves original bytes, extra frontmatter and other assets; without Files only main/reference Markdown is accepted and export is normalized. Database priority: --database > configured default > sole discovered skill database. --dry-run validates and reports action=create without mutation. Success returns a verified snapshot, pinned refs and content_id. Insert, Update and Read content are required. Inspect partial/unknown outcomes before retrying.",
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
    name: singleton("name", "English display title overriding source metadata"),
    description: singleton("description", "Override Description; required if source has none"),
    target: singleton(
      "target",
      "Existing page selector or pinned main-file baseline; preserve its identity without create fallback",
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
          target: Option.getOrUndefined(config.target),
        }),
      )
    }),
).pipe(
  Command.withShortDescription("Import a Skill, replacing same-name content"),
  Command.withDescription(
    "Import one ZIP, folder or Markdown file. Without --target, match the invocation name in the selected creation database: create if absent, reuse identical content, update differing content. --target resolves one existing page and preserves its identity even when imported metadata renames it; missing/inaccessible targets never create. Pinned main targets enforce expected scope/version; reference-file targets fail. --database constrains an explicit target; otherwise priority is --database > configured default > sole discovered database. --name/--description override source metadata. Whole-Skill updates replace the complete file set; omitted reference pages remain available in Notion. Optional Files preserves bytes/assets; page-only mode accepts main/reference Markdown and compares normalized content. Strong validation includes reference edits; read back partial/unknown outcomes before retry. --dry-run validates without content mutation.",
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
      if (format !== undefined && format !== "zip" && format !== "directory")
        return yield* Effect.fail(fail("INVALID_ARGUMENT", "--format requires zip or directory."))
      yield* emit(
        yield* exportSkill(config.selector, {
          output: config.output,
          format,
          database: Option.getOrUndefined(config.database),
          ...(yield* readPolicy(config)),
        }),
      )
    }),
).pipe(
  Command.withShortDescription("Export a complete reversible Skill as ZIP or folder"),
  Command.withDescription(
    "Export every Skill file and a versioned portable manifest. Current inputs follow the 5m content policy; use mutually exclusive --refresh, --offline or --max-age. Pinned refs and snapshot IDs are immutable/offline and reject refresh/max-age. References links become relative paths; optional Files preserves source bytes, while page-only output is normalized. ZIP entries sort deterministically with fixed timestamps. --output is required; .zip selects ZIP, otherwise directory; --format overrides it. Identical output returns reused=true; differing output returns OUTPUT_CONFLICT. Cache policy changes input selection only, never output overwrite permission. Export never mutates Notion.",
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
    path: singleton("path", "Skill-relative file path, default SKILL.md; omit for a file ref"),
    input: requiredSingleton("input", "Local file containing the full replacement content"),
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
    "Replace one Skill file using shared targets, default SKILL.md. --path supplies a path only when the target has none. Pinned refs and snapshot IDs are online version baselines; stale main or reference-page content returns WRITE_CONFLICT. Unpinned targets capture the current version. Entry point name/description update properties; notion_page_id must match. Reference paths update or add editable Notion pages and restore page links. Optional Files retains extra frontmatter and nested/binary assets; page-only mode accepts main/reference Markdown. Other logical files stay intact. Identical input returns action=unchanged and unchanged=true without mutation. --dry-run validates and reports the target. Success returns a verified snapshot, pinned file ref and previous_version_id. Read back WRITE_PARTIAL/WRITE_OUTCOME_UNKNOWN before retrying.",
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
    yield* emit({
      config: {
        ...publicConfiguration(yield* configuration),
        effective_cache_policy: yield* effectiveCachePolicy,
      },
    })
  }),
).pipe(
  Command.withShortDescription("Show local configuration with token presence only"),
  Command.withDescription(
    "Read local configuration and effective cache policy offline. Token values are omitted; token_configured reports a non-empty configured token. Authentication priority: config.token > NOTION_API_TOKEN > existing ntn login. The default database affects create/import only; cache policy controls current reads and catalog observations.",
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
    stdin: switchFlag(
      "stdin",
      "Required: read the token from piped standard input, never command arguments",
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
const configSetCachePolicy = Command.make(
  "set-cache-policy",
  {
    readMaxAge: singleton("read-max-age", "Content age limit: 0, Ns, Nm, Nh or Nd (default 5m)"),
    catalogMaxAge: singleton(
      "catalog-max-age",
      "Catalog age limit: 0, Ns, Nm, Nh or Nd (default 60s)",
    ),
  },
  (config) =>
    Effect.gen(function* () {
      const read = Option.getOrUndefined(config.readMaxAge)
      const catalog = Option.getOrUndefined(config.catalogMaxAge)
      if (read === undefined && catalog === undefined)
        return yield* Effect.fail(
          fail("INVALID_ARGUMENT", "Provide --read-max-age or --catalog-max-age."),
        )
      const policy = yield* Effect.try({
        try: () => ({
          ...(read === undefined ? {} : { readMaxAge: parseDuration(read) }),
          ...(catalog === undefined ? {} : { catalogMaxAge: parseDuration(catalog) }),
        }),
        catch: (error) => error as SkillsError,
      })
      yield* emit({ config: yield* configureCachePolicy(policy) })
    }),
).pipe(Command.withShortDescription("Save specified cache age defaults offline"))
const configClearCachePolicy = Command.make("clear-cache-policy", {}, () =>
  Effect.gen(function* () {
    yield* emit({ config: yield* clearCachePolicy })
  }),
).pipe(
  Command.withShortDescription("Restore built-in cache policy without removing content or state"),
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
    configSetCachePolicy,
    configClearCachePolicy,
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
    from: requiredSingleton(
      "from",
      "Containing-file skill:// ref; a pinned snapshot is preserved in the returned ref",
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
    let readStatus: unknown = {
      checked: false,
      reason: "No skill is present in the discovered list.",
    }
    if (result.skills[0]) {
      const snapshot = yield* openSkill(result.skills[0].id, { refresh: true })
      readStatus = {
        checked: true,
        available: true,
        storage: snapshot.references ? "references" : "native_skills",
      }
    }
    yield* emit({
      ntn_version: version,
      authentication: "available",
      skills_databases: result.databases.length,
      skill_count: result.skills.length,
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

const bindingArgument = Argument.String("binding").pipe(
  Argument.withDescription("Registered binding ID or exact local label"),
)
const syncBindCommand = Command.make(
  "bind",
  {
    target: Argument.String("target"),
    path: requiredSingleton(
      "path",
      "Logical local Skill directory; an absent ordinary leaf can be initialized",
    ),
    as: singleton("as", "Unique local binding label; default is the remote invocation alias"),
    database: databaseFlag,
    dryRun: dryRunFlag,
  },
  (config) =>
    Effect.gen(function* () {
      yield* emit(
        yield* bindSync(config.target, {
          path: config.path,
          as: Option.getOrUndefined(config.as),
          database: Option.getOrUndefined(config.database),
          dryRun: config.dryRun,
        }),
      )
    }),
).pipe(
  Command.withShortDescription("Bind an existing page to one logical local directory"),
  Command.withDescription(
    "Registration validates both sides online. Equal contents initialize a confirmed common baseline; differences require sync plan --from local|notion. Bind never copies content or creates a page. Historical targets and dangling links fail; --dry-run saves no binding or baseline.",
  ),
)
const syncStatusCommand = Command.make(
  "status",
  {
    binding: bindingArgument.pipe(Argument.optional),
    refresh: refreshFlag,
  },
  (config) =>
    Effect.gen(function* () {
      yield* emit(
        yield* syncStatus(Option.getOrUndefined(config.binding), { refresh: config.refresh }),
      )
    }),
).pipe(
  Command.withShortDescription(
    "Inspect one or all bindings; remote observations are provisional by default",
  ),
  Command.withDescription(
    "Default inspects local content, common baseline and the last cached remote observation without network. --refresh validates remote state online. Neither observation advances a common baseline.",
  ),
)
const syncPlanCommand = Command.make(
  "plan",
  {
    binding: bindingArgument.pipe(Argument.optional),
    all: switchFlag("all", "Plan all active bindings with shared-page and real-target checks"),
    from: singleton(
      "from",
      "Explicit source local or notion for initialization or conflict resolution",
    ),
    output: singleton(
      "output",
      "Reviewable JSON copy; identical copies reused, differing output rejected",
    ),
  },
  (config) =>
    Effect.gen(function* () {
      const binding = Option.getOrUndefined(config.binding)
      const from = Option.getOrUndefined(config.from)
      if ((binding === undefined) === !config.all || (config.all && from !== undefined))
        return yield* Effect.fail(
          fail(
            "INVALID_ARGUMENT",
            "Provide exactly one binding or --all; --from is single-binding only.",
          ),
        )
      if (from !== undefined && from !== "local" && from !== "notion")
        return yield* Effect.fail(fail("INVALID_ARGUMENT", "--from requires local or notion."))
      yield* emit(
        yield* planSync(binding, {
          all: config.all,
          from,
          output: Option.getOrUndefined(config.output),
        }),
      )
    }),
).pipe(
  Command.withShortDescription("Save a strongly checked content-addressed sync plan"),
  Command.withDescription(
    "Preview without content or baseline changes. One-sided changes select direction; differing two-sided changes fail with a retained conflict plan. --from explicitly resolves initialization/conflict and still enforces all version/path/link checks. Batch plans accept only one candidate per page and can fan out to unchanged copies.",
  ),
)
const syncApplyCommand = Command.make(
  "apply",
  {
    plan: requiredSingleton("plan", "Exact saved p_<sha256> plan ID or local JSON file"),
  },
  (config) =>
    Effect.gen(function* () {
      yield* emit(yield* applySync(config.plan))
    }),
).pipe(
  Command.withShortDescription("Revalidate and execute the saved plan with verified readback"),
  Command.withDescription(
    "All initial preconditions are checked before the first write. Content, baseline, binding, scope or link changes reject the plan. Confirmed convergence advances each baseline; partial/unknown results retain receipts and require reconcile before another apply. There is no force, direction override or global transaction.",
  ),
)
const syncReconcileCommand = Command.make("reconcile", { binding: bindingArgument }, (config) =>
  Effect.gen(function* () {
    yield* emit(yield* reconcileSync(config.binding))
  }),
).pipe(
  Command.withShortDescription("Read back an unfinished operation without repeating writes"),
  Command.withDescription(
    "Strongly reads both sides and classifies the recorded intent. Verified convergence may advance the common baseline; divergence retains the old base. Unresolved outcomes stay explicit and fence affected resources.",
  ),
)
const syncUnbindCommand = Command.make(
  "unbind",
  {
    binding: bindingArgument,
    dryRun: dryRunFlag,
  },
  (config) =>
    Effect.gen(function* () {
      yield* emit(yield* unbindSync(config.binding, { dryRun: config.dryRun }))
    }),
).pipe(
  Command.withShortDescription(
    "Deactivate a binding while retaining content, plans, receipts and baseline",
  ),
)
const syncCommand = Command.make("sync").pipe(
  Command.withShortDescription(
    "Synchronize existing Notion pages and logical local Skill directories",
  ),
  Command.withSubcommands([
    syncBindCommand,
    syncStatusCommand,
    syncPlanCommand,
    syncApplyCommand,
    syncReconcileCommand,
    syncUnbindCommand,
  ]),
)
const cacheStatusCommand = Command.make(
  "status",
  {
    target: Argument.String("target").pipe(Argument.optional),
    database: databaseFlag,
  },
  (config) =>
    Effect.gen(function* () {
      yield* emit(
        yield* cacheStatus(Option.getOrUndefined(config.target), {
          database: Option.getOrUndefined(config.database),
        }),
      )
    }),
).pipe(Command.withShortDescription("Inspect effective roots and cached observations offline"))
const cacheClearCommand = Command.make(
  "clear",
  {
    target: Argument.String("target").pipe(Argument.optional),
    all: switchFlag("all", "Retire disposable observations in every recorded scope"),
    database: databaseFlag,
    dryRun: dryRunFlag,
  },
  (config) =>
    Effect.gen(function* () {
      const target = Option.getOrUndefined(config.target)
      if ((target === undefined) === !config.all || (config.all && Option.isSome(config.database)))
        return yield* Effect.fail(
          fail(
            "INVALID_ARGUMENT",
            "Provide exactly one target or --all; --database is target-only.",
          ),
        )
      yield* emit(
        yield* clearCache(target, {
          all: config.all,
          database: Option.getOrUndefined(config.database),
          dryRun: config.dryRun,
        }),
      )
    }),
).pipe(
  Command.withShortDescription("Move selected cache observations to system Trash"),
  Command.withDescription(
    "Retires disposable latest/catalog observations only. Pinned snapshots, content objects, bindings, plans, receipts and common baselines survive. --dry-run previews entries; unavailable system Trash is an explicit prerequisite failure.",
  ),
)
const cacheCommand = Command.make("cache").pipe(
  Command.withShortDescription("Inspect and retire disposable read observations"),
  Command.withSubcommands([cacheStatusCommand, cacheClearCommand]),
)

const root = Command.make("ntn-skills").pipe(
  Command.withDescription(
    "Discover and read: list returns paginated metadata and coverage; read/open/files/export accept Name, alias, page ID/URL, skill:// ref or cached snapshot. Current content uses complete eligible observations for 5m; list defaults to 60s. Mutually exclusive --refresh, --offline and --max-age control freshness. Expired online reads wait for validation, with no stale-on-error fallback. Pinned targets remain immutable/offline and reject refresh/max-age; follow their supporting files with read relative-path --from REF. Cached identity is credential/workspace/endpoint/database scoped.\n\nModify and move: create INPUT creates a page; import INPUT creates/reuses/replaces by invocation name. import INPUT --target TARGET replaces one existing page without identity redirection or create fallback. write TARGET --input FILE replaces one file using online version checks. References become editable child pages; optional Files preserves source bytes/assets. Export writes a reversible ZIP/folder without overwriting differing output. --dry-run previews create/import/write.\n\nSynchronize: sync bind TARGET --path DIR registers a logical directory. Differing first binds require sync plan BINDING --from local|notion. Later one-sided changes select direction from the confirmed common baseline; two-sided differences conflict. sync plan --all validates shared-page candidates and fan-out. sync apply --plan PLAN_ID_OR_FILE rechecks versions, baseline/config identity and complete link chains before execution. Baselines advance only after verified convergence. sync status is provisional/offline by default; --refresh observes current remote state. sync reconcile reads unfinished operations without replay; sync unbind retains content and state.\n\nSettings: database list discovers databases; source list/add manages exact registrations. config set-default affects create/import only. config set-token --stdin/clear-token manages a private plaintext token; never put credentials in arguments. config set-cache-policy/clear-cache-policy manages age defaults. cache status inspects roots/observations offline; cache clear TARGET|--all moves disposable observations to system Trash while retaining snapshots, objects, bindings, plans and receipts. Doctor always checks online.\n\nStorage: configuration NTN_SKILLS_CONFIG_HOME > XDG_CONFIG_HOME/ntn-skills > ~/.config/ntn-skills; state NTN_SKILLS_HOME > XDG_STATE_HOME/ntn-skills > ~/.local/state/ntn-skills; cache NTN_SKILLS_CACHE_HOME > XDG_CACHE_HOME/ntn-skills > ~/.cache/ntn-skills. Authentication config.token > NOTION_API_TOKEN > existing ntn login. Online operations need official ntn; consumers require Node.js >=22.19.0.\n\nOutput: one JSON value; exit 0 success, 1 operational failure, 2 invalid arguments. Help/version are offline text; read --raw changes successful text only. No automatic scripts/login, interactive conflict decisions or force bypass. WRITE_CONFLICT or stale plans need fresh observation/replanning; WRITE_PARTIAL/WRITE_OUTCOME_UNKNOWN and interrupted sync require readback/reconcile before new writes. Provider commits are not server-atomic. Use ntn-skills COMMAND --help for parameters.",
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
    syncCommand,
    cacheCommand,
    resolveCommand,
    doctorCommand,
  ]),
)
const platform = Layer.mergeAll(
  NodeServices.layer,
  NodeHttpClient.layerFetch,
  StoreLive.pipe(Layer.provide(NodeServices.layer)),
  SyncLocalLive.pipe(Layer.provide(NodeServices.layer)),
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
