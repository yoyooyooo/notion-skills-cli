------------------------------ MODULE AuditScope ------------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS PretendGlobal, SkipOwnerRecords, WriteDuringAudit,
          DropCheckpoint, ChangeScopeOnResume, Visible
VARIABLE s
vars == <<s>>
OwnerFacts == {"page", "files", "records", "source"}
Modes == {"target", "library"}

Init == \E mode \in Modes :
  s = [mode |-> mode, originalMode |-> mode, phase |-> "initial owner",
       initial |-> {}, final |-> {}, checkpoint |-> {},
       reverse |-> FALSE, orphan |-> FALSE, writes |-> 0,
       budget |-> 2, resumes |-> 0, targetFull |-> FALSE, globalFull |-> FALSE]

ReadInitial ==
  /\ s.phase = "initial owner" /\ Visible /\ s.budget > 0
  /\ \E fact \in OwnerFacts \ s.initial :
       s' = [s EXCEPT !.initial = @ \cup {fact}, !.budget = @ - 1,
              !.writes = IF WriteDuringAudit THEN 1 ELSE s.writes]
Pause ==
  /\ s.phase = "initial owner" /\ s.budget = 0 /\ s.initial # OwnerFacts
  /\ s' = [s EXCEPT !.phase = "paused", !.checkpoint = s.initial]
Resume ==
  /\ s.phase = "paused" /\ s.resumes = 0
  /\ s' = [s EXCEPT !.phase = "initial owner", !.budget = 2, !.resumes = 1,
       !.initial = IF DropCheckpoint THEN {} ELSE s.initial,
       !.mode = IF ChangeScopeOnResume THEN IF s.mode = "target" THEN "library" ELSE "target" ELSE s.mode]
OwnerDone ==
  /\ s.phase = "initial owner"
  /\ s.initial = OwnerFacts \/ (SkipOwnerRecords /\ s.initial = OwnerFacts \ {"records"})
  /\ s' = [s EXCEPT !.phase = IF s.mode = "library" THEN "reverse census" ELSE "final owner"]
Reverse ==
  /\ s.phase = "reverse census"
  /\ s' = [s EXCEPT !.phase = "final owner", !.reverse = TRUE, !.orphan = TRUE]
ReadFinal ==
  /\ s.phase = "final owner" /\ s.final # OwnerFacts
  /\ \E fact \in OwnerFacts \ s.final : s' = [s EXCEPT !.final = @ \cup {fact}]
Report ==
  /\ s.phase = "final owner" /\ s.final = OwnerFacts
  /\ s' = [s EXCEPT !.phase = "reported", !.targetFull = TRUE,
       !.globalFull = (s.mode = "library" /\ s.reverse /\ s.orphan) \/ PretendGlobal]
PermissionLimited ==
  /\ s.phase = "initial owner" /\ ~Visible
  /\ s' = [s EXCEPT !.phase = "reported"]
Stop ==
  /\ s.phase = "reported" \/ (s.phase = "paused" /\ s.resumes = 1)
  /\ UNCHANGED vars
Next == ReadInitial \/ Pause \/ Resume \/ OwnerDone \/ Reverse \/ ReadFinal
        \/ Report \/ PermissionLimited \/ Stop
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ s.mode \in Modes /\ s.originalMode \in Modes
  /\ s.phase \in {"initial owner", "paused", "reverse census", "final owner", "reported"}
  /\ s.initial \subseteq OwnerFacts /\ s.final \subseteq OwnerFacts /\ s.checkpoint \subseteq OwnerFacts
  /\ s.writes \in 0..1 /\ s.budget \in 0..2 /\ s.resumes \in 0..1
  /\ \A key \in {"reverse", "orphan", "targetFull", "globalFull"} : s[key] \in BOOLEAN
AuditReadOnly == s.writes = 0
TargetCoverageNeedsOwnerFacts == s.targetFull => (Visible /\ s.initial = OwnerFacts /\ s.final = OwnerFacts)
GlobalCoverageNeedsReverse == s.globalFull => (s.mode = "library" /\ s.reverse /\ s.orphan)
ConfirmedEvidenceMonotone == s.checkpoint \subseteq s.initial
OriginalScopePreserved == s.mode = s.originalMode
=============================================================================
