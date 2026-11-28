-------------------------- MODULE LibraryLifecycle --------------------------
EXTENDS Naturals, Sequences, FiniteSets, TLC

\* Root bootstrap and Library admission. World facts deliberately do not come
\* from descriptor fields. A role binding is abstract; concrete UUID spelling,
\* schema/property IDs, pagination and API failures remain boundary regressions.
CONSTANT Defect
ASSUME Defect \in {"none", "intent-after-root", "replay-root", "replay-table",
                  "trust-descriptor", "ignore-parent", "ignore-data-source",
                  "duplicate-role", "early-ready", "rebind-operation",
                  "ambient-retarget", "foreign-pending", "overwrite-root",
                  "pending-table-key"}

Roots == {"A", "B"}
Roles == {"skills", "files", "sources", "records"}
Order == <<"skills", "files", "sources", "records">>
ATables == [skills |-> "AS", files |-> "AF", sources |-> "AU", records |-> "AR"]
BTables == [skills |-> "BS", files |-> "BF", sources |-> "BU", records |-> "BR"]
ASources == [skills |-> "as", files |-> "af", sources |-> "au", records |-> "ar"]
BSources == [skills |-> "bs", files |-> "bf", sources |-> "bu", records |-> "br"]
DBs == {"AS", "AF", "AU", "AR", "AS2", "BS", "BF", "BU", "BR"}
DSs == {"as", "af", "au", "ar", "as2", "bs", "bf", "bu", "br"}
EmptyBindings == [r \in Roles |-> "none"]
ZeroCalls == [r \in Roles |-> 0]
Scenarios == {"fresh", "root-lost-visible", "root-lost-hidden",
              "table-lost-visible", "table-lost-hidden", "incomplete-readback",
              "copied-root", "moved-table", "foreign-data-source", "duplicate-role",
              "replacement-table", "pending-key-drift", "changed-default", "foreign-pending",
              "new-root-old-pending", "root-observation-conflict", "inspect"}

VARIABLES scenario, s
vars == <<scenario, s>>
Bootstrap == scenario \in {"fresh", "root-lost-visible", "root-lost-hidden",
                           "table-lost-visible", "table-lost-hidden", "incomplete-readback"}
Resume == scenario \in {"replacement-table", "pending-key-drift", "changed-default", "foreign-pending",
                        "new-root-old-pending", "root-observation-conflict"}
ReadOnly == ~Bootstrap /\ ~Resume
RequestedRoot == IF scenario \in {"copied-root", "new-root-old-pending"} THEN "B" ELSE "A"
AmbientRoot == IF scenario = "changed-default" THEN "B" ELSE RequestedRoot
OriginalIntentAuthorized == scenario \notin {"foreign-pending", "new-root-old-pending"}

\* Descriptor claims and physical Notion facts are independent functions.
DescriptorRoot(root) == IF scenario = "copied-root" /\ root = "B" THEN "A" ELSE root
DescriptorTables(root) ==
  IF scenario = "copied-root" /\ root = "B" THEN ATables
  ELSE IF root = "B" THEN BTables
  ELSE IF scenario \in {"replacement-table", "pending-key-drift"} THEN [ATables EXCEPT !.skills = "AS2"]
  ELSE IF scenario = "duplicate-role" THEN [ATables EXCEPT !.files = "AS"]
  ELSE ATables
DescriptorSources(root) ==
  IF scenario = "copied-root" /\ root = "B" THEN ASources
  ELSE IF root = "B" THEN BSources
  ELSE IF scenario \in {"replacement-table", "pending-key-drift"} THEN [ASources EXCEPT !.skills = "as2"]
  ELSE IF scenario = "duplicate-role" THEN [ASources EXCEPT !.files = "as"]
  ELSE ASources
ActualDBParent(db) ==
  IF scenario = "moved-table" /\ db = "AS" THEN "B"
  ELSE IF db \in {"BS", "BF", "BU", "BR"} THEN "B" ELSE "A"
ActualDSParent(ds) ==
  IF scenario = "foreign-data-source" /\ ds = "as" THEN "BS"
  ELSE CASE ds = "as" -> "AS" [] ds = "af" -> "AF"
         [] ds = "au" -> "AU" [] ds = "ar" -> "AR" [] ds = "as2" -> "AS2"
         [] ds = "bs" -> "BS" [] ds = "bf" -> "BF"
         [] ds = "bu" -> "BU" [] ds = "br" -> "BR"
