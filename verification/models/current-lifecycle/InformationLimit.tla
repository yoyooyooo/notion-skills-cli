-------------------------- MODULE InformationLimit --------------------------
EXTENDS Naturals, Integers, TLC
CONSTANT AllowHiddenEdits
VARIABLES remoteVersion, cachedVersion, consumed, remoteAtRead
vars == <<remoteVersion, cachedVersion, consumed, remoteAtRead>>
Init == /\ remoteVersion = 0 /\ cachedVersion = 0 /\ consumed = -1 /\ remoteAtRead = 0
HiddenRemoteEdit == /\ AllowHiddenEdits /\ remoteVersion = 0 /\ remoteVersion' = 1
                    /\ UNCHANGED <<cachedVersion, consumed, remoteAtRead>>
ConsumeWithinTTL == /\ consumed = -1 /\ consumed' = cachedVersion
                    /\ remoteAtRead' = remoteVersion
                    /\ UNCHANGED <<remoteVersion, cachedVersion>>
Idle == UNCHANGED vars
Next == HiddenRemoteEdit \/ ConsumeWithinTTL \/ Idle
TypeOK == remoteVersion \in {0,1} /\ cachedVersion = 0 /\ consumed \in {-1,0}
          /\ remoteAtRead \in {0,1}
AlwaysEqualsRemote == consumed = -1 \/ consumed = remoteAtRead
=============================================================================

