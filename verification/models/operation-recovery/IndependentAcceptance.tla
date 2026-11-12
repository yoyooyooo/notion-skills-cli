--------------------- MODULE IndependentAcceptance ---------------------
EXTENDS Naturals, FiniteSets
CONSTANT IgnoreOriginal, IgnoreFrozenContext, ReuseOriginalId,
         InferOldSuccess, ReplayUncertain, SkipColdProof, SkipAdoption
VARIABLE s
vars == <<s>>
Records == 1..3
Proofs == {"original plan", "original outcome", "review", "adopted event", "completion"}
Scenarios == {"known failure", "unknown original", "changed File", "changed owner", "changed frontier", "reused identity"}
Init == \E scenario \in Scenarios :
  s = [phase |-> "inspect original", scenario |-> scenario,
       originalOperation |-> "original", originalInput |-> "frozen",
       originalStatus |-> IF scenario = "unknown original" THEN "unknown" ELSE "needs_review",
       oldCompletion |-> "unproven", oldAck |-> FALSE,
       acceptanceOperation |-> IF scenario = "reused identity" THEN "original" ELSE "acceptance",
       frozenFile |-> "File", frozenOwner |-> "owner", frozenFrontier |-> "frontier",
       currentFile |-> IF scenario = "changed File" THEN "other File" ELSE "File",
       currentOwner |-> IF scenario = "changed owner" THEN "other owner" ELSE "owner",
       currentFrontier |-> IF scenario = "changed frontier" THEN "other frontier" ELSE "frontier",
       authorized |-> FALSE, record |-> 1,
       attempts |-> [r \in Records |-> 0], retained |-> {}, applied |-> {},
       acks |-> {}, confirmed |-> {}, replayed |-> FALSE,
       sentAgainstFrozen |-> TRUE, accepted |-> FALSE,
       coldAvailable |-> {}, coldVerified |-> FALSE]

FrozenContext ==
  s.currentFile = s.frozenFile /\ s.currentOwner = s.frozenOwner /\ s.currentFrontier = s.frozenFrontier
FreezeReview ==
  /\ s.phase = "inspect original"
  /\ (s.originalStatus = "needs_review" \/ IgnoreOriginal)
  /\ (s.acceptanceOperation # s.originalOperation \/ ReuseOriginalId)
  /\ s' = [s EXCEPT !.phase = "before dispatch", !.authorized = TRUE]
RejectOriginal ==
  /\ s.phase = "inspect original" /\ s.originalStatus # "needs_review"
  /\ s' = [s EXCEPT !.phase = "original unresolved"]
RejectIdentity ==
  /\ s.phase = "inspect original" /\ s.acceptanceOperation = s.originalOperation
  /\ s' = [s EXCEPT !.phase = "identity conflict"]
Revalidate ==
  /\ s.phase = "before dispatch" /\ (FrozenContext \/ IgnoreFrozenContext)
  /\ s' = [s EXCEPT !.phase = "ready", !.sentAgainstFrozen = FrozenContext]
RejectDrift ==
  /\ s.phase = "before dispatch" /\ ~FrozenContext
  /\ s' = [s EXCEPT !.phase = "stale review"]
DriftAfterReview ==
  /\ s.phase = "before dispatch" /\ FrozenContext
  /\ s' = [s EXCEPT !.currentFrontier = "other frontier"]
RetainIntent ==
  /\ s.phase = "ready" /\ s.record \notin s.retained
  /\ s' = [s EXCEPT !.phase = "intent retained", !.retained = @ \cup {s.record}]
Dispatch ==
  /\ s.phase = "intent retained" /\ s.attempts[s.record] = 0
  /\ s' = [s EXCEPT !.phase = "inflight", !.attempts[s.record] = 1]
ProviderApplies ==
  /\ s.phase = "inflight"
  /\ s' = [s EXCEPT !.phase = "response", !.applied = @ \cup {s.record}]
RetainAck ==
  /\ s.phase = "response"
  /\ s' = [s EXCEPT !.phase = "ACK", !.acks = @ \cup {s.record}]
VerifyAck ==
  /\ s.phase = "ACK" /\ s.record \in s.applied /\ s.record \in s.acks
  /\ s' = [s EXCEPT !.phase = "record verified", !.confirmed = @ \cup {s.record}]
Interrupt ==
  /\ s.phase \in {"intent retained", "inflight", "response", "ACK"}
  /\ s' = [s EXCEPT !.phase = "unknown dispatch"]
ObserveExactImmutableFact ==
  /\ s.phase = "unknown dispatch" /\ s.record \in s.applied
  /\ s' = [s EXCEPT !.phase = "record verified", !.confirmed = @ \cup {s.record}]
ReplayUnknown ==
  /\ ReplayUncertain /\ s.phase = "unknown dispatch" /\ s.attempts[s.record] < 2
  /\ s' = [s EXCEPT !.phase = "inflight", !.attempts[s.record] = @ + 1, !.replayed = TRUE]
NextFact ==
  /\ s.phase = "record verified" /\ s.record < 3
  /\ s' = [s EXCEPT !.record = @ + 1, !.phase = "before dispatch"]
SkipAdoptedFact ==
  /\ SkipAdoption /\ s.phase = "record verified" /\ s.record = 1
  /\ s' = [s EXCEPT !.record = 3, !.phase = "before dispatch"]
CompleteIndependentDecision ==
  /\ s.phase = "record verified" /\ s.record = 3
  /\ s' = [s EXCEPT !.phase = "accepted", !.accepted = TRUE,
       !.oldCompletion = IF InferOldSuccess THEN "applied" ELSE s.oldCompletion]
