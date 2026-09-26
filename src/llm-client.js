'use strict';

// Platform LLM client (epic #1470 P1.3-hermes-scoring): OpenRouter + GigaChat
// transport and per-user key lookup. Lived inside hh-scoring.js, which made
// Hermes (a platform worker) import HH domain code. Domain skills bring their
// own copy; core platform code must import from here, never from hh-*.

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── OpenRouter (fallback) ────────────────────────────────────────────────────

function llmCall(apiKey, model, messages, maxTokens = 2000, temperature = 0.1) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, messages, temperature, max_tokens: maxTokens });
    const req = https.request({
      hostname: 'openrouter.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (parsed.error) reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
          else resolve(parsed.choices[0].message.content);
        } catch (e) { reject(e); }
      });
    });
    req.setTimeout(20_000, () => req.destroy(new Error('openrouter timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── GigaChat (primary) ───────────────────────────────────────────────────────

// Token cache: credentials_b64 → { token, expiresAt }
const _gcTokenCache = {};

// Sber uses a self-signed cert — skip verification on their endpoints.
const GC_AUTH_AGENT = new https.Agent({ rejectUnauthorized: false });
const GC_API_AGENT  = new https.Agent({ rejectUnauthorized: false });

function gcGetToken(credentials) {
  const cached = _gcTokenCache[credentials];
  if (cached && cached.expiresAt > Date.now() + 60_000) return Promise.resolve(cached.token);

  return new Promise((resolve, reject) => {
    const body = 'scope=GIGACHAT_API_PERS';
    const req = https.request({
      hostname: 'ngw.devices.sberbank.ru',
      port: 9443,
      path: '/api/v2/oauth',
      method: 'POST',
      agent: GC_AUTH_AGENT,
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'RqUID': crypto.randomUUID(),
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.access_token) return reject(new Error('GigaChat auth failed: ' + data));
          _gcTokenCache[credentials] = { token: parsed.access_token, expiresAt: parsed.expires_at };
          resolve(parsed.access_token);
        } catch (e) { reject(e); }
      });
    });
    req.setTimeout(15_000, () => req.destroy(new Error('GigaChat auth timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function gcCall(credentials, messages, maxTokens = 2000, temperature = 0.1, model = 'GigaChat') {
  const token = await gcGetToken(credentials);
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, messages, temperature, max_tokens: maxTokens });
    const req = https.request({
      hostname: 'gigachat.devices.sberbank.ru',
      path: '/api/v1/chat/completions',
      method: 'POST',
      agent: GC_API_AGENT,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (parsed.error) reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
          else resolve(parsed.choices[0].message.content);
        } catch (e) { reject(e); }
      });
    });
    req.setTimeout(30_000, () => req.destroy(new Error('GigaChat API timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function readGigachatKey(username) {
  const tokensBase = process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
  const file = path.join(tokensBase, String(username), 'gigachat');
  if (fs.existsSync(file)) {
    const key = fs.readFileSync(file, 'utf8').trim();
    if (key) return key;
  }
  return process.env.GIGACHAT_API_KEY || null;
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

function parseLlmJson(content) {
  if (!content) throw new Error('LLM returned empty content');
  content = content.trim();
  const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) content = fenceMatch[1].trim();
  return JSON.parse(content);
}

function readOrKey(username) {
  const tokensBase = process.env.AGENT_TOKENS_DIR || path.join(os.homedir(), 'agent-tokens');
  const file = path.join(tokensBase, String(username), 'openrouter');
  if (fs.existsSync(file)) {
    const key = fs.readFileSync(file, 'utf8').trim();
    if (key) return key;
  }
  return process.env.OPENROUTER_API_KEY || null;
}

module.exports = {
  llmCall,
  gcGetToken,
  gcCall,
  readGigachatKey,
  readOrKey,
  parseLlmJson,
};
