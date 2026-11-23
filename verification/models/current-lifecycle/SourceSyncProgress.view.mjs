export const title = "Source sync progress: retain verified prefixes and qualify child retirement"

const failures = (v) => [
  ...v.violations,
  ...(Object.entries(v.cursors).some(([s, n]) =>
    Array.from({ length: n }, (_, i) => i + 1).some((i) => !v.verified[s].includes(i)),
  )
    ? ["cursor skipped verification"]
    : []),
  ...(Object.values(v.results).includes("retry") ? ["retry saved as terminal"] : []),
  ...(v.phase === "finished" && v.hardSeen && !v.reportedFailure ? ["hard failure forgotten"] : []),
]

export const state = (v) => {
  const broken = failures(v)
  if (broken.length) return "Violation: " + broken.slice().sort().join(", ")
  if (v.phase === "finished")
    return v.reportedFailure ? "Sweep finished with retained hard failure" : "Sweep complete"
  if (v.phase === "blocked") return "Blocked by changed recovery identity"
  const completed = Object.values(v.results).length
  const source = completed + 1
  const cursor = v.cursors[source] ?? 2
  const needsCleanup = Object.entries(v.childPending).some(
    ([id, pending]) => pending && Number(id) <= completed && v.results[id] === "ok",
  )
  const qualified =
    v.settling > 0 &&
    v.results[v.settling] === "ok" &&
    v.parentProof[v.settling] === v.cursorInput[v.settling]
  const label = {
    preflight: needsCleanup ? "Parent saved; select child cleanup" : "Check complete scope",
    target: "Project next target",
    checkpoint: "Verified target; cursor not yet saved",
    source_result:
      v.outcome === "retry" ? "Retryable source is unfinished" : "Save terminal source result",
    cleanup: qualified ? "Retire exactly completed child" : "Reject mismatched parent completion",
    paused: "Budget or process stopped; keep prefixes",
  }[v.phase]
  return `${label}; ${completed}/2 Sources, ${cursor}/2 targets`
}

export const step = (action) =>
  ({
    CheckSource: "validate the current scope and frozen input",
    ProjectTarget: "verify only the next remaining target",
    SaveProjectionCursor: "save the next verified target cursor",
    TemporaryFailure: "stop safely with a retryable result",
    RecordSourceResult: "append only the next terminal source result",
    BeginCompletedCleanup: "select saved parent completion for local cleanup",
    RetireCompletedChild: "retire only its exactly qualified completed child",
    RetireBeforeParent: "retire the child before parent completion (fault)",
    PauseBudget: "stop when this invocation has no budget",
    CrashBeforeCursorSave: "lose the process before saving this target",
    CrashAfterParentSave: "lose the process after saving parent completion",
    Resume: "renew the budget with the same saved prefixes",
    Finish: "report all results and retire the full sweep",
    Done: "keep the explained outcome",
  })[action] ?? action

export const group = (v) =>
  failures(v).length
    ? "violation"
    : v.phase === "finished"
      ? "complete"
      : v.phase === "paused" || v.phase === "blocked"
        ? "needsAction"
        : "inProgress"
export const colors = {
  violation: "pink",
  complete: "teal",
  needsAction: "orange",
  inProgress: "blue",
}
