import type { SharedLibrary } from "./shared-library-model.ts"

/** Report only facts the initializer and local configuration actually observed.
 * Host connection and a delivered body require separate host evidence. */
export function libraryOnboarding(input: {
  readonly library: SharedLibrary
  readonly created: boolean
  readonly localAliases: readonly string[]
}) {
  const entry = input.library.skills.database_id
  const remote =
    input.library.sources === undefined
      ? "core_ready_source_pending"
      : input.created
        ? "ready_empty"
        : "ready"
  const next =
    remote === "core_ready_source_pending"
      ? ["ntn-skills", "ctl", "library", "sources", "init", "--entry", entry]
      : ["ntn-skills", "list", "--database", entry, "--refresh", "--json"]
  return {
    entry,
    onboarding: {
      version: 1,
      remote: { status: remote, entry },
      local:
        input.localAliases.length === 0
          ? { status: "not_registered", aliases: [] }
          : { status: "registered", aliases: [...input.localAliases] },
      pi: { status: "not_observed", body_read: "not_observed", configuration_changed: false },
      next: { argv: next },
      setup: {
        argv: [
          "ntn-skills",
          "ctl",
          "builtin",
          "read",
          "notion/ntn-skills-maintain",
          "--path",
          "references/setup.md",
        ],
      },
    },
    next: { argv: next },
  } as const
}
