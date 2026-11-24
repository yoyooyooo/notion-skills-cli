------------------------ MODULE ReferenceSelection ------------------------
EXTENDS Naturals, TLC

\* A bounded binding/selection slice, not a parser or byte-verification proof.
\* Resource identity abstracts either a native/resource File binding or a
\* frozen Source route plus hash/bytes/mode. Source files need no File row.
CONSTANT Defect
ASSUME Defect \in {"none", "ambient-library", "missing-context", "name-fallback",
                  "duplicate-claim", "foreign-manifest", "missing-manifest",
                  "live-entrypoint", "missing-path", "source-fallback",
                  "source-pin", "resolution-write", "explicit-conflict"}

Scenarios == {"document", "entry", "no-context", "explicit-library", "explicit-conflict",
              "missing-id", "duplicate-id", "fixed-file", "fixed-entry",
              "foreign-manifest", "missing-manifest", "missing-path",
              "source-valid", "source-missing", "source-ambiguous"}
Snapshots == {"ta1", "ta2", "pa1", "pa2", "tr1", "pr1"}
Paths == {"SKILL.md", "references/guide.md", "new.md"}
Owner(s) == CASE s \in {"ta1", "ta2"} -> <<"test", "architect">>
              [] s \in {"pa1", "pa2"} -> <<"production", "architect">>
              [] s = "tr1" -> <<"test", "reviewer">>
              [] s = "pr1" -> <<"production", "reviewer">>
              [] OTHER -> <<"none", "none">>
ManifestPaths(s) == IF s \in {"ta2", "pa2"} THEN Paths
                   ELSE {"SKILL.md", "references/guide.md"}
ManifestEntry(s) == IF s \in {"ta2", "pa2"} THEN "references/guide.md"
                   ELSE "SKILL.md"
Resource(s, p) == <<s, p>>

VARIABLES scenario, phase, ambientLibrary, ambientChanged, liveChanged,
          boundLibrary, boundSkill, selectedSnapshot, selectedPath,
          selectedResource, reason, semanticWrites
vars == <<scenario, phase, ambientLibrary, ambientChanged, liveChanged,
          boundLibrary, boundSkill, selectedSnapshot, selectedPath,
          selectedResource, reason, semanticWrites>>

SourceRelative == scenario \in {"source-valid", "source-missing", "source-ambiguous"}
Fixed == scenario \in {"fixed-file", "fixed-entry", "foreign-manifest",
                       "missing-manifest", "missing-path"}
ExpectedLibrary == IF scenario \in {"explicit-library", "explicit-conflict"} THEN "production"
                   ELSE IF scenario = "no-context" THEN "none" ELSE "test"
RequestedSkill == IF SourceRelative THEN "reviewer"
                  ELSE IF scenario = "missing-id" THEN "missing" ELSE "architect"
RequestedPath == IF scenario \in {"document", "entry", "no-context",
                                  "explicit-library", "fixed-entry"} THEN ""
                 ELSE IF scenario = "missing-path" THEN "new.md"
                 ELSE "references/guide.md"
RequestedSnapshot == IF scenario = "foreign-manifest" THEN "pa1" ELSE "ta1"
CurrentSnapshot(lib, skill) ==
  IF skill = "reviewer" THEN IF lib = "test" THEN "tr1" ELSE "pr1"
  ELSE IF lib = "test" THEN IF liveChanged THEN "ta2" ELSE "ta1"
       ELSE IF liveChanged THEN "pa2" ELSE "pa1"
Bound == phase \in {"bound", "selected", "returned"}
Selected == phase \in {"selected", "returned"}
Terminal == phase \in {"returned", "rejected"}

Init ==
  /\ scenario \in Scenarios
  /\ phase = "parsed"
  /\ ambientLibrary = "test" /\ ambientChanged = FALSE /\ liveChanged = FALSE
  /\ boundLibrary = "none" /\ boundSkill = "none"
  /\ selectedSnapshot = "none" /\ selectedPath = ""
  /\ selectedResource = <<"none", "">>
  /\ reason = "" /\ semanticWrites = 0

Reject(why) ==
  /\ phase' = "rejected" /\ reason' = why
  /\ UNCHANGED <<scenario, ambientLibrary, ambientChanged, liveChanged,
                 boundLibrary, boundSkill, selectedSnapshot, selectedPath,
                 selectedResource, semanticWrites>>

Choose(s, p) ==
  /\ phase' = "selected" /\ selectedSnapshot' = s /\ selectedPath' = p
  /\ selectedResource' = Resource(s, p)
  /\ UNCHANGED <<scenario, ambientLibrary, ambientChanged, liveChanged,
                 boundLibrary, boundSkill, reason, semanticWrites>>

ChangeDefault ==
  /\ ~ambientChanged /\ phase \in {"parsed", "bound"}
  /\ ambientLibrary' = "production" /\ ambientChanged' = TRUE
  /\ UNCHANGED <<scenario, phase, liveChanged, boundLibrary, boundSkill,
                 selectedSnapshot, selectedPath, selectedResource, reason, semanticWrites>>

ChangeLiveEntrypoint ==
  /\ ~liveChanged /\ phase \in {"parsed", "bound"}
  /\ liveChanged' = TRUE
  /\ UNCHANGED <<scenario, phase, ambientLibrary, ambientChanged,
                 boundLibrary, boundSkill, selectedSnapshot, selectedPath,
                 selectedResource, reason, semanticWrites>>

