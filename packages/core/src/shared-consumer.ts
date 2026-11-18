import { openSharedSnapshot, type OpenSharedSnapshotInput } from "./shared-snapshot.ts"

/** All current shared Skills use the same per-file authority contract. */
export function openSharedConsumer(input: OpenSharedSnapshotInput) {
  return openSharedSnapshot(input)
}
