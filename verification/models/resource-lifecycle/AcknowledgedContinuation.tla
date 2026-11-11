-------------------- MODULE AcknowledgedContinuation --------------------
EXTENDS Naturals, FiniteSets
CONSTANT SkipCompleteAckSet, SkipFreshBody, SkipColdProof, ReplayUnknown,
         NativeRestoration
Files == IF NativeRestoration THEN {"main", "reference-a"}
         ELSE {"main", "reference-a", "reference-b"}
OriginalFiles == IF NativeRestoration THEN {"main"} ELSE Files
EventStep == IF NativeRestoration THEN 3 ELSE 2
EnableStep == EventStep + 1
CompletionStep == EnableStep + 1
Steps == 1..CompletionStep
VARIABLES phase, originalAcks, originalRequestsExact, originalPages,
          originalOutcome, authorityExact, fresh, bodyCheckedBeforeWrite,
          step, attempts, applied, acked, verified, proofs, events,
          enabled, coldVerified, allocated
vars == <<phase, originalAcks, originalRequestsExact, originalPages,
          originalOutcome, authorityExact, fresh, bodyCheckedBeforeWrite,
          step, attempts, applied, acked, verified, proofs, events,
          enabled, coldVerified, allocated>>
OriginalAuthority == originalAcks = OriginalFiles /\ originalRequestsExact
Init ==
  /\ phase = "inspect" /\ originalAcks \in SUBSET OriginalFiles
  /\ originalRequestsExact \in BOOLEAN
  /\ originalPages = OriginalFiles /\ originalOutcome = "needs_review"
  /\ authorityExact = TRUE /\ fresh = TRUE /\ bodyCheckedBeforeWrite = TRUE
  /\ step = 1 /\ attempts = [s \in Steps |-> 0]
  /\ applied = {} /\ acked = {} /\ verified = {}
  /\ proofs = {} /\ events = {} /\ enabled = FALSE /\ coldVerified = FALSE
  /\ allocated = OriginalFiles

Review ==
  /\ phase = "inspect" /\ (OriginalAuthority \/ SkipCompleteAckSet)
  /\ authorityExact' = (authorityExact /\ OriginalAuthority)
  /\ phase' = "reviewed"
  /\ UNCHANGED <<originalAcks, originalRequestsExact, originalPages, originalOutcome,
                  fresh, bodyCheckedBeforeWrite, step, attempts, applied, acked,
                  verified, proofs, events, enabled, coldVerified, allocated>>
LoseOriginalEvidence ==
  /\ phase = "reviewed" /\ originalRequestsExact
  /\ originalRequestsExact' = FALSE
  /\ UNCHANGED <<phase, originalAcks, originalPages, originalOutcome, authorityExact,
                  fresh, bodyCheckedBeforeWrite, step, attempts, applied, acked,
                  verified, proofs, events, enabled, coldVerified, allocated>>
Begin ==
  /\ phase = "reviewed" /\ (OriginalAuthority \/ SkipCompleteAckSet)
  /\ authorityExact' = (authorityExact /\ OriginalAuthority)
  /\ phase' = "ready"
  /\ UNCHANGED <<originalAcks, originalRequestsExact, originalPages, originalOutcome,
                  fresh, bodyCheckedBeforeWrite, step, attempts, applied, acked,
                  verified, proofs, events, enabled, coldVerified, allocated>>
RejectOriginalEvidence ==
  /\ phase \in {"inspect", "reviewed"} /\ ~OriginalAuthority
  /\ phase' = "blocked"
  /\ UNCHANGED <<originalAcks, originalRequestsExact, originalPages, originalOutcome,
                  authorityExact, fresh, bodyCheckedBeforeWrite, step, attempts,
                  applied, acked, verified, proofs, events, enabled, coldVerified, allocated>>
CurrentBodyChanges ==
  /\ phase \in {"reviewed", "ready"} /\ fresh /\ fresh' = FALSE
  /\ UNCHANGED <<phase, originalAcks, originalRequestsExact, originalPages,
                  originalOutcome, authorityExact, bodyCheckedBeforeWrite,
                  step, attempts, applied, acked, verified, proofs, events,
                  enabled, coldVerified, allocated>>
