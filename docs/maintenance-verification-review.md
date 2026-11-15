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

## NXT native reference binding and source task continuation

AH-1052–1055 extends the original owners from baseline `4580b7d6d692013091d5c66e90d703d51fd5fb10`. The historical `e34b446` change was reviewed: final-path link projections and unchanged-body evidence added no dispatch, while reviewed partial settlement was already represented by the existing model. The NXT changes below alter modeled boundaries. Before changing the models, both selected runners stopped on the protected-source hash mismatch. Those failed artifacts are retained; they are not model passes.

| Concrete boundary | Model change and scope |
| --- | --- |
| `shared-skill-apply-authoring` freezes logical body templates together with the complete final tree. `bindSharedApplyBody` derives a native body only from exact allocation identities; a capacity-only projection checks fixed-width UUID destination limits before any allocation. | `MaintenanceApply` still has three children, now two reference allocations and one body. Raw Markdown, modes, codec capacity and UUID strings remain concrete tests. No placeholder identity is persisted, returned or dispatched. |
| `executeSharedApplyBodyBinding` retains the original local binding intent and immutable binding record. Allocation plan/outcome/page ID are checked again when loading it. Its underlying original body request and outcome are separate. | New binding intent, dispatch, service application, durable ACK, exact verification and interruption states precede child three. `NativeBodyNeedsOriginalAllocationBinding` requires both original allocation outcomes and verified binding before body dispatch. Existing skip-prefix and replay-unknown negatives cover bypass and replay. |
| `resumeSharedSkillApply` checks every later child for original facts before continuing a pending binding. A binding with an existing body request only reconciles that original request. | Original prefix, unknown non-replay and whole-tree publication invariants remain. The model does not enumerate every Record subrequest or prove cross-machine absence. The public navigation test proves two original allocation ACKs yield only the unissued main body, with the exact same parent. |
| `guardedSourceMutation` records only `NOTION_REQUEST_FAILED` + `definitive_rejection` + HTTP400 + `validation_error` as not applied, bound to the original request hash. Saving that rejection is a separate fallible step. | `RestoreFeedback` now has up to two immutable feedback generations. `UnknownFeedbackNeverRedispatched` counts each generation; `NewFeedbackGenerationNeedsRejection` requires the retained negative receipt before the second. Receipt loss leaves unknown. The original body and request identity remain fixed. |
| `runSourceUpdate` / `resumeSourceUpdateRun` freeze selected version, per-following-file body/frontier/identity and submitted request ID. A failed checkpoint preserves the latest original body IDs. Completion checks the full final tree and each feedback result. | Task inventory, Source selection, fixed resource retrieval, checkpoint storage and result projection remain implementation obligations outside the finite restore model. Source fixtures cover A→B, custom preservation, body unknown, feedback-only continuation and interrupted checkpoint recovery. A selected version alone cannot complete a display task. |

The prior feedback rule used a single total-attempt count because no later feedback generation existed. Its new wording preserves at-most-once dispatch for each immutable request and admits only a separately authorized generation after a proven rejection. This is an intentional capability change, demonstrated by the exact-rejection and same-run feedback tests. Unknown 429/408/gateway/unrecognized/unclassified responses remain barriers; they are not retryable by this business protocol.

The existing inventory contains 35 configurations: AcknowledgedRecordPrefix 10, IndependentAcceptance 8, RestoreFeedback 10, MaintenanceApply 7. Earlier current-scope prose said 34 because it had not counted the later unreviewed-partial case. This change adds properties and states to those configurations, with the new exact expected-broken sets; it adds no configuration family or replacement guardian.

The isolated mutation harness now has six groups. The two added mutations remove original allocation-page verification and falsely classify uncertain source failures as definitive rejection. Baseline, real assertion failure, exact byte/mode restoration and restored pass are required. A syntax or type error is not a counterexample. Local model slices, the final full suite, installed commands and actual Notion/Pi results retain their own artifact identities.

The integration owner's bounded mismatch diagnostics and local full raw readback retention do not change comparators, dispatch, ACK or acceptance. The cache lane's freshness policy and explicit unresolved-binding barrier likewise provide no recovery authority. Their encoding and cost remain outside these finite models. Current exact source hashes bind the reviewed worktree; the integration owner records the final product commit after serialized submission.

### NXT verification run, 2026-11-15

The reviewed worktree at base `4580b7d6d692013091d5c66e90d703d51fd5fb10` passed the complete operation-recovery suite: 35 configurations and 376 property results, with all expected rule inventories and exact broken-rule sets matched. Every search completed without a cut. The runner verified all 39 covered source/test hashes and all 31 locked tool files; it used the locked TLC 1.7.4 jar. The coverage digest was `d0d0b8b61087f0590446d50543cccd1dcd7f97cfb2d40423d7ececb916e4e307`. The historical `source_commit` field remains the prior correspondence anchor; this run's exact reviewed inputs are its source hashes, not a claim that the uncommitted work was already published.

Artifacts, including both initial hash-mismatch failures and the subsequent model slices, are retained under `/Users/yoyo/Documents/code/personal/verification-evidence/nxt-20261115-jTFsQ9/evidence/nxt-operation-recovery/`. Original `/tmp` run directories also remain. The complete run is `nxt-operation-recovery-full-20261115-a/summary.json`, SHA-256 `54ebda8efd7f5454fe42f133d72d9deb96d60bb34c8f3e86bdb81f2db4aec0cf`.

