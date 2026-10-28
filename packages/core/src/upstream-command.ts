import { Effect, FileSystem, Option } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { fail, type SkillsError } from "./model.ts"
import { strictJson, SubscriptionInputSchema } from "./upstream-model.ts"
import {
  addSubscription,
  listSubscriptions,
  removeSubscription,
  updateSubscription,
} from "./upstream-subscription.ts"
import { applyUpstream } from "./upstream-apply.ts"
import { planUpstream } from "./upstream-plan.ts"
import { forkUpstream, trackUpstream } from "./upstream-conversion.ts"
import { checkUpstream, connectGitUpstream, runUpstreams, statusUpstream } from "./upstream.ts"
import {
  defineCommand,
  enforceConstraint,
  withConstraints,
  type CommandConstraint,
} from "./command-schema.ts"

const runConstraints: readonly CommandConstraint[] = [
  { kind: "exactly_one", flags: ["target", "all"] },
]

const InputSchema = SubscriptionInputSchema
const inputDescription =
  "Path to strict JSON with all required fields: target_database_id, name, description (strings), default_context, enabled (booleans), source (object), roots, include, exclude (string arrays), mapping (string-to-string object). source.provider is git {type,url,ref}, registry {type,base_url,owner,slug,version?}, or github-market {type,url,ref?}. Optional source fields: patch {version:1,files:[{path,replacements:[{from,to}]}]}, shared_target_set, publisher_subscription_id, accepted_ref, strip_prefix, target_prefix, target_mode (strings), require_all_included (boolean). Unknown fields are rejected. Update replaces the complete configuration; no fields are partial."
