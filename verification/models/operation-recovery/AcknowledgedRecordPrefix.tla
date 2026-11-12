------------------- MODULE AcknowledgedRecordPrefix -------------------
EXTENDS Naturals, FiniteSets
CONSTANT IgnoreAck, IgnoreIdentity, IgnorePrefix, ReplayUncertain, RequireQuery,
         IgnorePremise, IgnorePermission, RewriteOriginal, SkipVerification
VARIABLE s
vars == <<s>>
Scenarios == {"exact-visible", "exact-hidden", "missing-ack", "unknown",
              "identity-conflict", "payload-conflict", "noncontiguous", "premise-changed", "permission-denied"}
Init == \E scenario \in Scenarios :
  s = [phase |-> "inspect", scenario |-> scenario,
       originalOperation |-> "original", originalInput |-> "frozen", originalFailure |-> "needs_review",
       prefixAck |-> scenario \notin {"missing-ack", "unknown"},
       requestExact |-> scenario # "identity-conflict",
       payloadExact |-> scenario # "payload-conflict",
       retainedRecords |-> IF scenario = "noncontiguous" THEN {2} ELSE {1},
       queryVisible |-> scenario # "exact-hidden",
       fresh |-> scenario # "premise-changed", permitted |-> scenario # "permission-denied",
       prefixAuthorized |-> FALSE, prefixVerified |-> FALSE, indexBlocked |-> FALSE,
       suffixIntent |-> FALSE, suffixAttempts |-> 0, suffixApplied |-> FALSE,
       suffixAck |-> FALSE, suffixVerified |-> FALSE, replayed |-> FALSE,
       sentWithFreshPremise |-> TRUE, sentWithPermission |-> TRUE]

CheckOriginal ==
  /\ s.phase = "inspect"
  /\ (s.prefixAck \/ IgnoreAck)
  /\ (s.requestExact \/ IgnoreIdentity)
  /\ (s.retainedRecords = 1..Cardinality(s.retainedRecords) \/ IgnorePrefix)
  /\ s' = [s EXCEPT !.phase = "exact GET", !.prefixAuthorized = TRUE]
RejectMissingAck ==
  /\ s.phase = "inspect" /\ ~s.prefixAck
  /\ s' = [s EXCEPT !.phase = IF s.scenario = "unknown" THEN "unknown original" ELSE "missing ACK"]
RejectIdentity ==
  /\ s.phase = "inspect" /\ ~s.requestExact
  /\ s' = [s EXCEPT !.phase = "conflict"]
RejectNonPrefix ==
  /\ s.phase = "inspect" /\ s.retainedRecords # 1..Cardinality(s.retainedRecords)
  /\ s' = [s EXCEPT !.phase = "noncontiguous prefix"]
ObserveExactPage ==
  /\ s.phase = "exact GET" /\ (s.payloadExact \/ IgnoreIdentity)
  /\ s' = [s EXCEPT
       !.phase = IF RequireQuery /\ ~s.queryVisible THEN "index blocked" ELSE "prefix verified",
       !.indexBlocked = RequireQuery /\ ~s.queryVisible,
       !.prefixVerified = ~(RequireQuery /\ ~s.queryVisible)]
RejectPayload ==
  /\ s.phase = "exact GET" /\ ~s.payloadExact
  /\ s' = [s EXCEPT !.phase = "conflict"]
WaitForCensus ==
  /\ s.phase = "prefix verified" /\ ~s.queryVisible
  /\ s' = [s EXCEPT !.phase = "waiting census"]
IndexCatchesUp ==
  /\ s.phase = "waiting census"
  /\ s' = [s EXCEPT !.phase = "prefix verified", !.queryVisible = TRUE]
PremiseChanges ==
  /\ s.phase = "prefix verified" /\ s.fresh
  /\ s' = [s EXCEPT !.fresh = FALSE]
PermissionDenied ==
  /\ s.phase = "prefix verified" /\ s.permitted
  /\ s' = [s EXCEPT !.permitted = FALSE]
RecheckBeforeDispatch ==
  /\ s.phase = "prefix verified" /\ s.queryVisible
  /\ (s.fresh \/ IgnorePremise) /\ (s.permitted \/ IgnorePermission)
  /\ s' = [s EXCEPT !.phase = "suffix ready"]
RejectPremise ==
  /\ s.phase = "prefix verified" /\ ~s.fresh
  /\ s' = [s EXCEPT !.phase = "stale premise"]
RejectPermission ==
  /\ s.phase = "prefix verified" /\ ~s.permitted
  /\ s' = [s EXCEPT !.phase = "permission denied"]