The six real guard mutations ran in a separate linked worktree, `notion-skills-cli-d4c30c64`, with its own frozen-lockfile Bun dependencies. The product worktree `notion-skills-cli-62b72949` was protected. Each baseline and restored run passed; each mutant failed a real assertion. The exact per-group test counts were 1, 1, 2, 1, 1 and 5. Both `complete_source_and_modes_restored` and `protected_source_unchanged` were true. The mutation result is `nxt-operation-recovery-mutations-20261115-a/summary.json`, SHA-256 `4560e990150bfa89e272c7296257072b609d8eb67a22800aafb87b9507a5cd61`.

Actual entry commands were:

~~~sh
env -u NTN_SKILLS_DEV_ROOT node scripts/verify-resource-lifecycle.mjs --suite operation-recovery --statechart "$PSTACK_STATECHART_ROOT" --jar "$TLA2TOOLS" --out /tmp/nxt-operation-recovery-full-20261115-a
env -u NTN_SKILLS_DEV_ROOT python3 scripts/check-operation-recovery-mutations.py --protected-worktree /Users/yoyo/.devspace/worktrees/notion-skills-cli-62b72949 --out /tmp/nxt-operation-recovery-mutations-20261115-a
bun run typecheck
bun test packages/core/test/shared-skill-apply.test.ts packages/core/test/shared-skill-apply-tree.test.ts packages/core/test/shared-maintenance-operations.test.ts packages/core/test/shared-source-run.test.ts packages/core/test/shared-source-refresh.test.ts packages/core/test/shared-source-definitions.test.ts packages/core/test/shared-file-request.test.ts packages/core/test/shared-file-restore.test.ts --timeout 60000
env -u NTN_SKILLS_DEV_ROOT bun test packages/cli/test/library-source-definitions.test.ts --timeout 60000
~~~

TypeScript checking exited 0. The eight-file Core run passed 158 tests with 1,073 assertions. The Node CLI offline-contract run passed eight tests with 161 assertions, including explicit following updates and original run continuation. Its fixture removes the inherited development launcher override. These are finite-model, source-regression, real mutation and offline CLI results. Actual Notion A→B updates, native custom preservation, visible file-request feedback and Pi consumption require their separate same-library evidence; none is inferred from these counts.

### Public apply result follow-up

The real maintenance run exposed an output-only gap: `mutation.ts::sharedApplyResult` repackaged the verified shared result without the common completion fields. The Core boundary now returns `complete` only after its existing full current-tree verification, `no_op` for an identical complete tree, and `needs_decision` for a preflight-only preview. It reports the corresponding effects and a read-only command for the exact retained ref; a successful operation is never offered resume. Dispatch, ordering and verification are unchanged. Four focused public-function cases passed 63 assertions, including no writes on repeated identical input, and the subsequent typecheck exited 0. The first added assertion referenced a nonexistent fixture property; it was corrected to the fixture's canonical library descriptor before these passing runs.

The mapping now includes the public result owner, for 40 protected source/test files. The full 35 configurations and 376 property results, followed by all six isolated guard mutations, passed again against coverage digest `f738fa59c2b3c349cb8f526f8f49371cf6cf0e652a7ee2b21a5f349ddd74f563`. No model transition or expected violation changed for this projection. Both new artifact directories sit beside the previous runs, which retain their original identities:

| Final projection artifact | Summary SHA-256 | Result |
| --- | --- | --- |
| `nxt-operation-recovery-full-20261115-public-projection` | `490b0df42181dae21efb1d6414014b74a23295792a8355365e074af4dd3cb035` | 35 complete configurations, exact inventories and violations, 40 source hashes |
| `nxt-operation-recovery-mutations-20261115-public-projection` | `b44d08345ce7486ba634a648a1b4a039e596186acae7347fb31fb69f434ed350` | Six real assertion failures; baseline/restored counts 1, 1, 2, 1, 1, 5; all source bytes/modes restored; protected product unchanged |

### NXT owned live Source evidence

The live NXT Source evidence uses the owned library entry `4195636c-236e-8104-aafa-f7366fe421ce` under the same retained run root. Fixed Git revisions are A `d6e546efe17c9ba48291a67356c4be6f7a7883a8` and B `657919af19c22951796b326af44032a63dec24f2`; both members use explicit retained storage. Source content was read and retained as data, never executed. The first admission continued the same original `skill-create-ad0059877fc1719a2450c3d16eeead073383fe031a5d7ec0de21f515493d1a56` after the local SQLite address fix. Its prior failure remains. The second admission and the complete Source update use the independently installed final-02 CLI, SHA-256 `3f4fb23cf2c6b4359257f5193d897c1ec2ec42e89f96bbcc38594c1803294528`.

`evidence/nxt-custom-sticky-proof.json` independently records following → custom → custom after a byte-exact native restoration of A. The original and restored raw-v2 SHA-256 is `4147e8fdc55667b968e3b94f67cdb7ae38cdd5872715cc99a5909f446134ae11`. This native equality does not mean the source-following and native-custom consumer serializations are byte-identical: the captured first difference is source Markdown bold versus Notion's `<b>` representation. Both are retained separately. The source Native probe is an explicitly labeled authoring simulation against owned Notion pages, executed by actual Node; the earlier unsupported Bun launch failed before any remote write and remains in the artifacts.

