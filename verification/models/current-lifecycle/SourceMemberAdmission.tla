------------------------- MODULE SourceMemberAdmission -------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS Initial, Fault
ASSUME Initial \in {"legacy", "current"}
ASSUME Fault \in {"none", "member", "legacy", "address", "manager", "ready", "dispatch"}

Members == {"plain", "patched", "ready"}
Phases == {"new", "lookup", "fresh", "candidate", "manager", "done"}
Readiness == {"unknown", "materializable", "blocked", "ready"}
Classify(m) == IF m = "ready" THEN "ready"
               ELSE IF m = "patched" THEN "blocked" ELSE "materializable"

VARIABLES phase, oldSlot, currentSlot, cached, exposed, observedVersion,
          requested, writes, forgedDone
vars == <<phase, oldSlot, currentSlot, cached, exposed, observedVersion,
          requested, writes, forgedDone>>
Terminal == (\A m \in Members: phase[m] = "done") /\ forgedDone

Init ==
  /\ phase = [m \in Members |-> "new"]
  /\ oldSlot = [m \in Members |-> 1]
  /\ currentSlot = [m \in Members |-> IF Initial = "current" THEN 2 ELSE 0]
  /\ cached = [m \in Members |-> IF Initial = "current" THEN Classify(m) ELSE "unknown"]
  /\ exposed = [m \in Members |-> "unknown"]
  /\ observedVersion = [m \in Members |-> 0]
  /\ requested = {}
  /\ writes = {}
  /\ forgedDone = FALSE

\* Physical ready content is readable without a new acquisition requirement.
\* The old slot contains materializable candidates whose capability was never
\* checked. It is retained for the old reader, never imported into the new slot.
ReadCandidate(m) ==
  /\ phase[m] = "new"
  /\ LET ready == IF Fault = "ready" THEN "blocked" ELSE "ready"
         value == IF m = "ready" THEN ready
                  ELSE IF currentSlot[m] = 2 THEN cached[m]
                  ELSE IF Fault = "legacy" THEN "materializable" ELSE "unknown"
         version == IF m = "ready" THEN 0
                    ELSE IF currentSlot[m] = 2 THEN 2
                    ELSE IF Fault = "legacy" THEN 1 ELSE 0
     IN /\ exposed' = [exposed EXCEPT ![m] = value]
        /\ observedVersion' = [observedVersion EXCEPT ![m] = version]
        /\ phase' = [phase EXCEPT ![m] = IF value = "unknown" THEN "lookup" ELSE "candidate"]
  /\ UNCHANGED <<oldSlot, currentSlot, cached, requested, writes, forgedDone>>

\* A complete, returning metadata observation has identified this exact member.
\* Its known transformation blocks a new fixed-file write; it is not a content
\* manifest and does not replace the manager's independent full-byte checks.
Discover(m) ==
  /\ phase[m] = "lookup"
  /\ cached' = [cached EXCEPT ![m] =
       IF Fault = "member" /\ m = "patched" THEN "materializable" ELSE Classify(m)]
  /\ currentSlot' = [currentSlot EXCEPT ![m] = 2]
  /\ oldSlot' = IF Fault = "address" THEN [oldSlot EXCEPT ![m] = 2] ELSE oldSlot
  /\ phase' = [phase EXCEPT ![m] = "fresh"]
  /\ UNCHANGED <<exposed, observedVersion, requested, writes, forgedDone>>

ReadFresh(m) ==
  /\ phase[m] = "fresh"
  /\ exposed' = [exposed EXCEPT ![m] = cached[m]]
  /\ observedVersion' = [observedVersion EXCEPT ![m] = 2]
  /\ phase' = [phase EXCEPT ![m] = "candidate"]
  /\ UNCHANGED <<oldSlot, currentSlot, cached, requested, writes, forgedDone>>

Choose(m) ==
  /\ phase[m] = "candidate"
  /\ LET dispatch == exposed[m] = "materializable"
                      \/ (Fault = "dispatch" /\ exposed[m] = "blocked")
     IN /\ requested' = IF dispatch THEN requested \cup {m} ELSE requested
        /\ phase' = [phase EXCEPT ![m] = IF dispatch THEN "manager" ELSE "done"]
  /\ UNCHANGED <<oldSlot, currentSlot, cached, exposed, observedVersion, writes, forgedDone>>

Manager(m) ==
  /\ phase[m] = "manager"
  /\ writes' = IF m = "plain" \/ Fault = "manager" THEN writes \cup {m} ELSE writes
  /\ phase' = [phase EXCEPT ![m] = "done"]
  /\ UNCHANGED <<oldSlot, currentSlot, cached, exposed, observedVersion, requested, forgedDone>>

\* A caller can bypass discovery. The manager still refuses transformed bytes.
ForgedManagerRequest ==
  /\ ~forgedDone
  /\ forgedDone' = TRUE
  /\ writes' = IF Fault = "manager" THEN writes \cup {"patched"} ELSE writes
  /\ UNCHANGED <<phase, oldSlot, currentSlot, cached, exposed, observedVersion, requested>>

Done == /\ Terminal /\ UNCHANGED vars
Next == (\E m \in Members: ReadCandidate(m))
     \/ (\E m \in Members: Discover(m))
     \/ (\E m \in Members: ReadFresh(m))
     \/ (\E m \in Members: Choose(m))
     \/ (\E m \in Members: Manager(m))
     \/ ForgedManagerRequest \/ Done
Spec == Init /\ [][Next]_vars /\ WF_vars(Next)

TypeOK ==
  /\ phase \in [Members -> Phases]
  /\ oldSlot \in [Members -> {1, 2}]
  /\ currentSlot \in [Members -> {0, 2}]
  /\ cached \in [Members -> Readiness]
  /\ exposed \in [Members -> Readiness]
  /\ observedVersion \in [Members -> {0, 1, 2}]
  /\ requested \subseteq Members /\ writes \subseteq Members
  /\ forgedDone \in BOOLEAN
CurrentCandidatesRequireV2 ==
  \A m \in Members: exposed[m] = "materializable" => observedVersion[m] = 2
UnsupportedIsBlocked ==
  phase["patched"] \in {"candidate", "manager", "done"} => exposed["patched"] = "blocked"
ReadyRemainsReadable == phase["ready"] # "new" => exposed["ready"] = "ready"
OldCacheSlotPreserved == \A m \in Members: oldSlot[m] = 1
BlockedCandidateDoesNotDispatch ==
  \A m \in Members: exposed[m] = "blocked" => m \notin requested
WriterRechecksTransformation == writes \subseteq {"plain"}
AdmissionEventuallyExplained == <>Terminal
=============================================================================
