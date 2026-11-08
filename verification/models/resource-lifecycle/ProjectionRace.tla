-------------------------- MODULE ProjectionRace --------------------------
EXTENDS Naturals
CONSTANT UnsafeOverwrite
VARIABLES phase, body, humanCreated, retained
vars == <<phase, body, humanCreated, retained>>
Init == /\ phase = "idle" /\ body = "upstream-v1"
        /\ humanCreated = FALSE /\ retained = FALSE
ReadUnchanged == /\ phase = "idle" /\ body = "upstream-v1"
                 /\ phase' = "checked"
                 /\ UNCHANGED <<body, humanCreated, retained>>
ReadCustom == /\ phase = "idle" /\ body = "human"
              /\ phase' = "custom" /\ retained' = TRUE
              /\ UNCHANGED <<body, humanCreated>>
HumanEdit == /\ ~humanCreated /\ phase \in {"idle", "checked", "authorized"}
             /\ body' = "human" /\ humanCreated' = TRUE
             /\ UNCHANGED <<phase, retained>>
Authorize == /\ phase = "checked"
             /\ phase' = IF UnsafeOverwrite THEN "authorized" ELSE "blocked"
             /\ UNCHANGED <<body, humanCreated, retained>>
ProviderReplace == /\ phase = "authorized"
                   /\ body' = "upstream-v2" /\ phase' = "written"
                   /\ UNCHANGED <<humanCreated, retained>>
ReadBack == /\ phase = "written" /\ phase' = "reported"
            /\ UNCHANGED <<body, humanCreated, retained>>
Done == /\ phase \in {"blocked", "custom", "reported"} /\ UNCHANGED vars
Next == ReadUnchanged \/ ReadCustom \/ HumanEdit \/ Authorize \/ ProviderReplace \/ ReadBack \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"idle", "checked", "custom", "authorized", "blocked", "written", "reported"}
          /\ body \in {"upstream-v1", "upstream-v2", "human"}
          /\ humanCreated \in BOOLEAN /\ retained \in BOOLEAN
HumanEditPreserved == humanCreated => (body = "human" \/ retained)
=============================================================================
