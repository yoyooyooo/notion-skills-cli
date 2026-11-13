# Progressive maintenance: implementation and model correspondence

AH-1024 extends the existing authorship, audit and original-operation owners. The prior baseline is `6c38e747a9e40186fdf9d4ecda033eb5b413561c`. This review records actual boundaries; execution results belong to a frozen run, not to this text or a refreshed source hash.

## Audit scope

`readReachableAudit` observes the selected page before relation-filtered Files and Records headers. Its callback retains already observed identity failures when the invocation exhausts its budget. A target run never marks an unfiltered table complete. `auditReachableReady` requires the owned observations; `auditReport` checks initial and final coverage. A full-library run still scans all tables independently and can find lost relations.

`AuditScope` abstracts four kinds of owner facts, a target/library choice, a bounded budget and one resumption. Scope immutability, read-only capability and checkpoint monotonicity map to the original scheduler, transport and stored run. Concrete HTTP counts, pagination, dependencies and permissions require implementation tests. Installed target checks compare zero and 120 unrelated rows from an independent actual-HTTP ledger; a three-request pause preserves an already observed root error.

V3 checkpoints cannot resume historical rules. Growth is descriptive: tombstones retain owner and File ID; operation and object headers use different denominators; equal header hashes do not prove equal bodies; private pins remain unobserved. No diagnostic grants cleanup or repair authority.

## Complete intent and ordered effects

`shared-skill-apply-tree.ts` classifies explicit moves/removes/revivals and exact reference spans. Omitted files remain in the final tree. The v2 parent retains its verified baseline, child candidates, ordered stages and full target manifest. `loadSharedApplyReferenceTree` reconstructs actual bytes from baseline objects and child candidates. A hash string is never a file body.

`authenticateApplyParent` requires the retained parent, exact child and every preceding applied child outcome. `continueSharedSkillApply` preserves verified effects and stops on unknown results. Explicit `resumeSharedSkillApply` requires the original local parent journal, verified prefix and genuinely undispatched suffix; remote query absence cannot create missing dispatch authority. A different Store may inspect shared historical completion but cannot invent a missing local journal.

`MaintenanceApply` models three ordered children. Dispatch, provider application, received acknowledgement, verified retained outcome and parent progress are separate. The acknowledgement variable records historical response receipt, not a claim that every child family writes a separate ACK row. Native allocation uses the durable source dispatcher. Body writes publish an applied outcome only after the exact response, body and ownership event verify. Parent recovery relies on original outcomes, never current equality.

The current-snapshot barrier rejects pending trees. Existing pins retain selected bytes and still obey current permission checks. Delete records a tombstone and retains the page/body. Explicit undelete restores the same File ID and exact retained bytes; it is not source-follow restoration.

These finite models do not promise atomic Notion transactions, compare-and-swap, arbitrary plan length, eventual unknown resolution or every native subrequest interleaving. Actual bytes, source changes, reference parsing, lost responses, row growth and package installation need separate concrete evidence.

## Same-execution lifecycle event verification

The correspondence review at `dafa00d5d781dcc44071a0092001e01ae829dfb6`
compares the protected source with `d5159127d0ca927a5f3540b79423ec9b11bc98ea`.
The only changed protected implementation and test are the file-management event
verification and its HTTP regression in `ff5f17a3f3b523afb4ebbe26a13d35a763ca3891`.
The remaining protected source bytes match the earlier correspondence.

For a move, `executeSharedFileManagement` still requires the original Path PATCH
response and exact page, body and ownership postcondition before appending the
lifecycle event. `appendSharedRecord` returns only an exact verified immutable
fact, obtained from an existing record or the original successful POST response.
The same execution now combines that returned fact with the fresh complete
event query before resolving file state. This supplies positive evidence for
one already verified event when the query index omits it. It does not infer any
other event or mutation from query absence.

