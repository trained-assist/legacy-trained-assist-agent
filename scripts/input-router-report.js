#!/usr/bin/env node
'use strict';
// Agreement report for the input router SHADOW log (epic #1542 §C, step P1).
// Usage: node scripts/input-router-report.js [path/to/input-router-shadow.jsonl ...]
// Default path: $AGENT_DATA_DIR/input-router-shadow.jsonl (+ rotated .1 file).
//
// quick: router route=quick vs legacy regex quick answer (source=quick records).
//        "false quick" (router quick, legacy agent) is the costly error class.
// ready: router ready vs legacy checkCompleteness (source=intake-gate records);
//        legacy clear|likely == ready, insufficient|error == awaiting_more.

const fs = require('fs');
const { shadowLogPath } = require('../src/input-router');

function readRecords(files) {
  const out = [];
  for (const f of files) {
    let raw;
    try { raw = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
    }
  }
  return out;
}

function pct(n, d) { return d ? `${(100 * n / d).toFixed(1)}%` : '—'; }
function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
}

function computeStats(records) {
  const stats = {
    total: records.length,
    routerNull: 0,
    quick: { n: 0, tp: 0, tn: 0, routerOnly: 0, legacyOnly: 0 },
    ready: { n: 0, bothReady: 0, bothWait: 0, routerReadyLegacyWait: 0, routerWaitLegacyReady: 0 },
    latency: { p50: null, p95: null },
    cost: { n: 0, sum: 0 },
    supplement: 0,
  };
  const ms = [];
  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    const router = r.router;
    if (!router) { stats.routerNull++; continue; }
    if (Number.isFinite(r.ms)) ms.push(r.ms);
    if (router.usage && Number.isFinite(router.usage.cost)) { stats.cost.n++; stats.cost.sum += router.usage.cost; }
    if (router.supplement_to_running) stats.supplement++;
    const legacy = r.legacy || {};
    if (r.source === 'quick' && typeof legacy.quick === 'boolean') {
      const q = stats.quick; q.n++;
      const rq = router.route === 'quick';
      if (rq && legacy.quick) q.tp++;
      else if (!rq && !legacy.quick) q.tn++;
      else if (rq) q.routerOnly++;
      else q.legacyOnly++;
    }
    if (r.source === 'intake-gate' && typeof legacy.completeness === 'string') {
      const g = stats.ready; g.n++;
      const rr = router.ready === 'ready';
      const lr = legacy.completeness === 'clear' || legacy.completeness === 'likely';
      if (rr && lr) g.bothReady++;
      else if (!rr && !lr) g.bothWait++;
      else if (rr) g.routerReadyLegacyWait++;
      else g.routerWaitLegacyReady++;
    }
  }
  stats.latency.p50 = percentile(ms, 0.5);
  stats.latency.p95 = percentile(ms, 0.95);
  return stats;
}

function formatReport(s) {
  const q = s.quick, g = s.ready;
  return [
    `records: ${s.total}, router null (error/timeout/disabled output): ${s.routerNull} (${pct(s.routerNull, s.total)})`,
    `latency ms: p50=${s.latency.p50 ?? '—'} p95=${s.latency.p95 ?? '—'} (target p95 <= 1500)`,
    `cost: ${s.cost.n ? `$${(s.cost.sum / s.cost.n).toFixed(6)}/call avg over ${s.cost.n}` : 'n/a'}`,
    '',
    `QUICK vs legacy regex (n=${q.n}): agreement ${pct(q.tp + q.tn, q.n)}`,
    `  both quick=${q.tp}  both agent=${q.tn}  router-only quick (FALSE QUICK risk)=${q.routerOnly}  legacy-only quick=${q.legacyOnly}`,
    `  router quick precision vs legacy: ${pct(q.tp, q.tp + q.routerOnly)} (target >= 95%)`,
    '',
    `READY vs checkCompleteness (n=${g.n}): agreement ${pct(g.bothReady + g.bothWait, g.n)}`,
    `  both ready=${g.bothReady}  both wait=${g.bothWait}  router ready/legacy wait=${g.routerReadyLegacyWait}  router wait/legacy ready=${g.routerWaitLegacyReady}`,
    '',
    `supplement_to_running=true: ${s.supplement}`,
  ].join('\n');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const files = args.length ? args : [shadowLogPath() + '.1', shadowLogPath()];
  const records = readRecords(files);
  if (!records.length) {
    console.log(`no records in ${files.join(', ')}`);
    process.exit(0);
  }
  console.log(formatReport(computeStats(records)));
}

module.exports = { readRecords, computeStats, formatReport };
