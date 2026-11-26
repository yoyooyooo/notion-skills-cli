import { expect, test } from "bun:test"
import { preservesSharedLibraryBindings } from "../src/shared-library-model.ts"
import { currentLibrary as library, currentId as id } from "./shared-current-fixture.ts"

test("additional display properties preserve every current four-table operation binding", () => {
  const updated = {
    ...library,
    files: {
      ...library.files,
      property_ids: { ...library.files.property_ids, "Reading note": "reading-note" },
    },
    sources: {
      ...library.sources,
      property_ids: { ...library.sources.property_ids, "Display note": "display-note" },
    },
  }
  expect(preservesSharedLibraryBindings(library, updated)).toBe(true)
  expect(preservesSharedLibraryBindings(updated, library)).toBe(false)
  expect(preservesSharedLibraryBindings(updated, structuredClone(updated))).toBe(true)
})

test("binding checks never accept deleted, renamed, rebound or foreign current identities", () => {
  const files = { ...library.files, property_ids: { ...library.files.property_ids } }
  delete files.property_ids["File ID"]
  for (const changed of [
    { ...library, library_id: "1fed9b5e-352d-53b8-811b-d62ae58344f8" },
    { ...library, operation_id: "foreign" },
    { ...library, skills: { ...library.skills, database_id: id(90) } },
    { ...library, files: { ...library.files, data_source_id: id(90) } },
    { ...library, sources: { ...library.sources, data_source_id: id(90) } },
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