BindContext ==
  /\ phase = "parsed"
  /\ IF scenario = "explicit-conflict" /\ Defect # "explicit-conflict"
     THEN Reject("LIBRARY_SCOPE_MISMATCH")
     ELSE LET lib == IF Defect = "ambient-library" /\ scenario = "document"
                       THEN ambientLibrary
                    ELSE IF Defect = "missing-context" /\ scenario = "no-context"
                       THEN ambientLibrary
                    ELSE ExpectedLibrary
          IN IF lib = "none" THEN Reject("LIBRARY_CONTEXT_REQUIRED")
             ELSE
               /\ phase' = "bound" /\ boundLibrary' = lib /\ boundSkill' = RequestedSkill
               /\ UNCHANGED <<scenario, ambientLibrary, ambientChanged, liveChanged,
                              selectedSnapshot, selectedPath, selectedResource,
                              reason, semanticWrites>>

SelectCurrent ==
  /\ phase = "bound" /\ ~Fixed /\ ~SourceRelative
  /\ IF scenario = "missing-id" /\ Defect # "name-fallback"
        THEN Reject("SKILL_NOT_FOUND")
     ELSE IF scenario = "duplicate-id" /\ Defect # "duplicate-claim"
        THEN Reject("DUPLICATE_IDENTITY")
     ELSE LET actualSkill == IF scenario = "missing-id" THEN "architect" ELSE boundSkill
              s == CurrentSnapshot(boundLibrary, actualSkill)
              p == IF RequestedPath = "" THEN ManifestEntry(s) ELSE RequestedPath
          IN Choose(s, p)

SelectFixed ==
  /\ phase = "bound" /\ Fixed
  /\ LET missing == scenario = "missing-manifest"
         repair == (missing /\ Defect = "missing-manifest") \/
                   (scenario = "missing-path" /\ Defect = "missing-path" /\ liveChanged)
         s == IF repair THEN CurrentSnapshot(boundLibrary, boundSkill) ELSE RequestedSnapshot
         p == IF RequestedPath # "" THEN RequestedPath
              ELSE IF Defect = "live-entrypoint" THEN ManifestEntry(CurrentSnapshot(boundLibrary, boundSkill))
              ELSE ManifestEntry(s)
         sameOwner == Owner(s) = <<boundLibrary, boundSkill>>
     IN IF missing /\ Defect # "missing-manifest" THEN Reject("SNAPSHOT_MISSING")
        ELSE IF ~sameOwner /\ Defect # "foreign-manifest" THEN Reject("SNAPSHOT_OWNER_MISMATCH")
        ELSE IF p \notin ManifestPaths(s) THEN Reject("FILE_NOT_FOUND")
        ELSE Choose(s, p)

SelectSourceRelative ==
  /\ phase = "bound" /\ SourceRelative
  /\ IF scenario # "source-valid" /\ Defect # "source-fallback"
       THEN Reject("SOURCE_TARGET_UNRESOLVED")
     ELSE LET s == IF Defect = "source-pin" THEN "ta1"
                   ELSE CurrentSnapshot(boundLibrary, boundSkill)
          IN Choose(s, RequestedPath)

ReturnSelection ==
  /\ phase = "selected" /\ phase' = "returned"
  /\ semanticWrites' = IF Defect = "resolution-write" THEN 1 ELSE 0
  /\ UNCHANGED <<scenario, ambientLibrary, ambientChanged, liveChanged,
                 boundLibrary, boundSkill, selectedSnapshot, selectedPath,
                 selectedResource, reason>>

Done == Terminal /\ UNCHANGED vars
Next == ChangeDefault \/ ChangeLiveEntrypoint \/ BindContext \/ SelectCurrent
        \/ SelectFixed \/ SelectSourceRelative \/ ReturnSelection \/ Done
Spec == Init /\ [][Next]_vars
        /\ WF_vars(BindContext)
        /\ WF_vars(SelectCurrent \/ SelectFixed \/ SelectSourceRelative)
        /\ WF_vars(ReturnSelection)

TypeOK ==
  /\ scenario \in Scenarios
  /\ phase \in {"parsed", "bound", "selected", "returned", "rejected"}
  /\ ambientLibrary \in {"test", "production"}
  /\ ambientChanged \in BOOLEAN /\ liveChanged \in BOOLEAN
  /\ boundLibrary \in {"none", "test", "production"}
  /\ boundSkill \in {"none", "architect", "reviewer", "missing"}
  /\ selectedSnapshot \in Snapshots \cup {"none"}
  /\ selectedPath \in Paths \cup {""}
  /\ selectedResource \in (Snapshots \cup {"none"}) \X (Paths \cup {""})
  /\ semanticWrites \in 0..1
ContextIsAuthoritative == Bound => boundLibrary = ExpectedLibrary /\ ExpectedLibrary # "none"
ExplicitScopeConstraint == scenario = "explicit-conflict" => ~Bound
StableIdentityIsExact == Selected => Owner(selectedSnapshot) = <<boundLibrary, boundSkill>>
DuplicateClaimRejected == scenario = "duplicate-id" => ~Selected
MissingManifestRejected == scenario = "missing-manifest" => ~Selected
FixedSelectionUsesManifest ==
  Fixed /\ Selected =>
    /\ selectedSnapshot = RequestedSnapshot
    /\ selectedPath \in ManifestPaths(RequestedSnapshot)
    /\ selectedPath = IF RequestedPath = "" THEN ManifestEntry(RequestedSnapshot) ELSE RequestedPath
    /\ selectedResource = Resource(RequestedSnapshot, selectedPath)
SourceAuthorityRequired == SourceRelative /\ Selected => scenario = "source-valid"
CrossSkillSelectionIsTargetOwned ==
  SourceRelative /\ Selected => Owner(selectedSnapshot) = <<boundLibrary, "reviewer">>
ResolutionDoesNotWrite == semanticWrites = 0
ResolutionEventuallyExplained == <>Terminal
=============================================================================
