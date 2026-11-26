# RefreshRotation — design model, not production refinement

Two processes share one OAuth grant. Each refreshes once; the negative replay case permits one extra attempt. One local logout/config epoch change, two abstract deadline ticks, and at most four server rotations are finite bounds. The server may accept a current or immediately previous revision, return an error, or consume a refresh while its response is lost. No credential bytes or live service are involved.

The candidate takes an exclusive per-grant lock, rereads persistent revision inside the lock, holds the lock through the remote request and commit, and compares both revision and credential epoch before persisting. Ambiguous completion returns reauthorization-required; it does not replay the old refresh token. Requests may complete, fail, need reauthorization, or time out. Termination assumes weak fairness only for the local clock/deadline actions; user authorization or network success is not assumed.

Ghost violation flags record whether a forbidden event occurred; later logout does not retroactively invalidate an earlier legitimate commit. The model does not prove filesystem lock semantics, atomic rename/fsync durability, actual OAuth parser/PKCE/issuer validation, server behavior, revocation of already dispatched HTTP, cross-machine locking, or production code refinement. Those require controlled implementation tests and live acceptance.

The negative revision_race disables both exclusivity and revision CAS so the second defensive guard has a reachable race. It is a deliberate compound design counterexample, not a claim of a single production mutation. The success_witness intentionally negates all-process success; its expected counterexample proves a successful sequential two-process trace is reachable. This is a reachability witness, not a safety regression.

Expected rule/broken inventories were written before execution. The generated view coarsens independent deadline values and actor identity; it keeps distinct violation combinations, ambiguous completion, logout, pending response, and successful commit. It hides no action; same-label transitions are omitted by statechart itself.

## Crash window extension (v5)

A durable in-flight marker is written before dispatch. Normal CAS commit clears that marker atomically with token replacement. A single process may crash before dispatch, in flight, or after receiving a response. Its lock is released but the marker remains; a successor under the lock detects the abandoned marker and returns reauthorization-required. The ghost ambiguousCrash records the possible consumption separately from that durable implementation state. Removing the abandoned-marker guard must expose old-token replay. The no-lock counterexample can also overwrite the other process marker, so its predeclared broken inventory includes NoAbandonedReplay. An extra one-process positive configuration produces a readable full chart.

The model assumes the marker write and successful commit are durable atomic storage operations. Power-loss/fsync behavior and a real crashed subprocess must be verified by implementation-level tests. Conservative recovery can request authorization even when a process crashed after writing the marker but before sending HTTP; that availability tradeoff is deliberate.

## View review (v6)

The view binds its acquisition labels to the checked configuration, so negative cases never claim that an omitted reread or lock occurred. Commit is neutrally labelled as committing a result; the violation names explain which omitted guard made it invalid. Abandoned-marker states distinguish awaiting takeover, entering despite an abandoned marker, and overwriting that marker. The full single-process chart keeps terminal abandoned markers visible. Chinese punctuation was removed from the title to avoid a frozen renderer escaping defect; no model transition or rule changed.

## Independent timeout and definitive rejection correction (v7)

Independent review found that the previous global Timeout ended both callers together and could not expose takeover after only one caller timed out. Each process now has its own bounded clock, its own weakly fair deadline, and a dispatch deadline guard. A terminal owner retaining an in-flight marker (including timeout) is treated as an abandoned attempt. No fresh request may overwrite that marker or replay its refresh token. A separate timeout-replay negative configuration disables process crashes; its expected violation must therefore come from timeout takeover. Network cancellation does not establish that the server did not consume the token.

Reject now explicitly represents a definitive grant rejection: it sets reauth_required (without overriding logged_out), retains the unresolved marker, and does not automatically start OAuth. This abstracts the chosen response policy, not actual invalid_grant or HTTP error parsing. The model's known-late commit guard also checks the caller deadline. Fairness assumes each local deadline is eventually serviced; no remote response is assumed. The successful candidate remains bounded to two processes, one crash and one credential epoch change, each with two abstract time ticks.
