export const title = "Freeze import relationships, create the batch, and preserve authored choices"
const phases = {
  input: "Local input admitted",
  creating: "Creating the planned Skill objects",
  unknown: "A create response was lost",
  relating: "All batch objects exist",
  verifying: "Checking the intended relationships",
  complete: "Import completed",
  blocked: "Original intent retained for explicit action",
  rejected: "Rejected before writes",
  repeat: "Author changed Members before repeating import",
}
const same = (left, right) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
export const state = (v) => {
  const expectedA =
    v.scenario === "update-omitted" ? ["manual"] : v.scenario === "new-empty" ? [] : ["b"]
  const expectedB = v.scenario === "cycle" ? ["a"] : []
  const faults = []
  if (v.writes && v.writeLibrary !== v.plannedLibrary)
    faults.push("Write escaped the selected Library")
  if (v.scenario === "foreign-relation" && v.writes)
    faults.push("Foreign relation input caused writes")
  if (
    !["input", "rejected"].includes(v.phase) &&
    (!same(v.frozenMembers.a, expectedA) || !same(v.frozenMembers.b, expectedB))
  ) {
    faults.push("Frozen member intent replaced")
  }
  if (v.scenario === "new-empty" && (v.members.a.length || v.members.b.length))
    faults.push("Explicit empty Members overwritten")
  if (v.scenario === "update-omitted" && !same(v.members.a, ["manual"]))
    faults.push("Existing Members overwritten")
  if (!same(v.requires, v.scenario === "new-explicit" ? ["mandatory"] : []))
    faults.push("Requires inferred")
  if (v.earlyWrite) faults.push("Relations applied before the batch existed")
  if (Object.values(v.calls).some((count) => count > 1)) faults.push("Unknown create repeated")
  if (v.repeated && v.members.a.length) faults.push("Manual deletion overwritten")
  if (v.repeated && v.writes !== v.writesBeforeRepeat) faults.push("Repeated input caused writes")
  if (v.phase === "complete" && (!v.verified || !v.completionSafe))
    faults.push("Unverified completion")
  const context = v.changedDefault
    ? "Production became the default"
    : v.changedCandidates
      ? "Later candidates changed"
      : "Original scope and candidates"
  const recovery =
    v.unknownTarget === "none"
      ? ""
      : v.created.includes(v.unknownTarget)
        ? "; accepted create"
        : "; unobserved create"
  return [phases[v.phase], faults.join("; ") || context + recovery]
}
export const step = (action, from, to) => {
  if (action === "ResumeUnknown") {
    if (Object.values(to.calls).some((count) => count > 1)) return "Replay the unobserved create"
    if (
      !same(from.frozenMembers.a, to.frozenMembers.a) ||
      !same(from.frozenMembers.b, to.frozenMembers.b)
    )
      return "Recompute the frozen Members from later candidates"
  }
  if (action === "ApplyRelations" && to.earlyWrite)
    return "Apply relationships before both objects exist"
  if (action === "ApplyRelations" && !same(from.requires, to.requires))
    return "Infer Requires from a document link"
  if (action === "RepeatOmitted" && to.writes !== from.writes)
    return "Rescan links and overwrite manual Members"
  return (
    {
      FreezePlan: "Freeze exact identities and relationship intent",
      ChangeDefault: "Change the ambient default Library",
      ChangeCandidates: "Change the later observed candidates",
      CreateKnown: "Create one planned Skill",
      CreateUnknown: "Lose a create response",
      Create: "Create a planned Skill or lose its response",
      ResumeUnknown: "Observe the original create before continuing",
      ObjectsReady: "Finish creating both batch objects",
      ApplyRelations: "Apply the frozen relationship sets",
      Verify: "Verify the intended result",
      PrematureComplete: "Declare completion before verification",
      ManualEdit: "The author clears Members",
      RepeatOmitted: "Repeat import with Members omitted",
      Done: "Keep the explained result",
    }[action] ?? action
  )
}
