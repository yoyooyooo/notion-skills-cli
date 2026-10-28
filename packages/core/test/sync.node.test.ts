import { registerLocalSyncRunCases } from "./local-sync-run-cases.ts"

import { page, fixture } from "./sync-fixture.ts"
registerLocalSyncRunCases(fixture, page)
