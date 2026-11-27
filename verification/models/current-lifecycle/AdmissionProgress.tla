------------------------- MODULE AdmissionProgress -------------------------
EXTENDS Naturals, TLC
CONSTANTS Mode, MaxAttempts
VARIABLES phase, attempts
vars == <<phase, attempts>>
Init == /\ phase = "requested" /\ attempts = 0
Start == /\ phase = "requested" /\ phase' = "checking" /\ UNCHANGED attempts
Verified == /\ phase = "checking" /\ phase' = "ready" /\ UNCHANGED attempts
FailedOrInvalidated ==
  /\ phase = "checking"
  /\ attempts' = attempts + 1
  /\ phase' = IF attempts' >= MaxAttempts THEN "unavailable" ELSE "requested"
AnotherHint ==
  /\ phase = "checking"
  /\ attempts' = IF Mode = "reset_budget_on_hint" THEN 0 ELSE attempts + 1
  /\ phase' = IF attempts' >= MaxAttempts THEN "unavailable" ELSE "requested"
FinishAttempt == Verified \/ FailedOrInvalidated \/ AnotherHint
Terminal == /\ phase \in {"ready", "unavailable"} /\ UNCHANGED vars
Next == Start \/ Verified \/ FailedOrInvalidated \/ AnotherHint \/ Terminal
Spec == Init /\ [][Next]_vars /\ WF_vars(Start) /\ WF_vars(FinishAttempt)
TypeOK == phase \in {"requested", "checking", "ready", "unavailable"}
          /\ attempts \in 0..MaxAttempts
EveryRequestSettles == <>(phase \in {"ready", "unavailable"})
=============================================================================

