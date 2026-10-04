// OpenCode plugin: strip leaked tool-call markup INSIDE the engine.
//
// Why this exists on top of src/runner/stream-noise-filter.js (which already cleans
// every engine text path on the way out):
//
//   1. opencode persists each assistant text part BEFORE the agent sees it. The runner
//      filter cannot un-write that, so the junk stayed in the engine's own `part` table.
//   2. opencode rebuilds the LLM context from those same parts (session/prompt.ts →
//      MessageV2.toModelMessages). So on the next turn the model re-read its own garbage —
//      the self-feeding loop behind "агент застряла".
//   3. Any other consumer of the engine store (web, future clients) reads the persisted
//      text, not the runner's cleaned copy.
//
// The fix therefore belongs on the engine's write path, not on ours. OpenCode 1.18.31
// fires `experimental.text.complete` in processor.ts at `text-end` BEFORE
// `session.updatePart(...)`, so rewriting `output.text` here keeps the markup out of the
// store entirely. `experimental.chat.messages.transform` (session/prompt.ts, right before
// the messages are converted for the model) cleans history that was polluted before this
// plugin existed.
//
// ONE implementation of the filter, not two: the strip logic is required from the runner
// module. ESM (.mjs) with a single named export on purpose — OpenCode's legacy plugin path
// (getLegacyPlugins) iterates every export and THROWS on a non-function one, which a
// CommonJS `module.exports = {...}` import would trigger through its `default`.
//
// Fail-open everywhere: a broken filter must never cost the user their run, so every hook
// body swallows its own errors and returns the input untouched.

import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

// Missing/broken module → strip stays null → hooks become no-ops (fail-open, not crash).
let strip = null
try {
  ;({ stripLeakedToolMarkup: strip } = require("../stream-noise-filter.js"))
} catch {
  strip = null
}

// Only touch text that can actually contain markup: the strip function is cheap but this
// hook runs on every assistant part of every run.
function looksSuspect(text) {
  return typeof text === "string" && (text.includes("<") || text.includes(""))
}

function clean(text) {
  if (!strip || !looksSuspect(text)) return null
  try {
    const next = strip(text)
    return next === text ? null : next
  } catch {
    return null
  }
}

export const StripLeakedToolPlugin = async () => ({
  // Engine write path: runs before the part is persisted.
  "experimental.text.complete": async (_input, output) => {
    if (!output || typeof output.text !== "string") return
    const next = clean(output.text)
    if (next !== null) output.text = next
  },

  // Engine read path: cleans already-stored history on its way to the model.
  "experimental.chat.messages.transform": async (_input, output) => {
    const messages = output && output.messages
    if (!Array.isArray(messages)) return
    for (const message of messages) {
      if (!message || !Array.isArray(message.parts)) continue
      for (let i = 0; i < message.parts.length; i++) {
        const part = message.parts[i]
        if (!part || part.type !== "text") continue
        const next = clean(part.text)
        // Replace the part with a copy instead of mutating in place: the objects come from
        // the session store and must not be written back.
        if (next !== null) message.parts[i] = { ...part, text: next }
      }
    }
  },
})
