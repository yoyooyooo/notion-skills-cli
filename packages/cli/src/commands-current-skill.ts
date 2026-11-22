import { Effect, Option } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { databaseId } from "../../core/src/catalog.ts"
import { defineCommand } from "../../core/src/command-schema.ts"
import { loadSkillUpdateFile } from "../../core/src/import.ts"
import {
  fail,
  SkillsError,
  validateDescription,
  validateDisplayName,
} from "../../core/src/model.ts"
import { withCurrentInvocationBudget } from "../../core/src/shared-current-invocation.ts"
import { registerCurrentNotionSkill } from "../../core/src/shared-current-skill-register.ts"
import { removeCurrentNotionSkill } from "../../core/src/shared-current-skill-remove.ts"
import {
  createCurrentNotionSkill,
  resolveCurrentSkillRelations,
  updateCurrentNotionSkill,
} from "../../core/src/shared-current-skill.ts"
import { checkedSkillManagement as checked } from "../../core/src/shared-current-skill-target.ts"
import { loadSharedLibrary } from "../../core/src/shared-library.ts"
import type { SharedLibrary } from "../../core/src/shared-library-model.ts"
import { emit, requiredSingleton, singleton, switchFlag } from "./command-options.ts"
import { prepareCurrentImport } from "./commands-current-import.ts"

const budgetFlag = (name: string, description: string) =>
  Flag.Int(name).pipe(
    Flag.atMost(1),
    Flag.map((values) => Option.fromUndefinedOr(values[0])),
    Flag.withDescription(description),
  )
