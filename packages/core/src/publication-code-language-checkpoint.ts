import { isDeepStrictEqual } from "node:util"
import { createHash } from "node:crypto"
import { codeLanguage } from "./markdown.ts"
import type { Receipt } from "./publication-model.ts"

type Intent = Receipt["intents"][number]

export interface TerminalCanonicalCodeAlias {
  readonly intent_index: number
  readonly acknowledged_body_intent_index: number
  readonly path: string
  readonly owner_path: string
  readonly body_path: string
  readonly language: string
  readonly canonical_language: string
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/

/**
 * Eligibility only. This is a retained, terminal legacy alias request, never an
 * ACK, a known HTTP rejection, or permission to lift a fence. The final adapter
 * below must consume the original block recovery proof after the whole owner
 * Markdown ACK has been proved by completedPublicationProof.
 */
function canonicalCodeAliasAt(
  receipt: Receipt,
  index: number,
): TerminalCanonicalCodeAlias | undefined {
  if (
    receipt.operation !== "create" ||
    receipt.portable.kind !== "skill" ||
    !uuid.test(receipt.page_id ?? "") ||
    !receipt.data_source_id ||
    !Number.isSafeInteger(index) ||
    index < 1 ||
    index >= receipt.intents.length
  )
    return
  const intent = receipt.intents[index]!
  if (
    intent.status !== "failed" ||
    intent.method !== "PATCH" ||
    !/^v1\/blocks\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      intent.path,
    ) ||
    intent.response !== undefined ||
    intent.recovery !== undefined ||
    intent.typed_links !== undefined ||
    intent.list_start_repair !== undefined ||
    intent.artifact !== undefined ||
    !intent.guards ||
    receipt.intents
      .slice(0, index)
      .some(
        (before) =>
          before.status !== "completed" ||
          before.recovery !== undefined ||
          before.typed_links?.state === "pending" ||
          before.list_start_repair !== undefined,
      )
  )
    return
  if (
    !record(intent.body) ||
    !exactKeys(intent.body, ["code"]) ||
    !record(intent.body.code) ||
    !exactKeys(intent.body.code, ["language"])
  )
    return
  const language = intent.body.code.language
  if (typeof language !== "string" || !language || language !== language.trim().toLowerCase())
    return
  const canonicalLanguage = codeLanguage(language)
  if (canonicalLanguage === language) return
  const before = intent.guards[intent.path]
  if (
    !record(before) ||
    before.id !== intent.path.split("/")[2] ||
    before.type !== "code" ||
    before.has_children !== false ||
    before.archived !== false ||
    before.in_trash !== false ||
    !record(before.code) ||
    before.code.language !== canonicalLanguage ||
    !Array.isArray(before.code.rich_text)
  )
    return
  const seen = new Set<string>([intent.path])
  let parent = before.parent
  while (record(parent) && parent.type === "block_id" && typeof parent.block_id === "string") {
    const path = `v1/blocks/${parent.block_id}`
    if (seen.has(path)) return
    seen.add(path)
    const ancestor = intent.guards[path]
    if (
      !record(ancestor) ||
      ancestor.id !== parent.block_id ||
      typeof ancestor.type !== "string" ||
      !record(ancestor[ancestor.type])
    )
      return
    parent = ancestor.parent
  }
  if (
    !record(parent) ||
    parent.type !== "page_id" ||
    typeof parent.page_id !== "string" ||
    !uuid.test(parent.page_id)
  )
    return
  const ownerPath = `v1/pages/${parent.page_id}`
  const bodyPath = `${ownerPath}/markdown`
  const owner = intent.guards[ownerPath]
  if (
    !record(owner) ||
    owner.id !== parent.page_id ||
    typeof intent.guards[bodyPath] !== "string" ||
    !record(receipt.guards[ownerPath]) ||
    typeof receipt.guards[bodyPath] !== "string"
  )
    return
  // This legacy repair immediately follows the acknowledged whole owner body.
  // Only that original ACK can supply the verifiedBodies requirement below.
  const acknowledged = receipt.intents[index - 1]!
  if (
    acknowledged.method !== "PATCH" ||
    acknowledged.path !== bodyPath ||
    !record(acknowledged.body)
  )
    return
  const request = acknowledged.body
  let target: unknown
  if (request.type === "replace_content" && record(request.replace_content)) {
    target = request.replace_content.new_str
  } else if (request.type === "update_content" && record(request.update_content)) {
    const updates = request.update_content.content_updates
    if (
      !Array.isArray(updates) ||
      updates.length !== 1 ||
      !record(updates[0]) ||
      typeof acknowledged.guards?.[bodyPath] !== "string" ||
      updates[0].old_str !== acknowledged.guards[bodyPath]
    )
      return
    target = updates[0].new_str
  }
  if (typeof target !== "string") return
  return {
    intent_index: index,
    acknowledged_body_intent_index: index - 1,
    path: intent.path,
    owner_path: ownerPath,
    body_path: bodyPath,
    language,
    canonical_language: canonicalLanguage,
  }
}

