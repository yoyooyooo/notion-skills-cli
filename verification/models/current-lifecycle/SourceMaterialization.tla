------------------------- MODULE SourceMaterialization -------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS Initial, Fault
ASSUME Initial \in {"covered", "growth", "empty"}
ASSUME Fault \in {"none", "gate", "replace", "revision", "eager"}

Writers == {"A", "B"}
Members == Writers \cup {"old", "legacy"}
Phases == {"new", "frozen", "written", "bound", "complete", "blocked"}

VARIABLES phase, gate, contributions, manifest, ready, descriptors, sourceReady,
          frozenContributions, frozenManifest, frozenReady, published
vars == <<phase, gate, contributions, manifest, ready, descriptors, sourceReady,
          frozenContributions, frozenManifest, frozenReady, published>>

Active == {w \in Writers: phase[w] \in {"frozen", "written", "bound"}}
Terminal == \A w \in Writers: phase[w] \in {"complete", "blocked"}
InitialContributions == IF Initial = "empty" THEN {} ELSE {"old", "legacy"}
InitialReady == IF Initial = "empty" THEN {} ELSE {"old"}
InitialManifest == IF Initial = "covered" THEN Members ELSE InitialContributions

Init ==
  /\ phase = [w \in Writers |-> "new"]
  /\ gate = "none"
  /\ contributions = InitialContributions
  /\ manifest = InitialManifest
  /\ ready = InitialReady
  /\ descriptors = [m \in Members |-> IF m \in InitialReady THEN InitialManifest ELSE {}]
  /\ sourceReady = TRUE
  /\ frozenContributions = [w \in Writers |-> {}]
  /\ frozenManifest = [w \in Writers |-> {}]
  /\ frozenReady = [w \in Writers |-> {}]
  /\ published = InitialContributions

\* Admission occurs at the one designated manager before reading the current
\* Source. The separate SourceWriterSettlement model checks its unknown-write
\* premise; this action is not a Notion compare-and-swap.
ReadAndFreeze(w) ==
  /\ phase[w] = "new"
  /\ gate = "none" \/ Fault = "gate"
  /\ LET kept == IF Fault = "replace" THEN {} ELSE contributions
         desired == kept \cup {w}
     IN /\ frozenContributions' = [frozenContributions EXCEPT ![w] = desired]
        /\ frozenManifest' = [frozenManifest EXCEPT ![w] =
             IF Fault = "replace" THEN desired ELSE manifest \cup desired]
  /\ frozenReady' = [frozenReady EXCEPT ![w] = ready \cup {w}]
  /\ gate' = w
  /\ phase' = [phase EXCEPT ![w] = "frozen"]
  /\ UNCHANGED <<contributions, manifest, ready, descriptors, sourceReady, published>>

\* This step abstracts a successfully settled exact Source property update.
\* The immutable file bytes and full normalized-plan digest are represented by
\* manifest identity; adding a member changes that identity only if needed.
PublishPlan(w) ==
  /\ phase[w] = "frozen"
  /\ contributions' = frozenContributions[w]
  /\ manifest' = frozenManifest[w]
  /\ sourceReady' = FALSE
  /\ phase' = [phase EXCEPT ![w] = "written"]
  /\ UNCHANGED <<gate, ready, descriptors, frozenContributions, frozenManifest,
                 frozenReady, published>>

\* A lower finite writer verifies each selected current owner. This bounded
\* aggregate does not claim that those owner writes are one remote transaction.
\* A declared legacy sibling is retained, but is not selected merely because
\* it appears in Contributions or the broader manifest.
BindSelectedOwners(w) ==
  /\ phase[w] = "written"
  /\ LET selected == IF Fault = "eager" THEN frozenContributions[w] ELSE frozenReady[w]
     IN /\ descriptors' = [m \in Members |->
             IF m \in selected /\ ~(Fault = "revision" /\ m = "old")
             THEN frozenManifest[w] ELSE descriptors[m]]
        /\ ready' = ready \cup selected
  /\ phase' = [phase EXCEPT ![w] = "bound"]
  /\ UNCHANGED <<gate, contributions, manifest, sourceReady, frozenContributions,
                 frozenManifest, frozenReady, published>>

Finish(w) ==
  /\ phase[w] = "bound"
  /\ LET same == contributions = frozenContributions[w] /\ manifest = frozenManifest[w]
     IN /\ phase' = [phase EXCEPT ![w] = IF same THEN "complete" ELSE "blocked"]
        /\ sourceReady' = IF same THEN TRUE ELSE sourceReady
        /\ published' = IF same THEN published \cup {w} ELSE published
  /\ gate' = IF gate = w THEN "none" ELSE gate
  /\ UNCHANGED <<contributions, manifest, ready, descriptors, frozenContributions,
                 frozenManifest, frozenReady>>

Done == /\ Terminal /\ UNCHANGED vars
Next == (\E w \in Writers: ReadAndFreeze(w))
     \/ (\E w \in Writers: PublishPlan(w))
     \/ (\E w \in Writers: BindSelectedOwners(w))
     \/ (\E w \in Writers: Finish(w)) \/ Done
Spec == Init /\ [][Next]_vars /\ WF_vars(Next)

TypeOK ==
  /\ phase \in [Writers -> Phases]
  /\ gate \in Writers \cup {"none"}
  /\ contributions \subseteq Members /\ manifest \subseteq Members
  /\ ready \subseteq Members /\ published \subseteq Members
  /\ descriptors \in [Members -> SUBSET Members]
  /\ sourceReady \in BOOLEAN
  /\ frozenContributions \in [Writers -> SUBSET Members]
  /\ frozenManifest \in [Writers -> SUBSET Members]
  /\ frozenReady \in [Writers -> SUBSET Members]
SingleSourceWriter == Cardinality(Active) <= 1
PublishedContributionsRemain == published \subseteq contributions /\ published \subseteq manifest
ReadyRevisionCoherent ==
  sourceReady => \A m \in ready:
    m \in contributions /\ m \in manifest /\ descriptors[m] = manifest
LegacySiblingUntouched == "legacy" \notin ready /\ descriptors["legacy"] = {}
MaterializationEventuallyExplained == <>Terminal
=============================================================================
