// The mainstream driver's own failures (decider LLM, POST /run, step waits) must not
// land in bugs.jsonl — that file is supposed to report AGENT bugs. 2026-09-28: all 27
// accumulated entries were decider_error/timeout, so the log had stopped reflecting
// the product at all.
process.env.AGENT_DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'mt-driver-errors-'));

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { Orchestrator } = require('../src/mainstream-tester/orchestrator');
const { SYSTEM_ROOT } = require('../src/data-paths');

const GLOBAL_BUGS_FILE = path.join(SYSTEM_ROOT, 'mainstream-test', 'bugs.jsonl');
const DRIVER_LOG_FILE = path.join(SYSTEM_ROOT, 'mainstream-test', 'driver-errors.jsonl');

function newOrchestrator() {
  const stateDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mt-state-'));
  const orch = new Orchestrator({ agentUrl: 'http://127.0.0.1:1', agentSecret: 'x', openrouterKey: 'k', maxSteps: 3, stateDir });
  fs.mkdirSync(stateDir, { recursive: true });
  orch.state = { runId: 'run-test', startedAt: new Date().toISOString(), phase: 'happy_path', username: 'mttest1h', currentStep: 1, maxSteps: 3, conversation: [], bugs: [], status: 'running' };
  return orch;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

test('driver failures go to driver-errors.jsonl as driver_error, never to bugs.jsonl', () => {
  const orch = newOrchestrator();

  orch._logBug({ type: 'decider_error', step: 2, detail: 'The operation was aborted due to timeout' });
  orch._logBug({ type: 'send_error', step: 1, detail: 'POST /run failed: 502' });
  orch._logBug({ type: 'timeout', step: 3, detail: 'Step timeout after 180000ms' });

  const driver = readJsonl(DRIVER_LOG_FILE);
  assert.equal(driver.length, 3);
  assert.deepEqual(driver.map(d => d.kind), ['decider_error', 'send_error', 'timeout']);
  for (const d of driver) {
    assert.equal(d.type, 'driver_error');
    assert.equal(d.runId, 'run-test');
    assert.ok(d.at);
  }
  assert.equal(driver[0].detail, 'The operation was aborted due to timeout');

  assert.deepEqual(readJsonl(GLOBAL_BUGS_FILE), [], 'bugs.jsonl must stay a product-bug log');
  assert.equal(readJsonl(orch.bugsFile).length, 3, 'the per-run file keeps the full record');
  assert.deepEqual(orch._bugCounts(), { product: 0, driver: 3 });
});

test('real agent bugs still go to bugs.jsonl', () => {
  const orch = newOrchestrator();
  // the global files are shared across tests in this file → compare deltas
  const bugsBefore = readJsonl(GLOBAL_BUGS_FILE).length;
  const driverBefore = readJsonl(DRIVER_LOG_FILE).length;

  orch._logBug({ type: 'js_error', step: 1, detail: 'TypeError: cannot read x' });
  orch._logBug({ type: 'empty_response', step: 2, detail: 'len=0' });
  orch._logBug({ type: 'run_fatal', detail: 'boom' });

  const bugs = readJsonl(GLOBAL_BUGS_FILE);
  assert.deepEqual(bugs.slice(bugsBefore).map(b => b.type), ['js_error', 'empty_response']);
  assert.equal(readJsonl(DRIVER_LOG_FILE).length - driverBefore, 1, 'only run_fatal is a driver failure here');
  assert.deepEqual(orch._bugCounts(), { product: 2, driver: 1 });
  assert.deepEqual(orch.state.bugs.map(b => b.type), ['js_error', 'empty_response', 'driver_error']);
  assert.equal(bugsBefore, 0, 'no product bug was logged before this test');
});

test('run summary separates product bugs from driver errors', async () => {
  const orch = newOrchestrator();
  orch._logBug({ type: 'decider_error', step: 1, detail: 'x' });
  orch._logBug({ type: 'js_error', step: 2, detail: 'y' });
  const { product, driver } = orch._bugCounts();
  assert.equal(product, 1);
  assert.equal(driver, 1);
});