export function terminalCanonicalCodeAliasCandidate(receipt: Receipt) {
  if (receipt.conflict !== true || receipt.owner !== undefined) return
  // A later fence must reuse and verify the original certificate. Minting a
  // second one would make the history ambiguous and break further recovery.
  if (
    receipt.conflict_history?.some(
      (entry) =>
        record(entry) &&
        "canonical_code_language_checkpoint" in entry &&
        entry.canonical_code_language_checkpoint !== undefined,
    )
  )
    return
  return canonicalCodeAliasAt(receipt, receipt.intents.length - 1)
}

type OriginalBlockRecovery = (
  intent: Intent,
  receipt: Receipt,
  observed: Record<string, unknown>,
  allowOriginal: true,
) => { readonly outcome: string; readonly skip?: boolean; readonly ownerPath?: string }

/**
 * The caller must be inside the original completed publication proof. Its source
 * bytes, marker, all ACK fields and complete owner body must already be proved;
 * normal final guard and revision checks remain mandatory afterwards. This
 * adapter grants only this failed intent's no-effect checkpoint, not completion.
 */
export function verifyTerminalCanonicalCodeAlias(
  receipt: Receipt,
  observed: Record<string, unknown>,
  verifiedBodies: ReadonlySet<string>,
  recoverOriginalBlock: OriginalBlockRecovery,
) {
  const candidate = terminalCanonicalCodeAliasCandidate(receipt)
  if (!candidate || !verifiedBodies.has(candidate.body_path)) return
  const intent = receipt.intents[candidate.intent_index]!
  // In particular, preserve all original server revisions. Do not turn a newer
  // successful GET into a replacement pre-mutation checkpoint.
  for (const saved of [receipt.guards, intent.guards!]) {
    if (
      !Object.keys(saved).length ||
      Object.entries(saved).some(
        ([path, value]) =>
          !Object.hasOwn(observed, path) || !isDeepStrictEqual(value, observed[path]),
      )
    )
      return
  }
  const recovery = recoverOriginalBlock(intent, receipt, observed, true)
  if (
    recovery.outcome !== "retry" ||
    recovery.skip !== true ||
    recovery.ownerPath !== candidate.owner_path
  )
    return
  return candidate
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (record(value))
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`
  return JSON.stringify(value) ?? "null"
}

const sha = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex")
const hash = /^[a-f0-9]{64}$/

export interface CanonicalCodeLanguageCheckpoint extends TerminalCanonicalCodeAlias {
  readonly version: 1
  readonly operation_id: string
  readonly page_id: string
  readonly data_source_id: string
  readonly intended_hash: string
  readonly original_intent_count: number
  readonly original_journal_sha256: string
  readonly original_guard_paths: readonly string[]
  readonly original_guards_sha256: string
  readonly original_intent_guards_sha256: string
}

/** Called only at the SUCCESS return of the complete original publication proof.
 * The official reconciler persists this in conflict_history. It never rewrites
 * the failed intent, its response, or the original guards inside that intent. */
export function canonicalCodeLanguageCheckpoint(
  receipt: Receipt,
  intendedHash: string,
  proved: TerminalCanonicalCodeAlias,
): CanonicalCodeLanguageCheckpoint | undefined {
  const candidate = terminalCanonicalCodeAliasCandidate(receipt)
  if (!candidate || !isDeepStrictEqual(candidate, proved) || !hash.test(intendedHash)) return
  const saved = receipt.intents[candidate.intent_index]!.guards!
  const paths = Object.keys(receipt.guards).sort()
  if (
    !paths.length ||
    paths.some(
      (path) =>
        !Object.hasOwn(saved, path) || !isDeepStrictEqual(saved[path], receipt.guards[path]),
    )
  )
    return
  return {
    ...candidate,
    version: 1,
    operation_id: receipt.operation_id,
    page_id: receipt.page_id!,
    data_source_id: receipt.data_source_id!,
    intended_hash: intendedHash,
    original_intent_count: receipt.intents.length,
    original_journal_sha256: sha(receipt.intents),
    original_guard_paths: paths,
    original_guards_sha256: sha(receipt.guards),
    original_intent_guards_sha256: sha(saved),
  }
}

function isCheckpoint(value: unknown): value is CanonicalCodeLanguageCheckpoint {
  if (
    !record(value) ||
    !exactKeys(value, [
      "intent_index",
      "acknowledged_body_intent_index",
      "path",
      "owner_path",
      "body_path",
      "language",
      "canonical_language",
      "version",
      "operation_id",
      "page_id",
      "data_source_id",
      "intended_hash",
      "original_intent_count",
      "original_journal_sha256",
      "original_guard_paths",
      "original_guards_sha256",
      "original_intent_guards_sha256",
    ])
  )
    return false
  return (
    value.version === 1 &&
    [
      "operation_id",
      "page_id",
      "data_source_id",
      "path",
      "owner_path",
      "body_path",
      "language",
      "canonical_language",
    ].every((key) => typeof value[key] === "string") &&
    [
      "intended_hash",
      "original_journal_sha256",
      "original_guards_sha256",
      "original_intent_guards_sha256",
    ].every((key) => {
      const child = value[key]
      return typeof child === "string" && hash.test(child)
    }) &&
    ["intent_index", "acknowledged_body_intent_index", "original_intent_count"].every((key) => {
      const child = value[key]
      return typeof child === "number" && Number.isSafeInteger(child) && child >= 0
    }) &&
    Array.isArray(value.original_guard_paths) &&
    value.original_guard_paths.length > 0 &&
    value.original_guard_paths.every((path) => typeof path === "string")
  )
}

export interface CertifiedCanonicalCodeAlias {
  readonly candidate: TerminalCanonicalCodeAlias
  readonly checkpoint: CanonicalCodeLanguageCheckpoint
}

/** Static eligibility from an officially recorded checkpoint, not current effect proof.
 * Every original journal entry, including the failed alias, must remain immutable.
 * The normal whole publication proof must still verify every later completed ACK. */
export function certifiedCanonicalCodeAliasCandidate(
  receipt: Receipt,
): CertifiedCanonicalCodeAlias | undefined {
  if (receipt.owner !== undefined || !Array.isArray(receipt.conflict_history)) return
  const proofs: CertifiedCanonicalCodeAlias[] = []
  for (const entry of receipt.conflict_history) {
    if (!record(entry) || !isCheckpoint(entry.canonical_code_language_checkpoint)) continue
    const checkpoint = entry.canonical_code_language_checkpoint
    const candidate = canonicalCodeAliasAt(receipt, checkpoint.intent_index)
    if (
      !candidate ||
      entry.conflict !== true ||
      entry.intent_count !== checkpoint.original_intent_count ||
      entry.intended_hash !== checkpoint.intended_hash ||
      checkpoint.operation_id !== receipt.operation_id ||
      checkpoint.page_id !== receipt.page_id ||
      checkpoint.data_source_id !== receipt.data_source_id ||
      checkpoint.original_intent_count !== candidate.intent_index + 1 ||
      !isDeepStrictEqual(
        {
          intent_index: checkpoint.intent_index,
          acknowledged_body_intent_index: checkpoint.acknowledged_body_intent_index,
          path: checkpoint.path,
          owner_path: checkpoint.owner_path,
          body_path: checkpoint.body_path,
          language: checkpoint.language,
          canonical_language: checkpoint.canonical_language,
        },
        candidate,
      ) ||
      sha(receipt.intents.slice(0, checkpoint.original_intent_count)) !==
        checkpoint.original_journal_sha256 ||
      receipt.intents
        .slice(checkpoint.original_intent_count)
        .some(
          (intent) =>
            intent.status !== "completed" ||
            intent.recovery !== undefined ||
            intent.typed_links?.state === "pending" ||
            intent.list_start_repair !== undefined,
        )
    )
      continue
    const paths = checkpoint.original_guard_paths
    const saved = receipt.intents[candidate.intent_index]!.guards!
    const historyPaths = entry.guard_paths
    if (
      !Array.isArray(historyPaths) ||
      historyPaths.some((path: unknown) => typeof path !== "string")
    )
      continue
    if (
      new Set(paths).size !== paths.length ||
      !isDeepStrictEqual([...paths].sort(), paths) ||
      !isDeepStrictEqual([...historyPaths].sort(), paths) ||
      paths.some((path) => !Object.hasOwn(saved, path)) ||
      sha(Object.fromEntries(paths.map((path) => [path, saved[path]]))) !==
        checkpoint.original_guards_sha256 ||
      sha(saved) !== checkpoint.original_intent_guards_sha256
    )
      continue
    proofs.push({ candidate, checkpoint })
  }
  return proofs.length === 1 ? proofs[0] : undefined
}

/** Current proof for the actual continuation: original code/ancestors and owner
 * body/metadata remain exact while later ACKs may update other pages.
 * A later body rebuild or missing block needs separate whole-body replacement
 * coverage; this checkpoint cannot suppress a missing or changed block read. */
export function verifyCertifiedCanonicalCodeAlias(
  receipt: Receipt,
  observed: Record<string, unknown>,
  verifiedBodies: ReadonlySet<string>,
  intendedHash: string,
) {
  const certified = certifiedCanonicalCodeAliasCandidate(receipt)
  if (
    !certified ||
    certified.checkpoint.intended_hash !== intendedHash ||
    !verifiedBodies.has(certified.candidate.body_path)
  )
    return
  const { candidate } = certified
  const saved = receipt.intents[candidate.intent_index]!.guards!
  let path = candidate.path
  const seen = new Set<string>()
  while (!seen.has(path)) {
    seen.add(path)
    const before = saved[path]
    if (
      !record(before) ||
      !Object.hasOwn(observed, path) ||
      !isDeepStrictEqual(before, observed[path])
    )
      return
    const parent = before.parent
    if (!record(parent)) return
    if (parent.type === "page_id") {
      if (`v1/pages/${parent.page_id}` !== candidate.owner_path) return
      break
    }
    if (parent.type !== "block_id" || typeof parent.block_id !== "string") return
    path = `v1/blocks/${parent.block_id}`
  }
  if (observed[candidate.body_path] !== saved[candidate.body_path]) return
  const originalOwner = saved[candidate.owner_path],
    currentOwner = observed[candidate.owner_path]
  // Current guards do not authorize unrelated owner metadata changes. The
  // checkpoint covers only the original language alias, so every original owner
  // metadata field and its revision must remain exact, including Files.
  if (
    !record(originalOwner) ||
    !record(currentOwner) ||
    !isDeepStrictEqual(currentOwner, originalOwner)
  )
    return
  // These are the current post-resume checkpoints; the prior full set was
  // proved at the recorded fence. No newer observation may replace either set.
  if (
    Object.entries(receipt.guards).some(
      ([guardPath, value]) =>
        !Object.hasOwn(observed, guardPath) || !isDeepStrictEqual(value, observed[guardPath]),
    )
  )
    return
  return certified
}
