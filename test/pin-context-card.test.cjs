// Regression test for buildContextCard's engine/model line.
// Bug: the OpenCode branch read the OLD shared ~/.config/opencode/.current-profile file
// instead of the per-workDir profile (profiles.getOcProfile) — same bug class as #1045,
// which scoped /oc_* switching per-profile but missed this read site, so the pin could show
// a stale profile/model belonging to a different user on the same VM.
const os = require('os'), fs = require('fs'), path = require('path');

let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }

// AGENT_TOKENS_ROOT must be set before requiring user-tokens/runner (module-load-time const).
const tokensRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-card-tokens-'));
process.env.AGENT_TOKENS_ROOT = tokensRoot;
// Issue #1467: ladder health is now read from ~/.config/opencode/model-health.json (per-model,
// shared). Isolate it so a real VM's backoff state cannot change which rung this test resolves.
process.env.OPENCODE_MODEL_HEALTH_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pin-card-health-')), 'model-health.json');

const { _pin } = require('../src/runner');
const { buildContextCard } = _pin;
const profiles = require('../src/profiles');

// Pin only builds when the user has ≥1 connected service (quick-answer commands like /ping are
// contractually one-message-only — see runner-e2e.test.js — so the pin can't fire unconditionally).
function withFakeConnectedService(username) {
  const dir = path.join(tokensRoot, username);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'github'), JSON.stringify({ value: 'fake-token' }));
}

// 1. No connected services → still null (must not regress the one-message quick-answer contract).
{
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-card-'));
  const card = buildContextCard('nobody-' + Date.now(), wd, 1);
  ok(card === null, 'no pin for a brand-new profile (no project, nothing connected)');
  // Added 2026-09-26: once a project exists the card carries it even with nothing connected.
  require('../src/projects').createProject(wd, { type: 'generic', name: 'Все подряд' });
  const card2 = buildContextCard('nobody-' + Date.now(), wd, 1);
  ok(/📁 Проект: Все подряд\n\/project — список/.test(card2 || '') && !/Подключено/.test(card2 || ''), 'nothing connected + a project → card shows the current project, no services line');
}

// 2. OpenCode engine — model must come from THIS workDir's profile (profiles.getOcProfile),
//    not from the old shared .current-profile file.
{
  const username = 'u-oc-' + Date.now();
  withFakeConnectedService(username);
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-card-'));
  profiles.setEngine(wd, 'opencode', 42);
  profiles.setOcProfile(wd, 'free');

  // Simulate stale shared state from a DIFFERENT profile/user on the same VM.
  const staleFile = path.join(os.tmpdir(), 'pin-card-stale-current-profile-' + Date.now());
  fs.writeFileSync(staleFile, 'value');

  const card = buildContextCard(username, wd, 42);
  ok(/⚙️ OpenCode · free/.test(card), `pin shows this workDir's own oc profile (free), got: ${card}`);
  // free's top rung is resolved through the ladder (issue #1061 Фаза 1-2), not a stale
  // ocCfg.model read — profiles.json no longer has a top-level `model` field.
  // xiaomi/mimo-v2.5:free (the previous top rung) was removed as a dead model in #1164 —
  // nemotron-3-super-120b-a12b:free is now first in the ladder.
  ok(/nemotron-3-super-120b-a12b/.test(card), `pin shows free's actual resolved model, got: ${card}`);
  fs.unlinkSync(staleFile);
}

// 3. Codex engine → no misleading Claude model line.
{
  const username = 'u-codex-' + Date.now();
  withFakeConnectedService(username);
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-card-'));
  profiles.setEngine(wd, 'codex', 7);
  const card = buildContextCard(username, wd, 7);
  ok(/⚙️ Codex CLI/.test(card), 'codex engine line present');
  ok(!/⚙️ Claude/.test(card), 'no Claude model line for codex engine');
}

