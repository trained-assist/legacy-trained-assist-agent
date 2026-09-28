'use strict';

// Google Drive Service Account management — extracted from 50-gdrive.js.
// Only the SA deletion path (used by quick/secrets.js revoke flow).

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const GCP_PROJECT = 'trained-assist-gdrive-sa';
const USER_ID     = process.env.USER_ID || process.env.AGENT_USER_ID || '';

function parseSaJson(userId) {
  const uid = userId || USER_ID;
  const raw = uid
    ? (() => { try { return fs.readFileSync(path.join(os.homedir(), 'agent-tokens', uid, 'gdrive'), 'utf8').trim(); } catch { return null; } })()
    : process.env.GDRIVE_SA_JSON;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function getSaEmail(userId) {
  const sa = parseSaJson(userId);
  return sa ? sa.client_email : null;
}

async function getAdcToken() {
  const res = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5000) }
  );
  if (!res.ok) throw new Error(`GCP metadata ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}

async function deleteServiceAccount(userId) {
  const saEmail = getSaEmail(userId);
  if (!saEmail) return { deleted: false, reason: 'no_sa_configured' };
  let adcToken;
  try { adcToken = await getAdcToken(); }
  catch (e) { return { deleted: false, reason: `adc_error: ${e.message}` }; }
  const url = `https://iam.googleapis.com/v1/projects/${GCP_PROJECT}/serviceAccounts/${encodeURIComponent(saEmail)}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${adcToken}` },
    signal: AbortSignal.timeout(10000),
  });
  if (res.ok || res.status === 404) return { deleted: true };
  const err = await res.json().catch(() => ({}));
  return { deleted: false, reason: `gcp_${res.status}: ${err.error?.message || res.statusText}` };
}

module.exports = { deleteServiceAccount };
