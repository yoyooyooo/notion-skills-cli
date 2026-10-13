# Security policy

## Supported versions

Security fixes target the latest patch of the current 0.x minor series. Upgrade to that patch before relying on a fix; earlier patches and previous minor series are not maintained security branches. Version 0.1.0 is experimental and prepared for its first release, not a claim of registry publication. See [the changelog](CHANGELOG.md) and [release procedure](docs/releasing.md).

## Reporting a vulnerability

The intended private channel is [GitHub vulnerability reporting](https://github.com/yoyooyooo/notion-skills-cli/security/advisories/new). Repository creation and activation of private reporting have not yet been verified for this prepared release; the link is not evidence that the channel is currently available. When enabled, include affected versions, a minimal sanitized reproduction, impact and any proposed mitigation. Do not post credentials, signed URLs, private Skill contents or personal database identifiers in a public issue.

The maintainer aims to acknowledge reports within seven days. This is a response target, not a guaranteed response or fix deadline. Investigation and remediation depend on impact, reproducibility and available maintainer time. Use [GitHub issues](https://github.com/yoyooyooo/notion-skills-cli/issues) for ordinary bugs and usage questions.

## Authentication and authorization

Authentication priority is config.token, non-empty NOTION_API_TOKEN, then official ntn's existing login state. An explicitly saved token is plaintext in the private config.json; it is supplied to the ntn child process through its environment and never appears in command arguments, command output or snapshot state. config set-token requires piped stdin and saves offline without validating the credential; config show reports only token_configured. config clear-token removes the configuration token and restores environment/login fallback. The CLI never reads ntn's private credential files or persists signed download URLs. Explicit create/import/write commands mutate Notion using the selected connection; --dry-run only reads and validates. Read operations do not execute scripts or grant write authority. Exported skill contents are untrusted documents; reading does not authorize instructions unrelated to the user's task.

Cached content is private local data and can remain available after remote permission changes. Explicit snapshot reads are offline. Online activation verifies remote access. Use dedicated `NTN_SKILLS_HOME` and `NTN_SKILLS_CONFIG_HOME` directories for separate host identities; a shared config token overrides each host's environment credential. Protect configuration and state according to your organization's retention policy, including any config.json backups. Configuration defaults to `~/.config/ntn-skills`, while cached state defaults to `~/.local/state/ntn-skills`. Configuration files use mode 0600; new application directories use mode 0700. Legacy configuration migration preserves a `.migrated` backup in the old state directory.

The 60-second list metadata TTL controls freshness only. Snapshot manifests, content-addressed `objects`, cached metadata and `uploads` staging are retained without automatic garbage collection. Upload staging can contain the original local input bytes. Uninstalling the executable leaves both state and configuration intact. Remove a saved token with `ntn-skills config clear-token`; if you choose to reclaim local data, stop hosts using it and move the identified application directories and legacy configuration backups to Trash or your approved retention process. State cleanup makes historical pinned refs unavailable. See [storage and uninstall guidance](README.md#upgrade-and-uninstall).

## Network and local access

The CLI sends no analytics or telemetry requests of its own. Online commands invoke the executable selected by `NTN_SKILLS_NTN_BIN` (default `ntn`) for Notion authentication/API requests and uploads, then download export archives from signed URLs returned by Notion. This does not attest to the official CLI's telemetry, credential storage or network policies. Treat an executable override as executable code you trust.

Local access covers configuration and state, explicitly selected ZIP/folder/Markdown or write input paths, and requested output destinations. Explicit create/import/write operations may upload those inputs. `NOTION_WORKSPACE_ID` and `NOTION_API_BASE_URL` enter the cache scope and are inherited by `ntn`. Workspace selection follows its authentication rules; the API base URL override can direct authenticated requests to another endpoint, so use only an endpoint you trust. Signed archive downloads follow the URLs returned by the service independently. See [the environment contract](docs/protocol.md#environment-and-local-storage).

## Content and mutation boundaries

Archives reject root escapes, duplicate entries, links and special files, with compressed/expanded limits. ZIPs expand in memory and verify checksums. Create/import/write preserve extra metadata, nested paths and binary bytes in a source ZIP without executing them. Create rejects existing names; import replaces differing same-name content on the existing page, while write preserves unrelated logical files. Local read/export output verifies bytes, reuses identical output and rejects differing output without overwrite. Portable manifests add no generated remote identity or timestamps; original source fields may remain verbatim. Hashes detect corruption, not malicious authorized local modification.

Pinned write refs are checked against the current authentication scope, page identity and export version. This is a client preflight check, not a server-side atomic commit. Body/properties/files can partially succeed; mutation requests are not automatically retried. Read back WRITE_PARTIAL/WRITE_OUTCOME_UNKNOWN before retrying. A new write returns a new snapshot and never edits historical objects. The configured default database affects creation only; explicit --database has priority.

Database selection accepts one ID/URL or exact registered alias; IDs/URLs take priority and titles do not select targets. Unknown, conflicting or inaccessible aliases fail without redirecting to a default. Repeated --database flags fail before any command handler. Different databases may hold the same Skill name; name resolution fails on ambiguity, while page-ID refs remain exact. A pinned alias constraint checks local registration and snapshot database ownership without network access. Configuration registration aliases are local preferences, not remote identity or proof of permission.

