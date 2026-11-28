----------------------------- MODULE SharedProducer -----------------------------
EXTENDS Naturals, FiniteSets, TLC
CONSTANTS BugCancelAll, BugLeakLast, BugScope, BugBudget, BugQueue, BugService,
          BugCache, BugCleanup, BugCreatorScope, BugCapacity, BugEarlyRelease
VARIABLES phase, context, domain, limit, status, active, stopped, joined, delivered,
          calls, cached, replacementAlive, replacementShared, admitted, cleanupPending
vars == <<phase, context, domain, limit, status, active, stopped, joined, delivered,
          calls, cached, replacementAlive, replacementShared, admitted, cleanupPending>>
Waiters == {1, 2}
Contexts == {"same", "scope", "budget", "queue", "service"}
Domains == {"transport", "immutable"}
Compatible ==
  /\ (context # "scope" \/ BugScope)
  /\ (context # "budget" \/ BugBudget)
  /\ (context # "queue" \/ BugQueue)
  /\ (context # "service" \/ domain = "immutable" \/ BugService)
CanAdmit == admitted < limit \/ BugCapacity
Init ==
  /\ phase = "ready" /\ context \in Contexts
  /\ domain \in Domains /\ limit \in {1, 2}
  /\ status = [w \in Waiters |-> "idle"] /\ active = {}
  /\ stopped = FALSE /\ joined = FALSE /\ delivered = {}
  /\ calls = 0 /\ cached = FALSE /\ replacementAlive = FALSE
  /\ replacementShared = FALSE /\ admitted = 0 /\ cleanupPending = FALSE
StartFirst ==
  /\ phase = "ready" /\ phase' = "first"
  /\ status' = [status EXCEPT ![1] = "waiting"] /\ active' = {1} /\ calls' = 1
  /\ admitted' = IF domain = "immutable" THEN 1 ELSE 0
  /\ UNCHANGED <<context, domain, limit, stopped, joined, delivered, cached,
                 replacementAlive, replacementShared, cleanupPending>>
StartSecond ==
  /\ phase = "first" /\ phase' = "shared"
  /\ status' = [status EXCEPT ![2] = "waiting"]
  /\ active' = IF Compatible THEN {1, 2} ELSE {1}
  /\ joined' = Compatible /\ calls' = IF Compatible THEN 1 ELSE 2
  /\ admitted' = IF domain = "immutable" /\ ~Compatible /\ CanAdmit
                     THEN admitted + 1 ELSE admitted
  /\ UNCHANGED <<context, domain, limit, stopped, delivered, cached,
                 replacementAlive, replacementShared, cleanupPending>>
Cancel(w) ==
  /\ phase = "shared" /\ status[w] = "waiting"
  /\ status' = [status EXCEPT ![w] = "cancelled"] /\ active' = active \ {w}
  /\ stopped' = IF w \in active /\
                    (BugCancelAll \/ (active \ {w} = {} /\ ~BugLeakLast) \/
                     (BugCreatorScope /\ domain = "immutable" /\ context = "service" /\ w = 1))
                  THEN TRUE ELSE stopped
  /\ UNCHANGED <<phase, context, domain, limit, joined, delivered, calls, cached,
                 replacementAlive, replacementShared, admitted, cleanupPending>>
Complete ==
  /\ phase = "shared" /\ ~stopped /\ active # {}
  /\ phase' = "settled" /\ delivered' = active
  /\ status' = [w \in Waiters |-> IF w \in active THEN "delivered" ELSE status[w]]
  /\ active' = {} /\ cached' = BugCache
  /\ admitted' = IF domain = "immutable" THEN admitted - 1 ELSE admitted
  /\ UNCHANGED <<context, domain, limit, stopped, joined, calls,
                 replacementAlive, replacementShared, cleanupPending>>
CompleteIndependent ==
  /\ phase = "shared" /\ ~joined /\ status[2] = "waiting"
  /\ phase' = "independent" /\ status' = [status EXCEPT ![2] = "delivered"]
  /\ delivered' = {2}
  /\ admitted' = IF domain = "immutable" /\ admitted > 1 THEN admitted - 1 ELSE admitted
  /\ UNCHANGED <<context, domain, limit, active, stopped, joined, calls, cached,
                 replacementAlive, replacementShared, cleanupPending>>
RestartAfterSettlement ==
  /\ phase = "settled" /\ phase' = "replacement"
  /\ calls' = IF cached THEN calls ELSE calls + 1
  /\ admitted' = IF domain = "immutable" /\ ~cached /\ CanAdmit
                     THEN admitted + 1 ELSE admitted
  /\ UNCHANGED <<context, domain, limit, status, active, stopped, joined, delivered,
                 cached, replacementAlive, replacementShared, cleanupPending>>
FinishCancelled ==
  /\ phase = "shared" /\ \A w \in Waiters: status[w] = "cancelled"
  /\ phase' = "cancelled"
  \* Interrupt is requested, but a slow producer finalizer still owns its charge.
  /\ cleanupPending' = (domain = "immutable")
  /\ UNCHANGED <<context, domain, limit, status, active, stopped, joined, delivered,
                 calls, cached, replacementAlive, replacementShared, admitted>>
RestartAfterCancellation ==
  /\ phase = "cancelled" /\ stopped /\ phase' = "restarted"
  /\ calls' = calls + 1 /\ replacementAlive' = TRUE
  /\ replacementShared' = (domain = "transport" \/ CanAdmit \/
                             (BugEarlyRelease /\ cleanupPending))
  \* Capacity rejects only registry sharing: the caller may use its own producer.
  /\ admitted' = IF domain = "immutable" /\ replacementShared'
                     THEN admitted + 1 ELSE admitted
  /\ UNCHANGED <<context, domain, limit, status, active, stopped, joined, delivered,
                 cached, cleanupPending>>
LateOldCleanup ==
  /\ phase = "restarted" /\ phase' = "cleanup"
  /\ replacementAlive' = ~(BugCleanup /\ replacementShared)
  /\ admitted' = IF cleanupPending THEN admitted - 1 ELSE admitted
  /\ cleanupPending' = FALSE
  /\ UNCHANGED <<context, domain, limit, status, active, stopped, joined, delivered,
                 cached, calls, replacementShared>>
Done ==
  /\ phase \in {"settled", "replacement", "independent", "cancelled", "restarted", "cleanup"}
  /\ UNCHANGED vars
Next == StartFirst \/ StartSecond \/ (\E w \in Waiters: Cancel(w)) \/ Complete
        \/ CompleteIndependent \/ RestartAfterSettlement \/ FinishCancelled
        \/ RestartAfterCancellation \/ LateOldCleanup \/ Done
TypeOK ==
  /\ phase \in {"ready", "first", "shared", "settled", "replacement", "independent", "cancelled", "restarted", "cleanup"}
  /\ context \in Contexts /\ domain \in Domains /\ limit \in {1, 2}
  /\ status \in [Waiters -> {"idle", "waiting", "cancelled", "delivered"}]
  /\ active \subseteq Waiters /\ stopped \in BOOLEAN /\ joined \in BOOLEAN
  /\ delivered \subseteq Waiters /\ calls \in 0..3 /\ cached \in BOOLEAN
  /\ replacementAlive \in BOOLEAN /\ replacementShared \in BOOLEAN
  /\ admitted \in 0..3 /\ cleanupPending \in BOOLEAN
SurvivingWaiterKeepsProducer == (phase = "shared" /\ active # {}) => ~stopped
LastWaiterReleasesProducer ==
  (phase \in {"shared", "cancelled"} /\ active = {} /\ status[1] = "cancelled") => stopped
ScopeIsolated == joined => context # "scope"
BudgetIsolated == joined => context # "budget"
QueueBudgetIsolated == joined => context # "queue"
ServiceIsolated == (domain = "transport" /\ joined) => context # "service"
SettledResultNotReused == phase = "replacement" => calls = (IF joined THEN 2 ELSE 3)
ReplacementSurvivesOldCleanup == phase = "cleanup" => replacementAlive
SharedAdmissionBounded == domain = "immutable" => admitted <= limit
Spec == Init /\ [][Next]_vars
=============================================================================
