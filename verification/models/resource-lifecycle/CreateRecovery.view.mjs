export const title = "Recover an acknowledged creation prefix without replay or body replacement"
const faults = (v) => {
  const values = []
  if (!v.admissionsExact) values.push("Original evidence missing")
  if (Object.values(v.attempts).some((n) => n > 1)) values.push("Recovery write repeated")
  if (!v.authorityBeforeWrite) values.push("Projection authority checked too late")
  if (v.bodyWriteSent) values.push("Existing body mutation sent")
  return values
}
const stage = (v) =>
  ({
    1: "Create the missing suffix",
    2: "Update exact Projection metadata",
    3: "Enable the complete tree",
    4: "Record separate completion",
  })[v.step]
export function state(v) {
  const bad = faults(v)
  if (bad.length)
    return [...bad, v.phase === "blocked" ? "Rejected after the write" : v.phase].join(" / ")
  const labels = {
    inspect: "Inspect the original evidence",
    reviewed: "Recovery decision inspected",
    unknown: "Uncertain recovery; reconcile only",
    blocked: "Stop without another write",
    completed: "Recovered; original history preserved",
  }
  if (labels[v.phase]) return labels[v.phase]
  if (v.phase === "ready" && !v.fresh) return "Current scope changed; stop required"
  if (v.phase === "ready" && v.step === 2 && ["other metadata", "body"].includes(v.requestKind))
    return "Unapproved metadata or body request"
  return stage(v)
}
export function step(action) {
  return (
    {
      Review: "inspect the exact original journal, request set and ACKs",
      OriginalSetChanges: "an original receipt becomes unavailable",
      StartSeparateRecovery: "recheck the original evidence before starting",
      RejectOriginalSet: "refuse missing original evidence",
      CurrentScopeChanges: "the current source, owner or body differs",
      RejectCurrentScope: "stop on changed current scope",
      ChooseMetadataRequest: "select the metadata request",
      RejectProjectionRequest: "reject the request before transport",
      PublishInitialEvents: "publish all verified initial file events",
      Dispatch: "authorize the exact request before sending",
      ProviderApplies: "the provider applies the request",
      RequestUncertain: "the request or readback is interrupted",
      PersistRecoveryAck: "retain the exact recovery acknowledgement",
      RejectAfterWrite: "reject after the remote write already happened",
      VerifyStage: "verify the acknowledged stage",
      ReplayIncompleteRecovery: "send again despite the incomplete prior attempt",
      RecordSeparateCompletion: "retain the separate recovery outcome",
      ReadOnlyReconcile: "inspect retained completion without writing",
      Terminal: "keep the terminal result",
    }[action] ?? action
  )
}
export const group = (v) =>
  faults(v).length
    ? "unsafe"
    : v.phase === "completed"
      ? "completed"
      : ["blocked", "unknown"].includes(v.phase)
        ? "stopped"
        : "active"
export const colors = { unsafe: "pink", completed: "teal", stopped: "yellow", active: "blue" }
