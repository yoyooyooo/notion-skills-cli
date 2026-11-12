------------------------ MODULE RestoreFeedback ------------------------
EXTENDS Naturals
CONSTANT IgnoreBinding, IgnoreCurrentPremise, RepeatBodyOnFeedbackFailure,
         InferFeedbackAck, ReplacePendingOriginal, AcceptInvalidOutcome,
         InferOriginalFromCurrent, DropHistoricalAck, ReplayFeedback
VARIABLE s
vars == <<s>>
Scenarios == {"submitted", "cancelled", "superseded", "failed", "stale context", "foreign identity"}
Init == \E scenario \in Scenarios :
  s = [phase |-> "inspect", scenario |-> scenario,
       submittedIdentity |-> "submitted original",
       originalOperation |-> "original", frozenInput |-> "submitted body and frontier",
       bindingIdentity |-> IF scenario = "foreign identity" THEN "foreign" ELSE "original",
       submissionStatus |-> IF scenario \in {"cancelled", "superseded", "failed"} THEN scenario ELSE "submitted",
       currentPremise |-> scenario # "stale context",
       bindingVerified |-> FALSE, originalOutcome |-> "unresolved",
       bodyAttempts |-> 0, bodyApplied |-> FALSE, bodyCurrentEqual |-> FALSE,
       bodySentWithPremise |-> TRUE, bodySentWithBinding |-> TRUE,
       feedbackAttempts |-> 0, feedbackApplied |-> FALSE, feedbackReplayed |-> FALSE,
       feedbackAck |-> FALSE, historicalAck |-> FALSE, published |-> FALSE,
       pendingReplaced |-> FALSE]

RetainOriginalPlan ==
  /\ s.phase = "inspect" /\ s.submissionStatus = "submitted"
  /\ s' = [s EXCEPT !.phase = "binding retained"]
InvalidPremise ==
  /\ s.phase = "inspect" /\ s.submissionStatus # "submitted"
  /\ s' = [s EXCEPT !.phase = "original blocked"]
ProcessingAck ==
  /\ s.phase = "binding retained"
  /\ s' = [s EXCEPT !.phase = "binding ACK"]
ProcessingReadback ==
  /\ s.phase = "binding ACK" /\ s.bindingIdentity = s.originalOperation
  /\ s' = [s EXCEPT !.phase = "before body", !.bindingVerified = TRUE]
BindingLost ==
  /\ s.phase \in {"binding retained", "binding ACK"}
  /\ s' = [s EXCEPT !.phase = "binding unknown"]
BindingConflict ==
  /\ s.phase = "binding ACK" /\ s.bindingIdentity # s.originalOperation
  /\ s' = [s EXCEPT !.phase = "needs review"]
IgnoreUnverifiedBinding ==
  /\ IgnoreBinding /\ s.phase = "binding unknown"
  /\ s' = [s EXCEPT !.phase = "before body"]
CheckBodyPremise ==
  /\ s.phase = "before body" /\ (s.currentPremise \/ IgnoreCurrentPremise)
  /\ s' = [s EXCEPT !.phase = "body ready"]
RejectBodyPremise ==
  /\ s.phase = "before body" /\ ~s.currentPremise
  /\ s' = [s EXCEPT !.phase = "needs review"]
BodyDispatch ==
  /\ s.phase = "body ready" /\ s.bodyAttempts < 2
  /\ s' = [s EXCEPT !.phase = "body inflight", !.bodyAttempts = @ + 1,
       !.bodySentWithPremise = s.currentPremise, !.bodySentWithBinding = s.bindingVerified]
BodyProviderApplies ==
  /\ s.phase = "body inflight"
  /\ s' = [s EXCEPT !.phase = "body response", !.bodyApplied = TRUE, !.bodyCurrentEqual = TRUE]
RetainOriginalOutcome ==
  /\ s.phase = "body response"
  /\ s' = [s EXCEPT !.phase = "body known", !.originalOutcome = "applied"]
