--------------------------- MODULE CreateRecovery ---------------------------
EXTENDS Naturals, FiniteSets
CONSTANT SkipOriginalSetGuard, ReplayUnknown, SkipProjectionPrecheck
Flavors == {"known failure", "sole main ACK"}
Steps == 1..3
Prefix(flavor) == IF flavor = "known failure" THEN {"main", "reference-a", "reference-b"}
                 ELSE {"main"}
Files(flavor) == Prefix(flavor) \cup {"suffix"}
Original(flavor) == IF flavor = "known failure" THEN "needs_review" ELSE "absent"
VARIABLES phase, flavor, originalOutcome, originalPages, originalSetComplete,
          admissionsExact, fresh, step, attempts, applied, acked, verified,
          requestKind, authorityBeforeWrite, bodyWriteSent, events, enabled
vars == <<phase, flavor, originalOutcome, originalPages, originalSetComplete,
          admissionsExact, fresh, step, attempts, applied, acked, verified,
          requestKind, authorityBeforeWrite, bodyWriteSent, events, enabled>>
Init ==
  /\ phase = "inspect"
  /\ flavor \in Flavors
  /\ originalOutcome = Original(flavor)
  /\ originalPages = Prefix(flavor)
  /\ originalSetComplete \in BOOLEAN
  /\ admissionsExact = TRUE /\ fresh = TRUE /\ step = 1
  /\ attempts = [s \in Steps |-> 0] /\ applied = {} /\ acked = {} /\ verified = {}
  /\ requestKind = "none" /\ authorityBeforeWrite = TRUE
  /\ bodyWriteSent = FALSE /\ events = {} /\ enabled = FALSE

Review ==
  /\ phase = "inspect" /\ (originalSetComplete \/ SkipOriginalSetGuard)
  /\ admissionsExact' = (admissionsExact /\ originalSetComplete)
  /\ phase' = "reviewed"
  /\ UNCHANGED <<flavor, originalOutcome, originalPages, originalSetComplete,
                  fresh, step, attempts, applied, acked, verified, requestKind,
                  authorityBeforeWrite, bodyWriteSent, events, enabled>>
OriginalSetChanges ==
  /\ phase = "reviewed" /\ originalSetComplete
  /\ originalSetComplete' = FALSE
  /\ UNCHANGED <<phase, flavor, originalOutcome, originalPages, admissionsExact,
                  fresh, step, attempts, applied, acked, verified, requestKind,
                  authorityBeforeWrite, bodyWriteSent, events, enabled>>
StartSeparateRecovery ==
  /\ phase = "reviewed" /\ (originalSetComplete \/ SkipOriginalSetGuard)
  /\ admissionsExact' = (admissionsExact /\ originalSetComplete)
  /\ phase' = "ready"
  /\ UNCHANGED <<flavor, originalOutcome, originalPages, originalSetComplete,
                  fresh, step, attempts, applied, acked, verified, requestKind,
                  authorityBeforeWrite, bodyWriteSent, events, enabled>>
RejectOriginalSet ==
  /\ phase \in {"inspect", "reviewed"} /\ ~originalSetComplete
  /\ phase' = "blocked"
  /\ UNCHANGED <<flavor, originalOutcome, originalPages, originalSetComplete,
                  admissionsExact, fresh, step, attempts, applied, acked, verified,
                  requestKind, authorityBeforeWrite, bodyWriteSent, events, enabled>>
CurrentScopeChanges ==
  /\ phase = "ready" /\ fresh /\ step \in Steps
  /\ fresh' = FALSE
  /\ UNCHANGED <<phase, flavor, originalOutcome, originalPages, originalSetComplete,
                  admissionsExact, step, attempts, applied, acked, verified,
                  requestKind, authorityBeforeWrite, bodyWriteSent, events, enabled>>
