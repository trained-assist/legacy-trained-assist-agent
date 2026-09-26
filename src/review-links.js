'use strict';

// Links to core-owned /hh/* HTTP routes (review, proactive). The routes stay in
// core as a thin shim (epic #1470, architecture choice 1), so building their
// URLs is core's job — not a reason to require HH domain modules.
//
// Must stay byte-compatible with hh-skill's hhReviewUrl()/proactiveUrlFor():
// the same links are emitted by provider tools. Token = HMAC-SHA256(AGENT_SECRET,
// username).slice(0,16), verified by handlers/hh.js.

const { createHmac } = require('crypto');

function publicBase() {
  return (process.env.HH_COLD_SEARCH_PUBLIC_URL || 'https://recruiter-assistant.ru').replace(/\/$/, '');
}

function reviewToken(username) {
  const secret = process.env.AGENT_SECRET || '';
  if (!secret) return '';
  return createHmac('sha256', secret).update(String(username)).digest('hex').slice(0, 16);
}

function link(route, username, vacancyId) {
  const token = reviewToken(username);
  const tokenParam = token ? `&token=${token}` : '';
  const vacancyParam = vacancyId ? `&vacancy_id=${encodeURIComponent(vacancyId)}` : '';
  return `${publicBase()}/hh/${route}?username=${encodeURIComponent(username)}${tokenParam}${vacancyParam}`;
}

const reviewUrl = (username, vacancyId) => link('review', username, vacancyId);
const proactiveUrl = (username, vacancyId) => link('proactive', username, vacancyId);

module.exports = { reviewUrl, proactiveUrl, reviewToken };
