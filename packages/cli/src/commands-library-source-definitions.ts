import {
  attachSourceLibrary,
  initializeSourceLibrary,
} from "../../core/src/shared-sources-library.ts"
import { Effect, Option } from "effect"
import { Argument, Command } from "effect/cli"
import { defineCommand, withConstraints } from "../../core/src/command-schema.ts"
import { fail, property } from "../../core/src/model.ts"
import { withReadOnlyNotion } from "../../core/src/notion-readonly.ts"
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
  sourceRefreshPin,
  applySourceRefresh,
  reconcileSourceRefresh,
  reviewSourceMembers,
} from "../../core/src/shared-source-refresh.ts"
import {
  prepareSourceRefreshBatch,
  runSourceRefreshBatch,
} from "../../core/src/shared-source-batch.ts"
import { exportPortable } from "../../core/src/export.ts"
import { assertSharedFileReferences } from "../../core/src/shared-file-references.ts"
import { emit, requiredSingleton, singleton, switchFlag } from "./command-options.ts"
import { Store } from "../../core/src/store.ts"
import { Notion } from "../../core/src/notion.ts"
import {
  sourceRunCommand,
  sourceRunStatusCommand,
  sourceRunListCommand,
  sourceRequestBudgets,
  parseSourceBudget,
} from "./commands-library-source-run.ts"
import { withSourceUpdateLock } from "../../core/src/shared-source-policy.ts"
import { withSourceCommandBudget } from "../../core/src/shared-source-budget.ts"
import { readSourceJson as input } from "./command-source-input.ts"
import {
  sourceAdmitCommand,
  sourceAdmitApplyCommand,
  sourceAdmitReconcileCommand,
  sourceMemberPrepareCommand,
  sourceMemberApplyCommand,
  sourceMemberReconcileCommand,
} from "./commands-library-source-members.ts"
const entry = requiredSingleton("entry", "Exact shared Skills database with Sources attached")
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
      const library = yield* loadSharedLibrary(args.entry)
      const action = putSourceDefinition(library, definition, args.expected, args.dryRun)
      yield* emit(
        yield* withSourceUpdateLock(
          library,
          args.dryRun ? action.pipe(withReadOnlyNotion) : action,
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
      const library = yield* loadSharedLibrary(args.entry)
      const action = bindSourceDefinition(library, args)
      yield* emit(
        yield* withSourceUpdateLock(
          library,
          args.dryRun ? action.pipe(withReadOnlyNotion) : action,
        ),
      )
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
      const library = yield* loadSharedLibrary(entry)
      const definition = yield* readSourceDefinition(library, source)
      const snapshot = yield* discoverSourceDefinition(definition, {
        metrics: (yield* Notion).metrics,
      })
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
        member_review: yield* reviewSourceMembers(library, definition.page_id, snapshot),
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
        snapshot = yield* discoverSourceDefinition(definition, {
          metrics: (yield* Notion).metrics,
        }),
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
    target: singleton("target", "Exact already-bound Skill page; exclusive with --all-bound"),
    allBound: switchFlag("all-bound", "Freeze every enabled Skill bound to this exact Source"),
    storage: singleton(
      "storage",
      "auto, fixed-git, or retained; auto uses unchanged complete public GitHub trees directly",
    ),
    output: requiredSingleton("output", "New or identical frozen plan JSON"),
  },
  ({ source, entry, target, allBound, storage, output }) =>
    Effect.gen(function* () {
      const selected = Option.getOrUndefined(target)
      if ((selected !== undefined) === allBound)
        return yield* Effect.fail(
          fail("INVALID_ARGUMENT", "Choose exactly one of --target or --all-bound."),
        )
      const policy = Option.getOrElse(storage, () => "auto")
      if (policy !== "auto" && policy !== "fixed-git" && policy !== "retained")
        return yield* Effect.fail(
          fail("INVALID_ARGUMENT", "Choose auto, fixed-git, or retained storage."),
        )
      const library = yield* loadSharedLibrary(entry)
      const plan = allBound
        ? yield* prepareSourceRefreshBatch(library, source, undefined, policy)
        : yield* prepareSourceRefresh(library, source, selected ?? "", undefined, policy)
      yield* (yield* Store).output(
        output,
        new TextEncoder().encode(JSON.stringify(plan, null, 2) + "\n"),
      )
      yield* emit(
        plan.kind === "source_refresh_batch"
          ? {
              plan_id: plan.plan_id,
              output,
              provider_revision: plan.provider_revision,
              member_review: plan.member_review,
              membership: plan.membership,
              items: plan.plans.map((item) => ({
                plan_id: item.plan_id,
                target_page_id: item.target_page_id,
                member: item.member,
                source_pin: sourceRefreshPin(item),
                storage: item.version === 4 ? "fixed_git" : "retained",
                projected_files: item.projected_files,
                custom_files_preserved: item.custom_files_preserved,
              })),
              remote_writes: 0,
              request_metrics: (yield* Notion).requestMetrics?.(),
            }
          : {
              plan_id: plan.plan_id,
              output,
              member: plan.member,
              provider_revision: plan.provider_revision,
              source_pin: sourceRefreshPin(plan),
              storage: plan.version === 4 ? "fixed_git" : "retained",
              projected_files: plan.projected_files,
              custom_files_preserved: plan.custom_files_preserved,
              member_review: plan.member_review,
              remote_writes: 0,
              request_metrics: (yield* Notion).requestMetrics?.(),
            },
      )
    }).pipe(withReadOnlyNotion),
).pipe(
  withConstraints([
    { kind: "exactly_one", flags: ["target", "allBound"] },
    { kind: "allowed_values", flag: "storage", values: ["auto", "fixed-git", "retained"] },
  ]),
  Command.withDescription(
    "Freeze one provider revision for one --target or --all-bound enabled Skills, preserving current ownership and complete membership; no remote writes.",
  ),
)
const apply = defineCommand(
  "apply",
  {
    plan: Argument.String("plan"),
    entry,
    ...sourceRequestBudgets,
    dryRun: switchFlag(
      "dry-run",
      "Recheck the exact frozen plan without retaining or selecting content",
    ),
  },
  (args) =>
    Effect.gen(function* () {
      const frozen = yield* input(args.plan)
      const limits = yield* parseSourceBudget(args)
      const { result, budget } = yield* withSourceCommandBudget(
        Effect.gen(function* () {
          const library = yield* loadSharedLibrary(args.entry)
          if (property(frozen).kind === "source_refresh_batch") {
            const result = yield* withSourceUpdateLock(
              library,
              runSourceRefreshBatch(library, frozen, { mode: "apply", dryRun: args.dryRun }),
            )
            if (result.status === "partial")
              return yield* Effect.fail(
                fail(
                  "SOURCE_BATCH_PARTIAL",
                  "Some original member operations need review.",
                  result,
                ),
              )
            return result
          }
          const action = applySourceRefresh(library, frozen, args.dryRun)
          return yield* withSourceUpdateLock(
            library,
            args.dryRun ? action.pipe(withReadOnlyNotion) : action,
          )
        }),
        limits,
      )
      yield* emit({ ...result, budget })
    }),
).pipe(
  Command.withDescription(
    "Apply the exact frozen member or Source batch through existing original-operation journals. Partial results retain every member outcome; no multi-page atomicity or body overwrite is claimed.",
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
  { plan: Argument.String("plan"), entry, ...sourceRequestBudgets },
  (args) =>
    Effect.gen(function* () {
      const frozen = yield* input(args.plan)
      const limits = yield* parseSourceBudget(args)
      const { result, budget } = yield* withSourceCommandBudget(
        Effect.gen(function* () {
          const library = yield* loadSharedLibrary(args.entry)
          if (property(frozen).kind === "source_refresh_batch")
            return yield* runSourceRefreshBatch(library, frozen, { mode: "reconcile" })
          return yield* reconcileSourceRefresh(library, frozen)
        }),
        limits,
      )
      yield* emit({ ...result, budget })
      if ("status" in result && result.status === "partial") process.exitCode = 4
    }).pipe(withReadOnlyNotion),
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
    sourceRunCommand,
    sourceRunStatusCommand,
    sourceRunListCommand,
    sourceAdmitCommand,
    sourceAdmitApplyCommand,
    sourceAdmitReconcileCommand,
    sourceMemberPrepareCommand,
    sourceMemberApplyCommand,
    sourceMemberReconcileCommand,
  ]),
)
