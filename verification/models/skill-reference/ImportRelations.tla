-------------------------- MODULE ImportRelations --------------------------
EXTENDS Naturals, FiniteSets, TLC

\* Only frozen identity/relationship planning and finite recovery are modeled.
\* Exact bytes, HTTP acceptance, full trees and relation pagination remain
\* concrete obligations. The optional-member meaning is a product convention,
\* not a proof of the natural-language author's intent.
CONSTANT Defect
ASSUME Defect \in {"none", "ambient-write", "foreign-relation", "empty-inference",
                  "update-inference", "retry-replan", "requires-inference",
                  "early-relations", "unknown-replay", "repeat-inference",
                  "unverified-completion"}

Skills == {"a", "b"}
Targets == Skills \cup {"manual", "mandatory"}
Scenarios == {"new-auto", "new-empty", "new-explicit", "update-omitted",
              "manual-edit", "cycle", "foreign-relation", "scope-retry",
              "resume-plan"}
EmptyMembers == [s \in Skills |-> {}]
Candidates == [s \in Skills |-> IF s = "a" THEN {"b"} ELSE {}]
CyclicCandidates == [s \in Skills |-> IF s = "a" THEN {"b"} ELSE {"a"}]

VARIABLES scenario, phase, ambientLibrary, plannedLibrary, writeLibrary,
          changedDefault, changedCandidates, created, calls, unknownTarget,
          frozenMembers, members, requires, relationWrites, earlyWrite,
          verified, completionSafe, manualEdited, repeated,
          writesBeforeRepeat, writes
vars == <<scenario, phase, ambientLibrary, plannedLibrary, writeLibrary,
          changedDefault, changedCandidates, created, calls, unknownTarget,
          frozenMembers, members, requires, relationWrites, earlyWrite,
          verified, completionSafe, manualEdited, repeated,
          writesBeforeRepeat, writes>>

Existing == scenario = "update-omitted"
ExplicitEmpty == scenario = "new-empty"
ForeignRelation == scenario = "foreign-relation"
InitialMembers == IF Existing THEN [s \in Skills |-> IF s = "a" THEN {"manual"} ELSE {}]
                  ELSE EmptyMembers
DeclaredRequires == IF scenario = "new-explicit" THEN {"mandatory"} ELSE {}
ExpectedMembers == IF Existing THEN InitialMembers
                   ELSE IF ExplicitEmpty THEN EmptyMembers
                   ELSE IF scenario = "cycle" THEN CyclicCandidates ELSE Candidates
Planned == phase # "input" /\ phase # "rejected"
Terminal == phase \in {"complete", "blocked", "rejected"}

Init ==
  /\ scenario \in Scenarios
  /\ phase = "input"
  /\ ambientLibrary = "test" /\ plannedLibrary = "none" /\ writeLibrary = "none"
  /\ changedDefault = FALSE /\ changedCandidates = FALSE
  /\ created = IF Existing THEN Skills ELSE {}
  /\ calls = [s \in Skills |-> 0] /\ unknownTarget = "none"
  /\ frozenMembers = EmptyMembers /\ members = InitialMembers
  /\ requires = DeclaredRequires
  /\ relationWrites = 0 /\ earlyWrite = FALSE
  /\ verified = FALSE /\ completionSafe = TRUE
  /\ manualEdited = FALSE /\ repeated = FALSE
  /\ writesBeforeRepeat = 0 /\ writes = 0

FreezePlan ==
  /\ phase = "input"
  /\ phase' = IF ForeignRelation /\ Defect # "foreign-relation" THEN "rejected" ELSE "creating"
  /\ plannedLibrary' = "test"
  /\ frozenMembers' = IF (ExplicitEmpty /\ Defect = "empty-inference") \/
                         (Existing /\ Defect = "update-inference")
                        THEN Candidates ELSE ExpectedMembers
  /\ UNCHANGED <<scenario, ambientLibrary, writeLibrary, changedDefault,
                 changedCandidates, created, calls, unknownTarget, members,
                 requires, relationWrites, earlyWrite, verified, completionSafe,
                 manualEdited, repeated, writesBeforeRepeat, writes>>

ChangeDefault ==
  /\ scenario = "scope-retry" /\ ~changedDefault
  /\ phase \in {"creating", "unknown", "relating"}
  /\ ambientLibrary' = "production" /\ changedDefault' = TRUE
  /\ UNCHANGED <<scenario, phase, plannedLibrary, writeLibrary, changedCandidates,
                 created, calls, unknownTarget, frozenMembers, members, requires,
                 relationWrites, earlyWrite, verified, completionSafe,
                 manualEdited, repeated, writesBeforeRepeat, writes>>