\* Durable intent, transport dispatch, provider application and ACK retention
\* are separate steps. An interruption after intent alone is still uncertain.
RetainSuffixIntent ==
  /\ s.phase = "suffix ready" /\ ~s.suffixIntent
  /\ s' = [s EXCEPT !.phase = "intent retained", !.suffixIntent = TRUE]
DispatchSuffix ==
  /\ s.phase = "intent retained" /\ s.suffixAttempts = 0
  /\ s' = [s EXCEPT !.phase = "suffix inflight", !.suffixAttempts = 1,
       !.sentWithFreshPremise = s.fresh, !.sentWithPermission = s.permitted]
ProviderApplies ==
  /\ s.phase = "suffix inflight"
  /\ s' = [s EXCEPT !.phase = "suffix response", !.suffixApplied = TRUE]
RetainAck ==
  /\ s.phase = "suffix response"
  /\ s' = [s EXCEPT !.phase = "suffix ACK", !.suffixAck = TRUE]
VerifySuffix ==
  /\ s.phase = "suffix ACK" /\ s.suffixApplied /\ s.suffixAck
  /\ s' = [s EXCEPT !.phase = "completed", !.suffixVerified = TRUE,
       !.originalFailure = IF RewriteOriginal THEN "recovered" ELSE s.originalFailure]
SkipSuffixVerification ==
  /\ SkipVerification /\ s.phase = "suffix response"
  /\ s' = [s EXCEPT !.phase = "completed"]
Interrupt ==
  /\ s.phase \in {"intent retained", "suffix inflight", "suffix response", "suffix ACK"}
  /\ s' = [s EXCEPT !.phase = "unknown suffix"]
ObserveOriginalAck ==
  /\ s.phase = "unknown suffix" /\ s.suffixAck /\ s.suffixApplied
  /\ s' = [s EXCEPT !.phase = "suffix ACK"]
ReplayUnknownSuffix ==
  /\ ReplayUncertain /\ s.phase = "unknown suffix" /\ s.suffixAttempts < 2
  /\ s' = [s EXCEPT !.phase = "suffix inflight",
       !.suffixAttempts = @ + 1, !.replayed = TRUE]
Wait ==
  /\ s.phase \in {"waiting census", "unknown suffix", "unknown original"}
  /\ UNCHANGED vars
Done ==
  /\ s.phase \in {"missing ACK", "conflict", "noncontiguous prefix", "index blocked", "stale premise", "permission denied", "completed"}
  /\ UNCHANGED vars
Next == CheckOriginal \/ RejectMissingAck \/ RejectIdentity \/ RejectNonPrefix \/ ObserveExactPage
        \/ RejectPayload \/ WaitForCensus \/ IndexCatchesUp \/ PremiseChanges
        \/ PermissionDenied \/ RecheckBeforeDispatch \/ RejectPremise \/ RejectPermission
        \/ RetainSuffixIntent \/ DispatchSuffix \/ ProviderApplies \/ RetainAck
        \/ VerifySuffix \/ SkipSuffixVerification \/ Interrupt \/ ObserveOriginalAck \/ ReplayUnknownSuffix \/ Wait \/ Done
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ s.scenario \in Scenarios
  /\ s.phase \in {"inspect", "exact GET", "prefix verified", "waiting census", "suffix ready",
       "intent retained", "suffix inflight", "suffix response", "suffix ACK", "unknown suffix",
       "unknown original", "missing ACK", "conflict", "noncontiguous prefix", "index blocked", "stale premise", "permission denied", "completed"}
  /\ s.retainedRecords \subseteq {1, 2}
  /\ s.suffixAttempts \in 0..2
  /\ \A key \in {"prefixAck", "requestExact", "payloadExact", "queryVisible", "fresh", "permitted",
       "prefixAuthorized", "prefixVerified", "indexBlocked", "suffixIntent", "suffixApplied",
       "suffixAck", "suffixVerified", "replayed", "sentWithFreshPremise", "sentWithPermission"} : s[key] \in BOOLEAN
PrefixNeedsOriginalAck == s.prefixAuthorized => s.prefixAck
PrefixMustBeContiguous == s.prefixAuthorized => s.retainedRecords = 1..Cardinality(s.retainedRecords)
ExactRecordBinding == (s.prefixAuthorized => s.requestExact) /\ (s.prefixVerified => s.payloadExact)
UnknownNeverRedispatched == ~s.replayed /\ s.suffixAttempts <= 1
AckLookupIndependentOfQuery == ~s.indexBlocked
DispatchNeedsFreshPremise == s.sentWithFreshPremise
DispatchNeedsPermission == s.sentWithPermission
OriginalFactsPreserved == s.originalOperation = "original" /\ s.originalInput = "frozen" /\ s.originalFailure = "needs_review"
CompletionNeedsVerification == s.phase = "completed" => s.prefixVerified /\ s.suffixAck /\ s.suffixVerified
=============================================================================