RejectCurrentBody ==
  /\ phase = "ready" /\ ~fresh /\ phase' = "blocked"
  /\ UNCHANGED <<originalAcks, originalRequestsExact, originalPages, originalOutcome,
                  authorityExact, fresh, bodyCheckedBeforeWrite, step, attempts,
                  applied, acked, verified, proofs, events, enabled, coldVerified, allocated>>

\* The retained all-allocated branch has four stages. Exact native restoration
\* adds one original suffix allocation before the initial-event stage. Each
\* stage is bounded; intermediate immutable Record requests are not expanded.
Dispatch ==
  /\ phase = "ready" /\ step \in Steps /\ attempts[step] = 0
  /\ (fresh \/ SkipFreshBody)
  /\ (step # EventStep \/ (allocated = Files /\ (NativeRestoration => 2 \in verified)))
  /\ (step # EnableStep \/ (1..EventStep \subseteq verified /\ events = Files))
  /\ (step # CompletionStep \/ (EnableStep \in verified /\ enabled))
  /\ attempts' = [attempts EXCEPT ![step] = 1]
  /\ bodyCheckedBeforeWrite' = (bodyCheckedBeforeWrite /\ fresh)
  /\ phase' = "inflight"
  /\ UNCHANGED <<originalAcks, originalRequestsExact, originalPages, originalOutcome,
                  authorityExact, fresh, step, applied, acked, verified, proofs,
                  events, enabled, coldVerified, allocated>>
ProviderApplies ==
  /\ phase = "inflight" /\ applied' = applied \cup {step}
  /\ proofs' = IF step = 1 THEN originalAcks ELSE proofs
  /\ allocated' = IF NativeRestoration /\ step = 2 THEN Files ELSE allocated
  /\ events' = IF step = EventStep THEN Files ELSE events
  /\ enabled' = (enabled \/ step = EnableStep) /\ phase' = "response"
  /\ UNCHANGED <<originalAcks, originalRequestsExact, originalPages, originalOutcome,
                  authorityExact, fresh, bodyCheckedBeforeWrite, step, attempts,
                  acked, verified, coldVerified>>
PersistAck ==
  /\ phase = "response" /\ acked' = acked \cup {step} /\ phase' = "readback"
  /\ UNCHANGED <<originalAcks, originalRequestsExact, originalPages, originalOutcome,
                  authorityExact, fresh, bodyCheckedBeforeWrite, step, attempts,
                  applied, verified, proofs, events, enabled, coldVerified, allocated>>
VerifyStage ==
  /\ phase = "readback" /\ step \in applied /\ step \in acked
  /\ verified' = verified \cup {step}
  /\ phase' = IF step = CompletionStep THEN "completed" ELSE "ready"
  /\ step' = step + 1
  /\ UNCHANGED <<originalAcks, originalRequestsExact, originalPages, originalOutcome,
                  authorityExact, fresh, bodyCheckedBeforeWrite, attempts,
                  applied, acked, proofs, events, enabled, coldVerified, allocated>>
RequestUncertain ==
  /\ phase \in {"inflight", "response", "readback"} /\ phase' = "unknown"
  /\ UNCHANGED <<originalAcks, originalRequestsExact, originalPages, originalOutcome,
                  authorityExact, fresh, bodyCheckedBeforeWrite, step, attempts,
                  applied, acked, verified, proofs, events, enabled, coldVerified, allocated>>
ResumeAcknowledgedStage ==
  /\ phase = "unknown" /\ step \in acked /\ step \in applied
  /\ phase' = "readback"
  /\ UNCHANGED <<originalAcks, originalRequestsExact, originalPages, originalOutcome,
                  authorityExact, fresh, bodyCheckedBeforeWrite, step, attempts,
                  applied, acked, verified, proofs, events, enabled, coldVerified, allocated>>
ReplayIncompleteContinuation ==
  /\ ReplayUnknown /\ phase = "unknown" /\ attempts[step] = 1
  /\ attempts' = [attempts EXCEPT ![step] = 2] /\ phase' = "inflight"
  /\ UNCHANGED <<originalAcks, originalRequestsExact, originalPages, originalOutcome,
                  authorityExact, fresh, bodyCheckedBeforeWrite, step, applied,
                  acked, verified, proofs, events, enabled, coldVerified, allocated>>
ProofUnavailable ==
  /\ phase = "completed" /\ proofs = OriginalFiles
  /\ proofs' \in (SUBSET OriginalFiles) \ {OriginalFiles}
  /\ UNCHANGED <<phase, originalAcks, originalRequestsExact, originalPages,
                  originalOutcome, authorityExact, fresh, bodyCheckedBeforeWrite,
                  step, attempts, applied, acked, verified, events, enabled,
                  coldVerified, allocated>>
ColdVerify ==
  /\ phase = "completed" /\ (proofs = OriginalFiles \/ SkipColdProof)
  /\ coldVerified' = TRUE /\ phase' = "cold verified"
  /\ UNCHANGED <<originalAcks, originalRequestsExact, originalPages, originalOutcome,
                  authorityExact, fresh, bodyCheckedBeforeWrite, step, attempts,
                  applied, acked, verified, proofs, events, enabled, allocated>>
ColdReject ==
  /\ phase = "completed" /\ proofs # OriginalFiles /\ phase' = "blocked"
  /\ UNCHANGED <<originalAcks, originalRequestsExact, originalPages, originalOutcome,
                  authorityExact, fresh, bodyCheckedBeforeWrite, step, attempts,
                  applied, acked, verified, proofs, events, enabled, coldVerified, allocated>>
ReadOnlyReconcile == /\ phase = "unknown" /\ UNCHANGED vars
Terminal == /\ phase \in {"blocked", "cold verified"} /\ UNCHANGED vars
Next == Review \/ LoseOriginalEvidence \/ Begin \/ RejectOriginalEvidence
        \/ CurrentBodyChanges \/ RejectCurrentBody \/ Dispatch \/ ProviderApplies
        \/ PersistAck \/ VerifyStage \/ RequestUncertain \/ ResumeAcknowledgedStage
        \/ ReplayIncompleteContinuation
        \/ ProofUnavailable \/ ColdVerify \/ ColdReject \/ ReadOnlyReconcile \/ Terminal
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ phase \in {"inspect", "reviewed", "ready", "inflight", "response", "readback",
                "unknown", "blocked", "completed", "cold verified"}
  /\ originalAcks \subseteq OriginalFiles /\ originalRequestsExact \in BOOLEAN
  /\ originalPages \subseteq Files /\ originalOutcome = "needs_review"
  /\ authorityExact \in BOOLEAN /\ fresh \in BOOLEAN /\ bodyCheckedBeforeWrite \in BOOLEAN
  /\ step \in 1..(CompletionStep + 1) /\ attempts \in [Steps -> 0..2]
  /\ applied \subseteq Steps /\ acked \subseteq Steps /\ verified \subseteq Steps
  /\ proofs \subseteq OriginalFiles /\ events \subseteq Files /\ allocated \subseteq Files
  /\ enabled \in BOOLEAN /\ coldVerified \in BOOLEAN
CompleteOriginalAuthority == authorityExact
OriginalHistoryPreserved == originalPages = OriginalFiles /\ originalOutcome = "needs_review"
FreshBodyBeforeWrite == bodyCheckedBeforeWrite
AtMostOneContinuationDispatch == \A s \in Steps : attempts[s] <= 1
ConfirmationNeedsOriginalAck == verified \subseteq acked
EnableRequiresCompleteEvents == enabled => (1..EventStep \subseteq verified /\ events = Files /\ allocated = Files)
ColdVerificationNeedsSharedProof == coldVerified => (proofs = OriginalFiles /\ verified = Steps /\ events = Files /\ allocated = Files)
=============================================================================
