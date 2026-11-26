export const title = "Create and verify a Library root without changing its original operation"

const resume = new Set([
  "replacement-table",
  "pending-key-drift",
  "changed-default",
  "foreign-pending",
  "new-root-old-pending",
  "root-observation-conflict",
])
const bootstrap = new Set([
  "fresh",
  "root-lost-visible",
  "root-lost-hidden",
  "table-lost-visible",
  "table-lost-hidden",
  "incomplete-readback",
])
const roles = ["skills", "files", "sources", "records"]
const sameTables = (a, b) => roles.every((role) => a[role] === b[role])
const unique = (bindings) =>
  Object.values(bindings).every((id) => id !== "none") &&
  new Set(Object.values(bindings)).size === 4
const faults = ({ scenario, s }) => {
  const bad = []
  if (s.rootWithoutIntent) bad.push("root CREATE preceded durable intent")
  if (s.rootCalls > 1 || Object.values(s.tableCalls).some((n) => n > 1))
    bad.push("unknown CREATE replayed")
  if (
    (s.firstRoot !== "none" && s.knownRoot !== s.firstRoot) ||
    roles.some((r) => s.firstTables[r] !== "none" && s.knownTables[r] !== s.firstTables[r])
  )
    bad.push("known binding replaced")
  if (
    resume.has(scenario) &&
    s.admitted &&
    ["foreign-pending", "new-root-old-pending"].includes(scenario)
  )
    bad.push("foreign original intent admitted")
  if (resume.has(scenario) && s.admitted && !s.foundOriginalPending)
    bad.push("table-based key hid original pending")
  if (s.phase === "blocked" && s.inFlight !== "none" && s.intent !== "op")
    bad.push("unknown intent lost")
  if (
    resume.has(scenario) &&
    ((s.readRoot !== "none" && s.readRoot !== s.firstRoot) ||
      (s.accepted && !sameTables(s.readTables, s.firstTables)))
  )
    bad.push("operation target changed")
  if (!bootstrap.has(scenario) && !resume.has(scenario) && s.semanticWrites)
    bad.push("inspection wrote")
  if (s.phase === "ready") {
    const requested = ["copied-root", "new-root-old-pending"].includes(scenario) ? "B" : "A"
    if (s.readDescriptorRoot !== s.readRoot || s.readRoot !== requested)
      bad.push("descriptor is not requested root")
    const parent = (db) =>
      scenario === "moved-table" && db === "AS" ? "B" : db.startsWith("B") ? "B" : "A"
    if (roles.some((r) => parent(s.readTables[r]) !== s.readRoot))
      bad.push("database has another direct parent")
    const dsParent = (ds) =>
      scenario === "foreign-data-source" && ds === "as" ? "BS" : ds.toUpperCase()
    if (roles.some((r) => dsParent(s.readSources[r]) !== s.readTables[r]))
      bad.push("data source belongs to another database")
    if (!unique(s.readTables) || !unique(s.readSources)) bad.push("roles incomplete or duplicated")
    if (
      !s.rootExists ||
      !s.descriptorPresent ||
      [...s.createdTables].length !== 4 ||
      !s.completeReadback
    )
      bad.push("incomplete readback published")
  }
  return bad
}
export const state = (v) => {
  const { scenario, s } = v
  const bad = faults(v)
  return [
    bad.length ? "Violation: " + bad.join("; ") : scenario + ": " + s.phase,
    "Root " + s.firstRoot + " / known " + s.knownRoot + " / observed " + s.readRoot,
    "Intent " +
      s.intent +
      "; root calls " +
      s.rootCalls +
      "; table calls " +
      Object.values(s.tableCalls).join("/"),
    s.reason || (s.accepted ? "Complete admission accepted" : "Admission unfinished"),
  ]
}
export const step = (action) =>
  ({
    Admit: "Load original intent or persist a new one",
    DispatchRoot: "Dispatch root CREATE",
    ReturnRoot: "Observe the root request outcome",
    ReconcileRoot: "Observe the original root without replay",
    DispatchTable: "Dispatch the next role CREATE",
    ReturnTable: "Observe the role request outcome",
    ReconcileTable: "Observe the original role without replay",
    WriteDescriptor: "Write the four registered role bindings",
    ReadLibrary: "Read the exact root and independent physical objects",
    Verify: "Check identity, physical ownership, complete readback and original binding",
    Publish: "Publish Ready and preserve the original mutation target",
    Done: "Retain the explained outcome",
  })[action] ?? action
export const group = (v) =>
  faults(v).length
    ? "violation"
    : v.s.phase === "ready"
      ? "complete"
      : ["blocked", "rejected"].includes(v.s.phase)
        ? "needsAction"
        : "inProgress"
export const colors = {
  violation: "pink",
  complete: "teal",
  needsAction: "orange",
  inProgress: "blue",
}
