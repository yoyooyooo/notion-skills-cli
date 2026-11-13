# Controlled original-page repair

MNT03 repairs one explicitly selected page. It does not clear identifiers and run `adopt` again. Native draft adoption remains the path for a blank, disabled, unregistered Skill.

## Entries

| Entry | Selected object | One write |
| --- | --- | --- |
| `historical-missing-main` | Skill row with one legal Skill ID and a blank Main File ID | Fill that blank Main File ID |
| `managed-file` | One hand-created Files row with a blank File ID, one owner, and an explicit path | Fill that blank File ID |
| `ordinary-child` | Child page whose parent is not a database row | None. Report `ordinary_child_page_same_page_placement` |

A blank binding is either an empty string or the 32-byte NUL buffer Notion can retain for an empty rich-text property. Neither is a legal identity. A nonempty foreign ID is refused and is not cleared.

## Frozen operation

`plan --dry-run` reads the page, linked Files, Records, original operations, relations, and body. It writes nothing. The returned operation ID is the hash of that frozen input. The same page, body, and frontier produce the same ID. That equality does not authorize dispatch when an earlier outcome is unknown.

`apply` takes that operation ID, the same page, entry, database, and the managed-file path and owner. It loads the retained plan. It does not require a handwritten JSON record. Optional `--input` can repeat the same frozen JSON. A different current page produces a different ID and is refused before writes.

The only mutable page request is one identity PATCH through `sharedCreateDispatch`. Immutable plan, original-body and outcome Records are retained separately. Repair never allocates a replacement Skill or Files page. A lost PATCH stays unknown even when the current ID already matches. A lost record POST is not sent again. Current body equality cannot manufacture an acknowledgement. Enabled is never switched by repair.

## Consumption

A repair plan without its outcome keeps that Skill out of current consumption. `loadPendingSharedRepairs` selects only the headers for that Skill page and validates the exact paired plan/outcome and retained body before accepting completion. Another Skill in the library is not blocked by those headers. A File ID written before its outcome is not current-ready. The consumer does not adopt the half-repaired tree.

## Family

`recognizeRepairOperation` returns `maintenance-repair` for `skill-repair-main-` and `skill-repair-file-` operation IDs. `repairCommand` is mounted under `ctl`; the unified operation show/reconcile router delegates these exact IDs to the repair owner. Do not resume these IDs through the generic operation router.

## Local persistence and evidence

The locator and original POST replay markers use an exact credential-scoped address in the existing SQLite `shared_local_records` dispatch domain. They are immutable derived barriers, not another remote fact authority. Another credential cannot borrow that locator or ACK. The exact body object is retained before the identity PATCH; a missing or conflicting original body prevents claiming completion.

A parser-accepted `next.argv`, independent installed binary, actual SQLite Store and real owned Notion readback are separate checks. Source fixture success alone does not establish them. No contract here claims Notion compare-and-swap or full Pi delivery.
