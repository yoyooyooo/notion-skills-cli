import { Effect } from "effect"
import { portableIdentity } from "./export.ts"
import { fail, property } from "./model.ts"
import { Notion } from "./notion.ts"
import { publicationMarker } from "./publication-integrity.ts"
import type { Receipt } from "./publication-model.ts"
import { canonical, observation } from "./publication-observation.ts"
import { sha256, Store } from "./store.ts"
import { thawPortable } from "./upstream-content.ts"
import type { ManagedContent } from "./upstream-model.ts"

/** A mode preflight can fail after binding its ledger and before its first
 * journaled mutation. The previous committed marker is then still correct.
 * This proves only that the original child may enter normal guarded resume;
 * it does not acknowledge a write or commit the requested mode. */
export function proveUnsentModePublication(
  receipt: Receipt,
  expectedVersion: string,
  current: ManagedContent,
) {
  return Effect.gen(function* () {
    if (
      receipt.operation !== "write" ||
      receipt.portable.kind !== "skill" ||
      receipt.state !== "failed" ||
      receipt.conflict ||
      receipt.owner ||
      receipt.result ||
      receipt.intents.length !== 0 ||
      !receipt.context?.ownership ||
      receipt.context.write_path !== undefined ||
      !receipt.page_id ||
      !receipt.database_id ||
      !receipt.data_source_id ||
      !receipt.scope ||
      !["NOTION_REQUEST_FAILED", "NTN_UNAVAILABLE", "RATE_LIMITED"].includes(
        receipt.failure?.code ?? "",
      )
    )
      return false
    const store = yield* Store
    const integrity = yield* store.integrity.inspect(receipt.operation_id)
    const root = `v1/pages/${receipt.page_id}`
    const before = receipt.guards[root]
    const marker = publicationMarker(before)
    if (
      !integrity ||
      integrity.operation_id !== receipt.operation_id ||
      integrity.page_id !== receipt.page_id ||
      integrity.marker.state !== "writing" ||
      integrity.marker.operation_id !== receipt.operation_id ||
      integrity.marker.intended_hash !== integrity.intended_hash ||
      !marker ||
      marker.state !== "committed" ||
      marker.operation_id === receipt.operation_id ||
      marker.intended_hash !== integrity.intended_hash ||
      integrity.marker.base_revision !== marker.revision ||
      property(before).id !== receipt.page_id ||
      property(property(before).parent).data_source_id !== receipt.data_source_id ||
      typeof receipt.guards[root + "/markdown"] !== "string"
    )
      return false
    const frozen = yield* thawPortable({
      ...receipt.portable,
      kind: "skill",
      files: receipt.portable.files.map((file) => ({ path: file.path, hash: file.sha256 })),
    })
    const hash = yield* portableIdentity(frozen)
    const files: Array<readonly [string, number, string]> = []
    for (const file of [...frozen.files].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    ))
      files.push([file.path, file.bytes.length, yield* sha256(file.bytes)])
    const intendedHash = yield* sha256(
      canonical([frozen.kind, frozen.name, frozen.description, frozen.main, files]),
    )
    const owner = receipt.context.ownership
    if (
      current.page_id !== receipt.page_id ||
      current.version !== expectedVersion ||
      intendedHash !== integrity.intended_hash ||
      current.content_hash !== hash ||
      current.ownership?.subscription_id !== owner.subscription_id ||
      current.ownership.member_key !== owner.member_key
    )
      return yield* Effect.fail(
        fail(
          "WRITE_CONFLICT",
          "The unsent mode child no longer matches its frozen content and original target version.",
        ),
      )
    const api = yield* Notion
    for (const [path, saved] of Object.entries(receipt.guards)) {
      const actual = observation(path, yield* api.request(path))
      if (actual === undefined || canonical(actual) !== canonical(saved))
        return yield* Effect.fail(
          fail("WRITE_CONFLICT", "The unsent mode child observed a changed original guard.", {
            path,
          }),
        )
    }
    const finalRoot = yield* api.request(root)
    if (
      canonical(observation(root, finalRoot)) !== canonical(before) ||
      canonical(publicationMarker(finalRoot)) !== canonical(marker)
    )
      return yield* Effect.fail(
        fail("WRITE_CONFLICT", "The original committed marker changed during mode preflight."),
      )
    return true
  })
}
