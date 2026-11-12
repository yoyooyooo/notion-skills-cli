--------------------------- MODULE RequestAdmission ---------------------------
EXTENDS Naturals, TLC
CONSTANTS BugCooldown, BugQueue, BugOperation, BugAttempts, BugUnknownRetry, BugRelease, BugLease, BugAttemptTimeout
VARIABLES phase, now, cooldown, lease, permit, attempts, mutating, queueWindow, queueEnd, attemptEnd,
          admittedEarly, expiredDispatch, excessAttempt, replayedUnknown, orphanedLease, lateResponse
vars == <<phase, now, cooldown, lease, permit, attempts, mutating, queueWindow, queueEnd, attemptEnd,
          admittedEarly, expiredDispatch, excessAttempt, replayedUnknown, orphanedLease, lateResponse>>
OperationEnd == 4
AttemptLimit == 2
Init ==
  /\ phase = "ready" /\ now = 0 /\ cooldown = 1
  /\ lease = FALSE /\ permit = FALSE /\ attempts = 0 /\ mutating \in BOOLEAN
  /\ queueWindow \in {2, 5} /\ queueEnd = 0 /\ attemptEnd = 0
  /\ admittedEarly = FALSE /\ expiredDispatch = FALSE /\ excessAttempt = FALSE
  /\ replayedUnknown = FALSE /\ orphanedLease = FALSE /\ lateResponse = FALSE
Enqueue ==
  /\ phase \in {"ready", "retry"}
  /\ (now < OperationEnd \/ BugOperation) /\ (attempts < AttemptLimit \/ BugAttempts)
  /\ phase' = "queued" /\ queueEnd' = now + queueWindow /\ lease' = TRUE
  /\ UNCHANGED <<now, cooldown, permit, attempts, mutating, queueWindow, attemptEnd,
                  admittedEarly, expiredDispatch, excessAttempt, replayedUnknown, orphanedLease, lateResponse>>
AdvanceClock ==
  /\ phase \in {"queued", "inflight", "admitted"} /\ now < OperationEnd
  /\ now' = now + 1
  /\ UNCHANGED <<phase, cooldown, lease, permit, attempts, mutating, queueWindow, queueEnd, attemptEnd,
                  admittedEarly, expiredDispatch, excessAttempt, replayedUnknown, orphanedLease, lateResponse>>
Admit ==
  /\ phase = "queued" /\ (now >= cooldown \/ BugCooldown)
  /\ (now < queueEnd \/ BugQueue) /\ (now < OperationEnd \/ BugOperation)
  /\ phase' = "admitted" /\ lease' = FALSE /\ permit' = TRUE
  /\ admittedEarly' = (admittedEarly \/ now < cooldown)
  /\ expiredDispatch' = (expiredDispatch \/ now >= queueEnd \/ now >= OperationEnd)
  /\ UNCHANGED <<now, cooldown, attempts, mutating, queueWindow, queueEnd, attemptEnd, excessAttempt,
                  replayedUnknown, orphanedLease, lateResponse>>
StartAttempt ==
  /\ phase = "admitted" /\ (now < OperationEnd \/ BugOperation)
  /\ (attempts < AttemptLimit \/ BugAttempts) /\ attempts < AttemptLimit + 1
  /\ phase' = "inflight" /\ attempts' = attempts + 1 /\ attemptEnd' = now + 1
  /\ excessAttempt' = (excessAttempt \/ attempts >= AttemptLimit)
  /\ expiredDispatch' = (expiredDispatch \/ now >= OperationEnd)
  /\ UNCHANGED <<now, cooldown, lease, permit, mutating, queueWindow, queueEnd,
                  admittedEarly, replayedUnknown, orphanedLease, lateResponse>>
RejectBudget ==
  /\ phase \in {"ready", "retry", "admitted"}
  /\ (now >= OperationEnd \/ attempts >= AttemptLimit)
  /\ phase' = "budget" /\ permit' = FALSE
  /\ UNCHANGED <<now, cooldown, lease, attempts, mutating, queueWindow, queueEnd, attemptEnd,
                  admittedEarly, expiredDispatch, excessAttempt, replayedUnknown, orphanedLease, lateResponse>>
Success ==
  /\ phase = "inflight" /\ now < OperationEnd
  /\ (now < attemptEnd \/ BugAttemptTimeout)
  /\ phase' = "done" /\ permit' = FALSE /\ lateResponse' = (now >= attemptEnd)
  /\ UNCHANGED <<now, cooldown, lease, attempts, mutating, queueWindow, queueEnd, attemptEnd,
                  admittedEarly, expiredDispatch, excessAttempt, replayedUnknown, orphanedLease>>
