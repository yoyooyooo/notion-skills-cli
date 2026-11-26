------------------------ MODULE RefreshRotation ------------------------
EXTENDS Naturals, FiniteSets, TLC
CONSTANTS Actors, GuardLock, ReadInsideLock, GuardEpoch, GuardCAS, GuardUncertainty, GuardCrashRecovery, AllowCrash
VARIABLES pc, lock, epoch, grant, diskRev, serverRev, readRev, sentRev,
          sentEpoch, responseRev, attempts, clock,
          badEpochCommit, badRevisionCommit, badStaleDispatch, badReplay,
          flightOwner, crashUsed, ambiguousPriorAttempt, badAbandonedReplay
vars == <<pc, lock, epoch, grant, diskRev, serverRev, readRev, sentRev,
          sentEpoch, responseRev, attempts, clock,
          badEpochCommit, badRevisionCommit, badStaleDispatch, badReplay,
          flightOwner, crashUsed, ambiguousPriorAttempt, badAbandonedReplay>>
Terminal == {"done", "rejected", "reauth", "timeout", "crashed"}
Busy == {"locked", "prepared", "sent", "response", "uncertain"}
Abandoned == IF flightOwner \in Actors THEN pc[flightOwner] \in Terminal ELSE FALSE
AllTerminal == \A p \in Actors: pc[p] \in Terminal
Init ==
  /\ pc = [p \in Actors |-> "start"]
  /\ lock = "none"
  /\ epoch = 0
  /\ grant = "ready"
  /\ diskRev = 0
  /\ serverRev = 0
  /\ readRev = [p \in Actors |-> 0]
  /\ sentRev = [p \in Actors |-> 0]
  /\ sentEpoch = [p \in Actors |-> 0]
  /\ responseRev = [p \in Actors |-> 0]
  /\ attempts = [p \in Actors |-> 0]
  /\ clock = [p \in Actors |-> 0]
  /\ badEpochCommit = FALSE
  /\ badRevisionCommit = FALSE
  /\ badStaleDispatch = FALSE
  /\ badReplay = FALSE
  /\ flightOwner = "none"
  /\ crashUsed = FALSE
  /\ ambiguousPriorAttempt = FALSE
  /\ badAbandonedReplay = FALSE
Peek(p) ==
  /\ pc[p] = "start"
  /\ pc' = [pc EXCEPT ![p] = "snapshot"]
  /\ readRev' = [readRev EXCEPT ![p] = diskRev]
  /\ UNCHANGED <<flightOwner, crashUsed, ambiguousPriorAttempt, badAbandonedReplay, lock, epoch, grant, diskRev, serverRev, sentRev, sentEpoch,
       responseRev, attempts, clock, badEpochCommit, badRevisionCommit, badStaleDispatch, badReplay>>
Acquire(p) ==
  /\ pc[p] = "snapshot" /\ grant = "ready" /\ clock[p] < 2
  /\ (~GuardLock \/ lock = "none")
  /\ (~GuardCrashRecovery \/ ~Abandoned)
  /\ pc' = [pc EXCEPT ![p] = "locked"]
  /\ lock' = p
  /\ readRev' = [readRev EXCEPT ![p] = IF ReadInsideLock THEN diskRev ELSE @]
  /\ UNCHANGED <<flightOwner, crashUsed, ambiguousPriorAttempt, badAbandonedReplay, epoch, grant, diskRev, serverRev, sentRev, sentEpoch,
       responseRev, attempts, clock, badEpochCommit, badRevisionCommit, badStaleDispatch, badReplay>>
MarkInFlight(p) ==
  /\ pc[p] = "locked" /\ grant = "ready" /\ clock[p] < 2
  /\ (~GuardLock \/ lock = p)
  /\ (~GuardCrashRecovery \/ ~Abandoned)
  /\ pc' = [pc EXCEPT ![p] = "prepared"]
  /\ flightOwner' = p
  /\ UNCHANGED <<lock, epoch, grant, diskRev, serverRev, readRev, sentRev, sentEpoch,
       responseRev, attempts, clock, badEpochCommit, badRevisionCommit, badStaleDispatch, badReplay,
       crashUsed, ambiguousPriorAttempt, badAbandonedReplay>>
Send(p) ==
  /\ pc[p] = "prepared" /\ grant = "ready" /\ clock[p] < 2
  /\ (~GuardLock \/ lock = p)
  /\ (~GuardCrashRecovery \/ ~Abandoned)
  /\ pc' = [pc EXCEPT ![p] = "sent"]
  /\ sentRev' = [sentRev EXCEPT ![p] = readRev[p]]
  /\ sentEpoch' = [sentEpoch EXCEPT ![p] = epoch]
  /\ attempts' = [attempts EXCEPT ![p] = 1]
  /\ badStaleDispatch' = (badStaleDispatch \/ readRev[p] # diskRev)
  /\ badAbandonedReplay' = (badAbandonedReplay \/ ambiguousPriorAttempt)
  /\ UNCHANGED <<flightOwner, crashUsed, ambiguousPriorAttempt, lock, epoch, grant, diskRev, serverRev, readRev,
       responseRev, clock, badEpochCommit, badRevisionCommit, badReplay>>
