# Security policy

## Supported versions

Security fixes target the latest patch of the current 0.x minor series. Upgrade to
that patch before relying on a fix; earlier patches and previous minor series are
not maintained security branches. The supported Node.js lines are 22.23.5+
within 22.x, 24.22.3+ within 24.x and 26.13.1+ within 26.x. Keep Node on a
maintained patch within one of these lines; other major versions are outside
the declared runtime range.

## Reporting a vulnerability

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/yoyooyooo/notion-skills-cli/security/advisories/new).
Include affected versions, a minimal sanitized reproduction, impact and any proposed
mitigation. Do not post credentials, signed URLs, private Skill contents or personal
database identifiers in a public issue.

The maintainer aims to acknowledge reports within seven days. This is a response
target, not a guaranteed response or fix deadline. Investigation and remediation
depend on impact, reproducibility and available maintainer time. Use
[GitHub issues](https://github.com/yoyooyooo/notion-skills-cli/issues) for ordinary
bugs and usage questions.

The boundaries below describe the current `next` implementation. They do not
establish that an older installation or existing Notion library has been converted.
See the [current library contract](docs/current-contract.md) for implementation
and cutover boundaries.

## Credentials and network access

Notion authentication selects a non-empty `config.token`, then `NOTION_API_TOKEN`.
Missing credentials return `AUTH_REQUIRED`. `ctl config set-token --stdin` accepts
piped input and saves it offline; it does not validate remote access. The saved token
is plaintext in the private configuration file. `ctl config show` omits its value;
`ctl config clear-token` removes it and restores environment-token selection. The
Notion transport does not reuse another CLI's login state or launch a login flow.

Use a Notion integration with access to the intended Skills, Files, Sources and
Records. Reads need content access. Explicit import and Profile changes also need
the relevant write access. A local registration, matching name, stored resource or
successful authentication does not establish permission for a particular target.
Library selection accepts an exact database ID, URL or registered alias. Unknown,
conflicting or inaccessible aliases fail without redirecting to another library.

`NOTION_API_BASE_URL` is trusted machine configuration: the selected endpoint
receives the Notion credential. It accepts a validated HTTPS origin; HTTP loopback
is reserved for controlled tests. URL credentials, paths and queries are rejected.
API origin and credential identity participate in cache isolation. Signed attachment
downloads do not receive the Notion authorization header. The CLI sends no analytics
or telemetry requests of its own.

GitHub Source access has a separate credential boundary. For the official API,
`NTN_SKILLS_GITHUB_TOKEN`, `GH_TOKEN` and `GITHUB_TOKEN` take precedence over the
existing official `gh` session. The only session command is the bounded,
noninteractive `gh auth token --hostname github.com`. It does not log in, refresh
credentials or change Git configuration. `NTN_SKILLS_GITHUB_AUTH=anonymous` disables
this credential reuse. A custom `NTN_SKILLS_GITHUB_API_URL` receives only an explicitly
supplied `NTN_SKILLS_GITHUB_TOKEN`, never the official session or environment token.
Source definitions do not select machine credentials. Selected provider identities
are checked when acquiring bytes; reading does not advance a Source or authorize
uploading local files.

## Read and content boundaries

Ordinary list, read, use, Files, export and SDK consumption perform zero semantic
Notion writes. They can populate local caches. They do not execute imported scripts,
repair remote data or grant management authority. Treat Skill instructions and
exported files as untrusted content; reading them does not authorize unrelated
instructions or executing a preserved executable file.

Current readers check exact ownership, complete file membership and current content
descriptors. An affected Skill in `applying` or `attention` is not a complete readable
tree. Resource downloads are bounded and checked against expected size and SHA-256.
A single-original ZIP carrier also checks its only path and executable mode. These
checks detect changed or corrupt bytes; they are not signatures or proof that an
authorized author is trustworthy.

A complete current observation may be reused within its configured age. Use
`--refresh` when a fresh remote check is needed. Selected local bytes can remain
available after remote access changes; freshness settings are not revocation or
secure-erasure guarantees. Missing selected bytes require current owner and locator
checks. A known permission denial must not be converted into successful remote
acquisition from an old pointer.

## Complete import and original files

`ctl library import INPUT --entry LIBRARY --skill-id ID` creates or replaces one
complete current Skill under its stable identity. Import selects the target by that
ID, not by name. Notion-owned supporting files omitted from the input are removed
from the current tree. The writer checks current references before trashing removed owned
Files and unreferenced owned resources. This scope is not a global library census.
Existing Source files cannot be removed, taken over, renamed or rebound through
this import. Both dry-run and apply reject before mutation with
`CURRENT_SOURCE_MANAGEMENT_REQUIRED`; Source contributions and exclusions must
be managed together.

Import accepts a directory, ZIP or explicitly selected Markdown file. The boundary
rejects unsafe paths, links, special files, duplicate ZIP entries, unsupported
portable relationships and observed input changes before Notion access. Directory
inputs also check parent paths for symbolic links. Inputs are bounded to 128 MiB of
expanded content and 10,000 entries. Do not mutate the input tree during import:
filesystem checks cannot provide atomic isolation from a noncooperating writer.

Default import preserves original bytes and the executable/non-executable mode as
current Notion resources. It uploads those bytes and renders complete readable text
on the associated page. Unsupported upload types use a ZIP containing that one
original. Review the selected files before importing; filenames, executable mode,
metadata and text can contain private information. Hashing or packaging does not
remove secrets or encrypt an attachment.

A generated reading projection is not the editable author source. Editing it does
not transfer authority from a resource or Source. Native author bodies have a
separate current descriptor. Notion page permissions govern access to uploaded
originals and their projections; mode metadata is not a remote access-control list.
Exported executable content is never executed by the export operation.

## Incomplete and concurrent writes

`--dry-run` inspects the complete input and current target without allocating an
operation or making semantic Notion writes. An import that already matches current
content also performs zero semantic writes. An actual change uses one current
operation identity and a finite local pending marker, bound to its credential
scope, library, owner and input.

Notion does not provide an atomic transaction across the affected pages, properties,
attachments and blocks. Interrupted or ambiguous requests can leave a partial
result. Resume uses the same complete input and `--operation ID --resume`; it
observes the current effect before continuing. A timeout or an absent observation
does not authorize replaying an unknown create or append. Some unresolved outcomes,
including a partially observed append, require attention rather than automatic
continuation.

Successful completion establishes the current ready state, retires the operation
and clears its local pending marker. This mechanism does not retain a permanent
publication receipt or content version. Preserve an unresolved operation's input
and pending state. There is no general-purpose abandon, historical rollback or
cross-object repair command promised by this implementation.

Local locks, hashes and preflight reads coordinate cooperating processes and detect
observed drift. They are not distributed compare-and-swap or protection against every
check-to-write race. Avoid overlapping writers to the same Skill. Source refresh,
cross-object governance and remaining recovery cases still need their current
implementations; the current import route does not certify those capabilities.

## Private local data and cleanup

Isolate `NTN_SKILLS_HOME`, `NTN_SKILLS_CONFIG_HOME` and `NTN_SKILLS_CACHE_HOME` for
separate host identities. A saved token in a shared configuration takes precedence
over each host's environment token. Defaults are `~/.local/state/ntn-skills`,
`~/.config/ntn-skills` and `~/.cache/ntn-skills`. New private configuration/content
files request mode `0600`, and managed directories request `0700`. These permissions
do not encrypt data or protect it from another process running as the same user.

Cached originals, exported files, temporary upload data and unfinished local state
may contain complete private content. Uninstalling does not erase them.
`ctl cache clear` retires disposable SQL observations; it does not delete content
files or perform a Trash operation. Do not treat freshness expiry, observation
retirement or removal of a remote row as local data erasure. Stop active hosts and
identify the exact data before deliberately reclaiming it. Do not discard unresolved
pending state as a cache cleanup shortcut.

Explicit `ctl builtin install/update` also writes local Skill files and distribution
links. Its ownership and content checks do not make package provenance a signature,
Notion endorsement or permission to replace a remote Skill. Builtin discovery and
reading do not install those files automatically. Protect local installations,
exports and any backups with the same care as the original content.
