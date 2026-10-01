'use strict';

// OpenRouter app attribution. The "Application" cut of the OpenRouter dashboard is keyed by the
// HTTP-Referer URL of the request — a call without it lands in "Unknown", and then there is no way
// to count or attribute anything (owner 01.10.2026: 571 req/h, 540 of them "Unknown"). Mirrors the
// ladder worker (trained-assist-llm-ladder src/ladder.js, issue #33), so ladder calls and direct
// calls show up in one analytics view under the same referer base.
//
// Every direct https://openrouter.ai call in this repo MUST build its headers here
// (test/or-attribution.test.cjs enforces it) — an inline `Authorization`-only header set is the
// defect this module exists to make impossible to repeat.

const APP_REFERER_BASE = 'https://recruiter-assistant.ru/app';
const DEFAULT_APP_SLUG = 'trained-assist-agent';
const DEFAULT_APP_TITLE = 'Trained Assist';
const SLUG_RE = /^[a-z0-9-]{1,64}$/;
const TITLE_MAX = 64;

// A caller-supplied slug must already be a slug. Anything else (cyrillic, spaces, path traversal,
// overlong) falls back to the repo default instead of being repaired: a half-sanitised slug would
// silently become a DIFFERENT application upstream, which is exactly the confusion we are removing.
function sanitizeAppSlug(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  return SLUG_RE.test(s) ? s : DEFAULT_APP_SLUG;
}

// Header-safe display name: control characters out, length capped, blank → "Trained Assist <slug>"
// so the dashboard list is self-describing without every caller inventing a title.
function sanitizeAppTitle(raw, slug) {
  const s = String(raw == null ? '' : raw).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, TITLE_MAX);
  return s || `${DEFAULT_APP_TITLE} ${slug}`;
}

/**
 * Headers for a direct OpenRouter call.
 * @param {object} o
 * @param {string} [o.apiKey]    OpenRouter key (Bearer)
 * @param {string} o.app         app/purpose slug — becomes the analytics application (required in practice)
 * @param {string} [o.title]     display name; defaults to "Trained Assist <app>"
 * @param {object} [o.extra]     extra headers to merge (e.g. Content-Length)
 * @returns {object} header object for fetch / https.request
 */
function orHeaders({ apiKey, app, title, extra } = {}) {
  const slug = sanitizeAppSlug(app);
  return {
    'Authorization': `Bearer ${apiKey == null ? '' : apiKey}`,
    'Content-Type': 'application/json',
    // The URL *is* the application id upstream; the title is only its display name.
    'HTTP-Referer': `${APP_REFERER_BASE}/${slug}`,
    'X-OpenRouter-Title': sanitizeAppTitle(title, slug),
    // Keep our internal tools out of public provider rankings while keeping the analytics.
    'X-OpenRouter-App-Visibility': 'hidden',
    ...(extra && typeof extra === 'object' ? extra : {}),
  };
}

module.exports = {
  APP_REFERER_BASE,
  DEFAULT_APP_SLUG,
  DEFAULT_APP_TITLE,
  sanitizeAppSlug,
  sanitizeAppTitle,
  orHeaders,
};
