import {
  attachSourceLibrary,
  initializeSourceLibrary,
} from "../../core/src/shared-sources-library.ts"
import { Effect, FileSystem, Option } from "effect"
import { Argument, Command } from "effect/cli"
import { defineCommand } from "../../core/src/command-schema.ts"
import { fail } from "../../core/src/model.ts"
import { loadSharedLibrary } from "../../core/src/shared-library.ts"
import {
  readSourceDefinition,
  listSourceDefinitions,
  listSourceMembers,
  putSourceDefinition,
  bindSourceDefinition,
  sourceChecked,
  validateSourceDefinition,
} from "../../core/src/shared-source-definitions.ts"
import {
  discoverSourceDefinition,
  sourceAdapterCapabilities,
} from "../../core/src/shared-source-adapters.ts"
import {
  prepareSourceRefresh,
  applySourceRefresh,
  reconcileSourceRefresh,
} from "../../core/src/shared-source-refresh.ts"
import { exportPortable } from "../../core/src/export.ts"
import { assertSharedFileReferences } from "../../core/src/shared-file-references.ts"
import { emit, requiredSingleton, singleton, switchFlag } from "./command-options.ts"
import { Store } from "../../core/src/store.ts"
const entry = requiredSingleton("entry", "Exact shared Skills database with Sources attached")
function input(path: string) {
  return Effect.gen(function* () {
    const raw = yield* (yield* FileSystem.FileSystem)
      .readFileString(path)
      .pipe(
        Effect.mapError(() =>
          fail("SOURCE_INPUT_UNAVAILABLE", "Cannot read the selected source JSON input."),
        ),
      )
    if (Buffer.byteLength(raw) > 48 * 1024 * 1024)
      return yield* Effect.fail(fail("SOURCE_INPUT_TOO_LARGE", "Source input exceeds 48 MiB."))
    return yield* sourceChecked(() => JSON.parse(raw) as unknown)
  })
}
const list = defineCommand("list", { entry }, ({ entry }) =>
  Effect.gen(function* () {
    const library = yield* loadSharedLibrary(entry)
    yield* emit({
      items: yield* listSourceDefinitions(library),
      metadata_only: true,
      provider_requests: 0,
    })
  }),
).pipe(
  Command.withDescription(
    "List the complete live Sources metadata; never fetch providers or Skill bodies.",
  ),
)
const show = defineCommand(
  "show",
  { source: Argument.String("source"), entry },
  ({ source, entry }) =>
    Effect.gen(function* () {
      yield* emit({
        definition: yield* readSourceDefinition(yield* loadSharedLibrary(entry), source),
      })
    }),
).pipe(
  Command.withDescription(
    "Read one exact Source and its complete configuration fingerprint, including long paginated options.",
  ),
)
const members = defineCommand(
  "members",
  { source: Argument.String("source"), entry },
  ({ source, entry }) =>
    Effect.gen(function* () {
      yield* emit(yield* listSourceMembers(yield* loadSharedLibrary(entry), source))
    }),
).pipe(
  Command.withDescription(
    "List every bound Skill/Router and its exact member/pin using the forward Origin relation and complete pagination; no body or provider reads.",
  ),
)
const providers = defineCommand("providers", {}, () =>
  emit({ items: sourceAdapterCapabilities }),
).pipe(Command.withDescription("Show implemented provider capabilities without network requests."))
const put = defineCommand(
  "put",
  {
    entry,
    input: requiredSingleton("input", "Complete Source definition JSON"),
    expected: requiredSingleton("expect", "Exact show fingerprint, or absent to create"),
    dryRun: switchFlag("dry-run", "Validate and preview without a source mutation"),
  },
  (args) =>
    Effect.gen(function* () {
      const raw = yield* input(args.input)
      const definition = yield* sourceChecked(() => validateSourceDefinition(raw))
      yield* emit(
        yield* putSourceDefinition(
          yield* loadSharedLibrary(args.entry),
          definition,
          args.expected,
          args.dryRun,
        ),
      )
    }),
).pipe(
  Command.withDescription(
    "Create or replace a live Source definition under an explicit fingerprint guard. Credentials are forbidden. No content pin or body is changed.",
  ),
)
const bind = defineCommand(
  "bind",
  {
    source: Argument.String("source"),
    entry,
    target: requiredSingleton("target", "Exact Skill page"),
    member: requiredSingleton("member", "Exact provider member key"),
    expected: requiredSingleton("expect-origin", "Exact current Source page ID, or none"),
    dryRun: switchFlag("dry-run", "Preview the association without writes"),
  },
  (args) =>
    Effect.gen(function* () {
      yield* emit(yield* bindSourceDefinition(yield* loadSharedLibrary(args.entry), args))
    }),
).pipe(
  Command.withDescription(
    "Associate a Skill with a Source/member without changing its selected content version or user customizations.",
  ),
)
const check = defineCommand(
  "check",
  { source: Argument.String("source"), entry },
  ({ source, entry }) =>
    Effect.gen(function* () {
      const definition = yield* readSourceDefinition(yield* loadSharedLibrary(entry), source)
      const snapshot = yield* discoverSourceDefinition(definition)
      yield* emit({
        definition,
        revision: snapshot.revision,
        provenance: snapshot.provenance,
        members: snapshot.members.map((m) => ({
          member_key: m.member_key,
          name: m.portable.name,
          description: m.portable.description,
          content_hash: m.content_hash,
          files: m.portable.files.length,
          bytes: m.portable.files.reduce((n, f) => n + f.bytes.length, 0),
        })),
        unavailable: snapshot.unavailable ?? [],
        remote_writes: 0,
        current_pins_changed: false,
      })
    }),
).pipe(
  Command.withDescription(
    "Read the configured provider and discover a complete candidate. Does not apply, publish or execute content.",
  ),
)
const fetch = defineCommand(
  "fetch",
  {
    source: Argument.String("source"),
    entry,
    member: singleton("member", "Exact member; required when the source has multiple Skills"),
    output: requiredSingleton("output", "New or identical portable output directory"),
  },
  ({ source, entry, member, output }) =>
    Effect.gen(function* () {
      const definition = yield* readSourceDefinition(yield* loadSharedLibrary(entry), source),
        snapshot = yield* discoverSourceDefinition(definition),
        key = Option.getOrUndefined(member)
      const selected =
        key === undefined && snapshot.members.length === 1
          ? snapshot.members
          : snapshot.members.filter((m) => m.member_key === key)
      if (selected.length !== 1)
        return yield* Effect.fail(
          fail("SOURCE_MEMBER_AMBIGUOUS", "Select exactly one returned member key."),
        )
      yield* sourceChecked(() => assertSharedFileReferences(selected[0]!.portable.files))
      yield* emit({
        definition_id: definition.source_id,
        provider_revision: snapshot.revision,
        member: selected[0]!.member_key,
        export: yield* exportPortable(selected[0]!.portable, {
          output,
          format: "directory",
          projection: "source",
        }),
        remote_writes: 0,
        current_pins_changed: false,
      })
    }),
).pipe(
  Command.withDescription(
    "Acquire a provider member and export its complete portable tree; no remote changes and no script execution.",
  ),
)
const prepare = defineCommand(
  "prepare",
  {
    source: Argument.String("source"),
    entry,
    target: requiredSingleton("target", "Exact already-bound Skill page"),
    output: requiredSingleton("output", "New or identical frozen plan JSON"),
  },
  ({ source, entry, target, output }) =>
    Effect.gen(function* () {
      const plan = yield* prepareSourceRefresh(yield* loadSharedLibrary(entry), source, target)
      yield* (yield* Store).output(
        output,
        new TextEncoder().encode(JSON.stringify(plan, null, 2) + "\n"),
      )
      yield* emit({
        plan_id: plan.plan_id,
        output,
        member: plan.member,
        provider_revision: plan.provider_revision,
        source_pin: plan.bundle_id,
        projected_files: plan.projected_files,
        custom_files_preserved: plan.custom_files_preserved,
        remote_writes: 0,
      })
    }),
).pipe(
  Command.withDescription(
    "Freeze a complete provider revision and preview one member against current native ownership; no remote writes.",
  ),
)
const apply = defineCommand(
  "apply",
  {
    plan: Argument.String("plan"),
    entry,
    dryRun: switchFlag(
      "dry-run",
      "Recheck the exact frozen plan without retaining or selecting content",
    ),
  },
  ({ plan, entry, dryRun }) =>
    Effect.gen(function* () {
      yield* emit(
        yield* applySourceRefresh(yield* loadSharedLibrary(entry), yield* input(plan), dryRun),
      )
    }),
).pipe(
  Command.withDescription(
    "Recheck one frozen source/member plan, retain its complete bundle and explicitly select it using the existing guarded Source journal. Preserves custom bodies and old pins.",
  ),
)
const init = defineCommand("init", { entry }, ({ entry }) =>
  Effect.gen(function* () {
    yield* emit(yield* initializeSourceLibrary(yield* loadSharedLibrary(entry)))
  }),
).pipe(
  Command.withDescription(
    "Initialize and attach the independent Sources table and native Origin/Source Member relationships. Existing current content and pins are unchanged; unknown writes are not replayed.",
  ),
)
const attach = defineCommand(
  "attach",
  {
    entry,
    manifest: requiredSingleton(
      "manifest",
      "Exact proposed library descriptor with Sources and stable relation identities",
    ),
    dryRun: switchFlag("dry-run", "Verify schema and preview descriptor attachment without writes"),
  },
  ({ entry, manifest, dryRun }) =>
    Effect.gen(function* () {
      yield* emit(yield* attachSourceLibrary(entry, yield* input(manifest), dryRun))
    }),
).pipe(
  Command.withDescription(
    "Verify and attach an explicitly initialized Sources schema without replacing any existing table identity.",
  ),
)
const reconcile = defineCommand(
  "reconcile",
  { plan: Argument.String("plan"), entry },
  ({ plan, entry }) =>
    Effect.gen(function* () {
      yield* emit(
        yield* reconcileSourceRefresh(yield* loadSharedLibrary(entry), yield* input(plan)),
      )
    }),
).pipe(
  Command.withDescription(
    "Read the exact original refresh-selection outcome without repeating writes. A missing or unknown original selection is not replaced from current visibility.",
  ),
)
export const librarySourceDefinitionsCommand = defineCommand("sources").pipe(
  Command.withShortDescription(
    "Manage provider-neutral live Sources, separately from immutable content pins",
  ),
  Command.withSubcommands([
    init,
    attach,
    providers,
    list,
    show,
    members,
    put,
    bind,
    check,
    fetch,
    prepare,
    apply,
    reconcile,
  ]),
)
