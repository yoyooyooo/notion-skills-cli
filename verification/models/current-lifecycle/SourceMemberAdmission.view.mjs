export const title = "Classify each member before dispatch; preserve both cache generations"

const members = ["plain", "patched", "ready"]
const failures = (v) => [
  ...(members.some((m) => v.exposed[m] === "materializable" && v.observedVersion[m] !== 2)
    ? ["Legacy candidate became actionable"]
    : []),
  ...(["candidate", "manager", "done"].includes(v.phase.patched) && v.exposed.patched !== "blocked"
    ? ["Transformed member appears writable"]
    : []),
  ...(v.phase.ready !== "new" && v.exposed.ready !== "ready"
    ? ["Ready content was downgraded"]
    : []),
  ...(members.some((m) => v.oldSlot[m] !== 1) ? ["Old reader slot was overwritten"] : []),
  ...(members.some((m) => v.exposed[m] === "blocked" && v.requested.includes(m))
    ? ["Blocked candidate was dispatched"]
    : []),
  ...(v.writes.some((m) => m !== "plain") ? ["Manager accepted transformed bytes"] : []),
]
const complete = (v) => members.every((m) => v.phase[m] === "done") && v.forgedDone
export const state = (v) => {
  const broken = failures(v)
  if (broken.length) return broken.join("; ")
  if (complete(v)) return "Ready readable; blocked explained; plain member written"
  if (members.some((m) => v.phase[m] === "manager"))
    return "Manager independently checks selected bytes"
  if (members.some((m) => v.phase[m] === "candidate"))
    return "Use ready content or dispatch only materializable"
  if (members.some((m) => v.phase[m] === "fresh"))
    return "Fresh version two candidate; old slot unchanged"
  if (members.some((m) => v.phase[m] === "lookup"))
    return "Legacy slot ignored; discover exact member metadata"
  return "Physical ready and both candidate cache generations"
}
export const step = (action) =>
  ({
    ReadCandidate: "read the current slot without upgrading legacy capability",
    Discover: "classify the member and persist only version two",
    ReadFresh: "reuse the fresh version two observation",
    Choose: "keep ready and blocked requests out of management",
    Manager: "verify original bytes before writing",
    ForgedManagerRequest: "reject a transformed request submitted directly",
    Done: "retain the explained results",
  })[action] ?? action
export const group = (v) =>
  failures(v).length ? "violation" : complete(v) ? "complete" : "progress"
export const colors = { violation: "pink", complete: "teal", progress: "blue" }
