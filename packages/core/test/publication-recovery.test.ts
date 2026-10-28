import { resumePublicationListRepair } from "../src/publication-recovery.ts"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { createSkill, resumePublication } from "../src/mutation.ts"
import { decode, fail, property } from "../src/model.ts"
import { Notion } from "../src/notion.ts"
import { reconcilePublication } from "../src/publication-reconcile.ts"
import { publicationOwnership, PublicationReadOperation } from "../src/publication-integrity.ts"
import {
  creationMarkerProof,
  creationProofFromBody,
  withoutCreationMarker,
} from "../src/publication-create-identity.ts"
import { openSkill } from "../src/snapshot.ts"
import { snapshotAuthoredPortable } from "../src/export.ts"
import { reconcileOperation, resumeOperation } from "../src/command-operations.ts"
import { PublicationReceiptSchema } from "../src/publication-model.ts"
import { restoreOrderedListStart } from "../src/markdown-blocks.ts"
import { zeroStartPresentation } from "../src/markdown.ts"
import { BUNDLE, bodyIdentity, portableZip } from "../src/portable.ts"
import { importDocument } from "../src/import.ts"
import {
  proveRetainedZeroListOwner,
  zeroListSourceBundleInput,
} from "../src/publication-zero-list-source.ts"
import {
  database,
  root,
  encoder,
  fixture,
  originalListFence,
  historicalAttachedZeroSource,
  historicalListRepair,
} from "./publication-recovery.fixture.ts"

test("list-start repair refuses unsupported before-effect writes without changing the original fence or receipt", async () => {
  const { f, id, receipt, receiptHash, observe } = await originalListFence()
  const original = structuredClone(receipt())
  const hash = receiptHash()
  expect((await observe()).outcome).toBe("before")
  expect(receiptHash()).toBe(hash)
  const refused = await f.run(resumePublicationListRepair(id).pipe(Effect.result))
  expect(refused._tag).toBe("Failure")
  if (refused._tag === "Failure") {
    expect(property(refused.failure).code).toBe("UNSUPPORTED_MARKDOWN")
    expect(property(property(refused.failure).details).field).toBe(
      "numbered_list_item.list_start_index",
    )
  }
  expect(f.listPatches()).toBe(0)
  expect(receiptHash()).toBe(hash)
  expect(receipt()).toEqual(original)
  expect(receipt().owner).toBeUndefined()
  expect(receipt().conflict).toBe(true)
  const reassessed = await f.run(reconcileOperation(id))
  expect(reassessed.verified).toBe(false)
  expect(receipt().conflict).toBe(true)
  expect(f.listPatches()).toBe(0)
}, 15000)

for (const response of ["before", "after", "interrupt"] as const) {
  test(`list-start repair classifies historical ${response} response loss without replaying an unsupported PATCH`, async () => {
    const { f, id, receipt, receiptHash, observe } = await historicalListRepair(
      response === "interrupt" ? "pending" : "unknown",
    )
    const original = structuredClone(receipt())
    const hash = receiptHash()
    if (response === "after") f.applyListEffect()
    expect((await observe()).outcome).toBe(response === "after" ? "applied" : "before")
    expect(receiptHash()).toBe(hash)
    if (response === "after") {
      const settled = await f.run(resumeOperation(id))
      expect(settled.verified).toBe(false)
      expect(settled.next.argv).toEqual(["ntn-skills", "operation", "reconcile", id])
      expect(receipt().intents).toHaveLength(original.intents.length)
      expect(receipt().intents.slice(0, -1)).toEqual(original.intents.slice(0, -1))
      const first = original.intents.at(-1)!
      const last = receipt().intents.at(-1)!
      expect(last.status).toBe("completed")
      expect(last.body).toEqual(first.body)
      expect(last.guards).toEqual(first.guards)
      expect(last.list_start_repair).toEqual(first.list_start_repair)
      expect(property(last.response).prior_status).toBe("unknown")
      expect(property(last.response).recovery).toBe("observed_applied")
    } else {
      const refused = await f.run(resumeOperation(id).pipe(Effect.result))
      expect(refused._tag).toBe("Failure")
      if (refused._tag === "Failure")
        expect(property(refused.failure).code).toBe("UNSUPPORTED_MARKDOWN")
      expect(receiptHash()).toBe(hash)
      expect(receipt()).toEqual(original)
    }
    expect(receipt().owner).toBeUndefined()
    expect(receipt().conflict).toBe(true)
    expect(f.listPatches()).toBe(0)
    expect(f.pagePosts).toHaveLength(1)
  }, 15000)
}

test("list-start repair observes stable owner file identity without authorizing an unsupported write", async () => {
  const { f, id, receipt, receiptHash, observe } = await originalListFence("stable")
  const ownerPath = `v1/pages/${root}`
  const evidence = structuredClone(
    property(property(receipt().guards[ownerPath]).properties).Evidence,
  )
  expect(property((property(evidence).files as unknown[])[0]).id).toBe(
    "77777777-7777-4777-8777-777777777777",
  )
  const original = structuredClone(receipt())
  const hash = receiptHash()
  expect((await observe()).outcome).toBe("before")
  const refused = await f.run(resumePublicationListRepair(id).pipe(Effect.result))
  expect(refused._tag).toBe("Failure")
  if (refused._tag === "Failure")
    expect(property(refused.failure).code).toBe("UNSUPPORTED_MARKDOWN")
  expect(f.listPatches()).toBe(0)
  expect(receiptHash()).toBe(hash)
  expect(receipt()).toEqual(original)
  expect(property(property(receipt().guards[ownerPath]).properties).Evidence).toEqual(evidence)
})

test("list-start repair requires owner file identity before deriving or sending a correction", async () => {
  const { f, id, receipt, receiptHash } = await originalListFence("missing")
  const original = structuredClone(receipt())
  const hash = receiptHash()
  const refused = await f.run(resumeOperation(id).pipe(Effect.result))
  expect(refused._tag).toBe("Failure")
  if (refused._tag === "Failure")
    expect(property(refused.failure).code).toBe("PUBLICATION_LIST_REPAIR_UNPROVEN")
  expect(f.listPatches()).toBe(0)
  expect(receiptHash()).toBe(hash)
  expect(receipt()).toEqual(original)
})

test("list-start repair never settles a historical lost-after send when current owner file identity is missing", async () => {
  const { f, id, receipt, receiptHash } = await historicalListRepair("unknown", "stable")
  const retained = structuredClone(receipt())
  const hash = receiptHash()
  f.applyListEffect()
  f.setEvidenceIdentity("missing")
  expect((await f.run(resumeOperation(id).pipe(Effect.result)))._tag).toBe("Failure")
  expect(f.listPatches()).toBe(0)
  expect(receiptHash()).toBe(hash)
  expect(receipt()).toEqual(retained)
})

for (const ownerEvidence of ["missing", "wrong_id"] as const) {
  test(`list-start repair refuses ${ownerEvidence} retained owner evidence without replacing it with a fresh read`, async () => {
    const { f, id, receipt, receiptHash } = await historicalListRepair("unknown")
    f.applyListEffect()
    // Corrupt only retained authority in this explicitly historical fixture.
    // Fresh observations must never manufacture the missing original guard.
    const incomplete = structuredClone(receipt())
    const ownerPath = `v1/pages/${root}`
    if (ownerEvidence === "missing") delete incomplete.guards[ownerPath]
    else
      incomplete.guards[ownerPath] = {
        ...property(incomplete.guards[ownerPath]),
        id: "99999999-9999-4999-8999-999999999999",
      }
    f.json.set("publications/" + id + ".json", incomplete)
    const retained = structuredClone(receipt())
    const hash = receiptHash()
    const refused = await f.run(resumeOperation(id).pipe(Effect.result))
    expect(refused._tag).toBe("Failure")
    if (refused._tag === "Failure")
      expect(property(refused.failure).code).toBe("PUBLICATION_LIST_REPAIR_UNPROVEN")
    expect(f.listPatches()).toBe(0)
    expect(receiptHash()).toBe(hash)
    expect(receipt()).toEqual(retained)
    expect(receipt().owner).toBeUndefined()
    expect(receipt().conflict).toBe(true)
  })
}

