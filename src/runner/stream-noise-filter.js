'use strict';
// Engine text hygiene: never let leaked tool-call markup reach the human.
//
// Symptom (2026-10-04, free models on the OpenCode ladder): the model emits the
// tool call TWICE — once as a native call whose JSON arguments are truncated
// (OpenCode records it as tool "invalid", so the tool NEVER runs) and once in the
// legacy XML dialect it was trained on. The XML copy arrives as an ordinary
// `text` part, and every engine text path appended it verbatim, so
//
//   <tool_call><function=repo_map><parameter=repo>…</parameter></function></tool_call>
//
// streamed into the Telegram progress message, into the web SSE stream, and —
// because the OpenCode engine makes its final answer out of the accumulated
// scratchpad (`claudeResult = fullOutput.text`) — into the PERSISTED transcript,
// where the model then re-reads its own garbage on the next turn. 2 114 leaked
// blocks in one profile's engine store; the "агент застряла" fallback the user saw
// was the downstream symptom of the same double-emit.
//
// One chokepoint for all three engines: Claude text blocks, Codex agent_message
// items and OpenCode text parts all pass through a StreamNoiseFilter before
// touching fullOutput.text / outputCallback / the transcript.
//
// Three states, because a block does not arrive whole: 'block' swallows from the
// opening marker to its closing tag (which routinely lands in the NEXT delta), then
// 'orphan' swallows any closing tags left stranded at the head by that split, and
// only then does 'idle' resume normal streaming. Both non-idle states hold instead
// of emitting, and are bounded by MAX_HELD.
//
// Precision over paranoia: only markup is removed. Prose with angle brackets
// (`a < b`), comparisons, URLs, JSON and even XML the user asked about pass through
// byte-for-byte, and the real answer that follows a leaked block on the SAME line
// survives. The ZWSP the model emits right after `<` is itself a tell that no
// human-authored line carries one.

const ZWSP = '\u200b';
// Openers, with and without the ZWSP the model injects after `<`.
const OPENERS = ['<tool_call>', '<function=', '<parameter=', '<\u200btool_call>', '<\u200bfunction=', '<\u200bparameter='];
// Longest marker fragment the next delta could still complete.
const MAX_MARKER_PREFIX = Math.max(...OPENERS.map(o => o.length));

// How many trailing chars could still become a marker opener. Holding a BLIND
// tail here (the obvious first cut) swallowed the last chars of every short
// message — and because Codex/Claude snapshot `lastAssistantMsg` per message, a
// 12-char answer like "Ответ Codex" came out empty. Only a genuine marker prefix
// may be withheld.
function markerPrefixLen(buf) {
  for (let len = Math.min(MAX_MARKER_PREFIX, buf.length); len >= 1; len--) {
    const suffix = buf.slice(buf.length - len);
    if (OPENERS.some(o => o.startsWith(suffix))) return len;
  }
  return 0;
}
// A block/orphan run with no terminator is runaway junk, not a slow stream: past
// this size we drop it instead of buffering without bound.
const MAX_HELD = 64 * 1024;

// Self-delimiting alternatives: each ends at a literal `>` or `=`, so a marker
// split mid-name does not match yet — it stays inside the held tail until the next
// delta completes it. Matching bare prefixes would make the filter swallow a
// half-arrived marker.
const SUSPECT_RE = new RegExp(`<${ZWSP}?(?:tool_call|function=|parameter=)`, 'i');
const TOOLCALL_OPEN_RE = new RegExp(`^${ZWSP}?tool_call>`, 'i');
const TOOLCALL_CLOSE_RE = new RegExp(`<\\/${ZWSP}?tool_call>`, 'i');
const INNER_CLOSE_RE = new RegExp(`<\\/${ZWSP}?(?:function|parameter)>`, 'i');
// A closing tag right at the head: complete → swallow; incomplete → it is the tail
// of a tag split across deltas, so keep holding.
const LEADING_CLOSE_RE = new RegExp(`^\\s*<\\/${ZWSP}?`, 'i');
const CLOSER_NAMES = ['function>', 'parameter>', 'tool_call>'];
// A buffer that is nothing but the makings of a tag (`<`, `</`, `</funct`) is the
// head of a close split across deltas — hold it instead of declaring the orphan
// state over. Any terminator disqualifies it, so real prose never waits here.
const CLOSE_PREFIX_RE = /^\s*<\/?\u200b?[A-Za-z_]*$/;

