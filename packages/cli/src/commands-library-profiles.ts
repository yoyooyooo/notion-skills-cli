import { Effect, Option } from "effect"
import { Argument, Command } from "effect/cli"
import { databaseId } from "../../core/src/catalog.ts"
import { defineCommand } from "../../core/src/command-schema.ts"
import { fail } from "../../core/src/model.ts"
import {
  normalizeSharedFreshness,
  resolveSharedFreshness,
} from "../../core/src/shared-freshness-policy.ts"
import { effectiveCachePolicy } from "../../core/src/cache.ts"
import { loadSharedLibrary } from "../../core/src/shared-library.ts"
import { bindSharedProfile, unbindSharedProfile } from "../../core/src/shared-profile-config.ts"
import {
  listSharedProfiles,
  loadSharedProfile,
  saveSharedProfile,
} from "../../core/src/shared-profile.ts"
import { emit, requiredSingleton, singleton, switchFlag } from "./command-options.ts"

const entry = requiredSingleton(
  "entry",
  "Shared library Skills database ID, URL or exact registered alias",
)
const profile = Argument.String("profile-id").pipe(
  Argument.withDescription("Exact stable Profile ID; names are display labels"),
)
const library = (value: string) => databaseId(value).pipe(Effect.flatMap(loadSharedLibrary))

const list = defineCommand("list", { entry }, (options) =>
  Effect.gen(function* () {
    yield* emit(yield* listSharedProfiles(yield* library(options.entry)))
  }),
).pipe(
  Command.withDescription(
    "List all current library-owned Profiles with one paginated management-metadata query. No Skill bodies or provider data are read. Incomplete history and concurrent heads remain explicit errors.",
  ),
)

const show = defineCommand("show", { profile, entry }, (options) =>
  Effect.gen(function* () {
    yield* emit({
      profile: yield* loadSharedProfile(yield* library(options.entry), options.profile),
      metadata_only: true,
    })
  }),
).pipe(
  Command.withDescription(
    "Read one Profile's complete shared revision history and return its single current rule revision.",
  ),
)

const set = defineCommand(
  "set",
  {
    profile,
    entry,
    name: requiredSingleton("name", "Full display name for the new Profile revision"),
    enabled: requiredSingleton("enabled", "Required full rule value: true or false"),
    base: requiredSingleton(
      "base",
      "Exact current revision ID, or new for a Profile with no shared revision",
    ),
    defaultView: singleton(
      "default-view",
      "Default View ID or Notion URL; omitting this field removes the prior default",
    ),
    freshness: singleton(
      "freshness-json",
      "Full shared freshness rules: default durations and stable Skill-ID overrides; omitted removes prior rules",
    ),
    reconcile: switchFlag(
      "reconcile",
      "Only reconcile this original rule revision; never submit another POST",
    ),
  },
  (options) =>
    Effect.gen(function* () {
      if (options.enabled !== "true" && options.enabled !== "false")
        return yield* Effect.fail(
          fail("INVALID_ARGUMENT", "--enabled must be exactly true or false."),
        )
      if (options.base !== "new" && !/^profile-[a-f0-9]{64}$/u.test(options.base))
        return yield* Effect.fail(
          fail(
            "INVALID_ARGUMENT",
            "--base must be new or an exact Profile revision ID returned by show.",
          ),
        )
      const defaultView = Option.getOrUndefined(options.defaultView)
      const rawFreshness = Option.getOrUndefined(options.freshness)
      const freshness =
        rawFreshness === undefined
          ? undefined
          : yield* Effect.try({
              try: () => normalizeSharedFreshness(JSON.parse(rawFreshness)),
              catch: () =>
                fail(
                  "INVALID_ARGUMENT",
                  "--freshness-json must contain valid shared freshness rules with unique stable Skill IDs.",
                ),
            })
      yield* emit(
        yield* saveSharedProfile(yield* library(options.entry), {
          profile: {
            profile_id: options.profile,
            name: options.name,
            enabled: options.enabled === "true",
            ...(defaultView === undefined ? {} : { default_view_id: defaultView }),
            ...(freshness === undefined ? {} : { freshness }),
          },
          expectedRevision: options.base === "new" ? null : options.base,
          mode: options.reconcile ? "reconcile" : "create",
        }),
      )
    }),
).pipe(
  Command.withDescription(
    "Save a full immutable Profile rule revision. --name, --enabled and --base are required; omitted --default-view or --freshness-json removes those prior rules. Freshness JSON accepts {default:{read_max_age_ms,source_check_max_age_ms},skills:[{skill_id,read_max_age_ms,source_check_max_age_ms}]}; each duration is optional nonnegative integer milliseconds. Stable Skill IDs survive renames. Explicit read max-age wins, then Skill override, Profile default and product default. Source checking and Notion body observation are separate; long read TTL discloses a matching visibility delay and never extends the independent full-body deadline or authoring preflight. Use show to review the exact current revision before updating. The original plan is retained before at most one POST. Repeating an unresolved revision or using --reconcile only checks its original shared fact and never replays an uncertain write. Concurrent heads require explicit review; a View never grants access.",
  ),
  Command.withExamples([
    {
      command:
        "ntn-skills ctl library profile set daily --entry LIBRARY_ID --name Daily --enabled true --base new",
      description: "Create an enabled Profile using the library's first View",
    },
    {
      command:
        "ntn-skills ctl library profile set daily --entry LIBRARY_ID --name Daily --enabled true --base PROFILE_REVISION --default-view VIEW_ID",
      description: "Replace reviewed rules with an explicit default View",
    },
  ]),
)

const bind = defineCommand("bind", { profile, entry }, (options) =>
  Effect.gen(function* () {
    yield* emit(
      yield* bindSharedProfile({ libraryEntry: options.entry, profileId: options.profile }),
    )
  }),
).pipe(
  Command.withDescription(
    "Validate an enabled shared Profile and store only its library entry and Profile ID on this machine. The binding participates in list --default-view and the default capability directory. Bare list remains complete explicit discovery, and an explicit --view takes precedence. Profile rules and membership remain in Notion.",
  ),
)

const freshness = defineCommand(
  "freshness",
  {
    profile,
    entry,
    skill: singleton("skill", "Exact stable Skill ID; omit to inspect Profile defaults"),
  },
  (options) =>
    Effect.gen(function* () {
      const selected = yield* loadSharedProfile(yield* library(options.entry), options.profile)
      const product = yield* effectiveCachePolicy
      yield* emit({
        profile_id: selected.profile_id,
        profile_revision_id: selected.revision_id,
        effective: resolveSharedFreshness({
          skillId: Option.getOrUndefined(options.skill),
          policy: selected.freshness,
          productReadMaxAge: product.read_max_age_ms,
        }),
        shared_rules: selected.freshness ?? null,
        metadata_only: true,
      })
    }),
).pipe(
  Command.withDescription(
    "Resolve shared freshness inheritance for one stable Skill ID. This reads Profile rules only, never changes content or selected source versions. Update or clear overrides with profile set --freshness-json and the exact base revision.",
  ),
)

const unbind = defineCommand("unbind", {}, () =>
  Effect.gen(function* () {
    yield* emit(yield* unbindSharedProfile())
  }),
).pipe(
  Command.withDescription(
    "Remove only this machine's shared Profile selection. This does not change shared rules and makes no remote requests.",
  ),
)

export const libraryProfilesCommand = defineCommand("profile").pipe(
  Command.withDescription(
    "Manage durable shared Profile rules and an optional machine binding for default discovery. Profiles and Views are not access-control boundaries.",
  ),
  Command.withSubcommands([list, show, set, freshness, bind, unbind]),
)
