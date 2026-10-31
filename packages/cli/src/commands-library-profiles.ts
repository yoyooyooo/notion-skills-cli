import { Effect, Option } from "effect"
import { Argument, Command } from "effect/cli"
import { databaseId } from "../../core/src/catalog.ts"
import { defineCommand } from "../../core/src/command-schema.ts"
import { fail } from "../../core/src/model.ts"
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
      yield* emit(
        yield* saveSharedProfile(yield* library(options.entry), {
          profile: {
            profile_id: options.profile,
            name: options.name,
            enabled: options.enabled === "true",
            ...(defaultView === undefined ? {} : { default_view_id: defaultView }),
          },
          expectedRevision: options.base === "new" ? null : options.base,
          mode: options.reconcile ? "reconcile" : "create",
        }),
      )
    }),
).pipe(
  Command.withDescription(
    "Save a full immutable Profile rule revision. --name, --enabled and --base are required; omitted --default-view means no default. Use show to review the exact current revision before updating. The original plan is retained before at most one POST. Repeating an unresolved revision or using --reconcile only checks its original shared fact and never replays an uncertain write. Concurrent heads require explicit review; a View never grants access.",
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
  Command.withSubcommands([list, show, set, bind, unbind]),
)