const common = () => ({
  entry: requiredSingleton("entry", "Current Skills database ID, URL or exact registered alias"),
  dryRun: switchFlag(
    "dry-run",
    "Read the complete selected scope and report the plan without writing",
  ),
  maxRequests: budgetFlag(
    "max-requests",
    "Positive maximum HTTP attempts for this invocation; default 1000",
  ),
  maxBytes: budgetFlag("max-bytes", "Positive maximum total HTTP payload bytes; default 536870912"),
  timeout: budgetFlag("timeout", "Positive invocation deadline in ms; default 600000"),
})
const metadata = () => ({
  name: singleton("name", "Set the Skill display name"),
  description: singleton("description", "Set the short author description"),
  enabled: singleton(
    "enabled",
    "Set daily availability: true or false; omission preserves on update",
  ),
  defaultContext: singleton(
    "default-context",
    "Set default context: true or false; omission preserves on update",
  ),
})
const relations = () => ({
  members: Flag.String("members").pipe(
    Flag.atLeast(0),
    Flag.withDescription(
      "Exact member Skill page or stable ID; repeat to replace the set, use one empty value to clear",
    ),
  ),
  requires: Flag.String("requires").pipe(
    Flag.atLeast(0),
    Flag.withDescription(
      "Exact required Skill page or stable ID; repeat to replace the set, use one empty value to clear",
    ),
  ),
})
type Common = {
  readonly entry: string
  readonly dryRun: boolean
  readonly maxRequests: Option.Option<number>
  readonly maxBytes: Option.Option<number>
  readonly timeout: Option.Option<number>
}
type Metadata = {
  readonly name: Option.Option<string>
  readonly description: Option.Option<string>
  readonly enabled: Option.Option<string>
  readonly defaultContext: Option.Option<string>
}
function authorMetadata(options: Metadata) {
  const boolean = (value: Option.Option<string>, flag: string) => {
    const supplied = Option.getOrUndefined(value)
    if (supplied === undefined) return undefined
    if (supplied !== "true" && supplied !== "false")
      throw fail("INVALID_ARGUMENT", flag + " accepts true or false.")
    return supplied === "true"
  }
  const name = Option.getOrUndefined(options.name),
    description = Option.getOrUndefined(options.description)
  const enabled = boolean(options.enabled, "--enabled"),
    defaultContext = boolean(options.defaultContext, "--default-context")
  if (name !== undefined) validateDisplayName(name)
  if (description !== undefined) validateDescription(description)
  return {
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(enabled === undefined ? {} : { enabled }),
    ...(defaultContext === undefined ? {} : { default_context: defaultContext }),
  }
}
function manage<A extends object, R>(
  options: Common,
  run: (library: SharedLibrary) => Effect.Effect<A, SkillsError, R>,
) {
  return Effect.gen(function* () {
    const limits = yield* checked(() => {
      if (
        /^notion_page:/iu.test(options.entry) ||
        (/^[a-z][a-z\d+.-]*:\/\//iu.test(options.entry) && !/^https?:\/\//iu.test(options.entry))
      )
        throw fail(
          "INVALID_ARGUMENT",
          "Skill management requires a database ID, HTTP(S) Notion URL or exact registered alias.",
        )
      const limits = {
        requests: Option.getOrUndefined(options.maxRequests),
        bytes: Option.getOrUndefined(options.maxBytes),
        duration_ms: Option.getOrUndefined(options.timeout),
      }
      for (const [budget, value] of Object.entries(limits))
        if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
          throw fail("INVALID_ARGUMENT", "Invocation budgets must be positive safe integers.", {
            budget,
          })
      return limits
    })
    const invocation = yield* withCurrentInvocationBudget(
      Effect.gen(function* () {
        const library = yield* loadSharedLibrary(yield* databaseId(options.entry))
        return yield* run(library)
      }),
      limits,
    )
    yield* emit({ ...invocation.result, budget: invocation.budget })
  })
}
function selectedRelations(
  library: SharedLibrary,
  input: { readonly members: readonly string[]; readonly requires: readonly string[] },
) {
  return resolveCurrentSkillRelations(library, {
    ...(input.members.length ? { members: input.members } : {}),
    ...(input.requires.length ? { requires: input.requires } : {}),
  })
}

const create = defineCommand(
  "create",
  {
    input: Argument.String("input").pipe(
      Argument.withDescription(
        "One Markdown file, Skill directory or current portable ZIP at a physical path; resolve temporary parent aliases with pwd -P before writing input",
      ),
    ),
    skillId: requiredSingleton(
      "skill-id",
      "New exact stable Skill ID; existing different content is never replaced",
    ),
    ...common(),
    ...metadata(),
    ...relations(),
  },
  (options) =>
    Effect.gen(function* () {
      const selected = yield* checked(() => authorMetadata(options))
      const prepared = yield* prepareCurrentImport(options.input, {
        skillId: options.skillId,
        name: selected.name,
        description: selected.description,
        nativeMarkdown: true,
      })
      yield* manage(options, (library) =>
        Effect.gen(function* () {
          const links = yield* selectedRelations(library, options)
          return {
            ...(yield* createCurrentNotionSkill(library, {
              plan: prepared.plan,
              dry_run: options.dryRun,
              metadata: {
                ...(selected.enabled === undefined ? {} : { enabled: selected.enabled }),
                ...(selected.default_context === undefined
                  ? {}
                  : { default_context: selected.default_context }),
                ...(links === undefined ? {} : { relations: links }),
              },
            })),
            input: prepared.input,
          }
        }),
      )
    }),
).pipe(
  Command.withDescription(
    "Create one Notion-owned Skill. Markdown files become editable native bodies; other files become exact resources. The CLI supplies required fields and ownership, verifies complete current content, and closes its operation. Native Markdown can correct a precisely verified automatic link on original plain text within that same intent before final readback. A complete equal repeat writes nothing; existing different content requires update. Repeat the same command after interruption to reconcile its own unfinished intent.",
  ),
)

const update = defineCommand(
  "update",
  {
    target: Argument.String("target").pipe(
      Argument.withDescription("Exact Skill page ID/URL or stable Skill ID"),
    ),
    input: singleton("input", "Local file replacing the main body, or the exact --path selection"),
    path: singleton(
      "path",
      "Exact Skill-relative path for --input; omission selects the kind's main file",
    ),
    file: Flag.String("file").pipe(
      Flag.atLeast(0),
      Flag.withDescription(
        "Selected Skill-relative PATH=LOCAL file; repeat for several replacements or additions",
      ),
    ),
    removeFile: Flag.String("remove-file").pipe(
      Flag.atLeast(0),
      Flag.withDescription(
        "Exact supporting path to remove; repeat. The main file cannot be removed",
      ),
    ),
    ...common(),
    ...metadata(),
    ...relations(),
  },
  (options) =>
    Effect.gen(function* () {
      const selected = yield* checked(() => authorMetadata(options))
      const local = Option.getOrUndefined(options.input),
        selectedPath = Option.getOrUndefined(options.path)
      const entries = yield* checked(() => {
        if (selectedPath !== undefined && local === undefined)
          throw fail("INVALID_ARGUMENT", "--path requires --input.")
        return options.file.map((value) => {
          const at = value.indexOf("=")
          if (at < 1 || at === value.length - 1)
            throw fail("INVALID_ARGUMENT", "--file requires PATH=LOCAL.")
          return { path: value.slice(0, at), local: value.slice(at + 1) }
        })
      })
      const files = yield* Effect.forEach(entries, (entry) =>
        loadSkillUpdateFile(entry.local).pipe(
          Effect.map((file) => ({
            ...file,
            path: entry.path,
            authority: {
              kind: /\.(md|markdown)$/iu.test(entry.path)
                ? ("native" as const)
                : ("resource" as const),
            },
          })),
        ),
      )
      const main = local === undefined ? undefined : yield* loadSkillUpdateFile(local)
      if (main !== undefined && selectedPath !== undefined)
        files.push({
          ...main,
          path: selectedPath,
          authority: { kind: /\.(md|markdown)$/iu.test(selectedPath) ? "native" : "resource" },
        })
      yield* manage(options, (library) =>
        Effect.gen(function* () {
          const links = yield* selectedRelations(library, options)
          return yield* updateCurrentNotionSkill(library, {
            target: options.target,
            files,
            remove: options.removeFile,
            dry_run: options.dryRun,
            ...(main !== undefined && selectedPath === undefined ? { main } : {}),
            metadata: { ...selected, ...(links === undefined ? {} : { relations: links }) },
          })
        }),
      )
    }),
).pipe(
  Command.withDescription(
    "Update only explicitly selected current bodies, files, metadata or relations. Unselected files retain their latest Notion content and identities. Markdown selections are native; other selections are resources. Native Markdown uses the same verified plain-text correction and complete readback as create. Missing flags preserve current values. The CLI validates the complete resulting directory and references, verifies changes and removes unreachable owned resources. Repeat the same command to resume its matching unfinished update; a different pending intent is never overwritten.",
  ),
)

const register = defineCommand(
  "register",
  {
    target: Argument.String("page").pipe(
      Argument.withDescription("Exact existing page ID/URL in this registered Skills table"),
    ),
    skillId: singleton(
      "skill-id",
      "Set a missing stable Skill ID; existing identities are preserved",
    ),
    ...common(),
    ...metadata(),
  },
  (options) =>
    Effect.gen(function* () {
      const selected = yield* checked(() => authorMetadata(options))
      yield* manage(options, (library) =>
        registerCurrentNotionSkill(library, {
          target: options.target,
          ...selected,
          skill_id: Option.getOrUndefined(options.skillId),
          dry_run: options.dryRun,
        }),
      )
    }),
).pipe(
  Command.withDescription(
    "Register an existing native Notion Skill in place. Supply missing name or description explicitly; the CLI supplies missing identities, native descriptors and ready state. Supporting rows need explicit canonical Path and this single Skill owner. Existing bodies and valid native metadata stay in place. Source or resource authority is not converted. Complete current content and relationships are checked before ready; repeated valid registration writes nothing.",
  ),
)

const remove = defineCommand(
  "remove",
  {
    target: Argument.String("target").pipe(
      Argument.withDescription("Exact Skill page ID/URL or stable Skill ID"),
    ),
    ...common(),
  },
  (options) =>
    manage(options, (library) =>
      removeCurrentNotionSkill(library, {
        target: options.target,
        dry_run: options.dryRun,
      }),
    ),
).pipe(
  Command.withDescription(
    "Remove one Notion-owned Skill together with its supporting Files, owned resources and inbound Members/Requires references. The complete affected scope is checked before mutation; the main page enters Trash last. Repeat the exact command to continue its unfinished removal. A Source contribution or Source-backed file requires Source management. An already trashed page is reported without claiming that a prior external deletion cleaned its children.",
  ),
)

export const currentSkillCommand = defineCommand("skill").pipe(
  Command.withDescription(
    "Create, update, register or remove a Notion-owned Skill. Required fields, bindings, verification and finite-operation cleanup belong to the CLI.",
  ),
  Command.withSubcommands([create, update, register, remove]),
)
