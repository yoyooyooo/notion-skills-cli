--------------------------- MODULE MaintenanceApply ---------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS SkipPrefix, ReplayUnknown, PublishPartial, ReadPending, IgnoreDrift, AcceptUnreviewed
VARIABLE s
vars == <<s>>
Children == 1..3
Prefix(n) == {i \in Children : i < n}
Init == s = [phase |-> "plan", child |-> 1, pending |-> FALSE,
             attempts |-> [i \in Children |-> 0], applied |-> {}, acks |-> {},
             outcomes |-> {}, verified |-> {}, failed |-> {}, reviewed |-> {}, drift |-> FALSE,
             bindingAttempts |-> 0, bindingApplied |-> FALSE, bindingAck |-> FALSE,
             bindingVerified |-> FALSE, boundAllocations |-> {}, nativeBodyBoundBeforeSend |-> TRUE,
             prefixBeforeSend |-> TRUE, frozenBeforeSend |-> TRUE,
             currentRead |-> "old", oldPin |-> "old"]
RetainParent ==
  /\ s.phase = "plan"
  /\ s' = [s EXCEPT !.phase = "boundary", !.pending = TRUE]
ExternalEdit ==
  /\ s.phase \in {"boundary", "binding intent", "binding sent", "binding response", "binding ACK"} /\ ~s.drift
  /\ s' = [s EXCEPT !.drift = TRUE]
