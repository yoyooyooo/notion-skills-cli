export const title = "Bind a Skill reference and select its exact manifest file"
const fixed = (v) =>
  ["fixed-file", "fixed-entry", "foreign-manifest", "missing-manifest", "missing-path"].includes(
    v.scenario,
  )
const source = (v) => v.scenario.startsWith("source-")
const selected = (v) => ["selected", "returned"].includes(v.phase)
function faults(v) {
  const result = []
  const expectedLibrary = ["explicit-library", "explicit-conflict"].includes(v.scenario)
    ? "production"
    : v.scenario === "no-context"
      ? "none"
      : "test"
  if (v.scenario === "explicit-conflict" && ["bound", "selected", "returned"].includes(v.phase))
    result.push("Complete reference conflicts with explicit call scope")
  if (
    ["bound", "selected", "returned"].includes(v.phase) &&
    (expectedLibrary === "none" || v.boundLibrary !== expectedLibrary)
  )
    result.push("Library context was guessed or replaced")
  if (selected(v)) {
    const library = v.selectedSnapshot.startsWith("t") ? "test" : "production"
    const skill = v.selectedSnapshot.includes("r") ? "reviewer" : "architect"
    if (library !== v.boundLibrary || skill !== v.boundSkill)
      result.push("Selected owner is different")
    if (v.scenario === "duplicate-id") result.push("Duplicate identity was accepted")
    if (v.scenario === "missing-manifest") result.push("Missing manifest was replaced")
    if (fixed(v)) {
      const snapshot = v.scenario === "foreign-manifest" ? "pa1" : "ta1"
      const path =
        v.scenario === "fixed-entry"
          ? "SKILL.md"
          : v.scenario === "missing-path"
            ? "new.md"
            : "references/guide.md"
      if (v.selectedSnapshot !== snapshot || v.selectedPath !== path || path === "new.md") {
        result.push("Fixed manifest selection changed")
      }
    }
    if (source(v) && v.scenario !== "source-valid") result.push("Source authority was missing")
    if (source(v) && (library !== v.boundLibrary || skill !== "reviewer"))
      result.push("Containing Skill pin was reused")
  }
  if (v.semanticWrites) result.push("Resolution wrote remotely")
  return result
}
export const state = (v) => {
  const bad = faults(v)
  if (bad.length)
    return [
      v.phase === "bound"
        ? "Invalid Library binding"
        : v.phase === "returned"
          ? "Invalid reference returned"
          : "Invalid manifest selection",
      bad.join("; "),
    ]
  if (v.phase === "rejected") return ["Rejected", v.reason]
  const context =
    v.scenario === "document"
      ? v.ambientLibrary + " default"
      : fixed(v)
        ? v.liveChanged
          ? "Current entrypoint changed"
          : "Original current entrypoint"
        : source(v)
          ? "Source containing-file context"
          : "Explicit or bound entry context"
  if (v.phase === "parsed") return ["Reference awaits Library binding", context]
  if (v.phase === "bound") return ["Library bound", v.boundLibrary + "/" + v.boundSkill, context]
  return [
    v.phase === "returned" ? "Exact reference returned" : "Exact manifest file selected",
    source(v)
      ? "Target Skill selection"
      : fixed(v)
        ? "Requested fixed selection"
        : "Current stable identity",
  ]
}
export const step = (action, from, to) => {
  if (action === "BindContext" && faults(to).length)
    return "Bind using an unrelated or missing context"
  if (action === "SelectCurrent" && selected(to)) {
    if (to.scenario === "missing-id") return "Substitute a same-name object"
    if (to.scenario === "duplicate-id") return "Choose one duplicate identity"
  }
  if (action === "SelectFixed" && selected(to)) {
    if (to.scenario === "missing-manifest") return "Substitute current for a missing manifest"
    if (to.scenario === "foreign-manifest") return "Accept another Library's manifest"
    if (to.scenario === "missing-path") return "Fill the missing path from current"
    if (faults(to).length) return "Use the current entrypoint for a fixed selection"
  }
  if (action === "SelectSourceRelative" && selected(to) && faults(to).length) {
    return to.scenario === "source-valid"
      ? "Reuse the containing Skill's pin"
      : "Substitute a file without Source authority"
  }
  if (action === "ReturnSelection" && to.semanticWrites)
    return "Write remotely while returning a reference"
  return (
    {
      ChangeDefault: "Change the ambient default Library",
      ChangeLiveEntrypoint: "Change the current entrypoint",
      BindContext: "Bind the explicit or containing Library",
      SelectCurrent: "Resolve the complete stable identity",
      SelectFixed: "Select only from the requested manifest",
      SelectSourceRelative: "Resolve the original Source path",
      ReturnSelection: "Return the selected reference",
      Done: "Keep the explained result",
    }[action] ?? action
  )
}
