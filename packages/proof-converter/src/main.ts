#!/usr/bin/env node
/** Standalone operator artifact; never imported by the normal CLI or offline migrator. */
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, FileSystem, Layer, Stdio, Stream } from "effect"
import { Command, Flag } from "effect/cli"
import { fail } from "../../core/src/model.ts"
import { NotionLive } from "../../core/src/notion.ts"
import { probeSqliteRuntime } from "../../core/src/sqlite-runtime-policy.ts"
import { sha256, StoreLive } from "../../core/src/store.ts"
import { applyPlan, InputSchema, makePlan, persistExclusive, strict } from "./converter.ts"

const platform = Layer.mergeAll(
  NodeServices.layer,
  NodeHttpClient.layerFetch,
  StoreLive.pipe(Layer.provide(NodeServices.layer)),
)
const live = NotionLive.pipe(Layer.provideMerge(platform))
const plan = Command.make(
  "plan",
  {
    input: Flag.String("input"),
    output: Flag.String("output"),
  },
  ({ input, output }) =>
    probeSqliteRuntime.pipe(
      Effect.flatMap(() =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const source = yield* fs.readFileString(input)
          const allowlist = yield* Effect.try({
            try: () => strict(InputSchema, JSON.parse(source)),
            catch: () => fail("INVALID_ARGUMENT", "Allowlist failed its strict schema."),
          })
          const result = yield* makePlan(allowlist)
          if (!(yield* persistExclusive(output, result)))
            return yield* Effect.fail(
              fail("CONVERSION_BLOCKED", "Plan output already exists; use another path."),
            )
          const bytes = yield* fs.readFileString(output)
          yield* Stream.make(
            JSON.stringify({
              output,
              plan_hash: yield* sha256(bytes),
              target_count: result.targets.length,
              remote_writes: 0,
            }) + "\n",
          ).pipe(Stream.run((yield* Stdio.Stdio).stdout()))
        }).pipe(Effect.provide(live)),
      ),
    ),
)
const apply = Command.make(
  "apply",
  {
    plan: Flag.String("plan"),
    hash: Flag.String("expected-plan-hash"),
    ledger: Flag.String("ledger"),
    apply: Flag.Boolean("apply"),
  },
  (args) => {
    if (!args.apply)
      return Effect.fail(fail("INVALID_ARGUMENT", "The apply command requires explicit --apply."))
    return probeSqliteRuntime.pipe(
      Effect.flatMap(() =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const result = yield* applyPlan(
            yield* fs.readFileString(args.plan),
            args.hash,
            args.ledger,
            true,
          )
          yield* Stream.make(JSON.stringify(result) + "\n").pipe(
            Stream.run((yield* Stdio.Stdio).stdout()),
          )
          if (result.results.some((target) => target.state !== "converted"))
            return yield* Effect.fail(
              fail(
                "CONVERSION_UNRESOLVED",
                "Read the retained ledger; unresolved targets cannot be blindly rewritten.",
              ),
            )
        }).pipe(Effect.provide(live)),
      ),
    )
  },
)
const reconcile = Command.make(
  "reconcile",
  {
    plan: Flag.String("plan"),
    hash: Flag.String("expected-plan-hash"),
    ledger: Flag.String("ledger"),
  },
  (args) =>
    probeSqliteRuntime.pipe(
      Effect.flatMap(() =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const result = yield* applyPlan(
            yield* fs.readFileString(args.plan),
            args.hash,
            args.ledger,
            false,
          )
          yield* Stream.make(JSON.stringify(result) + "\n").pipe(
            Stream.run((yield* Stdio.Stdio).stdout()),
          )
          if (result.results.some((target) => target.state !== "converted"))
            return yield* Effect.fail(
              fail(
                "CONVERSION_UNRESOLVED",
                "Read-only reconciliation has unresolved targets; retain the ledger.",
              ),
            )
        }).pipe(Effect.provide(live)),
      ),
    ),
)
const command = Command.make("ntn-skills-proof-convert").pipe(
  Command.withSubcommands([plan, apply, reconcile]),
)
NodeRuntime.runMain(
  Command.runWith(command, { version: "1", renderErrors: false })(process.argv.slice(2)).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  ),
)
