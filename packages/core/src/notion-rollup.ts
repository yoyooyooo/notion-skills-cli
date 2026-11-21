import { property } from "./model.ts"

/** Notion returns raw IDs inside rollups and URL-encoded IDs on the referenced properties. */
export function matchesNotionRollup(actual: unknown, expected: Readonly<Record<string, unknown>>) {
  const value = property(actual)
  if (
    typeof expected.relation_property_id !== "string" ||
    typeof expected.rollup_property_id !== "string" ||
    typeof expected.function !== "string"
  )
    return false
  try {
    return (
      value.relation_property_id === decodeURIComponent(expected.relation_property_id) &&
      value.rollup_property_id === decodeURIComponent(expected.rollup_property_id) &&
      value.function === expected.function
    )
  } catch {
    return false
  }
}
