-------------------------- MODULE SourceSyncProgress --------------------------
EXTENDS Naturals, Sequences, TLC

CONSTANTS Scenario, Fault
ASSUME Scenario \in {"full", "resume", "hard", "completion", "foreign-completion"}
ASSUME Fault \in {"none", "skip-target", "rebind-input", "repeat-target",
                 "drop-batch-prefix", "advance-retry", "forget-hard-failure",
                 "foreign-parent-proof", "early-child-retirement"}

Sources == 1..2
Targets == 1..2
MaxInvocations == 6
\* A fresh budget pays one complete scope preflight and one target verification.
\* Real production progress needs at least this much room after its full preflight.
InvocationBudget == 2

VARIABLES phase, cursors, verified, cursorInput, requestedInput, budget,
          invocations, active, outcome, results, committedSources,
          childPending, parentProof, settling, crashed, transientUsed,
          hardSeen, reportedFailure, violations
vars == <<phase, cursors, verified, cursorInput, requestedInput, budget,
          invocations, active, outcome, results, committedSources,
          childPending, parentProof, settling, crashed, transientUsed,
          hardSeen, reportedFailure, violations>>

Current == Len(results) + 1
Terminal == phase \in {"finished", "blocked"}
ViolationNames == {"target-repeat", "source-repeat", "input", "parent-proof"}
CompletedChildren == {s \in 1..Len(results) : results[s] = "ok" /\ childPending[s]}
ParentAlreadySaved == Scenario \in {"completion", "foreign-completion"}

Init ==
  /\ phase = "preflight"
  /\ cursors = [s \in Sources |-> IF s = 1 /\ Scenario = "resume" THEN 1
                   ELSE IF s = 1 /\ ParentAlreadySaved THEN 2 ELSE 0]
  /\ verified = [s \in Sources |-> IF s = 1 /\ Scenario = "resume" THEN {1}
                    ELSE IF s = 1 /\ ParentAlreadySaved THEN Targets ELSE {}]
  /\ cursorInput = [s \in Sources |-> 0]
  /\ requestedInput = IF Scenario = "resume" THEN 1 ELSE 0
  /\ childPending = [s \in Sources |-> s = 1 /\ (Scenario = "resume" \/ ParentAlreadySaved)]
  /\ parentProof = [s \in Sources |-> IF s = 1 /\ Scenario = "foreign-completion" THEN 1 ELSE 0]
  /\ budget = InvocationBudget /\ invocations = 1
  /\ active = 0 /\ outcome = "none" /\ settling = 0
  /\ results = IF ParentAlreadySaved THEN <<"ok">> ELSE <<>>
  /\ committedSources = IF ParentAlreadySaved THEN {1} ELSE {}
  /\ crashed = FALSE /\ transientUsed = FALSE
  /\ hardSeen = FALSE /\ reportedFailure = FALSE /\ violations = {}

\* Complete scope/owner/source checks precede remaining Source work. A saved
\* successful parent first qualifies cleanup of any still-retained child.
CheckSource ==
  /\ phase = "preflight" /\ CompletedChildren = {}
  /\ Current \in Sources /\ budget > 0
  /\ LET repeated == Current \in committedSources
         hard == Scenario = "hard" /\ Current = 1
     IN /\ phase' = IF repeated THEN "blocked"
                    ELSE IF hard \/ cursors[Current] = 2 THEN "source_result" ELSE "target"
        /\ outcome' = IF hard THEN "hard"
                      ELSE IF cursors[Current] = 2 THEN "ok" ELSE "none"
        /\ childPending' = IF hard \/ repeated THEN childPending
                            ELSE [childPending EXCEPT ![Current] = TRUE]
        /\ violations' = violations \cup (IF repeated THEN {"source-repeat"} ELSE {})
  /\ budget' = budget - 1
  /\ UNCHANGED <<cursors, verified, cursorInput, requestedInput, invocations,
                 active, results, committedSources, parentProof, settling,
                 crashed, transientUsed, hardSeen, reportedFailure>>

\* One action abstracts the existing projection writer's observed exact result.
\* Re-observing an uncheckpointed target after a crash is allowed; entering an
\* already committed prefix is not. This does not model individual Notion writes.
ProjectTarget ==
  /\ phase = "target" /\ Current \in Sources /\ childPending[Current]
  /\ cursors[Current] < 2 /\ budget > 0
  /\ LET next == IF Fault = "repeat-target" /\ cursors[Current] > 0
                 THEN 1 ELSE cursors[Current] + 1
         rebound == Fault = "rebind-input" /\ cursors[Current] > 0 /\ requestedInput # 0
         repeated == next <= cursors[Current]
     IN /\ active' = next
        /\ phase' = IF repeated \/ rebound THEN "blocked" ELSE "checkpoint"
        /\ verified' = IF repeated \/ rebound THEN verified
                        ELSE [verified EXCEPT ![Current] = @ \cup {next}]
        /\ cursorInput' = IF rebound THEN [cursorInput EXCEPT ![Current] = requestedInput]
                          ELSE cursorInput
        /\ violations' = violations
             \cup (IF repeated THEN {"target-repeat"} ELSE {})
             \cup (IF rebound THEN {"input"} ELSE {})
  /\ budget' = budget - 1
  /\ UNCHANGED <<cursors, requestedInput, invocations, outcome, results,
                 committedSources, childPending, parentProof, settling,
                 crashed, transientUsed, hardSeen, reportedFailure>>

