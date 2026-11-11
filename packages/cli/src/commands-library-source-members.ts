import { Effect, Option } from "effect"
import { Argument, Command } from "effect/cli"
import { defineCommand, withConstraints } from "../../core/src/command-schema.ts"
import { fail } from "../../core/src/model.ts"
import { Notion } from "../../core/src/notion.ts"
import { withReadOnlyNotion } from "../../core/src/notion-readonly.ts"
import { pageId } from "../../core/src/ref.ts"
import { executeSharedCreate, previewSharedCreate } from "../../core/src/shared-create.ts"
import { validateSharedCreatePlan } from "../../core/src/shared-create-model.ts"
import { loadSharedLibrary } from "../../core/src/shared-library.ts"
import { discoverSourceDefinition } from "../../core/src/shared-source-adapters.ts"
import { withSourceCommandBudget } from "../../core/src/shared-source-budget.ts"
import { readSourceDefinition } from "../../core/src/shared-source-definitions.ts"
import {
  executeSourceMemberDecision,
  prepareSourceMemberDecision,
} from "../../core/src/shared-source-member-decision.ts"
import { withSourceUpdateLock } from "../../core/src/shared-source-policy.ts"
import { prepareSharedSourceProjection } from "../../core/src/shared-source-projection.ts"
import { Store } from "../../core/src/store.ts"
import { emit, requiredSingleton, singleton, switchFlag } from "./command-options.ts"
import { readSourceJson } from "./command-source-input.ts"
import { parseSourceBudget, sourceRequestBudgets } from "./commands-library-source-run.ts"

const entry = requiredSingleton("entry", "Exact shared library with Sources attached")
const output = requiredSingleton("output", "New or identical frozen plan JSON")
const writePlan = (path: string, plan: unknown) =>
  Effect.gen(function* () {
    yield* (yield* Store).output(
      path,
      new TextEncoder().encode(JSON.stringify(plan, null, 2) + "\n"),
    )
  })

export const sourceAdmitCommand = defineCommand(
  "admit",
  {
    source: Argument.String("source"),
    entry,
    output,
    member: requiredSingleton("member", "Exact reviewed new provider member key"),
    skillId: requiredSingleton("skill-id", "New stable Skill business identity"),
    enable: switchFlag(
      "enable",
      "Explicitly enable this new Skill only after its complete initial projection is verified",
    ),
    ...sourceRequestBudgets,
  },
  (args) =>
    Effect.gen(function* () {
      const limits = yield* parseSourceBudget(args)
      const { result: plan, budget } = yield* withSourceCommandBudget(
        Effect.gen(function* () {
          const library = yield* loadSharedLibrary(args.entry)
          const definition = yield* readSourceDefinition(library, args.source)
          if (!definition.enabled)
            return yield* Effect.fail(
              fail("SOURCE_DISABLED", "Enable the reviewed Source before admitting a new member."),
            )
          const acquired = yield* discoverSourceDefinition(definition, {
            metrics: (yield* Notion).metrics,
          })
          return yield* prepareSharedSourceProjection({
            library,
            definition,
            acquired,
            member: args.member,
            skillId: args.skillId,
            enabled: args.enable,
            markdownImport: true,
          })
        }),
        limits,
      )
      yield* writePlan(args.output, plan)
      yield* emit({
        operation_id: plan.operation_id,
        skill_id: plan.skill_id,
        enabled: plan.enabled ?? true,
        source_projection: plan.source_projection,
        projected_files: plan.files.map((file) => ({
          path: file.path,
          bytes: file.input.bytes,
          sha256: file.input.sha256,
        })),
        output: args.output,
        budget,
        remote_writes: 0,
      })
    }).pipe(withReadOnlyNotion),
).pipe(
  Command.withDescription(
    "Freeze one complete exact provider member, its resources and new native Markdown pages. New Skills stay disabled unless --enable is explicit. This prepares the existing original create operation without remote writes.",
  ),
)

export const sourceAdmitApplyCommand = defineCommand(
  "admit-apply",
  {
    plan: Argument.String("plan"),
    entry,
    ...sourceRequestBudgets,
    dryRun: switchFlag("dry-run", "Revalidate the frozen original create plan without writing"),
  },
  (args) =>
    Effect.gen(function* () {
      const plan = yield* validateSharedCreatePlan(
        yield* readSourceJson(args.plan, 192 * 1024 * 1024),
      )
      if (!plan.source_projection)
        return yield* Effect.fail(
          fail("SOURCE_ADMISSION_REQUIRED", "Use a frozen Source admission plan."),
        )
      const limits = yield* parseSourceBudget(args)
      const { result, budget } = yield* withSourceCommandBudget(
        Effect.gen(function* () {
          const library = yield* loadSharedLibrary(args.entry)
          return yield* withSourceUpdateLock(
            library,
            Effect.gen(function* () {
              if (args.dryRun)
                return yield* previewSharedCreate(library, plan).pipe(withReadOnlyNotion)
              return yield* executeSharedCreate(library, { plan, mode: "create" })
            }),
          )
        }),
        limits,
      )
      yield* emit({ ...result, budget })
    }),
).pipe(
  Command.withDescription(
    "Create only the exact reviewed new Source member through the original native-create journal. An unknown original write is reconciled, never recreated.",
  ),
)