test("list-start repair preserves a definitive rejected request before-effect without rewriting its history", async () => {
  const { f, id, receipt, receiptHash, observe } = await historicalListRepair("failed")
  const retained = structuredClone(receipt())
  const hash = receiptHash()
  expect(retained.intents.at(-1)?.response).toBeUndefined()
  expect((await observe()).outcome).toBe("before")
  const refused = await f.run(resumePublicationListRepair(id).pipe(Effect.result))
  expect(refused._tag).toBe("Failure")
  if (refused._tag === "Failure")
    expect(property(refused.failure).code).toBe("UNSUPPORTED_MARKDOWN")
  expect(receiptHash()).toBe(hash)
  expect(receipt()).toEqual(retained)
  expect(receipt().intents.at(-1)?.status).toBe("failed")
  expect(receipt().intents.at(-1)?.response).toBeUndefined()
  expect(receipt().owner).toBeUndefined()
  expect(receipt().conflict).toBe(true)
  expect(f.listPatches()).toBe(0)
})

test("list-start repair never promotes a definitive failed send after a later matching external effect", async () => {
  const { f, id, receipt, receiptHash } = await historicalListRepair("failed")
  const retained = structuredClone(receipt())
  const hash = receiptHash()
  f.applyListEffect()
  expect((await f.run(resumeOperation(id).pipe(Effect.result)))._tag).toBe("Failure")
  expect(f.listPatches()).toBe(0)
  expect(receiptHash()).toBe(hash)
  expect(receipt()).toEqual(retained)
})

for (const laterEffect of [false, true]) {
  test(`list-start repair preserves durable no-effect history after a pre-successor crash with after=${laterEffect}`, async () => {
    const { f, id, receipt, receiptHash, observe } = await historicalListRepair(
      "failed",
      undefined,
      true,
    )
    const retained = structuredClone(receipt())
    const hash = receiptHash()
    const historical = retained.intents.at(-1)!
    expect(historical.status).toBe("failed")
    expect(property(historical.response).recovery).toBe("known_not_applied")
    expect(property(historical.response).prior_status).toBe("unknown")
    expect(property(historical.response).replayed_by_intent).toBe(retained.intents.length)
    if (laterEffect) f.applyListEffect()
    else expect((await observe()).outcome).toBe("before")
    const refused = await f.run(resumeOperation(id).pipe(Effect.result))
    expect(refused._tag).toBe("Failure")
    if (refused._tag === "Failure")
      expect(property(refused.failure).code).toBe(
        laterEffect ? "PUBLICATION_LIST_REPAIR_UNPROVEN" : "UNSUPPORTED_MARKDOWN",
      )
    expect(receiptHash()).toBe(hash)
    expect(receipt()).toEqual(retained)
    expect(receipt().owner).toBeUndefined()
    expect(receipt().conflict).toBe(true)
    expect(f.listPatches()).toBe(0)
  }, 15000)
}

test("list-start repair refuses acknowledged no-effect and never replays that PATCH", async () => {
  const { f, id, receipt, receiptHash } = await historicalListRepair("completed")
  const before = structuredClone(receipt())
  const hash = receiptHash()
  expect((await f.run(resumeOperation(id).pipe(Effect.result)))._tag).toBe("Failure")
  expect(f.listPatches()).toBe(0)
  expect(receiptHash()).toBe(hash)
  expect(receipt()).toEqual(before)
  expect(receipt().owner).toBeUndefined()
  expect(receipt().conflict).toBe(true)
})

for (const changed of ["body", "metadata", "root_order", "source_object"] as const) {
  test(`list-start repair preserves the fence and sends zero PATCHes after changed ${changed}`, async () => {
    const { f, id, receipt, receiptHash } = await originalListFence()
    const original = structuredClone(receipt())
    const hash = receiptHash()
    if (changed === "body") f.editRoot("# Sample\n\n1. External words.\n2. Keep `code` exact.\n")
    else if (changed === "metadata")
      f.editProperties({
        Description: {
          rich_text: [{ type: "text", text: { content: "An external description." } }],
        },
      })
    else if (changed === "root_order") f.editListRoots((roots) => [roots[1]!, roots[0]!, roots[2]!])
    else
      f.objects.set(
        `objects/${receipt().portable.files[0]!.sha256}`,
        encoder.encode("Changed immutable source bytes"),
      )
    expect((await f.run(resumeOperation(id).pipe(Effect.result)))._tag).toBe("Failure")
    expect(f.listPatches()).toBe(0)
    expect(receiptHash()).toBe(hash)
    expect(receipt()).toEqual(original)
  })
}

test("new list-start writes reject the unsupported public field before sending a correction", async () => {
  const f = fixture("list_normal", await mkdtemp(join(tmpdir(), "publication-list-new-")))
  const saved = await f.run(createSkill("/input", { database }).pipe(Effect.result))
  expect(saved._tag).toBe("Failure")
  if (saved._tag !== "Failure") throw new Error("Expected unsupported zero-start rejection")
  const details = property(property(saved.failure).details)
  expect(details.cause_code).toBe("UNSUPPORTED_MARKDOWN")
  const id = String(details.operation_id)
  const receipt = decode(PublicationReceiptSchema, f.json.get("publications/" + id + ".json"))
  expect(receipt.state).not.toBe("completed")
  expect(receipt.intents.some((intent) => intent.list_start_repair)).toBe(false)
  expect(
    receipt.intents.some(
      (intent) => intent.path.endsWith("/markdown") && intent.status === "completed",
    ),
  ).toBe(true)
  expect(f.listPatches()).toBe(0)
  expect((await f.run(reconcileOperation(id))).verified).toBe(false)
  expect(f.pagePosts).toHaveLength(1)
})

test("list-start restoration refuses unsupported writes even without a publication transport", async () => {
  const { f, receipt, receiptHash } = await originalListFence()
  const source = receipt().intents.find((intent) => intent.path.endsWith("/markdown"))!
  const target = property(property(source.body).replace_content).new_str
  expect(typeof target).toBe("string")
  const hash = receiptHash()
  const refused = await f.run(
    Notion.pipe(
      Effect.flatMap((api) => restoreOrderedListStart(root, String(target), api)),
      Effect.result,
    ),
  )
  expect(refused._tag).toBe("Failure")
  if (refused._tag === "Failure")
    expect(property(refused.failure).code).toBe("UNSUPPORTED_MARKDOWN")
  expect(receiptHash()).toBe(hash)
  expect(f.listPatches()).toBe(0)
})

for (const failure of ["registration", "body"] as const) {
  test(`receipt resumes ${failure} with frozen input and stable page identities`, async () => {
    const f = fixture(failure, await mkdtemp(join(tmpdir(), "publication-recovery-")))
    const stopped = await f.run(createSkill("/input", { database }).pipe(Effect.result))
    expect(stopped._tag).toBe("Failure")
    if (stopped._tag !== "Failure") return
    const details = property(stopped.failure.details)
    expect(details.operation_id).toMatch(/^p_/)
    expect(details.receipt_path).toBe(`sqlite:publications/${details.operation_id}`)
    const receipt = f.json.get(`publications/${details.operation_id}.json`)
    expect(property(receipt).state).toBe(failure === "registration" ? "failed" : "unknown")
    const intents = property(receipt).intents as Array<{ status: string }>
    expect(intents.some((intent) => intent.status === "unknown")).toBe(failure === "body")
    expect(intents.some((intent) => intent.status === "failed")).toBe(failure === "registration")
    const ids = f.children.map((child) => child.id)
    f.input.set(
      "references/policy.md",
      encoder.encode("Changed local source must never be published.\n"),
    )
    const saved = await f.run(resumePublication(String(details.operation_id)))
    expect(property(saved).operation_id).toBe(String(details.operation_id))
    expect(f.children.map((child) => child.id).slice(0, ids.length)).toEqual(ids)
    expect(f.children).toHaveLength(2)
    expect(f.children.find((child) => child.title === "policy.md")!.body).toContain(
      "keep original page identities",
    )
    const writes = f.mutations()
    expect(await f.run(resumePublication(String(details.operation_id)))).toEqual(saved)
    expect(f.mutations()).toBe(writes)
  })
}

