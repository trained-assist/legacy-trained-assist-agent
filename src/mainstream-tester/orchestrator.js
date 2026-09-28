'use strict';
// Test orchestrator: manages a single test run (happy path + alternative path).
// State is persisted to disk so it survives process restarts.
// Wired to FakeTelegram events via onFinalMessage().

const fs = require('fs');
const path = require('path');
const { decideFirstAction, decideNextAction, fallbackAction } = require('./mainstream-decider');
const { SYSTEM_ROOT } = require('../data-paths');

const STEP_TIMEOUT_MS = 180_000; // 3 min per step (Claude can be slow)
const TEST_CHAT_ID = 999_000_001;

// Durable cross-run bug log — separate from the per-invocation stateDir (which
// stays isolated to avoid GTD spillover between agent instances). Every bug
// from every run also lands here so bugs accumulate instead of being scattered
// across timestamped directories. Holds PRODUCT bugs (agent responses) only.
const GLOBAL_BUGS_FILE = path.join(SYSTEM_ROOT, 'mainstream-test', 'bugs.jsonl');
// Failures of the test driver ITSELF (decider LLM, POST /run, step waits) get their
// own log: 27/27 entries in bugs.jsonl were driver errors, so the file had stopped
// reporting agent bugs at all (2026-09-28).
const DRIVER_LOG_FILE = path.join(SYSTEM_ROOT, 'mainstream-test', 'driver-errors.jsonl');
const DRIVER_ERROR_KINDS = new Set(['decider_error', 'send_error', 'timeout', 'run_fatal']);

// Patterns that indicate something went wrong in the agent response.
const BUG_PATTERNS = [
  { re: /TypeError|ReferenceError|SyntaxError/i, type: 'js_error' },
  { re: /Internal Server Error/i, type: 'server_error' },
  { re: /\bat line \d+/i, type: 'stack_trace' },
  { re: /Unhandled rejection/i, type: 'unhandled_rejection' },
  { re: /Cannot read propert/i, type: 'null_deref' },
];

class Orchestrator {
  constructor({ agentUrl, agentSecret, openrouterKey, maxSteps = 7, stateDir }) {
    this.agentUrl = agentUrl;
    this.agentSecret = agentSecret;
    this.openrouterKey = openrouterKey;
    this.maxSteps = maxSteps;
    this.stateDir = stateDir;
    this.state = null;
    this._responseResolve = null;
    this._responseReject = null;
    this._stepTimer = null;
  }

  get stateFile() { return path.join(this.stateDir, 'current-run.json'); }
  get bugsFile() { return path.join(this.stateDir, 'bugs.jsonl'); }

  _saveState() {
    fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
  }

  // Product bugs go to bugs.jsonl (agent problems); driver failures go to
  // driver-errors.jsonl as type=driver_error with the original kind in `kind`.
  // Both keep landing in this state.bugs array / the per-run bugsFile.
  _logBug(bug) {
    const entry = { ...bug, runId: this.state?.runId, at: new Date().toISOString() };
    const isDriver = DRIVER_ERROR_KINDS.has(bug.type);
    if (isDriver) {
      entry.kind = bug.type;
      entry.type = 'driver_error';
      fs.mkdirSync(path.dirname(DRIVER_LOG_FILE), { recursive: true });
      fs.appendFileSync(DRIVER_LOG_FILE, JSON.stringify(entry) + '\n');
      console.warn(`[driver] kind=${entry.kind} step=${bug.step ?? '?'} detail=${(bug.detail || '').slice(0, 120)}`);
    } else {
      fs.mkdirSync(path.dirname(GLOBAL_BUGS_FILE), { recursive: true });
      fs.appendFileSync(GLOBAL_BUGS_FILE, JSON.stringify(entry) + '\n');
      console.warn(`[bug] type=${bug.type} step=${bug.step ?? '?'} detail=${(bug.detail || '').slice(0, 120)}`);
    }
    fs.mkdirSync(this.stateDir, { recursive: true });
    fs.appendFileSync(this.bugsFile, JSON.stringify(entry) + '\n');
    this.state.bugs.push(entry);
    this._saveState();
  }

  _bugCounts() {
    const driver = this.state.bugs.filter(b => b.type === 'driver_error').length;
    return { product: this.state.bugs.length - driver, driver };
  }

  _detectBugs(text, step) {
    const bugs = [];
    if (!text || text.length < 5) {
      bugs.push({ type: 'empty_response', step, detail: `len=${text?.length ?? 0}` });
      return bugs;
    }
    for (const { re, type } of BUG_PATTERNS) {
      if (re.test(text)) {
        bugs.push({ type, step, detail: text.slice(0, 300) });
        break;
      }
    }
    return bugs;
  }