| Boundary | Implementation and model correspondence |
| --- | --- |
| Exact immutable event | The returned fact has passed the original owner, Record ID, kind, entity, canonical envelope and Hash checks. A fresh query containing the same event ID with another payload fails. `resolveFileState` still checks the joined graph for missing parents, foreign identities and incompatible heads. Exact Record payloads and this query union are outside the finite models. |
| Original child outcome | `saveOutcome` remains after the exact native postcondition, verified event and graph checks. `MaintenanceApply` still separates `RetainAck`, `VerifyOutcome` and `CheckpointChild`; its acknowledgement is historical response receipt, not a new durable per-request ACK row. No parent child is verified merely because its event is present. |
| Interrupted execution | The returned event fact is retained in this execution only. Interruption, a query failure or a graph conflict before the original outcome can leave the child pending; an unknown outcome POST also remains fenced. The model permits interruption after acknowledgement and reconciliation only with the original outcome. It does not model every event/outcome subrequest or prove crash recovery for this in-memory fact. |
| Independent recovery | `reconcileSharedFileManagement` still requires the original exact outcome; `resumeSharedSkillApply` refuses a started child without one. Current path/body equality or a subsequently visible event cannot manufacture that outcome. The separate `AcknowledgedRecordPrefix` exact-ACK GET and complete-census requirement are unchanged; this union grants no native recovery suffix authority. |

The actual HTTP regression hides the newly acknowledged event from the complete
query response and requires one Path PATCH, one event POST and one outcome POST.
Its second case returns a conflicting event with a valid recomputed Hash and
requires rejection with no outcome POST. Existing unknown-PATCH and
event-alone-without-outcome negatives remain required. These checks exercise
the concrete branch; they do not turn the lifecycle models, independent add
acceptance or restore feedback into a proof of all file-management subrequests.

No TLA transition, configuration, property, bound or view changes for this review.
The source bindings and explicit exclusions are updated; fresh complete suite
results belong to their own runner artifacts. Earlier failed operations retain
their original pending history, and no eventual-visibility or unconditional
completion claim is added.

## Native revival metadata and preview reconstruction

The follow-up source review is `2e5b3ac9e6fc16a35863657237257ea380e534b8`,
whose parent is `dafa00d5d781dcc44071a0092001e01ae829dfb6`. Tombstone
classification now carries the original retained mode into the revival and final
manifest. Known `100644` and `100755` values remain unchanged; a conflicting
submitted mode is rejected, while historical absence remains unknown even if
the caller submits a mode. No native mode update or default is inferred.

`loadSharedApplyReferenceTree` retains its strict original byte, hash, path and
mode comparison. Its existing v2 reconstruction now also runs before a dry-run
returns `planned`. In both preview and execution it precedes local parent
retention, the original parent Record and child dispatch. The original failed
revival therefore stopped before writes; this change does not create another
ACK/outcome recovery route or relax the final-tree check.

The subsequent `02cfbd2831e991d66d77ed95c41c2340c7523481` correction
forwards the supplied optional mode through the isolated one-file add route to
the existing file-management plan, as the complete-parent route already does.
This preserves new input metadata without changing retained historical plans or
adding mode-update authority. Three public `applySkill` regressions use actual
filesystem input: regular and executable directory entries retain their modes,
while a bare Markdown input remains unknown. The original one-pass/two-failure
run becomes three passes; these are controlled source tests, not installed or
live Notion results.

`MaintenanceApply` abstracts valid ordered children and their original outcomes,
not native modes, byte reconstruction or preview results. The changed constructor
and earlier preview validation remain concrete preflight obligations outside the
finite models. The new controlled regressions distinguish both known modes from
historical absence, reject a changed known mode and require unavailable baseline
bytes to fail before writes in both preview and execution. The original ten-case
run had three passes and seven assertion failures; the corrected ten cases and
the 38 affected source tests passed. Installation and live Notion require their
separate results.

The completed 40-case lifecycle and 34-case operation-recovery runs at `dafa00d`
predate this correction and include the original mode omission. They establish
their declared finite contracts, not mode preservation. Their original inputs
and results retain that source identity. The final source bindings include this
reviewed follow-up; no model, configuration, property, bound or view changed, and
those earlier runs are not relabeled as a new run of either follow-up commit.

