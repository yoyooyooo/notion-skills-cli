import { Effect, FileSystem, Option, Path } from "effect"
import { Argument, Command } from "effect/cli"
import { libraryId } from "../../core/src/catalog.ts"
import { defineCommand } from "../../core/src/command-schema.ts"
import { exportPortable } from "../../core/src/export.ts"
import { fail, SkillsError } from "../../core/src/model.ts"
import { validatePortableRelations } from "../../core/src/portable.ts"
import { withCurrentInvocationBudget } from "../../core/src/shared-current-invocation.ts"
import {
  bindCurrentImportOrigin,
  parseCurrentMemberBindings,
  planCurrentMembers,
} from "../../core/src/shared-current-member-discovery.ts"
import { queryCurrentSkillIdentity } from "../../core/src/shared-current-skill-target.ts"
import {
  inspectCurrentSkillWrite,
  prepareCurrentSkillWrite,
} from "../../core/src/shared-current-write.ts"
import { loadSharedLibrary } from "../../core/src/shared-library.ts"
import { emit, requiredSingleton, singleton } from "./command-options.ts"
import { loadCurrentImportInput } from "./commands-current-import.ts"

export function prepareCurrentMembersPlanInput(
  input: string,
  options: {
    readonly skillId: string
    readonly name?: string
    readonly description?: string
    readonly bindings?: string
    readonly output?: string
  },
) {
  return Effect.gen(function* () {
    const { loaded, admitted } = yield* loadCurrentImportInput(input, options)
    if (loaded.kind === "directory" && options.output !== undefined)
      yield* assertSeparateOutput(input, options.output)
    if (options.bindings === undefined) return { admitted, bindings: undefined }
    const raw = yield* (yield* FileSystem.FileSystem)
      .readFileString(options.bindings)
      .pipe(
        Effect.mapError(() =>
          fail("MEMBERS_BINDINGS_INVALID", "Cannot read the bindings JSON file."),
        ),
      )
    const bindings = yield* Effect.try({
      try: () => {
        if (new TextEncoder().encode(raw).byteLength > 2 * 1024 * 1024)
          throw fail("MEMBERS_BINDINGS_INVALID", "Bindings exceed 2 MiB.")
        return parseCurrentMemberBindings(JSON.parse(raw))
      },
      catch: (error) =>
        error instanceof SkillsError
          ? error
          : fail("MEMBERS_BINDINGS_INVALID", "Bindings must be valid version 1 JSON."),
    })
    return { admitted, bindings }
  })
}

function assertSeparateOutput(input: string, output: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const source = yield* fs.realPath(path.resolve(input))
    let parent = path.resolve(output)
    const missing: string[] = []
    while (!(yield* fs.exists(parent))) {
      missing.unshift(path.basename(parent))
      const next = path.dirname(parent)
      if (next === parent)
        return yield* Effect.fail(
          fail("MEMBERS_OUTPUT_INVALID", "Cannot resolve the output parent."),
        )
      parent = next
    }
    const destination = path.join(yield* fs.realPath(parent), ...missing)
    const relative = path.relative(source, destination)
    if (
      relative === "" ||
      (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep))
    )
      return yield* Effect.fail(
        fail(
          "MEMBERS_OUTPUT_INVALID",
          "The portable output must be outside the original input directory.",
        ),
      )
  }).pipe(
    Effect.mapError((error) =>
      error instanceof SkillsError
        ? error
        : fail("MEMBERS_OUTPUT_INVALID", "Cannot verify the separate portable output location."),
    ),
  )
}

export const currentMembersPlanCommand = defineCommand(
  "members-plan",
  {
    input: Argument.String("input"),
    library: requiredSingleton("library", "Exact current Library root page"),
    skillId: requiredSingleton("skill-id", "Exact stable identity of the intended import"),
    bindings: singleton(
      "bindings",
      "JSON with an explicit source-tree root and exact path-to-Skill reference bindings",
    ),
    output: singleton(
      "output",
      "Write a new portable directory or .zip outside the input directory, only when importable",
    ),
    name: singleton("name", "Override the imported name"),
    description: singleton("description", "Override the imported description"),
  },
  (options) =>
    Effect.gen(function* () {
      const input = yield* prepareCurrentMembersPlanInput(options.input, {
        skillId: options.skillId,
        name: Option.getOrUndefined(options.name),
        description: Option.getOrUndefined(options.description),
        bindings: Option.getOrUndefined(options.bindings),
        output: Option.getOrUndefined(options.output),
      })
      const invocation = yield* withCurrentInvocationBudget(
        Effect.gen(function* () {
          const library = yield* loadSharedLibrary(yield* libraryId(options.library))
          const bound = yield* Effect.try({
            try: () => {
              const bound = bindCurrentImportOrigin(library.library_id, input.admitted)
              const relations =
                input.admitted.relations === undefined
                  ? undefined
                  : validatePortableRelations({
                      ...input.admitted.relations,
                      library_id: library.library_id,
                    })
              return {
                ...bound,
                admitted: {
                  ...input.admitted,
                  files: bound.files,
                  ...(relations === undefined ? {} : { relations }),
                },
              }
            },
            catch: (error) =>
              error instanceof SkillsError
                ? error
                : fail("INVALID_ARCHIVE", "Cannot retain the portable reference context."),
          })
          const owner = yield* queryCurrentSkillIdentity(library, options.skillId)
          const planned = yield* planCurrentMembers(library, bound.admitted, {
            existing: owner !== undefined,
            ...(input.bindings === undefined ? {} : { bindings: input.bindings }),
          })
          const { portable, ...report } = planned
          if (!report.importable) return { ...report, rewrites: bound.rewrites, output: null }
          // The same complete admission and remote authority checks as import decide
          // whether an output may be handed to the existing writer.
          const plan = yield* prepareCurrentSkillWrite({
            ...bound.admitted,
            files: portable.files,
            ...(portable.relations === undefined ? {} : { relations: portable.relations }),
          })
          const inspected = yield* inspectCurrentSkillWrite(library, plan)
          const output = Option.getOrUndefined(options.output)
          return {
            ...report,
            rewrites: bound.rewrites,
            inspection: inspected,
            output: output === undefined ? null : yield* exportPortable(portable, { output }),
          }
        }),
      )
      yield* emit({ ...invocation.result, budget: invocation.budget })
    }),
).pipe(
  Command.withDescription(
    "Plan Members for one local directory, ZIP or Markdown import without changing Notion. Only actual links to unique same-library enabled ready Skills and exact files qualify. Plain names, inline/fenced/indented code, comments, images and template paths do not establish Members. Real hyperlinks in example prose remain hyperlinks; this does not infer narrative intent. At most 100 distinct candidate refs are checked, including rejected refs; extra candidates remain unresolved. Explicit Members, including [], win; an existing target preserves omitted Members; Requires is retained and never inferred. --bindings declares exact source-tree paths and current canonical references, without name lookup. Portable inputs copied across Libraries first qualify active short body refs with their declared origin; plain local inputs use the destination. Origin rewrites are reported without querying the external Library for Members. Verified cross-root Markdown destinations are canonicalized in an optional portable copy; the original input remains unchanged. Unresolved cross-root links make importable false and no output is written. Import the reviewed copy with ctl library import. Source acquisition and Source bytes are outside this command.",
  ),
)
