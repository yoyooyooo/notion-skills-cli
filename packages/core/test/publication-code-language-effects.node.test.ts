import assert from "node:assert/strict"
import { test } from "vitest"
import type { Receipt } from "../src/publication-model.ts"
import {
  exactPlainTextLanguageBodyEffect,
  hasOnlyCompletedOrRetriedPlainTextEffects,
} from "../src/publication-code-language-effects.ts"

// Pure evidence records are never persisted or passed to publication/reconcile.
type MutableIntent = {
  -readonly [K in keyof Receipt["intents"][number]]: Receipt["intents"][number][K]
}
type MutableReceipt = Omit<Receipt, "intents"> & { intents: MutableIntent[] }
const fixture = () => {
  const before =
    "# Original\n\n```javascript\n  exact code\n```\n\n[site](https://example.test/exact?key=one#part)\n"
  const after = before.replace("```javascript", "```plain text")
  const path = "v1/blocks/code",
    owner = "v1/pages/owner"
  const intent: MutableIntent = {
    path,
    method: "PATCH",
    status: "unknown",
    body: { code: { language: "plain text" } },
    guards: {
      [path]: {
        id: "code",
        type: "code",
        parent: { type: "page_id", page_id: "owner" },
        has_children: false,
        archived: false,
        in_trash: false,
        last_edited_time: "before",
        code: {
          language: "javascript",
          rich_text: [{ type: "text", text: { content: "  exact code", link: null } }],
          caption: [],
        },
      },
      [owner]: { id: "owner", properties: {} },
      [`${owner}/markdown`]: before,
    },
  }
  return { before, after, intent, owner, path }
}

test("an applied plain-text field explains only its exact original fence-language line", () => {
  const f = fixture(),
    prior = structuredClone(f)
  for (const info of ["plain text", "text", ""]) {
    assert.equal(
      exactPlainTextLanguageBodyEffect(
        f.intent,
        f.before,
        f.after.replace("```plain text", `\`\`\`${info}`),
      ),
      true,
    )
  }
  assert.deepEqual(f, prior)
  assert.equal(exactPlainTextLanguageBodyEffect(f.intent, f.before, f.before), false)
})

test("all other body bytes, explicit URLs and code bytes remain exact", () => {
  const f = fixture()
  for (const after of [
    f.after.replace("# Original", "# Changed"),
    f.after.replace("# Original\n\n", "# Original\n\n\n"),
    f.after.replace("  exact code", " exact code"),
    f.after.replace("  exact code", "  exact code\n"),
    f.after.replace("https:", "http:"),
    f.after.replace("/exact", "/other"),
    f.after.replace("key=one", "key=two"),
    f.after.replace("#part", "#else"),
    f.after + "\n",
  ])
    assert.equal(exactPlainTextLanguageBodyEffect(f.intent, f.before, after), false)
})

test("an ambiguous, nested or differently framed code cannot supply this effect proof", () => {
  for (const extra of [
    "\n```javascript\n  exact code\n```\n",
    "\n- Item\n\n  ```javascript\n    exact code\n  ```\n",
  ]) {
    const f = fixture(),
      before = f.before + extra
    f.intent.guards = { ...f.intent.guards, [`${f.owner}/markdown`]: before }
    assert.equal(exactPlainTextLanguageBodyEffect(f.intent, before, f.after + extra), false)
  }
  const f = fixture()
  for (const after of [
    f.after.replaceAll("```", "````"),
    f.after.replaceAll("```", "~~~"),
    f.after.replace("```plain text", "```python"),
    f.after.replace("```plain text", "```plain text extra"),
  ])
    assert.equal(exactPlainTextLanguageBodyEffect(f.intent, f.before, after), false)
})

