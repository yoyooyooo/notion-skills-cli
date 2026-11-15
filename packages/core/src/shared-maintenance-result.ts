/** A public projection of observed facts, not a recovery or dispatch authority. */
export type MaintenanceCompletion =
  | "complete"
  | "no_op"
  | "partial"
  | "unknown"
  | "refused"
  | "read_again"
  | "needs_decision"
export type MaintenanceEffect = "none" | "confirmed" | "unknown"
export function maintenanceResult(input: {
  readonly completion: MaintenanceCompletion
  readonly verifiedScope:
    | "original_operation"
    | "current_observation"
    | "preflight"
    | "not_verified"
  readonly authorContent: MaintenanceEffect
  readonly retainedRemote: MaintenanceEffect
  readonly message: string
}) {
  return {
    completion: input.completion,
    task_completed: input.completion === "complete" || input.completion === "no_op",
    verified_scope: input.verifiedScope,
    effects: { author_content: input.authorContent, retained_remote: input.retainedRemote },
    summary: input.message,
  }
}

export function maintenanceOperationArgv(
  action: "show" | "reconcile" | "resume",
  operationId: string,
  target: string,
  entry?: string,
) {
  return [
    "ntn-skills",
    "ctl",
    "operation",
    action,
    operationId,
    "--target",
    target,
    ...(entry === undefined ? [] : ["--entry", entry]),
  ]
}
