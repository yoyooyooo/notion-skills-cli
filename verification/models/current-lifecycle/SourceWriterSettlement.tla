------------------------ MODULE SourceWriterSettlement ------------------------
EXTENDS Naturals

CONSTANTS Scenario, Fault
ASSUME Scenario \in {"unique", "ambiguous", "children"}
ASSUME Fault \in {"none", "replay", "release", "cancel", "value-only", "intent", "child-fence"}

VARIABLES phase, gate, durable, sent, outstanding, applied, value, witness,
          cancelled, successor, successorComplete, pendingChildren
vars == <<phase, gate, durable, sent, outstanding, applied, value, witness,
          cancelled, successor, successorComplete, pendingChildren>>

Phases == {"new", "saved", "dispatched", "unknown", "observed", "complete", "blocked"}
Terminal == phase \in {"complete", "blocked"}
            /\ successor \in {"complete", "blocked"}

Init ==
  /\ phase = IF Scenario = "children" THEN "saved" ELSE "new"
  /\ gate = IF Scenario = "children" THEN "old" ELSE "none"
  /\ durable = (Scenario = "children")
  /\ pendingChildren = IF Scenario = "children" THEN {"first", "last"} ELSE {}
  /\ sent = 0 /\ outstanding = 0 /\ applied = 0
  /\ value = IF Scenario = "ambiguous" THEN "old" ELSE "before"
  /\ witness = "none"
  /\ cancelled = FALSE
  /\ successor = "waiting" /\ successorComplete = FALSE

SaveOriginal ==
  /\ phase = "new"
  /\ phase' = "saved" /\ gate' = "old" /\ durable' = TRUE
  /\ UNCHANGED <<sent, outstanding, applied, value, witness, cancelled,
                 successor, successorComplete, pendingChildren>>

\* A durable checkpoint precedes the single outbound mutation. The parameter
\* describes one business or control-record PATCH, not all such writes at once.
DispatchOriginal ==
  /\ phase = "saved" \/ (Fault = "intent" /\ phase = "new")
  /\ phase' = "dispatched" /\ sent' = 1 /\ outstanding' = 1
  /\ UNCHANGED <<gate, durable, applied, value, witness, cancelled,
                 successor, successorComplete, pendingChildren>>

\* Transport loss does not cancel an already submitted server action.
LoseResponse ==
  /\ phase = "dispatched" /\ phase' = "unknown"
  /\ UNCHANGED <<gate, durable, sent, outstanding, applied, value, witness,
                 cancelled, successor, successorComplete, pendingChildren>>

ApplyOriginal ==
  /\ outstanding > 0
  /\ outstanding' = outstanding - 1 /\ applied' = applied + 1
  /\ value' = "old"
  /\ witness' = IF Scenario # "ambiguous" THEN "old-action" ELSE "none"
  /\ UNCHANGED <<phase, gate, durable, sent, cancelled, successor, successorComplete, pendingChildren>>

ReceiveOriginalResponse ==
  /\ phase = "dispatched" /\ applied > 0
  /\ phase' = "observed"
  /\ UNCHANGED <<gate, durable, sent, outstanding, applied, value, witness,
                 cancelled, successor, successorComplete, pendingChildren>>

\* Equality is insufficient when the old value already existed. Only a unique
\* action witness from the one dispatch can explain an unknown write. Where
\* production has no such witness it must retain the original gate.
ObserveOriginal ==
  /\ phase = "unknown"
  /\ value = "old" /\ (witness = "old-action" \/ Fault = "value-only")
  /\ phase' = "observed"
  /\ UNCHANGED <<gate, durable, sent, outstanding, applied, value, witness,
                 cancelled, successor, successorComplete, pendingChildren>>

ReplayUnknown ==
  /\ Fault = "replay" /\ phase = "unknown" /\ sent = 1
  /\ sent' = 2 /\ outstanding' = outstanding + 1
  /\ UNCHANGED <<phase, gate, durable, applied, value, witness, cancelled,
                 successor, successorComplete, pendingChildren>>

ExplainUnknown ==
  /\ phase = "unknown" /\ phase' = "blocked"
  /\ gate' = IF Fault = "release" THEN "none" ELSE gate
  /\ durable' = IF Fault = "release" THEN FALSE ELSE durable
  /\ UNCHANGED <<sent, outstanding, applied, value, witness, cancelled,
                 successor, successorComplete, pendingChildren>>

