import { expect, test } from "bun:test"
import { libraryOnboarding } from "../src/shared-library-onboarding.ts"
import { library } from "./shared-snapshot-fixture.ts"

test("source-pending attachment never claims a ready library or Pi delivery", () => {
  const result = libraryOnboarding({ library, created: false, localAliases: ["selected"] })
  expect(result.onboarding.remote.status).toBe("core_ready_source_pending")
  expect(result.next.argv).toEqual([
    "ntn-skills",
    "ctl",
    "library",
    "sources",
    "init",
    "--entry",
    library.skills.database_id,
  ])
  expect(result.onboarding.local).toEqual({ status: "registered", aliases: ["selected"] })
  expect(result.onboarding.pi).toEqual({
    status: "not_observed",
    body_read: "not_observed",
    configuration_changed: false,
  })
})

test("new and attached four-table libraries keep one entry but distinct empty claims", () => {
  const complete = {
    ...library,
    sources: {
      database_id: "00000000-0000-4000-8000-000000000009",
      data_source_id: "00000000-0000-4000-8000-00000000000a",
      property_ids: {},
    },
  }
  const first = libraryOnboarding({ library: complete, created: true, localAliases: [] })
  const attached = libraryOnboarding({ library: complete, created: false, localAliases: [] })
  expect(first.onboarding.remote.status).toBe("ready_empty")
  expect(attached.onboarding.remote.status).toBe("ready")
  expect(first.entry).toBe(attached.entry)
  expect(first.next.argv).toEqual([
    "ntn-skills",
    "list",
    "--database",
    complete.skills.database_id,
    "--refresh",
    "--json",
  ])
  expect(attached.onboarding.local.status).toBe("not_registered")
})
