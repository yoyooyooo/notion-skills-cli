---------------------------- MODULE SearchAdmission ----------------------------
EXTENDS Naturals, TLC
CONSTANTS Enabled, SearchMode, RestReady, AuthReady, BindingReady, QueryPresent, Fault
EpochNames == {"source","credential","session","metadata"}
Kinds == {"native","projection","owned_file","foreign_source","disabled_skill","unmapped_file","wrong_workspace","ai_search","empty"}
VARIABLES phase, epochs, changed, kind, selected, disclosed, proof, outcome, tick, called, violations, dispatchConnection
vars == <<phase,epochs,changed,kind,selected,disclosed,proof,outcome,tick,called,violations,dispatchConnection>>
InitialPins == <<1,2>>
EpochCurrent == \A k \in EpochNames : epochs[k] = 0
Current == EpochCurrent /\ tick < 2
PhysicalAdmission == kind \in {"native","projection","owned_file","ai_search"} /\ RestReady /\ epochs["source"] = 0
Init ==
 /\ phase = "new" /\ epochs = [k \in EpochNames |-> 0] /\ changed = FALSE
 /\ kind = "empty" /\ selected = InitialPins /\ disclosed = FALSE /\ proof = "none"
 /\ outcome = "none" /\ tick = 0 /\ called = FALSE /\ violations = {} /\ dispatchConnection = "none"
Preflight ==
 /\ phase = "new"
 /\ LET result == IF ~Enabled /\ Fault # "disabled_dispatch" THEN "disabled"
                  ELSE IF SearchMode # "content" /\ Fault # "metadata_dispatch" THEN "metadata"
                  ELSE IF ~QueryPresent THEN "query_required"
                  ELSE IF ~RestReady /\ Fault # "ignore_rest" THEN "rest_auth_required"
                  ELSE IF ~AuthReady THEN "mcp_auth_required"
                  ELSE IF ~BindingReady /\ Fault \notin {"misroute","ignore_binding"} THEN "binding_required"
                  ELSE "ready"
    IN /\ phase' = IF result = "ready" THEN "prepared" ELSE "done"
       /\ outcome' = result
 /\ UNCHANGED <<epochs,changed,kind,selected,disclosed,proof,tick,called,violations,dispatchConnection>>
