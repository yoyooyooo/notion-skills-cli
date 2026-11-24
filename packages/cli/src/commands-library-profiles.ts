import { Effect, Option } from "effect"
import { Argument, Command } from "effect/cli"
import { libraryId } from "../../core/src/catalog.ts"
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

const libraryFlag = requiredSingleton(
  "library",
  "Shared library Skills database ID, URL or exact registered alias",
)
const profile = Argument.String("profile-id").pipe(
  Argument.withDescription("Exact stable Profile ID; names are display labels"),
)
const library = (value: string) => libraryId(value).pipe(Effect.flatMap(loadSharedLibrary))

const list = defineCommand("list", { library: libraryFlag }, (options) =>
  Effect.gen(function* () {
    yield* emit(yield* listSharedProfiles(yield* library(options.library)))
  }),
).pipe(
  Command.withDescription(
    "List all current library-owned Profiles with one paginated management-metadata query. No Skill bodies or provider data are read. Duplicate current rows and incomplete queries remain explicit errors.",
  ),
)

const show = defineCommand("show", { profile, library: libraryFlag }, (options) =>
  Effect.gen(function* () {
    yield* emit({
      profile: yield* loadSharedProfile(yield* library(options.library), options.profile),
      metadata_only: true,
    })
  }),
).pipe(
  Command.withDescription(
    "Read one Profile's unique current rules and conflict-detection fingerprint.",
  ),
)

const set = defineCommand(
  "set",
  {
    profile,
    library: libraryFlag,
    name: requiredSingleton("name", "Full display name for the current Profile"),
    enabled: requiredSingleton("enabled", "Required full rule value: true or false"),
    expected: requiredSingleton(
      "expect",
      "Exact current fingerprint, or new for a Profile with no current record",
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
      "Only compare current rules with this intent; never repeat POST or PATCH",
    ),
  },
  (options) =>
    Effect.gen(function* () {
      if (options.enabled !== "true" && options.enabled !== "false")
        return yield* Effect.fail(
          fail("INVALID_ARGUMENT", "--enabled must be exactly true or false."),
        )
      if (options.expected !== "new" && !/^[a-f0-9]{64}$/u.test(options.expected))
        return yield* Effect.fail(
          fail(
            "INVALID_ARGUMENT",
            "--expect must be new or the exact current fingerprint returned by show.",
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
        yield* saveSharedProfile(yield* library(options.library), {
          profile: {
            profile_id: options.profile,
            name: options.name,
            enabled: options.enabled === "true",
            ...(defaultView === undefined ? {} : { default_view_id: defaultView }),
            ...(freshness === undefined ? {} : { freshness }),
          },
          expectedFingerprint: options.expected === "new" ? null : options.expected,
          mode: options.reconcile ? "reconcile" : "apply",
        }),
      )
    }),
).pipe(
  Command.withDescription(
    "Save complete current Profile rules on one stable Record page. --name, --enabled and --expect are required; omitted --default-view or --freshness-json removes those prior rules. Freshness JSON accepts {default:{read_max_age_ms,source_check_max_age_ms},skills:[{skill_id,read_max_age_ms,source_check_max_age_ms}]}; each duration is optional nonnegative integer milliseconds. Stable Skill IDs survive renames. Explicit read max-age wins, then Skill override, Profile default and product default. Long read TTL discloses its visibility delay and never extends independent full-body or eligibility deadlines. Review the current fingerprint with show before replacing rules. Unchanged rules perform no write. An unresolved intent remains local; --reconcile checks current content without repeating POST or PATCH. The fingerprint detects observed conflicts, not distributed CAS. Profiles and Views do not grant access.",
  ),
  Command.withExamples([
    {
      command:
        "ntn-skills ctl library profile set daily --library LIBRARY_ID --name Daily --enabled true --expect new",
      description: "Create an enabled Profile using the library's first View",
    },
    {
      command:
        "ntn-skills ctl library profile set daily --library LIBRARY_ID --name Daily --enabled true --expect CURRENT_FINGERPRINT --default-view VIEW_ID",
      description: "Replace reviewed rules with an explicit default View",
    },
  ]),
)

const bind = defineCommand("bind", { profile, library: libraryFlag }, (options) =>
  Effect.gen(function* () {
    yield* emit(
      yield* bindSharedProfile({ library: options.library, profileId: options.profile }),
    )
  }),
).pipe(
  Command.withDescription(
    "Validate an enabled shared Profile and store only its Library root and Profile ID on this machine. The binding participates in list --default-view and the default capability directory. Bare list lists the complete selected Library, and an explicit --view takes precedence. Profile rules and membership remain in Notion.",
  ),
)

const freshness = defineCommand(
  "freshness",
  {
    profile,
    library: libraryFlag,
    skill: singleton("skill", "Exact stable Skill ID; omit to inspect Profile defaults"),
  },
  (options) =>
    Effect.gen(function* () {
      const selected = yield* loadSharedProfile(yield* library(options.library), options.profile)
      const product = yield* effectiveCachePolicy
      yield* emit({
        profile_id: selected.profile_id,
        profile_fingerprint: selected.fingerprint,
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
    "Resolve shared freshness inheritance for one stable Skill ID. This reads Profile rules only, never changes content or selected source versions. Update or clear overrides with profile set --freshness-json and the exact current fingerprint.",
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