for (const externalOwnership of [false, true]) {
  test(`partial-create reassessment ${externalOwnership ? "rejects external ownership changes" : "accepts pending final ownership and resumes the original publication"}`, async () => {
    const f = fixture(
      "body",
      await mkdtemp(join(tmpdir(), "publication-ownership-checkpoint-")),
      true,
    )
    const ownership = {
      subscription_id: "55555555-5555-4555-8555-555555555555",
      member_key: "skills/sample-skill",
      mode: "tracked",
      published_hash: "a".repeat(64),
      revision: "upstream-revision-a",
    } satisfies NonNullable<NonNullable<Parameters<typeof createSkill>[1]>["ownership"]>
    const stopped = await f.run(createSkill("/input", { database, ownership }).pipe(Effect.result))
    if (stopped._tag !== "Failure") throw new Error("Expected lost body response")
    expect(stopped.failure.code).toMatch(/^(WRITE_OUTCOME_UNKNOWN|WRITE_PARTIAL)$/)
    expect(property(stopped.failure.details).operation_id).toEqual(expect.any(String))
    const id = String(property(stopped.failure.details).operation_id)
    const beforeObservation = f.mutations()
    expect(await f.run(reconcilePublication(id))).toMatchObject({
      outcome: "success",
      verified: false,
    })
    expect(f.mutations()).toBe(beforeObservation)
    const receipt = property(f.json.get(`publications/${id}.json`))
    expect(property(receipt.context).ownership).toEqual(ownership)
    if (!Array.isArray(receipt.intents)) throw new Error("Expected publication intents")
    expect(receipt.intents.every((intent) => property(intent).status === "completed")).toBe(true)
    const ownershipFields = new Set([
      "Upstream",
      "upstream",
      "Sync Mode",
      "mode",
      "Upstream Key",
      "key",
      "Upstream Revision",
      "revision",
      "Published Hash",
      "hash",
      "Fork Baseline",
      "baseline",
    ])
    expect(
      receipt.intents.some((intent) =>
        Object.keys(property(property(property(intent).body).properties)).some((key) =>
          ownershipFields.has(key),
        ),
      ),
    ).toBe(false)
    expect(publicationOwnership(f.rootPage())).toEqual({
      upstream: [],
      mode: "",
      key: "",
      revision: "",
      hash: "",
      baseline: "",
    })
    const createdPages = f.pagePosts.length
    const childIds = f.children.map((child) => child.id)
    f.json.set(`publications/${id}.json`, { ...receipt, conflict: true, state: "failed" })
    if (externalOwnership) f.editProperties({ mode: { select: { name: "fork" } } })
    const observed = await f.run(reconcilePublication(id))
    expect(observed).toMatchObject({
      outcome: externalOwnership ? "conflict" : "success",
      verified: false,
    })
    expect(f.mutations()).toBe(beforeObservation)
    const reassessed = property(f.json.get(`publications/${id}.json`))
    expect(reassessed.intents).toEqual(receipt.intents)
    expect(reassessed.guards).toEqual(receipt.guards)
    if (externalOwnership) {
      expect(reassessed.conflict).toBe(true)
      const refused = await f.run(resumePublication(id).pipe(Effect.result))
      expect(refused._tag === "Failure" && refused.failure.code).toBe("WRITE_CONFLICT")
      expect(f.mutations()).toBe(beforeObservation)
    } else {
      expect(reassessed.conflict).toBeUndefined()
      expect(reassessed.state).not.toBe("completed")
      const resumed = await f.run(resumePublication(id))
      expect(property(resumed).operation_id).toBe(id)
      expect(property(f.json.get(`publications/${id}.json`)).state).toBe("completed")
      expect(f.pagePosts).toHaveLength(createdPages)
      expect(f.children.map((child) => child.id)).toEqual(childIds)
      expect(publicationOwnership(f.rootPage())).toEqual({
        upstream: [ownership.subscription_id],
        mode: ownership.mode,
        key: ownership.member_key,
        revision: ownership.revision,
        hash: ownership.published_hash,
        baseline: "",
      })
      expect(await f.run(reconcilePublication(id))).toMatchObject({
        outcome: "success",
        verified: true,
      })
    }
  }, 20_000)
}

test("receipt rejects external root or unregistered child edits without a mutation", async () => {
  for (const target of ["root", "child"] as const) {
    const f = fixture("registration", await mkdtemp(join(tmpdir(), "publication-conflict-")))
    const stopped = await f.run(createSkill("/input", { database }).pipe(Effect.result))
    if (stopped._tag !== "Failure") throw new Error("Expected registration interruption")
    if (target === "root") f.editRoot("External author edit")
    else f.children[0]!.body = "External author edit"
    const writes = f.mutations()
    const resumed = await f.run(
      resumePublication(String(property(stopped.failure.details).operation_id)).pipe(Effect.result),
    )
    expect(resumed._tag === "Failure" && resumed.failure.code).toBe("WRITE_CONFLICT")
    expect(f.mutations()).toBe(writes)
  }
})

test("resume rejects changed References membership despite changing request trace IDs", async () => {
  const f = fixture("body", await mkdtemp(join(tmpdir(), "publication-reference-conflict-")))
  const stopped = await f.run(createSkill("/input", { database }).pipe(Effect.result))
  if (stopped._tag !== "Failure") throw new Error("Expected body interruption")
  f.omitFirstReference()
  const writes = f.mutations()
  const resumed = await f.run(
    resumePublication(String(property(stopped.failure.details).operation_id)).pipe(Effect.result),
  )
  expect(resumed._tag === "Failure" && resumed.failure.code).toBe("WRITE_CONFLICT")
  expect(f.mutations()).toBe(writes)
})

test("receipt rejects another credential scope without a mutation", async () => {
  const f = fixture("registration", await mkdtemp(join(tmpdir(), "publication-scope-")))
  const stopped = await f.run(createSkill("/input", { database }).pipe(Effect.result))
  if (stopped._tag !== "Failure") throw new Error("Expected registration interruption")
  f.setCredential("another-credential")
  const writes = f.mutations()
  const resumed = await f.run(
    resumePublication(String(property(stopped.failure.details).operation_id)).pipe(Effect.result),
  )
  expect(resumed._tag === "Failure" && resumed.failure.code).toBe("PUBLICATION_SCOPE_MISMATCH")
  expect(f.mutations()).toBe(writes)
})

test("receipt never retries a create with an unknown response", async () => {
  const f = fixture("create", await mkdtemp(join(tmpdir(), "publication-create-")))
  const stopped = await f.run(createSkill("/input", { database }).pipe(Effect.result))
  if (stopped._tag !== "Failure") throw new Error("Expected unknown creation outcome")
  const writes = f.mutations()
  const id = String(property(stopped.failure.details).operation_id)
  for (let attempt = 0; attempt < 2; attempt++) {
    const resumed = await f.run(
      resumePublication(id, { newArtifact: attempt === 1 }).pipe(Effect.result),
    )
    expect(resumed._tag === "Failure" && resumed.failure.code).toBe("PUBLICATION_UNRESOLVED")
  }
  expect(f.mutations()).toBe(writes)
}, 20_000)

