export const title = "A disconnected writer keeps the original Source admission"

const failures = (v) => [
  ...(["dispatched", "unknown"].includes(v.phase) && !v.durable
    ? ["Mutation has no durable original"]
    : []),
  ...(v.sent > 1 ? ["Unknown mutation sent again"] : []),
  ...(["observed", "complete"].includes(v.phase) && v.outstanding > 0
    ? ["Current equality hid an outstanding original"]
    : []),
  ...(["unknown", "blocked"].includes(v.phase) && (!v.durable || v.gate !== "old")
    ? ["Unknown original released its admission"]
    : []),
  ...((v.outstanding > 0 || v.pendingChildren.length > 0) && (v.gate !== "old" || !v.durable)
    ? ["A late mutation escaped its admission"]
    : []),
  ...(["admitted", "complete"].includes(v.successor) && v.outstanding > 0
    ? ["Successor entered before settlement"]
    : []),
  ...((v.phase === "complete" || ["admitted", "complete"].includes(v.successor)) &&
  v.pendingChildren.length > 0
    ? ["Parent replaced before every original child settled"]
    : []),
  ...(v.successorComplete && v.value !== "new" ? ["Late original overwrote the successor"] : []),
]

export const state = (v) => {
  const broken = failures(v)
  if (broken.length) return broken.join("; ")
  if (v.successor === "complete") return "Successor complete; old mutation cannot return"
  if (v.successor === "admitted") return "Successor owns the same Source admission"
  if (v.phase === "blocked")
    return v.successor === "blocked"
      ? "Original unresolved; successor refused"
      : "Original unresolved; admission retained"
  if (v.phase === "unknown") {
    if (v.cancelled) return "Caller detached; original mutation still owned"
    return v.applied === 0
      ? "Response lost; server may still apply"
      : "Response lost; inspect exact original witness"
  }
  if (v.phase === "dispatched")
    return v.applied === 0
      ? "Original mutation submitted"
      : "Server applied; response not yet observed"
  if (v.phase === "observed" && v.pendingChildren.length > 0)
    return "Parent settled; original children still outstanding"
  return {
    new: "No original request admitted",
    saved: "Original intent persisted before dispatch",
    observed: "Exact original completion established",
    complete: "Original retired; successor may enter",
  }[v.phase]
}

export const step = (action) =>
  ({
    SaveOriginal: "persist the original admission",
    DispatchOriginal: "submit the one frozen mutation",
    LoseResponse: "the connection loses the response",
    ApplyOriginal: "the server applies its accepted mutation",
    ReceiveOriginalResponse: "receive this request's successful response",
    ObserveOriginal: "observe a unique completion witness",
    ReplayUnknown: "send the unresolved mutation again",
    ExplainUnknown: "retain an unresolved original",
    CancelWaiter: "detach the caller",
    RetireOriginal: "retire the explained original",
    AdmitSuccessor: "admit the next Source request",
    RefuseSuccessor: "report the retained original",
    PublishSuccessor: "publish the next Source result",
    SettleChild: "observe this original child's causal completion",
    ExplainChildren: "retain the parent while an original child is unknown",
    Done: "retain the explained result",
  })[action] ?? action
export const group = (v) =>
  failures(v).length
    ? "violation"
    : v.phase === "blocked"
      ? "needsAction"
      : v.successor === "complete"
        ? "complete"
        : "progress"
export const colors = {
  violation: "pink",
  needsAction: "orange",
  complete: "teal",
  progress: "blue",
}