ChangeCandidates ==
  /\ scenario = "resume-plan" /\ phase = "unknown" /\ ~changedCandidates
  /\ changedCandidates' = TRUE
  /\ UNCHANGED <<scenario, phase, ambientLibrary, plannedLibrary, writeLibrary,
                 changedDefault, created, calls, unknownTarget, frozenMembers,
                 members, requires, relationWrites, earlyWrite, verified,
                 completionSafe, manualEdited, repeated, writesBeforeRepeat, writes>>

CreateKnown(s) ==
  /\ phase = "creating" /\ s \in Skills \ created
  /\ created' = created \cup {s} /\ calls' = [calls EXCEPT ![s] = @ + 1]
  /\ writeLibrary' = IF Defect = "ambient-write" THEN ambientLibrary ELSE plannedLibrary
  /\ writes' = writes + 1
  /\ UNCHANGED <<scenario, phase, ambientLibrary, plannedLibrary, changedDefault,
                 changedCandidates, unknownTarget, frozenMembers, members, requires,
                 relationWrites, earlyWrite, verified, completionSafe,
                 manualEdited, repeated, writesBeforeRepeat>>

CreateUnknown(s, accepted) ==
  /\ phase = "creating" /\ s \in Skills \ created
  /\ phase' = "unknown" /\ unknownTarget' = s
  /\ created' = IF accepted THEN created \cup {s} ELSE created
  /\ calls' = [calls EXCEPT ![s] = @ + 1]
  /\ writeLibrary' = IF Defect = "ambient-write" THEN ambientLibrary ELSE plannedLibrary
  /\ writes' = writes + 1
  /\ UNCHANGED <<scenario, ambientLibrary, plannedLibrary, changedDefault,
                 changedCandidates, frozenMembers, members, requires, relationWrites,
                 earlyWrite, verified, completionSafe, manualEdited, repeated, writesBeforeRepeat>>

ResumeUnknown ==
  /\ phase = "unknown"
  /\ LET observed == unknownTarget \in created
         replay == ~observed /\ Defect = "unknown-replay"
     IN
       /\ phase' = IF observed \/ replay THEN "creating" ELSE "blocked"
       /\ created' = IF replay THEN created \cup {unknownTarget} ELSE created
       /\ calls' = IF replay THEN [calls EXCEPT ![unknownTarget] = @ + 1] ELSE calls
       /\ writes' = IF replay THEN writes + 1 ELSE writes
       /\ unknownTarget' = IF observed \/ replay THEN "none" ELSE unknownTarget
       /\ frozenMembers' = IF changedCandidates /\ Defect = "retry-replan"
                             THEN EmptyMembers ELSE frozenMembers
  /\ UNCHANGED <<scenario, ambientLibrary, plannedLibrary, writeLibrary,
                 changedDefault, changedCandidates, members, requires,
                 relationWrites, earlyWrite, verified, completionSafe,
                 manualEdited, repeated, writesBeforeRepeat>>

ObjectsReady ==
  /\ phase = "creating" /\ created = Skills
  /\ phase' = "relating"
  /\ UNCHANGED <<scenario, ambientLibrary, plannedLibrary, writeLibrary,
                 changedDefault, changedCandidates, created, calls, unknownTarget,
                 frozenMembers, members, requires, relationWrites, earlyWrite,
                 verified, completionSafe, manualEdited, repeated, writesBeforeRepeat, writes>>

