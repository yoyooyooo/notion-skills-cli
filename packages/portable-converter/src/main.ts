#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, Option, Stdio, Stream } from "effect"
import { Command, Flag } from "effect/cli"
import { convertPath } from "./converter.ts"
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

const command = Command.make("ntn-skills-portable-convert").pipe(Command.withSubcommands([offline]))
NodeRuntime.runMain(
  Command.runWith(command, { version: "1", renderErrors: false })(process.argv.slice(2)).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  ),
)