RejectCurrentScope ==
  /\ phase = "ready" /\ ~fresh /\ step \in Steps
  /\ phase' = "blocked"
  /\ UNCHANGED <<flavor, originalOutcome, originalPages, originalSetComplete,
                  admissionsExact, fresh, step, attempts, applied, acked, verified,
                  requestKind, authorityBeforeWrite, bodyWriteSent, events, enabled>>
ChooseMetadataRequest ==
  /\ phase = "ready" /\ step = 2 /\ requestKind = "none"
  /\ requestKind' \in {"exact projection", "other metadata", "body"}
  /\ UNCHANGED <<phase, flavor, originalOutcome, originalPages, originalSetComplete,
                  admissionsExact, fresh, step, attempts, applied, acked, verified,
                  authorityBeforeWrite, bodyWriteSent, events, enabled>>
RejectProjectionRequest ==
  /\ phase = "ready" /\ step = 2
  /\ requestKind \in {"other metadata", "body"} /\ ~SkipProjectionPrecheck
  /\ phase' = "blocked"
  /\ UNCHANGED <<flavor, originalOutcome, originalPages, originalSetComplete,
                  admissionsExact, fresh, step, attempts, applied, acked, verified,
                  requestKind, authorityBeforeWrite, bodyWriteSent, events, enabled>>
PublishInitialEvents ==
  /\ phase = "ready" /\ step = 3 /\ {1, 2} \subseteq verified /\ events = {}
  /\ events' = Files(flavor)
  /\ UNCHANGED <<phase, flavor, originalOutcome, originalPages, originalSetComplete,
                  admissionsExact, fresh, step, attempts, applied, acked, verified,
                  requestKind, authorityBeforeWrite, bodyWriteSent, enabled>>
