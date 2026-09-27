'use strict';
// Pinned chat + task confidently about ANOTHER project → 'ask' (owner 2026-09-24).
//   X1  confident verdict for another project → ask, suggested first, pinned second, mismatch meta
//   X2  low confidence → stays auto into the pin
//   X3  verdict = pinned project → auto
//   X4  no verdict (timeout/error/short task) → auto
//   X5  not pinned (single-project auto) → untouched
//   X6  classifier: short task / <2 projects / no key never calls the network
//   X7  classifier: unknown id or garbage JSON → null; valid → clamped verdict
const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.AGENT_TOKENS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-mm-tok-'));
const projects = require('../src/projects');
const match = require('../src/project-match');

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.log('FAIL:', m); } }

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-mm-'));
  const a = projects.createProject(root, 'recruiting: Вакансия Java');
  const b = projects.createProject(root, 'Flexi выставки');
  const c = projects.createProject(root, 'Основной');
  const CHAT = 7;
  projects.setActiveProjectId(root, a.id, CHAT, { pinned: true });
  const all = projects.listProjects(root);
  const d = projects.decideNewSessionProject(root, CHAT);
  ok(d.action === 'auto' && d.pinned && d.project.id === a.id, 'precondition: pinned auto');

  const x1 = match.applyMismatch(d, { projectId: b.id, confidence: 0.92, reason: 'про выставку' }, { allProjects: all });
  ok(x1.action === 'ask', 'X1 ask');
  ok(x1.choices[0].id === b.id && x1.choices[1].id === a.id && x1.choices.length === 3, 'X1 order suggested, pinned, rest');
  ok(x1.mismatch && x1.mismatch.suggested === b.id && x1.mismatch.pinned === a.id, 'X1 mismatch meta');
  ok(x1.pinned === true && x1.project.id === a.id, 'X1 still reports the pin');

  ok(match.applyMismatch(d, { projectId: b.id, confidence: 0.6 }, { allProjects: all }) === d, 'X2 low confidence keeps pin');
  ok(match.applyMismatch(d, { projectId: a.id, confidence: 0.99 }, { allProjects: all }) === d, 'X3 verdict = pin');
  ok(match.applyMismatch(d, null, { allProjects: all }) === d, 'X4 no verdict');
  const unpinned = { action: 'auto', project: c };
  ok(match.applyMismatch(unpinned, { projectId: b.id, confidence: 0.99 }, { allProjects: all }) === unpinned, 'X5 not pinned untouched');

  let calls = 0;
  const f = async () => { calls++; return { ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) }; };
  await match.classifyTaskProject('коротко', all, { apiKey: 'k', fetchImpl: f });
  await match.classifyTaskProject('достаточно длинная задача про выставку', [a], { apiKey: 'k', fetchImpl: f });
  const savedKey = process.env.LLM_LADDER_TOKEN; delete process.env.LLM_LADDER_TOKEN;
  const savedOa = process.env.OPENAI_API_KEY; delete process.env.OPENAI_API_KEY;
  await match.classifyTaskProject('достаточно длинная задача про выставку', all, { fetchImpl: f });
  if (savedKey) process.env.LLM_LADDER_TOKEN = savedKey;
  if (savedOa) process.env.OPENAI_API_KEY = savedOa;
  ok(calls === 0, 'X6 no network for short / single project / no key');

  const reply = (content) => async () => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });
  const long = 'собери каталог участников выставки CPM и классифицируй';
  ok(await match.classifyTaskProject(long, all, { apiKey: 'k', fetchImpl: reply('{"projectId":"nope","confidence":0.99}') }) === null, 'X7 unknown id → null');
  ok(await match.classifyTaskProject(long, all, { apiKey: 'k', fetchImpl: reply('не json') }) === null, 'X7 garbage → null');
  const v = await match.classifyTaskProject(long, all, { apiKey: 'k', fetchImpl: reply('```json\n{"projectId":"' + b.id + '","confidence":1.7,"reason":"выставка"}\n```') });
  ok(v && v.projectId === b.id && v.confidence === 1, 'X7 valid verdict clamped');
  ok(await match.classifyTaskProject(long, all, { apiKey: 'k', fetchImpl: async () => { throw new Error('timeout'); } }) === null, 'X7 error → null');

  // X8 llm-ladder worker error → OpenAI fallback answers; garbage from the ladder is a failed rung
  // (service-llm.js JSON guard), so the OpenAI fallback is tried too (reliability over one call)
  const urls = [];
  const f402 = async (u) => { urls.push(u); return u.includes('llm-ladder')
    ? { ok: false, status: 402, json: async () => ({}) }
    : { ok: true, json: async () => ({ choices: [{ message: { content: '{"projectId":"' + b.id + '","confidence":0.9}' } }] }) }; };
  const v8 = await match.classifyTaskProject(long, all, { apiKey: 'k', openaiKey: 'o', fetchImpl: f402 });
  ok(v8 && v8.projectId === b.id && urls.length === 2 && urls[1].includes('openai.com'), 'X8 402 → openai fallback');
  urls.length = 0;
  const fGarbage = async (u) => { urls.push(u); return { ok: true, json: async () => ({ choices: [{ message: { content: 'x' } }] }) }; };
  ok(await match.classifyTaskProject(long, all, { apiKey: 'k', openaiKey: 'o', fetchImpl: fGarbage }) === null && urls.length === 2 && urls[1].includes('openai.com'), 'X8 ladder garbage → OpenAI fallback tried, still garbage → null');

  // X9 prompt marks the pinned project and lists it first, rest by id (list order used to
  // swing gpt-4o-mini's confidence 0.7↔0.9 on the same task)
  let sent = '';
  const fCap = async (u, o) => { sent = JSON.parse(o.body).messages[1].content; return { ok: true, json: async () => ({ choices: [{ message: { content: '{"projectId":"' + a.id + '","confidence":0.1}' } }] }) }; };
  await match.classifyTaskProject(long, [...all].reverse(), { apiKey: 'k', fetchImpl: fCap, pinnedId: c.id });
  const lines = sent.split('\n').filter(l => l.includes('id='));
  ok(lines[0].startsWith('[ЗАКРЕПЛЁН] id=' + c.id), 'X9 pinned first + marked');
  const restIds = lines.slice(1).map(l => l.match(/id=(\S+)/)[1]);
  ok(JSON.stringify(restIds) === JSON.stringify([...restIds].sort((x, y) => x.localeCompare(y))) && restIds.length === 2, 'X9 rest sorted by id');

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`pin-mismatch: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