RetainChildIntent ==
  /\ s.phase = "boundary" /\ (Prefix(s.child) \subseteq s.verified \/ SkipPrefix)
  /\ (s.child # 3 \/ s.bindingVerified \/ SkipPrefix)
  /\ (~s.drift \/ IgnoreDrift)
  /\ s' = [s EXCEPT !.phase = "intent"]
RetainNativeBindingIntent ==
  /\ s.phase = "boundary" /\ s.child = 3 /\ s.bindingAttempts = 0
  /\ Prefix(s.child) \subseteq s.verified /\ (~s.drift \/ IgnoreDrift)
  /\ s' = [s EXCEPT !.phase = "binding intent", !.boundAllocations = s.outcomes \cap {1, 2}]
SendNativeBinding ==
  /\ s.phase = "binding intent" /\ s.bindingAttempts = 0
  /\ s' = [s EXCEPT !.phase = "binding sent", !.bindingAttempts = 1]
NativeBindingApplies ==
  /\ s.phase = "binding sent"
  /\ s' = [s EXCEPT !.phase = "binding response", !.bindingApplied = TRUE]
RetainNativeBindingAck ==
  /\ s.phase = "binding response"
  /\ s' = [s EXCEPT !.phase = "binding ACK", !.bindingAck = TRUE]
VerifyNativeBinding ==
  /\ s.phase = "binding ACK" /\ s.bindingApplied /\ s.bindingAck
  /\ s.boundAllocations = {1, 2} /\ s.boundAllocations \subseteq s.outcomes
  /\ s' = [s EXCEPT !.phase = "boundary", !.bindingVerified = TRUE]
InterruptNativeBinding ==
  /\ s.phase \in {"binding intent", "binding sent", "binding response", "binding ACK"}
  /\ s' = [s EXCEPT !.phase = "binding unknown"]
ReconcileNativeBinding ==
  /\ s.phase = "binding unknown" /\ s.bindingAck /\ s.bindingApplied
  /\ s' = [s EXCEPT !.phase = "binding ACK"]
RepeatUnknownBinding ==
  /\ ReplayUnknown /\ s.phase = "binding unknown" /\ ~s.bindingAck /\ s.bindingAttempts < 2
  /\ s' = [s EXCEPT !.phase = "binding sent", !.bindingAttempts = @ + 1]
RejectDrift ==
  /\ s.phase = "boundary" /\ s.drift
  /\ s' = [s EXCEPT !.phase = "stopped"]
Send ==
  /\ s.phase = "intent" /\ s.attempts[s.child] = 0
  /\ s' = [s EXCEPT !.phase = "sent", !.attempts[s.child] = 1,
       !.prefixBeforeSend = s.prefixBeforeSend /\ Prefix(s.child) \subseteq s.verified,
       !.nativeBodyBoundBeforeSend = s.nativeBodyBoundBeforeSend /\ (s.child # 3 \/ (s.bindingVerified /\ s.boundAllocations = {1, 2} /\ s.boundAllocations \subseteq s.outcomes)),
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
RecordKnownFailure ==
  /\ s.phase = "ack" /\ s.child \in s.acks
  /\ s' = [s EXCEPT !.phase = "known_failed", !.failed = @ \cup {s.child}]
ReviewKnownFailure ==
  /\ s.phase = "known_failed" /\ s.child \in s.failed
  /\ s' = [s EXCEPT !.phase = "reviewed_failure", !.reviewed = @ \cup {s.child}]
SettlePartial ==
  /\ s.phase \in {"known_failed", "reviewed_failure"}
  /\ s.child \in s.failed /\ Prefix(s.child) \subseteq s.verified
  /\ (s.child \in s.reviewed \/ AcceptUnreviewed)
  /\ s' = [s EXCEPT !.phase = "partial", !.pending = FALSE]
ObserveCurrent ==
  /\ s.phase # "plan"
  /\ s' = [s EXCEPT !.currentRead = IF s.pending /\ ~ReadPending THEN "blocked" ELSE "new"]
Stop ==
  /\ s.phase \in {"stopped", "complete", "unknown", "binding unknown", "known_failed", "reviewed_failure", "partial"}
  /\ UNCHANGED vars
Next == RetainParent \/ ExternalEdit \/ RetainChildIntent \/ RejectDrift \/ Send
        \/ RetainNativeBindingIntent \/ SendNativeBinding \/ NativeBindingApplies \/ RetainNativeBindingAck
        \/ VerifyNativeBinding \/ InterruptNativeBinding \/ ReconcileNativeBinding \/ RepeatUnknownBinding
        \/ ServiceApplies \/ RetainAck \/ VerifyOutcome \/ CheckpointChild \/ Interrupt
        \/ ReconcileOriginal \/ RepeatUnknown \/ NextChild \/ Complete \/ RecordKnownFailure
        \/ ReviewKnownFailure \/ SettlePartial \/ ObserveCurrent \/ Stop
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ s.child \in Children /\ s.phase \in {"plan", "boundary", "intent", "sent", "response", "ack", "outcome", "verified", "unknown", "stopped", "complete", "known_failed", "reviewed_failure", "partial", "binding intent", "binding sent", "binding response", "binding ACK", "binding unknown"}
  /\ s.attempts \in [Children -> 0..2]
  /\ s.bindingAttempts \in 0..2 /\ s.boundAllocations \subseteq {1, 2}
  /\ s.applied \subseteq Children /\ s.acks \subseteq Children /\ s.outcomes \subseteq Children /\ s.verified \subseteq Children
  /\ s.failed \subseteq Children /\ s.reviewed \subseteq s.failed
  /\ s.currentRead \in {"old", "blocked", "new"} /\ s.oldPin = "old"
  /\ \A key \in {"pending", "drift", "prefixBeforeSend", "frozenBeforeSend", "bindingApplied", "bindingAck", "bindingVerified", "nativeBodyBoundBeforeSend"} : s[key] \in BOOLEAN
ConfirmedPrefixBeforeSuffix == s.prefixBeforeSend
NativeBodyNeedsOriginalAllocationBinding == s.nativeBodyBoundBeforeSend
UnknownNeverRepeated == (\A child \in Children : s.attempts[child] <= 1) /\ s.bindingAttempts <= 1
CompletionNeedsAllChildren == s.phase = "complete" => s.verified = Children
PendingTreeNotPublished == s.pending => s.currentRead # "new"
ObservedDriftStopsDispatch == s.frozenBeforeSend
OriginalOutcomeAuthority == s.verified \subseteq s.outcomes /\ s.outcomes \subseteq s.acks /\ s.acks \subseteq s.applied
PartialRequiresOriginalReview == s.phase = "partial" => s.child \in s.reviewed /\ s.child \in s.failed
PartialTailNeverSent == s.phase = "partial" => \A i \in Children : i > s.child => s.attempts[i] = 0
OldPinPreserved == s.oldPin = "old"
=============================================================================
