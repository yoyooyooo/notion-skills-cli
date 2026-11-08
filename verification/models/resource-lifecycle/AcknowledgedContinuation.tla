-------------------- MODULE AcknowledgedContinuation --------------------
EXTENDS Naturals, FiniteSets
CONSTANT SkipCompleteAckSet, SkipFreshBody, SkipColdProof, ReplayUnknown
Files == {"main", "reference-a", "reference-b"}
Steps == 1..4
VARIABLES phase, originalAcks, originalRequestsExact, originalPages,
          originalOutcome, authorityExact, fresh, bodyCheckedBeforeWrite,
          step, attempts, applied, acked, verified, proofs, events,
          enabled, coldVerified
vars == <<phase, originalAcks, originalRequestsExact, originalPages,
          originalOutcome, authorityExact, fresh, bodyCheckedBeforeWrite,
          step, attempts, applied, acked, verified, proofs, events,
          enabled, coldVerified>>
OriginalAuthority == originalAcks = Files /\ originalRequestsExact
Init ==
  /\ phase = "inspect" /\ originalAcks \in SUBSET Files
  /\ originalRequestsExact \in BOOLEAN
  /\ originalPages = Files /\ originalOutcome = "needs_review"
  /\ authorityExact = TRUE /\ fresh = TRUE /\ bodyCheckedBeforeWrite = TRUE
  /\ step = 1 /\ attempts = [s \in Steps |-> 0]
  /\ applied = {} /\ acked = {} /\ verified = {}
  /\ proofs = {} /\ events = {} /\ enabled = FALSE /\ coldVerified = FALSE

Review ==
  /\ phase = "inspect" /\ (OriginalAuthority \/ SkipCompleteAckSet)
  /\ authorityExact' = (authorityExact /\ OriginalAuthority)
  /\ phase' = "reviewed"
  /\ UNCHANGED <<originalAcks, originalRequestsExact, originalPages, originalOutcome,
                  fresh, bodyCheckedBeforeWrite, step, attempts, applied, acked,
                  verified, proofs, events, enabled, coldVerified>>
LoseOriginalEvidence ==
  /\ phase = "reviewed" /\ originalRequestsExact
  /\ originalRequestsExact' = FALSE
  /\ UNCHANGED <<phase, originalAcks, originalPages, originalOutcome, authorityExact,
                  fresh, bodyCheckedBeforeWrite, step, attempts, applied, acked,
                  verified, proofs, events, enabled, coldVerified>>
Begin ==
  /\ phase = "reviewed" /\ (OriginalAuthority \/ SkipCompleteAckSet)
  /\ authorityExact' = (authorityExact /\ OriginalAuthority)
  /\ phase' = "ready"
  /\ UNCHANGED <<originalAcks, originalRequestsExact, originalPages, originalOutcome,
                  fresh, bodyCheckedBeforeWrite, step, attempts, applied, acked,
                  verified, proofs, events, enabled, coldVerified>>
RejectOriginalEvidence ==
  /\ phase \in {"inspect", "reviewed"} /\ ~OriginalAuthority
  /\ phase' = "blocked"
  /\ UNCHANGED <<originalAcks, originalRequestsExact, originalPages, originalOutcome,
                  authorityExact, fresh, bodyCheckedBeforeWrite, step, attempts,
                  applied, acked, verified, proofs, events, enabled, coldVerified>>
CurrentBodyChanges ==
  /\ phase \in {"reviewed", "ready"} /\ fresh /\ fresh' = FALSE
  /\ UNCHANGED <<phase, originalAcks, originalRequestsExact, originalPages,
                  originalOutcome, authorityExact, bodyCheckedBeforeWrite,
                  step, attempts, applied, acked, verified, proofs, events,
                  enabled, coldVerified>>
RejectCurrentBody ==
  /\ phase = "ready" /\ ~fresh /\ phase' = "blocked"
  /\ UNCHANGED <<originalAcks, originalRequestsExact, originalPages, originalOutcome,
                  authorityExact, fresh, bodyCheckedBeforeWrite, step, attempts,
                  applied, acked, verified, proofs, events, enabled, coldVerified>>

