# Editing a Skill in Notion

Keep the main content in its Skills page. Reference files are Files database rows
related to that page; a normal nested child page is not automatically a managed
reference. The CLI owns the stable identity and original-operation records.

| Location | Author-editable content | Identity or operation evidence |
| --- | --- | --- |
| Skills | Body, Name, Description, reviewed Kind, Enabled and chosen relations | Skill ID, Main File ID and generated projections |
| Files | Complete body after registration; explicit source-control intention | File ID, logical Path, owner binding and source versions |
| Records | No direct author edits | Original plans, outcomes, body objects, snapshots and file events |

Normal body editing remains available. It customizes that whole file when a
successful current observation retains it. It does not implicitly update all
other files or select a newer upstream revision. A strictly read-only observation
cannot create retention facts.

Keep machine-owned columns collapsed in the ordinary editing view, but do not
hide broken records from the maintenance view. A disabled blank-identity page is
a draft, not corruption. A half-registered enabled page must be diagnosed before
it can be consumed. Duplicating a row also copies its identifiers and relations;
run a scoped audit rather than reusing those identities for another Skill.

Use one `apply` for an ordinary split into references. Use explicit move, delete
and undelete actions for file layout changes. Removing a relation or putting a
page in the trash is not a confirmed lifecycle event. Unknown visibility and
permission errors cannot prove deletion.

A Notion button may capture a user's requested intent. Its displayed state is
not a dispatch authorization or a verified outcome. Execute the corresponding
public CLI operation and retain its original result before reporting success.
This template describes the supported editing workflow; it does not claim that
Notion button clicks or arbitrary UI automation were tested.