ReadFailure ==
  /\ phase = "inflight" /\ ~mutating /\ now < attemptEnd /\ now < OperationEnd
  /\ phase' = "retry" /\ cooldown' = now + 1 /\ permit' = BugRelease
  /\ UNCHANGED <<now, lease, attempts, mutating, queueWindow, queueEnd, attemptEnd,
                  admittedEarly, expiredDispatch, excessAttempt, replayedUnknown, orphanedLease, lateResponse>>
DefinitiveWriteRejection ==
  /\ phase = "inflight" /\ mutating /\ now < attemptEnd /\ now < OperationEnd
  /\ phase' = "retry" /\ cooldown' = now + 1 /\ permit' = BugRelease
  /\ UNCHANGED <<now, lease, attempts, mutating, queueWindow, queueEnd, attemptEnd,
                  admittedEarly, expiredDispatch, excessAttempt, replayedUnknown, orphanedLease, lateResponse>>
UnknownWrite ==
  /\ phase = "inflight" /\ mutating
  /\ phase' = "unknown" /\ permit' = FALSE
  /\ UNCHANGED <<now, cooldown, lease, attempts, mutating, queueWindow, queueEnd, attemptEnd,
                  admittedEarly, expiredDispatch, excessAttempt, replayedUnknown, orphanedLease, lateResponse>>
AttemptTimeout ==
  /\ phase = "inflight" /\ (now >= attemptEnd \/ now >= OperationEnd)
  /\ phase' = IF mutating THEN "unknown" ELSE IF now >= OperationEnd THEN "budget" ELSE "retry"
  /\ cooldown' = IF ~mutating /\ now < OperationEnd THEN now + 1 ELSE cooldown
  /\ permit' = FALSE
  /\ UNCHANGED <<now, lease, attempts, mutating, queueWindow, queueEnd, attemptEnd,
                  admittedEarly, expiredDispatch, excessAttempt, replayedUnknown, orphanedLease, lateResponse>>
ReplayUnknown ==
  /\ phase = "unknown" /\ BugUnknownRetry
  /\ phase' = "retry" /\ replayedUnknown' = TRUE
  /\ UNCHANGED <<now, cooldown, lease, permit, attempts, mutating, queueWindow, queueEnd, attemptEnd,
                  admittedEarly, expiredDispatch, excessAttempt, orphanedLease, lateResponse>>
ExpireQueue ==
  /\ phase = "queued" /\ (now >= queueEnd \/ now >= OperationEnd)
  /\ phase' = "budget" /\ lease' = FALSE /\ permit' = FALSE
  /\ UNCHANGED <<now, cooldown, attempts, mutating, queueWindow, queueEnd, attemptEnd,
                  admittedEarly, expiredDispatch, excessAttempt, replayedUnknown, orphanedLease, lateResponse>>
CancelQueue ==
  /\ phase = "queued" /\ phase' = "cancelled" /\ lease' = BugLease
  /\ orphanedLease' = BugLease /\ permit' = FALSE
  /\ UNCHANGED <<now, cooldown, attempts, mutating, queueWindow, queueEnd, attemptEnd,
                  admittedEarly, expiredDispatch, excessAttempt, replayedUnknown, lateResponse>>
Done ==
  /\ phase \in {"done", "budget", "cancelled", "unknown"} /\ UNCHANGED vars
Next == Enqueue \/ AdvanceClock \/ Admit \/ StartAttempt \/ RejectBudget
        \/ Success \/ ReadFailure \/ DefinitiveWriteRejection \/ UnknownWrite \/ AttemptTimeout
        \/ ReplayUnknown \/ ExpireQueue \/ CancelQueue \/ Done
TypeOK ==
  /\ phase \in {"ready", "queued", "admitted", "inflight", "retry", "done", "budget", "cancelled", "unknown"}
  /\ now \in 0..OperationEnd /\ cooldown \in 0..(OperationEnd + 1)
  /\ queueWindow \in {2, 5} /\ queueEnd \in 0..(OperationEnd + 5) /\ attemptEnd \in 0..(OperationEnd + 1)
  /\ lease \in BOOLEAN /\ permit \in BOOLEAN /\ attempts \in 0..(AttemptLimit + 1)
  /\ mutating \in BOOLEAN /\ admittedEarly \in BOOLEAN /\ expiredDispatch \in BOOLEAN
  /\ excessAttempt \in BOOLEAN /\ replayedUnknown \in BOOLEAN /\ orphanedLease \in BOOLEAN /\ lateResponse \in BOOLEAN
CooldownBeforeAdmission == ~admittedEarly
CallerDeadlineRespected == ~expiredDispatch
AttemptBudgetRespected == ~excessAttempt
UnknownMutationNeverRetried == ~replayedUnknown
NoPermitDuringQueueOrBackoff == phase \in {"queued", "retry"} => ~permit
CancelledQueueReleasesLease == ~orphanedLease
AttemptDeadlineRespected == ~lateResponse
Spec == Init /\ [][Next]_vars
=============================================================================
