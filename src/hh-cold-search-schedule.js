'use strict';
const { readActiveVacancies, readHhContext } = require('./hh-utils');
const { loadSchedule, saveSchedule } = require('./hh-proactive-search');
function getSchedules(username, workDir) {
  const saved = loadSchedule(username) || {};
  if (saved.vacancies) return saved.vacancies;
  // Legacy enabled meant the selected vacancy, never every vacancy in HH.
  const selected = readHhContext(workDir, 'hh', 'active_vacancy')?.value;
  return saved.enabled && selected?.id ? { [selected.id]: { ...saved } } : {};
}
function updateSchedule(username, workDir, vacancyId, patch) {
  if (!/^[a-zA-Z0-9_-]+$/.test(String(vacancyId))) throw new Error('vacancy_id required');
  const saved = loadSchedule(username) || {};
  const vacancies = getSchedules(username, workDir);
  vacancies[vacancyId] = { ...vacancies[vacancyId], ...patch };
  saveSchedule(username, { ...saved, enabled: Object.values(vacancies).some(v => v.enabled), vacancies });
  return vacancies[vacancyId];
}
// No vacancy argument means an explicit profile-wide stop, independent of selection.
function disableSearches(username, workDir, vacancyId) {
  if (vacancyId) return updateSchedule(username, workDir, vacancyId, { enabled: false });
  const saved = loadSchedule(username) || {};
  const vacancies = Object.fromEntries(Object.entries(getSchedules(username, workDir))
    .map(([id, state]) => [id, { ...state, enabled: false }]));
  saveSchedule(username, { ...saved, enabled: false, vacancies });
  require('./hh-autoscan').disable(username);
  return { enabled: false, vacancies };
}
// Compatibility for old callers. Telegram cold-search notifications were retired.
// These functions never alter scheduling or create a delivery path.
function setNotifications() { return { notifications_enabled: false, retired: true }; }
function deliveryEnabled() { return false; }
function notificationsEnabled() { return false; }
// The run loop moved to the generic cron (#1489 S7.1). This legacy file keeps only
// per-vacancy page state (starred/archived) and the pre-migration schedule for display.
module.exports = { setNotifications, deliveryEnabled, getSchedules, updateSchedule, disableSearches, notificationsEnabled };
