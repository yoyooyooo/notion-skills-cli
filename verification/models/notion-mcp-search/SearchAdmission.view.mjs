export const title = "Notion remote search admission before disclosure"
export const state = (v) => {
  if (v.dispatchConnection === "other") return "Query sent to a different connection"
  if (v.violations.length) return "Violation: " + v.violations.slice().sort().join(", ")
  if (v.selected[1] !== 1) return "Search changed a fixed pin"
  if (v.proof === "exact_consumption_bytes") return "Remote hit misreported as exact bytes"
  if (v.phase === "done")
    return (
      {
        results: "Scoped match published",
        retired: "Retired result discarded",
        no_remote_hits: "No remote hits; completeness unknown",
        not_admitted: "Candidate denied",
        unsupported_response: "Unexpected response rejected",
        timed_out: "Request timed out",
        cancelled: "Request cancelled",
        remote_error: "Remote error",
      }[v.outcome] ?? v.outcome
    )
  if (v.changed) return "Context changed; revalidation required"
  return {
    new: "Check search policy",
    prepared: "Connection and scope resolved",
    sent: "Remote search pending",
    received: "Untrusted candidate received",
    admitted: "Candidate admitted; publication pending",
  }[v.phase]
}
export const step = (a) =>
  ({
    Preflight: "check mode and both authorizations",
    Dispatch: "dispatch remote search",
    Receive: "receive remote candidate",
    Admit: "process candidate admission",
    Publish: "publish search result",
    Change: "change one context epoch",
    Cancel: "cancel request",
    RemoteError: "remote error",
    Tick: "deadline advances",
    Timeout: "deadline expires",
    Done: "finished",
  })[a] ?? a
