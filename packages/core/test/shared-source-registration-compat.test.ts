import { afterAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { property } from "../src/model.ts"
import { trashPath } from "../src/local-locks.ts"
import { sourceDiscoveryInput } from "../src/shared-source-adapters.ts"
import { validateCurrentSourceInput } from "../src/shared-current-source-input.ts"
import { parseCurrentSourceConfiguration } from "../src/shared-current-source-management.ts"
import { sourceRich, validateSourceDefinition } from "../src/shared-source-definitions.ts"
import { discoverRegisteredSourceMembers } from "../src/shared-source-member-discovery.ts"
import {
  commit,
  declaration,
  library,
  materializationFixture,
  sourceId,
} from "./shared-source-materialization-fixture.ts"

const root = mkdtempSync(join(tmpdir(), "source-registration-compat-"))
afterAll(async () => {
  if (process.platform === "darwin") await Effect.runPromise(trashPath(root))
})
type Fixture = Awaited<ReturnType<typeof materializationFixture>>
const legacy = (settings: Readonly<Record<string, unknown>>) => ({
  version: 1,
  adapter: {},
  settings,
})
function setText(f: Fixture, name: string, value: unknown) {
  const id = library.sources.property_ids[name]!
  property(f.pages.get(f.sourcePage)!.properties)[id] = {
    id,
    type: "rich_text",
    rich_text: sourceRich(typeof value === "string" ? value : JSON.stringify(value)),
  }
}
const composition = {
  target_mode: "auto",
  shared_target_set: "shared-team-target",
  publisher_subscription_id: "00000000-0000-4000-8000-000000000070",
  accepted_ref: commit,
  require_all_included: true,
}

test("historical classification and fixed-storage metadata retain exact acquisition options", async () => {
  const f = await materializationFixture(root)
  for (const settings of [
    { target_mode: "auto" },
    { target_mode: "design", strip_prefix: "skills" },
    { target_mode: "video" },
    { target_mode: "matt", strip_prefix: "skills" },
    { target_mode: "architecture-diagrams" },
    { storage: "auto" },
    { storage: "fixed-git" },
  ]) {
    const options = legacy({ ...settings, accepted_ref: commit, require_all_included: true })
    setText(f, "Options", options)
    const parsed = parseCurrentSourceConfiguration(library, f.pages.get(f.sourcePage))
    expect(parsed.definition.options).toEqual(options)
    const discovery = sourceDiscoveryInput(parsed.definition)
    expect(discovery).toMatchObject({
      source: declaration.definition.adapter,
      ...declaration.definition.selection,
      accepted_ref: commit,
      require_all_included: true,
    })
    expect(
      validateCurrentSourceInput({ ...declaration, definition: parsed.definition }),
    ).toMatchObject({
      definition: { options },
    })
  }
  expect(f.mutations()).toEqual([])
})

test("only the historical Notion boundary admits a strict version-one Selection envelope", async () => {
  const f = await materializationFixture(root)
  const selection = { ...declaration.definition.selection, exclude: ["skills/sibling"] }
  setText(f, "Selection", { version: 1, ...selection })
  expect(
    parseCurrentSourceConfiguration(library, f.pages.get(f.sourcePage)).definition.selection,
  ).toEqual(selection)
  expect(() =>
    validateSourceDefinition({
      ...declaration.definition,
      selection: { version: 1, ...selection },
    }),
  ).toThrow()
  for (const value of [
    { version: 2, ...selection },
    { version: "1", ...selection },
    { version: 1, ...selection, unsafe_extra: true },
    { version: 1, ...selection, roots: ["../outside"] },
  ]) {
    setText(f, "Selection", value)
    expect(() => parseCurrentSourceConfiguration(library, f.pages.get(f.sourcePage))).toThrow()
  }
})

test("legacy metadata never admits unknown adapters, settings, storage or publication owners", () => {
  for (const options of [
    { version: 2, adapter: {}, settings: {} },
    { version: 1, adapter: [], settings: {} },
    { version: 1, adapter: { execute: true }, settings: {} },
    legacy({ unknown_setting: true }),
    legacy({ target_mode: false }),
    legacy({ target_mode: "bad\nlabel" }),
    legacy({ storage: "copy-anywhere" }),
    legacy({ storage: ["auto"] }),
    legacy({ shared_target_set: "team" }),
    legacy({ publisher_subscription_id: composition.publisher_subscription_id }),
    legacy({ ...composition, publisher_subscription_id: "not-an-owner" }),
    legacy({ ...composition, accepted_ref: "main" }),
  ])
    expect(() => validateSourceDefinition({ ...declaration.definition, options })).toThrow()
  // New declarations still cannot request obsolete storage through the flat API.
  expect(() =>
    validateSourceDefinition({ ...declaration.definition, options: { storage: "fixed-git" } }),
  ).toThrow()
})

test.each([
  [composition, "SOURCE_COMPOSITION_REVIEW_REQUIRED"],
  [{ storage: "retained" }, "SOURCE_STORAGE_REVIEW_REQUIRED"],
] as const)(
  "complete read-only member discovery separates a blocked write policy (%s)",
  async (settings, reason) => {
    const f = await materializationFixture(root)
    setText(f, "Options", legacy(settings))
    const found = await f.run(discoverRegisteredSourceMembers(library, { query: "legacy-root" }))
    expect(found).toMatchObject({
      coverage: "complete",
      failures: [],
      effects: { remote_writes: "none" },
    })
    expect(found.candidates).toHaveLength(1)
    expect(found.candidates[0]).toMatchObject({
      source_id: sourceId,
      expected_skill_id: "legacy-root",
      readiness: "blocked",
      reason,
      record: { locator: { page_id: f.owners.get("root") } },
    })
    expect(f.mutations()).toEqual([])
    // A valid target/digest does not carry the candidate's readiness. The manager
    // must independently reject a caller that dispatches this target anyway.
    const request = await f.request()
    const result = await f.materialize(request)
    expect(result).toMatchObject({
      status: "blocked",
      reason,
      records: [],
      effects: { remote_writes: "none", projection: "none" },
    })
    expect(f.mutations()).toEqual([])
    expect(f.preparedCount()).toBe(0)
  },
)

test("a ready physical member is not downgraded by a new write-policy restriction", async () => {
  const f = await materializationFixture(root)
  expect(await f.materialize(await f.request())).toMatchObject({ status: "ready" })
  setText(f, "Options", legacy(composition))
  f.clearCalls()
  const found = await f.run(discoverRegisteredSourceMembers(library, { query: "legacy-root" }))
  expect(found).toMatchObject({ coverage: "complete", failures: [] })
  expect(found.candidates[0]).toMatchObject({
    readiness: "ready",
    record: { locator: { page_id: f.owners.get("root") } },
  })
  expect(found.candidates[0]?.reason).toBeUndefined()
  expect(f.mutations()).toEqual([])
})

test("partial discovery reports the exact registered identities whose options failed", async () => {
  const f = await materializationFixture(root)
  setText(f, "Options", legacy({ unknown_setting: true }))
  const second = structuredClone(f.pages.get(f.sourcePage)!)
  second.id = "00000000-0000-4000-8000-00000000fff0"
  const id = library.sources.property_ids["Source ID"]!
  property(second.properties)[id] = {
    id,
    type: "rich_text",
    rich_text: sourceRich("second-failed-source"),
  }
  f.pages.set(String(second.id), second)
  const result = await f.run(discoverRegisteredSourceMembers(library))
  expect(result).toMatchObject({
    coverage: "partial",
    candidates: [],
    effects: { remote_writes: "none" },
  })
  expect(result.failures).toEqual([
    { source_id: sourceId, code: "SOURCE_ADAPTER_OPTIONS_UNSUPPORTED" },
    { source_id: "second-failed-source", code: "SOURCE_ADAPTER_OPTIONS_UNSUPPORTED" },
  ])
  expect(f.mutations()).toEqual([])
})