// Stranded closing tag at the head of buf: { head, key } where `head` is the
// whitespace + `</` prefix and `key` the closer name. Returns null as soon as the
// text after `</` is neither a complete closer nor a prefix of one — that is what
// keeps an honest `</div>` in a user's answer from stalling the filter.
function leadingStrandedClose(buf) {
  const m = LEADING_CLOSE_RE.exec(buf);
  if (!m) return null;
  const rest = buf.slice(m[0].length);
  for (const key of CLOSER_NAMES) {
    // Either the whole closer is here (followed by more text) or it is still
    // arriving — both keep the filter in the orphan state.
    if (rest.startsWith(key) || key.startsWith(rest)) return { head: m[0].length, key };
  }
  return null;
}

class StreamNoiseFilter {
  constructor() {
    this.buf = '';
    this.state = 'idle'; // idle | block | orphan
  }

  // Feed one engine text delta; returns the part that is safe to emit now.
  // Returns '' while a block is incomplete — that text is held, never dropped,
  // until the next push() or flush().
  push(text) {
    if (!text) return '';
    this.buf += text;
    let out = '';
    for (;;) {
      if (this.state === 'block') {
        if (this._closeBlock() === false) return out; // terminator not here yet
        continue;
      }
      if (this.state === 'orphan') {
        // An empty buffer is not "no close coming" — it is "not yet arrived": a
        // stranded closing tag is exactly what the previous delta was cut off from.
        // Waiting one delta is the only way to tell it from a finished block.
        if (!this.buf) return out;
        if (CLOSE_PREFIX_RE.test(this.buf)) return out; // close still arriving
        const stranded = leadingStrandedClose(this.buf);
        if (!stranded) { this.state = 'idle'; continue; }
        const arrived = this.buf.length - stranded.head;
        if (arrived >= stranded.key.length) {
          this.buf = this.buf.slice(stranded.head + stranded.key.length);
          continue;
        }
        if (this.buf.length > MAX_HELD) { this.buf = ''; this.state = 'idle'; }
        return out; // stranded tag still arriving
      }
      const m = SUSPECT_RE.exec(this.buf);
      if (!m) {
        // Nothing suspicious so far; withhold only a genuine marker prefix, so
        // ordinary text (including a short final answer) streams out in full.
        const hold = markerPrefixLen(this.buf);
        if (this.buf.length > hold) {
          out += this.buf.slice(0, this.buf.length - hold);
          this.buf = hold ? this.buf.slice(-hold) : '';
        }
        return out;
      }
      if (m.index > 0) {
        out += this.buf.slice(0, m.index);
        this.buf = this.buf.slice(m.index);
        continue;
      }
      // Suspect at the head: remember whether it is the wrapped or bare dialect,
      // then start swallowing from here.
      this.wrapped = TOOLCALL_OPEN_RE.test(this.buf.slice(1));
      this.state = 'block';
    }
  }

  // End of stream: emit what is left, minus a block that never terminated.
  flush() {
    const tail = this.buf;
    this.buf = '';
    this.state = 'idle';
    return SUSPECT_RE.test(tail) ? '' : tail;
  }

  // Swallow the suspect run at the head of buf. Returns false when the closing
  // tag has not arrived yet (caller keeps holding), true once it has.
  _closeBlock() {
    const body = this.wrapped ? this.buf.slice(1 + (TOOLCALL_OPEN_RE.exec(this.buf.slice(1)) || [''])[0].length) : this.buf;
    const re = this.wrapped ? TOOLCALL_CLOSE_RE : INNER_CLOSE_RE;
    const m = re.exec(body);
    if (!m) {
      if (this.buf.length > MAX_HELD) { this.buf = ''; this.state = 'idle'; return true; }
      return false;
    }
    this.buf = body.slice(m.index + m[0].length);
    this.state = 'orphan';
    return true;
  }
}

// One-shot variant for callers holding a complete string (final-answer paths,
// replay of a stored transcript). Returns the text without leaked markup.
function stripLeakedToolMarkup(text) {
  if (!text || typeof text !== 'string') return '';
  if (!SUSPECT_RE.test(text)) return text;
  const f = new StreamNoiseFilter();
  return f.push(text) + f.flush();
}

module.exports = { StreamNoiseFilter, stripLeakedToolMarkup };