test("progress failure preserves durable intent and default publication is silent", async () => {
  const f = fixture("registration", await mkdtemp(join(tmpdir(), "publication-progress-")))
  const events: string[] = []
  const stopped = await f.run(
    createSkill("/input", {
      database,
      onProgress: (event) =>
        Effect.sync(() => {
          events.push(event.stage)
        }),
    }).pipe(Effect.result),
  )
  expect(events).toContain("prepare")
  if (stopped._tag !== "Failure") throw new Error("Expected registration interruption")
  const id = String(property(stopped.failure.details).operation_id)
  const writes = f.mutations()
  const observer = await f.run(
    resumePublication(id, {
      onProgress: () => Effect.fail(fail("PROGRESS_OUTPUT_FAILED", "Sink closed")),
    }).pipe(Effect.result),
  )
  expect(observer._tag === "Failure" && observer.failure.code).toBe("PROGRESS_OUTPUT_FAILED")
  expect(f.json.has(`publications/${id}.json`)).toBe(true)
  expect(f.mutations()).toBe(writes)
})

test("dry-run reports progress without creating a receipt or sending a write", async () => {
  const f = fixture("registration", await mkdtemp(join(tmpdir(), "publication-dry-")))
  const events: string[] = []
  const result = await f.run(
    createSkill("/input", {
      database,
      dryRun: true,
      onProgress: (event) =>
        Effect.sync(() => {
          events.push(event.stage)
        }),
    }),
  )
  expect(result).not.toHaveProperty("receipt_path")
  expect([...f.json.keys()].filter((key) => key.startsWith("publications/"))).toHaveLength(0)
  expect(f.mutations()).toBe(0)
  expect(events).toContain("prepare")
})

test("a conflict detected during a stage stays fenced on the next resume", async () => {
  const f = fixture("registration", await mkdtemp(join(tmpdir(), "publication-fenced-")))
  const stopped = await f.run(createSkill("/input", { database }).pipe(Effect.result))
  if (stopped._tag !== "Failure") throw new Error("Expected registration interruption")
  const id = String(property(stopped.failure.details).operation_id)
  const writes = f.mutations()
  const failed = await f.run(
    resumePublication(id, {
      onProgress: (event) =>
        event.stage === "validate" && event.status === "started"
          ? Effect.sync(() => {
              f.editRoot("External author changed the body during version validation")
            })
          : Effect.void,
    }).pipe(Effect.result),
  )
  expect(failed._tag === "Failure" && failed.failure.code).toBe("WRITE_CONFLICT")
  const repeated = await f.run(resumePublication(id).pipe(Effect.result))
  expect(repeated._tag === "Failure" && repeated.failure.code).toBe("WRITE_CONFLICT")
  expect(f.mutations()).toBe(writes)
})

test("a process exit during version validation cannot authorize external content on resume", async () => {
  const f = fixture("registration", await mkdtemp(join(tmpdir(), "publication-crash-")))
  const stopped = await f.run(createSkill("/input", { database }).pipe(Effect.result))
  if (stopped._tag !== "Failure") throw new Error("Expected registration interruption")
  const id = String(property(stopped.failure.details).operation_id)
  const writes = f.mutations()
  await expect(
    f.run(
      resumePublication(id, {
        onProgress: (event) =>
          event.stage === "validate" && event.status === "started"
            ? Effect.sync(() => {
                f.editRoot("External author edit read before the process exited")
                f.crashAfterRootRead()
              })
            : Effect.void,
      }),
    ),
  ).rejects.toThrow("Process exited during version validation")
  // Model the dead process releasing ownership while retaining its durable receipt.
  const key = `publications/${id}.json`
  const receipt = { ...property(f.json.get(key)) }
  delete receipt.owner
  f.json.set(key, receipt)
  const resumed = await f.run(resumePublication(id).pipe(Effect.result))
  expect(resumed._tag === "Failure" && resumed.failure.code).toBe("WRITE_CONFLICT")
  expect(f.mutations()).toBe(writes)
})

test("resume rejects an external edit between preflight and the first continuation read", async () => {
  const f = fixture("registration", await mkdtemp(join(tmpdir(), "publication-handoff-")))
  const stopped = await f.run(createSkill("/input", { database }).pipe(Effect.result))
  if (stopped._tag !== "Failure") throw new Error("Expected registration interruption")
  const id = String(property(stopped.failure.details).operation_id)
  const writes = f.mutations()
  const resumed = await f.run(
    resumePublication(id, {
      onProgress: (event) =>
        event.stage === "resume_preflight" && event.status === "started"
          ? Effect.sync(() => {
              f.onNextReceiptWrite(() => f.editRoot("External edit after preflight"))
            })
          : Effect.void,
    }).pipe(Effect.result),
  )
  expect(resumed._tag === "Failure" && resumed.failure.code).toBe("WRITE_CONFLICT")
  expect(f.mutations()).toBe(writes)
})

test("failed final readback never authorizes external edits on a later resume", async () => {
  const f = fixture("registration", await mkdtemp(join(tmpdir(), "publication-readback-")))
  const stopped = await f.run(createSkill("/input", { database }).pipe(Effect.result))
  if (stopped._tag !== "Failure") throw new Error("Expected registration interruption")
  const id = String(property(stopped.failure.details).operation_id)
  const failed = await f.run(
    resumePublication(id, {
      onProgress: (event) =>
        event.stage === "verify" && event.status === "started"
          ? Effect.sync(() => f.editRoot("External edit during final readback"))
          : Effect.void,
    }).pipe(Effect.result),
  )
  expect(failed._tag === "Failure" && failed.failure.code).toBe("WRITE_PARTIAL")
  const writes = f.mutations()
  const resumed = await f.run(resumePublication(id).pipe(Effect.result))
  expect(resumed._tag === "Failure" && resumed.failure.code).toBe("WRITE_CONFLICT")
  expect(f.mutations()).toBe(writes)
}, 20_000)

test("resume refuses an initial publication that is still running", async () => {
  const f = fixture("registration", await mkdtemp(join(tmpdir(), "publication-active-")))
  let rejected = false
  const stopped = await f.run(
    createSkill("/input", {
      database,
      onProgress: (event) =>
        event.stage === "create_page" && event.status === "started"
          ? Effect.gen(function* () {
              const before = f.mutations()
              const result = yield* Effect.promise(() =>
                f.run(resumePublication(event.operation_id).pipe(Effect.result)),
              )
              expect(result._tag === "Failure" && result.failure.code).toBe("PUBLICATION_LOCKED")
              expect(f.mutations()).toBe(before)
              rejected = true
            })
          : Effect.void,
    }).pipe(Effect.result),
  )
  expect(rejected).toBe(true)
  expect(stopped._tag).toBe("Failure")
})

for (const proven of [false, true]) {
  test(`reconciliation ${proven ? "proves an unknown create by exact operation marker" : "never guesses an unproven unknown create"}`, async () => {
    const f = fixture("create", await mkdtemp(join(tmpdir(), "publication-reconcile-create-")))
    const stopped = await f.run(createSkill("/input", { database }).pipe(Effect.result))
    if (stopped._tag !== "Failure") throw new Error("Expected lost create response")
    const id = String(property(stopped.failure.details).operation_id)
    if (!proven) f.clearPublication()
    const writes = f.mutations()
    const result = await f.run(reconcilePublication(id))
    expect(result.outcome).toBe(proven ? "success" : "unknown")
    expect(result.verified).toBe(false)
    expect(property(f.json.get(`publications/${id}.json`)).page_id).toBe(proven ? root : undefined)
    expect(f.mutations()).toBe(writes)
    if (proven) {
      await f.run(resumePublication(id))
      expect(f.children).toHaveLength(2)
      expect(property(f.json.get(`publications/${id}.json`)).state).toBe("completed")
      const settled = await f.run(reconcilePublication(id))
      expect(settled.verified).toBe(true)
    } else {
      const resumed = await f.run(resumePublication(id).pipe(Effect.result))
      expect(resumed._tag === "Failure" && resumed.failure.code).toBe("PUBLICATION_UNRESOLVED")
      expect(f.mutations()).toBe(writes)
    }
  }, 20_000)
}

