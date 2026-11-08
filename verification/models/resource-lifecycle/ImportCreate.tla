---------------------------- MODULE ImportCreate ----------------------------
EXTENDS Naturals, FiniteSets
CONSTANT UnsafeReplay, EarlyEnable, InferReceipt, IgnoreChangedInput
Files == {"main", "raw"}
Steps == 1..4
VARIABLES phase, objects, original, step, attempts, applied, acked, verified,
          inputMatches, allDispatchesReviewed, enabled
vars == <<phase, objects, original, step, attempts, applied, acked, verified,
          inputMatches, allDispatchesReviewed, enabled>>
Init == /\ phase = "preparing" /\ objects = {} /\ original = FALSE /\ step = 1
        /\ attempts = [s \in Steps |-> 0] /\ applied = {} /\ acked = {} /\ verified = {}
        /\ inputMatches = TRUE /\ allDispatchesReviewed = TRUE /\ enabled = FALSE

RetainOne == /\ phase = "preparing" /\ objects # Files
             /\ objects' = objects \cup {IF "main" \in objects THEN "raw" ELSE "main"}
             /\ UNCHANGED <<phase, original, step, attempts, applied, acked, verified,
                              inputMatches, allDispatchesReviewed, enabled>>
FreezeOriginal == /\ phase = "preparing" /\ objects = Files
                  /\ original' = TRUE /\ phase' = "ready"
                  /\ UNCHANGED <<objects, step, attempts, applied, acked, verified,
                                   inputMatches, allDispatchesReviewed, enabled>>
InputChanges == /\ phase = "ready" /\ step = 1 /\ inputMatches
                /\ inputMatches' = FALSE
                /\ UNCHANGED <<phase, objects, original, step, attempts, applied, acked,
                                 verified, allDispatchesReviewed, enabled>>
Dispatch == /\ phase = "ready" /\ step \in Steps /\ original /\ attempts[step] = 0
            /\ (inputMatches \/ IgnoreChangedInput)
            /\ (step # 4 \/ {1, 2, 3} \subseteq verified)
            /\ attempts' = [attempts EXCEPT ![step] = 1] /\ phase' = "inflight"
            /\ allDispatchesReviewed' = (allDispatchesReviewed /\ inputMatches)
            /\ UNCHANGED <<objects, original, step, applied, acked, verified, inputMatches, enabled>>
RejectChangedInput == /\ phase = "ready" /\ step \in Steps /\ ~inputMatches
                      /\ phase' = "blocked"
                      /\ UNCHANGED <<objects, original, step, attempts, applied, acked,
                                       verified, inputMatches, allDispatchesReviewed, enabled>>
ProviderApplies == /\ phase = "inflight" /\ applied' = applied \cup {step}
                   /\ enabled' = (enabled \/ step = 4) /\ phase' = "response"
                   /\ UNCHANGED <<objects, original, step, attempts, acked, verified,
                                    inputMatches, allDispatchesReviewed>>
DispatchInterrupted == /\ phase = "inflight" /\ phase' = "unknown"
                       /\ UNCHANGED <<objects, original, step, attempts, applied, acked,
                                        verified, inputMatches, allDispatchesReviewed, enabled>>
ResponseLost == /\ phase = "response" /\ phase' = "unknown"
                /\ UNCHANGED <<objects, original, step, attempts, applied, acked,
                                 verified, inputMatches, allDispatchesReviewed, enabled>>
PersistOriginalAck == /\ phase = "response" /\ acked' = acked \cup {step}
                      /\ phase' = "readback"
                      /\ UNCHANGED <<objects, original, step, attempts, applied, verified,
                                       inputMatches, allDispatchesReviewed, enabled>>
ReadbackInterrupted == /\ phase = "readback" /\ phase' = "unknown"
                       /\ UNCHANGED <<objects, original, step, attempts, applied, acked,
                                        verified, inputMatches, allDispatchesReviewed, enabled>>
VerifyStage == /\ phase = "readback" /\ step \in acked /\ step \in applied
               /\ verified' = verified \cup {step} /\ step' = step + 1 /\ phase' = "ready"
               /\ UNCHANGED <<objects, original, attempts, applied, acked,
                                inputMatches, allDispatchesReviewed, enabled>>
ReconcileOriginal == /\ phase = "unknown" /\ step \in acked /\ step \in applied
                     /\ phase' = "readback"
                     /\ UNCHANGED <<objects, original, step, attempts, applied, acked,
                                      verified, inputMatches, allDispatchesReviewed, enabled>>
ReplayUnknown == /\ UnsafeReplay /\ phase = "unknown" /\ attempts[step] = 1
                 /\ attempts' = [attempts EXCEPT ![step] = 2] /\ phase' = "inflight"
                 /\ UNCHANGED <<objects, original, step, applied, acked, verified,
                                  inputMatches, allDispatchesReviewed, enabled>>
InferFromVisible == /\ InferReceipt /\ phase = "unknown" /\ step \in applied /\ step \notin acked
                    /\ verified' = verified \cup {step} /\ step' = step + 1 /\ phase' = "ready"
                    /\ UNCHANGED <<objects, original, attempts, applied, acked,
                                     inputMatches, allDispatchesReviewed, enabled>>
PublishEarly == /\ EarlyEnable /\ phase = "ready" /\ ~enabled /\ ~({1, 2, 3} \subseteq verified)
                /\ enabled' = TRUE
                /\ UNCHANGED <<phase, objects, original, step, attempts, applied, acked,
                                 verified, inputMatches, allDispatchesReviewed>>
Finish == /\ phase = "ready" /\ step = 5 /\ phase' = "completed"
          /\ UNCHANGED <<objects, original, step, attempts, applied, acked,
                           verified, inputMatches, allDispatchesReviewed, enabled>>
HoldUnknown == /\ phase = "unknown" /\ step \notin acked /\ UNCHANGED vars
Terminal == /\ phase \in {"blocked", "completed"} /\ UNCHANGED vars
Next == RetainOne \/ FreezeOriginal \/ InputChanges \/ Dispatch \/ RejectChangedInput
        \/ ProviderApplies \/ DispatchInterrupted \/ ResponseLost \/ PersistOriginalAck
        \/ ReadbackInterrupted \/ VerifyStage \/ ReconcileOriginal \/ ReplayUnknown
        \/ InferFromVisible \/ PublishEarly \/ Finish \/ HoldUnknown \/ Terminal
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"preparing", "ready", "inflight", "response", "readback", "unknown", "blocked", "completed"}
          /\ objects \subseteq Files /\ original \in BOOLEAN /\ step \in 1..5
          /\ attempts \in [Steps -> 0..2] /\ applied \subseteq Steps /\ acked \subseteq Steps
          /\ verified \subseteq Steps /\ inputMatches \in BOOLEAN
          /\ allDispatchesReviewed \in BOOLEAN /\ enabled \in BOOLEAN
AtMostOneDispatch == \A s \in Steps : attempts[s] <= 1
EnableRequiresComplete == enabled => (original /\ objects = Files /\ {1, 2, 3} \subseteq verified)
ConfirmationNeedsOriginalAck == verified \subseteq acked
FrozenInputRequired == allDispatchesReviewed
=============================================================================

