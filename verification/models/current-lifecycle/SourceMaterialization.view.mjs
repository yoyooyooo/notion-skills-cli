export const title = "Materialize requested members while retaining the registered Source"

const subset = (left, right) => left.every((value) => right.includes(value))
const same = (left, right) => subset(left, right) && subset(right, left)
const active = (v) => ["A", "B"].filter((w) => ["frozen", "written", "bound"].includes(v.phase[w]))
const failures = (v) => [
  ...(active(v).length > 1 ? ["Concurrent Source plans"] : []),
  ...(!subset(v.published, v.contributions) || !subset(v.published, v.manifest)
    ? ["An existing contribution disappeared"]
    : []),
  ...(v.sourceReady &&
  v.ready.some(
    (member) =>
      !v.contributions.includes(member) ||
      !v.manifest.includes(member) ||
      !same(v.descriptors[member], v.manifest),
  )
    ? ["Ready owner names another revision"]
    : []),
  ...(v.ready.includes("legacy") || v.descriptors.legacy.length > 0
    ? ["An unrequested legacy sibling changed"]
    : []),
]

export const state = (v) => {
  const broken = failures(v)
  if (broken.length) return broken.join("; ")
  const writers = active(v)
  if (writers.length === 1)
    return {
      frozen: "Freeze the additive member set",
      written: "Source declared; selected owners not yet published",
      bound: "Current owners refer to the complete revision",
    }[v.phase[writers[0]]]
  if (["A", "B"].every((w) => ["complete", "blocked"].includes(v.phase[w])))
    return "Both requests explained; legacy sibling unchanged"
  if (["A", "B"].some((w) => v.phase[w] === "complete"))
    return "One member published; next request may enter"
  return "Registered Source; requested members not initialized"
}

export const step = (action) =>
  ({
    ReadAndFreeze: "admit one original request before reading",
    PublishPlan: "retain the existing plan and contributions",
    BindSelectedOwners: "verify ready owners and requested members",
    Finish: "publish only after the exact Source readback",
    Done: "retain the explained result",
  })[action] ?? action
export const group = (v) =>
  failures(v).length
    ? "violation"
    : ["A", "B"].every((w) => v.phase[w] === "complete")
      ? "complete"
      : "progress"
export const colors = { violation: "pink", complete: "teal", progress: "blue" }
