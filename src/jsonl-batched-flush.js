'use strict';
const fs = require('fs');
const path = require('path');
const { atomicText } = require('./atomic-json');

const FLUSH_MAX_ENTRIES = 20;
const FLUSH_INTERVAL_MS = 30_000;

const pending = new Map();
let flushTimer = null;

function appendBuffered(file, record) {
  let buffered = pending.get(file);
  if (!buffered) {
    buffered = [];
    pending.set(file, buffered);
  }
  buffered.push(record);
  ensureTimer();
  if (buffered.length >= FLUSH_MAX_ENTRIES) flushFile(file);
}

function bufferedRecords(file) {
  return pending.get(file) || [];
}

// Returns how many buffered records were written (0 = nothing to do).
function flushFile(file) {
  const buffered = pending.get(file);
  if (!buffered || !buffered.length) return 0;
  pending.delete(file);
  if (!fs.existsSync(path.dirname(file))) return 0;
  let existing = '';
  try { existing = fs.readFileSync(file, 'utf8'); } catch { existing = ''; }
  if (existing && !existing.endsWith('\n')) existing += '\n';
  const chunk = buffered.map(r => JSON.stringify(r) + '\n').join('');
  try {
    atomicText(file, existing + chunk);
  } catch (e) {
    pending.set(file, buffered);
    throw e;
  }
  if (!pending.size && flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  return buffered.length;
}

// Write every buffered file now. Returns the number of records flushed — the
// profile migrator's POST /internal/flush-profile turns it into {flushed}, the
// evidence that no buffered record can re-create a file it is about to archive
// (epic #1784 risk R2).
function flushAll() {
  let flushed = 0;
  for (const file of [...pending.keys()]) {
    try { flushed += flushFile(file); } catch (e) { console.warn(`[jsonl-batched-flush] flush failed for ${file}: ${e.message}`); }
  }
  return flushed;
}

function ensureTimer() {
  if (flushTimer) return;
  flushTimer = setInterval(flushAll, FLUSH_INTERVAL_MS);
  flushTimer.unref();
}

process.on('exit', flushAll);

module.exports = { appendBuffered, bufferedRecords, flushAll };