CompleteUnique(bindings) ==
  /\ \A r \in Roles : bindings[r] # "none"
  /\ Cardinality({bindings[r] : r \in Roles}) = Cardinality(Roles)
Terminal == s.phase \in {"ready", "blocked", "rejected"}

Init ==
  /\ scenario \in Scenarios
  /\ s = [phase |-> "admit",
          intent |-> IF scenario = "foreign-pending" THEN "other"
                     ELSE IF Resume THEN "op" ELSE "none",
          admitted |-> FALSE, foundOriginalPending |-> TRUE,
          firstRoot |-> IF Resume THEN "A" ELSE "none",
          knownRoot |-> IF Resume THEN "A" ELSE "none",
          firstTables |-> IF Resume THEN ATables ELSE EmptyBindings,
          knownTables |-> IF Resume THEN ATables ELSE EmptyBindings,
          rootCalls |-> 0, tableCalls |-> ZeroCalls,
          rootWithoutIntent |-> FALSE,
          inFlight |-> "none", rootExists |-> ~Bootstrap, rootVisible |-> ~Bootstrap,
          createdTables |-> IF Bootstrap THEN {} ELSE Roles,
          visibleTables |-> IF Bootstrap THEN {} ELSE Roles,
          cursor |-> 1, descriptorPresent |-> ~Bootstrap,
          completeReadback |-> scenario # "incomplete-readback",
          readRoot |-> "none", readDescriptorRoot |-> "none",
          readTables |-> EmptyBindings, readSources |-> EmptyBindings,
          accepted |-> FALSE, writeRoot |-> "none", writeTable |-> "none",
          semanticWrites |-> 0, reason |-> ""]

Stop(phase, reason) ==
  /\ s' = [s EXCEPT !.phase = phase, !.reason = reason]
  /\ UNCHANGED scenario

Admit ==
  /\ s.phase = "admit"
  /\ IF Resume /\ ~OriginalIntentAuthorized /\ Defect # "foreign-pending"
     THEN Stop("rejected", "ORIGINAL_INTENT_REQUIRED")
     ELSE IF scenario = "root-observation-conflict"
       THEN IF Defect = "overwrite-root"
         THEN /\ s' = [s EXCEPT !.knownRoot = "B", !.phase = "blocked",
                              !.reason = "CONFLICTING_ROOT_OBSERVATION"]
              /\ UNCHANGED scenario
         ELSE Stop("blocked", "CONFLICTING_ROOT_OBSERVATION")
     ELSE
       /\ s' = [s EXCEPT !.admitted = TRUE,
                        !.foundOriginalPending = ~(scenario = "pending-key-drift" /\ Defect = "pending-table-key"),
                        !.knownTables = IF scenario = "pending-key-drift" /\ Defect = "pending-table-key"
                                        THEN DescriptorTables("A") ELSE @,
                        !.intent = IF Bootstrap /\ Defect # "intent-after-root" THEN "op" ELSE @,
                        !.phase = IF Bootstrap THEN "root-ready" ELSE "read"]
       /\ UNCHANGED scenario

DispatchRoot ==
  /\ s.phase = "root-ready" /\ s.rootCalls < 2
  /\ s' = [s EXCEPT !.phase = "root-return", !.rootCalls = @ + 1,
                   !.rootWithoutIntent = @ \/ s.intent # "op",
                   !.inFlight = "root", !.semanticWrites = @ + 1]
  /\ UNCHANGED scenario

ReturnRoot ==
  /\ s.phase = "root-return"
  /\ LET lost == scenario \in {"root-lost-visible", "root-lost-hidden"} /\ s.rootCalls = 1
     IN /\ s' = [s EXCEPT !.rootExists = TRUE,
                         !.rootVisible = ~lost \/ scenario = "root-lost-visible",
                         !.phase = IF lost THEN "root-unknown" ELSE "tables",
                         !.knownRoot = IF lost THEN @ ELSE "A",
                         !.firstRoot = IF lost THEN @ ELSE "A",
                         !.inFlight = IF lost THEN @ ELSE "none",
                         !.intent = IF Defect = "intent-after-root" THEN "op" ELSE @]
        /\ UNCHANGED scenario

ReconcileRoot ==
  /\ s.phase = "root-unknown"
  /\ IF s.rootVisible
     THEN /\ s' = [s EXCEPT !.knownRoot = "A", !.firstRoot = "A",
                           !.inFlight = "none", !.phase = "tables"]
          /\ UNCHANGED scenario
     ELSE IF Defect = "replay-root" THEN Stop("root-ready", "REPLAY_UNKNOWN")
     ELSE Stop("blocked", "ROOT_OUTCOME_UNKNOWN")

