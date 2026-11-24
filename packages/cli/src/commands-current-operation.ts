import { Effect, Option } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { libraryId } from "../../core/src/catalog.ts"
import { defineCommand, withConstraints } from "../../core/src/command-schema.ts"
import { fail, SkillsError } from "../../core/src/model.ts"
import { Notion } from "../../core/src/notion.ts"
import { withCurrentInvocationBudget } from "../../core/src/shared-current-invocation.ts"
import {
  inspectCurrentOperation,
  type CurrentOperationOwner,
} from "../../core/src/shared-current-operation.ts"
import { validateCurrentSourceId } from "../../core/src/shared-current-source.ts"
import { currentWriteIdentity } from "../../core/src/shared-current-write-input.ts"
import { loadSharedLibrary } from "../../core/src/shared-library.ts"
import { emit, requiredSingleton } from "./command-options.ts"

const budgetFlag = (name: string, description: string) =>
  Flag.Int(name).pipe(
    Flag.atMost(1),
    Flag.map((values) => Option.fromUndefinedOr(values[0])),
    Flag.withDescription(description),
  )

/** Read the current finite intent through its real Store and remote Record boundary. */
export function inspectCurrentLibraryOperation(input: {
  readonly ownerId: string
  readonly kind: string
  readonly library: string
  readonly maxRequests?: number
  readonly maxBytes?: number
  readonly timeout?: number
}) {
  return Effect.gen(function* () {
    const selected = yield* Effect.try({
      try: () => {
        if (
          /^notion_page:/iu.test(input.library) ||
          (/^[a-z][a-z\d+.-]*:\/\//iu.test(input.library) && !/^https?:\/\//iu.test(input.library))
        )
          throw fail("INVALID_ARGUMENT", "Operation inspection requires a current library entry.")
        let owner: CurrentOperationOwner
        if (input.kind === "source") {
          validateCurrentSourceId(input.ownerId)
          owner = { kind: "source", id: input.ownerId }
        } else if (input.kind === "skill") {
          currentWriteIdentity(input.ownerId, "Skill ID")
          owner = { kind: "skill", id: input.ownerId }
        } else throw fail("INVALID_ARGUMENT", "--kind must be skill or source.")
        const limits = {
          requests: input.maxRequests,
          bytes: input.maxBytes,
          duration_ms: input.timeout,
        }
        for (const [name, value] of Object.entries(limits))
          if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
            throw fail(
              "INVALID_ARGUMENT",
              "Invocation budgets must be positive safe integers; --timeout uses ms.",
              { budget: name },
            )
        return { owner, limits }
      },
      catch: (error) =>
        error instanceof SkillsError
          ? error
          : fail("INVALID_ARGUMENT", "Use one exact current operation owner and library."),
    })
    const invocation = yield* withCurrentInvocationBudget(
      Effect.gen(function* () {
        const library = yield* loadSharedLibrary(yield* libraryId(input.library))
        const operation = yield* inspectCurrentOperation(library, selected.owner)
        return {
          version: 1 as const,
          contract: "current" as const,
          library: {
            library_id: library.library_id,
            database_id: library.skills.database_id,
            data_source_id: library.skills.data_source_id,
          },
          owner: selected.owner,
          status: operation === undefined ? ("not_found" as const) : ("observed" as const),
          operation: operation ?? null,
          request_metrics: (yield* Notion).requestMetrics?.(),
        }
      }),
      selected.limits,
    )
    return { ...invocation.result, budget: invocation.budget }
  })
}

export const currentOperationCommand = defineCommand(
  "operation",
  {
    ownerId: Argument.String("owner-id").pipe(
      Argument.withDescription("Exact stable Skill or Source ID"),
    ),
    kind: requiredSingleton("kind", "Current owner kind: skill or source"),
    library: requiredSingleton("library", "Current Skills database ID, URL or exact registered alias"),
    maxRequests: budgetFlag(
      "max-requests",
      "Positive maximum HTTP attempts including library lookup; default 1000",
    ),
    maxBytes: budgetFlag("max-bytes", "Positive maximum HTTP payload bytes; default 536870912"),
    timeout: budgetFlag("timeout", "Positive invocation deadline in ms; default 600000"),
  },
  (options) =>
    Effect.gen(function* () {
      yield* emit(
        yield* inspectCurrentLibraryOperation({
          ownerId: options.ownerId,
          kind: options.kind,
          library: options.library,
          maxRequests: Option.getOrUndefined(options.maxRequests),
          maxBytes: Option.getOrUndefined(options.maxBytes),
          timeout: Option.getOrUndefined(options.timeout),
        }),
      )
    }),
).pipe(
  withConstraints([{ kind: "allowed_values", flag: "kind", values: ["skill", "source"] }]),
  Command.withDescription(
    "Inspect one current finite operation without semantic writes, replay or repair. Returns exact observed Record, owner, local lifecycle, in-flight request, Source cursor and predecessor coordinates. No observable intent returns status not_found with operation:null; it does not prove that the owner exists, is ready or was retired. Preserve the original input, state Store and credential scope before resuming or explicitly superseding its owning command.",
  ),
  Command.withExamples([
    {
      command: "ntn-skills ctl library operation SKILL_ID --kind skill --library ENTRY",
      description: "Inspect the current complete-import intent",
    },
    {
      command: "ntn-skills ctl library operation SOURCE_ID --kind source --library ENTRY",
      description: "Inspect the finite parent Source intent",
    },
  ]),
)
