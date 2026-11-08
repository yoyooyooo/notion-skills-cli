import { Effect, Option } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { defineCommand } from "../../core/src/command-schema.ts"
import { fail } from "../../core/src/model.ts"
import {
  prepareSharedBaselineInventory,
  scanLocalSkillInventory,
  reconcileSkillInventories,
  reviewInventoryReconciliation,
} from "../../core/src/shared-inventory.ts"
import { Store } from "../../core/src/store.ts"
import { emit, requiredSingleton, singleton } from "./command-options.ts"
import { inventoryImportCommands } from "./commands-library-inventory-import.ts"

const output = singleton(
  "output",
  "Optional complete JSON artifact; an existing different file is never overwritten",
)
function number(value: Option.Option<string>, name: string) {
  const raw = Option.getOrUndefined(value)
  if (raw === undefined) return undefined
  if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) <= 0)
    throw fail("INVALID_ARGUMENT", `${name} must be a positive safe integer.`)
  return Number(raw)
}
const deliver = (value: { readonly coverage: string }, destination: Option.Option<string>) =>
  Effect.gen(function* () {
    const path = Option.getOrUndefined(destination)
    if (path !== undefined)
      yield* (yield* Store).output(
        path,
        new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`),
      )
    yield* emit(value)
    process.exitCode = value.coverage === "full" ? 0 : 4
  })
const remote = defineCommand(
  "remote",
  {
    auditRun: requiredSingleton(
      "audit-run",
      "Exact retained formal audit run ID; content/history depth is needed for content equivalence",
    ),
    output,
  },
  (options) =>
    Effect.gen(function* () {
      yield* deliver(yield* prepareSharedBaselineInventory(options.auditRun), options.output)
    }),
).pipe(
  Command.withDescription(
    "Derive a readonly upstream-baseline review plan from one exact formal audit, entirely offline. Preserve all findings, native metadata/relations, File ownership, selected immutable Source/member/revision, byte comparisons and recovery identities. A partial census or unknown ownership cannot become an automatic candidate. Equal bytes do not release custom ownership. This does not reset, import, adopt or apply a plan.",
  ),
)
const local = defineCommand(
  "local",
  {
    roots: Flag.String("root").pipe(
      Flag.atLeast(1),
      Flag.withDescription(
        "Explicit absolute directory root; repeat for each canonical or logical host entry",
      ),
    ),
    targets: Flag.String("allow-target").pipe(
      Flag.atLeast(0),
      Flag.withDescription(
        "Explicit absolute real target root for symlinks; outside targets are only reported",
      ),
    ),
    provenance: Flag.String("provenance").pipe(
      Flag.atLeast(0),
      Flag.withDescription(
        "Exact readonly identity registry/config file; supports Agent Kit assets.yaml with upstreams/install-sources/notion-handoffs and versioned explicit identity manifests",
      ),
    ),
    entries: singleton("max-entries", "Maximum examined filesystem entries; default 50000"),
    bytes: singleton("max-bytes", "Maximum file and provenance bytes; default 268435456"),
    duration: singleton(
      "duration-ms",
      "Finite inventory deadline including Git metadata checks; default 120000",
    ),
    output,
  },
  (options) =>
    Effect.gen(function* () {
      const budgets = yield* Effect.try({
        try: () => ({
          entries: number(options.entries, "--max-entries"),
          bytes: number(options.bytes, "--max-bytes"),
          duration_ms: number(options.duration, "--duration-ms"),
        }),
        catch: () => fail("INVALID_ARGUMENT", "Inventory budgets must be positive safe integers."),
      })
      yield* deliver(
        yield* scanLocalSkillInventory({
          roots: options.roots,
          allow_targets: options.targets,
          provenance_files: options.provenance,
          budget: budgets,
        }),
        options.output,
      )
    }),
).pipe(
  Command.withDescription(
    "Inventory the complete local resource trees inside explicit roots and approved real symlink targets. Preserve logical aliases separately, deduplicate exact real entities, hash binary/CRLF bytes and executable modes, and retain broken/outside links, dirty state, unverified references and credential indicators without secret values. Git runs with optional locks and filesystem monitor disabled; Skill scripts are never executed. Scanned roots, links and files are never modified. Reports are bounded and partial scope exits 4. No Notion calls or uploads occur.",
  ),
)
const reconcile = defineCommand(
  "reconcile",
  {
    remote: requiredSingleton("remote", "Exact remote inventory observation ID"),
    local: requiredSingleton("local", "Exact local inventory observation ID"),
    output,
  },
  (options) =>
    Effect.gen(function* () {
      yield* deliver(
        yield* reconcileSkillInventories({
          remote_inventory_id: options.remote,
          local_inventory_id: options.local,
        }),
        options.output,
      )
    }),
).pipe(
  Command.withDescription(
    "Reconcile exact frozen inventories offline by stable page identity or complete Source/repository/member/fixed-commit provenance. Same names and hashes only produce review candidates. Local custom bytes and all remote anomalies remain visible. The review ID binds both semantic manifests and the exact library; this grants no mutation authority.",
  ),
)
const review = defineCommand(
  "review",
  {
    inventory: Argument.String("inventory-id"),
    remote: singleton("remote", "Optional newly observed remote inventory ID; requires --local"),
    local: singleton("local", "Optional newly observed local inventory ID; requires --remote"),
    output,
  },
  (options) =>
    Effect.gen(function* () {
      const remote = Option.getOrUndefined(options.remote),
        local = Option.getOrUndefined(options.local)
      if ((remote === undefined) !== (local === undefined))
        return yield* Effect.fail(
          fail("INVALID_ARGUMENT", "Supply both --remote and --local for drift checking."),
        )
      yield* deliver(
        yield* reviewInventoryReconciliation(
          options.inventory,
          remote === undefined || local === undefined
            ? undefined
            : { remote_inventory_id: remote, local_inventory_id: local },
        ),
        options.output,
      )
    }),
).pipe(
  Command.withDescription(
    "Review the exact retained reconciliation offline. Optional fresh observation IDs must have identical frozen semantic manifests and library; drift rejects the old review. Historical review does not make a fresh remote or filesystem health claim.",
  ),
)

export const libraryInventoryCommand = defineCommand("inventory").pipe(
  Command.withShortDescription(
    "Audit exact inventories, review identities and explicitly import complete approved Skills",
  ),
  Command.withSubcommands([remote, local, reconcile, review, ...inventoryImportCommands]),
)
