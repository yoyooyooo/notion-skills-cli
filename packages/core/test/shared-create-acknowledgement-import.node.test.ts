import { spawn } from "node:child_process"
import { once } from "node:events"
import { expect, test } from "vitest"

async function freshNode(source: string) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = "",
    stderr = ""
  child.stdout.setEncoding("utf8").on("data", (data: string) => {
    stdout += data
  })
  child.stderr.setEncoding("utf8").on("data", (data: string) => {
    stderr += data
  })
  const [exit] = await once(child, "close")
  return { exit, stdout, stderr }
}

async function freshImport(entry: string, expected: string) {
  const url = new URL("../src/" + entry, import.meta.url).href
  return freshNode(
    `const module = await import(${JSON.stringify(url)}); if (!( ${JSON.stringify(expected)} in module)) throw Error("Missing public module entry"); console.log("loaded")`,
  )
}

// A controlled Effect fixture and a preloaded bundle can hide an ESM cycle.
// Each case starts a new native Node process with no loader, build or services.
test.each([
  ["shared-create-restoration.ts", "reviewSharedCreateRestoration"],
  ["shared-create.ts", "executeSharedCreate"],
  ["shared-create-recovery-native-model.ts", "SharedCreateNativeRecoveryReviewSchema"],
  ["shared-create-recovery-native-plan.ts", "nativeMainRecoveryPlan"],
  ["shared-create-recovery-native-authority.ts", "originalNativeMainAllocation"],
  ["shared-create-recovery-native-completion.ts", "readSharedCreateNativeCompletion"],
  ["shared-create-recovery-native.ts", "reviewSharedCreateNativeRecovery"],
  ["shared-inventory-recovery.ts", "reviewInventoryNativeRecovery"],
  ["shared-create-recovery-acknowledgement-model.ts", "SharedNativeAllocationReferenceSchema"],
  ["shared-create-recovery-acknowledgements.ts", "readSharedNativeAllocationProofs"],
  ["shared-create-recovery-known-model.ts", "validateSharedCreateKnownRecoveryReview"],
  ["shared-create-recovery-prefix-model.ts", "SharedCreatePrefixBootstrapSchema"],
  ["shared-create-recovery-proof-model.ts", "SharedCreateRecoveryFileCommitmentSchema"],
  [
    "shared-create-continuation-acknowledged-model.ts",
    "validateSharedCreateAcknowledgedContinuationReview",
  ],
  ["shared-create-recovery-known-completion.ts", "readSharedCreateKnownCompletion"],
  ["shared-create-continuation-acknowledged.ts", "reviewSharedCreateAcknowledgedContinuation"],
  ["shared-create-recovery.ts", "reviewSharedCreateContinuation"],
])(
  "native Node independently initializes %s without a temporal-dead-zone cycle",
  async (entry, expected) => {
    const result = await freshImport(entry, expected)
    expect(result.exit, result.stderr).toBe(0)
    expect(result.stdout).toBe("loaded\n")
    expect(result.stderr).toBe("")
  },
  60_000,
)

test.each([
  { name: "ordinary path", body: "# Root\n\nRead references/policy.md.\n" },
  { name: "literal underscores", body: "# Root\n\nThe review_rule is CEDAR_3.\n" },
  { name: "explicit link", body: "# Root\n\n[Read policy](references/policy.md)\n" },
])(
  "fresh Node restores the original $name and refuses changed links",
  async (sample) => {
    const from = (path: string) => JSON.stringify(new URL(path, import.meta.url).href)
    const source = `
import assert from 'node:assert/strict';
import {Effect} from 'effect';
const {sharedCreateFixture}=await import(${from("./shared-create-fixture.ts")});
const {prepareSharedCreate,executeSharedCreate}=await import(${from("../src/shared-create.ts")});
const {reviewSharedCreateRestoration,applySharedCreateRestoration,reconcileSharedCreateRestoration}=await import(${from("../src/shared-create-restoration.ts")});
const {querySharedRecords,canonicalSharedJson}=await import(${from("../src/shared-records.ts")});
const {sharedCreateOutcomeId}=await import(${from("../src/shared-create-outcome.ts")});
const sample=${JSON.stringify(sample)},f=sharedCreateFixture(),encode=value=>new TextEncoder().encode(value);
const plan=await f.run(prepareSharedCreate(f.library,{portable:{kind:'skill',name:'Fresh Node '+sample.name,description:'Original recovery fixture',main:'SKILL.md',files:[{path:'SKILL.md',bytes:encode(sample.body)},{path:'references/policy.md',bytes:encode('# Policy\\n\\nKEEP-ORIGINAL\\n')}]}}));
const expected=plan.files.find(file=>file.path===plan.entrypoint).projection.markdown;
f.onCreate((page,kind)=>{if(kind==='skill')f.base.bodies.set(String(page.id),expected+'\\n\\nUnaccepted body');});
const failed=await f.run(Effect.flip(executeSharedCreate(f.library,{plan,mode:'create'})));
assert.equal(failed.code,'SHARED_CREATE_BODY_MISMATCH');
const page=String(failed.details.skill_page_id),selected={entry:f.library.skills.database_id,plan,target:page};
const history=()=>f.run(querySharedRecords(f.library,{skillPageId:page,kind:'operation',recordId:sharedCreateOutcomeId(plan.operation_id)}));
const original=canonicalSharedJson(await history());
const changed=sample.name==='explicit link'?expected.replace('references/policy.md','https://example.invalid/replaced'):expected+'\\n\\n[policy.md](https://example.invalid/replaced)';
f.base.bodies.set(page,changed);f.clear();
assert.match((await f.run(Effect.flip(reviewSharedCreateRestoration(selected)))).code,/SHARED_CREATE/);assert.equal(f.writes().length,0);
if(sample.name==='ordinary path'){
 f.base.bodies.set(page,expected.replace('references/policy.md','references/[policy.md](http://policy.md)'));f.clear();
 assert.match((await f.run(Effect.flip(reviewSharedCreateRestoration(selected)))).code,/SHARED_CREATE/);assert.equal(f.writes().length,0);
}
f.base.bodies.set(page,expected);f.onCreate(()=>{});f.clear();
const review=await f.run(reviewSharedCreateRestoration(selected));assert.equal(f.writes().length,0);
const input={entry:selected.entry,plan,review,reviewId:review.review_id};
const recovered=await f.run(applySharedCreateRestoration(input));assert.equal(recovered.status,'created');assert.equal(recovered.skill_page_id,page);assert.equal(recovered.operation_id,plan.operation_id);assert.equal(f.nativeCreates().length,1);
assert.equal(canonicalSharedJson(await history()),original);f.clear();
const repeated=await f.run(applySharedCreateRestoration(input));assert.equal(repeated.verified,true);assert.equal(repeated.reused,true);assert.equal(f.writes().length,0);
f.base.json.clear();f.base.objects.clear();f.credential('independent-'+sample.name);f.clear();
assert.equal((await f.run(reconcileSharedCreateRestoration(selected))).verified,true);assert.equal(f.writes().length,0);
console.log(JSON.stringify({case:sample.name,original_failure_preserved:true,same_page:true,repeat_writes:0,cold_verified:true,changed_link_refused:true}));
`
    const result = await freshNode(source)
    expect(result.exit, result.stderr).toBe(0)
    expect(result.stderr).toBe("")
    expect(JSON.parse(result.stdout)).toMatchObject({
      case: sample.name,
      original_failure_preserved: true,
      same_page: true,
      repeat_writes: 0,
      cold_verified: true,
      changed_link_refused: true,
    })
  },
  60_000,
)