test("the request and retained original owner/block are exact finite evidence", () => {
  const edits: Array<(f: ReturnType<typeof fixture>) => void> = [
    (f) => {
      f.intent.body = { code: { language: "text" } }
    },
    (f) => {
      f.intent.body = { code: { language: "plain text", caption: [] } }
    },
    (f) => {
      f.intent.body = { code: { language: "plain text" }, archived: false }
    },
    (f) => {
      f.intent.status = "failed"
    },
    (f) => {
      f.intent.path = "v1/blocks/foreign"
    },
    (f) => {
      f.intent.guards = {}
    },
    (f) => {
      f.intent.guards = { ...f.intent.guards, [f.owner]: { id: "foreign", properties: {} } }
    },
    (f) => {
      f.intent.guards = { ...f.intent.guards, [f.owner]: undefined }
    },
    (f) => {
      f.intent.guards = { ...f.intent.guards, [`${f.owner}/markdown`]: f.after }
    },
    (f) => {
      const raw = structuredClone(f.intent.guards![f.path]) as Record<string, unknown>
      raw.has_children = true
      f.intent.guards = { ...f.intent.guards, [f.path]: raw }
    },
  ]
  for (const edit of edits) {
    const f = fixture()
    edit(f)
    assert.equal(exactPlainTextLanguageBodyEffect(f.intent, f.before, f.after), false)
  }
})

const history = () => {
  const f = fixture(),
    original = structuredClone(f.intent),
    successor = structuredClone(f.intent)
  original.status = "failed"
  original.response = {
    prior_status: "unknown",
    recovery: "known_not_applied",
    replayed_by_intent: 1,
  }
  successor.status = "completed"
  successor.response = { id: "code" }
  const receipt = { intents: [original, successor] } as unknown as MutableReceipt
  return { ...f, receipt }
}

test("only formally disposed no-effect history with its real exact successor permits postprocessing", () => {
  const f = history(),
    before = structuredClone(f.receipt)
  assert.equal(hasOnlyCompletedOrRetriedPlainTextEffects(f.receipt), true)
  assert.deepEqual(f.receipt, before)
  const second = structuredClone(f.receipt.intents[0]!)
  second.response = {
    prior_status: "pending",
    recovery: "known_not_applied",
    replayed_by_intent: 2,
  }
  f.receipt.intents.splice(1, 0, second)
  assert.equal(hasOnlyCompletedOrRetriedPlainTextEffects(f.receipt), true)
})

test("an unresolved or malformed disposition, wrong successor or changed preimage remains blocked", () => {
  const edits: Array<(f: ReturnType<typeof history>) => void> = [
    (f) => {
      f.receipt.intents[0]!.status = "unknown"
    },
    (f) => {
      f.receipt.intents[0]!.response = undefined
    },
    (f) => {
      f.receipt.intents[0]!.response = {
        prior_status: "completed",
        recovery: "known_not_applied",
        replayed_by_intent: 1,
      }
    },
    (f) => {
      f.receipt.intents[0]!.response = {
        prior_status: "unknown",
        recovery: "known_not_applied",
        replayed_by_intent: 1,
        extra: true,
      }
    },
    (f) => {
      f.receipt.intents[0]!.response = {
        prior_status: "unknown",
        recovery: "observed_applied",
        replayed_by_intent: 1,
      }
    },
    ...[0, 2, -1, 1.1, "1"].map((index) => (f: ReturnType<typeof history>) => {
      f.receipt.intents[0]!.response = {
        prior_status: "unknown",
        recovery: "known_not_applied",
        replayed_by_intent: index,
      }
    }),
    (f) => {
      f.receipt.intents[1]!.status = "unknown"
    },
    (f) => {
      f.receipt.intents[1]!.status = "failed"
    },
    (f) => {
      f.receipt.intents[1]!.response = { id: "foreign" }
    },
    (f) => {
      f.receipt.intents[1]!.path = "v1/blocks/foreign"
    },
    (f) => {
      f.receipt.intents[1]!.body = { code: { language: "python" } }
    },
    (f) => {
      f.receipt.intents[1]!.guards = {
        ...f.receipt.intents[1]!.guards,
        [f.owner]: { id: "owner", properties: { changed: true } },
      }
    },
    (f) => {
      f.receipt.intents[1]!.guards = undefined
    },
    (f) => {
      f.receipt.intents.push(structuredClone(f.intent))
    },
  ]
  for (const edit of edits) {
    const f = history()
    edit(f)
    assert.equal(hasOnlyCompletedOrRetriedPlainTextEffects(f.receipt), false)
  }
})
