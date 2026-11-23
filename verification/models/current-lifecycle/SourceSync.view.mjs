export const title = "Source sync: resume the owned intent before selecting upstream"

const broken = (v) => [
  ...v.violations,
  ...(v.completedSource && !v.source.ready ? ["projection changed content readiness"] : []),
]

const failures = {
  pending: "New decision bypassed the unfinished Source intent",
  projection: "Source changed before the old projection settled",
  frozen: "The Source write changed its frozen commit",
  configuration: "Commit-only no-op ignored changed configuration",
  ownership: "Automatic recovery claimed a foreign intent",
  "projection changed content readiness": "Projection failure made completed content unreadable",
}

export const state = (v) => {
  const failed = broken(v)
  if (failed.length)
    return failed
      .slice()
      .sort()
      .map((name) => failures[name])
      .join("; ")
  if (v.phase === "inspect") {
    if (v.source.intent === "foreign") return "Foreign Source intent awaits its owner"
    if (v.source.intent === "owned")
      return v.source.ready
        ? "Source ready; original retirement pending"
        : "Original Source intent unfinished"
    return "Inspect pending work"
  }
  if (v.phase === "preflight")
    return v.projection.intent === "none"
      ? "Inspect all affected Skill owners"
      : `${v.projection.intent === "owned" ? "Owned" : "Foreign"} projection on ${v.projection.owner === 2 ? "removed" : "retained"} Skill`
  if (v.phase === "old_projection")
    return v.projection.intent === "owned"
      ? "Resume the old owned projection"
      : "Attempt foreign projection recovery"
  if (v.phase === "observe") {
    if (v.source.intent !== "none") return "Check upstream with a Source intent unfinished"
    if (v.projection.intent !== "none") return "Check upstream with an old projection unsettled"
    return v.upstream.config !== v.source.config
      ? "Observe changed Source configuration"
      : "Observe upstream reference"
  }
  if (v.phase === "prepared")
    return v.upstream.commit !== v.source.frozen
      ? "Keep the frozen commit after the branch moves"
      : v.source.intent === "owned"
        ? "Use the original frozen intent"
        : "Candidate commit frozen"
  if (v.phase === "blocked") {
    if (v.source.intent === "foreign" || v.projection.intent === "foreign")
      return "Blocked by a foreign intent"
    if (v.source.intent === "owned") return "Unresolved Source intent retained"
    if (v.projection.intent === "owned") return "Unresolved projection intent retained"
    return "Provider observation failed"
  }
  return {
    applying: "Converge the affected Skills",
    verify: "All affected targets verified",
    retire: "Ready; retire the original Source intent",
    project: "Source complete; project current content",
    complete: "Source and projection complete",
    unchanged: "Upstream and configuration unchanged",
    partial: "Source ready; projection incomplete",
  }[v.phase]
}

export const step = (action) =>
  ({
    InspectIntent: "select the original owned intent or start a check",
    InspectAffectedOwners: "include retained and removed owners",
    SettleOldProjection: "observe the old projection result",
    ObserveRef: "compare the observed commit and configuration",
    ProviderUnavailable: "the provider observation fails",
    BeginSource: "write the exact candidate",
    ApplyChild: "verify the next affected target",
    UnresolvedChild: "a child result cannot be established",
    PublishSource: "publish the verified Source as ready",
    RetireSourceIntent: "retire the completed finite intent",
    ProjectCurrent: "report the independent projection result",
    CrashAndReinvoke: "restart while retaining the finite intent",
    MoveBranch: "the upstream branch moves",
    Done: "keep the explained result",
  })[action] ?? action

export const group = (v) =>
  broken(v).length
    ? "violation"
    : v.phase === "blocked" || v.phase === "partial"
      ? "needsAction"
      : v.phase === "complete" || v.phase === "unchanged"
        ? "complete"
        : "inProgress"

export const colors = {
  violation: "pink",
  needsAction: "orange",
  complete: "teal",
  inProgress: "blue",
}