Receive(p) ==
  /\ pc[p] = "sent"
  /\ sentRev[p] + 1 >= serverRev
  /\ pc' = [pc EXCEPT ![p] = "response"]
  /\ serverRev' = serverRev + 1
  /\ responseRev' = [responseRev EXCEPT ![p] = serverRev + 1]
  /\ UNCHANGED <<flightOwner, crashUsed, ambiguousPriorAttempt, badAbandonedReplay, lock, epoch, grant, diskRev, readRev, sentRev, sentEpoch,
       attempts, clock, badEpochCommit, badRevisionCommit, badStaleDispatch, badReplay>>
LoseResponse(p) ==
  /\ pc[p] = "sent"
  /\ sentRev[p] + 1 >= serverRev
  /\ pc' = [pc EXCEPT ![p] = "uncertain"]
  /\ serverRev' = serverRev + 1
  /\ grant' = IF grant = "logged_out" THEN grant ELSE "uncertain"
  /\ UNCHANGED <<flightOwner, crashUsed, ambiguousPriorAttempt, badAbandonedReplay, lock, epoch, diskRev, readRev, sentRev, sentEpoch,
       responseRev, attempts, clock, badEpochCommit, badRevisionCommit, badStaleDispatch, badReplay>>
Reject(p) ==
  /\ pc[p] = "sent"
  /\ pc' = [pc EXCEPT ![p] = "rejected"]
  /\ grant' = IF grant = "logged_out" THEN grant ELSE "reauth_required"
  /\ lock' = IF lock = p THEN "none" ELSE lock
  /\ UNCHANGED <<flightOwner, crashUsed, ambiguousPriorAttempt, badAbandonedReplay, epoch, diskRev, serverRev, readRev, sentRev, sentEpoch,
       responseRev, attempts, clock, badEpochCommit, badRevisionCommit, badStaleDispatch, badReplay>>
EpochValid(p) == sentEpoch[p] = epoch /\ grant = "ready" /\ clock[p] < 2
RevisionValid(p) == readRev[p] = diskRev /\ responseRev[p] > diskRev
Commit(p) ==
  /\ pc[p] = "response"
  /\ (~GuardEpoch \/ EpochValid(p))
  /\ (~GuardCAS \/ RevisionValid(p))
  /\ pc' = [pc EXCEPT ![p] = "done"]
  /\ lock' = IF lock = p THEN "none" ELSE lock
  /\ diskRev' = responseRev[p]
  /\ flightOwner' = IF flightOwner = p THEN "none" ELSE flightOwner
  /\ grant' = "ready"
  /\ badEpochCommit' = (badEpochCommit \/ ~EpochValid(p))
  /\ badRevisionCommit' = (badRevisionCommit \/ ~RevisionValid(p))
  /\ UNCHANGED <<crashUsed, ambiguousPriorAttempt, badAbandonedReplay, epoch, serverRev, readRev, sentRev, sentEpoch, responseRev,
       attempts, clock, badStaleDispatch, badReplay>>
RejectCommit(p) ==
  /\ pc[p] = "response"
  /\ ((GuardEpoch /\ ~EpochValid(p)) \/ (GuardCAS /\ ~RevisionValid(p)))
  /\ pc' = [pc EXCEPT ![p] = "rejected"]
  /\ lock' = IF lock = p THEN "none" ELSE lock
  /\ UNCHANGED <<flightOwner, crashUsed, ambiguousPriorAttempt, badAbandonedReplay, epoch, grant, diskRev, serverRev, readRev, sentRev, sentEpoch,
       responseRev, attempts, clock, badEpochCommit, badRevisionCommit, badStaleDispatch, badReplay>>
RequireReauth(p) ==
  /\ pc[p] = "uncertain"
  /\ pc' = [pc EXCEPT ![p] = "reauth"]
  /\ lock' = IF lock = p THEN "none" ELSE lock
  /\ UNCHANGED <<flightOwner, crashUsed, ambiguousPriorAttempt, badAbandonedReplay, epoch, grant, diskRev, serverRev, readRev, sentRev, sentEpoch,
       responseRev, attempts, clock, badEpochCommit, badRevisionCommit, badStaleDispatch, badReplay>>
Replay(p) ==
  /\ ~GuardUncertainty /\ pc[p] = "uncertain" /\ attempts[p] = 1 /\ clock[p] < 2
  /\ pc' = [pc EXCEPT ![p] = "sent"]
  /\ attempts' = [attempts EXCEPT ![p] = 2]
  /\ badReplay' = TRUE
  /\ UNCHANGED <<flightOwner, crashUsed, ambiguousPriorAttempt, badAbandonedReplay, lock, epoch, grant, diskRev, serverRev, readRev, sentRev, sentEpoch,
       responseRev, clock, badEpochCommit, badRevisionCommit, badStaleDispatch>>
