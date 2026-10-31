import { Clock, Effect, FileSystem, Option } from "effect"
import { Store } from "../../core/src/store.ts"
import {
  archiveSharedHistory,
  restoreSharedHistory,
} from "../../core/src/shared-history-workflow.ts"
import { Argument, Command } from "effect/cli"
import {
  inspectFixedGithubSource,
  validateFixedGithubSource,
} from "../../core/src/shared-github-source.ts"
import { registerSourceBinding } from "../../core/src/shared-source-binding.ts"
import { initializeSharedLibrary, loadSharedLibrary } from "../../core/src/shared-library.ts"
import {
  FileEventSchema,
  notionWriteCapabilities,
  resolveFileState,
} from "../../core/src/shared-file-state.ts"
import { querySharedSkillIndex } from "../../core/src/shared-skill-index.ts"
import { Notion } from "../../core/src/notion.ts"
import { querySharedRecords } from "../../core/src/shared-records.ts"
import { decode, fail, property, SkillsError, SnapshotSchema } from "../../core/src/model.ts"
import { defineCommand } from "../../core/src/command-schema.ts"
import { emit, singleton, requiredSingleton, switchFlag } from "./command-options.ts"
import { libraryMigrationCommand } from "./commands-library-migration.ts"
import { libraryProfilesCommand } from "./commands-library-profiles.ts"

const initialize = defineCommand(
  "init",
  {
    parent: singleton("parent", "Create one shared library under this exact Notion parent page"),
    entry: singleton("entry", "Attach and verify an existing shared library database entry"),
    operation: singleton(
      "operation",
      "Reconcile an original initialization; never replay unknown creation",
    ),
  },
  (options) =>
    Effect.gen(function* () {
      yield* emit(
        yield* initializeSharedLibrary({
          parent: Option.getOrUndefined(options.parent),
          entry: Option.getOrUndefined(options.entry),
          operation: Option.getOrUndefined(options.operation),
        }),
      )
    }),
).pipe(
  Command.withDescription(
    "Create Skills, flat Skill Files and shared Records tables, or attach an exact existing entry. Stable property/data-source IDs live in Notion. Repeating the same parent reuses its unique registered library. Unknown creation is retained with its original operation; this command does not migrate existing content or change machine defaults.",
  ),
)

const inspect = defineCommand("inspect", { entry: Argument.String("entry") }, ({ entry }) =>
  Effect.gen(function* () {
    yield* emit({ library: yield* loadSharedLibrary(entry), capabilities: notionWriteCapabilities })
  }),
).pipe(
  Command.withDescription(
    "Read a shared library descriptor from its exact Notion entry. This reads management metadata only, not Skill bodies or upstream resources.",
  ),
)

const files = defineCommand(
  "files",
  {
    target: Argument.String("target"),
    entry: requiredSingleton("entry", "Exact shared library database entry"),
  },
  ({ target, entry }) =>
    Effect.gen(function* () {
      const library = yield* loadSharedLibrary(entry)
      const index = yield* querySharedSkillIndex(library, target)
      yield* emit({
        library_id: library.library_id,
        ...index,
        count: index.files.length,
        metadata_only: true,
        request_metrics: (yield* Notion).requestMetrics?.(),
      })
    }),
).pipe(
  Command.withDescription(
    "Query only the selected Skill's flat file metadata, following all data-source cursors. Returns stable file IDs, logical paths and the actual body-page edit times. Does not read bodies, fetch upstream resources or infer deletion from inaccessible rows.",
  ),
)

