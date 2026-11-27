-------------------------- MODULE ClosureEvidence --------------------------
EXTENDS Integers, FiniteSets

\* BOUNDED CONTRACT, NOT AN IMPLEMENTATION REFINEMENT PROOF.
\* One attempt reuses or renews an already complete cached root+Requires graph.
\* Every cached version and the cached Files/Sources membership epoch are 0.
\* "Known" means an accepted observation.  Unknown remote changes, transport,
\* independent remote read atomicity, and fetching replacement bodies are out
\* of scope.  The basis below is local knowledge, not a remote revision.

CONSTANTS EnforceCoverage, EnforceClosureFence

Nodes == {"root", "requires"}
Checks == Nodes \cup {"members"}
NoObservation == -1
Phases == {"cached", "checking", "prepared", "published", "ttl_reused", "blocked"}
Terminal == {"published", "ttl_reused", "blocked"}

VARIABLES phase, requiredVersion, membershipEpoch, observed,
          preparedBasis, leaseRenewed

vars == <<phase, requiredVersion, membershipEpoch, observed,
          preparedBasis, leaseRenewed>>

\* A member-list change can be known without changing either known file.
CurrentKnown == [root |-> 0, requires |-> requiredVersion,
                 members |-> membershipEpoch]
KnownChange == requiredVersion # 0 \/ membershipEpoch # 0
FullCoverage == \A key \in Checks : observed[key] # NoObservation
ObservedUnchanged == \A key \in Checks : observed[key] \in {NoObservation, 0}
FenceMatches == preparedBasis = CurrentKnown

\* Keep the old body TTL valid for the entire bounded attempt.  Refusal after
\* a known change therefore cannot be explained away as ordinary TTL expiry.
TtlStillFresh == TRUE

Init ==
  /\ phase = "cached"
  /\ requiredVersion = 0
  /\ membershipEpoch = 0
  /\ observed = [key \in Checks |-> NoObservation]
  /\ preparedBasis = [key \in Checks |-> NoObservation]
  /\ leaseRenewed = FALSE

BeginValidation ==
  /\ phase = "cached"
  /\ phase' = "checking"
  /\ UNCHANGED <<requiredVersion, membershipEpoch, observed,
                 preparedBasis, leaseRenewed>>

ObserveMetadata(key) ==
  /\ phase = "checking"
  /\ observed[key] = NoObservation
  /\ observed' = [observed EXCEPT ![key] = CurrentKnown[key]]
  /\ UNCHANGED <<phase, requiredVersion, membershipEpoch,
                 preparedBasis, leaseRenewed>>

ReadRoot == ObserveMetadata("root")
ReadRequires == ObserveMetadata("requires")
ReadMembership == ObserveMetadata("members")

\* These actions accept externally obtained evidence and monotonically advance
\* local knowledge.  Either can occur after preparation and before publication.
ObserveRequiredChange ==
  /\ phase \in {"checking", "prepared"}
  /\ requiredVersion = 0
  /\ requiredVersion' = 1
  /\ UNCHANGED <<phase, membershipEpoch, observed,
                 preparedBasis, leaseRenewed>>

ObserveMembershipChange ==
  /\ phase \in {"checking", "prepared"}
  /\ membershipEpoch = 0
  /\ membershipEpoch' = 1
  /\ UNCHANGED <<phase, requiredVersion, observed,
                 preparedBasis, leaseRenewed>>

PrepareLease ==
  /\ phase = "checking"
  /\ (IF EnforceCoverage THEN FullCoverage ELSE observed["root"] # NoObservation)
  /\ ObservedUnchanged
  /\ ~KnownChange
  /\ phase' = "prepared"
  /\ preparedBasis' = CurrentKnown
  /\ UNCHANGED <<requiredVersion, membershipEpoch, observed, leaseRenewed>>

RejectKnownChange ==
  /\ phase = "checking"
  /\ KnownChange
  /\ phase' = "blocked"
  /\ UNCHANGED <<requiredVersion, membershipEpoch, observed,
                 preparedBasis, leaseRenewed>>

PublishLease ==
  /\ phase = "prepared"
  /\ (~EnforceClosureFence \/ FenceMatches)
  /\ phase' = "published"
  /\ leaseRenewed' = TRUE
  /\ UNCHANGED <<requiredVersion, membershipEpoch, observed, preparedBasis>>

RejectLateChange ==
  /\ phase = "prepared"
  /\ ~FenceMatches
  /\ phase' = "blocked"
  /\ UNCHANGED <<requiredVersion, membershipEpoch, observed,
                 preparedBasis, leaseRenewed>>

ReuseOriginalTtl ==
  /\ phase \in {"cached", "checking", "prepared", "blocked"}
  /\ TtlStillFresh
  /\ ~KnownChange
  /\ phase' = "ttl_reused"
  /\ UNCHANGED <<requiredVersion, membershipEpoch, observed,
                 preparedBasis, leaseRenewed>>

Done == phase \in Terminal /\ UNCHANGED vars

Next == BeginValidation
        \/ ReadRoot \/ ReadRequires \/ ReadMembership
        \/ ObserveRequiredChange \/ ObserveMembershipChange
        \/ PrepareLease \/ RejectKnownChange
        \/ PublishLease \/ RejectLateChange
        \/ ReuseOriginalTtl \/ Done

TypeOK ==
  /\ phase \in Phases
  /\ requiredVersion \in 0..1
  /\ membershipEpoch \in 0..1
  /\ observed \in [Checks -> {NoObservation, 0, 1}]
  /\ preparedBasis \in [Checks -> {NoObservation, 0, 1}]
  /\ leaseRenewed \in BOOLEAN

\* All nodes AND complete collection membership evidence are needed to renew
\* the closure.  Root-only or known-file-only observations are insufficient.
FullClosureEvidence == leaseRenewed => (\A key \in Checks : observed[key] = 0)

\* Once a dependency or collection change is known, the still-valid old TTL
\* cannot make this stale graph reusable or eligible for renewal.
KnownChangeWins == phase \in {"published", "ttl_reused"} => ~KnownChange

\* A later accepted dependency or membership change invalidates the prepared
\* candidate before publication, even when every earlier read was unchanged.
PublicationFence == leaseRenewed => FenceMatches

TtlReuseDoesNotRenew == phase = "ttl_reused" => ~leaseRenewed
=============================================================================

