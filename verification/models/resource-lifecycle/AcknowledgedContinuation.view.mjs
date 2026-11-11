export const title = "Continue acknowledged original allocations and exact native restoration"
const faults = (v) => [
  ...(!v.authorityExact ? ["Original request or ACK set incomplete"] : []),
  ...(!v.bodyCheckedBeforeWrite ? ["Changed body passed the write boundary"] : []),
  ...(Object.values(v.attempts).some((n) => n > 1) ? ["Uncertain continuation repeated"] : []),
  ...(v.coldVerified && v.proofs.length !== v.originalPages.length
    ? ["Cold result lacks full original shared proofs"]
    : []),
]
export function state(v) {
  const bad = faults(v)
  if (bad.length) return bad.join(" / ")
  const label = {
    inspect: "Inspect the complete original allocation set",
    reviewed: "Inspect the separate original continuation decision",
    unknown: "Uncertain continuation; reconcile only",
    blocked: "Stop without another dispatch",
    completed: "Read the immutable shared proof chain",
    "cold verified": "Cold completion verified",
  }[v.phase]
  if (label) return label
  if (v.phase === "ready" && !v.fresh) return "Current body changed; stop required"
  return (
    v.originalPages.length === 1
      ? {
          1: "Retain original main ACK and restoration review",
          2: "Allocate the original never-dispatched reference",
          3: "Publish the complete original initial events",
          4: "Enable the complete tree",
          5: "Retain the separate restoration completion",
        }
      : {
          1: "Retain original ACK facts",
          2: "Publish exact metadata and initial events",
          3: "Enable the complete tree",
          4: "Retain the separate completion",
        }
  )[v.step]
}
export function step(action) {
  return (
    {
      Review: "check every original request and durable ACK",
      LoseOriginalEvidence: "an original receipt becomes unavailable",
      Begin: "recheck the exact original set before apply",
      RejectOriginalEvidence: "refuse incomplete or extra original attempts",
      CurrentBodyChanges: "an observed body changes",
      RejectCurrentBody: "refuse the changed body before transport",
      Dispatch: "send one original authorized continuation request",
      ProviderApplies: "the provider applies the request",
      PersistAck: "retain its original ACK",
      VerifyStage: "verify the acknowledged stage",
      RequestUncertain: "the response or readback becomes uncertain",
      ResumeAcknowledgedStage: "observe the exact original ACK without another dispatch",
      ReplayIncompleteContinuation: "repeat the uncertain original request",
      ProofUnavailable: "a full shared ACK fact becomes unavailable",
      ColdVerify: "independently check complete immutable proofs",
      ColdReject: "refuse incomplete immutable evidence",
      ReadOnlyReconcile: "read the original operation without writing",
      Terminal: "retain the terminal result",
    }[action] ?? action
  )
}
export const group = (v) =>
  faults(v).length
    ? "unsafe"
    : v.phase === "cold verified"
      ? "completed"
      : ["blocked", "unknown"].includes(v.phase)
        ? "stopped"
        : "active"
export const colors = { unsafe: "pink", completed: "teal", stopped: "yellow", active: "blue" }
