import { Effect, FileSystem, Option, Stdio, Stream } from "effect"
import { Argument, Command } from "effect/cli"
import { fileURLToPath } from "node:url"

import { SkillsError, builtinInfo, fail, readBuiltin, selectBuiltin } from "@notion-skills-cli/core"
import type { BuiltinSkill } from "@notion-skills-cli/core"
import { defineCommand, exclusiveFlags, withConstraints } from "../../core/src/command-schema.ts"
import { builtins } from "./builtins.ts"
import { emit, singleton, switchFlag, withRuntime } from "./command-options.ts"
import { localRuntime } from "./command-runtime.ts"

const jsonFlag = switchFlag("json", "Emit structured package metadata and content as JSON")
const nameArgument = Argument.String("name").pipe(
  Argument.withDescription("Exact bundled Skill name from skills list, e.g. ntn-skills-maintain"),
)
const select = (name: string) =>
  Effect.try({
    try: () => selectBuiltin(builtins, name),
    catch: (error) => error as SkillsError,
  })
const raw = (content: string) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    yield* Stream.make(content).pipe(Stream.run(stdio.stdout()))
  })

const list = (json: boolean) =>
  Effect.gen(function* () {
    const skills = yield* Effect.forEach(builtins, builtinInfo)
    if (json) yield* emit({ source: "builtin", count: skills.length, skills })
    else
      yield* raw(skills.map((skill) => `${skill.name}\n  ${skill.description}`).join("\n\n") + "\n")
  })

const listCommand = defineCommand("list", { json: jsonFlag }, ({ json }) => list(json)).pipe(
  Command.withShortDescription("List the Skills bundled with this CLI version, offline"),
)

const getCommand = defineCommand(
  "get",
  {
    name: nameArgument.pipe(Argument.variadic()),
    all: switchFlag("all", "Get every bundled Skill; omit names"),
    full: switchFlag("full", "Include every bundled supporting file, with file headings"),
    path: singleton("path", "Read one relative file instead of SKILL.md; incompatible with --full"),
    json: jsonFlag,
  },
  (config) =>
    Effect.gen(function* () {
      // Resolve every name and file before writing, so an invalid selection never
      // leaves a successful-looking partial document on stdout.
      const skills = config.all
        ? builtins
        : yield* Effect.forEach([...new Set(config.name)], select)
      const results = yield* Effect.forEach(skills, (skill) =>
        Effect.gen(function* () {
          if (!config.full) return yield* readBuiltin(skill, Option.getOrUndefined(config.path))
          return {
            source: "builtin" as const,
            builtin: yield* builtinInfo(skill),
            files: skill.portable.files.map((file) => ({
              path: file.path,
              bytes: file.bytes.length,
              content: new TextDecoder().decode(file.bytes),
            })),
          }
        }),
      )
      if (config.json) {
        if (results.length === 1) yield* emit(results[0]!)
        else yield* emit({ source: "builtin", count: results.length, skills: results })
        return
      }
      const documents = results.map((result) => {
        if ("content" in result) return result.content
        return result.files.map((file) => `## ${file.path}\n\n${file.content}`).join("\n\n")
      })
      if (documents.length === 1) yield* raw(documents[0]!)
      else
        yield* raw(
          results
            .map((result, index) => `# ${result.builtin.name}\n\n${documents[index]}`)
            .join("\n\n"),
        )
    }),
).pipe(
  Command.withShortDescription(
    "Read bundled instructions as Markdown, without setup or installation",
  ),
  withConstraints([
    { kind: "exactly_one", flags: ["name", "all"] },
    exclusiveFlags(["full", "path"]),
  ]),
)

// These are the current source, standalone npm and embedded Broker layouts.
// A path is usable only when its files match this executable's embedded bytes.
// No cache, installed-copy registry or working-directory search is involved.
const layouts = [
  { root: new URL("../skills/", import.meta.url), nested: true },
  { root: new URL("./builtin-skills/", import.meta.url), nested: false },
  ...(import.meta.url.endsWith(".ts")
    ? [{ root: new URL("../../../skills/", import.meta.url), nested: true }]
    : []),
] as const
const relativeDirectory = (skill: BuiltinSkill, nested: boolean) =>
  nested && skill.portable.name !== "ntn-skills"
    ? `notion/${skill.portable.name}/`
    : `${skill.portable.name}/`

const packagePath = (selected: Option.Option<BuiltinSkill>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const skills = Option.isSome(selected) ? [selected.value] : builtins
    for (const layout of layouts) {
      const matches = yield* Effect.forEach(skills, (skill) =>
        Effect.forEach(skill.portable.files, (file) =>
          fs
            .readFile(
              fileURLToPath(
                new URL(relativeDirectory(skill, layout.nested) + file.path, layout.root),
              ),
            )
            .pipe(
              Effect.map(
                (bytes) =>
                  bytes.length === file.bytes.length &&
                  bytes.every((byte, index) => byte === file.bytes[index]),
              ),
              Effect.catch(() => Effect.succeed(false)),
            ),
        ).pipe(Effect.map((files) => files.every(Boolean))),
      )
      if (matches.every(Boolean))
        return yield* fs.realPath(
          fileURLToPath(
            Option.isSome(selected)
              ? new URL(relativeDirectory(selected.value, layout.nested), layout.root)
              : layout.root,
          ),
        )
    }
    return yield* Effect.fail(
      fail(
        "BUILTIN_PATH_UNAVAILABLE",
        "No packaged Skill directory matches this executable's content. Reinstall the complete CLI or host package.",
      ),
    )
  })

const pathCommand = defineCommand(
  "path",
  { name: nameArgument.pipe(Argument.optional), json: jsonFlag },
  (config) =>
    Effect.gen(function* () {
      const skill = Option.isSome(config.name)
        ? Option.some(yield* select(config.name.value))
        : Option.none<BuiltinSkill>()
      const path = yield* packagePath(skill)
      if (config.json)
        yield* emit({
          source: "builtin",
          path,
          ...(Option.isSome(skill) ? { builtin: yield* builtinInfo(skill.value) } : {}),
        })
      else yield* raw(path + "\n")
    }),
).pipe(Command.withShortDescription("Print the matching bundled Skill directory on this machine"))

export const skillsCommand = defineCommand("skills", { json: jsonFlag }, ({ json }) =>
  list(json),
).pipe(
  Command.withShortDescription("Discover and read the Skills shipped with this CLI version"),
  Command.withDescription(
    "Read the package's own instructions offline. With no subcommand, list the bundled Skills. Use skills get NAME for Markdown, --full for supporting files, and --json for structured output. Package upgrades update these Skills together with the CLI. No Notion connection, library, cache or separate Skill installation is required.",
  ),
  Command.withSubcommands([
    withRuntime(listCommand, localRuntime),
    withRuntime(getCommand, localRuntime),
    withRuntime(pathCommand, localRuntime),
  ]),
)