## Original-page repair

Historical-main repair and managed-file adoption freeze one exact owner, native page, complete body, editable-property preimage, relationship and original-operation frontier. `sharedCreateDispatch` permits only the nominated blank-identity PATCH; ordinary creation does not acquire a general metadata-edit capability. Original body, plan and outcome are retained separately. Credential-scoped SQLite locators and POST markers are barriers, not a second remote authority.

Completion readers validate the full original plan, expected outcome and retained body. A matching current File ID, outcome header or another credential's ACK cannot manufacture completion. `assertSharedRepairPending` checks this exact owner before current consumption. Unknown requests are preserved rather than replaced. Ordinary child-page placement explicitly remains unsupported when its original page cannot safely become a managed database row.

Existing acknowledgement and creation models retain their bounds. Repair's metadata parsing and new entry authorization are unmodeled concrete guards; source tests and actual owned Notion readback prove those boundaries separately.

## Commands and host

Canonical `ctl audit/file/resource` spellings share their handlers with retained historical spellings. `ctl operation` delegates each exact original family. Show is not completion; reconcile is read-only; only explicit original apply resume has its narrow suffix authority. The Pi fixture validates that a proposed next.argv is the same owner's read-only original reconcile before it executes it.

Mock supplies model decisions only. Actual CLI, SDK, Pi tools, serializer, source writes and session recording run normally. The independent oracle checks native calls, exact source bodies, whole generated directory objects, each operation's effects and actual HTTP. Repeated paths in author commands or audit reports are not duplicate directories. Duplicate native call IDs remain visible to the verifier.

Independent installation, real Notion, real Pi with a loopback model and real-model usability are separate evidence scopes. A successful one does not stand in for another. No result authorizes a global installation change, production inventory repair, main merge or publication.

The installed consumer resolves the selected Node launcher's actual `process.execPath` before changing HOME. The same concrete runtime drives CLI commands and the Pi source adapter. The launcher regression exercises a real child process whose launcher only works in its original home, then verifies the resolved Node in an isolated home. It does not inherit version-manager configuration or relax the installed Pi acceptance conditions. The original Volta launch failure remains a failed run.

## Independent review corrections after `9e4cefb`

The cold review reproduced two bugs on the frozen product, without mutating its
guards. Original failure artifacts remain alongside the corrected runs.

The same-model [maintenance atlas](statecharts/2026-11-13-maintenance/README.md)
shows scope and parent/child recovery without introducing a second state model.
Its presentation-only child-label aggregation is checked against all six original
configurations; model states, rules and broken-rule sets remain unchanged.

**Repair query visibility.** An applied identity PATCH with a lost outcome stayed
blocked while the original plan was query-visible, but a temporary query omission
let the same Store consume and add observation Records. The corrected gate joins
the credential-scoped locator and original pre-POST marker with remote headers.
Only an exact complete original shared proof releases that barrier. Another owner
does not inherit it. An empty local repair inventory does not add an identity
request to ordinary audit or consumer paths. The local marker does not create ACK
authority or repair knowledge for a fresh Store.

**Permission evidence at a budget boundary.** A Files denial was held in a local
variable until Records completed, so the next exhausted request erased the known
denial from the paused report. Each observed group now reaches the in-memory run
before the next request, and the audit transport durably retains the confirmed
reachable failure. This applies to the initial and final observations. Resume
replays the original task's denial; later final observations may improve current
coverage without rewriting its historical evidence. Report-only next actions do
not expand a healthy target into a full census.

These changes restore the existing promises; they do not add a model variable for
real query visibility or each permission error. `AuditScope` still proves only its
declared finite facts and progress contract. Repair metadata, local marker lookup
and exact HTTP response retention remain concrete implementation checks. The
independent review reproducers are rerun by changing only their checkout path;
their assertions and old failures stay intact. Model source hashes are updated
only after this correspondence review and the affected real-code checks.