`evidence/nxt-source-b-proof.json` binds the successful task `source-run-c44dc695-ee6c-4dab-9581-320c15d5b32e` to its frozen two-member plan, exact body operation, complete independent raw readbacks and current ownership observations. The changed following member performed one attributed body PATCH; the custom member received no page PATCH and remained custom. Both full trees verified and Source feedback was acknowledged. The second provider member has identical content at A and B, so its retained bundle ID correctly remains unchanged; the proof does not claim its upstream bytes changed. Both original A pins were then read byte-for-byte unchanged with zero HTTP requests. The task's returned `run-status` action also executed entirely offline with zero HTTP requests. The full operation used 178 measured HTTP attempts and one separately measured Git acquisition; Git wire bytes remain unknown.

### NXT original file request and visible feedback

After the B task preserved the custom member, a new owned native edit replaced that member's body with a 166-byte request note. The public request-schema preview sent no writes; its explicit application registered the ordinary request, result and receipt columns. The public request preview also sent no writes. Submission froze the complete note, original custom frontier, exact file identity and fixed B Source definition as `file-request-9c7936fd6779629452167c84028efb67dba8dada44c394c6ad7e2649bc6743e7`.

The single task `source-run-f18974dc-5fc4-42ee-84d8-7fc6e73efe4b` completed with the exact submitted request. Its earlier Source-display phase preserved custom ownership; only the submitted request authorized the later restore. The request result was `verified_applied`, both member selections were unchanged, and Source feedback verified. Independent public request inspection, complete raw-v2 GET and state observation confirmed the original file and page, the 3972-byte selected body, following ownership and the retained user-owned `restore-follow` intent. These observations sent no remote writes.

`evidence/nxt-file-request-proof.json` binds the frozen request and run to the full original restore operation. It also records the original 166-byte custom body retained by the `following_restored` event. Generic operation show reported only original intent and did not claim completion. Executing its returned read-only reconcile action then verified that exact original operation with zero writes. No current-body equality was promoted into an original acknowledgement.

The task made 224 measured HTTP attempts and seven Notion writes. Five writes belonged to the original restore protocol, including its retained facts and native metadata; two later writes recorded file feedback and Source feedback. The nested feedback helper's `body_writes: 0` describes that metadata-feedback step, not the complete task. The proof retains the full trace and separates this field from the actual restore. One Git acquisition also occurred; its wire bytes remain unknown. The real run used ordinary successful feedback. Feedback-only repair after a definite rejection remains covered by focused regression and guard mutations, not by a claimed real Notion failure.

### NXT independent historical export and version refusal

The final installed CLI restored the explicitly shared old graph into the independent `old-pin-independent` config/state/cache/data roots. A public `export` of that pinned snapshot with `--projection snapshot --offline` then made zero HTTP requests. `evidence/nxt-old-pin-independent-proof.json` verifies all six exported file hashes, lengths and logical modes. Main is 5536 bytes; the script is 52 bytes with mode `100755`; the binary is nine bytes. The old alpha path remains, and the two new reference paths are absent. No author Store was copied and no script was executed. The established directory exporter uses private filesystem permissions `0600` and executable `0700`; the report preserves that distinction from logical `100644` and `100755` source modes.

Two later apply attempts returned `WRITE_CONFLICT` with 22 requests and zero writes each. The first used the pre-maintenance six-file pin. The second used the successful eight-file apply pin, whose acquisition library descriptor predated request-schema installation. `evidence/nxt-single-apply-version-diagnostic.json` records the six added Skills/Files property IDs and verifies that all eight file hashes, lengths, modes, native references, relations and ownership frontiers stayed the same. One independently observed ownership set reconstructs both exact version digests. Changing only the acquisition library descriptor reconstructs the earlier digest, because the existing snapshot identity includes that descriptor. This was a schema-bound stale write baseline, not a Profile or body change. Both refused commands remain original evidence; a fresh public read supplies a separate current intent rather than changing either old pin.

The full-unit failure in `shared-resource-state.test.ts` had the same kind of inconsistent fixture preimage. Its candidate reused an upstream archive and changed the selected C1 pin while retaining the other fixture's display baseline. The test now freezes the actual following main file's identity, body hash and frontier and preserves the custom reference. No product guard changed. `evidence/nxt-gates/unit-resource-state-before.*` retains the original failure; the focused whole-file run in `unit-resource-state-after.*` passed eight tests and 54 assertions. The file format check passed without changes. This test file is outside the formal coverage inventories.

### NXT Source correspondence in the lifecycle suite

The Source/Following/Request review keeps the existing lifecycle transitions and property inventories. It does not reuse the operation-recovery run as a lifecycle result. `ProjectionRace` still describes refusal of automatic read-check-unconditional-replace: ordinary `runSourceUpdate` retains every `automaticSourceStops` result. Only an explicit `updateFollowing` decision removes `BODY_REPLACEMENT_UNSAFE`; `INITIAL_PROJECTION_REQUIRED` remains a stop. The new orchestration then calls the existing complete-old-body-match restore protocol. That explicit writer is already outside `ProjectionRace`, as are page CAS and edits after a separate observation. Giving that path the model's rejected `UnsafeOverwrite` switch would misrepresent the implementation.

