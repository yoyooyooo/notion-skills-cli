# Current Skill metadata consumption

SC11 / AH-628 reuses one complete Skills metadata observation within a scalar
current read. Public CLI and SDK results keep their existing shape. The
[selected-snapshot contract](selected-snapshot-consumption.md) continues to own
source bytes, current-tree validation and fixed-file selection.

## One observation within the read

A logical Skill selector needs a fresh directory observation before opening its
current page. Native links in the resulting Markdown tree may need the same
directory to resolve external Skill identities. The scalar path carries the
first observation through to that compilation instead of querying it again.

The observation contains all rows from the authorized Skills data source,
including disabled rows. The ordinary catalog still exposes enabled records and
its existing failure coverage. Its records cannot substitute for the complete
observation: doing so would lose disabled targets and identity-conflict evidence.

The query uses the registered property IDs for exactly these six properties:

| Property | Purpose |
| --- | --- |
| Name | Display and invocation identity |
| Description | Directory and reference metadata |
| Kind | Skill, Router and Prompt classification |
| Skill ID | Stable logical identity and conflict checks |
| Enabled | Availability without activating or reading a target |
| Default Context | Existing metadata semantics |

Every page uses `page_size: 100`; `has_more` and a valid advancing cursor determine
completion. Short or empty intermediate pages do not terminate the observation.
The list envelope, incomplete query status, missing/repeated cursors, non-null
terminal cursor and the existing native inventory cursor bound are checked before
the result can be carried to another consumer. Record decoding, parent scope,
physical-page duplicates and logical identity conflicts remain caller-owned.

## Scope and freshness

The internal `freshCatalogForRead` creates a new observation map inside each Effect
execution and forces online catalog refresh. Each observation retains the
authenticated scope and a copy of the complete library descriptor. The consumer
checks that scope, descriptor, data-source identity and completeness before using
the observation. No global cache, TTL extension or additional persisted receipt is
introduced. Raw inventory rows do not enter public catalog results, the catalog
cache, CLI JSON or the SDK protocol.

Native-reference compilation and Members/Requires target metadata resolution use
this handoff. The selected current page still supplies each actual relation, with
its existing complete relation pagination and validation. Graph preparation keeps
its complete graph inventory and metadata batching. Reusing a six-property
observation does not authorize a consumer that requires additional fields.

## Current page and identity

The selected current page is still fetched independently. Directory rows cannot
supply its Source, Files, ownership or full relation state. Source planning and the
complete current-tree checks therefore keep their existing inputs and barriers.

A logical selector's stable Skill ID must still match that current page; identity
drift fails before source acquisition or body observation. A physical page-ID read
continues to select that page's current identity. Name and Description changes are
allowed, and the current selected record owns self-reference metadata. Its logical
identity claim remains present even if an external inventory omits the current
page, so another page cannot silently claim the selected Skill's identity.

An external target remains available, disabled or unavailable according to the
complete metadata observation. Resolution never fetches the target's body. A later
refresh obtains another observation rather than retaining the previous invocation's
directory. This is an observation within one call, not a remote snapshot transaction.

## Verification and remaining costs

