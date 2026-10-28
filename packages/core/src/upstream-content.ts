import { Effect } from "effect"

import { fail } from "./model.ts"
import type { PortableSkill } from "./portable.ts"
import { sha256, Store } from "./store.ts"
import { discoverSource } from "./upstream-source.ts"

import type { FrozenPortable, PlanItem, Subscription } from "./upstream-model.ts"

export type AwaitedPublication = {
  readonly page_id: string
  readonly version: string
  readonly content_hash: string
  readonly publication_operation_id: string
  readonly verified: true
}

/** Retained upstream child IDs address the original publication receipt; never allocate a replacement ID. */
export function publicationIdentityForUpstream(operationId: string) {
  return Effect.gen(function* () {
    const hash = yield* sha256(operationId)
    return { id: /^p_[a-zA-Z0-9-]{1,100}$/.test(operationId) ? operationId : `p_${hash}` }
  })
}

export function freezePortable(portable: PortableSkill) {
  return Effect.gen(function* () {
    const store = yield* Store
    const files: Array<{ path: string; hash: string }> = []
    for (const file of [...portable.files].sort((a, b) => a.path.localeCompare(b.path))) {
      const hash = yield* sha256(file.bytes)
      yield* store.writeBytes(`objects/${hash}`, file.bytes)
      files.push({ path: file.path, hash })
    }
    return {
      kind: "skill" as const,
      name: portable.name,
      description: portable.description,
      main: portable.main,
      files,
    } satisfies FrozenPortable
  })
}
export function thawPortable(frozen: FrozenPortable) {
  return Effect.gen(function* () {
    const store = yield* Store
    const files: Array<{ path: string; bytes: Uint8Array }> = []
    for (const file of frozen.files) {
      const bytes = yield* store.readBytes(`objects/${file.hash}`)
      if ((yield* sha256(bytes)) !== file.hash)
        return yield* Effect.fail(
          fail("STATE_CORRUPT", "Frozen upstream file no longer matches the reviewed plan.", {
            path: file.path,
          }),
        )
      files.push({ path: file.path, bytes })
    }
    return {
      kind: "skill" as const,
      name: frozen.name,
      description: frozen.description,
      main: frozen.main,
      files,
    } satisfies PortableSkill
  })
}
export const configOf = (s: Subscription) => ({
  source: s.source,
  roots: s.roots,
  include: s.include,
  exclude: s.exclude,
  mapping: s.mapping,
  target_database_id: s.target_database_id,
  enabled: s.enabled,
  removed: s.removed,
})
export const subscriptionConfigHash = (s: Subscription) => sha256(JSON.stringify(configOf(s)))
export const publicationMemberKey = (s: Subscription, member: string) => {
  const prefix = s.source.strip_prefix?.replace(/\/$/, "")
  const relative =
    prefix && member.startsWith(prefix + "/") ? member.slice(prefix.length + 1) : member
  return s.source.target_prefix ? `${s.source.target_prefix}/${relative}` : relative
}
export const targetKey = (s: Subscription, member: string) =>
  JSON.stringify([
    s.target_database_id,
    s.source.shared_target_set ?? s.subscription_id,
    publicationMemberKey(s, member),
  ])
export const fileHashes = (portable: FrozenPortable) =>
  new Map(portable.files.map((file) => [file.path, file.hash]))
export function contentDeltas(
  before: FrozenPortable | undefined,
  after: FrozenPortable | undefined,
): PlanItem["deltas"] {
  const a = before ? fileHashes(before) : new Map<string, string>(),
    b = after ? fileHashes(after) : new Map<string, string>()
  const paths = [...new Set([...a.keys(), ...b.keys()])].sort()
  return paths
    .filter((path) => a.get(path) !== b.get(path))
    .map((path) => ({ path, before: a.get(path) ?? null, after: b.get(path) ?? null }))
}
/** Apply only this contributor's accepted->candidate delta; peer changes survive. */
export function mergeSharedDelta(
  base: FrozenPortable,
  current: FrozenPortable,
  candidate: FrozenPortable,
): FrozenPortable {
  const before = fileHashes(base),
    live = fileHashes(current),
    next = fileHashes(candidate)
  const conflicts: string[] = []
  for (const delta of contentDeltas(base, candidate)) {
    const currentHash = live.get(delta.path) ?? null
    if (currentHash !== delta.before && currentHash !== delta.after) conflicts.push(delta.path)
    else if (delta.after === null) live.delete(delta.path)
    else live.set(delta.path, delta.after)
  }
  const field = (name: "name" | "description" | "main") => {
    if (base[name] === candidate[name]) return current[name]
    if (current[name] !== base[name] && current[name] !== candidate[name])
      conflicts.push(`@${name}`)
    return candidate[name]
  }
  const name = field("name"),
    description = field("description"),
    main = field("main")
  if (conflicts.length)
    throw fail(
      "UPSTREAM_SHARED_CONFLICT",
      "Contributors changed the same accepted content differently.",
      { paths: conflicts },
    )
  if (!live.has(main))
    throw fail("UPSTREAM_SHARED_CONFLICT", "Contributor delta removed the published entrypoint.")
  return {
    kind: "skill",
    name,
    description,
    main,
    files: [...live].sort(([a], [b]) => a.localeCompare(b)).map(([path, hash]) => ({ path, hash })),
  }
}
export const discover = (s: Subscription, accepted_ref?: string) =>
  discoverSource({
    source: s.source.provider,
    roots: s.roots,
    include: s.include,
    exclude: s.exclude,
    mapping: s.mapping,
    allow_empty: true,
    require_all_included: s.source.require_all_included ?? false,
    ...(s.source.patch ? { patch: s.source.patch } : {}),
    ...(s.source.member_patches ? { member_patches: s.source.member_patches } : {}),
    ...(accepted_ref ? { accepted_ref } : {}),
  })
