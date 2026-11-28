--------------------------- MODULE SelectionPins ---------------------------
EXTENDS Naturals, Integers, TLC
CONSTANT Mode
VARIABLES upstream, selected, authorizedSelection, pin, originalPin, readVersion
vars == <<upstream, selected, authorizedSelection, pin, originalPin, readVersion>>
Init == /\ upstream = 0 /\ selected = 0 /\ authorizedSelection = 0
        /\ pin = -1 /\ originalPin = -1 /\ readVersion = -1
UpstreamAdvances == /\ upstream = 0 /\ upstream' = 1
                    /\ UNCHANGED <<selected, authorizedSelection, pin, originalPin, readVersion>>
AdoptUpstream == /\ upstream = 1 /\ selected = 0
                /\ selected' = 1 /\ authorizedSelection' = 1
                /\ UNCHANGED <<upstream, pin, originalPin, readVersion>>
OpenSession ==
  /\ pin = -1
  /\ LET picked == IF Mode = "follow_head_on_read" THEN upstream ELSE selected
     IN /\ pin' = picked /\ originalPin' = picked
        /\ selected' = IF Mode = "follow_head_on_read" THEN picked ELSE selected
  /\ UNCHANGED <<upstream, authorizedSelection, readVersion>>
ReadPinned ==
  /\ pin # -1
  /\ pin' = IF Mode = "rewrite_pin" THEN selected ELSE pin
  /\ readVersion' = IF Mode = "rewrite_pin" THEN selected ELSE pin
  /\ UNCHANGED <<upstream, selected, authorizedSelection, originalPin>>
Idle == UNCHANGED vars
Next == UpstreamAdvances \/ AdoptUpstream \/ OpenSession \/ ReadPinned \/ Idle
TypeOK == /\ upstream \in {0,1} /\ selected \in {0,1} /\ authorizedSelection \in {0,1}
          /\ pin \in {-1,0,1} /\ originalPin \in {-1,0,1}
          /\ readVersion \in {-1,0,1}
ReadsDoNotAdoptUpstream == selected = authorizedSelection
SessionPinNeverChanges == pin = originalPin
PinnedReadUsesOriginalBytes == readVersion = -1 \/ readVersion = originalPin
=============================================================================