for (const conflict of [false, true]) {
  test(`property reconciliation ${conflict ? "fences an external body edit" : "settles exact known PATCH content"} without writing`, async () => {
    const f = fixture(
      "registration",
      await mkdtemp(join(tmpdir(), "publication-reconcile-properties-")),
    )
    const stopped = await f.run(createSkill("/input", { database }).pipe(Effect.result))
    if (stopped._tag !== "Failure") throw new Error("Expected registration interruption")
    const id = String(property(stopped.failure.details).operation_id)
    await f.run(resumePublication(id))
    const receipt = property(f.json.get(`publications/${id}.json`))
    f.json.set(`publications/${id}.json`, {
      ...receipt,
      state: "unknown",
      result: undefined,
      failure: undefined,
      context: { write_path: "@properties" },
      intents: [
        {
          path: `v1/pages/${root}`,
          method: "PATCH",
          status: "unknown",
          body: {
            properties: {
              description: { rich_text: [{ text: { content: "Use for recovery." } }] },
            },
          },
        },
      ],
    })
    if (conflict) f.editRoot("External author body edit")
    const writes = f.mutations()
    const result = await f.run(reconcilePublication(id))
    expect(result.outcome).toBe(conflict ? "conflict" : "success")
    expect(result.verified).toBe(!conflict)
    const saved = property(f.json.get(`publications/${id}.json`))
    expect(saved.state).toBe(conflict ? "failed" : "completed")
    expect(result.next.argv).toEqual(["ntn-skills", "read", root, "--refresh"])
    expect(f.mutations()).toBe(writes)
  })
}

for (const kind of ["create", "child_create"] as const) {
  test(`creation identity recovers real initial ${kind} POST after complete pagination with no extra POST`, async () => {
    const f = fixture(kind, await mkdtemp(join(tmpdir(), "publication-create-proof-")))
    const stopped = await f.run(createSkill("/input", { database }).pipe(Effect.result))
    if (stopped._tag !== "Failure") throw new Error("Expected lost initial POST response")
    const id = String(property(stopped.failure.details).operation_id)
    const finalPayload = f.pagePosts.at(-1)
    const proof = creationProofFromBody(finalPayload)!
    expect(proof.operation_id).toBe(id)
    expect(proof.role).toBe(kind === "create" ? "content_root" : "reference")
    expect(proof.source_sha256).toMatch(/^[a-f0-9]{64}$/)
    if (kind === "create") f.setQueryMode("paged")
    else {
      f.setChildInventoryMode("paged")
      f.children[0]!.body = f.children[0]!.body.replaceAll(":", "\\:")
    }
    const posts = f.pagePosts.length
    const result = await f.run(reconcilePublication(id))
    expect(result.outcome).toBe("success")
    expect(f.pagePosts.length).toBe(posts)
    const receipt = property(f.json.get(`publications/${id}.json`))
    const discovery = property((receipt.creation_discovery as unknown[])[0])
    expect(discovery.complete).toBe(true)
    expect(discovery.candidate_count).toBe(1)
    expect(property((receipt.intents as unknown[]).at(-1)).status).toBe("completed")
  })
}

for (const mode of ["duplicate", "partial"] as const) {
  test(`creation identity refuses ${mode} root discovery without replay`, async () => {
    const f = fixture("create", await mkdtemp(join(tmpdir(), "publication-create-unsafe-")))
    const stopped = await f.run(createSkill("/input", { database }).pipe(Effect.result))
    if (stopped._tag !== "Failure") throw new Error("Expected lost root response")
    const id = String(property(stopped.failure.details).operation_id)
    f.setQueryMode(mode)
    const writes = f.mutations()
    const result = await f.run(reconcilePublication(id))
    expect(result.outcome).toBe("unknown")
    expect(property(f.json.get(`publications/${id}.json`)).page_id).toBeUndefined()
    expect(f.mutations()).toBe(writes)
  })
}

test("creation identity refuses duplicated child marker and fences changed parent inventory", async () => {
  const f = fixture("child_create", await mkdtemp(join(tmpdir(), "publication-child-duplicate-")))
  const stopped = await f.run(createSkill("/input", { database }).pipe(Effect.result))
  if (stopped._tag !== "Failure") throw new Error("Expected lost child response")
  const id = String(property(stopped.failure.details).operation_id)
  f.duplicateChild()
  const writes = f.mutations()
  expect((await f.run(reconcilePublication(id))).outcome).toBe("conflict")
  expect(f.mutations()).toBe(writes)
})

test("creation identity excludes same-path other operation and fences unrelated parent changes", async () => {
  const f = fixture("child_create", await mkdtemp(join(tmpdir(), "publication-child-other-")))
  const stopped = await f.run(createSkill("/input", { database }).pipe(Effect.result))
  if (stopped._tag !== "Failure") throw new Error("Expected lost child response")
  const id = String(property(stopped.failure.details).operation_id)
  f.duplicateChild(true)
  const writes = f.mutations()
  const result = await f.run(reconcilePublication(id).pipe(Effect.result))
  expect(result._tag === "Failure" && result.failure.code).toBe("WRITE_CONFLICT")
  expect(f.mutations()).toBe(writes)
})

test("creation identity marker survives authored replacement without source pollution", async () => {
  const f = fixture("registration", await mkdtemp(join(tmpdir(), "publication-marker-source-")))
  const stopped = await f.run(createSkill("/input", { database }).pipe(Effect.result))
  if (stopped._tag !== "Failure") throw new Error("Expected registration interruption")
  const id = String(property(stopped.failure.details).operation_id)
  await f.run(resumePublication(id))
  const exported = await f.run(
    snapshotAuthoredPortable(await f.run(openSkill(root, { database, refresh: true }))),
  )
  for (const file of exported.files)
    expect(new TextDecoder().decode(file.bytes)).not.toContain("ntn-skills-create")
  for (const child of f.children) {
    expect(creationMarkerProof(child.body)?.operation_id).toBe(id)
    expect(withoutCreationMarker(child.body)).not.toContain("ntn-skills-create")
    expect(withoutCreationMarker(child.body)).toContain("# ")
  }
})

test("creation identity refuses partial child inventory and changed authentication scope", async () => {
  const f = fixture("child_create", await mkdtemp(join(tmpdir(), "publication-child-partial-")))
  const stopped = await f.run(createSkill("/input", { database }).pipe(Effect.result))
  if (stopped._tag !== "Failure") throw new Error("Expected lost child response")
  const id = String(property(stopped.failure.details).operation_id)
  f.setChildInventoryMode("partial")
  const writes = f.mutations()
  expect((await f.run(reconcilePublication(id))).outcome).toBe("unknown")
  expect(f.mutations()).toBe(writes)
  f.setCredential("different")
  const result = await f.run(reconcilePublication(id).pipe(Effect.result))
  expect(result._tag === "Failure" && result.failure.code).toBe("PUBLICATION_SCOPE_MISMATCH")
  expect(f.mutations()).toBe(writes)
})

test("creation identity fences an externally edited root after a lost initial POST", async () => {
  const f = fixture("create", await mkdtemp(join(tmpdir(), "publication-root-edited-")))
  const stopped = await f.run(createSkill("/input", { database }).pipe(Effect.result))
  if (stopped._tag !== "Failure") throw new Error("Expected lost root response")
  const id = String(property(stopped.failure.details).operation_id)
  f.editRoot("External accepted content must not be replaced")
  const writes = f.mutations()
  const result = await f.run(reconcilePublication(id).pipe(Effect.result))
  expect(result._tag === "Failure" && result.failure.code).toBe("WRITE_CONFLICT")
  expect(f.mutations()).toBe(writes)
})

test("creation identity recovers the retained legacy child paragraph with escaped colons", async () => {
  const f = fixture("child_create", await mkdtemp(join(tmpdir(), "publication-child-legacy-")))
  const stopped = await f.run(createSkill("/input", { database }).pipe(Effect.result))
  if (stopped._tag !== "Failure") throw new Error("Expected lost child response")
  const id = String(property(stopped.failure.details).operation_id)
  const receipt = property(f.json.get(`publications/${id}.json`))
  const intents = receipt.intents as Array<Record<string, unknown>>
  const index = intents.length - 1
  const marker = `ntn-skills-operation:${id}:${index}`
  const body = property(intents[index]!.body)
  body.children = [
    {
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: [{ type: "text", text: { content: marker } }] },
    },
  ]
  f.children[0]!.body = marker.replaceAll(":", "\\:")
  const writes = f.mutations()
  expect((await f.run(reconcilePublication(id))).outcome).toBe("success")
  expect(f.mutations()).toBe(writes)
  const adopted = property(f.json.get(`publications/${id}.json`)).intents as unknown[]
  expect(property(property(adopted[index]).response).id).toBe(f.children[0]!.id)
})