/** Official sync upstream subtree; the caller owns formatting, runtime layers and parent registration. */
export function upstreamCommand<E, R>(emit: (value: unknown) => Effect.Effect<void, E, R>) {
  const target = Argument.String("subscription-id").pipe(
    Argument.withDescription(
      "Exact subscription page UUID; display names are never mutation identity",
    ),
  )
  const member = Argument.String("member-key").pipe(
    Argument.withDescription("Exact stable source member path from status/check"),
  )
  const one = (name: string) =>
    Flag.String(name).pipe(
      Flag.between(1, 1),
      Flag.map((values) => values[0]!),
    )
  const optional = (name: string, description: string) =>
    Flag.String(name).pipe(
      Flag.atMost(1),
      Flag.map((values) => Option.fromUndefinedOr(values[0])),
      Flag.withDescription(description),
    )
  const emitRunResult = <T extends { readonly verified: boolean }>(
    result: T,
  ): Effect.Effect<void, E | SkillsError, R> =>
    result.verified
      ? emit(result)
      : Effect.fail(
          fail(
            "UPSTREAM_SYNC_INCOMPLETE",
            "Some subscriptions did not complete synchronization.",
            result,
          ),
        )
  const input = (file: string) =>
    Effect.gen(function* () {
      const bytes = yield* (yield* FileSystem.FileSystem)
        .readFileString(file)
        .pipe(
          Effect.mapError(() =>
            fail("UPSTREAM_INPUT_UNREADABLE", "Subscription input JSON could not be read."),
          ),
        )
      return yield* Effect.try({
        try: () => strictJson(InputSchema, bytes),
        catch: () =>
          fail("INVALID_UPSTREAM", "Input must be strict subscription configuration JSON."),
      })
    })
  return defineCommand("upstream").pipe(
    Command.withDescription(
      "Connect a source to Notion, then use run for recurring synchronization. Status reads local observations; check observes current remote metadata. Advanced plan/apply freezes an exact candidate. No scheduler is installed.",
    ),
    Command.withSubcommands([
      defineCommand(
        "connect",
        {
          source: Argument.String("source").pipe(
            Argument.withDescription(
              "Git repository URL, GitHub tree URL or local Git repository path",
            ),
          ),
          database: optional(
            "database",
            "Target content database ID, URL or registered alias; otherwise use the configured creation default",
          ),
          name: optional(
            "name",
            "Subscription display name and member namespace; defaults from the source",
          ),
          description: optional(
            "description",
            "Description of this subscription; defaults from the source",
          ),
          ref: optional("ref", "Git ref to track; defaults to HEAD or the GitHub tree URL ref"),
          root: Flag.String("root").pipe(
            Flag.atLeast(0),
            Flag.withDescription("Source root directory; repeat for multiple roots, default ."),
          ),
          include: Flag.String("include").pipe(
            Flag.atLeast(0),
            Flag.withDescription(
              "Include member directory paths or globs, for example skills/**; repeat to select more",
            ),
          ),
          exclude: Flag.String("exclude").pipe(
            Flag.atLeast(0),
            Flag.withDescription("Exclude member directory paths or globs; repeat to exclude more"),
          ),
          operation: optional(
            "operation",
            "Original subscription creation operation ID; normally derived from the connection",
          ),
        },
        (config) =>
          connectGitUpstream(config.source, {
            database: Option.getOrUndefined(config.database),
            name: Option.getOrUndefined(config.name),
            description: Option.getOrUndefined(config.description),
            ref: Option.getOrUndefined(config.ref),
            roots: config.root.length ? config.root : undefined,
            include: config.include.length ? config.include : undefined,
            exclude: config.exclude.length ? config.exclude : undefined,
            operationId: Option.getOrUndefined(config.operation),
          }).pipe(Effect.flatMap(emitRunResult)),
      ).pipe(
        Command.withShortDescription("Connect a Git source to Notion and synchronize its Skills"),
        Command.withDescription(
          "Create or reuse the same source/target selection, then run synchronization. Git HEAD and root . are the defaults; discovery selects member directories containing SKILL.md. Include/exclude patterns match those member directory paths. Repeating a matching connection reuses its subscription without changing the saved configuration. Partial or failed synchronization exits nonzero with the subscription and retained run results.",
        ),
      ),
      defineCommand("list", {}, () => listSubscriptions.pipe(Effect.flatMap(emit))).pipe(
        Command.withShortDescription("List native subscription records"),
      ),
      defineCommand(
        "add",
        {
          input: one("input").pipe(Flag.withDescription(inputDescription)),
          operation: one("operation"),
        },
        ({ input: file, operation }) =>
          input(file).pipe(
            Effect.flatMap((config) => addSubscription(config, operation)),
            Effect.flatMap(emit),
          ),
      ).pipe(
        Command.withShortDescription(
          "Create once using a durable operation ID and strict JSON input",
        ),
      ),
      defineCommand(
        "update",
        {
          target,
          input: one("input").pipe(Flag.withDescription(inputDescription)),
          version: one("if-version"),
        },
        ({ target, input: file, version }) =>
          input(file).pipe(
            Effect.flatMap((config) => updateSubscription(target, version, config)),
            Effect.flatMap(emit),
          ),
      ).pipe(
        Command.withShortDescription(
          "Replace source configuration at the observed version; publication map is preserved",
        ),
      ),
      defineCommand("remove", { target, version: one("if-version") }, ({ target, version }) =>
        removeSubscription(target, version).pipe(Effect.flatMap(emit)),
      ).pipe(
        Command.withShortDescription(
          "Remove the automatic entry and stop updates while retaining member pages",
        ),
      ),
      defineCommand("status", { target }, ({ target }) =>
        statusUpstream(target).pipe(Effect.flatMap(emit)),
      ).pipe(
        Command.withShortDescription(
          "Show scoped local upstream observations without network access",
        ),
        Command.withDescription(
          "Read saved local evidence offline. Router availability is explicit and may be unknown; aggregate state does not prove the current published Router or its member pages. Use check for a live metadata observation.",
        ),
      ),
      defineCommand("check", { target }, ({ target }) =>
        checkUpstream(target).pipe(Effect.flatMap(emit)),
      ).pipe(
        Command.withShortDescription(
          "Observe current subscription and publication metadata online",
        ),
        Command.withDescription(
          "Observe current subscription/member metadata and publication markers without reading member bodies or writing remotely, then save the observation locally. Report explicit Router availability, coverage and failed_sources. Revision evidence comes from published or accepted refs; incomplete observations do not prove all member pages are current.",
        ),
      ),
      defineCommand("plan", { target }, ({ target }) =>
        planUpstream(target).pipe(Effect.flatMap(emit)),
      ).pipe(
        Command.withShortDescription(
          "Save exact revision, full files, deltas and page/version/hash preconditions",
        ),
      ),
      defineCommand(
        "apply",
        {
          plan: Argument.String("plan-id"),
          member: Flag.String("member").pipe(
            Flag.atLeast(0),
            Flag.withDescription(
              "Execute only these exact frozen member keys; repeat for multiple members",
            ),
          ),
        },
        ({ plan, member }) =>
          applyUpstream(plan, member.length ? member : undefined).pipe(Effect.flatMap(emit)),
      ).pipe(
        Command.withShortDescription("Execute or reconcile the exact saved plan; never replace it"),
        Command.withDescription(
          "Optional repeated --member flags select original plan items without changing their indices, operation identities, bytes or outcomes. Unselected items remain unchanged. Repeat the selection on each apply; unqualified operation resume has no member selection. Partial selection does not advance the source accepted revision until the whole original plan is verified.",
        ),
      ),
      defineCommand(
        "run",
        {
          target: Flag.String("target").pipe(Flag.atLeast(0)),
          all: Flag.Boolean("all").pipe(
            Flag.atMost(1),
            Flag.map((values) => values[0] ?? false),
          ),
        },
        ({ target: targets, all }) => {
          if (
            !runConstraints.every((constraint) =>
              enforceConstraint(constraint, { target: targets, all }),
            )
          )
            return Effect.fail(
              fail("INVALID_ARGUMENT", "Provide --target UUID or --all, exclusively.", {
                constraints: runConstraints,
              }),
            )
          const selected = targets.length ? targets : undefined
          return runUpstreams({ ...(selected ? { targets: selected } : {}), all }).pipe(
            Effect.flatMap(emitRunResult),
          )
        },
      ).pipe(
        Command.withShortDescription(
          "Synchronize selected subscriptions and record their latest workflow result",
        ),
        Command.withDescription(
          "Requires --target UUID or --all. Continues retained operations under their original guards before planning; restores a mapped member only when its exact owned page is confirmed in Notion Trash. Unknown or inaccessible results remain failures. Records Sync Status, Last Sync Attempt, Last Synced and Sync Summary on each upstream subscription. Unchanged successful runs refresh Last Synced; failed/partial runs preserve it. Continues other subscriptions and exits nonzero when any selected subscription is incomplete. Overlapping runs of the same subscription in one local state are rejected.",
        ),
        withConstraints(runConstraints),
      ),
      defineCommand("fork", { target, member }, ({ target, member }) =>
        forkUpstream(target, member).pipe(Effect.flatMap(emit)),
      ).pipe(
        Command.withShortDescription(
          "Preserve a remotely recoverable accepted baseline and explicitly enter fork mode",
        ),
      ),
      defineCommand("track", { target, member }, ({ target, member }) =>
        trackUpstream(target, member).pipe(Effect.flatMap(emit)),
      ).pipe(
        Command.withShortDescription(
          "Return unresolved content differences; track only when already resolved",
        ),
      ),
    ]),
  )
}