`UpdateCommit` still abstracts one already-authorized selection. `applySourceRefresh` retains every fixed resource, source descriptor and provenance fact, rechecks the Source definition and complete current target, saves the original selection plan, and delegates to `applySharedSourceSelection`. Selection continues to use `executeSharedMetadataWriteWithJournal`; its complete-source `beforeDispatch` check, original outcome and unknown barrier are unchanged. The two `guardedSourceMutation(...repeat: "never")` calls inside refresh instead own Records Origin links and Source status. They are not the selection ledger. A new rejection receipt in the Source mutation owner therefore does not create a second selection dispatch. Complete selection, stable existing pins and no invented original outcome remain the same modeled claims.

`display_baseline` freezes the original selected version, native file identity, body hash and event frontier. `updateSourceDisplay` checks this authority through `expectedFollowing`, retains each actual restore ID before body dispatch, and uses reconciliation for an existing ID. Its later complete-tree read is forced and read-only. The task checkpoints, per-file custom/unchanged/display results, same-run request scope and final result projection are orchestration outside the lifecycle finite domains. The narrower original-request and per-generation feedback boundaries are reviewed in `RestoreFeedback`; that model does not expand `UpdateCommit` or prove the entire Source task.

Custom ownership continues to come from the event frontier, including after native bytes are restored to their original value. No byte equality releases customization. `ProjectionRace` has no separate human-revert step, so the actual same-byte sticky-custom run is concrete Notion evidence, not a newly enumerated lifecycle behavior. File-request submission still freezes body/frontier/identity/Source; the native dropdown alone supplies no overwrite authority. Allowing the Source runner to reconcile the exact recorded request does not create a fresh submission or replace a pending original. Only a durable, exact HTTP 400 `validation_error` rejection may permit a separately identified feedback generation; uncertain errors remain barriers. The immutable selection journal and every `repeat: "never"` mutation keep their original single-dispatch rule.

### NXT complete lifecycle correspondence run

The lifecycle review covered 22 changed protected inputs and 16 newly relevant concrete boundaries. The seven existing models and all 40 configurations retain their original transitions, views, property inventories and expected broken-rule sets. Complete old-body replacement remains outside the automatic projection race; maintenance allocation bindings and feedback generations belong to operation recovery; detached immutable producers belong to request-engine. Freshness, capacity, diagnostic retention and growth metadata are concrete implementation boundaries, not newly enumerated lifecycle properties.

`evidence/nxt-lifecycle-final/summary.json` completed all 40 configurations against 119 exact source/test hashes. Its SHA-256 is `30c9a0050fbed3106d077fade33b4dcbc44ba76f5e6241b6e789545e7693e7cd`; coverage SHA-256 is `7238af886862eb0dc80ac1e6c17a1656bc051806a4cb30194bf03684dbffc6df`. The original failed source-correspondence check remains in `evidence/nxt-lifecycle-before`; it did not run TLC or produce a passing model result.

The four existing real guard mutations (`editable-overwrite`, `custom-takeover`, `audit-readonly`, `readonly-capability`) ran in a separate worktree. Each baseline and restored case passed; each mutation failed its designated business assertion. All protected main-worktree files remained unchanged and all isolated inputs were restored byte-for-byte. `evidence/nxt-lifecycle-mutations/summary.json` has SHA-256 `833a6abb5ae1c3039484ad51daed0434783ee471d51c663fde9bc350daa84c6d`; `evidence/nxt-lifecycle-protected.json` records the exact protected input set. These results establish the existing finite claims and their concrete guards; they do not establish page CAS, all possible native human edits, or the complete same-library acceptance journey by themselves.

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

## 真实集合维护：源码对应补充

2026-11 的真实目录上传、整组移除和 Source 归并复用了已有 complete-resource create、原 ACK dispatcher、元数据修改守卫与 SQLite Store。普通 `create` 不再要求 Agent 为脚本/JSON/二进制另走迁移入口。仅生成资源说明标题的同名 HTTP 自动链接按表现差异核对；作者 Markdown、真实脚本字节、hash/mode 与原未知请求仍保留精确检查。历史资源说明误判通过同一创建的原 ACK 前缀续办，并独立保存完成结果，不覆盖原失败。

集合移除、来源归并/改名、对当前观察的失效处理、Notion Trash 属性端点差异及新 Store 地址均不在旧有限域中。这些由真实授权对象、公开 CLI、源码回归和真实 Node SQLite 断言承担；不要把同步 hash 说成新形式化证明。ImportCreate 的抽象顺序与性质未变，只选择原完整模型组复验，其他模型与历史图不重复生成。

## SRC 来源接手：SDK 与原操作对应审阅

2026-11-15 的 `4be7add` 在现有 Promise SDK 上增加四个来源管理入口。
逐段比较确认 `runOperation`、`consume`、`readSkill`、`readResources` 的行为未变；
新增入口直接进入 Core，沿用凭据作用域、取消、请求预算和同库本地写锁。
`review` 与计划准备受 `withReadOnlyNotion` 限制，正式应用由明确的 `onboard-apply` 授权。
来源已登记、成员已关联、内容已验证和原操作已确认仍是不同事实。