async function finishLiteralZero(state: Awaited<ReturnType<typeof originalListFence>>) {
  const { f, id, receipt } = state
  const reconciled = await f.run(reconcileOperation(id))
  if (receipt().conflict)
    throw new Error("Literal-zero reassessment remained fenced: " + JSON.stringify(reconciled))
  expect(receipt().conflict_history?.length).toBeGreaterThan(0)
  const result = await f.run(resumeOperation(id))
  expect(result.verified).toBe(true)
  expect(receipt().state).toBe("completed")
  const exported = await f.run(
    snapshotAuthoredPortable(await f.run(openSkill(root, { database, refresh: true }))),
  )
  const main = exported.files.find((file) => file.path === exported.main)
  expect(main?.bytes).toEqual(f.input.get("SKILL.md"))
  expect(f.listPatches()).toBe(0)
  expect(f.pagePosts).toHaveLength(1)
  expect(f.uploadAllocations()).toBe(1)
  expect(f.uploadSends()).toBe(1)
  const count = f.zeroRequests()
  expect((await f.run(resumeOperation(id))).verified).toBe(true)
  expect(f.zeroRequests()).toBe(count)
}

async function retainLiteralZeroAcknowledgement(
  state: Awaited<ReturnType<typeof originalListFence>>,
) {
  const { f, id, receipt } = state
  f.setNotionZeroReadback()
  const crash = () => {
    const intent = receipt().intents.at(-1)
    if (
      intent?.zero_list_repair &&
      intent.status === "completed" &&
      property(intent.response).acknowledgement === "received"
    )
      throw new Error("Process exited after the real literal-zero ACK was persisted")
    f.onNextReceiptWrite(crash)
  }
  f.onNextReceiptWrite(crash)
  await expect(f.run(resumeOperation(id))).rejects.toThrow()
  const acknowledged = structuredClone(receipt().intents.at(-1)!)
  expect(acknowledged.status).toBe("completed")
  expect(property(acknowledged.response).acknowledgement).toBe("received")
  expect(receipt().stages.includes("zero_list_repair_verified")).toBe(false)
  expect(receipt().owner).toBeUndefined()
  expect(f.zeroRequests()).toBe(1)
  return acknowledged
}

for (const rejectedField of [false, true]) {
  test("literal zero proves a retained real ACK with single-LF paragraphs and null icons; old field=" +
    rejectedField, async () => {
    const state = rejectedField
      ? await historicalListRepair("failed", undefined, false, true)
      : await originalListFence(undefined, true)
    const { f, id, receipt } = state
    const prefix = structuredClone(receipt().intents)
    const acknowledged = await retainLiteralZeroAcknowledgement(state)
    const writes = f.mutations()
    await f.run(resumeOperation(id))
    expect(f.mutations()).toBe(writes)
    expect(f.zeroRequests()).toBe(1)
    expect(receipt().intents.slice(0, prefix.length)).toEqual(prefix)
    expect(receipt().intents.at(-1)).toEqual(acknowledged)
    expect(receipt().stages.includes("zero_list_repair_verified")).toBe(true)
    expect(receipt().conflict).toBe(true)
    await finishLiteralZero(state)
    expect(f.zeroRequests()).toBe(1)
    expect(receipt().intents.slice(0, prefix.length)).toEqual(prefix)
  }, 30000)
}

test("literal zero proves a lost response with real paragraph serialization without replay", async () => {
  const state = await originalListFence(undefined, true)
  const { f, id, receipt } = state
  const prefix = structuredClone(receipt().intents)
  f.setNotionZeroReadback()
  f.zeroResponse("unknown_after")
  expect((await f.run(resumeOperation(id).pipe(Effect.result)))._tag).toBe("Failure")
  const unresolved = structuredClone(receipt().intents.at(-1)!)
  expect(unresolved.status).toBe("unknown")
  await f.run(resumeOperation(id))
  expect(f.zeroRequests()).toBe(1)
  const settled = receipt().intents.at(-1)!
  expect(settled.body).toEqual(unresolved.body)
  expect(settled.guards).toEqual(unresolved.guards)
  expect(settled.status).toBe("completed")
  expect(property(settled.response).recovery).toBe("observed_applied")
  expect(receipt().intents.slice(0, prefix.length)).toEqual(prefix)
  await finishLiteralZero(state)
  expect(f.zeroRequests()).toBe(1)
}, 30000)

for (const change of [
  "visible_icon",
  "wrong_digit",
  "code_content",
  "outside_field",
  "owner",
] as const) {
  test("literal zero retained ACK rejects " + change + " without changing history", async () => {
    const state = await originalListFence(undefined, true)
    const { f, id, receipt, receiptHash } = state
    await retainLiteralZeroAcknowledgement(state)
    if (change === "owner")
      f.editProperties({
        description: { rich_text: [{ type: "text", text: { content: "changed owner" } }] },
      })
    else
      f.editListRoots((roots) => {
        const result = structuredClone(roots)
        const paragraph = property(property(result[change === "code_content" ? 2 : 1]).paragraph)
        const spans = paragraph.rich_text
        if (!Array.isArray(spans)) throw new Error("Missing fixture paragraph rich text")
        if (change === "visible_icon") paragraph.icon = { type: "emoji", emoji: "X" }
        if (change === "wrong_digit") property(property(spans[0]).text).content = "1. "
        if (change === "code_content") {
          const code = spans.find((span) => property(property(span).annotations).code)
          property(property(code).text).content = "other"
        }
        if (change === "outside_field") property(property(result[0]).heading_1).color = "red"
        return result
      })
    const retained = receiptHash(),
      writes = f.mutations()
    expect((await f.run(resumeOperation(id).pipe(Effect.result)))._tag).toBe("Failure")
    expect(receiptHash()).toBe(retained)
    expect(f.mutations()).toBe(writes)
    expect(f.zeroRequests()).toBe(1)
    expect(receipt().owner).toBeUndefined()
    expect(receipt().conflict).toBe(true)
  }, 30000)
}

for (const lostResponse of [false, true]) {
  test("literal zero reuses the idless original source through its three ACKs and exact bytes; lost=" +
    lostResponse, async () => {
    const state = await historicalAttachedZeroSource()
    const { f, id, receipt, artifactKey } = state
    const original = structuredClone(receipt())
    const bytes = new Uint8Array(f.objects.get(artifactKey)!)
    expect(
      await f.run(
        proveRetainedZeroListOwner(
          original,
          original.intents.length,
          root,
          original.guards,
          f.rootPage(),
        ),
      ),
    ).toBe(true)
    f.setUploadExpiry("2099-01-01T00:00:00.000Z")
    if (lostResponse) {
      f.zeroResponse("unknown_after")
      expect((await f.run(resumeOperation(id).pipe(Effect.result)))._tag).toBe("Failure")
    }
    await f.run(resumeOperation(id))
    expect(receipt().stages.includes("zero_list_repair_verified")).toBe(true)
    expect(receipt().conflict).toBe(true)
    await finishLiteralZero(state)
    expect(receipt().intents.slice(0, original.intents.length)).toEqual(original.intents)
    expect(f.objects.get(artifactKey)).toEqual(bytes)
    expect(receipt().intents.filter((intent) => intent.path === "v1/file_uploads")).toHaveLength(1)
    expect(f.zeroRequests()).toBe(1)
  }, 30000)
}