Dispatch ==
 /\ phase = "prepared"
 /\ LET send == Current \/ Fault = "late_dispatch" \/ (Fault = "expired_ticket" /\ EpochCurrent)
    IN /\ phase' = IF send THEN "sent" ELSE "done"
       /\ called' = IF send THEN TRUE ELSE called
       /\ dispatchConnection' = IF send THEN IF Fault = "misroute" THEN "other" ELSE "bound" ELSE dispatchConnection
       /\ outcome' = IF send THEN "searching" ELSE "retired"
       /\ violations' = violations
          \cup (IF send /\ ~Enabled THEN {"disabled"} ELSE {})
          \cup (IF send /\ SearchMode # "content" THEN {"metadata"} ELSE {})
          \cup (IF send /\ ~RestReady THEN {"rest"} ELSE {})
          \cup (IF send /\ ~BindingReady THEN {"route"} ELSE {})
          \cup (IF send /\ ~Current THEN {"stale_dispatch"} ELSE {})
 /\ UNCHANGED <<epochs,changed,kind,selected,disclosed,proof,tick>>
Receive(k) ==
 /\ phase = "sent" /\ k \in Kinds
 /\ phase' = "received" /\ kind' = k
 /\ UNCHANGED <<epochs,changed,selected,disclosed,proof,outcome,tick,called,violations,dispatchConnection>>
Admit ==
 /\ phase = "received"
 /\ LET responseOK == kind # "ai_search" \/ Fault = "ai_response"
        eligible == PhysicalAdmission \/ Fault = "skip_admission"
        accepted == kind # "empty" /\ responseOK /\ eligible
        statusAllowed == Current \/ Fault = "late_status" \/ (Fault = "expired_ticket" /\ EpochCurrent)
    IN /\ phase' = IF accepted THEN "admitted" ELSE "done"
       /\ outcome' = IF accepted THEN "candidate"
                      ELSE IF ~statusAllowed THEN "retired"
                      ELSE IF kind = "empty" THEN "no_remote_hits"
                      ELSE IF ~responseOK THEN "unsupported_response"
                      ELSE "not_admitted"
       /\ violations' = violations
          \cup (IF kind = "empty" /\ statusAllowed /\ Fault = "absence_claim" THEN {"absence"} ELSE {})
          \cup (IF ~accepted /\ statusAllowed /\ ~Current THEN {"stale_status"} ELSE {})
 /\ UNCHANGED <<epochs,changed,kind,selected,disclosed,proof,tick,called,dispatchConnection>>
Publish ==
 /\ phase = "admitted"
 /\ LET publish == Current \/ Fault = "late_publish" \/ (Fault = "expired_ticket" /\ EpochCurrent)
    IN /\ phase' = "done"
       /\ disclosed' = publish
       /\ outcome' = IF publish THEN "results" ELSE "retired"
       /\ proof' = IF ~publish THEN "none"
                    ELSE IF Fault = "exact_claim" THEN "exact_consumption_bytes"
                    ELSE "notion_remote_match"
       /\ selected' = IF publish /\ Fault = "mutate_pins" THEN <<2,2>> ELSE selected
       /\ violations' = violations
          \cup (IF publish /\ ~PhysicalAdmission THEN {"admission"} ELSE {})
          \cup (IF publish /\ kind = "ai_search" THEN {"response_type"} ELSE {})
          \cup (IF publish /\ ~Current THEN {"stale_publish"} ELSE {})
 /\ UNCHANGED <<epochs,changed,kind,tick,called,dispatchConnection>>
Change(k) ==
 /\ phase \in {"prepared","sent","received","admitted"} /\ ~changed /\ k \in EpochNames
 /\ epochs' = [epochs EXCEPT ![k] = 1] /\ changed' = TRUE
 /\ UNCHANGED <<phase,kind,selected,disclosed,proof,outcome,tick,called,violations,dispatchConnection>>
Cancel ==
 /\ phase \in {"prepared","sent","received","admitted"}
 /\ phase' = "done" /\ outcome' = "cancelled"
 /\ UNCHANGED <<epochs,changed,kind,selected,disclosed,proof,tick,called,violations,dispatchConnection>>
RemoteError ==
 /\ phase = "sent" /\ phase' = "done"
 /\ LET allowed == Current \/ Fault = "late_status" \/ (Fault = "expired_ticket" /\ EpochCurrent)
    IN /\ outcome' = IF allowed THEN "remote_error" ELSE "retired"
       /\ violations' = violations \cup (IF allowed /\ ~Current THEN {"stale_status"} ELSE {})
 /\ UNCHANGED <<epochs,changed,kind,selected,disclosed,proof,tick,called,dispatchConnection>>
Tick ==
 /\ phase \in {"prepared","sent","received","admitted"} /\ tick < 2
 /\ tick' = tick + 1
 /\ UNCHANGED <<phase,epochs,changed,kind,selected,disclosed,proof,outcome,called,violations,dispatchConnection>>
Timeout ==
 /\ phase \in {"prepared","sent","received","admitted"} /\ tick = 2
 /\ phase' = "done" /\ outcome' = "timed_out"
 /\ UNCHANGED <<epochs,changed,kind,selected,disclosed,proof,tick,called,violations,dispatchConnection>>
Done == phase = "done" /\ UNCHANGED vars
Next == Preflight \/ Dispatch \/ (\E k \in Kinds : Receive(k)) \/ Admit \/ Publish
        \/ (\E k \in EpochNames : Change(k)) \/ Cancel \/ RemoteError \/ Tick \/ Timeout \/ Done
Spec == Init /\ [][Next]_vars /\ WF_vars(Preflight) /\ WF_vars(Tick) /\ WF_vars(Timeout)
TypeOK ==
 /\ phase \in {"new","prepared","sent","received","admitted","done"}
 /\ epochs \in [EpochNames -> 0..1] /\ changed \in BOOLEAN /\ kind \in Kinds
 /\ selected \in {<<1,2>>,<<2,2>>} /\ disclosed \in BOOLEAN /\ called \in BOOLEAN
 /\ proof \in {"none","notion_remote_match","exact_consumption_bytes"} /\ tick \in 0..2
 /\ outcome \in {"none","disabled","metadata","query_required","rest_auth_required","mcp_auth_required","binding_required","ready","searching","retired","candidate","no_remote_hits","unsupported_response","not_admitted","results","cancelled","remote_error","timed_out"}
 /\ dispatchConnection \in {"none","bound","other"}
 /\ violations \subseteq {"disabled","metadata","rest","route","stale_dispatch","admission","response_type","stale_publish","absence","stale_status"}
DisabledHasNoNetwork == "disabled" \notin violations
MetadataDoesNotStartMcp == "metadata" \notin violations
RestAdmissionExistsBeforeSearch == "rest" \notin violations
BindingResolvedBeforeSearch == "route" \notin violations
QueryUsesBoundConnection == dispatchConnection # "other"
RetiredStatusCannotPublish == "stale_status" \notin violations
RetiredRequestCannotDispatch == "stale_dispatch" \notin violations
AuthorizedBeforeDisclosure == "admission" \notin violations
WorkspaceResponseRequired == "response_type" \notin violations
RetiredResultCannotPublish == "stale_publish" \notin violations
SearchKeepsPins == selected = InitialPins
RemoteHitIsNotExactByteProof == proof # "exact_consumption_bytes"
EmptyIsNotExhaustiveAbsence == "absence" \notin violations
RequestTerminates == <>(phase = "done")
NoNativeDisclosed == ~(disclosed /\ kind = "native")
NoProjectionDisclosed == ~(disclosed /\ kind = "projection")
================================================================================