const state = defineCommand(
  "state",
  {
    target: Argument.String("target"),
    entry: requiredSingleton("entry", "Exact shared library database entry"),
  },
  ({ target, entry }) =>
    Effect.gen(function* () {
      const library = yield* loadSharedLibrary(entry)
      const index = yield* querySharedSkillIndex(library, target)
      const facts = yield* querySharedRecords(library, {
        skillPageId: index.page_id,
        kind: "file_event",
      })
      const states = yield* Effect.try({
        try: () => {
          const events = facts.map((fact) => {
            const event = decode(FileEventSchema, fact.payload)
            if (fact.entity_id !== event.file_id || fact.record_id !== event.event_id)
              throw fail(
                "SHARED_STATE_SCOPE",
                "A file event disagrees with its shared record identity.",
              )
            return event
          })
          const bindings = [index.main, ...index.files]
          const currentIds = new Set(bindings.map((binding) => binding.file_id))
          return {
            files: bindings.map((binding) => {
              const selected = events.filter((event) => event.file_id === binding.file_id)
              return {
                file_id: binding.file_id,
                path: binding.path,
                page_id: binding.page_id,
                resolution: selected.length
                  ? resolveFileState(binding.file_id, selected)
                  : { kind: "uninitialized" as const },
              }
            }),
            unbound_file_ids: [...new Set(events.map((event) => event.file_id))].filter(
              (id) => !currentIds.has(id),
            ),
          }
        },
        catch: (error) =>
          error instanceof SkillsError
            ? error
            : fail("SHARED_STATE_INVALID", "The shared file facts could not be decoded."),
      })
      yield* emit({
        library_id: library.library_id,
        skill_id: index.skill_id,
        skill_page_id: index.page_id,
        ...states,
        metadata_only: true,
        request_metrics: (yield* Notion).requestMetrics?.(),
      })
    }),
).pipe(
  Command.withDescription(
    "Rebuild file ownership from Notion's shared immutable facts without reading current bodies or local file state. Missing baselines remain uninitialized; incompatible event heads fail explicitly. This inspection does not change ownership or restore following.",
  ),
)

const sourceFlags = {
  commit: requiredSingleton("commit", "Selected immutable full 40-character Git commit"),
  root: requiredSingleton(
    "root",
    "Exact repository-relative source root; use an empty string for the whole repository",
  ),
}
const sourceInspect = defineCommand(
  "inspect",
  {
    url: Argument.String("url"),
    ...sourceFlags,
  },
  ({ url, commit, root }) =>
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis
      const api = yield* Notion
      const source = yield* inspectFixedGithubSource({ url, commit, root, metrics: api.metrics })
      yield* emit({
        source,
        metadata_only: true,
        elapsed_ms: (yield* Clock.currentTimeMillis) - startedAt,
        request_metrics: api.requestMetrics?.(),
      })
    }),
).pipe(
  Command.withDescription(
    "Inspect one explicitly fixed public GitHub commit and complete selected file tree. Does not download blob bodies, execute files, or select a newer commit. Truncated trees, symlinks and submodules in scope fail explicitly.",
  ),
)
const sourceRegister = defineCommand(
  "register",
  {
    target: Argument.String("target"),
    entry: requiredSingleton("entry", "Exact shared library database entry"),
    url: singleton(
      "url",
      "Public https://github.com/owner/repository source; requires --commit and --root",
    ),
    commit: singleton("commit", "Selected immutable full Git commit; use with --url and --root"),
    root: singleton("root", "Exact repository-relative root; use with --url and --commit"),
    manifest: singleton(
      "manifest",
      "Previously inspected fixed source JSON, or the complete source inspect JSON output; excludes --url/--commit/--root",
    ),
    reconcile: switchFlag(
      "reconcile",
      "Read back the original deterministic registration without repeating an unknown create",
    ),
  },
  ({ target, entry, url, commit, root, manifest, reconcile }) =>
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis
      const api = yield* Notion
      const selectedUrl = Option.getOrUndefined(url)
      const selectedCommit = Option.getOrUndefined(commit)
      const selectedRoot = Option.getOrUndefined(root)
      const manifestPath = Option.getOrUndefined(manifest)
      const fixedSource = yield* Effect.gen(function* () {
        if (manifestPath !== undefined) {
          if (
            selectedUrl !== undefined ||
            selectedCommit !== undefined ||
            selectedRoot !== undefined
          )
            return yield* Effect.fail(
              fail(
                "INVALID_ARGUMENT",
                "--manifest cannot be combined with --url, --commit or --root.",
              ),
            )
          const json = yield* (yield* FileSystem.FileSystem)
            .readFileString(manifestPath)
            .pipe(
              Effect.mapError(() =>
                fail(
                  "SOURCE_MANIFEST_UNAVAILABLE",
                  "The selected source manifest could not be read.",
                ),
              ),
            )
          return yield* Effect.try({
            try: () => {
              const parsed: unknown = JSON.parse(json)
              return validateFixedGithubSource(property(parsed).source ?? parsed)
            },
            catch: (error) =>
              error instanceof SkillsError
                ? error
                : fail(
                    "INVALID_SHARED_SOURCE",
                    "The source manifest is not valid fixed-source JSON.",
                  ),
          })
        }
        if (selectedUrl === undefined || selectedCommit === undefined || selectedRoot === undefined)
          return yield* Effect.fail(
            fail("INVALID_ARGUMENT", "Supply --manifest, or all of --url, --commit and --root."),
          )
        return yield* inspectFixedGithubSource({
          url: selectedUrl,
          commit: selectedCommit,
          root: selectedRoot,
          metrics: api.metrics,
        })
      })
      const library = yield* loadSharedLibrary(entry)
      const index = yield* querySharedSkillIndex(library, target)
      const result = yield* registerSourceBinding(library, {
        skillPageId: index.page_id,
        mode: reconcile ? "reconcile" : "create",
        fixedSource,
      })
      yield* emit({
        ...result,
        elapsed_ms: (yield* Clock.currentTimeMillis) - startedAt,
        request_metrics: api.requestMetrics?.(),
      })
    }),
).pipe(
  Command.withDescription(
    "Retain an immutable Git source manifest for one exact shared Skill. This registers a candidate source and returns its stable source ID; it does not select it, create body projections, or replace editable content. Use --manifest to reuse a previously inspected exact source without another provider metadata request. On unknown outcome, retain the same manifest or URL/commit/root and target, and add --reconcile.",
  ),
)
const sources = defineCommand("source").pipe(
  Command.withSubcommands([sourceInspect, sourceRegister]),
)