DispatchTable ==
  /\ s.phase = "tables" /\ s.cursor <= Len(Order)
  /\ LET role == Order[s.cursor]
     IN /\ s' = [s EXCEPT !.phase = "table-return", !.tableCalls[role] = @ + 1,
                         !.inFlight = role, !.semanticWrites = @ + 1]
        /\ UNCHANGED scenario

ReturnTable ==
  /\ s.phase = "table-return"
  /\ LET role == Order[s.cursor]
         lost == role = "skills" /\ s.tableCalls[role] = 1 /\
                 scenario \in {"table-lost-visible", "table-lost-hidden"}
     IN /\ s' = [s EXCEPT !.createdTables = @ \cup {role},
                         !.visibleTables = IF ~lost \/ scenario = "table-lost-visible"
                                           THEN @ \cup {role} ELSE @,
                         !.knownTables[role] = IF lost THEN @ ELSE ATables[role],
                         !.firstTables[role] = IF lost THEN @ ELSE ATables[role],
                         !.cursor = IF lost THEN @ ELSE @ + 1,
                         !.inFlight = IF lost THEN @ ELSE "none",
                         !.phase = IF lost THEN "table-unknown" ELSE "tables"]
        /\ UNCHANGED scenario

ReconcileTable ==
  /\ s.phase = "table-unknown"
  /\ LET role == Order[s.cursor]
     IN IF role \in s.visibleTables
        THEN /\ s' = [s EXCEPT !.knownTables[role] = ATables[role],
                               !.firstTables[role] = ATables[role],
                               !.cursor = @ + 1, !.inFlight = "none", !.phase = "tables"]
             /\ UNCHANGED scenario
        ELSE IF Defect = "replay-table" THEN Stop("tables", "REPLAY_UNKNOWN")
        ELSE Stop("blocked", "TABLE_OUTCOME_UNKNOWN")

WriteDescriptor ==
  /\ s.phase = "tables" /\ s.cursor > Len(Order)
  /\ s' = [s EXCEPT !.descriptorPresent = TRUE, !.semanticWrites = @ + 1, !.phase = "read"]
  /\ UNCHANGED scenario

ReadLibrary ==
  /\ s.phase = "read"
  /\ LET root == IF Defect = "ambient-retarget" /\ scenario = "changed-default"
                 THEN AmbientRoot
                 ELSE IF Bootstrap \/ Resume THEN s.knownRoot ELSE RequestedRoot
     IN /\ s' = [s EXCEPT !.readRoot = root, !.readDescriptorRoot = DescriptorRoot(root),
                         !.readTables = DescriptorTables(root),
                         !.readSources = DescriptorSources(root), !.phase = "verify"]
        /\ UNCHANGED scenario

RootFact == s.readDescriptorRoot = s.readRoot /\ s.readRoot = RequestedRoot
ParentFact(root) == \A r \in Roles : ActualDBParent(s.readTables[r]) = root
DataSourceFact == \A r \in Roles : ActualDSParent(s.readSources[r]) = s.readTables[r]
RolesFact == CompleteUnique(s.readTables) /\ CompleteUnique(s.readSources)
ReadbackFact == s.rootExists /\ s.descriptorPresent /\
                s.createdTables = Roles /\ s.completeReadback
BindingFact == ~Resume \/ (s.readRoot = s.firstRoot /\ s.readTables = s.firstTables)

Verify ==
  /\ s.phase = "verify"
  /\ LET authority == IF Defect = "trust-descriptor" THEN s.readDescriptorRoot ELSE s.readRoot
         rootOK == s.readDescriptorRoot = authority /\ s.readRoot = RequestedRoot
         parentOK == Defect = "ignore-parent" \/ ParentFact(authority)
         sourceOK == Defect = "ignore-data-source" \/ DataSourceFact
         roleOK == Defect = "duplicate-role" \/ RolesFact
         bindingOK == Defect = "rebind-operation" \/ ~Resume \/
                      (s.readRoot = s.knownRoot /\ s.readTables = s.knownTables)
         readbackOK == Defect = "early-ready" \/ ReadbackFact
     IN IF rootOK /\ parentOK /\ sourceOK /\ roleOK /\ bindingOK /\ readbackOK
        THEN /\ s' = [s EXCEPT !.accepted = TRUE, !.phase = "verified"]
             /\ UNCHANGED scenario
        ELSE Stop("rejected", "LIBRARY_READBACK_OR_BINDING_MISMATCH")