The [CLI verification recipe](https://github.com/yoyooyooo/notion-skills-cli/blob/main/.cursor/skills/verify-ntn-skills/features/skill-consumption.md)
connects public-read regression, independently installed SDK/CLI consumption and
the existing live-source cost driver. Controlled fixtures record exact property
IDs, cursors, row counts and decoded JSON bytes. Live request metrics remain a
separate measurement; controlled counts do not establish live latency.

The change removes repeated directory acquisition in the affected scalar path.
It does not remove the first complete directory observation, change graph field
projections, implement selected-ID metadata batching, or eliminate first-current
body observation and retained-source costs. SC11's wider projection and batching
matrix remains independently tracked.

### Relation metadata reuse within one scalar read

The SC14 audit of existing C7 Pro and Mini public-command traces found three
complete six-property inventory passes inside each current logical `read`: one
for the selector, then one each for Members and Requires targets. Both original
receipts reported two duplicate requests. The two later passes contained six HTTP
attempts and 1,431,764 decoded response bytes in each machine's trace. These are
the observed duplicate work and the candidate reduction, not a new measured
latency or whole-task saving.

`openSharedSnapshot` now passes its already validated `skillsInventory` to the two
relation readers when no graph inventory exists. Both readers retain their
selected-target identity, kind, availability and complete-relation checks. The
current selected-page permission check still runs; a missing or incomplete
relation fails. A later refresh creates a new observation, and fixed snapshots
keep their original relation metadata. Records headers, missing-Payload reads,
pending-operation checks and source-body acquisition are unchanged.

The original metadata consumption tests compare the complete public result and
frozen snapshot against the physical-page read path, including a 101-row paged
inventory. They also cover fresh relation metadata, an unchanged old pin, revoked
selected-page access, missing targets and incomplete current relations. The
original red cases and actual four ledgers are preserved under
`/Users/yoyo/Library/Logs/pi-context-broker/AH-617-20261105/sc14-fact-read-audit-346gjnf6`.
Installed and live-source measurements remain separate evidence layers in
[AH-631](https://linear.app/yoyooyooo/issue/AH-631).

## Single-current inspect experiment was not adopted

The 2026-11-05 AH-628 candidate used a complete six-property identity inventory
and one full selected-page GET for a single current `inspect` root. It preserved
the existing `use`, multiple-root, and fixed-resource paths. Controlled tests and
independently installed SDK and CLI runs verified the complete body, files,
identity, permissions, pagination, and cancellation boundaries.

The frozen live comparison used C6 and the candidate in three ordered pairs, each
with an empty owned state. Every sample used the same authorized production root
and one public `ctl prepare --purpose inspect` call. The original body, all 46
files, scope, version, pin, and relation directories matched in all six samples.

| Pair and order | C6 elapsed / root-ready ms | Candidate elapsed / root-ready ms | Candidate minus C6 ms |
| --- | ---: | ---: | ---: |
| 1, C6 then candidate | 9875.752 / 9572 | 9007.326 / 8626 | -868.425 / -946 |
| 2, candidate then C6 | 8302.505 / 7993 | 8683.400 / 8384 | +380.895 / +391 |
| 3, C6 then candidate | 8588.354 / 8280 | 10698.151 / 10401 | +2109.797 / +2121 |

Each candidate call added one selected-page metadata GET, for 16 HTTP attempts
instead of 15. Total decoded response bytes fell from 1,971,679 to between
1,182,292 and 1,182,316. All four body attempts and their 395,627 response bytes
stayed equal. The complete ledger observed no writes or provider calls in this
window. That observation does not remove normal retention or adoption behavior.

The frozen adoption gate required both complete-call and root-ready medians to
avoid regression. Complete-call medians were 8588.354 ms for C6 and 9007.326 ms for
the candidate. Root-ready medians were 8280 ms and 8626 ms. The medians of the
paired differences were +380.895 ms and +391 ms. Functional acceptance passed;
the adoption gate failed. The prototype runtime changes and their added smoke
test assertions were withdrawn. Graph preparation retains its complete inventory.
The scalar-read reuse described above remains unchanged.

The controlled N=1 case also increased total response bytes by 864. The live
window covers one root and one library, with three pairs. It does not establish
p95 latency, compressed wire bytes, or complete Agent task costs. No replacement
samples, scale thresholds, or adaptive cache rules were added.

[AH-628](https://linear.app/yoyooyooo/issue/AH-628) tracks the remaining work. The
original packages, patches, red cases, six receipts, offline source attribution,
and Evidence → Cleanup → Evidence records remain under
`/Users/yoyo/Library/Logs/pi-context-broker/AH-617-20261105/sc11-single-inspect-iyw1oxit`.
`live-pair-plan/real-pair-result.json` has SHA-256
`515544b7210df7847f77bbaf05454f50309af5c5936b651dbc435a26008d7700`.
A future proposal needs a concrete mechanism that changes the measured tradeoff,
such as avoiding the extra selected-page request while preserving authority, or
an explicitly revised task-cost budget. It must freeze a new comparison and
retain this result.
