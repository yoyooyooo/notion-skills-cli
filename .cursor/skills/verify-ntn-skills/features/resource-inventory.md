# Exact resource inventories: AH-711 / AH-716

## Public contract

`ctl library inventory remote --audit-run ID` derives an upstream-baseline review
plan from one exact retained formal audit. The plan freezes library, physical and
business identities, selected immutable source, Source definition/member, ownership,
content digests, native metadata/relations and retained recovery references. A
missing or partial proof is an explicit review/block reason. Exact content equality
does not release custom ownership or authorize an upload. This command does not
apply a baseline or delete any object.

`ctl library inventory local --root PATH --allow-target PATH` scans only explicit
roots and explicitly permitted real symlink targets. A complete tree includes main,
references, scripts, JSON, binaries and executable modes. Logical host aliases and
real entities are separate. Same real entity can share aliases; equal names or byte
hashes cannot establish shared ownership. Broken/outside links, unreadable files,
changed-during-read files, dirty tracked state, sensitive configuration, external
references and budget limits stay visible. No local tree modification or script
execution is permitted. Local inventory writes only a derived immutable local
Store artifact and its optional report.

`reconcile` joins frozen remote/local inventories using explicit stable identity or
validated source provenance. Name/hash matches are review candidates only. Review
identities bind both manifests, discovery rules and scope; drift produces a new
identity and invalidates old approval. No mutation command is implied by inventory.

Agent Kit identities use exact `.ak/assets.yaml` mode roots plus registry keys.
`into` is already part of an install key; installed display names never supply a
path. A mutable `baseRef` is not a fixed commit. View codec/configuration matches
are origin candidates only: copied views remain separate physical entities even
when all bytes and modes match. Cross-root canonical-name collisions remain blocked.
Unknown remote executable modes are reported as `bytes_equal_mode_unestablished`,
never silently converted to 100644. Native immutable mode metadata and raw-resource
or selected-source modes use their respective existing ownership facts.

Complete current native bytes/ownership/mode can be compared without inventing an
upstream Source; missing Source still blocks an automatic upstream-baseline action.
A target-only audit cannot make other uninspected census members complete. Those
members remain in the remote inventory denominator with explicit partial coverage.

New remote reports always include `visible_registered_census`, independently of
content coverage. It proves only the registered rows visible under the recorded
endpoint and permission scope: all required tables must finish both independent
censuses, all registered metadata and relations must be observed, and their
semantic digests must agree. Missing pages, fields, endpoint proof or final
pagination cannot produce a full census. Unknown modes or incomplete content in
unrelated resources remain in the original findings and denominator. Older reports
remain readable, but absence of this fact cannot authorize a new import.

Declared provenance paths resolve only through directory aliases observed within
the authorized scan. Reports retain the declared path and exact evidence file.
Revalidation freezes each alias target; swapping a logical entrance invalidates
the observation. An unresolved explicit identity stays blocked instead of silently
becoming an unbound native resource.

## Minimal falsifiable evidence

| Scope | Required cases |
| --- | --- |
| Remote | Full pagination audit retained; exact source and no-diff; custom even with equal bytes; missing origin; ambiguous/unsupported source; pending operation; partial audit never automatic; unchanged inputs stable plan ID; metadata/ownership/content drift changes ID |
| Local | Two aliases to one real entity; duplicate names with different identities; broken and escaping links; approved external target; binary/CRLF/mode; file changing during scan; dirty Git; credentials only flagged without secret values; entry/byte/time limit yields partial |
| Reconciliation | Exact library/Source/member/commit and Skill/File mapping; same name/hash cannot claim ownership; local custom remains retained; scope/manifest drift rejects review; zero Notion writes and zero local source writes |
| Visible census | Target content complete with unrelated missing mode stays globally partial but may have a full metadata census; changed census, unfinished final pages, missing registered properties and absent endpoint proof cannot establish it |
| Installed/live | Independently installed CLI, fresh state, exact frozen Pro roots and allowed targets; raw manifest comparison; actual counts and exceptions; production Notion reads only after formal audit; no import, relinking or deletion |

The approved actual Pro scope is supplied to the command, never a hard-coded
default or a recursive home-directory scan. Controlled fixture, real raw inventory,
installed package, product mutation and human UI evidence remain separate.

## Exercised real scope

`nr31-inventory-63c2b4b0/scope-v3.json` freezes the canonical Pro Agent Kit skills
root, four logical global entrances, the canonical and `.ak/state/views` target
boundaries, and four exact provenance/config files. Public source CLI receipt
`pro-local-v5-report.json` retained 443 physical entities, including 378 under
configured mode roots. It read 4,955 file entries with zero Notion/source writes.
The physical entity and content manifests matched the preceding observation;
adding exact configuration established provenance candidates without merging owners.
The 47 entities with declared identity evidence retain 51 declaration records.
The 278 unmatched declarations comprise 267 valid handoffs, seven install records
and four upstream records; the input handoff registry had 268 entries, one invalid.
The 38 view copies include 34 exact byte/mode matches, three differences and one
unestablished origin. Two package-bound targets, two broken links and sensitive or
unverified inputs keep the global observation partial. No package target was expanded
and no path was relinked, imported or deleted. This source-CLI receipt does not
replace independent installed-package acceptance or authorize production upload.