ApplyRelations ==
  /\ ((phase = "relating") \/
      (Defect = "early-relations" /\ phase = "creating" /\ created # {} /\ created # Skills))
  /\ phase' = "verifying"
  /\ members' = frozenMembers
  /\ requires' = IF Defect = "requires-inference" THEN DeclaredRequires \cup {"b"}
                   ELSE DeclaredRequires
  /\ writeLibrary' = IF Defect = "ambient-write" THEN ambientLibrary ELSE plannedLibrary
  /\ relationWrites' = 1 /\ writes' = writes + 1
  /\ earlyWrite' = (created # Skills)
  /\ UNCHANGED <<scenario, ambientLibrary, plannedLibrary, changedDefault,
                 changedCandidates, created, calls, unknownTarget, frozenMembers,
                 verified, completionSafe, manualEdited, repeated, writesBeforeRepeat>>

Verify ==
  /\ phase = "verifying"
  /\ LET matches == created = Skills /\ members = frozenMembers /\ requires = DeclaredRequires
     IN
       /\ phase' = IF matches \/ Defect = "unverified-completion" THEN "complete" ELSE "blocked"
       /\ verified' = matches
       /\ completionSafe' = matches
  /\ UNCHANGED <<scenario, ambientLibrary, plannedLibrary, writeLibrary,
                 changedDefault, changedCandidates, created, calls, unknownTarget,
                 frozenMembers, members, requires, relationWrites, earlyWrite,
                 manualEdited, repeated, writesBeforeRepeat, writes>>

PrematureComplete ==
  /\ Defect = "unverified-completion" /\ phase = "creating" /\ created # Skills
  /\ phase' = "complete" /\ completionSafe' = FALSE
  /\ UNCHANGED <<scenario, ambientLibrary, plannedLibrary, writeLibrary,
                 changedDefault, changedCandidates, created, calls, unknownTarget,
                 frozenMembers, members, requires, relationWrites, earlyWrite,
                 verified, manualEdited, repeated, writesBeforeRepeat, writes>>

ManualEdit ==
  /\ scenario = "manual-edit" /\ phase = "complete" /\ ~manualEdited
  /\ phase' = "repeat" /\ manualEdited' = TRUE
  /\ members' = [members EXCEPT !["a"] = {}]
  /\ writesBeforeRepeat' = writes
  /\ UNCHANGED <<scenario, ambientLibrary, plannedLibrary, writeLibrary,
                 changedDefault, changedCandidates, created, calls, unknownTarget,
                 frozenMembers, requires, relationWrites, earlyWrite,
                 verified, completionSafe, repeated, writes>>

RepeatOmitted ==
  /\ phase = "repeat" /\ phase' = "complete" /\ repeated' = TRUE
  /\ members' = IF Defect = "repeat-inference" THEN Candidates ELSE members
  /\ writes' = IF Defect = "repeat-inference" THEN writes + 1 ELSE writes
  /\ UNCHANGED <<scenario, ambientLibrary, plannedLibrary, writeLibrary,
                 changedDefault, changedCandidates, created, calls, unknownTarget,
                 frozenMembers, requires, relationWrites, earlyWrite,
                 verified, completionSafe, manualEdited, writesBeforeRepeat>>

Done == Terminal /\ UNCHANGED vars
Create == (\E s \in Skills: CreateKnown(s)) \/
          (\E s \in Skills, accepted \in BOOLEAN: CreateUnknown(s, accepted))
Next == FreezePlan \/ ChangeDefault \/ ChangeCandidates \/ Create \/ ResumeUnknown
        \/ ObjectsReady \/ ApplyRelations \/ Verify \/ PrematureComplete
        \/ ManualEdit \/ RepeatOmitted \/ Done
Spec == Init /\ [][Next]_vars
        /\ WF_vars(FreezePlan) /\ WF_vars(Create) /\ WF_vars(ResumeUnknown)
        /\ WF_vars(ObjectsReady) /\ WF_vars(ApplyRelations) /\ WF_vars(Verify)
        /\ WF_vars(RepeatOmitted)

TypeOK ==
  /\ scenario \in Scenarios
  /\ phase \in {"input", "creating", "unknown", "relating", "verifying",
                "complete", "blocked", "rejected", "repeat"}
  /\ ambientLibrary \in {"test", "production"}
  /\ plannedLibrary \in {"none", "test"}
  /\ writeLibrary \in {"none", "test", "production"}
  /\ changedDefault \in BOOLEAN /\ changedCandidates \in BOOLEAN
  /\ created \subseteq Skills /\ calls \in [Skills -> 0..2]
  /\ unknownTarget \in Skills \cup {"none"}
  /\ frozenMembers \in [Skills -> SUBSET Targets]
  /\ members \in [Skills -> SUBSET Targets] /\ requires \subseteq Targets
  /\ relationWrites \in 0..1 /\ earlyWrite \in BOOLEAN
  /\ verified \in BOOLEAN /\ completionSafe \in BOOLEAN
  /\ manualEdited \in BOOLEAN /\ repeated \in BOOLEAN
  /\ writesBeforeRepeat \in 0..5 /\ writes \in 0..6
ImportScopeRemainsBound == writes > 0 => writeLibrary = plannedLibrary /\ plannedLibrary = "test"
ForeignRelationsBeforeWrites == ForeignRelation => writes = 0
FrozenMembersIntent == Planned => frozenMembers = ExpectedMembers
ExplicitEmptyMembers == ExplicitEmpty => members = EmptyMembers
ExistingMembersOnOmission == Existing => members = InitialMembers
RequiresOnlyExplicit == requires = DeclaredRequires
RelationsAfterObjectCreation == ~earlyWrite
UnknownCreateNotReplayed == \A s \in Skills: calls[s] <= 1
ManualMembersPreserved == repeated => members["a"] = {}
RepeatHasNoWrites == repeated => writes = writesBeforeRepeat
CompleteWasVerified == phase = "complete" => verified /\ completionSafe
ImportEventuallyExplained == <>Terminal
RepeatEventuallyExplained == phase = "repeat" ~> phase = "complete"
=============================================================================
