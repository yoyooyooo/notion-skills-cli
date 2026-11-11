------------------------------- MODULE AuditRun -----------------------------
EXTENDS Naturals, FiniteSets
CONSTANT RootOnly, MutatingRead, ResetCheckpoint, InventoryVisible
Skills == {1, 2}
VARIABLES phase, checked, checkpoint, budget, resumes, reverseDone, orphanFound, complete, writes, observedChange
vars == <<phase, checked, checkpoint, budget, resumes, reverseDone, orphanFound, complete, writes, observedChange>>
Init == /\ phase = "inventory" /\ checked = {} /\ checkpoint = {} /\ budget = 1 /\ resumes = 0
        /\ reverseDone = FALSE /\ orphanFound = FALSE /\ complete = FALSE /\ writes = 0 /\ observedChange = FALSE
Inventory == /\ phase = "inventory" /\ phase' = IF InventoryVisible THEN "skills" ELSE "limited"
             /\ UNCHANGED <<checked, checkpoint, budget, resumes, reverseDone, orphanFound, complete, writes, observedChange>>
InspectOne == /\ phase = "skills" /\ checked # Skills /\ budget > 0
              /\ checked' = checked \cup {IF 1 \in checked THEN 2 ELSE 1}
              /\ budget' = budget-1
              /\ UNCHANGED <<phase, checkpoint, resumes, reverseDone, orphanFound, complete, writes, observedChange>>
ObserveHumanChange == /\ phase = "skills" /\ ~observedChange
                      /\ observedChange' = TRUE /\ writes' = IF MutatingRead THEN 1 ELSE 0
                      /\ UNCHANGED <<phase, checked, checkpoint, budget, resumes, reverseDone, orphanFound, complete>>
Pause == /\ phase = "skills" /\ budget = 0 /\ checked # Skills
         /\ phase' = "paused" /\ checkpoint' = checked
         /\ UNCHANGED <<checked, budget, resumes, reverseDone, orphanFound, complete, writes, observedChange>>
Resume == /\ phase = "paused" /\ resumes < 2
          /\ phase' = "skills" /\ budget' = 1 /\ resumes' = resumes+1
          /\ checked' = IF ResetCheckpoint THEN {} ELSE checked
          /\ UNCHANGED <<checkpoint, reverseDone, orphanFound, complete, writes, observedChange>>
MoveToReverse == /\ phase = "skills" /\ checked = Skills /\ phase' = "reverse"
                 /\ UNCHANGED <<checked, checkpoint, budget, resumes, reverseDone, orphanFound, complete, writes, observedChange>>
ReverseInventory == /\ phase = "reverse" /\ ~reverseDone
                    /\ reverseDone' = TRUE /\ orphanFound' = TRUE
                    /\ UNCHANGED <<phase, checked, checkpoint, budget, resumes, complete, writes, observedChange>>
Report == /\ phase = "reverse" /\ (reverseDone \/ RootOnly)
          /\ complete' = TRUE /\ phase' = "reported"
          /\ UNCHANGED <<checked, checkpoint, budget, resumes, reverseDone, orphanFound, writes, observedChange>>
ReportLimited == /\ phase = "limited" /\ phase' = "reported"
                 /\ complete' = FALSE
                 /\ UNCHANGED <<checked, checkpoint, budget, resumes, reverseDone, orphanFound, writes, observedChange>>
NeedsResume == /\ phase = "paused" /\ resumes = 2 /\ UNCHANGED vars
Done == /\ phase = "reported" /\ UNCHANGED vars
Next == Inventory \/ InspectOne \/ ObserveHumanChange \/ Pause \/ Resume \/ MoveToReverse
        \/ ReverseInventory \/ Report \/ ReportLimited \/ NeedsResume \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"inventory","skills","paused","reverse","limited","reported"}
          /\ checked \subseteq Skills /\ checkpoint \subseteq Skills /\ budget \in 0..1 /\ resumes \in 0..2
          /\ reverseDone \in BOOLEAN /\ orphanFound \in BOOLEAN /\ complete \in BOOLEAN
          /\ writes \in 0..1 /\ observedChange \in BOOLEAN
AuditReadOnly == writes = 0
CompleteMeansCovered == complete => (InventoryVisible /\ checked = Skills /\ reverseDone /\ orphanFound)
CheckpointMonotone == checkpoint \subseteq checked
Progress == Inventory \/ InspectOne \/ Pause \/ Resume \/ MoveToReverse \/ ReverseInventory \/ Report \/ ReportLimited
FairSpec == Spec /\ WF_vars(Progress)
EventuallyReport == <> (phase = "reported")
=============================================================================