Dispatch ==
  /\ phase = "ready" /\ step \in Steps /\ fresh /\ attempts[step] = 0
  /\ (step # 2 \/ (requestKind # "none" /\
                   (requestKind = "exact projection" \/ SkipProjectionPrecheck)))
  /\ (step # 3 \/ (events = Files(flavor) /\ {1, 2} \subseteq verified))
  /\ attempts' = [attempts EXCEPT ![step] = 1]
  /\ authorityBeforeWrite' = (authorityBeforeWrite /\
                              (step # 2 \/ requestKind = "exact projection"))
  /\ bodyWriteSent' = (bodyWriteSent \/ (step = 2 /\ requestKind = "body"))
  /\ phase' = "inflight"
  /\ UNCHANGED <<flavor, originalOutcome, originalPages, originalSetComplete,
                  admissionsExact, fresh, step, applied, acked, verified,
                  requestKind, events, enabled>>
ProviderApplies ==
  /\ phase = "inflight" /\ applied' = applied \cup {step}
  /\ enabled' = (enabled \/ step = 3) /\ phase' = "response"
  /\ UNCHANGED <<flavor, originalOutcome, originalPages, originalSetComplete,
                  admissionsExact, fresh, step, attempts, acked, verified,
                  requestKind, authorityBeforeWrite, bodyWriteSent, events>>
RequestUncertain ==
  /\ phase \in {"inflight", "response", "readback"} /\ phase' = "unknown"
  /\ UNCHANGED <<flavor, originalOutcome, originalPages, originalSetComplete,
                  admissionsExact, fresh, step, attempts, applied, acked, verified,
                  requestKind, authorityBeforeWrite, bodyWriteSent, events, enabled>>
PersistRecoveryAck ==
  /\ phase = "response" /\ acked' = acked \cup {step} /\ phase' = "readback"
  /\ UNCHANGED <<flavor, originalOutcome, originalPages, originalSetComplete,
                  admissionsExact, fresh, step, attempts, applied, verified,
                  requestKind, authorityBeforeWrite, bodyWriteSent, events, enabled>>
RejectAfterWrite ==
  /\ phase = "readback" /\ step = 2 /\ requestKind # "exact projection"
  /\ phase' = "blocked"
  /\ UNCHANGED <<flavor, originalOutcome, originalPages, originalSetComplete,
                  admissionsExact, fresh, step, attempts, applied, acked, verified,
                  requestKind, authorityBeforeWrite, bodyWriteSent, events, enabled>>
VerifyStage ==
  /\ phase = "readback" /\ step \in acked /\ step \in applied
  /\ (step # 2 \/ requestKind = "exact projection")
  /\ verified' = verified \cup {step} /\ step' = step + 1 /\ phase' = "ready"
  /\ UNCHANGED <<flavor, originalOutcome, originalPages, originalSetComplete,
                  admissionsExact, fresh, attempts, applied, acked, requestKind,
                  authorityBeforeWrite, bodyWriteSent, events, enabled>>
ReplayIncompleteRecovery ==
  /\ ReplayUnknown /\ phase = "unknown" /\ attempts[step] = 1
  /\ attempts' = [attempts EXCEPT ![step] = 2] /\ phase' = "inflight"
  /\ UNCHANGED <<flavor, originalOutcome, originalPages, originalSetComplete,
                  admissionsExact, fresh, step, applied, acked, verified, requestKind,
                  authorityBeforeWrite, bodyWriteSent, events, enabled>>
RecordSeparateCompletion ==
  /\ phase = "ready" /\ step = 4 /\ phase' = "completed"
  /\ UNCHANGED <<flavor, originalOutcome, originalPages, originalSetComplete,
                  admissionsExact, fresh, step, attempts, applied, acked, verified,
                  requestKind, authorityBeforeWrite, bodyWriteSent, events, enabled>>
ReadOnlyReconcile == /\ phase = "unknown" /\ UNCHANGED vars
Terminal == /\ phase \in {"blocked", "completed"} /\ UNCHANGED vars
Next == Review \/ OriginalSetChanges \/ StartSeparateRecovery \/ RejectOriginalSet
        \/ CurrentScopeChanges \/ RejectCurrentScope \/ ChooseMetadataRequest
        \/ RejectProjectionRequest \/ PublishInitialEvents \/ Dispatch
        \/ ProviderApplies \/ RequestUncertain \/ PersistRecoveryAck \/ RejectAfterWrite
        \/ VerifyStage \/ ReplayIncompleteRecovery \/ RecordSeparateCompletion
        \/ ReadOnlyReconcile \/ Terminal
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ phase \in {"inspect", "reviewed", "ready", "inflight", "response", "readback",
                "unknown", "blocked", "completed"}
  /\ flavor \in Flavors /\ originalOutcome \in {"needs_review", "absent"}
  /\ originalPages \subseteq Files(flavor)
  /\ originalSetComplete \in BOOLEAN /\ admissionsExact \in BOOLEAN /\ fresh \in BOOLEAN
  /\ step \in 1..4 /\ attempts \in [Steps -> 0..2]
  /\ applied \subseteq Steps /\ acked \subseteq Steps /\ verified \subseteq Steps
  /\ requestKind \in {"none", "exact projection", "other metadata", "body"}
  /\ authorityBeforeWrite \in BOOLEAN /\ bodyWriteSent \in BOOLEAN
  /\ events \subseteq Files(flavor) /\ enabled \in BOOLEAN
OriginalEvidenceRequired == admissionsExact
OriginalHistoryPreserved == originalOutcome = Original(flavor) /\ originalPages = Prefix(flavor)
AtMostOneRecoveryDispatch == \A s \in Steps : attempts[s] <= 1
ProjectionAuthorityBeforeWrite == authorityBeforeWrite
ExistingBodyWriteForbidden == ~bodyWriteSent
RecoveryConfirmationNeedsAck == verified \subseteq acked
EnableRequiresAllInitialFiles == enabled => (events = Files(flavor) /\ {1, 2} \subseteq verified)
CompletionRequiresAllStages == (phase = "completed") => (verified = Steps /\ enabled /\ events = Files(flavor))
=============================================================================
