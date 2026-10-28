import { join } from "node:path"
import { prepareConsumer } from "./package-smoke/consumer.ts"
import { checkCommandContract, checkStorageRoots } from "./package-smoke/command-contract.ts"
import { checkBuiltinLifecycle } from "./package-smoke/builtin-lifecycle.ts"
import { prepareMigrationFixture } from "./package-smoke/migration-fixture.ts"
import { checkMigrationConsumption } from "./package-smoke/migration-consumption.ts"

const consumer = await prepareConsumer()
await checkCommandContract(consumer)
await checkBuiltinLifecycle(consumer)
await checkStorageRoots(consumer)
const fixture = await prepareMigrationFixture(consumer)
const { trashCheck } = await checkMigrationConsumption(consumer, fixture)
const { manifest, runtime, run, executable, consumerBin, scratch } = consumer
console.log(
  JSON.stringify({
    name: manifest.name,
    version: manifest.version,
    runtime: (await run([runtime, "--version"])).trim(),
    executable,
    consumer_bin: consumerBin,
    proof: "seeded_offline_consumer",
    trash_check: trashCheck,
    checks: [
      "installed_bin",
      "version",
      "all_offline_help",
      "independent_historical_operator_installed_bin_and_offline_help",
      "daily_command_schema_excludes_historical_workflows",
      "resolve",
      "sanitized_config",
      "invalid_arguments",
      "builtin_offline_catalog_and_provenance",
      "builtin_main_reference_export_bytes",
      "builtin_three_skill_installation_and_reference_bytes",
      "builtin_independent_receipts_and_modified_sibling_isolation",
      "builtin_copied_entrypoint_not_adopted",
      "builtin_export_reuse_and_customization_conflict",
      "builtin_exact_id_and_remote_name_isolation",
      "root_precedence",
      "policy_process_persistence",
      "policy_clear_preserves_config",
      "complete_pinned_snapshot_unchanged",
      "raw_pinned_read",
      "relative_range",
      "snapshot_files",
      "portable_export_reuse",
      "offline_alias",
      "pinned_policy_rejection",
      "import_target_and_bind_prerequisites",
      "saved_plan_missing_rejected",
      "seeded_offline_current_read_open_files_export_list",
      "broker_metadata_only_discovery",
      "broker_list_selected_pinned_activation",
      "broker_pinned_directory_manifest_bytes_identity",
      "broker_directory_reuse_and_conflict_preserves_bytes",
      "broker_portable_workflow_entrypoint",
      "synthetic_same_user_credential_scope_isolation",
      "public_token_stdin_saved_config_environment_precedence",
      "seeded_eligible_max_age_cache",
      "failed_refresh_retains_observation",
      "seeded_offline_sync_status",
      "sync_status_refresh_prerequisite",
      "unbind_dry_run",
      "cache_clear_dry_run",
      "cache_clear_logical_retirement_preserves_migration_evidence",
      "unbind_process_retention",
    ],
    evidence: join(scratch, "offline-command-evidence.json"),
    scratch,
  }),
)
