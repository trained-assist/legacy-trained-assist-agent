'use strict';
// Quick answers about the profile's connected services — /secrets_list, /secrets_log,
// «github подключен?», «отзови доступ к …» (incl. the Google Drive two-step confirm).
// Deterministic token-store reads/writes, no Claude. Called by intent-engine at the same
// point in its check order as before; returns the reply (string) or undefined when the
// message is not about connected services.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { listConnectedServices, revokeService, getSecretsLog, SERVICE_DISPLAY } = require('../../user-tokens');
const { deleteServiceAccount: deleteGdriveSA } = require('../../gdrive-sa');
const { fuzzyInfoIntent } = require('./fuzzy');

const SECRETS_LIST_INTENT   = /^\/secrets_list$|список.{0,15}подключённых|какие.{0,15}подключ|покажи.{0,15}сервис|мои.{0,15}доступ/i;
const SECRETS_LOG_INTENT    = /^\/secrets_log$|история.{0,15}доступ|лог.{0,15}секрет|обращени.{0,15}секрет/i;
const REVOKE_INTENT         = /отзов|revoke|удал.{0,10}доступ|отключ.{0,10}сервис|убер.{0,10}доступ/i;
const REVOKE_SERVICE_RE     = /(github|гитхаб|weeek|вик|nalog|налог|нпд|самозан|figma|фигма|notion|linear|tilda|тильда|gdrive|гугл|google|dadata)/i;
const REVOKE_CONFIRM_RE     = /^да[,.]?\s*(удал|отключ|подтвер|confirm)|^confirm$|^yes$/i;
const SERVICE_STATUS_INTENT = /(?:подключён|подключен|connected|активен|добавлен|работает|есть ли|подключён ли).{0,30}(?:github|weeek|вик|nalog|налог|нпд|figma|фигма|tilda|тильда|gdrive|getcourse|геткурс)|(?:github|weeek|вик|nalog|налог|нпд|figma|фигма|tilda|тильда|gdrive|getcourse|геткурс).{0,20}(?:подключён|подключен|connected|активен|добавлен|работает|статус|status)/i;
const SERVICE_STATUS_RE     = /(github|weeek|вик|nalog|налог|нпд|figma|фигма|tilda|тильда|gdrive|getcourse|геткурс)/i;

function secretsQuickAnswer(task, { userId, workDir } = {}) {
  // /secrets_list — show connected services
  if (fuzzyInfoIntent(SECRETS_LIST_INTENT, task)) {
    const services = userId ? listConnectedServices(userId) : null;
    if (!services || services.length === 0) {
      return 'Нет подключённых сервисов.\n\nЧтобы подключить: «подключи GitHub», «подключи Налог.ру» и т. д.';
    }
    const lines = services.map(s => {
      const d = s.mtime.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
      return `• ${s.name} — обновлён ${d}`;
    });
    return [
      '🔑 Подключённые сервисы:',
      ...lines,
      '',
      'Отозвать: «отзови доступ к [сервис]»',
      'История обращений: /secrets_log',
    ].join('\n');
  }

  // /secrets_log — show access log
  if (fuzzyInfoIntent(SECRETS_LOG_INTENT, task)) {
    const log = userId ? getSecretsLog(userId) : null;
    if (!log || log.length === 0) return 'История обращений пуста.';
    const lines = log.map(l => {
      const [ts, svcs] = l.split('\t');
      const time = new Date(ts).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      return `${time} — ${svcs}`;
    });
    return '📋 Последние обращения к вашим данным:\n' + lines.join('\n');
  }

  // Service status check — "github подключен?", "статус nalog"
  if (SERVICE_STATUS_INTENT.test(task) && userId) {
    const svcMatch = task.match(SERVICE_STATUS_RE);
    if (svcMatch) {
      const ALIASES = { вик: 'weeek', налог: 'nalog', нпд: 'nalog', фигма: 'figma', тильда: 'tilda', геткурс: 'getcourse', гугл: 'gdrive' };
      const key = ALIASES[svcMatch[1].toLowerCase()] || svcMatch[1].toLowerCase();
      const display = SERVICE_DISPLAY[key] || key;
      const services = listConnectedServices(userId);
      const found = services?.find(s => s.file === key);
      if (found) {
        const d = found.mtime.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
        return `✅ ${display} подключён (обновлён ${d}).`;
      }
      return `❌ ${display} не подключён. Напиши «подключи ${display}» чтобы добавить.`;
    }
  }

  // Revoke — delete a service token
  if (REVOKE_INTENT.test(task)) {
    const svcMatch = task.match(REVOKE_SERVICE_RE);
    if (!svcMatch) return 'Укажи сервис для отзыва, например: «отзови доступ к GitHub»';
    if (!userId) return 'Не удалось определить пользователя.';

    const isGdrive = /gdrive|гугл|google/i.test(svcMatch[1]);

    if (isGdrive && workDir) {
      const pendingFile = path.join(workDir, '.revoke_gdrive_pending.json');
      if (REVOKE_CONFIRM_RE.test(task)) {
        // Confirmed — check pending file
        let pending = null;
        try { pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8')); } catch { /* no pending */ }
        const isValid = pending && pending.expiresAt > Date.now();
        if (!isValid) return '⚠️ Подтверждение устарело. Напиши «отключи Google Drive» ещё раз.';
        try { fs.unlinkSync(pendingFile); } catch { /* ignore */ }
        // Fire-and-forget SA deletion (getQuickAnswer is sync)
        deleteGdriveSA(userId).catch(e => console.error('[gdrive-revoke] SA delete failed:', e.message));
        const revokeResult = revokeService(userId, 'gdrive');
        if (revokeResult === 'not_found') return 'Сервис Google Drive не был подключён.';
        return '✅ Google Drive отключён. Удаление сервис-аккаунта из GCP запущено.';
      } else {
        // First request — ask for confirmation, write pending file
        const gdriveFile = path.join(os.homedir(), 'agent-tokens', String(userId), 'gdrive');
        if (!fs.existsSync(gdriveFile)) return 'Google Drive не был подключён.';
        try {
          fs.writeFileSync(pendingFile, JSON.stringify({ service: 'gdrive', expiresAt: Date.now() + 5 * 60 * 1000 }), { mode: 0o600 });
        } catch { /* non-critical */ }
        return '⚠️ Это удалит подключение Google Drive и сервис-аккаунт из GCP.\n\nПодтвердить? Напиши «да, удали»';
      }
    }

    const result = revokeService(userId, svcMatch[1]);
    if (result === null) return `Не распознал сервис «${svcMatch[1]}». Доступные: GitHub, Weeek, Налог.ру, Figma, Tilda, Google Drive.`;
    if (result === 'not_found') return `Сервис «${svcMatch[1]}» не был подключён.`;
    return `✅ Доступ к ${SERVICE_DISPLAY[result] || result} отозван. Данные удалены с сервера.`;
  }
  return undefined;
}

module.exports = {
  secretsQuickAnswer,
  SECRETS_LIST_INTENT, SECRETS_LOG_INTENT, REVOKE_INTENT, SERVICE_STATUS_INTENT,
};
