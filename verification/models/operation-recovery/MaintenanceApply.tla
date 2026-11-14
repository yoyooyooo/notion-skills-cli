--------------------------- MODULE MaintenanceApply ---------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS SkipPrefix, ReplayUnknown, PublishPartial, ReadPending, IgnoreDrift
VARIABLE s
vars == <<s>>
Children == 1..3
Prefix(n) == {i \in Children : i < n}
Init == s = [phase |-> "plan", child |-> 1, pending |-> FALSE,
             attempts |-> [i \in Children |-> 0], applied |-> {}, acks |-> {},
             outcomes |-> {}, verified |-> {}, drift |-> FALSE,
             prefixBeforeSend |-> TRUE, frozenBeforeSend |-> TRUE,
             currentRead |-> "old", oldPin |-> "old"]
RetainParent ==
  /\ s.phase = "plan"
  /\ s' = [s EXCEPT !.phase = "boundary", !.pending = TRUE]
ExternalEdit ==
  /\ s.phase = "boundary" /\ ~s.drift
  /\ s' = [s EXCEPT !.drift = TRUE]
RetainChildIntent ==
  /\ s.phase = "boundary" /\ (Prefix(s.child) \subseteq s.verified \/ SkipPrefix)
  /\ (~s.drift \/ IgnoreDrift)
  /\ s' = [s EXCEPT !.phase = "intent"]
RejectDrift ==
  /\ s.phase = "boundary" /\ s.drift
  /\ s' = [s EXCEPT !.phase = "stopped"]
Send ==
  /\ s.phase = "intent" /\ s.attempts[s.child] = 0
  /\ s' = [s EXCEPT !.phase = "sent", !.attempts[s.child] = 1,
       !.prefixBeforeSend = s.prefixBeforeSend /\ Prefix(s.child) \subseteq s.verified,
       !.frozenBeforeSend = s.frozenBeforeSend /\ ~s.drift]
ServiceApplies ==
  /\ s.phase = "sent"
  /\ s' = [s EXCEPT !.phase = "response", !.applied = @ \cup {s.child}]
RetainAck ==
  /\ s.phase = "response"
  /\ s' = [s EXCEPT !.phase = "ack", !.acks = @ \cup {s.child}]
VerifyOutcome ==
  /\ s.phase = "ack" /\ s.child \in s.applied /\ s.child \in s.acks
  /\ s' = [s EXCEPT !.phase = "outcome", !.outcomes = @ \cup {s.child}]
CheckpointChild ==
  /\ s.phase = "outcome" /\ s.child \in s.outcomes
  /\ s' = [s EXCEPT !.phase = "verified", !.verified = @ \cup {s.child}]
Interrupt ==
  /\ s.phase \in {"intent", "sent", "response", "ack", "outcome"}
  /\ s' = [s EXCEPT !.phase = "unknown"]
ReconcileOriginal ==
  /\ s.phase = "unknown" /\ s.child \in s.outcomes
  /\ s' = [s EXCEPT !.phase = "outcome"]
RepeatUnknown ==
  /\ ReplayUnknown /\ s.phase = "unknown" /\ s.child \notin s.outcomes /\ s.attempts[s.child] < 2
  /\ s' = [s EXCEPT !.phase = "sent", !.attempts[s.child] = @ + 1]
NextChild ==
  /\ (s.phase = "verified" \/ (SkipPrefix /\ s.phase = "unknown")) /\ s.child < 3
  /\ s' = [s EXCEPT !.phase = "boundary", !.child = @ + 1]
Complete ==
  /\ s.phase = "verified" /\ (s.verified = Children \/ PublishPartial)
  /\ s' = [s EXCEPT !.phase = "complete", !.pending = FALSE]
ObserveCurrent ==
  /\ s.phase # "plan"
  /\ s' = [s EXCEPT !.currentRead = IF s.pending /\ ~ReadPending THEN "blocked" ELSE "new"]
Stop ==
  /\ s.phase \in {"stopped", "complete", "unknown"}
  /\ UNCHANGED vars
Next == RetainParent \/ ExternalEdit \/ RetainChildIntent \/ RejectDrift \/ Send
        \/ ServiceApplies \/ RetainAck \/ VerifyOutcome \/ CheckpointChild \/ Interrupt
        \/ ReconcileOriginal \/ RepeatUnknown \/ NextChild \/ Complete \/ ObserveCurrent \/ Stop
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ s.child \in Children /\ s.phase \in {"plan", "boundary", "intent", "sent", "response", "ack", "outcome", "verified", "unknown", "stopped", "complete"}
  /\ s.attempts \in [Children -> 0..2]
  /\ s.applied \subseteq Children /\ s.acks \subseteq Children /\ s.outcomes \subseteq Children /\ s.verified \subseteq Children
  /\ s.currentRead \in {"old", "blocked", "new"} /\ s.oldPin = "old"
  /\ \A key \in {"pending", "drift", "prefixBeforeSend", "frozenBeforeSend"} : s[key] \in BOOLEAN
ConfirmedPrefixBeforeSuffix == s.prefixBeforeSend
UnknownNeverRepeated == \A child \in Children : s.attempts[child] <= 1
CompletionNeedsAllChildren == s.phase = "complete" => s.verified = Children
PendingTreeNotPublished == s.pending => s.currentRead # "new"
ObservedDriftStopsDispatch == s.frozenBeforeSend
OriginalOutcomeAuthority == s.verified \subseteq s.outcomes /\ s.outcomes \subseteq s.acks /\ s.acks \subseteq s.applied
OldPinPreserved == s.oldPin = "old"
=============================================================================
