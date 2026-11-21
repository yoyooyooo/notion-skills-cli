-------------------------- MODULE CurrentLifecycle --------------------------
EXTENDS Naturals, TLC

CONSTANTS IntentKind, OmitReadFence, ChangeNonContentOwner,
          RepeatUnknown, OmitCompletionCheck
ASSUME IntentKind \in {"content", "projection", "restore"}
ASSUME OmitReadFence \in BOOLEAN /\ ChangeNonContentOwner \in BOOLEAN
ASSUME RepeatUnknown \in BOOLEAN /\ OmitCompletionCheck \in BOOLEAN

VARIABLES phase, ownerState, ownerOperation, intentActive, version, trashed,
          accepted, dispatches, verified, foreignUsed, nonContentOwnerWrite,
          completionSafe, readPhase, readVersion, readBody, publicationSafe

vars == <<phase, ownerState, ownerOperation, intentActive, version, trashed,
          accepted, dispatches, verified, foreignUsed, nonContentOwnerWrite,
          completionSafe, readPhase, readVersion, readBody, publicationSafe>>

CurrentReady == ownerState = "ready" /\ ownerOperation = "none" /\ ~trashed
NonContent == IntentKind # "content"
PreserveReadyOwner == NonContent /\ ~ChangeNonContentOwner
Terminal == phase \in {"retired", "blocked"}

Init ==
  /\ phase = "idle"
  /\ ownerState = "ready"
  /\ ownerOperation = "none"
  /\ intentActive = FALSE
  /\ version = 0
  /\ trashed = (IntentKind = "restore")
  /\ accepted = FALSE
  /\ dispatches = 0
  /\ verified = FALSE
  /\ foreignUsed = FALSE
  /\ nonContentOwnerWrite = FALSE
  /\ completionSafe = TRUE
  /\ readPhase = "idle"
  /\ readVersion = 0
  /\ readBody = 0
  /\ publicationSafe = TRUE

Start ==
  /\ phase = "idle"
  /\ phase' = "active"
  /\ intentActive' = TRUE
  /\ ownerState' = IF PreserveReadyOwner THEN ownerState ELSE "applying"
  /\ ownerOperation' = IF PreserveReadyOwner THEN ownerOperation ELSE "local"
  /\ nonContentOwnerWrite' = (NonContent /\ ChangeNonContentOwner)
  /\ UNCHANGED <<version, trashed, accepted, dispatches, verified, foreignUsed,
                 completionSafe, readPhase, readVersion, readBody, publicationSafe>>

DispatchKnown ==
  /\ phase = "active"
  /\ phase' = "observed"
  /\ accepted' = TRUE
  /\ dispatches' = 1
  /\ version' = IF IntentKind = "content" THEN 1 ELSE version
  /\ trashed' = FALSE
  /\ UNCHANGED <<ownerState, ownerOperation, intentActive, verified, foreignUsed,
                 nonContentOwnerWrite, completionSafe, readPhase, readVersion,
                 readBody, publicationSafe>>

DispatchUnknown ==
  /\ phase = "active"
  /\ \E tookEffect \in BOOLEAN:
       /\ phase' = "unknown"
       /\ accepted' = tookEffect
       /\ dispatches' = 1
       /\ version' = IF tookEffect /\ IntentKind = "content" THEN 1 ELSE version
       /\ trashed' = IF tookEffect THEN FALSE ELSE trashed
       /\ ownerState' = IF PreserveReadyOwner THEN ownerState ELSE "attention"
  /\ UNCHANGED <<ownerOperation, intentActive, verified, foreignUsed,
                 nonContentOwnerWrite, completionSafe, readPhase, readVersion,
                 readBody, publicationSafe>>

ResumeUnknown ==
  /\ phase = "unknown"
  /\ phase' = IF accepted \/ RepeatUnknown THEN "observed" ELSE "blocked"
  /\ dispatches' = IF ~accepted /\ RepeatUnknown THEN 2 ELSE dispatches
  /\ accepted' = (accepted \/ RepeatUnknown)
  /\ version' = IF ~accepted /\ RepeatUnknown /\ IntentKind = "content" THEN 1 ELSE version
  /\ trashed' = IF ~accepted /\ RepeatUnknown THEN FALSE ELSE trashed
  /\ ownerState' = IF ~PreserveReadyOwner /\ (accepted \/ RepeatUnknown) THEN "applying" ELSE ownerState
  /\ UNCHANGED <<ownerOperation, intentActive, verified, foreignUsed,
                 nonContentOwnerWrite, completionSafe, readPhase, readVersion,
                 readBody, publicationSafe>>

VerifyTarget ==
  /\ phase = "observed"
  /\ phase' = "verified"
  /\ verified' = accepted
  /\ UNCHANGED <<ownerState, ownerOperation, intentActive, version, trashed,
                 accepted, dispatches, foreignUsed, nonContentOwnerWrite,
                 completionSafe, readPhase, readVersion, readBody, publicationSafe>>

ForeignWriterStarts ==
  /\ NonContent /\ phase \in {"observed", "verified"} /\ ~foreignUsed
  /\ ownerState' = "applying"
  /\ ownerOperation' = "foreign"
  /\ foreignUsed' = TRUE
  /\ version' = 1
  /\ UNCHANGED <<phase, intentActive, trashed, accepted, dispatches, verified,
                 nonContentOwnerWrite, completionSafe, readPhase, readVersion,
                 readBody, publicationSafe>>