const snapshotSave = defineCommand(
  "save",
  {
    snapshot: Argument.String("snapshot"),
    entry: requiredSingleton("entry", "Exact shared library database entry"),
    reconcile: switchFlag(
      "reconcile",
      "Observe the original frozen archive operation without repeating unknown writes",
    ),
    allowLocalArchive: switchFlag(
      "allow-local-archive",
      "Authorize sharing this exact snapshot's local resource bytes in Notion",
    ),
  },
  ({ snapshot, entry, reconcile, allowLocalArchive }) =>
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis
      if (!/^s_[a-f0-9]{64}$/.test(snapshot))
        return yield* Effect.fail(
          fail("INVALID_SNAPSHOT", "Save requires an exact local snapshot ID."),
        )
      const frozen = yield* (yield* Store).readJson(`snapshots/${snapshot}.json`, SnapshotSchema)
      if (!frozen)
        return yield* Effect.fail(
          fail("SNAPSHOT_MISSING", "The original local snapshot manifest is unavailable."),
        )
      const library = yield* loadSharedLibrary(entry)
      const result = yield* archiveSharedHistory(library, frozen, {
        mode: reconcile ? "reconcile" : "create",
        allowLocalArchive,
      })
      yield* emit({
        ...result,
        elapsed_ms: (yield* Clock.currentTimeMillis) - startedAt,
        request_metrics: (yield* Notion).requestMetrics?.(),
      })
    }),
).pipe(
  Command.withDescription(
    "Retain one already complete local shared Skill snapshot as a portable shared pin in Notion. Freezes exact final main/resource bytes, writes content chunks before the manifest, and preserves the original plan on unknown outcome. Current body content is never substituted for this pin.",
  ),
)
const snapshotRestore = defineCommand(
  "restore",
  {
    pin: Argument.String("pin"),
    entry: requiredSingleton("entry", "Exact shared library database entry"),
    target: requiredSingleton("target", "Exact Skill page belonging to the shared pin"),
  },
  ({ pin, entry, target }) =>
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis
      const library = yield* loadSharedLibrary(entry)
      const result = yield* restoreSharedHistory(library, { skillPageId: target, pinId: pin })
      yield* emit({
        ...result,
        elapsed_ms: (yield* Clock.currentTimeMillis) - startedAt,
        request_metrics: (yield* Notion).requestMetrics?.(),
      })
    }),
).pipe(
  Command.withDescription(
    "Validate current access to the exact Skill, then restore every archived byte from the selected shared Notion pin. Publishes a complete local fixed snapshot only; does not read current bodies, fetch upstream, advance current state or change Notion content. Use its returned snapshot_id with read/files/export --projection snapshot.",
  ),
)
const snapshots = defineCommand("snapshot").pipe(
  Command.withSubcommands([snapshotSave, snapshotRestore]),
)

export const libraryCommand = defineCommand("library").pipe(
  Command.withShortDescription("Initialize and inspect the shared Notion library layout"),
  Command.withSubcommands([
    initialize,
    inspect,
    files,
    state,
    sources,
    snapshots,
    libraryMigrationCommand,
    libraryProfilesCommand,
  ]),
)
