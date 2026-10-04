// Page links must leave the process naming the branded origin, never the raw-IP
// host they were published on before it existed. Regression: /agent/hh/review
// reached a user verbatim because the rewrite allowlist had drifted to a
// two-entry route copy (only hh/proactive and p/*) while the HH surface grew.
import { it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { canonicalizePublicLinks, publicPageBase, publicLinksStatus, pageBase } = require('../../src/public-links');
const { tgFormat } = require('../../src/runner/tg-stream');

const LEGACY = 'https://136-65-7-197.sslip.io';
const LEGACY_AGENT = `${LEGACY}/agent`;
const BRANDED = 'https://recruiter-assistant.ru';

const ENV_KEYS = ['AGENT_PAGES_URL', 'AGENT_PAGES_PREFIXES', 'AGENT_LEGACY_PAGES_BASES', 'AGENT_PUBLIC_URL'];
let savedEnv = null;

function withEnv(values) {
  if (!savedEnv) savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);
}

afterEach(() => {
  if (!savedEnv) return;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv = null;
});

it('rewrites every HH page route, not just the ones an allowlist remembered', () => {
  withEnv({});
  for (const route of ['review', 'ats-editor', 'vacancies', 'plan', 'proactive', 'candidate']) {
    expect(canonicalizePublicLinks(`${LEGACY_AGENT}/hh/${route}?username=alice`))
      .toBe(`${BRANDED}/hh/${route}?username=alice`);
  }
});

it('rewrites published reports and both generations of the legacy base', () => {
  withEnv({});
  expect(canonicalizePublicLinks(`${LEGACY_AGENT}/p/report?password=a%2Bb&raw=1`))
    .toBe(`${BRANDED}/p/report?password=a%2Bb&raw=1`);
  expect(canonicalizePublicLinks(`${LEGACY}/hh/proactive?token=t`)).toBe(`${BRANDED}/hh/proactive?token=t`);
  // /agent is a base path, not part of the path: dropping it must not leave it dangling.
  expect(canonicalizePublicLinks(`${LEGACY_AGENT}/hh/review`)).toBe(`${BRANDED}/hh/review`);
});

it('preserves nested paths, signed params and fragments in plain text, markdown and HTML', async () => {
  withEnv({});
  const suffix = '/hh/review/candidate?username=alice&token=a%2Bb&vacancy_id=123#card';
  for (const wrap of [u => u, u => `[кандидаты](${u})`, u => `<a href="${u}">кандидаты</a>`]) {
    expect(canonicalizePublicLinks(wrap(LEGACY_AGENT + suffix))).toBe(wrap(BRANDED + suffix));
  }
  const html = `<a href="${LEGACY_AGENT}/p/report?password=a%2Bb&amp;raw=1">отчёт</a>`;
  expect((await tgFormat(html, { parse_mode: 'HTML' })).text).toBe(html.replace(LEGACY_AGENT, BRANDED));
  expect((await tgFormat(`${LEGACY_AGENT}/p/report`, {})).text).not.toContain('sslip.io');
});

it('is idempotent', () => {
  withEnv({});
  const once = canonicalizePublicLinks(`${LEGACY_AGENT}/hh/review ${LEGACY}/p/report`);
  expect(canonicalizePublicLinks(once)).toBe(once);
});

it('leaves machine endpoints and lookalikes on the host that answers them', () => {
  withEnv({});
  for (const url of [
    `${LEGACY_AGENT}/connect/hh?t=x`, `${LEGACY_AGENT}/tokens?userId=alice`,
    `${LEGACY_AGENT}/api/hh/proactive/candidates`, `${LEGACY}/tg-proxy/bot123/sendMessage`,
    `${LEGACY}/browser/`, `${LEGACY_AGENT}/images/abc.png`, `${LEGACY_AGENT}/hhx/review`,
    `${LEGACY}.evil.test/agent/hh/review`, 'https://192-0-2-10.sslip.io/agent/hh/review',
    'https://reports.customer.test/p/report',
  ]) expect(canonicalizePublicLinks(url)).toBe(url);
});

it('takes the pages origin from env, and ignores an env that names a legacy host', () => {
  withEnv({ AGENT_PAGES_URL: 'https://report.recruiter-assistant.ru' });
  expect(pageBase()).toBe('https://report.recruiter-assistant.ru');
  expect(canonicalizePublicLinks(`${LEGACY_AGENT}/hh/review`)).toBe('https://report.recruiter-assistant.ru/hh/review');

  withEnv({ AGENT_PAGES_URL: LEGACY_AGENT });
  expect(pageBase()).toBe(BRANDED);
  expect(publicLinksStatus()).toMatchObject({ pagesBase: BRANDED, pagesBaseEnvIgnored: true });
});

it('takes the legacy bases and page prefixes from env', () => {
  withEnv({ AGENT_LEGACY_PAGES_BASES: 'https://old.example.test', AGENT_PAGES_PREFIXES: 'reports' });
  expect(canonicalizePublicLinks('https://old.example.test/reports/x')).toBe(`${BRANDED}/reports/x`);
  // Default legacy host is no longer configured, so it is no longer rewritten.
  expect(canonicalizePublicLinks(`${LEGACY_AGENT}/hh/review`)).toBe(`${LEGACY_AGENT}/hh/review`);
});

it('publicPageBase migrates a legacy base and leaves a profile domain alone', () => {
  withEnv({});
  expect(publicPageBase(`${LEGACY_AGENT}/`)).toBe(BRANDED);
  expect(publicPageBase(LEGACY)).toBe(BRANDED);
  expect(publicPageBase('https://report.recruiter-assistant.ru')).toBe('https://report.recruiter-assistant.ru');
  expect(publicPageBase('')).toBe(BRANDED);
});