--------------------------- MODULE AuthAcquisition ---------------------------
EXTENDS Naturals, FiniteSets, TLC
CONSTANTS Enabled, Mode, ExplicitToken, TokenValid, CachedOAuth, Fault
Waiters == {1, 2}
VARIABLES w, auth, credentialEpoch, sessionEpoch, authEpoch, grant,
          grantEpoch, tick, callbackValid, exchanges, violations
vars == <<w, auth, credentialEpoch, sessionEpoch, authEpoch, grant,
          grantEpoch, tick, callbackValid, exchanges, violations>>
Terminal(s) == s \notin {"new", "waiting"}
Waiting == {i \in Waiters : w[i] = "waiting"}
AllDone == \A i \in Waiters : Terminal(w[i])
Interactive == Mode = "interactive"
Init ==
 /\ w = [i \in Waiters |-> "new"]
 /\ auth = "none" /\ credentialEpoch = 0 /\ sessionEpoch = 0 /\ authEpoch = 0
 /\ grant = CachedOAuth /\ grantEpoch = 0 /\ tick = 0
 /\ callbackValid = FALSE /\ exchanges = 0 /\ violations = {}
Start ==
 /\ \A i \in Waiters : w[i] = "new"
 /\ LET dialog == (Enabled \/ Fault = "disabled_auth")
                   /\ ~ExplicitToken /\ ~grant
                   /\ (Interactive \/ Fault = "headless_browser")
        result == IF ~Enabled /\ Fault # "disabled_auth" THEN "off"
                  ELSE IF ExplicitToken THEN
                    IF TokenValid \/ Fault = "token_fallback" THEN "ready" ELSE "token_invalid"
                  ELSE IF grant THEN "ready"
                  ELSE IF dialog THEN "waiting" ELSE "auth_required"
    IN /\ w' = [i \in Waiters |-> result]
       /\ auth' = IF dialog THEN "pending" ELSE "none"
       /\ violations' = violations
          \cup (IF ~Enabled /\ dialog THEN {"disabled"} ELSE {})
          \cup (IF ~Interactive /\ dialog THEN {"headless"} ELSE {})
          \cup (IF ExplicitToken /\ ~TokenValid /\ result = "ready" THEN {"fallback"} ELSE {})
 /\ UNCHANGED <<credentialEpoch,sessionEpoch,authEpoch,grant,grantEpoch,tick,callbackValid,exchanges>>
ReceiveCallback(valid) ==
 /\ (auth = "pending" \/ (Fault = "callback_replay" /\ auth = "committed" /\ exchanges < 2))
 /\ Waiting # {}
 /\ LET current == credentialEpoch = authEpoch /\ tick < 2
        accepted == (valid \/ Fault = "invalid_callback") /\ (current \/ Fault = "retired_callback")
    IN /\ auth' = IF accepted THEN "exchanging" ELSE IF current THEN "rejected" ELSE "retired"
       /\ exchanges' = IF accepted THEN exchanges + 1 ELSE exchanges
       /\ violations' = violations \cup (IF accepted /\ ~current THEN {"retired_exchange"} ELSE {})
 /\ callbackValid' = valid
 /\ UNCHANGED <<w,credentialEpoch,sessionEpoch,authEpoch,grant,grantEpoch,tick>>
ExchangeReturns ==
 /\ auth = "exchanging" /\ Waiting # {}
 /\ auth' = "returned"
 /\ UNCHANGED <<w,credentialEpoch,sessionEpoch,authEpoch,grant,grantEpoch,tick,callbackValid,exchanges,violations>>