创建动作持有原 `SharedCreatePlan` 并调用 `executeSharedCreate`，不建立另一套派发器。
缺关系的固定 Git 旧页使用不可变来源证明；没有历史来源证明的同名原生/保留型内容
只能由单来源的显式 `--bind MEMBER=PAGE_ID` 决定新的发现关联。该决定冻结原页面、
业务身份、原关系与 Selected Version，不能清除另一个来源、绕过原 unknown 或覆写正文。
绑定使用 `guardedSourceMutation` 的 `repeat: never`，当前关系相等仍不能补造丢失的 ACK。
原创建、绑定和独立接管决定各自保留，不以主任务完成标签代替逐项结果。

来源成员分类、多成员协调、派生 Skill ID、Provider 超时、参数和错误投影均不在既有
七个生命周期模型的有限域中。对应记录将这些文件作为明确未建模的实现上下文，
保持全部 TLA 模型、配置、视图与 expected_rules 不变。原 CI 的源码对应失败保留；
更新 hash 本身不代表新模型性质或实库全量成功。源码回归与独立安装 CLI→SDK→CLI
真实 Git/受控 Notion 入口分别覆盖新协调行为，实库仍由原始运行回执和独立读取验证。

真实全库试用另揭示 Git 部分克隆的分支批取缺陷：仅用 commit 的测试未覆盖已有远端
分支引用时的协商行为。相同受控 HTTP 仓库改用 main 可复现失败。精确缺失 blob 的
批取关闭 commit negotiation，初始 ref 获取保持原行为。新增 commit、branch、tag
三组分别检查固定 revision、完整选中文件、一次批取及未选大对象不下载；这属于提供方
传输实现回归，不扩展生命周期或请求引擎的形式化结论。

### SRC 实库反例的追加对应审阅

原生 Selection 只增加已知 v1 封装的读取规范化，四个过滤字段和语义指纹保持一致；
未知版本/额外字段仍在边界拒绝，不增加来源写入。来源目录 Router 与 Skill 成员分别
投影，`--member` 只收窄已完整发现的当前动作范围，保存到原计划并在应用时再次约束。
错误投影省略重复的子计划正文，但保留原操作身份和父计划中的完整输入。这些分类与
展示行为仍在来源接手的未建模范围，不由更新源码 hash 证明模型性质。

创建文本保留新增有界分块：小对象保留 v1 原字节和原 identity；只有不能放入普通
64 KiB 事实的完整输入/基线才使用现有 exact_bytes 对象。根记录仍绑定整文 SHA-256
与长度，块布局复用现有32 KiB读取校验。所有确定性字节/清单验证在原创建派发前完成；
之后仍由同一创建 journal 先记录派发，按原页面与事件继续，未引入第二个上传/重试器。
原生提交的 Markdown 与内容接纳规则不变，跨页链接不一致仍拒绝。既有正文观察和编辑
计划的内容大小边界不因此放宽。

retained_bundle 与其 source_projection v2 创建清单使用既有1 MiB逻辑/180 KiB编码清单
上限；对象、事件和普通操作仍64 KiB。该编码和文本块布局不在有限 TLA 字节域中，
记录为显式未建模对应；原 ImportCreate/恢复顺序保持，所有模型与expected_rules未改。
新增407文件清单、100 KiB完整Markdown、冷重建、缺块拒绝及真实Node/SQLite HTTP入口
分别承担这部分证据。曾要求65,536字节文本被拒绝的旧用例改为验证分块和8 MiB上界，
保留普通记录拒绝测试；不能把这个边界调整解释为取消一般大小保护。


## AH-1068：验证分域与原生完整URL误判

管理、消费与来源接手有不同的主要状态和验收边界。继续把三者追加到原总入口会增加
上下文与误选全量矩阵的成本；为每个Issue新建guardian则会复制同一原操作和证据协议。
本轮选择三个执行Skill加一个管理侧原生导入子模块：原总入口缩为路由，旧23份feature
规程/脚本与用例ID原地保留；模型和Pi证明仍归原负责人。`verification/skill-domains.json`
只登记唯一主要feature归属、实际回归文件和安装规程，不作为新的执行或证明平台。

常规测试拒绝缺owner、双owner、断测试/安装链接和不可发现入口。Broker反向交接由
其原三个Skill及常规test:verification检查。本轮作者实际运行了管理/消费/来源/原恢复
切片，安装和实际Notion证据另外记录；结构测试不证明冷Agent能正确选择，独立指令评估
仍为not_run。旧合同和共用隔离设施移至references，未删除历史失败或改变其通过范围。

Guizang原失败回执指向的完整main已通过只读公开CLI重新取得。原文字与代码完全相同；
Notion把保留的注释转为转义字面量，并把其中完整URL加成同地址标签链接。旧校验器
只识别不含scheme的自标签链接，因而把该第二处自动链接误记为额外明确目标。修复只
增加完整href恰好等于可见label的自动链接识别；原输入的authored目标仍逐一要求，
图片、不同href、文本/代码变化、表格加号变圆点均保留拒绝。原生wire和冻结projection
policy、原journal/ACK/恢复权威没有变化。

