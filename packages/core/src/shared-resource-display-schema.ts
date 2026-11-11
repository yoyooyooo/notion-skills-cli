import { registerSharedFileProperties } from "./shared-file-request-schema.ts"
import type { SharedLibrary } from "./shared-library-model.ts"

export const resourceFileDisplaySchema = {
  "Displayed Revision": { rich_text: {} },
  "Custom Baseline": { rich_text: {} },
  Ownership: {
    select: { options: ["following", "custom", "deleted", "unobserved"].map((name) => ({ name })) },
  },
  "Projection State": { rich_text: {} },
  "Content Observed At": { date: {} },
} as const
export const resourceSkillDisplaySchema = {
  ...resourceFileDisplaySchema,
  "Selected Revision": { rich_text: {} },
  "Upstream Commit Time": { date: {} },
  "Last Successful Check": { date: {} },
  "Discovered Candidate": { rich_text: {} },
} as const
export const resourceRollupProperties = [
  "Selected Revision",
  "Upstream Commit Time",
  "Last Successful Check",
  "Discovered Candidate",
] as const
export function resourceDisplaySchema(library: SharedLibrary, role: "skills" | "files") {
  if (role === "skills") return resourceSkillDisplaySchema
  return {
    ...resourceFileDisplaySchema,
    ...Object.fromEntries(
      resourceRollupProperties.map((name) => [
        name,
        {
          rollup: {
            relation_property_id: library.files.property_ids.Skill,
            rollup_property_id: library.skills.property_ids[name] ?? `pending-registration:${name}`,
            function: "show_original",
          },
        },
      ]),
    ),
  }
}

/** Files aggregate plain Skills properties through their existing one-hop relation; no recursive rollup. */
export function initializeSharedResourceDisplay(library: SharedLibrary, dryRun = false) {
  return registerSharedFileProperties(
    library,
    {
      namespace: "resource-display",
      properties: resourceDisplaySchema,
      writerContract: {
        cli: Object.keys(resourceSkillDisplaySchema),
        aggregation: "Files.Skill -> plain Skills display properties; rollups are UI hints only",
        authoritative_ownership: "existing immutable file events",
        existing_views: "preserved",
        source_check:
          "only the recorded successful Source check advances the displayed success time",
        dry_run_rollups:
          "pending-registration references resolve to actual stable IDs before dispatch",
      },
    },
    dryRun,
  )
}
