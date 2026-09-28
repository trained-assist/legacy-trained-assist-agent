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

function flushFile(file) {
  const buffered = pending.get(file);
  if (!buffered || !buffered.length) return;
  pending.delete(file);
  if (!fs.existsSync(path.dirname(file))) return;
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
}

function flushAll() {
  for (const file of [...pending.keys()]) {
    try { flushFile(file); } catch (e) { console.warn(`[jsonl-batched-flush] flush failed for ${file}: ${e.message}`); }
  }
}

function ensureTimer() {
  if (flushTimer) return;
  flushTimer = setInterval(flushAll, FLUSH_INTERVAL_MS);
  flushTimer.unref();
}

process.on('exit', flushAll);

module.exports = { appendBuffered, bufferedRecords, flushAll };
