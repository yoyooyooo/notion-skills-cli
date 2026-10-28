import { Effect, FileSystem, Schema } from "effect"
import { fail, property, SkillsError } from "./model.ts"
import { strictDecode } from "./upstream-model.ts"
import type { SubscriptionInput } from "./upstream-model.ts"
import { SourcePatchSchema } from "./upstream-source-model.ts"
import { sha256 } from "./store.ts"

const Artifact = Schema.Struct({
  normalized_result: Schema.Struct({
    frames: Schema.Array(Schema.Struct({ data: Schema.String })),
  }),
})
const Body = Schema.Struct({
  path: Schema.String,
  line: Schema.Number,
  root: Schema.String,
  name: Schema.String,
  mode: Schema.Literals(["tracked", "fork", "local", "local-default"]),
  groups: Schema.Array(Schema.String),
  provenance: Schema.Boolean,
})
export interface CensusSource {
  readonly registration: string
  readonly lifecycle: string
  readonly config: SubscriptionInput | null
  readonly original: Readonly<Record<string, unknown>>
  readonly members: readonly {
    readonly path: string
    readonly name: string
    readonly root: string
  }[]
  readonly blocked: readonly string[]
}
/** Decode frozen REA frames in order; frames may split a JSON line. No counts or source names are hardcoded. */
export function importAkCensus(input: {
  readonly registrations: unknown
  readonly bodies: unknown
  readonly target_database_id: string
  readonly shared_publishers: Readonly<Record<string, string>>
  readonly patches: Readonly<Record<string, unknown>>
}) {
  return Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => {
        const registrationText = Schema.decodeUnknownSync(Artifact)(input.registrations)
          .normalized_result.frames.map((f) => f.data)
          .join("")
        const bodyText = Schema.decodeUnknownSync(Artifact)(input.bodies)
          .normalized_result.frames.map((f) => f.data)
          .join("")
        const registrations = registrationText
          .split(/\r?\n/)
          .filter((line) => line.startsWith("{"))
          .map((line) => property(JSON.parse(line)))
        const bodies = bodyText
          .split(/\r?\n/)
          .filter((line) => line.startsWith("{"))
          .map((line) => strictDecode(Body, JSON.parse(line)))
        return { registrations, bodies }
      },
      catch: (e) =>
        e instanceof SkillsError
          ? e
          : fail("INVALID_UPSTREAM_CENSUS", "Frozen census frames are incomplete or invalid."),
    })
    const sources: CensusSource[] = []
    for (const registration of parsed.registrations.filter(
      (r) => r.file === ".ak/upstreams.json",
    )) {
      const name = String(registration.name),
        mode = String(registration.mode),
        group = registration.section === "sources"
      const members = parsed.bodies.filter((body) =>
        group ? body.groups.includes(name) : body.name === name,
      )
      const blocked: string[] = []
      const roots = group ? registration.paths : [registration.sourcePath]
      if (!Array.isArray(roots) || !roots.every((p) => typeof p === "string"))
        blocked.push("source-root-unresolved")
      const clone = registration.cloneUrl
      if (typeof clone !== "string") blocked.push("git-location-unresolved")
      const shared =
        typeof registration.sharedTargetSet === "string" ? registration.sharedTargetSet : undefined
      const publisher = shared ? input.shared_publishers[shared] : undefined
      if (shared && (!publisher || typeof registration.acceptedRef !== "string"))
        blocked.push("shared-publication-authority-unresolved")
      let patch: typeof SourcePatchSchema.Type | undefined
      if (typeof registration.patchPath === "string") {
        const raw = input.patches[registration.patchPath]
        if (raw === undefined) blocked.push("explicit-patch-missing")
        else {
          const result = yield* Effect.try({
            try: () => strictDecode(SourcePatchSchema, raw),
            catch: () =>
              fail(
                "INVALID_UPSTREAM_PATCH",
                "The registered patch is not a version-one exact patch document.",
              ),
          }).pipe(Effect.result)
          if (result._tag === "Failure") blocked.push(result.failure.code)
          else patch = result.success
        }
      }
      const mapping: Record<string, string> = {}
      // Exact source path mapping follows AK stripPrefix/targetPrefix; source membership stays identity.
      const include = Array.isArray(registration.include)
        ? registration.include.filter((v): v is string => typeof v === "string")
        : []
      const config: SubscriptionInput | null =
        blocked.length || mode !== "tracked"
          ? null
          : {
              target_database_id: input.target_database_id,
              name,
              description:
                typeof registration.note === "string"
                  ? registration.note
                  : `Tracked source ${name}`,
              default_context: false,
              enabled: true,
              source: {
                provider: {
                  type: "git",
                  url: clone as string,
                  ref: typeof registration.ref === "string" ? registration.ref : "main",
                },
                ...(patch ? { patch } : {}),
                ...(shared
                  ? {
                      shared_target_set: shared,
                      publisher_subscription_id: publisher!,
                      accepted_ref: registration.acceptedRef as string,
                    }
                  : {}),
                ...(typeof registration.stripPrefix === "string"
                  ? { strip_prefix: registration.stripPrefix }
                  : {}),
                ...(typeof registration.targetPrefix === "string"
                  ? { target_prefix: registration.targetPrefix }
                  : {}),
                target_mode:
                  typeof registration.targetMode === "string" ? registration.targetMode : "auto",
                ...(registration.requireAllIncluded === true ? { require_all_included: true } : {}),
              },
              roots: roots as string[],
              include,
              exclude: Array.isArray(registration.exclude)
                ? registration.exclude.filter((v): v is string => typeof v === "string")
                : [],
              mapping,
            }
      sources.push({
        registration: `${group ? "source" : "skill"}:${name}`,
        lifecycle: mode,
        config,
        original: registration,
        members: members.map(({ path, name, root }) => ({ path, name, root })),
        blocked,
      })
    }
    // Install provenance is evidence, never authorization to convert local/fork into tracked.
    const provenance = parsed.registrations.filter((r) => r.file === ".ak/install-sources.json")
    const trackedBodies = parsed.bodies.filter((b) => b.mode === "tracked")
    const uncovered = trackedBodies
      .filter(
        (body) =>
          !sources.some(
            (source) =>
              source.lifecycle === "tracked" &&
              source.members.some((member) => member.path === body.path),
          ),
      )
      .map((b) => b.path)
    const manifest = {
      version: 1 as const,
      sources,
      provenance,
      bodies: parsed.bodies,
      counts: {
        tracked_bodies: trackedBodies.length,
        individual: sources.filter((s) => s.registration.startsWith("skill:")).length,
        source_groups: sources.filter((s) => s.registration.startsWith("source:")).length,
      },
      uncovered,
      migration_ready:
        uncovered.length === 0 &&
        sources.filter((s) => s.lifecycle === "tracked").every((s) => s.blocked.length === 0),
    }
    return { ...manifest, manifest_hash: yield* sha256(JSON.stringify(manifest)) }
  })
}
/** All filesystem reads are explicit caller inputs; the AK checkout remains read-only. */
export function readAkCensus(input: {
  readonly registrations_path: string
  readonly bodies_path: string
  readonly target_database_id: string
  readonly shared_publishers: Readonly<Record<string, string>>
  readonly patch_paths: Readonly<Record<string, string>>
}) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const json = (path: string) =>
      fs.readFileString(path).pipe(
        Effect.mapError(() =>
          fail("UPSTREAM_CENSUS_UNREADABLE", "Could not read explicit census input."),
        ),
        Effect.flatMap((text) =>
          Effect.try({
            try: () => JSON.parse(text) as unknown,
            catch: () => fail("INVALID_UPSTREAM_CENSUS", "Census input is not JSON."),
          }),
        ),
      )
    const patches: Record<string, unknown> = {}
    for (const [key, path] of Object.entries(input.patch_paths)) patches[key] = yield* json(path)
    return yield* importAkCensus({
      registrations: yield* json(input.registrations_path),
      bodies: yield* json(input.bodies_path),
      target_database_id: input.target_database_id,
      shared_publishers: input.shared_publishers,
      patches,
    })
  })
}