\* The four stages abstract retaining ACK facts, exact metadata/events,
\* enablement, and the separate immutable completion. Native pages already exist.
Dispatch ==
  /\ phase = "ready" /\ step \in Steps /\ attempts[step] = 0
  /\ (fresh \/ SkipFreshBody)
  /\ (step # 3 \/ ({1, 2} \subseteq verified /\ events = Files))
  /\ (step # 4 \/ (3 \in verified /\ enabled))
  /\ attempts' = [attempts EXCEPT ![step] = 1]
  /\ bodyCheckedBeforeWrite' = (bodyCheckedBeforeWrite /\ fresh)
  /\ phase' = "inflight"
  /\ UNCHANGED <<originalAcks, originalRequestsExact, originalPages, originalOutcome,
                  authorityExact, fresh, step, applied, acked, verified, proofs,
                  events, enabled, coldVerified>>
ProviderApplies ==
  /\ phase = "inflight" /\ applied' = applied \cup {step}
  /\ proofs' = IF step = 1 THEN originalAcks ELSE proofs
  /\ events' = IF step = 2 THEN Files ELSE events
  /\ enabled' = (enabled \/ step = 3) /\ phase' = "response"
  /\ UNCHANGED <<originalAcks, originalRequestsExact, originalPages, originalOutcome,
                  authorityExact, fresh, bodyCheckedBeforeWrite, step, attempts,
                  acked, verified, coldVerified>>
PersistAck ==
  /\ phase = "response" /\ acked' = acked \cup {step} /\ phase' = "readback"
  /\ UNCHANGED <<originalAcks, originalRequestsExact, originalPages, originalOutcome,
                  authorityExact, fresh, bodyCheckedBeforeWrite, step, attempts,
                  applied, verified, proofs, events, enabled, coldVerified>>
VerifyStage ==
  /\ phase = "readback" /\ step \in applied /\ step \in acked
  /\ verified' = verified \cup {step}
  /\ phase' = IF step = 4 THEN "completed" ELSE "ready"
  /\ step' = step + 1
  /\ UNCHANGED <<originalAcks, originalRequestsExact, originalPages, originalOutcome,
                  authorityExact, fresh, bodyCheckedBeforeWrite, attempts,
                  applied, acked, proofs, events, enabled, coldVerified>>
RequestUncertain ==
  /\ phase \in {"inflight", "response", "readback"} /\ phase' = "unknown"
  /\ UNCHANGED <<originalAcks, originalRequestsExact, originalPages, originalOutcome,
                  authorityExact, fresh, bodyCheckedBeforeWrite, step, attempts,
                  applied, acked, verified, proofs, events, enabled, coldVerified>>
ReplayIncompleteContinuation ==
  /\ ReplayUnknown /\ phase = "unknown" /\ attempts[step] = 1
  /\ attempts' = [attempts EXCEPT ![step] = 2] /\ phase' = "inflight"
  /\ UNCHANGED <<originalAcks, originalRequestsExact, originalPages, originalOutcome,
                  authorityExact, fresh, bodyCheckedBeforeWrite, step, applied,
                  acked, verified, proofs, events, enabled, coldVerified>>
ProofUnavailable ==
  /\ phase = "completed" /\ proofs = Files
  /\ proofs' \in (SUBSET Files) \ {Files}
  /\ UNCHANGED <<phase, originalAcks, originalRequestsExact, originalPages,
                  originalOutcome, authorityExact, fresh, bodyCheckedBeforeWrite,
                  step, attempts, applied, acked, verified, events, enabled,
                  coldVerified>>
ColdVerify ==
  /\ phase = "completed" /\ (proofs = Files \/ SkipColdProof)
  /\ coldVerified' = TRUE /\ phase' = "cold verified"
  /\ UNCHANGED <<originalAcks, originalRequestsExact, originalPages, originalOutcome,
                  authorityExact, fresh, bodyCheckedBeforeWrite, step, attempts,
                  applied, acked, verified, proofs, events, enabled>>
ColdReject ==
  /\ phase = "completed" /\ proofs # Files /\ phase' = "blocked"
  /\ UNCHANGED <<originalAcks, originalRequestsExact, originalPages, originalOutcome,
                  authorityExact, fresh, bodyCheckedBeforeWrite, step, attempts,
                  applied, acked, verified, proofs, events, enabled, coldVerified>>
ReadOnlyReconcile == /\ phase = "unknown" /\ UNCHANGED vars
Terminal == /\ phase \in {"blocked", "cold verified"} /\ UNCHANGED vars
Next == Review \/ LoseOriginalEvidence \/ Begin \/ RejectOriginalEvidence
        \/ CurrentBodyChanges \/ RejectCurrentBody \/ Dispatch \/ ProviderApplies
        \/ PersistAck \/ VerifyStage \/ RequestUncertain \/ ReplayIncompleteContinuation
        \/ ProofUnavailable \/ ColdVerify \/ ColdReject \/ ReadOnlyReconcile \/ Terminal
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ phase \in {"inspect", "reviewed", "ready", "inflight", "response", "readback",
                "unknown", "blocked", "completed", "cold verified"}
  /\ originalAcks \subseteq Files /\ originalRequestsExact \in BOOLEAN
  /\ originalPages \subseteq Files /\ originalOutcome = "needs_review"
  /\ authorityExact \in BOOLEAN /\ fresh \in BOOLEAN /\ bodyCheckedBeforeWrite \in BOOLEAN
  /\ step \in 1..5 /\ attempts \in [Steps -> 0..2]
  /\ applied \subseteq Steps /\ acked \subseteq Steps /\ verified \subseteq Steps
  /\ proofs \subseteq Files /\ events \subseteq Files
  /\ enabled \in BOOLEAN /\ coldVerified \in BOOLEAN
CompleteOriginalAuthority == authorityExact
OriginalHistoryPreserved == originalPages = Files /\ originalOutcome = "needs_review"
FreshBodyBeforeWrite == bodyCheckedBeforeWrite
AtMostOneContinuationDispatch == \A s \in Steps : attempts[s] <= 1
ConfirmationNeedsOriginalAck == verified \subseteq acked
EnableRequiresCompleteEvents == enabled => ({1, 2} \subseteq verified /\ events = Files)
ColdVerificationNeedsSharedProof == coldVerified => (proofs = Files /\ verified = Steps)
=============================================================================