CancelWaiter ==
  /\ phase \in {"dispatched", "unknown", "blocked"} /\ ~cancelled
  /\ cancelled' = TRUE
  /\ gate' = IF Fault = "cancel" THEN "none" ELSE gate
  /\ durable' = IF Fault = "cancel" THEN FALSE ELSE durable
  /\ UNCHANGED <<phase, sent, outstanding, applied, value, witness,
                 successor, successorComplete, pendingChildren>>

RetireOriginal ==
  /\ phase = "observed"
  /\ pendingChildren = {} \/ Fault = "child-fence"
  /\ phase' = "complete" /\ gate' = "none" /\ durable' = FALSE
  /\ UNCHANGED <<sent, outstanding, applied, value, witness, cancelled,
                 successor, successorComplete, pendingChildren>>

AdmitSuccessor ==
  /\ successor = "waiting" /\ gate = "none" /\ phase # "new"
  /\ successor' = "admitted" /\ gate' = "new"
  /\ UNCHANGED <<phase, durable, sent, outstanding, applied, value, witness,
                 cancelled, successorComplete, pendingChildren>>

RefuseSuccessor ==
  /\ successor = "waiting" /\ phase = "blocked" /\ gate # "none"
  /\ successor' = "blocked"
  /\ UNCHANGED <<phase, gate, durable, sent, outstanding, applied, value, witness,
                 cancelled, successorComplete, pendingChildren>>

\* The successor's successful bounded write is independently observed.
PublishSuccessor ==
  /\ successor = "admitted"
  /\ value' = "new" /\ witness' = "new-action"
  /\ successor' = "complete" /\ successorComplete' = TRUE
  /\ gate' = "none"
  /\ UNCHANGED <<phase, durable, sent, outstanding, applied, cancelled, pendingChildren>>

\* These are two separately accepted original child requests. Any child may
\* arrive after its parent transport has finished. An observed original reply
\* settles that child; it does not prove the successor's desired contents.
SettleChild(child) ==
  /\ child \in pendingChildren
  /\ pendingChildren' = pendingChildren \ {child}
  /\ value' = "old"
  /\ UNCHANGED <<phase, gate, durable, sent, outstanding, applied, witness,
                 cancelled, successor, successorComplete>>

ExplainChildren ==
  /\ phase = "observed" /\ pendingChildren # {}
  /\ phase' = "blocked"
  /\ UNCHANGED <<gate, durable, sent, outstanding, applied, value, witness,
                 cancelled, successor, successorComplete, pendingChildren>>

Done == /\ Terminal /\ UNCHANGED vars
Next == SaveOriginal \/ DispatchOriginal \/ LoseResponse \/ ApplyOriginal
     \/ ReceiveOriginalResponse \/ ObserveOriginal \/ ReplayUnknown \/ ExplainUnknown
     \/ CancelWaiter \/ RetireOriginal \/ AdmitSuccessor \/ RefuseSuccessor
     \/ PublishSuccessor \/ (\E child \in {"first", "last"}: SettleChild(child))
     \/ ExplainChildren \/ Done
Spec == Init /\ [][Next]_vars /\ WF_vars(Next)

TypeOK ==
  /\ phase \in Phases /\ gate \in {"none", "old", "new"} /\ durable \in BOOLEAN
  /\ sent \in 0..2 /\ outstanding \in 0..2 /\ applied \in 0..2
  /\ value \in {"before", "old", "new"}
  /\ witness \in {"none", "old-action", "new-action"}
  /\ cancelled \in BOOLEAN
  /\ successor \in {"waiting", "admitted", "complete", "blocked"}
  /\ successorComplete \in BOOLEAN
  /\ pendingChildren \subseteq {"first", "last"}
OriginalIntentPrecedesDispatch == phase \in {"dispatched", "unknown"} => durable
UnknownMutationDispatchedOnce == sent <= 1
UnknownOriginalKeepsAdmission == phase \in {"unknown", "blocked"} => durable /\ gate = "old"
OriginalSettlementIsCausal == phase \in {"observed", "complete"} => outstanding = 0
OriginalGateRetainsUnsettledWrite == (outstanding > 0 \/ pendingChildren # {}) => gate = "old" /\ durable
SuccessorWaitsForSettlement == successor \in {"admitted", "complete"} => outstanding = 0
AllOriginalChildrenSettledBeforeSuccessor ==
  (phase = "complete" \/ successor \in {"admitted", "complete"}) => pendingChildren = {}
SettledSuccessorNeverOverwritten == successorComplete => value = "new"
WriterEventuallyExplained == <>Terminal
=============================================================================
