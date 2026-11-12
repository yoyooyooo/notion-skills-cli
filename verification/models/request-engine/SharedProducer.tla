----------------------------- MODULE SharedProducer -----------------------------
EXTENDS Naturals, FiniteSets, TLC
CONSTANTS BugCancelAll, BugLeakLast, BugScope, BugBudget, BugQueue, BugService, BugCache, BugCleanup
VARIABLES phase, context, status, active, stopped, joined, delivered, calls, cached, replacementAlive
vars == <<phase, context, status, active, stopped, joined, delivered, calls, cached, replacementAlive>>
Waiters == {1, 2}
Contexts == {"same", "scope", "budget", "queue", "service"}
Compatible ==
  /\ (context # "scope" \/ BugScope)
  /\ (context # "budget" \/ BugBudget)
  /\ (context # "queue" \/ BugQueue)
  /\ (context # "service" \/ BugService)
Init ==
  /\ phase = "ready" /\ context \in Contexts
  /\ status = [w \in Waiters |-> "idle"] /\ active = {}
  /\ stopped = FALSE /\ joined = FALSE /\ delivered = {}
  /\ calls = 0 /\ cached = FALSE /\ replacementAlive = FALSE
StartFirst ==
  /\ phase = "ready" /\ phase' = "first"
  /\ status' = [status EXCEPT ![1] = "waiting"] /\ active' = {1} /\ calls' = 1
  /\ UNCHANGED <<context, stopped, joined, delivered, cached, replacementAlive>>
StartSecond ==
  /\ phase = "first" /\ phase' = "shared"
  /\ status' = [status EXCEPT ![2] = "waiting"]
  /\ active' = IF Compatible THEN {1, 2} ELSE {1}
  /\ joined' = Compatible /\ calls' = IF Compatible THEN 1 ELSE 2
  /\ UNCHANGED <<context, stopped, delivered, cached, replacementAlive>>
Cancel(w) ==
  /\ phase = "shared" /\ status[w] = "waiting"
  /\ status' = [status EXCEPT ![w] = "cancelled"] /\ active' = active \ {w}
  /\ stopped' = IF w \in active /\ (BugCancelAll \/ (active \ {w} = {} /\ ~BugLeakLast))
                  THEN TRUE ELSE stopped
  /\ UNCHANGED <<phase, context, joined, delivered, calls, cached, replacementAlive>>
Complete ==
  /\ phase = "shared" /\ ~stopped /\ active # {}
  /\ phase' = "settled" /\ delivered' = active
  /\ status' = [w \in Waiters |-> IF w \in active THEN "delivered" ELSE status[w]]
  /\ active' = {} /\ cached' = BugCache
  /\ UNCHANGED <<context, stopped, joined, calls, replacementAlive>>
CompleteIndependent ==
  /\ phase = "shared" /\ ~joined /\ status[2] = "waiting"
  /\ phase' = "independent" /\ status' = [status EXCEPT ![2] = "delivered"]
  /\ delivered' = {2}
  /\ UNCHANGED <<context, active, stopped, joined, calls, cached, replacementAlive>>
RestartAfterSettlement ==
  /\ phase = "settled" /\ phase' = "replacement"
  /\ calls' = IF cached THEN calls ELSE calls + 1
  /\ UNCHANGED <<context, status, active, stopped, joined, delivered, cached, replacementAlive>>
FinishCancelled ==
  /\ phase = "shared" /\ \A w \in Waiters: status[w] = "cancelled"
  /\ phase' = "cancelled"
  /\ UNCHANGED <<context, status, active, stopped, joined, delivered, calls, cached, replacementAlive>>
RestartAfterCancellation ==
  /\ phase = "cancelled" /\ stopped /\ phase' = "restarted"
  /\ calls' = calls + 1 /\ replacementAlive' = TRUE
  /\ UNCHANGED <<context, status, active, stopped, joined, delivered, cached>>
LateOldCleanup ==
  /\ phase = "restarted" /\ phase' = "cleanup"
  /\ replacementAlive' = ~BugCleanup
  /\ UNCHANGED <<context, status, active, stopped, joined, delivered, cached, calls>>
Done ==
  /\ phase \in {"settled", "replacement", "independent", "cancelled", "restarted", "cleanup"}
  /\ UNCHANGED vars
Next == StartFirst \/ StartSecond \/ (\E w \in Waiters: Cancel(w)) \/ Complete
        \/ CompleteIndependent \/ RestartAfterSettlement \/ FinishCancelled
        \/ RestartAfterCancellation \/ LateOldCleanup \/ Done
TypeOK ==
  /\ phase \in {"ready", "first", "shared", "settled", "replacement", "independent", "cancelled", "restarted", "cleanup"}
  /\ context \in Contexts /\ status \in [Waiters -> {"idle", "waiting", "cancelled", "delivered"}]
  /\ active \subseteq Waiters /\ stopped \in BOOLEAN /\ joined \in BOOLEAN
  /\ delivered \subseteq Waiters /\ calls \in 0..3 /\ cached \in BOOLEAN /\ replacementAlive \in BOOLEAN
SurvivingWaiterKeepsProducer == (phase = "shared" /\ active # {}) => ~stopped
LastWaiterReleasesProducer ==
  (phase \in {"shared", "cancelled"} /\ active = {} /\ status[1] = "cancelled") => stopped
ScopeIsolated == joined => context # "scope"
BudgetIsolated == joined => context # "budget"
QueueBudgetIsolated == joined => context # "queue"
ServiceIsolated == joined => context # "service"
SettledResultNotReused == phase = "replacement" => calls = (IF joined THEN 2 ELSE 3)
ReplacementSurvivesOldCleanup == phase = "cleanup" => replacementAlive
Spec == Init /\ [][Next]_vars
=============================================================================