Crash(p) ==
  /\ AllowCrash /\ ~crashUsed /\ pc[p] \in Busy
  /\ pc' = [pc EXCEPT ![p] = "crashed"]
  /\ lock' = IF lock = p THEN "none" ELSE lock
  /\ crashUsed' = TRUE
  /\ ambiguousPriorAttempt' = (ambiguousPriorAttempt \/ pc[p] # "locked")
  /\ UNCHANGED <<epoch, grant, diskRev, serverRev, readRev, sentRev, sentEpoch,
       responseRev, attempts, clock, badEpochCommit, badRevisionCommit, badStaleDispatch, badReplay,
       flightOwner, badAbandonedReplay>>
RecoverAbandoned(p) ==
  /\ pc[p] = "snapshot" /\ lock = "none" /\ Abandoned
  /\ pc' = [pc EXCEPT ![p] = "reauth"]
  /\ grant' = IF grant = "logged_out" THEN grant ELSE "uncertain"
  /\ UNCHANGED <<lock, epoch, diskRev, serverRev, readRev, sentRev, sentEpoch,
       responseRev, attempts, clock, badEpochCommit, badRevisionCommit, badStaleDispatch, badReplay,
       flightOwner, crashUsed, ambiguousPriorAttempt, badAbandonedReplay>>
Logout ==
  /\ epoch = 0
  /\ epoch' = 1
  /\ grant' = "logged_out"
  /\ UNCHANGED <<flightOwner, crashUsed, ambiguousPriorAttempt, badAbandonedReplay, pc, lock, diskRev, serverRev, readRev, sentRev, sentEpoch,
       responseRev, attempts, clock, badEpochCommit, badRevisionCommit, badStaleDispatch, badReplay>>
AdvanceClock(p) ==
  /\ pc[p] \notin Terminal /\ clock[p] < 2
  /\ clock' = [clock EXCEPT ![p] = @ + 1]
  /\ UNCHANGED <<flightOwner, crashUsed, ambiguousPriorAttempt, badAbandonedReplay,
       pc, lock, epoch, grant, diskRev, serverRev, readRev, sentRev,
       sentEpoch, responseRev, attempts, badEpochCommit, badRevisionCommit, badStaleDispatch, badReplay>>
Timeout(p) ==
  /\ clock[p] = 2 /\ pc[p] \notin Terminal
  /\ pc' = [pc EXCEPT ![p] = "timeout"]
  /\ lock' = IF lock = p THEN "none" ELSE lock
  /\ ambiguousPriorAttempt' = (ambiguousPriorAttempt \/ pc[p] \in {"prepared","sent","response","uncertain"})
  /\ UNCHANGED <<flightOwner, crashUsed, badAbandonedReplay,
       epoch, grant, diskRev, serverRev, readRev, sentRev, sentEpoch,
       responseRev, attempts, clock, badEpochCommit, badRevisionCommit, badStaleDispatch, badReplay>>
Done == AllTerminal /\ UNCHANGED vars
Next == (\E p \in Actors: Peek(p) \/ Acquire(p) \/ MarkInFlight(p) \/ Send(p) \/ Receive(p) \/
         LoseResponse(p) \/ Reject(p) \/ Commit(p) \/ RejectCommit(p) \/ RequireReauth(p) \/ Replay(p) \/ Crash(p) \/ RecoverAbandoned(p) \/ AdvanceClock(p) \/ Timeout(p))
        \/ Logout \/ Done
Spec == Init /\ [][Next]_vars
        /\ (\A p \in Actors: WF_vars(AdvanceClock(p)) /\ WF_vars(Timeout(p)))
TypeOK ==
  /\ pc \in [Actors -> {"start", "snapshot", "locked", "prepared", "sent", "response", "uncertain", "done", "rejected", "reauth", "timeout", "crashed"}]
  /\ lock \in Actors \cup {"none"}
  /\ epoch \in 0..1 /\ grant \in {"ready", "uncertain", "reauth_required", "logged_out"}
  /\ diskRev \in 0..4 /\ serverRev \in 0..4
  /\ readRev \in [Actors -> 0..4] /\ sentRev \in [Actors -> 0..4]
  /\ sentEpoch \in [Actors -> 0..1] /\ responseRev \in [Actors -> 0..4]
  /\ attempts \in [Actors -> 0..2] /\ clock \in [Actors -> 0..2]
  /\ badEpochCommit \in BOOLEAN /\ badRevisionCommit \in BOOLEAN
  /\ badStaleDispatch \in BOOLEAN /\ badReplay \in BOOLEAN
  /\ flightOwner \in Actors \cup {"none"}
  /\ crashUsed \in BOOLEAN /\ ambiguousPriorAttempt \in BOOLEAN /\ badAbandonedReplay \in BOOLEAN
ExclusiveRefresh == Cardinality({p \in Actors: pc[p] \in Busy}) <= 1
FreshDispatch == ~badStaleDispatch
CurrentGrantCommit == ~badEpochCommit
RevisionCommitSafe == ~badRevisionCommit
NoAmbiguousReplay == ~badReplay
NoAbandonedReplay == ~badAbandonedReplay
RequestsTerminate == <>AllTerminal
NoSuccessfulPair == ~(\A p \in Actors: pc[p] = "done")
=============================================================================
