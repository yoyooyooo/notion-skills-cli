#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import { Effect, FileSystem, Layer, Option, Stdio, Stream } from "effect"
import { Command, Flag } from "effect/cli"
import { convertPath } from "./converter.ts"
import {
  planRemote,
  replanRemote,
  applyRemote,
  reconcileRemote,
  planRecoveryRemote,
  resumeRemote,
} from "./remote.ts"
import {
  applyPlan,
  InputSchema,
  makePlan,
  persistExclusive,
  strict,
} from "../../proof-converter/src/converter.ts"
import { fail } from "../../core/src/model.ts"
import { NotionLive } from "../../core/src/notion.ts"
import { StoreLive } from "../../core/src/store.ts"
import { PortableSourceDecoder } from "../../core/src/portable-source.ts"
import { convertPortable } from "./converter.ts"
import { MANIFEST, readPortable } from "../../core/src/portable.ts"
const platform = Layer.mergeAll(
  NodeServices.layer,
  NodeHttpClient.layerFetch,
  StoreLive.pipe(Layer.provide(NodeServices.layer)),
)
const live = NotionLive.pipe(Layer.provideMerge(platform))
const remotePlan = Command.make(
  "remote-plan",
  {
    target: Flag.String("target"),
    database: Flag.String("database"),
    kind: Flag.Literals("kind", ["skill", "router", "prompt"]),
    output: Flag.String("output"),
  },
  (args) =>
    Effect.gen(function* () {
      const plan = yield* planRemote(args.target, args.database, args.kind)
      if (!(yield* persistExclusive(args.output, plan)))
        return yield* Effect.fail(fail("CONVERSION_BLOCKED", "Plan output exists."))
      yield* Stream.make(JSON.stringify({ output: args.output, remote_writes: 0 }) + "\n").pipe(
        Stream.run((yield* Stdio.Stdio).stdout()),
      )
    }).pipe(Effect.provide(live)),
)
const remoteReplan = Command.make(
  "remote-replan",
  {
    fromPlan: Flag.String("from-plan"),
    hash: Flag.String("expected-plan-hash"),
    ledger: Flag.String("ledger"),
    preserveOutput: Flag.Boolean("preserve-output"),
  },
  (args) =>
    Effect.gen(function* () {
      if (!args.preserveOutput)
        return yield* Effect.fail(
          fail("INVALID_ARGUMENT", "Explicit --preserve-output is required."),
        )
      const fs = yield* FileSystem.FileSystem
      const plan = yield* replanRemote(
        yield* fs.readFileString(args.fromPlan),
        args.hash,
        args.ledger,
      )
      yield* Stream.make(JSON.stringify(plan) + "\n").pipe(
        Stream.run((yield* Stdio.Stdio).stdout()),
      )
    }).pipe(Effect.provide(live)),
)
const remoteApply = Command.make(
  "remote-apply",
  {
    plan: Flag.String("plan"),
    hash: Flag.String("expected-plan-hash"),
    ledger: Flag.String("ledger"),
    apply: Flag.Boolean("apply"),
  },
  (args) =>
    Effect.gen(function* () {
      if (!args.apply)
        return yield* Effect.fail(fail("INVALID_ARGUMENT", "Explicit --apply is required."))
      const fs = yield* FileSystem.FileSystem
      const result = yield* applyRemote(yield* fs.readFileString(args.plan), args.hash, args.ledger)
      yield* Stream.make(JSON.stringify(result) + "\n").pipe(
        Stream.run((yield* Stdio.Stdio).stdout()),
      )
    }).pipe(Effect.provide(live)),
)
const recoveryFlags = {
  plan: Flag.String("plan"),
  hash: Flag.String("expected-plan-hash"),
  ledger: Flag.String("ledger"),
  expectedPage: Flag.String("expected-page"),
  operationId: Flag.String("operation-id").pipe(Flag.optional),
}
const remoteRecoveryPlan = Command.make("remote-recovery-plan", recoveryFlags, (args) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const result = yield* planRecoveryRemote(
      yield* fs.readFileString(args.plan),
      args.hash,
      args.ledger,
      args.expectedPage,
      Option.getOrUndefined(args.operationId),
    )
    yield* Stream.make(JSON.stringify(result) + "\n").pipe(
      Stream.run((yield* Stdio.Stdio).stdout()),
    )
  }).pipe(Effect.provide(live)),
)
const remoteReconcile = Command.make("remote-reconcile", recoveryFlags, (args) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const result = yield* reconcileRemote(
      yield* fs.readFileString(args.plan),
      args.hash,
      args.ledger,
      args.expectedPage,
      Option.getOrUndefined(args.operationId),
    )
    yield* Stream.make(JSON.stringify(result) + "\n").pipe(
      Stream.run((yield* Stdio.Stdio).stdout()),
    )
  }).pipe(Effect.provide(live)),
)
const remoteResume = Command.make(
  "remote-resume",
  {
    ...recoveryFlags,
    apply: Flag.Boolean("apply"),
    recoveryPlan: Flag.String("recovery-plan").pipe(Flag.optional),
    recoveryHash: Flag.String("expected-recovery-plan-hash").pipe(Flag.optional),
  },
  (args) =>
    Effect.gen(function* () {
      if (!args.apply)
        return yield* Effect.fail(fail("INVALID_ARGUMENT", "Explicit --apply is required."))
      const recoveryPlan = Option.getOrUndefined(args.recoveryPlan)
      const recoveryHash = Option.getOrUndefined(args.recoveryHash)
      if ((recoveryPlan === undefined) !== (recoveryHash === undefined))
        return yield* Effect.fail(
          fail(
            "INVALID_ARGUMENT",
            "--recovery-plan and --expected-recovery-plan-hash must be supplied together.",
          ),
        )
      const fs = yield* FileSystem.FileSystem
      const result = yield* resumeRemote(
        yield* fs.readFileString(args.plan),
        args.hash,
        args.ledger,
        args.expectedPage,
        Option.getOrUndefined(args.operationId),
        recoveryPlan === undefined ? undefined : yield* fs.readFileString(recoveryPlan),
        recoveryHash,
      )
      yield* Stream.make(JSON.stringify(result) + "\n").pipe(
        Stream.run((yield* Stdio.Stdio).stdout()),
      )
    }).pipe(Effect.provide(live)),
)
const offline = Command.make(
  "offline",
  {
    input: Flag.String("input"),
    output: Flag.String("output"),
    kind: Flag.Literals("kind", ["skill", "router", "prompt"]).pipe(Flag.optional),
  },
  (args) =>
    Effect.gen(function* () {
      const audit = yield* convertPath(args.input, args.output, Option.getOrUndefined(args.kind))
      yield* Stream.make(JSON.stringify(audit) + "\n").pipe(
        Stream.run((yield* Stdio.Stdio).stdout()),
      )
    }),
)
const proofPlan = Command.make(
  "proof-plan",
  {
    input: Flag.String("input"),
    output: Flag.String("output"),
  },
  (args) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const input = strict(InputSchema, JSON.parse(yield* fs.readFileString(args.input)))
      const plan = yield* makePlan(input)
      if (!(yield* persistExclusive(args.output, plan)))
        return yield* Effect.fail(fail("CONVERSION_BLOCKED", "Plan output exists."))
    }).pipe(
      Effect.provide(live),
      Effect.provideService(PortableSourceDecoder, {
        rewriteSourceArchive: false,
        decode: (files) => {
          const manifest = files.find((file) => file.path === MANIFEST)
          if (!manifest) return undefined
          const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifest.bytes))
          return raw.version === 1 ? convertPortable(files, "skill").portable : readPortable(files)
        },
      }),
    ),
)
const proofApply = Command.make(
  "proof-apply",
  {
    plan: Flag.String("plan"),
    hash: Flag.String("expected-plan-hash"),
    ledger: Flag.String("ledger"),
    apply: Flag.Boolean("apply"),
  },
  (args) =>
    Effect.gen(function* () {
      if (!args.apply)
        return yield* Effect.fail(fail("INVALID_ARGUMENT", "Explicit --apply is required."))
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
    }).pipe(
      Effect.provide(live),
      Effect.provideService(PortableSourceDecoder, {
        rewriteSourceArchive: false,
        decode: (files) => {
          const manifest = files.find((file) => file.path === MANIFEST)
          if (!manifest) return undefined
          const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifest.bytes))
          return raw.version === 1 ? convertPortable(files, "skill").portable : readPortable(files)
        },
      }),
    ),
)
const command = Command.make("ntn-skills-portable-convert").pipe(
  Command.withSubcommands([
    offline,
    remotePlan,
    remoteReplan,
    remoteApply,
    remoteRecoveryPlan,
    remoteReconcile,
    remoteResume,
    proofPlan,
    proofApply,
  ]),
)
NodeRuntime.runMain(
  Command.runWith(command, { version: "1", renderErrors: false })(process.argv.slice(2)).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  ),
)