最小复现保留修复前失败，安装HTTP旅程添加相同注释转义与自动链接；完整实际main
单独通过新比较器。此语义解析不在ImportCreate有限状态域中，作为显式未建模源码
对应。旧needs_review事实没有被改写；retained Source v2原失败的正式恢复入口仍是
另一个明确产品缺口，不能套用仅支持普通native或旧fixed-Git的恢复命令。各原计划和
页面继续保留，实际库存完成数未因校验器修复而增加。


## 原失败阶段的纠正与原计划继续（AH-1067 / AH-1068）

进一步读取原只读reconcile及执行顺序，纠正上一节对Guizang恢复状态的推断：它在
main POST/ACK后的首次读回阶段被旧校验器拒绝，尚未保存manifest或不可变终局。
因此“CLI曾返回失败”不能写成“已有needs_review事实”。原producer已经支持由原journal
和完整native ACK继续未派发后缀，不需要新增retained-v2恢复器。真正已持久化的
needs_review及unknown仍走原拒绝/独立恢复规则，没有改变其权威。

本轮只调整onboarding命令的下一步导航：原reconcile报告精确绑定同plan的manifest/outcome
缺失时，返回同plan只读preview；一旦混有终局拒绝、unknown或无法关联的错误，仍保留
只读核对路线。preview本身不授予写权限，后续明确apply仍由原dispatcher检查所有原证据。
增加原main拒绝后继续、缺ACK、缺journal、正文漂移和已终局拒绝五个真实核心回归；
安装HTTP旅程增加原主观察被拒绝→reconcile→实际返回argv→SDK同plan完成→重复零写。
此处没有新增状态转换、放开重发、改变模型/配置/expected_rules或拷贝作者缓存。

另将provider原unavailable原因通过来源review的有界20项诊断透传，保留真实Source和
revision、精确from_path/href及截断计数。Clip To Kami的实际发现包含CHANGELOG中
越过仓库根的链接；诊断不删链接、不改变根、不让不完整发现成为可应用计划。
上述投影和新增测试列为现有模型之外的实现上下文；测试通过与真实库存完成分别记录。


## 保留型已知终局的明确审阅与原producer（AH-1067）

上节的清单前纠正只适用于该原失败阶段：原plan继续后若支持页面的完整读回被拒绝，
执行器会保存不可变needs_review。这时不能再把“缺manifest可继续”当成全程权限。
新增retained v2分支限定初始disabled、完整原source/input、policy14和未发布归属事件的
已知语义拒绝；原失败保持原样。用户审阅独立digest，原journal/POST/ACK/owner/Source
与完整native前缀均须吻合，再由同一个executeSharedCreate继续原未派发后缀。

实际代码边界：readOriginalFailure核原终局与有序页前缀，originalJournal核凭据/计划和
original dispatcher canResume；allocationProof复用既有完整native响应证明；observePrefix
只读核完整当前语义且不制造新观察缓存；review绑定原计划、manifest、失败和前缀正文。
明确apply持有同库本地锁，在每个原派发阶段重新核验原事实。新的review和完成记录使用
独立记录身份，原失败不改写；普通reconcile/冷消费者需完整review、原ACK证明、前缀
hash和全部不可变file事件才能解析独立完成。当前页面相等或仅一条完成标签不能代证。

这与AcknowledgedRecordPrefix的原ACK/精确绑定/前缀/新鲜前提/未派发后缀抽象相接，
与IndependentAcceptance的已知失败、独立决定、旧事实保留及冷证明完备原则相接。
原TLA模型、配置、expected_rules不变；它们没有枚举retained v2字节、Markdown语法、
实际凭据/Notion分页或audit家族分类。具体review schema/记录编解码、metadata审计归类、
Source选择与CLI/SDK参数由真实实现回归及独立安装承担，不宣称新的全系统形式化性质。

若恢复的新native POST明确400拒绝，同一original dispatcher仍禁止重发。受控回归移除
拒绝响应后再次调用也零native写，旧失败和前缀正文不变，content audit继续保留未完成。
HTTP分类与原operation/file/path通过错误投影返回；原计划与资源base64留在原私有文件，
不再次塞入Agent。明确metadata反馈的新一代权限与同一native请求重发权限分别表达。

本轮实库原拒绝仅保留400 validation_error及README.en.md身份，传输未保存细化说明；
不能根据文件HTML或外链猜测服务拒绝原因。原真实请求不为补诊断而重复发送。只读
reconcile/dry-run与后续明确执行分开，所有公开next.argv绑定原计划、operation和页面。
恢复数据产生新的辅助Records，audit-v5将精确关联原manifest的review/completion头归到
原创建家族；metadata仍标payload未观察，content仍需原完成验证，不隐藏原失败。


### 安装旅程时限与原件边界

同一安装HTTP旅程新增清单前拒绝、持久终局审阅、SDK恢复与独立冷读后，原180秒
总时限已经接近正常执行时长；该上限的超时结果保留。受控旅程总时限明确调整为300秒，
receipt记录此值和未变的100毫秒请求调度；不修改产品请求预算、模型次数/输出预算、
负例断言或任何业务恢复门槛。改变时限后的运行是新候选证据，不改判旧超时。
该测试单文件只影响对应source hash，模型与产品语义、已执行原TLC输入均不变；当前
最终候选的形式化证据按各次输入hash分别记录，不能把旧head自动当成新head通过。


