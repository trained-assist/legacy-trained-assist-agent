'use strict';

// eval-skill-visibility.js — "does the model actually pick this tool when it should
// (and stay away when it shouldn't)" harness.
//
// The bug class this targets (owner's own words): "я делаю скил, всё вроде готово, но он
// не виден юзером или виден не так" — a tool's `description` reads fine to the author but
// fails to get selected for real paraphrased requests (low recall), or fires on unrelated
// requests that merely share a keyword (false positives / precision). check-skill-contract.js
// only checks a description *exists* and isn't too short — it can't tell you whether the
// wording actually routes correctly. This does, empirically, against a cheap LLM judge.
//
// NOT wired into `npm test` — costs OpenRouter calls and has LLM-judge variance, so it's a
// manual/on-demand gate to run before calling a newly extracted skill "ready", not a CI
// blocker. Uses deepseek/deepseek-chat (same "cheap, strong Russian" model already used
// for recruiter outreach — see trained-assist-hh-skill/src/mcp-skills/tools/91b-hh-outreach.js).
//
// Usage:
//   OPENROUTER_API_KEY=... node scripts/eval-skill-visibility.js <seeds.json>
//
// seeds.json shape:
//   {
//     "target_tool": "hh_send_message",
//     "catalog": [ { "name": "...", "description": "..." }, ... ],  // realistic distractor set
//     "should_trigger": ["написать кандидату на hh.ru", ...],
//     "should_not_trigger": ["напиши клиенту в телеграм", ...]
//   }

const fs = require('fs');
const path = require('path');
const os = require('os');
const { readCredentialFile } = require('../src/credential-store');

const MODEL = 'deepseek/deepseek-chat';
const PARAPHRASES_PER_SEED = 3;

function loadApiKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const userId = process.env.USER_ID;
  if (userId) {
    const tokenFile = path.join(os.homedir(), 'agent-tokens', String(userId), 'openrouter');
    if (fs.existsSync(tokenFile)) return readCredentialFile(tokenFile).trim();
  }
  return null;
}

async function llmCall(apiKey, messages, { maxTokens = 400, temperature = 0.7 } = {}) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: MODEL, messages, temperature, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

async function paraphrase(apiKey, seed) {
  const prompt = `Дай ${PARAPHRASES_PER_SEED} разных перефразировки этой фразы на русском — так, как разные пользователи могли бы написать то же самое сообщение помощнику (используй синонимы, разговорный стиль, разный порядок слов). Никаких пояснений, только фразы, каждая с новой строки, без нумерации.\n\nФраза: "${seed}"`;
  const out = await llmCall(apiKey, [{ role: 'user', content: prompt }], { maxTokens: 300, temperature: 0.9 });
  return out.split('\n').map(l => l.replace(/^[-\d.)\s]+/, '').trim()).filter(Boolean).slice(0, PARAPHRASES_PER_SEED);
}

async function judge(apiKey, catalog, message) {
  const toolList = catalog.map(t => `- ${t.name}: ${t.description}`).join('\n');
  const prompt = `Тебе доступны следующие инструменты:\n${toolList}\n\nСообщение пользователя: "${message}"\n\nКакой ИМЕННО ОДИН инструмент из списка ты бы вызвал для этого сообщения? Если ни один не подходит — ответь "none". Ответь ТОЛЬКО именем инструмента или "none", без пояснений.`;
  const out = await llmCall(apiKey, [{ role: 'user', content: prompt }], { maxTokens: 30, temperature: 0 });
  return out.replace(/[`"']/g, '').trim();
}

async function runEval(seedsPath) {
  const seeds = JSON.parse(fs.readFileSync(seedsPath, 'utf8'));
  const apiKey = loadApiKey();
  if (!apiKey) throw new Error('No OpenRouter key found (OPENROUTER_API_KEY env or ~/agent-tokens/<USER_ID>/openrouter)');

  const { target_tool, catalog, should_trigger = [], should_not_trigger = [] } = seeds;
  if (!catalog.some(t => t.name === target_tool)) throw new Error(`target_tool "${target_tool}" not present in catalog`);

  console.log(`Evaluating visibility of "${target_tool}" against a ${catalog.length}-tool catalog\n`);

  // Recall: every seed + its paraphrases should resolve to target_tool
  const recallProbes = [];
  for (const seed of should_trigger) {
    recallProbes.push(seed);
    const variants = await paraphrase(apiKey, seed);
    recallProbes.push(...variants);
  }

  let recallHits = 0;
  for (const probe of recallProbes) {
    const picked = await judge(apiKey, catalog, probe);
    const hit = picked === target_tool;
    if (hit) recallHits++;
    console.log(`  [recall]  ${hit ? 'OK  ' : 'MISS'} "${probe}" -> ${picked}`);
  }

  // Precision: decoys must NOT resolve to target_tool
  let falsePositives = 0;
  for (const probe of should_not_trigger) {
    const picked = await judge(apiKey, catalog, probe);
    const fp = picked === target_tool;
    if (fp) falsePositives++;
    console.log(`  [precision] ${fp ? 'FALSE-POS' : 'ok       '} "${probe}" -> ${picked}`);
  }

  const recall = recallProbes.length ? recallHits / recallProbes.length : null;
  const fpRate = should_not_trigger.length ? falsePositives / should_not_trigger.length : null;

  console.log(`\nrecall: ${recallHits}/${recallProbes.length}${recall !== null ? ` (${(recall * 100).toFixed(0)}%)` : ''}`);
  console.log(`false-positive rate: ${falsePositives}/${should_not_trigger.length}${fpRate !== null ? ` (${(fpRate * 100).toFixed(0)}%)` : ''}`);

  return { target_tool, recall, fpRate, recallHits, recallTotal: recallProbes.length, falsePositives, decoyTotal: should_not_trigger.length };
}

if (require.main === module) {
  const seedsPath = process.argv[2];
  if (!seedsPath) {
    console.error('Usage: node scripts/eval-skill-visibility.js <seeds.json>');
    process.exit(2);
  }
  runEval(path.resolve(seedsPath))
    .then(({ recall, fpRate }) => {
      const ok = (recall === null || recall >= 0.7) && (fpRate === null || fpRate <= 0.2);
      process.exit(ok ? 0 : 1);
    })
    .catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { runEval, judge, paraphrase };
