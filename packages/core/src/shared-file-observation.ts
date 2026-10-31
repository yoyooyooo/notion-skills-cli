export type FileMetadataInput = {
  readonly file_id: string
  readonly page_id: string
  readonly path: string
  readonly last_edited_time: string
  readonly management_revision: string
}

export type LocalFileObservation = FileMetadataInput & {
  readonly body_sha256: string
  readonly body_verified_at: number
  readonly metadata_validated_at: number
}

export type BodyReadReason =
  | "unobserved"
  | "binding_changed"
  | "path_changed"
  | "management_changed"
  | "timestamp_changed"
  | "forced"
  | "full_body_due"

export type FileValidation =
  | {
      readonly action: "use_cached"
      readonly file: FileMetadataInput
      readonly body_sha256: string
    }
  | {
      readonly action: "metadata_check"
      readonly file: FileMetadataInput
      readonly body_sha256: string
    }
  | {
      readonly action: "body_read"
      readonly file: FileMetadataInput
      readonly reason: BodyReadReason
    }
  | {
      readonly action: "recover_fixed"
      readonly file: FileMetadataInput
      readonly body_sha256: string
      readonly metadata_check_required: boolean
    }

export type MissingMembershipCandidate = {
  readonly file_id: string
  readonly page_id: string
  readonly path: string
  /** Missing query results never authorize deletion or prove a permission change. */
  readonly deletion_authorized: false
}

export type FileValidationPlan = {
  readonly files: readonly FileValidation[]
  /** Only populated when the caller attests that pagination/membership enumeration completed. */
  readonly removed_candidates: readonly MissingMembershipCandidate[]
  readonly unobserved_candidates: readonly MissingMembershipCandidate[]
}

export class FileObservationError extends Error {
  readonly code: "INVALID_FILE_OBSERVATION" | "BODY_VALIDATION_REQUIRED"
  constructor(code: "INVALID_FILE_OBSERVATION" | "BODY_VALIDATION_REQUIRED", message: string) {
    super(message)
    this.name = "FileObservationError"
    this.code = code
  }
}

function invalid(message: string): never {
  throw new FileObservationError("INVALID_FILE_OBSERVATION", message)
}

function nonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) invalid(`${name} must be a finite nonnegative time.`)
}

function validateMetadata(file: FileMetadataInput, now: number): void {
  for (const [name, value] of Object.entries({
    file_id: file.file_id,
    page_id: file.page_id,
    path: file.path,
    management_revision: file.management_revision,
  }))
    if (typeof value !== "string" || value.length === 0) invalid(`${name} must be nonempty.`)
  const timestamp = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(
    file.last_edited_time,
  )
  const editedAt = Date.parse(file.last_edited_time)
  if (
    !timestamp ||
    !Number.isFinite(editedAt) ||
    editedAt < 0 ||
    editedAt > now ||
    new Date(editedAt).toISOString() !== `${timestamp[1]}.${(timestamp[2] ?? "").padEnd(3, "0")}Z`
  )
    invalid("last_edited_time is invalid or in the future.")
}

function validateObservation(observation: LocalFileObservation, now: number): void {
  // Deliberately pass only metadata fields, rather than the observation's numeric fields.
  validateMetadata(
    {
      file_id: observation.file_id,
      page_id: observation.page_id,
      path: observation.path,
      last_edited_time: observation.last_edited_time,
      management_revision: observation.management_revision,
    },
    now,
  )
  if (!/^[a-f0-9]{64}$/.test(observation.body_sha256)) invalid("body_sha256 is invalid.")
  nonNegative(observation.body_verified_at, "body_verified_at")
  nonNegative(observation.metadata_validated_at, "metadata_validated_at")
  if (observation.body_verified_at > now || observation.metadata_validated_at > now)
    invalid("Observation validation times cannot be in the future.")
}

function changedReason(
  file: FileMetadataInput,
  observation: LocalFileObservation,
): BodyReadReason | undefined {
  if (file.file_id !== observation.file_id || file.page_id !== observation.page_id)
    return "binding_changed"
  if (file.path !== observation.path) return "path_changed"
  if (file.management_revision !== observation.management_revision) return "management_changed"
  if (file.last_edited_time !== observation.last_edited_time) return "timestamp_changed"
  return undefined
}