## AH-1100：原主页面的独立字面量修复

选择一个有限的真实状态，而非给所有失败创建新增统一重试器：retained Source v2、原
policy14、初始disabled、唯一原main POST/ACK、manifest和file_event尚不存在。原父/子
计划不改。原页面只在普通表格文字的加号位置可出现+到圆点的变化，其余文本、code、
显式目标严格保持。真实Kami有9个原普通表格加号，其中8个变圆点；固定“全部变圆点”
的早期假设被完整原件比对否定。新的review-only位置匹配支持该部分变化，正常导入
语义校验继续拒绝+到圆点，不向成功条件加入模糊归一化。

原policy14和默认作者policy15不变。新policy16仅用于明确修复wire，对识别出的原表格
普通文本加号加反斜线；links、code、HTML code、非表格文本、原义与原UTF-8输入不动。
新的review冻结完整前像、原plan/hash、原main ACK以及候选wire。先用现有immutable
记录producer保留review/原ACK，再调用同一guardedSourceMutation、repeat:never执行
一次完整old_str匹配的PATCH。其请求、ACK与完成事实独立于原创建，没有改旧journal。
全前像匹配不提供跨机器CAS，后续仍要求原单writer和完整当前guard。

受控负例发现并保留了一处真实组合漏洞：修复PATCH的响应丢失但服务端已生效，原
onboard-apply原本可绕过repair的未知结果而继续。新增assertOriginalSourceProjectionRepairComplete
在原创建续接前验证完整修复；completed create outcome还绑定review/outcome的精确hash，
冷消费与内容审计缺任何证明均拒绝。可见性不代替ACK，换命令不能制造权限。审阅记录
按原operation只有一个稳定记录身份，漂移review不能建立另一份权限替代未知决定。
旧无repair的创建outcome不获得虚构附加证明，旧policy和历史消费合同保持。

历史completion核对使用原main分配证明、完整review、实际PATCH响应ACK和独立完成，
不重读当前body来推断历史成功。修复成功与原导入完成分别报告；original create仍要
从同一个原plan续接，它自己的输入、成员、Source与页面guard继续工作。Unknown修复
阻断原导入，缺原ACK/日志、body/owner/Source改变、原terminal、额外原请求都写前拒绝。
恢复结果含固定原页和原operation，不发布目录、不启用Skill、不丢弃未表示资源。

代码与有限模型的对应：原allocation/ACK前缀约束复用AcknowledgedRecordPrefix；独立
决定的先审阅、完整前像、未知不重放、冷证明保全分别由既有模型的相应规则提供抽象
参照。本轮新增的“repair与original create跨入口组合屏障”、Markdown位置解析、
Notion全文替换、proof编解码和audit-v6家族分类并不在旧有限域内，由专门实现反例、
完整原件比对及同包安装旅程负责；不因为更新source hash声称原TLA已证明该新组合。
TLA模型、配置及expected_rules保持原样，guardian重跑仍只声明原有限模型范围。

验证入口继续归管理native-import子模块与来源接手Skill，消费补冷证明缺失拒绝，
无需新增平台/常驻服务。安装旅程复用已有Git/Node/SQLite驱动：真实已分配main出现
普通table-plus改义，CLI review/dry-run、同包SDK修复和独立冷核对，然后原onboarding
继续、后续终局审阅与完整冷读取都保留。曾发现Bun 1.4的嵌套asymmetric toMatchObject
会把入参字段删空；最小复现保留，命令ledger保存独立clone与原始stdout/hash，断言使用
副本，不将被断言污染的对象作为原操作证据。原失败日志不改判。


### 真实v16失败与明确v17接续

实际Kami的v16 whole-preimage PATCH得到真实ACK，但提供方完整输出逐字等于修复前，
8个圆点仍存在。严格语义校验保留失败，未发布repair完成，也未继续原导入；原页属性
仅自动last_edited_time变化。先前受控fixture把反斜线看作有效，与实际服务不同；原
受控通过和实库失败均保留，fixture补充该真实无效行为，不将它泛化为生产成功。

随后在原隔离验证库通过正式create/dry-run创建最小表格原件，Markdown strong和
字面HTML <b>+</b>两种表示都由实际Notion完整读回验证。新policy17只采用HTML表示，
旧policy16及其失败review字节/解释保持。新review v2为none或acknowledged_unchanged_v16
两个离散状态。后者必须有共享完整原review、作者本机原PATCH与真正持久ACK，响应完整
正文必须逐字等于原前像和当前前像；缺ACK、unknown、不同正文或旧成功都不能授权。

新的v17 review/outcome使用各自稳定记录ID，不覆写旧v16记录。原创建续接屏障改为
验证唯一最终完成及其精确review；若承接旧v16，则完整两份review和旧ACK一起核验，
最终原create结果仍承诺最终review/outcome的hash。旧review hash由新review承诺，因此
冷客户端缺任一代都拒绝。新review写前重新核实本机旧ACK，不能通过手构新决定制造权限。
这只是已验证旧请求确切no-op后的一个有限新提交分支，不是无限重试/重写历史的框架。