test("literal zero source projection reuses the original archive after filename-link localization", async () => {
  const state = await historicalAttachedZeroSource(undefined, true)
  const { f, id, receipt, artifactKey } = state
  const original = structuredClone(receipt())
  const bytes = new Uint8Array(f.objects.get(artifactKey)!)
  f.setNotionZeroReadback()
  f.setUploadExpiry("2099-01-01T00:00:00.000Z")
  await f.run(resumeOperation(id))
  expect(receipt().stages.includes("zero_list_repair_verified")).toBe(true)
  expect(receipt().guards["v1/pages/" + root + "/markdown"]).toContain(
    "Edit [SKILL.md](http://SKILL.md) only.",
  )
  await finishLiteralZero(state)
  expect(receipt().intents.slice(0, original.intents.length)).toEqual(original.intents)
  expect(f.objects.get(artifactKey)).toEqual(bytes)
  expect(receipt().intents.filter((intent) => intent.path === "v1/file_uploads")).toHaveLength(1)
  expect(f.zeroRequests()).toBe(1)
}, 30000)

for (const change of ["text", "destination"] as const) {
  test("literal zero source projection refuses changed " +
    change +
    " with unchanged authored bytes", async () => {
    const state = await historicalAttachedZeroSource(undefined, true)
    const { f, id, receipt, artifactKey } = state
    f.setNotionZeroReadback()
    await f.run(resumeOperation(id))
    await f.run(reconcileOperation(id))
    expect(receipt().conflict).not.toBe(true)
    const snapshot = await f.run(
      openSkill(root, { database, refresh: true }).pipe(
        Effect.provideService(PublicationReadOperation, id),
      ),
    )
    const main = snapshot.files.find((file) => file.path === snapshot.entrypoint)
    const mainBytes = main && f.objects.get("objects/" + main.sha256)
    if (!mainBytes) throw new Error("Missing current checkpoint root")
    const projection = bodyIdentity(
      importDocument(
        { path: snapshot.entrypoint, bytes: mainBytes },
        {
          name: receipt().portable.name,
          description: receipt().portable.description,
        },
      ).body,
    )
    expect(projection).toContain("Edit ")
    expect(projection).toContain("SKILL.md")
    const changed =
      change === "text"
        ? projection.replace("Edit ", "Ignore ")
        : projection.replace(
            /^Edit .* only\.$/m,
            "Edit [SKILL.md](https://other.example/SKILL.md) only.",
          )
    expect(changed).not.toBe(projection)
    const requested = portableZip(
      {
        ...receipt().portable,
        files: receipt().portable.files.map((file) => {
          const bytes = f.objects.get("objects/" + file.sha256)
          if (!bytes) throw new Error("Missing frozen source")
          return { path: file.path, bytes }
        }),
        projection: {
          name: receipt().portable.name,
          description: receipt().portable.description,
          body: changed,
          references: {},
        },
      },
      true,
    )
    const before = structuredClone(receipt()),
      writes = f.mutations()
    const artifact = new Uint8Array(f.objects.get(artifactKey)!)
    const result = await f.run(
      Notion.pipe(
        Effect.flatMap((api) => zeroListSourceBundleInput(receipt(), api, requested, BUNDLE)),
        Effect.result,
      ),
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure")
      expect(result.failure.code).toBe("PUBLICATION_ZERO_SOURCE_UNPROVEN")
    expect(receipt()).toEqual(before)
    expect(f.mutations()).toBe(writes)
    expect(f.objects.get(artifactKey)).toEqual(artifact)
    expect(f.uploadAllocations()).toBe(1)
    expect(f.uploadSends()).toBe(1)
  }, 30000)
}

for (const change of [
  "download_bytes",
  "cache_missing",
  "cache_bytes",
  "source_bytes",
  "send_id",
  "attachment_id",
  "source_zero",
  "duplicate_attachment",
  "null_id",
  "empty_id",
  "other_unstable_file",
  "metadata_bracket",
] as const) {
  test("literal zero idless source still refuses " +
    change +
    " before owner acquisition or writes", async () => {
    const state = await historicalAttachedZeroSource(
      change === "other_unstable_file" ? "missing" : undefined,
    )
    const { f, id, receipt, artifactKey, allocationIndex } = state
    if (change === "download_bytes") f.changeAttachedBytes(encoder.encode("changed attachment"))
    if (change === "cache_missing") f.objects.delete(artifactKey)
    if (change === "cache_bytes")
      f.objects.set(artifactKey, encoder.encode("changed cached archive"))
    if (change === "source_bytes")
      f.objects.set(
        "objects/" + receipt().portable.files[0]!.sha256,
        encoder.encode("changed frozen source"),
      )
    if (change === "send_id" || change === "attachment_id" || change === "source_zero") {
      const modified = structuredClone(receipt())
      if (change === "send_id")
        modified.intents[allocationIndex + 1]!.response = {
          id: "different-upload",
          status: "uploaded",
        }
      if (change === "attachment_id") {
        const fields = property(property(modified.intents[allocationIndex + 2]!.body).properties)
        const files = property(fields.files).files
        if (!Array.isArray(files)) throw new Error("Missing historical source attachment")
        property(property(files[0]).file_upload).id = "different-upload"
      }
      if (change === "source_zero") {
        const path = "v1/pages/" + root + "/markdown"
        modified.guards[path] = String(modified.guards[path]).replace(/^1\. First/m, "0. First")
      }
      f.json.set("publications/" + id + ".json", modified)
    }
    if (change === "duplicate_attachment" || change === "null_id" || change === "empty_id") {
      const files = structuredClone(property(property(f.rootPage().properties).Files).files)
      if (!Array.isArray(files)) throw new Error("Missing fixture source Files")
      if (change === "duplicate_attachment") files.push(structuredClone(files[0]))
      else property(files[0]).id = change === "null_id" ? null : ""
      f.editProperties({ files: { files } })
    }
    if (change === "metadata_bracket") f.changeOwnerAfterDownload()
    const retained = structuredClone(receipt()),
      writes = f.mutations()
    expect((await f.run(resumeOperation(id).pipe(Effect.result)))._tag).toBe("Failure")
    expect(receipt()).toEqual(retained)
    expect(f.mutations()).toBe(writes)
    expect(f.zeroRequests()).toBe(0)
    expect(f.uploadAllocations()).toBe(1)
    expect(f.uploadSends()).toBe(1)
    expect(receipt().owner).toBeUndefined()
  }, 30000)
}

test("literal zero refuses a page without Files support before changing its receipt or body", async () => {
  const { f, id, receipt } = await originalListFence()
  const original = structuredClone(receipt()),
    writes = f.mutations()
  const result = await f.run(resumeOperation(id).pipe(Effect.result))
  expect(result._tag).toBe("Failure")
  if (result._tag === "Failure")
    expect("code" in result.failure ? result.failure.code : undefined).toBe(
      "PUBLICATION_ZERO_LIST_UNPROVEN",
    )
  expect(receipt()).toEqual(original)
  expect(f.mutations()).toBe(writes)
  expect(f.zeroRequests()).toBe(0)
})

for (const rejectedField of [false, true]) {
  test("literal zero preserves original operation through legal replacement with rejected field=" +
    rejectedField, async () => {
    const state = rejectedField
      ? await historicalListRepair("failed", undefined, false, true)
      : await originalListFence(undefined, true)
    const { f, id, receipt } = state
    const original = structuredClone(receipt())
    const request = original.intents.find((intent) => intent.path.endsWith("/markdown"))!
    const source = String(property(property(request.body).replace_content).new_str)
    const planned = zeroStartPresentation(source)!
    const before = f.mutations()
    const repaired = await f.run(resumeOperation(id))
    expect(repaired.verified).toBe(false)
    expect(receipt().conflict).toBe(true)
    expect(f.mutations()).toBe(before + 1)
    expect(f.zeroRequests()).toBe(1)
    expect(f.listPatches()).toBe(0)
    expect(receipt().intents.slice(0, original.intents.length)).toEqual(original.intents)
    const successor = receipt().intents.at(-1)!
    expect(successor.status).toBe("completed")
    expect(property(successor.response).acknowledgement).toBe("received")
    expect(property(property(successor.body).replace_content).new_str).toBe(planned.wire)
    expect(successor.zero_list_repair?.original_fence.failure).toEqual(original.failure)
    expect(successor.zero_list_repair?.original_intent_count).toBe(original.intents.length)
    expect(successor.guards?.["v1/pages/" + root + "/markdown"]).toBe(
      original.guards["v1/pages/" + root + "/markdown"],
    )
    expect(Object.keys(receipt().guards).some((path) => path.includes("33333333"))).toBe(false)
    expect(Object.keys(receipt().guards).filter((path) => path.includes("66666666"))).toHaveLength(
      3,
    )
    expect(receipt().owner).toBeUndefined()
    await finishLiteralZero(state)
    expect(receipt().intents.slice(0, original.intents.length)).toEqual(original.intents)
  }, 30000)
}

for (const response of ["unknown_before", "unknown_after", "failed_before"] as const) {
  test("literal zero resumes actual " +
    response +
    " without erasing original history", async () => {
    const state = await historicalListRepair("failed", undefined, false, true)
    const { f, id, receipt } = state
    const original = structuredClone(receipt())
    f.zeroResponse(response)
    const lost = await f.run(resumeOperation(id).pipe(Effect.result))
    expect(lost._tag).toBe("Failure")
    const unresolved = structuredClone(receipt().intents.at(-1)!)
    expect(unresolved.zero_list_repair).toBeDefined()
    expect(unresolved.status).toBe(response === "failed_before" ? "failed" : "unknown")
    expect(receipt().conflict).toBe(true)
    await f.run(resumeOperation(id))
    expect(f.zeroRequests()).toBe(response === "unknown_after" ? 1 : 2)
    expect(receipt().intents.slice(0, original.intents.length)).toEqual(original.intents)
    const settled = receipt().intents[original.intents.length]!
    expect(settled.body).toEqual(unresolved.body)
    expect(settled.guards).toEqual(unresolved.guards)
    if (response === "unknown_after") {
      expect(settled.status).toBe("completed")
      expect(property(settled.response).recovery).toBe("observed_applied")
      expect(receipt().intents).toHaveLength(original.intents.length + 1)
    } else {
      expect(settled.status).toBe("failed")
      expect(property(settled.response).recovery).toBe("known_not_applied")
      expect(property(settled.response).replayed_by_intent).toBe(original.intents.length + 1)
      expect(receipt().intents.at(-1)?.body).toEqual(unresolved.body)
      expect(receipt().intents.at(-1)?.guards).toEqual(unresolved.guards)
    }
    await finishLiteralZero(state)
  }, 30000)
}

test("literal zero recovers a durable pending pre-send crash by appending one real successor", async () => {
  const state = await originalListFence(undefined, true)
  const { f, id, receipt } = state
  const original = structuredClone(receipt())
  const crash = () => {
    if (receipt().intents.at(-1)?.zero_list_repair)
      throw new Error("Process exited after the pending literal-zero intent was persisted")
    f.onNextReceiptWrite(crash)
  }
  f.onNextReceiptWrite(crash)
  await expect(f.run(resumeOperation(id))).rejects.toThrow()
  expect(f.zeroRequests()).toBe(0)
  expect(receipt().intents.at(-1)?.status).toBe("pending")
  await f.run(resumeOperation(id))
  expect(f.zeroRequests()).toBe(1)
  expect(receipt().intents[original.intents.length]?.status).toBe("failed")
  expect(property(receipt().intents[original.intents.length]?.response).recovery).toBe(
    "known_not_applied",
  )
  await finishLiteralZero(state)
}, 30000)

test("literal zero never retries an ACK whose complete before-image still remains", async () => {
  const { f, id, receipt } = await originalListFence(undefined, true)
  f.zeroResponse("ack_no_effect")
  expect((await f.run(resumeOperation(id).pipe(Effect.result)))._tag).toBe("Failure")
  expect(receipt().intents.at(-1)?.status).toBe("completed")
  expect(receipt().conflict).toBe(true)
  const retained = structuredClone(receipt())
  expect((await f.run(resumeOperation(id).pipe(Effect.result)))._tag).toBe("Failure")
  expect(receipt()).toEqual(retained)
  expect(f.zeroRequests()).toBe(1)
  expect(f.listPatches()).toBe(0)
})

for (const drift of [
  "source",
  "owner",
  "body",
  "root_order",
  "journal",
  "descriptor",
  "partial_roots",
] as const) {
  test(
    "literal zero refuses changed " + drift + " after unresolved send before any further mutation",
    async () => {
      const { f, id, receipt } = await originalListFence(undefined, true)
      f.zeroResponse("unknown_before")
      await f.run(resumeOperation(id).pipe(Effect.result))
      if (drift === "source")
        f.objects.set(
          "objects/" + receipt().portable.files[0]!.sha256,
          encoder.encode("An external source edit"),
        )
      else if (drift === "owner")
        f.editProperties({
          Description: {
            rich_text: [{ type: "text", text: { content: "An external owner edit" } }],
          },
        })
      else if (drift === "body")
        f.editRoot("# Different\n\n1. First exact item.\n2. Keep code exact.\n")
      else if (drift === "root_order") f.editListRoots((roots) => [roots[1]!, roots[0]!, roots[2]!])
      else if (drift === "partial_roots") f.editListRoots((roots) => roots.slice(0, -1))
      else {
        const changed = structuredClone(receipt())
        if (drift === "journal") changed.intents[0]!.response = { id: "other" }
        else {
          const index = changed.intents.length - 1
          const last = changed.intents[index]!
          changed.intents[index] = {
            ...last,
            body: { ...property(last.body), replace_content: { new_str: "0\\. A forged body" } },
          }
        }
        f.json.set("publications/" + id + ".json", changed)
      }
      const retained = structuredClone(receipt())
      const writes = f.mutations()
      expect((await f.run(resumeOperation(id).pipe(Effect.result)))._tag).toBe("Failure")
      expect(f.mutations()).toBe(writes)
      expect(receipt()).toEqual(retained)
      expect(receipt().conflict).toBe(true)
      expect(f.listPatches()).toBe(0)
    },
  )
}

test("literal zero after-proof checks all roots and code spans, not a matching Markdown string alone", async () => {
  const { f, id, receipt } = await originalListFence(undefined, true)
  f.zeroResponse("unknown_after")
  await f.run(resumeOperation(id).pipe(Effect.result))
  f.editListRoots((roots) =>
    roots.map((raw, index) =>
      index === 2
        ? {
            ...property(raw),
            paragraph: {
              ...property(property(raw).paragraph),
              rich_text: [
                {
                  type: "text",
                  text: { content: "1. Keep code changed." },
                  annotations: { bold: false, code: false },
                  plain_text: "1. Keep code changed.",
                },
              ],
            },
          }
        : raw,
    ),
  )
  const retained = structuredClone(receipt())
  expect((await f.run(resumeOperation(id).pipe(Effect.result)))._tag).toBe("Failure")
  expect(receipt()).toEqual(retained)
  expect(f.zeroRequests()).toBe(1)
  expect(receipt().conflict).toBe(true)
})

test("literal zero rechecks complete guards after the pending request is persisted", async () => {
  const { f, id, receipt } = await originalListFence(undefined, true)
  const edit = () => {
    if (receipt().intents.at(-1)?.zero_list_repair) f.editRoot("External edit before the send")
    else f.onNextReceiptWrite(edit)
  }
  f.onNextReceiptWrite(edit)
  expect((await f.run(resumeOperation(id).pipe(Effect.result)))._tag).toBe("Failure")
  expect(f.zeroRequests()).toBe(0)
  expect(receipt().intents.at(-1)?.status).toBe("failed")
  expect(property(receipt().intents.at(-1)?.response).recovery).toBe("pre_send_guard_failed")
  expect(receipt().conflict).toBe(true)
  expect(receipt().owner).toBeUndefined()
})