SaveProjectionCursor ==
  /\ phase = "checkpoint" /\ active \in verified[Current]
  /\ LET next == IF Fault = "skip-target" /\ active = 1 THEN 2 ELSE active
     IN /\ cursors' = [cursors EXCEPT ![Current] = next]
        /\ phase' = IF next = 2 THEN "source_result" ELSE "target"
        /\ outcome' = IF next = 2 THEN "ok" ELSE "none"
  /\ UNCHANGED <<verified, cursorInput, requestedInput, budget, invocations,
                 active, results, committedSources, childPending, parentProof,
                 settling, crashed, transientUsed, hardSeen, reportedFailure, violations>>

TemporaryFailure ==
  /\ phase = "target" /\ ~transientUsed
  /\ outcome' = "retry" /\ transientUsed' = TRUE
  /\ phase' = "source_result" /\ budget' = 0
  /\ UNCHANGED <<cursors, verified, cursorInput, requestedInput, invocations,
                 active, results, committedSources, childPending, parentProof,
                 settling, crashed, hardSeen, reportedFailure, violations>>

\* A successful Source completion first becomes an immutable parent result.
\* No disposable latest observation is needed to retain full-batch progress.
RecordSourceResult ==
  /\ phase = "source_result" /\ Current \in Sources /\ outcome # "none"
  /\ LET advance == outcome # "retry" \/ Fault = "advance-retry"
         cleanup == advance /\ outcome = "ok" /\ childPending[Current]
     IN /\ results' = IF advance THEN Append(results, outcome) ELSE results
        /\ committedSources' = IF advance THEN committedSources \cup {Current}
                                ELSE committedSources
        /\ parentProof' = IF cleanup THEN [parentProof EXCEPT ![Current] = cursorInput[Current]]
                          ELSE parentProof
        /\ settling' = IF cleanup THEN Current ELSE 0
        /\ phase' = IF outcome = "retry" THEN "paused"
                    ELSE IF cleanup THEN "cleanup" ELSE "preflight"
  /\ hardSeen' = (hardSeen \/ outcome = "hard")
  /\ outcome' = "none"
  /\ UNCHANGED <<cursors, verified, cursorInput, requestedInput, budget,
                 invocations, active, childPending, crashed, transientUsed,
                 reportedFailure, violations>>

BeginCompletedCleanup ==
  /\ phase = "preflight" /\ CompletedChildren # {}
  /\ settling' = CHOOSE s \in CompletedChildren : \A other \in CompletedChildren : s <= other
  /\ phase' = "cleanup"
  /\ UNCHANGED <<cursors, verified, cursorInput, requestedInput, budget,
                 invocations, active, outcome, results, committedSources,
                 childPending, parentProof, crashed, transientUsed,
                 hardSeen, reportedFailure, violations>>

\* Matching abstracts the exact operation, selection, projection and parent
\* ownership tuple. Cleanup is local and cannot reopen the remote Source work.
RetireCompletedChild ==
  /\ phase = "cleanup" /\ settling \in Sources /\ childPending[settling]
  /\ LET qualified == settling <= Len(results) /\ results[settling] = "ok"
                       /\ parentProof[settling] = cursorInput[settling]
         admitted == qualified \/ Fault = "foreign-parent-proof"
     IN /\ phase' = IF admitted THEN "preflight" ELSE "blocked"
        /\ childPending' = IF admitted THEN [childPending EXCEPT ![settling] = FALSE]
                           ELSE childPending
        /\ violations' = violations
             \cup (IF admitted /\ ~qualified THEN {"parent-proof"} ELSE {})
  /\ settling' = 0
  /\ UNCHANGED <<cursors, verified, cursorInput, requestedInput, budget,
                 invocations, active, outcome, results, committedSources,
                 parentProof, crashed, transientUsed, hardSeen, reportedFailure>>

RetireBeforeParent ==
  /\ Fault = "early-child-retirement" /\ phase = "source_result"
  /\ outcome = "ok" /\ Current \in Sources /\ childPending[Current]
  /\ childPending' = [childPending EXCEPT ![Current] = FALSE]
  /\ violations' = violations \cup {"parent-proof"}
  /\ phase' = "blocked"
  /\ UNCHANGED <<cursors, verified, cursorInput, requestedInput, budget,
                 invocations, active, outcome, results, committedSources,
                 parentProof, settling, crashed, transientUsed, hardSeen, reportedFailure>>

