import { Effect } from "effect"
import { libraryId } from "../../core/src/catalog.ts"
import { loadSharedLibrary } from "../../core/src/shared-library.ts"
import { SourceManagerExecution } from "../../core/src/shared-current-source-writer.ts"
import { withCurrentInvocationBudget } from "../../core/src/shared-current-invocation.ts"
import {
  materializeRegisteredSource,
  invalidateMaterializationFacts,
} from "../../core/src/shared-source-materialization-management.ts"
import { decodeSourceMaterializationRequest } from "../../core/src/shared-source-materialization-model.ts"
import {
  runCurrentSourceSync,
  validateCurrentSourceSyncCommand,
} from "../../core/src/shared-current-source-sync.ts"
import type { SourceManagerCommand } from "./source-manager-transport.ts"
import { runRuntimeOperation, type OperationOptions } from "./operation-runtime.ts"

/** Fixed entry only: validated host/generation/Store binding supplies this scope.
 * It is never selected from a client request or an environment bypass flag. */
export function runBoundSourceManagerCommand(
  command: SourceManagerCommand,
  options: OperationOptions,
  execution: {
    readonly library_id: string
    readonly store_root: string
    readonly source_ids: readonly string[]
  },
  limits?: { readonly requests: number; readonly bytes: number; readonly duration_ms: number },
) {
  if (command.action === "materialize") {
    const input = decodeSourceMaterializationRequest(command.input)
    return runRuntimeOperation(
      () =>
        libraryId(input.library).pipe(
          Effect.flatMap(loadSharedLibrary),
          Effect.flatMap((library) =>
            withCurrentInvocationBudget(
              materializeRegisteredSource(library, input).pipe(
                Effect.tap((receipt) => invalidateMaterializationFacts(library, receipt)),
              ),
              limits,
            ),
          ),
          Effect.map(({ result }) => result),
          Effect.provideService(SourceManagerExecution, execution),
        ),
      options,
    )
  }
  return runRuntimeOperation(() => {
    const { library, ...input } = command.input
    return runCurrentSourceSync(
      library,
      validateCurrentSourceSyncCommand({ ...input, action: "sync" }),
    ).pipe(Effect.provideService(SourceManagerExecution, execution))
  }, options)
}
