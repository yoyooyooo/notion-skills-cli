# NXT maintenance and consumption delivery

This records the AH-1050 acceptance run begun on 2026-11-15. The owning tickets define the completion gates; code, controlled HTTP, real Notion, installed packages, actual Pi, and bounded model behavior are separate evidence classes.

## Exact starting inputs

- CLI baseline: `4580b7d6d692013091d5c66e90d703d51fd5fb10`; continue existing PR #10.
- Broker baseline: `2d8e112ed7b6b7e0b55372eb3284f1692bc5d12f`; continue existing Broker PR #12.
- Owned test library: `library-c7f71664-a24e-44a2-a20d-a30cbf7d17e1`; entry `4195636c-236e-8104-aafa-f7366fe421ce`.
- Original six-file Skill: `skill-908879fb92f1a4b4f957b440a011ea5cc13b16a2f450c5af926bf62cfa066566`; page `4195636c-236e-81e0-be28-ed9a783bd84a`.
- Original snapshot: `s_e086282444fc61d2da3f7b5ad78056be63fe3e202df8fc408f2ee71eb7a4bdcb`.
- Fixed Git input: `nowledge-co/community`, A `d6e546efe17c9ba48291a67356c4be6f7a7883a8`, B `657919af19c22951796b326af44032a63dec24f2`; only the two preselected member roots are in scope.
- Original evidence root: `/Users/yoyo/Documents/code/personal/verification-evidence/nxt-20261115-jTFsQ9`. Original outputs, failures, journals and .started dispatch markers are retained there. No credentials are included in this document or those command envelopes.

## Verification corrections that remain part of the evidence

The first CLI envelopes recorded a bundle hash but inherited `NTN_SKILLS_DEV_ROOT`. The package launcher consequently selected the daily development checkout at `2c491ff838a4231d5d8d850c5d55a63571f2562b`. Their observed library effects remain real, but those envelopes do not establish execution of the named baseline/candidate bundle. `evidence/nxt-launcher-attribution-correction.json` identifies all 18 original affected records without overwriting them. The verification harness now removes the variable from child processes and records the execution choice; the global environment is unchanged. Direct imports of `dist/sdk.js` do not pass through that launcher.

The corrected packaged CLI comparison uses independent empty clients, equal content and freshness, and zero remote writes:

| Read | Baseline requests / response bytes | Candidate requests / response bytes |
| --- | ---: | ---: |
| Cold main | 10 / 55,098 | 10 / 55,098 |
| Warm main | 0 / 0 | 0 / 0 |
| Explicit refresh | 10 / 55,098 | 10 / 55,098 |

These main-read measurements establish parity, not an optimization. The separate immutable supporting-resource comparison records actual duplicate HTTP attempts and does not trade away freshness or pin validation.

For two simultaneous public SDK `readResources` calls on the original pinned 52-byte `scripts/example.sh`, baseline-03 used 12 requests / 39,730 response bytes and candidate-02 used 10 / 32,937. That is 2 fewer requests (16.7%) and 6,793 fewer response bytes (17.1%). Both results were ready with identical bytes, hash, executable mode and 120-second budget; permission/pin qualification remained independent, no remote writes occurred, and unknown-byte/in-flight counts were zero. Each client began empty and bootstrapped through public reads. Candidate-01, which showed no savings because it exercised a different internal resource path, is preserved. The gain is for this duplicate immutable resource path, not a claim of lower cost for every read.

The original packaged baseline still rejects main links to not-yet-allocated references before writing: `SHARED_NATIVE_REFERENCE_UNBOUND`, 24 requests, 118,458 response bytes, zero writes. That was the prior safe contract; a single complete maintenance intent is this batch's new capability.

Anonymous GitHub content requests returned HTTP 403 with an exhausted public quota during fixed-source admission. The two original failed preparations remain preserved. Admission now accepts an explicit `--storage retained` selection through the existing retained-source implementation; it does not silently downgrade a failed fixed-Git proof. Git discovery still verifies the frozen commit and member input, and upstream content is never executed.

A real packaged write preflight exposed a missing `source-rejection-<hash>.json` case in the SQLite operation-address classifier. Both attempted creates stopped with zero Notion writes. The fix extends only the exact shared-source journal address and retains that journal in the protected operation domain; a real Node reopen/enumeration regression covers persistence.

## Result semantics and limits

One maintenance parent retains its complete input and original allocation outcomes before resolving links to actual acknowledged page IDs. An unknown allocation is never replayed. New supporting files that themselves reference other unallocated new files still fail preflight; the existing staged route remains available for that explicit boundary.

Source selection, still-following native body replacement, request feedback, and overall task completion are reported separately. Explicit `--update-following` authorizes only the fixed candidate and observed following baseline. Custom ownership remains custom when bytes coincide. A complete old-string match is not an atomic page revision compare-and-swap, and no such guarantee is claimed.

Shared freshness policy resolves explicit request settings before Skill policy, Profile policy and defaults. Revalidation uses the original validation time. Expiry does not erase fixed content. Cache capacity applies to identified optional rebuildable payloads, not physical database size or protected history. Reclamation requires an exact preview, a verified archive and successful system Trash before conditional retirement; pins, objects and operation evidence stay protected.

Pi working-set budgets cover the complete active Notion root/Requires union. Explicit release preserves shared requirements and original Session history; stale completion cannot restore a released root. Configuration saved, runtime reloaded, and a successful body read are distinct onboarding states.

## Closure evidence

The final verification inventory and existing PR heads are recorded after the same-library journey and exact-package gates finish. Until that inventory is present, this document is an in-progress implementation record and does not close AH-1050 or its integration gate.