BodyUnknown ==
  /\ s.phase \in {"body inflight", "body response"}
  /\ s' = [s EXCEPT !.phase = "body unknown"]
PrepareFeedback ==
  /\ s.phase = "body known"
  /\ s' = [s EXCEPT !.phase = "feedback ready"]
FeedbackBudgetExhausted ==
  /\ s.phase = "body known"
  /\ s' = [s EXCEPT !.phase = "needs reconcile"]
ReconcileOriginal ==
  /\ s.phase = "needs reconcile" /\ s.originalOutcome = "applied"
  /\ s.currentPremise /\ s.bindingIdentity = s.originalOperation
  /\ s' = [s EXCEPT !.phase = "feedback ready"]
RejectReconcilePremise ==
  /\ s.phase = "needs reconcile" /\ ~s.currentPremise
  /\ s' = [s EXCEPT !.phase = "needs review"]
RepeatBody ==
  /\ RepeatBodyOnFeedbackFailure /\ s.phase \in {"needs reconcile", "feedback unknown"}
  /\ s.bodyAttempts < 2
  /\ s' = [s EXCEPT !.phase = "before body"]
ExistingFeedbackRemainsUnknown ==
  /\ s.phase = "feedback ready" /\ s.feedbackAttempts > 0
  /\ s' = [s EXCEPT !.phase = "feedback unknown"]
RetainFeedbackIntent ==
  /\ s.phase = "feedback ready" /\ s.feedbackAttempts = 0
  /\ s' = [s EXCEPT !.phase = "feedback intent"]
FeedbackDispatch ==
  /\ s.phase = "feedback intent" /\ s.feedbackAttempts = 0
  /\ s' = [s EXCEPT !.phase = "feedback inflight", !.feedbackAttempts = 1]
FeedbackProviderApplies ==
  /\ s.phase = "feedback inflight"
  /\ s' = [s EXCEPT !.phase = "feedback response", !.feedbackApplied = TRUE]
RetainFeedbackAck ==
  /\ s.phase = "feedback response"
  /\ s' = [s EXCEPT !.phase = "feedback ACK", !.feedbackAck = TRUE, !.historicalAck = TRUE]
VerifyFeedback ==
  /\ s.phase = "feedback ACK" /\ s.currentPremise
  /\ s' = [s EXCEPT !.phase = "published", !.published = TRUE]
FeedbackDrift ==
  /\ s.phase \in {"feedback ACK", "published", "needs reconcile"} /\ s.currentPremise
  /\ s' = [s EXCEPT !.currentPremise = FALSE]
RejectLateDrift ==
  /\ s.phase = "feedback ACK" /\ ~s.currentPremise
  /\ s' = [s EXCEPT !.phase = "needs review"]
FeedbackUnknown ==
  /\ s.phase \in {"feedback intent", "feedback inflight", "feedback response", "feedback ACK"}
  /\ s' = [s EXCEPT !.phase = "feedback unknown"]
ObserveHistoricalAck ==
  /\ s.phase = "feedback unknown" /\ s.feedbackAck
  /\ s' = [s EXCEPT !.phase = "feedback ACK"]
GuessFeedbackAck ==
  /\ InferFeedbackAck /\ s.phase = "feedback unknown" /\ s.feedbackApplied /\ ~s.historicalAck
  /\ s' = [s EXCEPT !.phase = "published", !.feedbackAck = TRUE, !.published = TRUE]
RedispatchFeedback ==
  /\ ReplayFeedback /\ s.phase = "feedback unknown" /\ s.feedbackAttempts < 2
  /\ s' = [s EXCEPT !.phase = "feedback inflight", !.feedbackAttempts = @ + 1, !.feedbackReplayed = TRUE]
