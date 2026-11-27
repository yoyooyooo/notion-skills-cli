------------------------- MODULE ObservationSafety -------------------------
EXTENDS Naturals, Integers, TLC

CONSTANTS Mode, MaxTime, MaxEpoch, ReadTTL, BodyTTL

VARIABLES now, epoch, dirty, denied, checkedAt, bodyAt,
          metadataProofAt, bodyProofAt, pending, served, publication

vars == <<now, epoch, dirty, denied, checkedAt, bodyAt,
          metadataProofAt, bodyProofAt, pending, served, publication>>

Init == /\ now = 0 /\ epoch = 0 /\ dirty = FALSE /\ denied = FALSE
        /\ checkedAt = 0 /\ bodyAt = 0
        /\ metadataProofAt = 0 /\ bodyProofAt = 0
        /\ pending = [kind |-> "none", epoch |-> 0, at |-> 0]
        /\ served = [present |-> FALSE, at |-> 0, dirty |-> FALSE, denied |-> FALSE,
                      metadataProofAt |-> 0, bodyProofAt |-> 0]
        /\ publication = [present |-> FALSE, startEpoch |-> 0, currentEpoch |-> 0]

StartMetadata ==
  /\ pending.kind = "none" /\ ~dirty /\ ~denied
  /\ pending' = [kind |-> "metadata", epoch |-> epoch, at |-> now]
  /\ UNCHANGED <<now, epoch, dirty, denied, checkedAt, bodyAt,
                  metadataProofAt, bodyProofAt, served, publication>>

StartFull ==
  /\ pending.kind = "none" /\ ~denied
  /\ pending' = [kind |-> "full", epoch |-> epoch, at |-> now]
  /\ UNCHANGED <<now, epoch, dirty, denied, checkedAt, bodyAt,
                  metadataProofAt, bodyProofAt, served, publication>>

MetadataUnchanged ==
  /\ pending.kind = "metadata"
  /\ LET accepted == ~denied /\
                    (pending.epoch = epoch \/ Mode = "ignore_epoch")
     IN /\ checkedAt' = IF accepted THEN pending.at ELSE checkedAt
        /\ metadataProofAt' = IF accepted THEN pending.at ELSE metadataProofAt
        /\ bodyAt' = IF accepted /\ Mode = "renew_body_on_metadata"
                     THEN pending.at ELSE bodyAt
        /\ dirty' = IF accepted THEN FALSE ELSE dirty
        /\ publication' = IF accepted
              THEN [present |-> TRUE, startEpoch |-> pending.epoch, currentEpoch |-> epoch]
              ELSE publication
  /\ pending' = [kind |-> "none", epoch |-> 0, at |-> 0]
  /\ UNCHANGED <<now, epoch, denied, bodyProofAt, served>>

FullVerified ==
  /\ pending.kind = "full"
  /\ LET accepted == ~denied /\ pending.epoch = epoch
     IN /\ checkedAt' = IF accepted THEN pending.at ELSE checkedAt
        /\ metadataProofAt' = IF accepted THEN pending.at ELSE metadataProofAt
        /\ bodyAt' = IF accepted THEN pending.at ELSE bodyAt
        /\ bodyProofAt' = IF accepted THEN pending.at ELSE bodyProofAt
        /\ dirty' = IF accepted THEN FALSE ELSE dirty
        /\ publication' = IF accepted
              THEN [present |-> TRUE, startEpoch |-> pending.epoch, currentEpoch |-> epoch]
              ELSE publication
  /\ pending' = [kind |-> "none", epoch |-> 0, at |-> 0]
  /\ UNCHANGED <<now, epoch, denied, served>>

ProbeUnknown ==
  /\ pending.kind # "none"
  /\ checkedAt' = IF Mode = "renew_on_unknown" THEN now ELSE checkedAt
  /\ pending' = [kind |-> "none", epoch |-> 0, at |-> 0]
  /\ UNCHANGED <<now, epoch, dirty, denied, bodyAt,
                  metadataProofAt, bodyProofAt, served, publication>>

ObserveChange ==
  /\ epoch < MaxEpoch
  /\ epoch' = epoch + 1 /\ dirty' = TRUE
  /\ UNCHANGED <<now, denied, checkedAt, bodyAt,
                  metadataProofAt, bodyProofAt, pending, served, publication>>

ObserveDenial ==
  /\ epoch < MaxEpoch /\ ~denied
  /\ epoch' = epoch + 1 /\ denied' = TRUE
  /\ UNCHANGED <<now, dirty, checkedAt, bodyAt,
                  metadataProofAt, bodyProofAt, pending, served, publication>>

Tick ==
  /\ now < MaxTime /\ now' = now + 1
  /\ UNCHANGED <<epoch, dirty, denied, checkedAt, bodyAt,
                  metadataProofAt, bodyProofAt, pending, served, publication>>

Consume ==
  /\ (~dirty \/ Mode = "ignore_dirty")
  /\ (~denied \/ Mode = "ignore_denial")
  /\ now < checkedAt + ReadTTL /\ now < bodyAt + BodyTTL
  /\ served' = [present |-> TRUE, at |-> now, dirty |-> dirty, denied |-> denied,
                metadataProofAt |-> metadataProofAt, bodyProofAt |-> bodyProofAt]
  /\ UNCHANGED <<now, epoch, dirty, denied, checkedAt, bodyAt,
                  metadataProofAt, bodyProofAt, pending, publication>>

Idle == UNCHANGED vars
Next == StartMetadata \/ StartFull \/ MetadataUnchanged \/ FullVerified
        \/ ProbeUnknown \/ ObserveChange \/ ObserveDenial \/ Tick \/ Consume \/ Idle

TypeOK ==
  /\ now \in 0..MaxTime /\ epoch \in 0..MaxEpoch
  /\ dirty \in BOOLEAN /\ denied \in BOOLEAN
  /\ checkedAt \in 0..MaxTime /\ bodyAt \in 0..MaxTime
  /\ metadataProofAt \in 0..MaxTime /\ bodyProofAt \in 0..MaxTime
  /\ pending \in
       [kind : {"none", "metadata", "full"}, epoch : 0..MaxEpoch, at : 0..MaxTime]
  /\ publication \in
       [present : BOOLEAN, startEpoch : 0..MaxEpoch, currentEpoch : 0..MaxEpoch]
  /\ served \in
       [present : BOOLEAN, at : 0..MaxTime, dirty : BOOLEAN, denied : BOOLEAN,
        metadataProofAt : 0..MaxTime, bodyProofAt : 0..MaxTime]

NoInventedMetadataProof == checkedAt = metadataProofAt
NoInventedBodyProof == bodyAt = bodyProofAt
NoOldResultPublication == ~publication.present \/
                         publication.startEpoch = publication.currentEpoch
NoKnownDirtyConsumption == ~served.present \/ ~served.dirty
NoKnownDeniedConsumption == ~served.present \/ ~served.denied
WithinMetadataBound == ~served.present \/ served.at < served.metadataProofAt + ReadTTL
WithinBodyBound == ~served.present \/ served.at < served.bodyProofAt + BodyTTL
NoFutureProof == checkedAt <= now /\ bodyAt <= now

=============================================================================

