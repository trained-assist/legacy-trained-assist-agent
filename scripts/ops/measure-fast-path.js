#!/usr/bin/env node
'use strict';

// #120 acceptance measurement — how much of a run is framing, and how long until the
// first line of code. Reads the durable-task DB read-only; safe to run against prod.
//
//   node scripts/ops/measure-fast-path.mjs 9a6854e4
//   node scripts/ops/measure-fast-path.mjs --compare 9a6854e4 <spec-ref-plan>
//   node scripts/ops/measure-fast-path.mjs 9a6854e4 --db ~/agent-data/durable-tasks/state.db
//
// "Framing" is classified by the item's STAGE (frame/propose/design), not by title, so
// it survives copy changes. A plan that took the #120 fast path has exactly one framing
// item («Сверка одобренной спецификации») instead of the whole chain.

const path = require('path');
const os = require('os');

const FRAMING_STAGES = new Set(['frame', 'propose', 'design']);
const APPLY_STAGES = new Set(['apply']);
const FAST_PATH_TITLE = 'Сверка одобренной спецификации';

function openDb(file) {
  const Database = require('better-sqlite3');
  return new Database(file, { readonly: true, fileMustExist: true });
}

function measure(db, prefix) {
  const task = db.prepare('SELECT id, goal, status, created_at, updated_at FROM durable_tasks WHERE id LIKE ? ORDER BY created_at DESC LIMIT 1')
    .get(`${prefix}%`);
  if (!task) return { prefix, found: false };
  const items = db.prepare('SELECT id, position, stage, title, status FROM task_items WHERE task_id = ? ORDER BY position').all(task.id);
  const ex = db.prepare('SELECT task_item_id, status, started_at, finished_at FROM executions WHERE task_id = ? ORDER BY started_at').all(task.id);
  const byItem = new Map();
  for (const e of ex) {
    if (!byItem.has(e.task_item_id)) byItem.set(e.task_item_id, []);
    byItem.get(e.task_item_id).push(e);
  }
  const runsOf = it => (byItem.get(it.id) || []).length;
  const framing = items.filter(i => FRAMING_STAGES.has(i.stage));
  const apply = items.filter(i => APPLY_STAGES.has(i.stage));
  const framingRuns = framing.reduce((n, i) => n + runsOf(i), 0);
  const framingExecs = framing.flatMap(i => byItem.get(i.id) || []);
  const firstFraming = framingExecs.length ? Math.min(...framingExecs.map(e => e.started_at)) : null;
  const lastFraming = framingExecs.length ? Math.max(...framingExecs.map(e => e.finished_at || e.started_at)) : null;
  const firstApplyExec = apply.flatMap(i => byItem.get(i.id) || []).sort((a, b) => a.started_at - b.started_at)[0] || null;
  const mins = ms => (ms == null ? null : Math.round(ms / 60000));
  return {
    prefix,
    found: true,
    plan_id: task.id,
    status: task.status,
    goal: String(task.goal || '').slice(0, 80),
    fast_path: items.some(i => i.title === FAST_PATH_TITLE),
    framing_items: framing.length,
    framing_model_runs: framingRuns,
    framing_wall_min: mins(lastFraming != null && firstFraming != null ? lastFraming - firstFraming : null),
    time_to_first_apply_min: firstApplyExec ? mins(firstApplyExec.started_at - task.created_at) : null,
    total_min: mins(task.updated_at - task.created_at),
  };
}

function fmt(m) {
  if (!m.found) return `${m.prefix}: plan not found`;
  return [
    `${m.prefix}  ${m.fast_path ? 'FAST PATH' : 'full frame'}  status=${m.status}`,
    `  framing items=${m.framing_items}  model runs=${m.framing_model_runs}  framing wall=${m.framing_wall_min} min`,
    `  plan-created → first apply run=${m.time_to_first_apply_min} min   total=${m.total_min} min`,
    `  goal: ${m.goal}`,
  ].join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  const dbFlag = argv.indexOf('--db');
  const dbFile = dbFlag >= 0 ? argv[dbFlag + 1] : path.join(os.homedir(), 'agent-data', 'durable-tasks', 'state.db');
  const args = argv.filter((a, i) => a !== '--db' && i !== dbFlag + 1);
  const db = openDb(dbFile);
  try {
    if (args[0] === '--compare') {
      const before = measure(db, args[1]);
      const after = measure(db, args[2]);
      console.log(fmt(before));
      console.log(fmt(after));
      if (before.found && after.found) {
        console.log(`\nΔ framing model runs: ${before.framing_model_runs} → ${after.framing_model_runs}`);
        console.log(`Δ time to first apply: ${before.time_to_first_apply_min} → ${after.time_to_first_apply_min} min`);
        console.log(`Δ total: ${before.total_min} → ${after.total_min} min`);
      }
      return;
    }
    if (!args[0]) {
      console.error('usage: measure-fast-path.mjs <planIdPrefix> | --compare <before> <after> [--db PATH]');
      process.exit(2);
    }
    console.log(fmt(measure(db, args[0])));
  } finally {
    db.close();
  }
}

if (require.main === module) main();
module.exports = { measure, FRAMING_STAGES, FAST_PATH_TITLE };