ForeignWriterFinishes ==
  /\ ownerOperation = "foreign"
  /\ ownerState' = "ready"
  /\ ownerOperation' = "none"
  /\ UNCHANGED <<phase, intentActive, version, trashed, accepted, dispatches,
                 verified, foreignUsed, nonContentOwnerWrite, completionSafe,
                 readPhase, readVersion, readBody, publicationSafe>>

Finish ==
  /\ phase = "verified" /\ verified
  /\ LET qualified == IF PreserveReadyOwner THEN CurrentReady ELSE ownerOperation = "local"
         mayFinish == qualified \/ (NonContent /\ OmitCompletionCheck)
     IN
       /\ phase' = IF mayFinish THEN "retiring" ELSE "blocked"
       /\ completionSafe' = (completionSafe /\ qualified)
       /\ ownerState' = IF mayFinish /\ ~PreserveReadyOwner THEN "ready" ELSE ownerState
       /\ ownerOperation' = IF mayFinish /\ ~PreserveReadyOwner THEN "none" ELSE ownerOperation
  /\ UNCHANGED <<intentActive, version, trashed, accepted, dispatches, verified,
                 foreignUsed, nonContentOwnerWrite, readPhase, readVersion,
                 readBody, publicationSafe>>

Retire ==
  /\ phase = "retiring"
  /\ phase' = "retired"
  /\ intentActive' = FALSE
  /\ UNCHANGED <<ownerState, ownerOperation, version, trashed, accepted,
                 dispatches, verified, foreignUsed, nonContentOwnerWrite,
                 completionSafe, readPhase, readVersion, readBody, publicationSafe>>

BeginRead ==
  /\ readPhase = "idle" /\ CurrentReady
  /\ readPhase' = "metadata"
  /\ readVersion' = version
  /\ UNCHANGED <<phase, ownerState, ownerOperation, intentActive, version, trashed,
                 accepted, dispatches, verified, foreignUsed, nonContentOwnerWrite,
                 completionSafe, readBody, publicationSafe>>

ReadBody ==
  /\ readPhase = "metadata"
  /\ readPhase' = "body"
  /\ readBody' = version
  /\ UNCHANGED <<phase, ownerState, ownerOperation, intentActive, version, trashed,
                 accepted, dispatches, verified, foreignUsed, nonContentOwnerWrite,
                 completionSafe, readVersion, publicationSafe>>

PublishRead ==
  /\ readPhase = "body"
  /\ LET sameTree == readVersion = version /\ readBody = version
         allowed == CurrentReady /\ (sameTree \/ OmitReadFence)
     IN
       /\ readPhase' = IF allowed THEN "published" ELSE "rejected"
       /\ publicationSafe' = (publicationSafe /\ (~allowed \/ sameTree))
  /\ UNCHANGED <<phase, ownerState, ownerOperation, intentActive, version, trashed,
                 accepted, dispatches, verified, foreignUsed, nonContentOwnerWrite,
                 completionSafe, readVersion, readBody>>

Done ==
  /\ Terminal /\ readPhase \in {"idle", "published", "rejected"}
  /\ UNCHANGED vars

Next == Start \/ DispatchKnown \/ DispatchUnknown \/ ResumeUnknown \/ VerifyTarget
        \/ ForeignWriterStarts \/ ForeignWriterFinishes \/ Finish \/ Retire
        \/ BeginRead \/ ReadBody \/ PublishRead \/ Done

Spec == Init /\ [][Next]_vars
        /\ WF_vars(Start) /\ WF_vars(DispatchKnown \/ DispatchUnknown)
        /\ WF_vars(ResumeUnknown) /\ WF_vars(VerifyTarget)
        /\ WF_vars(Finish) /\ WF_vars(Retire)
        /\ WF_vars(ReadBody) /\ WF_vars(PublishRead)

TypeOK ==
  /\ phase \in {"idle", "active", "unknown", "observed", "verified", "retiring", "retired", "blocked"}
  /\ ownerState \in {"ready", "applying", "attention"}
  /\ ownerOperation \in {"none", "local", "foreign"}
  /\ intentActive \in BOOLEAN /\ version \in 0..1 /\ trashed \in BOOLEAN
  /\ accepted \in BOOLEAN /\ dispatches \in 0..2 /\ verified \in BOOLEAN
  /\ foreignUsed \in BOOLEAN /\ nonContentOwnerWrite \in BOOLEAN
  /\ completionSafe \in BOOLEAN /\ publicationSafe \in BOOLEAN
  /\ readPhase \in {"idle", "metadata", "body", "published", "rejected"}
  /\ readVersion \in 0..1 /\ readBody \in 0..1

ReadyHasNoContentOperation == ownerState = "ready" => ownerOperation = "none"
NonContentPreservesReadiness == ~nonContentOwnerWrite
UnknownNonIdempotentNeverRepeated == dispatches <= 1
NoMixedCurrentPublication == publicationSafe
NonContentCompletionQualified == phase \in {"retiring", "retired"} => completionSafe
NoFalseComplete == phase = "retired" => verified /\ accepted /\ ~intentActive
UnknownIntentRetained == phase = "blocked" /\ ~accepted => intentActive
OperationEventuallyExplained == <>Terminal
ReadEventuallyExplained == (readPhase \in {"metadata", "body"}) ~> (readPhase \in {"published", "rejected"})
=============================================================================