// 4. HH single vacancy — no numbering; review stays bound to this vacancy even after switching.
{
  const username = 'u-hh-single-' + Date.now();
  withFakeConnectedService(username);
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-card-'));
  process.env.AGENT_SECRET = 'test-secret';
  const hhDir = path.join(wd, 'contexts', 'hh');
  fs.mkdirSync(hhDir, { recursive: true });
  fs.writeFileSync(path.join(hhDir, 'active_vacancy.json'), JSON.stringify({ value: { id: 'v1', title: 'Backend разработчик' } }));
  fs.writeFileSync(path.join(hhDir, 'ats_config.json'), JSON.stringify({ value: { pass_threshold: 70 } }));

  const card = buildContextCard(username, wd, 1);
  ok(/💼 Backend разработчик/.test(card), `single vacancy title shown, got: ${card}`);
  ok(/⚡ Скоринг активен/.test(card), 'single vacancy scoring-on line shown');
  const reviewUrl = new URL(card.match(/\[Кандидаты →\]\(([^)]+)\)/)[1]);
  ok(reviewUrl.origin === 'https://recruiter-assistant.ru', 'review uses the public recruiter domain');
  ok(reviewUrl.searchParams.get('vacancy_id') === 'v1', 'single-vacancy review preserves explicit vacancy binding');
  ok(reviewUrl.searchParams.get('username') === username && !!reviewUrl.searchParams.get('token'), 'review preserves signed profile scope');
  ok(!/Активные вакансии/.test(card), 'no multi-vacancy header for a single tracked vacancy');
}

// 5. HH multiple vacancies — numbered blocks, per-vacancy scoring status, vacancy_id-scoped links.
{
  const username = 'u-hh-multi-' + Date.now();
  withFakeConnectedService(username);
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-card-'));
  process.env.AGENT_SECRET = 'test-secret';
  const hhDir = path.join(wd, 'contexts', 'hh');
  fs.mkdirSync(hhDir, { recursive: true });
  fs.writeFileSync(path.join(hhDir, 'active_vacancies.json'), JSON.stringify({
    value: [{ id: 'v1', title: 'Backend разработчик' }, { id: 'v2', title: 'Frontend разработчик' }],
  }));
  fs.writeFileSync(path.join(hhDir, 'ats_config:v1.json'), JSON.stringify({ value: { pass_threshold: 70 } }));
  // v2 deliberately has no ats_config:v2.json → must show as scoring-off.

  const card = buildContextCard(username, wd, 1);
  ok(/Активные вакансии \(2\)/.test(card), `multi-vacancy header present, got: ${card}`);
  ok(/1\. Backend разработчик/.test(card), 'vacancy 1 numbered');
  ok(/2\. Frontend разработчик/.test(card), 'vacancy 2 numbered');
  ok(/vacancy_id=v1/.test(card), 'vacancy 1 links carry its own vacancy_id');
  ok(/vacancy_id=v2/.test(card), 'vacancy 2 links carry its own vacancy_id');
  const v1Idx = card.indexOf('1. Backend');
  const v2Idx = card.indexOf('2. Frontend');
  const v1Block = card.slice(v1Idx, v2Idx);
  ok(/⚡ Скоринг активен/.test(v1Block), 'vacancy 1 (has ats config) shows scoring-on');
  const v2Block = card.slice(v2Idx);
  ok(/⏸ Скоринг выключен/.test(v2Block), 'vacancy 2 (no ats config) shows scoring-off');
}

// 6. Claude model line reflects the model the run actually used, not the static
//    ANTHROPIC_MODEL env. Regression: the card advertised claude-opus-5-5 (systemd env)
//    while the session really ran a different model.
{
  const username = 'u-claude-model-' + Date.now();
  withFakeConnectedService(username);
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-card-'));
  const prev = process.env.ANTHROPIC_MODEL;
  process.env.ANTHROPIC_MODEL = 'claude-opus-5-5';
  const card = buildContextCard(username, wd, 1, 'claude-sonnet-4-5-20250929');
  ok(/⚙️ Claude · sonnet-4-5/.test(card), `card shows the real run model, got: ${card}`);
  ok(!/opus-5-5/.test(card), 'card must not advertise the static env model when the run model is known');
  // No run model available (e.g. quick answer) → env is the only signal, keep old behaviour.
  const cardEnvOnly = buildContextCard(username, wd, 1);
  ok(/⚙️ Claude · opus-5-5/.test(cardEnvOnly), `falls back to env without a live model, got: ${cardEnvOnly}`);
  if (prev === undefined) delete process.env.ANTHROPIC_MODEL; else process.env.ANTHROPIC_MODEL = prev;
}

console.log(`\npin-context-card: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