export const sourceAdmitReconcileCommand = defineCommand(
  "admit-reconcile",
  {
    plan: Argument.String("plan"),
    entry,
    ...sourceRequestBudgets,
  },
  (args) =>
    Effect.gen(function* () {
      const plan = yield* validateSharedCreatePlan(
        yield* readSourceJson(args.plan, 192 * 1024 * 1024),
      )
      if (!plan.source_projection)
        return yield* Effect.fail(
          fail("SOURCE_ADMISSION_REQUIRED", "Use the original frozen Source admission plan."),
        )
      const limits = yield* parseSourceBudget(args)
      const { result, budget } = yield* withSourceCommandBudget(
        Effect.gen(function* () {
          const library = yield* loadSharedLibrary(args.entry)
          return yield* executeSharedCreate(library, { plan, mode: "reconcile" })
        }),
        limits,
      )
      yield* emit({ ...result, budget })
    }).pipe(withReadOnlyNotion),
).pipe(
  Command.withDescription(
    "Read the original admission outcome from the frozen create plan without another provider read or remote write.",
  ),
)

export const sourceMemberPrepareCommand = defineCommand(
  "member-prepare",
  {
    source: Argument.String("source"),
    entry,
    output,
    target: requiredSingleton("target", "Exact existing Skill page UUID or URL"),
    member: singleton("member", "Exact new provider member to bind"),
    retainRemoved: switchFlag(
      "retain-removed",
      "Keep the selected content, native customizations and old pins; detach this removed member from future discovery",
    ),
    ...sourceRequestBudgets,
  },
  (args) =>
    Effect.gen(function* () {
      const member = Option.getOrUndefined(args.member)
      const target = pageId(args.target)
      if (!target || (member !== undefined) === args.retainRemoved)
        return yield* Effect.fail(
          fail(
            "INVALID_ARGUMENT",
            "Choose an exact target and exactly one of --member or --retain-removed.",
          ),
        )
      const limits = yield* parseSourceBudget(args)
      const { result: plan, budget } = yield* withSourceCommandBudget(
        Effect.gen(function* () {
          const library = yield* loadSharedLibrary(args.entry)
          return yield* prepareSourceMemberDecision(library, {
            source: args.source,
            target,
            action: args.retainRemoved
              ? { kind: "retain_removed" }
              : { kind: "rebind", member: member! },
          })
        }),
        limits,
      )
      yield* writePlan(args.output, plan)
      yield* emit({ plan, output: args.output, budget, remote_writes: 0 })
    }).pipe(withReadOnlyNotion),
).pipe(
  withConstraints([{ kind: "exactly_one", flags: ["member", "retainRemoved"] }]),
  Command.withDescription(
    "Review a complete provider observation and freeze an explicit exact-member decision. This does not infer renames, switch selected bytes, or delete content.",
  ),
)

export const sourceMemberApplyCommand = defineCommand(
  "member-apply",
  {
    plan: Argument.String("plan"),
    entry,
    ...sourceRequestBudgets,
    dryRun: switchFlag("dry-run", "Revalidate the original binding without writing"),
  },
  (args) =>
    Effect.gen(function* () {
      const plan = yield* readSourceJson(args.plan)
      const limits = yield* parseSourceBudget(args)
      const { result, budget } = yield* withSourceCommandBudget(
        Effect.gen(function* () {
          const library = yield* loadSharedLibrary(args.entry)
          return yield* withSourceUpdateLock(
            library,
            executeSourceMemberDecision(library, plan, { dryRun: args.dryRun }),
          )
        }),
        limits,
      )
      yield* emit({ ...result, budget })
      if (!args.dryRun && !result.verified) process.exitCode = 4
    }),
).pipe(
  Command.withDescription(
    "Apply the exact reviewed discovery binding through its original mutation journal. Selected content and user relations are preserved.",
  ),
)

export const sourceMemberReconcileCommand = defineCommand(
  "member-reconcile",
  {
    plan: Argument.String("plan"),
    entry,
    ...sourceRequestBudgets,
  },
  (args) =>
    Effect.gen(function* () {
      const plan = yield* readSourceJson(args.plan)
      const limits = yield* parseSourceBudget(args)
      const { result, budget } = yield* withSourceCommandBudget(
        Effect.gen(function* () {
          const library = yield* loadSharedLibrary(args.entry)
          return yield* executeSourceMemberDecision(library, plan, { reconcile: true })
        }),
        limits,
      )
      yield* emit({ ...result, budget })
      if (!result.verified) process.exitCode = 4
    }).pipe(withReadOnlyNotion),
).pipe(
  Command.withDescription(
    "Reconcile the original member decision without writes or provider rediscovery; current equality alone does not confirm an unknown original request.",
  ),
)
