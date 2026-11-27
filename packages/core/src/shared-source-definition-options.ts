import { fail, property } from "./model.ts"

const label = (value: unknown) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 200 &&
  !/[\u0000-\u001f\u007f]/u.test(value)

/** Historical publication metadata is retained in the declaration and digest.
 * Knowing how to enumerate its Git members does not grant publication authority. */
function legacySettings(input: Readonly<Record<string, unknown>>) {
  if (!("settings" in input || "adapter" in input || "version" in input)) return undefined
  if (
    input.version !== 1 ||
    Object.keys(input).some((key) => !["version", "adapter", "settings"].includes(key))
  )
    throw fail("SOURCE_ADAPTER_OPTIONS_UNSUPPORTED", "Unsupported Source registration envelope.")
  const adapter = property(input.adapter),
    settings = property(input.settings)
  if (
    input.adapter === null ||
    typeof input.adapter !== "object" ||
    Array.isArray(input.adapter) ||
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
    "storage",
    "shared_target_set",
    "publisher_subscription_id",
  ])
  if (Object.keys(settings).some((key) => !permitted.has(key)))
    throw fail(
      "SOURCE_ADAPTER_OPTIONS_UNSUPPORTED",
      "An explicit legacy setting has no current interpretation.",
    )
  if (settings.target_mode !== undefined && !label(settings.target_mode))
    throw fail(
      "SOURCE_ADAPTER_OPTIONS_UNSUPPORTED",
      "Legacy target mode must be a bounded classification label.",
    )
  if (
    settings.storage !== undefined &&
    (typeof settings.storage !== "string" ||
      !["auto", "fixed-git", "retained"].includes(settings.storage))
  )
    throw fail("SOURCE_STORAGE_POLICY_INVALID", "Unsupported legacy Source storage policy.")
  if (settings.shared_target_set !== undefined || settings.publisher_subscription_id !== undefined)
    if (
      !label(settings.shared_target_set) ||
      typeof settings.publisher_subscription_id !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(
        settings.publisher_subscription_id,
      ) ||
      typeof settings.accepted_ref !== "string" ||
      !/^[a-f0-9]{40}$/u.test(settings.accepted_ref)
    )
      throw fail(
        "SOURCE_ADAPTER_OPTIONS_UNSUPPORTED",
        "Shared publication metadata requires its exact owner, target set and accepted commit.",
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
  return settings
}

/** Prefixes and target modes named legacy publication identities/classifications,
 * not Git paths. Storage and shared publication policy are checked by the writer. */
export function sourceDefinitionOptions(input: Readonly<Record<string, unknown>>) {
  const settings = legacySettings(input)
  if (settings === undefined) return input
  const {
    strip_prefix: _strip,
    target_prefix: _target,
    target_mode: _mode,
    storage: _storage,
    shared_target_set: _shared,
    publisher_subscription_id: _publisher,
    ...effective
  } = settings
  return effective
}

/** Call only from a fresh management declaration, never from candidate trust. */
export function assertCurrentSourceWriteOptions(input: Readonly<Record<string, unknown>>) {
  const settings = legacySettings(input)
  if (settings?.shared_target_set !== undefined)
    throw fail(
      "SOURCE_COMPOSITION_REVIEW_REQUIRED",
      "A shared publication target needs an explicit fixed composition; one Source cannot replace its merged owner.",
    )
  if (settings?.storage === "retained")
    throw fail(
      "SOURCE_STORAGE_REVIEW_REQUIRED",
      "Explicit retained storage cannot be silently changed to current fixed Git files.",
    )
}