CommitGrant ==
 /\ auth = "returned" /\ Waiting # {}
 /\ LET allowed == (credentialEpoch = authEpoch \/ Fault = "late_grant")
                    /\ (tick < 2 \/ Fault = "expired_grant")
    IN /\ auth' = IF allowed THEN "committed" ELSE "retired"
       /\ grant' = IF allowed THEN TRUE ELSE grant
       /\ grantEpoch' = IF allowed THEN authEpoch ELSE grantEpoch
       /\ violations' = violations
          \cup (IF allowed /\ credentialEpoch # authEpoch THEN {"late_grant"} ELSE {})
          \cup (IF allowed /\ ~callbackValid THEN {"invalid_callback"} ELSE {})
          \cup (IF allowed /\ tick = 2 THEN {"expired_grant"} ELSE {})
 /\ UNCHANGED <<w,credentialEpoch,sessionEpoch,authEpoch,tick,callbackValid,exchanges>>
Publish(i) ==
 /\ w[i] = "waiting" /\ grant
 /\ LET epochLive == credentialEpoch = 0 /\ sessionEpoch = 0 /\ grantEpoch = credentialEpoch
        current == epochLive /\ tick < 2
        allowed == current \/ Fault = "late_resume" \/ (Fault = "expired_resume" /\ epochLive)
    IN /\ w' = [w EXCEPT ![i] = IF allowed THEN "ready" ELSE "stale"]
       /\ violations' = violations \cup (IF allowed /\ ~current THEN {"stale_resume"} ELSE {})
 /\ UNCHANGED <<auth,credentialEpoch,sessionEpoch,authEpoch,grant,grantEpoch,tick,callbackValid,exchanges>>
Cancel(i) ==
 /\ w[i] = "waiting"
 /\ LET cascade == Fault = "cancel_shared" /\ Cardinality(Waiting) = 2
    IN /\ w' = IF cascade THEN [j \in Waiters |-> "cancelled"] ELSE [w EXCEPT ![i] = "cancelled"]
       /\ violations' = violations \cup (IF cascade THEN {"cancel_other"} ELSE {})
       /\ auth' = IF cascade \/ Cardinality(Waiting) = 1 THEN "retired" ELSE auth
 /\ UNCHANGED <<credentialEpoch,sessionEpoch,authEpoch,grant,grantEpoch,tick,callbackValid,exchanges>>
Logout ==
 /\ credentialEpoch = 0 /\ Waiting # {}
 /\ credentialEpoch' = 1 /\ grant' = FALSE
 /\ UNCHANGED <<w,auth,sessionEpoch,authEpoch,grantEpoch,tick,callbackValid,exchanges,violations>>
SwitchSession ==
 /\ sessionEpoch = 0 /\ Waiting # {}
 /\ sessionEpoch' = 1
 /\ UNCHANGED <<w,auth,credentialEpoch,authEpoch,grant,grantEpoch,tick,callbackValid,exchanges,violations>>
Tick ==
 /\ Waiting # {} /\ tick < 2
 /\ tick' = tick + 1
 /\ UNCHANGED <<w,auth,credentialEpoch,sessionEpoch,authEpoch,grant,grantEpoch,callbackValid,exchanges,violations>>
Timeout(i) ==
 /\ w[i] = "waiting" /\ tick = 2 /\ Fault # "no_timeout"
 /\ w' = [w EXCEPT ![i] = "timed_out"]
 /\ auth' = IF Cardinality(Waiting) = 1 THEN "retired" ELSE auth
 /\ UNCHANGED <<credentialEpoch,sessionEpoch,authEpoch,grant,grantEpoch,tick,callbackValid,exchanges,violations>>
Done == AllDone /\ UNCHANGED vars
Next == Start \/ (\E valid \in BOOLEAN : ReceiveCallback(valid)) \/ ExchangeReturns
        \/ CommitGrant \/ (\E i \in Waiters : Publish(i) \/ Cancel(i) \/ Timeout(i))
        \/ Logout \/ SwitchSession \/ Tick \/ Done
Spec == Init /\ [][Next]_vars /\ WF_vars(Start) /\ WF_vars(Tick)
        /\ (\A i \in Waiters : WF_vars(Timeout(i)) /\ WF_vars(Publish(i)))
TypeOK == /\ w \in [Waiters -> {"new","waiting","ready","off","token_invalid","auth_required","cancelled","timed_out","stale"}]
          /\ credentialEpoch \in 0..1 /\ sessionEpoch \in 0..1 /\ authEpoch = 0
          /\ tick \in 0..2 /\ exchanges \in 0..2 /\ grant \in BOOLEAN
          /\ auth \in {"none","pending","exchanging","returned","committed","rejected","retired"}
          /\ grantEpoch \in 0..1 /\ callbackValid \in BOOLEAN
          /\ violations \subseteq {"disabled","headless","fallback","late_grant","invalid_callback","stale_resume","cancel_other","retired_exchange","expired_grant"}
TokenPrecedence == "fallback" \notin violations
HeadlessNeverOpensBrowser == "headless" \notin violations
DisabledStaysQuiet == "disabled" \notin violations
CallbackMustValidate == "invalid_callback" \notin violations
CallbackConsumedOnce == exchanges <= 1
LogoutCannotResurrectGrant == "late_grant" \notin violations
RetiredRequestCannotResume == "stale_resume" \notin violations
WaiterCancellationIsLocal == "cancel_other" \notin violations
RetiredCallbackCannotExchange == "retired_exchange" \notin violations
ExpiredFlightCannotCommitGrant == "expired_grant" \notin violations
NoSuccessfulPair == ~(w[1] = "ready" /\ w[2] = "ready")
NoLocalCancelSuccess == ~(w[1] = "cancelled" /\ w[2] = "ready")
RequestsTerminate == <>(AllDone)
=============================================================================