  _parseButtons(replyMarkup) {
    if (!replyMarkup?.inline_keyboard) return [];
    return replyMarkup.inline_keyboard.flat().map(b => ({
      text: b.text || '',
      callback_data: b.callback_data || '',
    }));
  }

  // Called by fake-telegram when agent finishes streaming a response.
  onFinalMessage(msg) {
    if (this._responseResolve) {
      clearTimeout(this._stepTimer);
      this._stepTimer = null;
      const cb = this._responseResolve;
      this._responseResolve = null;
      this._responseReject = null;
      cb(msg);
    }
  }

  _waitForResponse() {
    return new Promise((resolve, reject) => {
      this._responseResolve = resolve;
      this._responseReject = reject;
      this._stepTimer = setTimeout(() => {
        this._responseResolve = null;
        this._responseReject = null;
        reject(new Error(`Step timeout after ${STEP_TIMEOUT_MS}ms`));
      }, STEP_TIMEOUT_MS);
    });
  }

  async _sendTask(task) {
    const res = await fetch(`${this.agentUrl}/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.agentSecret}`,
      },
      body: JSON.stringify({
        userId: TEST_CHAT_ID,
        username: this.state.username,
        task,
        context: '',
        initialMsgId: 0,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`POST /run failed: ${res.status}`);
    return res.json();
  }

  async startRun() {
    const runId = `run-${Date.now()}`;
    // Each run + each path gets a fresh username → fresh session in the agent.
    // username must be alphanumeric, max ~20 chars.
    const runTag = runId.slice(-8);
    this.state = {
      runId,
      startedAt: new Date().toISOString(),
      phase: 'happy_path',
      username: `mt${runTag}h`,
      currentStep: 0,
      maxSteps: this.maxSteps,
      conversation: [],
      bugs: [],
      status: 'running',
    };
    fs.mkdirSync(this.stateDir, { recursive: true });
    this._saveState();
    console.log(`[orchestrator] Run ${runId} started (maxSteps=${this.maxSteps})`);

    try {
      await this._runPath(false);

      this.state.phase = 'alternative_path';
      this.state.currentStep = 0;
      this.state.conversation = [];
      // Fresh username → fresh agent session for alternative path
      this.state.username = `mt${runId.slice(-8)}a`;
      this._saveState();
      console.log('[orchestrator] Starting alternative path');
      await this._runPath(true);

      this.state.status = 'completed';
      this._saveState();
      const { product, driver } = this._bugCounts();
      console.log(`[orchestrator] Run ${runId} done. Bugs found: ${product} (product) + ${driver} driver errors`);
    } catch (err) {
      this.state.status = 'error';
      this._logBug({ type: 'run_fatal', detail: err.message });
      console.error('[orchestrator] Run failed:', err.message);
    }

    return this.state;
  }

  async _runPath(alternativeMode) {
let action = await decideFirstAction(alternativeMode);
    const previousActions = []; // track to prevent looping

    for (let step = 1; step <= this.maxSteps; step++) {
      this.state.currentStep = step;
      this._saveState();

      const taskText = action.type === 'text'
        ? action.content
        : `[button:${action.buttonText}]`;

      console.log(`[orchestrator] ${alternativeMode ? 'alt' : 'main'} step ${step}: "${taskText}"`);
      this.state.conversation.push({ role: 'user', text: taskText });
previousActions.push(action);

      try {
        await this._sendTask(taskText);
      } catch (err) {
        this._logBug({ type: 'send_error', step, detail: err.message });
        break;
      }

      let responseMsg;
      try {
        responseMsg = await this._waitForResponse();
      } catch (err) {
        this._logBug({ type: 'timeout', step, task: taskText, detail: err.message });
        break;
      }

      const responseText = responseMsg.text || '';
      this.state.conversation.push({ role: 'agent', text: responseText });
      this._saveState();

      for (const bug of this._detectBugs(responseText, step)) {
        this._logBug({ ...bug, task: taskText });
      }

      if (step >= this.maxSteps) break;

      const buttons = this._parseButtons(responseMsg.replyMarkup);
      try {
        action = await decideNextAction({
          conversation: this.state.conversation,
          latestText: responseText,
          buttons,
          stepNumber: step + 1,
          alternativeMode,
          openrouterKey: this.openrouterKey,
previousActions,
        });
        console.log(`[orchestrator] Next action: ${JSON.stringify(action)}`);
      } catch (err) {
        this._logBug({ type: 'decider_error', step, detail: err.message });
        // Same deterministic diversity as the LLM-less fallback — never a fixed word.
        action = fallbackAction({ buttons, previousActions });
      }
    }
  }
}

module.exports = { Orchestrator };
