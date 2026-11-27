import { fail, property } from "./model.ts"

/** Interpret the old registration envelope without erasing it from Notion.
 * Prefixes named legacy catalog identities, not paths in the Git file tree. */
export function sourceDefinitionOptions(input: Readonly<Record<string, unknown>>) {
  if (!("settings" in input || "adapter" in input || "version" in input)) return input
  if (
    input.version !== 1 ||
    Object.keys(input).some((key) => !["version", "adapter", "settings"].includes(key))
  )
    throw fail("SOURCE_ADAPTER_OPTIONS_UNSUPPORTED", "Unsupported Source registration envelope.")
  const adapter = property(input.adapter),
    settings = property(input.settings)
  if (
    Object.keys(adapter).length !== 0 ||
    input.settings === null ||
    typeof input.settings !== "object" ||
    Array.isArray(input.settings)
  )
    throw fail("SOURCE_ADAPTER_OPTIONS_UNSUPPORTED", "Unsupported legacy adapter configuration.")
  const permitted = new Set([
    "strip_prefix",
    "target_prefix",
    "target_mode",
    "patch",
    "member_patches",
    "require_all_included",
    "accepted_ref",
    "external_assets",
    "external_markdown",
  ])
  if (Object.keys(settings).some((key) => !permitted.has(key)))
    throw fail(
      "SOURCE_ADAPTER_OPTIONS_UNSUPPORTED",
      "An explicit legacy setting has no current interpretation.",
    )
  if (settings.target_mode !== undefined && settings.target_mode !== "manual")
    throw fail(
      "SOURCE_ADAPTER_OPTIONS_UNSUPPORTED",
      "Legacy target mode must be reviewed before materialization.",
    )
  for (const key of ["strip_prefix", "target_prefix"])
    if (
      settings[key] !== undefined &&
      (typeof settings[key] !== "string" ||
        /[\\\u0000-\u001f\u007f]/u.test(settings[key] as string) ||
        (settings[key] as string).split("/").some((part) => part === ".."))
    )
      throw fail(
        "SOURCE_ADAPTER_OPTIONS_UNSUPPORTED",
        "Legacy catalog prefixes must be safe paths.",
      )
  const {
    strip_prefix: _strip,
    target_prefix: _target,
    target_mode: _mode,
    ...effective
  } = settings
  return effective
}
