---------------------------- MODULE UpdateCommit ----------------------------
EXTENDS Naturals, FiniteSets
CONSTANT UnsafeReplay, EarlyPublish, MovingSession, InferOutcome
Files == {"main", "reference"}
VARIABLES phase, objects, attempts, selected, receipt, acknowledged, sessionPin, served
vars == <<phase, objects, attempts, selected, receipt, acknowledged, sessionPin, served>>
Init == /\ phase = "preparing" /\ objects = {} /\ attempts = 0
        /\ selected = 1 /\ receipt = FALSE /\ acknowledged = FALSE
        /\ sessionPin = 1 /\ served = 0
RetainMain == /\ phase = "preparing" /\ objects = {}
              /\ objects' = {"main"}
              /\ UNCHANGED <<phase, attempts, selected, receipt, acknowledged, sessionPin, served>>
RetainReference == /\ phase = "preparing" /\ objects = {"main"}
                   /\ objects' = Files
                   /\ UNCHANGED <<phase, attempts, selected, receipt, acknowledged, sessionPin, served>>
FreezePlan == /\ phase = "preparing" /\ (objects = Files \/ EarlyPublish)
              /\ phase' = "ready"
              /\ UNCHANGED <<objects, attempts, selected, receipt, acknowledged, sessionPin, served>>
Dispatch == /\ phase = "ready" /\ attempts = 0
            /\ phase' = "inflight" /\ attempts' = 1
            /\ UNCHANGED <<objects, selected, receipt, acknowledged, sessionPin, served>>
ProviderApplies == /\ phase = "inflight" /\ selected' = 2 /\ phase' = "response"
                   /\ UNCHANGED <<objects, attempts, receipt, acknowledged, sessionPin, served>>
Acknowledgement == /\ phase = "response" /\ receipt' = TRUE
                   /\ acknowledged' = TRUE /\ phase' = "verified"
                   /\ UNCHANGED <<objects, attempts, selected, sessionPin, served>>
ResponseLost == /\ phase = "response" /\ phase' = "unknown"
                /\ UNCHANGED <<objects, attempts, selected, receipt, acknowledged, sessionPin, served>>
ExposeOriginalReceipt == /\ phase = "unknown" /\ ~receipt /\ receipt' = TRUE
                        /\ UNCHANGED <<phase, objects, attempts, selected, acknowledged, sessionPin, served>>
ReconcileOriginal == /\ phase = "unknown" /\ receipt
                     /\ phase' = "verified" /\ acknowledged' = TRUE
                     /\ UNCHANGED <<objects, attempts, selected, receipt, sessionPin, served>>
ReplayUnknown == /\ UnsafeReplay /\ phase = "unknown" /\ attempts = 1
                 /\ attempts' = 2 /\ phase' = "inflight"
                 /\ UNCHANGED <<objects, selected, receipt, acknowledged, sessionPin, served>>
GuessFromVisibility == /\ InferOutcome /\ phase = "unknown" /\ selected = 2 /\ ~receipt
                       /\ acknowledged' = TRUE /\ phase' = "verified"
                       /\ UNCHANGED <<objects, attempts, selected, receipt, sessionPin, served>>
PublishResult == /\ phase = "verified" /\ phase' = "completed"
                 /\ UNCHANGED <<objects, attempts, selected, receipt, acknowledged, sessionPin, served>>
ReadPinned == /\ served = 0 /\ selected = 2
              /\ served' = IF MovingSession THEN selected ELSE sessionPin
              /\ UNCHANGED <<phase, objects, attempts, selected, receipt, acknowledged, sessionPin>>
Wait == /\ phase = "unknown" /\ UNCHANGED vars
Done == /\ phase = "completed" /\ UNCHANGED vars
Next == RetainMain \/ RetainReference \/ FreezePlan \/ Dispatch \/ ProviderApplies
        \/ Acknowledgement \/ ResponseLost \/ ExposeOriginalReceipt \/ ReconcileOriginal
        \/ ReplayUnknown \/ GuessFromVisibility \/ PublishResult \/ ReadPinned \/ Wait \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"preparing", "ready", "inflight", "response", "unknown", "verified", "completed"}
          /\ objects \subseteq Files /\ attempts \in 0..2 /\ selected \in 1..2
          /\ receipt \in BOOLEAN /\ acknowledged \in BOOLEAN /\ sessionPin = 1 /\ served \in 0..2
AtMostOneDispatch == attempts <= 1
SelectedVersionComplete == selected = 2 => objects = Files
SessionPinStable == served = 0 \/ served = sessionPin
NoInventedOutcome == acknowledged => receipt
=============================================================================
