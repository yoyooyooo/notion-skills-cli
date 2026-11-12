# Draft audit state and proof boundaries

AH-1025 fixes one cross-module disagreement. The directory classifies a disabled
page with an empty Skill ID as unregistered. The previous audit instead required
both registered identities, then tried to inspect that page as a managed tree.

## Registration is separate from adoption and consumption

`inspectAuditDraft` reuses `sharedMetadataEntryFromPage` for directory eligibility.
It checks complete managed properties, native relations, and the visible reverse
Files and Records inventory before describing the draft's lifecycle bindings.
Missing reverse coverage or malformed fields remain unobserved. Existing bindings
remain errors, including a surviving Main File ID. A valid draft produces an
informational finding and stays out of consumer discovery.

The per-target inspector uses the same result before reading a managed file tree.
A metadata audit can finish for an unregistered draft. Content and history depths
remain partial because no registered tree was verified. Neither result authorizes
adoption, assigns an identity, observes body bytes, or writes remote state. The
existing adoption entry still checks its own complete preconditions.

## Historical reports keep their original meaning

Current runs use `resource-audit-v2`. Known v1 checkpoints retain their original
findings and can be read or listed offline. They cannot resume or serve as a v2
incremental baseline. Unknown versions and damaged checkpoints still fail.
Local derived-history retention does not delete these original v1 observations.

## Verification ownership

The concrete negative cases live in `shared-audit-draft.test.ts`. They cover the
directory and complete audit together, not only the new helper. The original
implementation fails four of the first five tests. The malformed-state control
already passes and must continue to do so. The installed package smoke drives
the public Node CLI against an owned HTTP fixture and checks explicit exit states,
request methods and unchanged remote data.

`AuditRun` abstracts read-only behavior, reverse coverage and durable progress.
It does not model draft property values, native metadata parsing, or rules-version
compatibility. This change leaves its TLA actions, variables, properties, configs
and views unchanged. Review source correspondence and run its six existing cases,
but use the concrete regressions and installed commands for the new semantics.

`shared-content.ts` only exposes its existing exact rich-text property reader for
reuse. `shared-audit-inventory.ts` distinguishes an unregistered draft from a
registered identity error without suppressing physical rows or owner conflicts.
`shared-audit-inspect.ts` returns explicit unregistered state and unverified
content/history. `shared-audit-store.ts` separates stored historical observation
from current resumable rules. None of these changes adds write authority, weakens
the read-only transport, or treats current content as a missing original ACK.

This slice does not optimize target audit requests, repair real half-registered
pages, implement multi-file apply, or change daily installation. Those changes
remain in the AH-1024 child tasks and require their own evidence.