ReplaceOriginal ==
  /\ ReplacePendingOriginal /\ s.phase \in {"binding unknown", "body unknown", "feedback unknown"}
  /\ s' = [s EXCEPT !.phase = "needs review", !.originalOperation = "replacement", !.pendingReplaced = TRUE]
PublishInvalidOutcome ==
  /\ AcceptInvalidOutcome /\ s.phase = "original blocked"
  /\ s' = [s EXCEPT !.phase = "published", !.published = TRUE, !.historicalAck = TRUE, !.feedbackAck = TRUE]
GuessOriginalSuccess ==
  /\ InferOriginalFromCurrent /\ s.phase = "body unknown" /\ s.bodyCurrentEqual
  /\ s' = [s EXCEPT !.phase = "published", !.published = TRUE, !.historicalAck = TRUE, !.feedbackAck = TRUE]
ForgetHistoricalAck ==
  /\ DropHistoricalAck /\ s.historicalAck /\ ~s.currentPremise /\ s.feedbackAck
  /\ s' = [s EXCEPT !.feedbackAck = FALSE]
Done ==
  /\ s.phase \in {"binding unknown", "body unknown", "feedback unknown", "original blocked", "needs review", "published"}
  /\ UNCHANGED vars
Next == RetainOriginalPlan \/ InvalidPremise \/ ProcessingAck \/ ProcessingReadback
        \/ BindingLost \/ BindingConflict \/ IgnoreUnverifiedBinding \/ CheckBodyPremise
        \/ RejectBodyPremise \/ BodyDispatch \/ BodyProviderApplies \/ RetainOriginalOutcome
        \/ BodyUnknown \/ PrepareFeedback \/ FeedbackBudgetExhausted \/ ReconcileOriginal
        \/ RejectReconcilePremise \/ RepeatBody \/ ExistingFeedbackRemainsUnknown \/ RetainFeedbackIntent \/ FeedbackDispatch
        \/ FeedbackProviderApplies \/ RetainFeedbackAck \/ VerifyFeedback \/ FeedbackDrift
        \/ RejectLateDrift \/ FeedbackUnknown \/ ObserveHistoricalAck \/ GuessFeedbackAck
        \/ RedispatchFeedback \/ ReplaceOriginal \/ PublishInvalidOutcome \/ GuessOriginalSuccess
        \/ ForgetHistoricalAck \/ Done
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ s.scenario \in Scenarios
  /\ s.phase \in {"inspect", "binding retained", "binding ACK", "binding unknown", "before body",
       "body ready", "body inflight", "body response", "body known", "body unknown", "feedback ready",
       "feedback intent", "feedback inflight", "feedback response", "feedback ACK", "feedback unknown",
       "needs reconcile", "original blocked", "needs review", "published"}
  /\ s.bodyAttempts \in 0..2 /\ s.feedbackAttempts \in 0..2
  /\ s.originalOutcome \in {"unresolved", "applied"}
  /\ \A key \in {"currentPremise", "bindingVerified", "bodyApplied", "bodyCurrentEqual",
       "bodySentWithPremise", "bodySentWithBinding", "feedbackApplied", "feedbackReplayed", "feedbackAck",
       "historicalAck", "published", "pendingReplaced"} : s[key] \in BOOLEAN
BodyNeedsBoundOriginal == s.bodySentWithBinding
BodyNeedsCurrentPremise == s.bodySentWithPremise
FeedbackNeverRepeatsBody == s.bodyAttempts <= 1
FeedbackRequiresRealAck == s.published => s.historicalAck
UnknownFeedbackNeverRedispatched == ~s.feedbackReplayed /\ s.feedbackAttempts <= 1
OriginalRequestPreserved ==
  s.originalOperation = "original" /\ s.frozenInput = "submitted body and frontier" /\ ~s.pendingReplaced
SuccessNeedsAppliedOriginal ==
  s.published => s.originalOutcome = "applied" /\ s.submissionStatus = "submitted"
HistoricalAckPreserved == s.historicalAck => s.feedbackAck
=============================================================================

