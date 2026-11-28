export const title = "Notion MCP authorization bounded design model"
export const state = (v) => {
  if (v.violations.length) return "Violation: " + v.violations.slice().sort().join(", ")
  if (v.exchanges > 1) return "Authorization code consumed twice"
  const w = Object.values(v.w)
  if (w.every((s) => s === "new")) return "Choose credential"
  if (w.every((s) => s === "ready")) return "Both requests ready"
  if (w.every((s) => !["new", "waiting"].includes(s)))
    return "Requests finished: " + [...new Set(w)].sort().join(", ")
  if (v.credentialEpoch) return "Grant revoked; old request pending"
  if (v.sessionEpoch) return "Session changed; old request pending"
  if (w.includes("cancelled")) return "One waiter cancelled; other remains"
  return (
    {
      pending: "Waiting for browser",
      exchanging: "Callback accepted; exchanging code",
      returned: "Tokens returned; commit pending",
      committed: "Grant saved; resume pending",
      rejected: "Callback rejected; wait bounded",
      retired: "Auth retired; wait bounded",
    }[v.auth] ?? "Waiting"
  )
}
export const step = (a) =>
  ({
    Start: "resolve credential policy",
    ReceiveCallback: "receive callback",
    ExchangeReturns: "token response arrives",
    CommitGrant: "validate and save grant",
    Publish: "resume eligible waiter",
    Cancel: "cancel one waiter",
    Logout: "log out",
    SwitchSession: "change session",
    Tick: "deadline advances",
    Timeout: "wait expires",
    Done: "finished",
  })[a] ?? a
export const forConfig = (text) => {
  if (!text.includes('Fault = "no_timeout"')) return { title, state, step }
  return {
    title: "Authorization wait without a timeout temporal counterexample",
    state: (v) =>
      "Request one " +
      v.w[1] +
      ", request two " +
      v.w[2] +
      "; authorization " +
      v.auth +
      "; deadline " +
      (v.tick === 2 ? "reached" : v.tick === 1 ? "near" : "open") +
      "; grant " +
      (v.grant ? "saved" : "absent") +
      "; account " +
      (v.credentialEpoch ? "revoked" : "current") +
      "; session " +
      (v.sessionEpoch ? "changed" : "current") +
      "; callback " +
      (v.callbackValid ? "valid" : "invalid") +
      "; exchanges " +
      v.exchanges,
    step,
  }
}
