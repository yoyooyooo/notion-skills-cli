import { expect, test } from "bun:test"
import { preservesSharedLibraryBindings } from "../src/shared-library-model.ts"
import { library, id } from "./shared-snapshot-fixture.ts"

test("older frozen operations retain exact bindings across additive optional registrations", () => {
  const updated = {
    ...library,
    files: {
      ...library.files,
      property_ids: { ...library.files.property_ids, "Management Receipt": "receipt" },
    },
    sources: {
      database_id: id(80),
      data_source_id: id(81),
      property_ids: { "Source ID": "source-id" },
    },
  }
  expect(preservesSharedLibraryBindings(library, updated)).toBe(true)
  expect(preservesSharedLibraryBindings(updated, library)).toBe(false)
  expect(preservesSharedLibraryBindings(updated, structuredClone(updated))).toBe(true)
})

test("additive compatibility never accepts deleted, renamed, rebound or foreign frozen identities", () => {
  const files = { ...library.files, property_ids: { ...library.files.property_ids } }
  delete files.property_ids["File ID"]
  for (const changed of [
    { ...library, library_id: "foreign" },
    { ...library, operation_id: "foreign" },
    { ...library, parent_page_id: id(90) },
    { ...library, skills: { ...library.skills, database_id: id(90) } },
    { ...library, files: { ...library.files, data_source_id: id(90) } },
    { ...library, files },
    {
      ...library,
      files: {
        ...library.files,
        property_ids: { ...library.files.property_ids, "File ID": "recreated-same-label" },
      },
    },
  ])
    expect(preservesSharedLibraryBindings(library, changed)).toBe(false)
})
