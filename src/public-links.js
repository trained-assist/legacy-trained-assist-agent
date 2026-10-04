'use strict';

// Where do pages a human opens live?
//
// Two origins, two jobs, and conflating them is how a raw-IP sslip.io link
// reached a user in Telegram:
//   • machine origin (AGENT_PUBLIC_URL) — the agent box itself: OAuth
//     /connect/* callbacks, /tokens, /api/*, /tg-proxy, /browser/. Only that box
//     answers them, so pointing them at a branded domain breaks the callback.
//   • pages origin (AGENT_PAGES_URL) — the branded domain of the area. For
//     recruiting that is recruiter-assistant.ru, whose nginx fronts the page
//     routes back to the agent box (infra/nginx/recruiter-assistant.conf).
//
// This module owns the pages origin, plus one repair job: page URLs emitted
// before the branded domain existed still name the raw-IP host, and they turn up
// in old chat messages, model memory and saved drafts. Every outgoing message
// passes through here, so a link never reaches a human with the old host on it.

// Branded origin when env is unset. Hard-coded on purpose: "never hand a
// raw-IP link to a user" must hold even when prod env is missing or stale.
const DEFAULT_PAGES_BASE = 'https://recruiter-assistant.ru';

// Both generations of the raw-IP host — pages were published under the /agent
// base path, and before that at the host root. Configurable so the next origin
// migration is env, not a code edit.
const DEFAULT_LEGACY_PAGE_BASES = [
  'https://136-65-7-197.sslip.io/agent',
  'https://136-65-7-197.sslip.io',
];

// Path prefixes on the legacy origin that are pages for humans. Surface-level on
// purpose: the branded origin fronts whole surfaces, and nginx keeps the
// per-route list (its `location ~ ^/hh/(review|candidate|...)$` block). A
// code-side copy of that route list is exactly what drifted and shipped
// /agent/hh/review un-rewritten while /hh/proactive worked. Everything else on
// the legacy host is a machine endpoint and must keep its own host:
// /connect/*, /tokens, /api/*, /tg-proxy, /browser/, /images/.
const DEFAULT_PAGE_PREFIXES = ['p', 'hh'];

const stripTrailingSlash = (value) => String(value || '').trim().replace(/\/+$/, '');

function csv(value, fallback) {
  const items = String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
  return items.length ? items : fallback;
}

function escapeRe(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function legacyPageBases() {
  // Longest first: a shorter base that is a prefix of a longer one would match
  // early and leave its base path dangling (/agent) on the rewritten URL.
  return csv(process.env.AGENT_LEGACY_PAGES_BASES, DEFAULT_LEGACY_PAGE_BASES)
    .map(stripTrailingSlash)
    .sort((a, b) => b.length - a.length);
}

function pagePrefixes() {
  return csv(process.env.AGENT_PAGES_PREFIXES, DEFAULT_PAGE_PREFIXES);
}

function isLegacyPageBase(base) {
  const value = stripTrailingSlash(base).toLowerCase();
  return value !== '' && legacyPageBases().some((known) => known.toLowerCase() === value);
}

// The pages origin. Env wins; a value that names a legacy host loses to the
// default, so a stale prod env cannot put a raw-IP host back into a link.
function pageBase() {
  const configured = stripTrailingSlash(process.env.AGENT_PAGES_URL || '');
  return configured !== '' && !isLegacyPageBase(configured) ? configured : DEFAULT_PAGES_BASE;
}

// What may follow the base for the match to be a page link: `/` for nested
// paths (candidate under review), the query/fragment start, or a terminator
// that ends the URL inside prose, markdown or HTML.
const AFTER_PREFIX = '(?=[/?#\\s<>"\')\\]]|$)';

let cachedKey = null;
let cachedRe = null;

function legacyPageRe() {
  const bases = legacyPageBases();
  if (!bases.length) return null;
  const prefixes = pagePrefixes();
  const key = `${bases.join('|')} ${prefixes.join('|')}`;
  if (key !== cachedKey) {
    cachedKey = key;
    // Legacy bases carry their own scheme, so no scheme is prepended here. The
    // match ends right after the page prefix, which is captured and re-emitted:
    // the rest of the path, the query and the fragment are never touched.
    cachedRe = new RegExp(
      `(?:${bases.map(escapeRe).join('|')})(?=\\/)(?:\\/(${prefixes.map(escapeRe).join('|')})${AFTER_PREFIX})`,
      'gi',
    );
  }
  return cachedRe;
}

// Rewrite page links that name a legacy origin. Only the origin is replaced —
// path, query and fragment stay byte-for-byte, so signed params, HTML-escaped
// ampersands and fragments survive.
function canonicalizePublicLinks(text) {
  if (typeof text !== 'string' || text === '') return text;
  const re = legacyPageRe();
  if (!re) return text;
  const base = pageBase();
  return text.replace(re, (_match, prefix) => `${base}/${prefix}`);
}

// A base to publish a page under: a legacy base becomes the pages origin, a
// profile's own branded domain is left alone.
function publicPageBase(base) {
  const value = stripTrailingSlash(base);
  if (value === '') return pageBase();
  return isLegacyPageBase(value) ? pageBase() : value;
}

// /health payload: makes "env points at a host we refuse to publish on" a
// visible fact instead of a silent fallback.
function publicLinksStatus() {
  const configured = stripTrailingSlash(process.env.AGENT_PAGES_URL || '');
  return {
    pagesBase: pageBase(),
    pagesBaseFromEnv: configured !== '',
    pagesBaseEnvIgnored: configured !== '' && isLegacyPageBase(configured),
    legacyPageBases: legacyPageBases(),
    pagePrefixes: pagePrefixes(),
  };
}

module.exports = { canonicalizePublicLinks, publicPageBase, publicLinksStatus, pageBase, pagePrefixes, legacyPageBases };