PauseBudget ==
  /\ phase \in {"preflight", "target"} /\ Current \in Sources /\ budget = 0
  /\ phase' = "paused"
  /\ UNCHANGED <<cursors, verified, cursorInput, requestedInput, budget,
                 invocations, active, outcome, results, committedSources,
                 childPending, parentProof, settling, crashed, transientUsed,
                 hardSeen, reportedFailure, violations>>

\* At most one crash occurs at either side of a local checkpoint boundary.
CrashBeforeCursorSave ==
  /\ phase = "checkpoint" /\ ~crashed
  /\ phase' = "paused" /\ crashed' = TRUE /\ budget' = 0
  /\ UNCHANGED <<cursors, verified, cursorInput, requestedInput, invocations,
                 active, outcome, results, committedSources, childPending,
                 parentProof, settling, transientUsed, hardSeen, reportedFailure, violations>>

CrashAfterParentSave ==
  /\ phase = "cleanup" /\ ~crashed
  /\ phase' = "paused" /\ crashed' = TRUE /\ budget' = 0 /\ settling' = 0
  /\ UNCHANGED <<cursors, verified, cursorInput, requestedInput, invocations,
                 active, outcome, results, committedSources, childPending,
                 parentProof, transientUsed, hardSeen, reportedFailure, violations>>

Resume ==
  /\ phase = "paused" /\ invocations < MaxInvocations
  /\ phase' = "preflight" /\ invocations' = invocations + 1
  /\ budget' = InvocationBudget /\ active' = 0 /\ outcome' = "none" /\ settling' = 0
  /\ results' = IF Fault = "drop-batch-prefix" THEN <<>> ELSE results
  /\ UNCHANGED <<cursors, verified, cursorInput, requestedInput, committedSources,
                 childPending, parentProof, crashed, transientUsed,
                 hardSeen, reportedFailure, violations>>

Finish ==
  /\ phase = "preflight" /\ Len(results) = 2 /\ CompletedChildren = {}
  /\ phase' = "finished"
  /\ reportedFailure' = IF Fault = "forget-hard-failure" THEN FALSE ELSE hardSeen
  /\ UNCHANGED <<cursors, verified, cursorInput, requestedInput, budget,
                 invocations, active, outcome, results, committedSources,
                 childPending, parentProof, settling, crashed, transientUsed, hardSeen, violations>>

Done == Terminal /\ UNCHANGED vars
Next == CheckSource \/ ProjectTarget \/ SaveProjectionCursor \/ TemporaryFailure
        \/ RecordSourceResult \/ BeginCompletedCleanup \/ RetireCompletedChild \/ RetireBeforeParent
        \/ PauseBudget \/ CrashBeforeCursorSave \/ CrashAfterParentSave \/ Resume \/ Finish \/ Done
Spec == Init /\ [][Next]_vars
        /\ WF_vars(CheckSource) /\ WF_vars(ProjectTarget \/ TemporaryFailure)
        /\ WF_vars(SaveProjectionCursor \/ CrashBeforeCursorSave)
        /\ WF_vars(RecordSourceResult \/ RetireBeforeParent)
        /\ WF_vars(BeginCompletedCleanup) /\ WF_vars(RetireCompletedChild \/ CrashAfterParentSave)
        /\ WF_vars(PauseBudget) /\ WF_vars(Resume) /\ WF_vars(Finish)

TypeOK ==
  /\ phase \in {"preflight", "target", "checkpoint", "source_result", "cleanup", "paused", "finished", "blocked"}
  /\ cursors \in [Sources -> 0..2] /\ verified \in [Sources -> SUBSET Targets]
  /\ cursorInput \in [Sources -> 0..1] /\ requestedInput \in 0..1
  /\ childPending \in [Sources -> BOOLEAN] /\ parentProof \in [Sources -> 0..1]
  /\ settling \in 0..2
  /\ budget \in 0..InvocationBudget /\ invocations \in 1..MaxInvocations
  /\ active \in 0..2 /\ outcome \in {"none", "ok", "hard", "retry"}
  /\ results \in UNION {[1..n -> {"ok", "hard", "retry"}] : n \in 0..2}
  /\ committedSources \subseteq Sources /\ crashed \in BOOLEAN /\ transientUsed \in BOOLEAN
  /\ hardSeen \in BOOLEAN /\ reportedFailure \in BOOLEAN /\ violations \subseteq ViolationNames

ProjectionCursorVerified == \A s \in Sources : (1..cursors[s]) \subseteq verified[s]
CursorBoundToFrozenInput == \A s \in Sources : cursors[s] > 0 => cursorInput[s] = 0
CommittedTargetNotReentered == "target-repeat" \notin violations
CommittedSourceNotReentered == "source-repeat" \notin violations
OnlyTerminalSourceResults == \A i \in 1..Len(results) : results[i] # "retry"
HardFailureRetained == (phase = "finished" /\ hardSeen) => reportedFailure
ParentCompletionBeforeChildRetirement == "parent-proof" \notin violations
ProgressEventuallyExplained == <>Terminal
=============================================================================