新增组合状态继续由真实代码反例、独立安装和实际服务验证。旧TLA有限域未扩张，
模型/配置/expected_rules不改，不用形式化旧结果掩盖提供方表示失败或新接续的未模型化部分。


前任no-op证明还需要避免将相同完整正文重复放进普通记录。初次v2审阅在派发前因64KiB
上限拒绝；原失败保留。现用有界无损ACK表示：保留所有原ACK哈希、时刻及response中
除markdown外的原字段，完整markdown从已验证的原review前像重建，再核原response_hash。
作者派发前仍读取真正本机ACK，不能用重建后的对象伪造author权限；冷读仍要求共享
完整前任review及其精确hash。没有扩大普通事实/清单限制或省略正文；实际私有review
约61KiB，完整逻辑封装仍在64KiB内。实际新preview与原输入hash分别保存。


## 支持文件物理代码修复与安全拒绝诊断（AH-1100）

实际Kami的v17主文修复完整确认后，原onboarding继续到CHEATSHEET.md。全文text相同，
134个code片段中一个由单个圆点变为带两前一后空格的圆点；物理table_row的code=true
rich_text也包含空格，排除了仅Markdown serializer的解释。普通import code比较保持
严格，不能为了“通过”而trim全部code或只看可见文字。

方案比较：重新提交整个大Markdown会再次触发提供方对所有结构的解释；直接放宽code
比较会接受真实改义。选择独立明确的原行修复：原known-failure、manifest、完整分配
POST/ACK前缀与未发布ownership仍由原retained恢复核心核验；目标仅一个已ACK支持
文件。其他所有已分配正文需保持完整语义和固定观察，原目标需只存在一个有限表格
代码padding缺陷。真实块遍历确认唯一原table-row与精确file父链。只PATCH该行cells，
唯一code span恢复原值，其他富文本、链接、注释/格式和原页身份保持，不建替代页。

review保留完整前像的内容地址、原失败hash、原ACK证明引用、原journal和其他前缀
观察、精确物理row前像。私有plan保留完整正文；共享正文复用既有chunk codec和内容
地址，不提高64KiB普通事实上限。新PATCH走既有guardedSourceMutation repeat:never；
先保留完整前像/原分配证明/review，后核真实row响应ACK、全部目标正文和其他前缀，
再保留完整结果与独立completion。全前像核查与本地writer锁不等于Notion原子CAS。

原import的后续独立恢复review绑定file-repair的精确review/outcome hash集合；unknown
repair即使已应用也无法从另一个original recovery入口绕过。旧review无该字段时仍保留
原解释/原digest；一旦存在新独立repair，不能让旧权限自动继承。冷客户端要求原失败、
完整原allocation ACK、物理row ACK及完整pre/post字节，不能只靠成功标签或作者Store。
audit-v7将精确归属原manifest的file-repair头分类，内容审计仍核全部证据，metadata不
因此证明完成。源码反例覆盖漂移的row/body/parent/Source、缺ACK、篡改review、两种
未知可见性与冷读缺共享review；安装旅程复用原Git/Node/SQLite及同包CLI/SDK。

另修复拒绝诊断丢失：transport从实际400 validation_error只生成有限诊断类别、公开
schema字段和有界数值位置，保留净化的request ID；不输出原message、私有属性名、
正文、URL或凭据。source mutation在新的not_applied回执及后续错误中保留同一安全
信息。旧回执字段可缺且不补造，retry/unknown/definitive-rejection的既有权限判定完全
不使用这些提示，repeat:never仍不增加派发。真实HTTP负例保留原修复前失败并验证隐私。

形式化对应仍限于现有ACK前缀、独立决定、未知不重放和冷证明原则。新增物理row协议、
跨file-repair与original recovery的组合屏障、具体code解析、诊断解析以及proof codec
未被旧TLA域枚举，由实现反例、独立安装和实际服务证明。模型/配置/expected_rules
不变；coverage的源码hash是审阅后的对应，不宣称新的全系统性质。


### 原ACK后的完整读回与记录续接

实际CHEATSHEET局部row PATCH成功返回，物理row与候选完全相同，完整原text/code/
links通过；初版exact-after比较拒绝了同一行自动production.md链接的根斜杠表示。
原物理href此前即有根斜杠，原请求并未修改该链接。旧失败原件保留且没有重复PATCH。
新完成记录显式physical_row_root_url_v1：仅该修复行内、已绑定原物理href、原文无该
URL的生成链接允许根斜杠表示；行外每字节与完整原语义保持。作者明确URL、协议/
路径/代码变化均拒绝。新增负例还检查同名后续自动链接不能掩盖前面的明确目标变更。
旧未声明该策略的完成事实不被重新解释。

另一个真实恢复缺口由控制器反例证明：row ACK已持久化但后续readback中断时，原
mutation守卫返回已观察结果，与首次派发的verified结果不同。调用方错误地将它当
未知。修复选择直接验证和复用原request/ACK，而不新调mutation后再伪造verified标记。
只读reconcile和dry-run检验全文件、原前像/review及真实ACK，报告completion_pending
和table_row_patches=0；明确apply仅留存缺失完整结果和completion，PATCH总数仍是1。
这未修改原guardedSourceMutation的重放规则，没有通过当前值猜ACK或生成新的原操作。