/**
 * Plans current-file observations only. It does not fetch, mutate, or authorize a tombstone.
 * A metadata_check is a member of one batched data-source query, never a per-page GET plan.
 * Pin resolution must independently require the pinned hash; a body_read reads current content.
 */
export function planFileValidation(input: {
  readonly files: readonly FileMetadataInput[]
  readonly observations: readonly LocalFileObservation[]
  readonly now: number
  readonly metadataTtlMs: number
  readonly fullBodyMaxAgeMs: number
  readonly forceFull?: boolean
  /** Hashes whose cached bytes have passed integrity validation, not merely filenames on disk. */
  readonly availableObjectHashes: ReadonlySet<string>
  readonly membershipComplete?: boolean
}): FileValidationPlan {
  nonNegative(input.now, "now")
  nonNegative(input.metadataTtlMs, "metadataTtlMs")
  nonNegative(input.fullBodyMaxAgeMs, "fullBodyMaxAgeMs")
  const observations = new Map<string, LocalFileObservation>()
  for (const observation of input.observations) {
    validateObservation(observation, input.now)
    if (observations.has(observation.file_id)) invalid("Duplicate observation file_id.")
    observations.set(observation.file_id, observation)
  }
  const identities = new Set<string>()
  const bindings = new Set<string>()
  const paths = new Set<string>()
  const files = input.files.map((current): FileValidation => {
    validateMetadata(current, input.now)
    if (identities.has(current.file_id)) invalid("Duplicate current file_id.")
    if (bindings.has(current.page_id)) invalid("Multiple files share one editable page binding.")
    if (paths.has(current.path)) invalid("Multiple files share one logical path.")
    identities.add(current.file_id)
    bindings.add(current.page_id)
    paths.add(current.path)
    const file = { ...current }
    const observation = observations.get(file.file_id)
    if (observation === undefined) return { action: "body_read", file, reason: "unobserved" }
    const changed = changedReason(file, observation)
    if (changed !== undefined) return { action: "body_read", file, reason: changed }
    if (input.forceFull) return { action: "body_read", file, reason: "forced" }
    // This deadline is independent of every metadata-only renewal.
    if (input.now - observation.body_verified_at >= input.fullBodyMaxAgeMs)
      return { action: "body_read", file, reason: "full_body_due" }
    const metadataExpired = input.now - observation.metadata_validated_at >= input.metadataTtlMs
    if (!input.availableObjectHashes.has(observation.body_sha256))
      return {
        action: "recover_fixed",
        file,
        body_sha256: observation.body_sha256,
        metadata_check_required: metadataExpired,
      }
    return {
      action: metadataExpired ? "metadata_check" : "use_cached",
      file,
      body_sha256: observation.body_sha256,
    }
  })
  const missing = [...observations.values()]
    .filter((observation) => !identities.has(observation.file_id))
    .map(
      (observation): MissingMembershipCandidate => ({
        file_id: observation.file_id,
        page_id: observation.page_id,
        path: observation.path,
        deletion_authorized: false,
      }),
    )
  return {
    files,
    removed_candidates: input.membershipComplete ? missing : [],
    unobserved_candidates: input.membershipComplete ? [] : missing,
  }
}

/** Only call after a successful, complete metadata observation of this exact binding. */
export function refreshMetadataObservation(input: {
  readonly file: FileMetadataInput
  readonly observation: LocalFileObservation
  readonly now: number
}): LocalFileObservation {
  nonNegative(input.now, "now")
  validateMetadata(input.file, input.now)
  validateObservation(input.observation, input.now)
  const reason = changedReason(input.file, input.observation)
  if (reason !== undefined)
    throw new FileObservationError(
      "BODY_VALIDATION_REQUIRED",
      `Metadata changed (${reason}); verify current body before replacing its observation.`,
    )
  return { ...input.observation, metadata_validated_at: input.now }
}
