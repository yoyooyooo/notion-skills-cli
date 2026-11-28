export const title = "Current content, finite intent and consumer publication"
export const state = (v) => ({
  "Content owner": v.trashed
    ? "Original page in Trash"
    : v.ownerState === "ready"
      ? "Content readable"
      : v.ownerOperation === "foreign"
        ? "Another writer owns content"
        : "Content write incomplete",
  "Finite intent": {
    idle: "No intent",
    active: "Action prepared",
    unknown: "Outcome unknown",
    observed: "Result observed",
    verified: "Target verified",
    retiring: "Retiring intent",
    retired: "Complete",
    blocked: "Needs explicit action",
  }[v.phase],
  "Current read": {
    idle: "No read",
    metadata: "Identity observed",
    body: "Bytes acquired",
    published: v.publicationSafe ? "Consistent selection" : "Mixed selection published",
    rejected: "Read rejected",
  }[v.readPhase],
})
const labels = {
  Start: "Start the declared operation",
  DispatchKnown: "Observe an accepted write",
  DispatchUnknown: "Lose the write response",
  ResumeUnknown: "Resume against current facts",
  VerifyTarget: "Verify the complete target",
  ForeignWriterStarts: "Another writer changes content",
  ForeignWriterFinishes: "The other writer becomes ready",
  Finish: "Check owner before completion",
  Retire: "Retire the finite intent",
  BeginRead: "Read current identity",
  ReadBody: "Acquire bytes",
  PublishRead: "Check identity again",
  Done: "Keep the explained result",
}
export const step = (action) => labels[action] ?? action
export const group = (v) =>
  !v.publicationSafe || v.nonContentOwnerWrite || (v.phase === "retired" && !v.completionSafe)
    ? "violation"
    : v.phase === "blocked"
      ? "needsAction"
      : v.phase === "retired"
        ? "complete"
        : "inProgress"
export const colors = {
  violation: "pink",
  needsAction: "orange",
  complete: "teal",
  inProgress: "blue",
}