Publish ==
  /\ s.phase = "verified"
  \* Selecting a follow-on write target is synchronous; no atomic remote CAS is
  \* assumed. Later external moves are outside this admission-time snapshot.
  /\ s' = [s EXCEPT !.phase = "ready",
                   !.writeRoot = IF Resume THEN s.readRoot ELSE "none",
                   !.writeTable = IF Resume THEN s.readTables.skills ELSE "none",
                   !.semanticWrites = IF Resume THEN @ + 1 ELSE @,
                   !.intent = IF Bootstrap \/ Resume THEN "none" ELSE @]
  /\ UNCHANGED scenario

Advance == Admit \/ DispatchRoot \/ ReturnRoot \/ ReconcileRoot \/ DispatchTable
           \/ ReturnTable \/ ReconcileTable \/ WriteDescriptor \/ ReadLibrary \/ Verify \/ Publish
Done == Terminal /\ UNCHANGED vars
Next == Advance \/ Done
Spec == Init /\ [][Next]_vars /\ WF_vars(Advance)

TypeOK ==
  /\ scenario \in Scenarios
  /\ s.phase \in {"admit", "root-ready", "root-return", "root-unknown", "tables",
                  "table-return", "table-unknown", "read", "verify", "verified",
                  "ready", "blocked", "rejected"}
  /\ s.intent \in {"none", "op", "other"}
  /\ s.admitted \in BOOLEAN /\ s.accepted \in BOOLEAN /\ s.rootWithoutIntent \in BOOLEAN
  /\ s.foundOriginalPending \in BOOLEAN
  /\ s.knownRoot \in Roots \cup {"none"} /\ s.firstRoot \in Roots \cup {"none"}
  /\ s.knownTables \in [Roles -> DBs \cup {"none"}]
  /\ s.firstTables \in [Roles -> DBs \cup {"none"}]
  /\ s.rootCalls \in 0..2 /\ s.tableCalls \in [Roles -> 0..2]
  /\ s.inFlight \in Roles \cup {"root", "none"}
  /\ s.rootExists \in BOOLEAN /\ s.rootVisible \in BOOLEAN
  /\ s.createdTables \subseteq Roles /\ s.visibleTables \subseteq Roles
  /\ s.cursor \in 1..5 /\ s.descriptorPresent \in BOOLEAN /\ s.completeReadback \in BOOLEAN
  /\ s.readRoot \in Roots \cup {"none"} /\ s.readDescriptorRoot \in Roots \cup {"none"}
  /\ s.readTables \in [Roles -> DBs \cup {"none"}]
  /\ s.readSources \in [Roles -> DSs \cup {"none"}]
  /\ s.writeRoot \in Roots \cup {"none"} /\ s.writeTable \in DBs \cup {"none"}
  /\ s.semanticWrites \in 0..8
IntentBeforeRootCreate == ~s.rootWithoutIntent
UnknownCreateNeverReplayed == s.rootCalls <= 1 /\ \A r \in Roles : s.tableCalls[r] <= 1
KnownBindingsNeverRebound ==
  /\ s.firstRoot # "none" => s.knownRoot = s.firstRoot
  /\ \A r \in Roles : s.firstTables[r] # "none" => s.knownTables[r] = s.firstTables[r]
OriginalIntentRequired == Resume /\ s.admitted => OriginalIntentAuthorized
PendingLookupIsStable == Resume /\ s.admitted => s.foundOriginalPending
UnknownIntentRetained == s.phase = "blocked" /\ s.inFlight # "none" => s.intent = "op"
ReadyIdentityIsRequestedRoot == s.phase = "ready" => RootFact
ReadyTablesHaveDirectRoot == s.phase = "ready" => ParentFact(s.readRoot)
ReadyDataSourcesBelongToTables == s.phase = "ready" => DataSourceFact
ReadyRolesAreCompleteUnique == s.phase = "ready" => RolesFact
ReadyHasCompleteReadback == s.phase = "ready" => ReadbackFact
FrozenOperationTarget ==
  Resume =>
    /\ s.readRoot = "none" \/ s.readRoot = s.firstRoot
    /\ s.accepted => BindingFact
    /\ s.writeTable = "none" \/ (s.writeRoot = s.firstRoot /\ s.writeTable = s.firstTables.skills)
InspectionDoesNotWrite == ReadOnly => s.semanticWrites = 0
InitializationEventuallyExplained == <>Terminal
=============================================================================

