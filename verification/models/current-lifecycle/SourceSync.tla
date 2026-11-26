------------------------------ MODULE SourceSync ------------------------------
EXTENDS Naturals, TLC

CONSTANTS Scenario, Fault
ASSUME Scenario \in {"fresh", "resume", "projection", "foreign"}
ASSUME Fault \in {"none", "pending", "projection-scope", "moving-ref",
                 "configuration", "ownership", "projection-readiness"}

VARIABLES phase, source, projection, upstream, candidate, crashed, moved,
          violations, completedSource
vars == <<phase, source, projection, upstream, candidate, crashed, moved,
          violations, completedSource>>

Terminal == phase \in {"complete", "unchanged", "partial", "blocked"}
ViolationNames == {"pending", "projection", "frozen", "configuration", "ownership"}

\* Owner 2 is in the complete affected set but absent from the new target set.
\* A pending reading intent on that removed owner must fence the Source as well.
AffectedOwners == {1, 2}
NewTargets == {1}

Init ==
  /\ phase = "inspect"
  /\ \E who \in (IF Scenario = "resume" THEN {"owned"}
                 ELSE IF Scenario = "foreign" THEN {"foreign"} ELSE {"none"}),
        cursor \in (IF Scenario = "resume" THEN {1, 2}
                    ELSE IF Scenario = "projection" THEN {2} ELSE {0}):
       source = [intent |-> who, commit |-> 0, frozen |-> 0, cursor |-> cursor,
                 ready |-> (who # "owned" \/ cursor = 2), config |-> 0]
  /\ \E who \in (IF Scenario = "projection" THEN {"owned", "foreign"} ELSE {"none"}),
        owner \in (IF Scenario = "projection" THEN AffectedOwners ELSE {1}):
       projection = [intent |-> who, owner |-> owner]
  /\ \E commit \in (IF Scenario = "projection" THEN {1} ELSE {0, 1}),
        config \in (IF Scenario = "fresh" THEN {0, 1} ELSE {0}):
       upstream = [commit |-> commit, config |-> config]
  /\ candidate = 0
  /\ crashed = FALSE /\ moved = FALSE /\ violations = {}
  /\ completedSource = FALSE

InspectIntent ==
  /\ phase = "inspect"
  /\ LET pending == source.intent # "none" /\ Fault # "pending"
         allowed == source.intent = "owned" \/ Fault = "ownership"
     IN /\ phase' = IF ~pending THEN "preflight"
                    ELSE IF ~allowed THEN "blocked"
                    ELSE IF source.ready /\ source.cursor = 2 THEN "retire"
                    ELSE "prepared"
        /\ candidate' = IF pending /\ allowed THEN source.frozen ELSE candidate
        /\ source' = IF pending /\ allowed /\ source.intent = "foreign"
                     THEN [source EXCEPT !.intent = "owned"] ELSE source
        /\ violations' = violations \cup
             (IF pending /\ allowed /\ source.intent = "foreign" THEN {"ownership"} ELSE {})
  /\ UNCHANGED <<projection, upstream, crashed, moved, completedSource>>

InspectAffectedOwners ==
  /\ phase = "preflight"
  /\ LET visible == projection.intent # "none" /\
                    (Fault # "projection-scope" \/ projection.owner \in NewTargets)
         allowed == projection.intent = "owned" \/ Fault = "ownership"
     IN phase' = IF ~visible THEN "observe"
                 ELSE IF allowed THEN "old_projection" ELSE "blocked"
  /\ UNCHANGED <<source, projection, upstream, candidate, crashed, moved,
                 violations, completedSource>>

\* Settlement abstracts the existing finite projection writer. An unobservable
\* non-idempotent result can stop; this action does not retry its product request.
SettleOldProjection ==
  /\ phase = "old_projection"
  /\ \E settled \in BOOLEAN:
       /\ phase' = IF settled THEN "complete" ELSE "blocked"
       /\ projection' = IF settled THEN [projection EXCEPT !.intent = "none"] ELSE projection
       /\ completedSource' = (completedSource \/ settled)
  /\ violations' = violations \cup
       (IF projection.intent = "foreign" THEN {"ownership"} ELSE {})
  /\ UNCHANGED <<source, upstream, candidate, crashed, moved>>

ObserveRef ==
  /\ phase = "observe"
  /\ LET unchanged == upstream.commit = source.commit /\
                      (upstream.config = source.config \/ Fault = "configuration")
     IN /\ phase' = IF unchanged THEN "unchanged" ELSE "prepared"
        /\ candidate' = upstream.commit
        /\ source' = IF unchanged THEN source
                     ELSE [source EXCEPT !.frozen = upstream.commit]
        /\ violations' = violations
             \cup (IF source.intent # "none" THEN {"pending"} ELSE {})
             \cup (IF unchanged /\ upstream.config # source.config THEN {"configuration"} ELSE {})
  /\ UNCHANGED <<projection, upstream, crashed, moved, completedSource>>

ProviderUnavailable ==
  /\ phase = "observe" /\ phase' = "blocked"
  /\ UNCHANGED <<source, projection, upstream, candidate, crashed, moved,
                 violations, completedSource>>

BeginSource ==
  /\ phase = "prepared"
  /\ LET selected == IF Fault = "moving-ref" THEN upstream.commit ELSE candidate
         cursor == IF source.intent = "none" THEN 0 ELSE source.cursor
     IN /\ phase' = IF cursor = 2 THEN "verify" ELSE "applying"
        /\ source' = [source EXCEPT !.intent = "owned", !.commit = selected,
                       !.ready = FALSE, !.cursor = cursor]
        /\ violations' = violations
             \cup (IF projection.intent # "none" THEN {"projection"} ELSE {})
             \cup (IF selected # source.frozen THEN {"frozen"} ELSE {})
  /\ UNCHANGED <<projection, upstream, candidate, crashed, moved, completedSource>>

\* One step is an observed, verified child, not an atomic Notion transaction.
\* The lower writer's unknown-response/child-checkpoint behavior is tested in code.
ApplyChild ==
  /\ phase = "applying" /\ source.cursor < 2
  /\ source' = [source EXCEPT !.cursor = @ + 1]
  /\ phase' = IF source.cursor + 1 = 2 THEN "verify" ELSE "applying"
  /\ UNCHANGED <<projection, upstream, candidate, crashed, moved,
                 violations, completedSource>>

UnresolvedChild ==
  /\ phase = "applying" /\ phase' = "blocked"
  /\ UNCHANGED <<source, projection, upstream, candidate, crashed, moved,
                 violations, completedSource>>

PublishSource ==
  /\ phase = "verify" /\ source.cursor = 2
  /\ source' = [source EXCEPT !.ready = TRUE, !.config = upstream.config]
  /\ phase' = "retire"
  /\ UNCHANGED <<projection, upstream, candidate, crashed, moved,
                 violations, completedSource>>

RetireSourceIntent ==
  /\ phase = "retire" /\ source.intent = "owned" /\ source.ready /\ source.cursor = 2
  /\ source' = [source EXCEPT !.intent = "none"]
  /\ phase' = "project" /\ completedSource' = TRUE
  /\ UNCHANGED <<projection, upstream, candidate, crashed, moved, violations>>

ProjectCurrent ==
  /\ phase = "project"
  /\ \E observed \in BOOLEAN:
       LET success == observed /\ projection.intent = "none"
       IN /\ phase' = IF success THEN "complete" ELSE "partial"
          /\ source' = IF ~success /\ Fault = "projection-readiness"
                       THEN [source EXCEPT !.ready = FALSE] ELSE source
          /\ projection' = IF ~success /\ projection.intent = "none"
                           THEN [projection EXCEPT !.intent = "owned"] ELSE projection
  /\ UNCHANGED <<upstream, candidate, crashed, moved, violations, completedSource>>

\* One process loss preserves the original finite intent and child prefix.
\* If no intent exists yet, the next invocation may choose a new candidate.
CrashAndReinvoke ==
  /\ ~crashed /\ phase \in {"prepared", "applying", "verify", "retire"}
  /\ phase' = "inspect" /\ crashed' = TRUE
  /\ UNCHANGED <<source, projection, upstream, candidate, moved,
                 violations, completedSource>>

MoveBranch ==
  /\ ~moved /\ phase \in {"prepared", "applying", "verify", "retire"}
  /\ upstream' = [upstream EXCEPT !.commit = 1 - @] /\ moved' = TRUE
  /\ UNCHANGED <<phase, source, projection, candidate, crashed,
                 violations, completedSource>>

Done == Terminal /\ UNCHANGED vars
Next == InspectIntent \/ InspectAffectedOwners \/ SettleOldProjection
        \/ ObserveRef \/ ProviderUnavailable \/ BeginSource \/ ApplyChild
        \/ UnresolvedChild \/ PublishSource \/ RetireSourceIntent \/ ProjectCurrent
        \/ CrashAndReinvoke \/ MoveBranch \/ Done
Spec == Init /\ [][Next]_vars
        /\ WF_vars(InspectIntent) /\ WF_vars(InspectAffectedOwners)
        /\ WF_vars(SettleOldProjection) /\ WF_vars(ObserveRef \/ ProviderUnavailable)
        /\ WF_vars(BeginSource) /\ WF_vars(ApplyChild \/ UnresolvedChild)
        /\ WF_vars(PublishSource) /\ WF_vars(RetireSourceIntent) /\ WF_vars(ProjectCurrent)

TypeOK ==
  /\ phase \in {"inspect", "preflight", "old_projection", "observe", "prepared",
                 "applying", "verify", "retire", "project", "complete",
                 "unchanged", "partial", "blocked"}
  /\ source \in [intent : {"none", "owned", "foreign"}, commit : 0..1,
                  frozen : 0..1, cursor : 0..2, ready : BOOLEAN, config : 0..1]
  /\ projection \in [intent : {"none", "owned", "foreign"}, owner : AffectedOwners]
  /\ upstream \in [commit : 0..1, config : 0..1]
  /\ candidate \in 0..1 /\ crashed \in BOOLEAN /\ moved \in BOOLEAN
  /\ completedSource \in BOOLEAN /\ violations \subseteq ViolationNames

PendingResolvedBeforeDecision == "pending" \notin violations
AllAffectedProjectionsSettledBeforeSourceWrite == "projection" \notin violations
FrozenCommitPreserved == "frozen" \notin violations
ConfigurationBoundToNoop == "configuration" \notin violations
OnlyAuthorizedIntentResumed == "ownership" \notin violations
ProjectionFailurePreservesSourceReady == completedSource => source.ready
NoFalseSyncCompletion == phase = "complete" =>
  source.intent = "none" /\ source.cursor = 2 /\ source.ready /\ projection.intent = "none"
SyncEventuallyExplained == <>Terminal
=============================================================================