AvailableProofs ==
  {"original plan", "original outcome"} \cup
  (IF 1 \in s.confirmed THEN {"review"} ELSE {}) \cup
  (IF 2 \in s.confirmed THEN {"adopted event"} ELSE {}) \cup
  (IF 3 \in s.confirmed THEN {"completion"} ELSE {})
ColdRead ==
  /\ s.phase = "accepted"
  /\ \E available \in {AvailableProofs} \cup {AvailableProofs \ {proof} : proof \in AvailableProofs} :
       s' = [s EXCEPT !.phase = "cold read", !.coldAvailable = available]
VerifyCold ==
  /\ s.phase = "cold read" /\ (s.coldAvailable = Proofs \/ SkipColdProof)
  /\ s' = [s EXCEPT !.phase = "cold verified", !.coldVerified = TRUE]
RejectCold ==
  /\ s.phase = "cold read" /\ s.coldAvailable # Proofs
  /\ s' = [s EXCEPT !.phase = "cold proof incomplete"]
Done ==
  /\ s.phase \in {"original unresolved", "identity conflict", "stale review", "unknown dispatch",
       "cold verified", "cold proof incomplete"}
  /\ UNCHANGED vars
Next == FreezeReview \/ RejectOriginal \/ RejectIdentity \/ Revalidate \/ RejectDrift
        \/ DriftAfterReview \/ RetainIntent \/ Dispatch \/ ProviderApplies \/ RetainAck
        \/ VerifyAck \/ Interrupt \/ ObserveExactImmutableFact \/ ReplayUnknown \/ NextFact
        \/ SkipAdoptedFact \/ CompleteIndependentDecision \/ ColdRead \/ VerifyCold \/ RejectCold \/ Done
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ s.scenario \in Scenarios /\ s.record \in Records
  /\ s.phase \in {"inspect original", "before dispatch", "ready", "intent retained", "inflight",
       "response", "ACK", "record verified", "unknown dispatch", "accepted", "cold read",
       "cold verified", "cold proof incomplete", "original unresolved", "identity conflict", "stale review"}
  /\ s.attempts \in [Records -> 0..2]
  /\ s.retained \subseteq Records /\ s.applied \subseteq Records
  /\ s.acks \subseteq Records /\ s.confirmed \subseteq Records /\ s.coldAvailable \subseteq Proofs
  /\ \A key \in {"oldAck", "authorized", "replayed", "sentAgainstFrozen", "accepted", "coldVerified"} : s[key] \in BOOLEAN
KnownFailureRequired == s.authorized => s.originalStatus = "needs_review"
FrozenIdentityRequired == s.sentAgainstFrozen
IndependentIdentity == s.authorized => s.acceptanceOperation # s.originalOperation
OriginalFactsPreserved ==
  s.originalOperation = "original" /\ s.originalInput = "frozen" /\ s.oldCompletion = "unproven" /\ ~s.oldAck
UnknownNeverRedispatched == ~s.replayed /\ \A r \in Records : s.attempts[r] <= 1
CompletionNeedsAdoption == s.accepted => {1, 2, 3} \subseteq s.confirmed
ColdRecoveryNeedsCompleteProof == s.coldVerified => s.coldAvailable = Proofs /\ s.accepted
=============================================================================

