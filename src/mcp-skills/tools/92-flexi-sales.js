'use strict';

// Flexi Sales — exhibition notes + status via site-predeal-notes API
//
// Connects to the flexi-telegram-deal-bot Cloudflare Worker (/api/site-predeal-notes).
// Auth: none needed for server-to-server (no Origin header = allowed by CORS policy).
// Deals: delegate to weeek_create_deal (sales-skill 30-weeek.js).
//
// Context store:
//   flexi/active_exhibition → { event_key, name }

const fs   = require('fs');
const path = require('path');
const { isExpoEnabled } = require('../expo-paths.js');

const NOTES_API = process.env.FLEXI_NOTES_API_URL
  || 'https://flexi-telegram-deal-bot.skillset-apply.workers.dev/api/site-predeal-notes';
const HEALTH_URL = NOTES_API.replace('/api/site-predeal-notes', '/health');

const FETCH_TIMEOUT_MS = 8000;

// ── Context store (mirrors 03-context-store.js) ────────────────────────────────────

function contextPath(skill, key) {
  return path.join(process.cwd(), 'contexts', skill, `${key}.json`);
}

function readContext(skill, key) {
  try {
    const file = contextPath(skill, key);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}

function writeContext(skill, key, value) {
  const file = contextPath(skill, key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ value, updated_at: new Date().toISOString() }, null, 2));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function clean(v) { return (v == null ? '' : String(v)).trim(); }

function activeEventKey() {
  const ctx = readContext('flexi', 'active_exhibition');
  return ctx?.value?.event_key || null;
}

function companyIdFromStand(stand) {
  const s = clean(stand).replace(/\s+/g, '').toLowerCase();
  return s || null;
}

function companyIdFromName(name) {
  return clean(name).toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9а-яёА-ЯЁ-]/g, '').slice(0, 40);
}

async function apiGet(params) {
  const url = new URL(NOTES_API);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach(vi => url.searchParams.append(k, String(vi)));
    else url.searchParams.set(k, String(v));
  }
  try {
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const json = await res.json();
    return { httpStatus: res.status, ...json };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function apiPost(fields) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v != null && v !== '') form.set(k, String(v));
  }
  try {
    const res = await fetch(NOTES_API, { method: 'POST', body: form, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const json = await res.json();
    return { httpStatus: res.status, ...json };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function resolveEventKey(event_key) {
  return clean(event_key) || activeEventKey();
}

const EVENT_NAMES = {
  rosupack2026: 'RosUpack 2026', stonefair2026: 'Индустрия камня 2026',
  oborot2026: 'ECOM Expo 2026', reindustry2026: 'ReIndustry Expo 2026',
  interautomechanica2026: 'ИнтерАвтоМеханика 2026', avtobusexpo2026: 'АвтобусЭкспо 2026',
  ipsa2026: 'IPSA 2026', cpmautumn2026: 'CPM Осень 2026',
  textilesalon2026: 'Textile Salon 2026', otdykhleisure2026: 'ОТДЫХ Leisure 2026',
};

// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  isReady: isExpoEnabled,
  setupTools: [],
  tools: {

    flexi_status: {
      description:
        'Проверить текущую активную выставку и доступность API заметок. ' +
        'Вызывай в начале сессии.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const ctx = readContext('flexi', 'active_exhibition');
        const exh = ctx?.value || null;

        let apiOk = false;
        try {
          const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(3000) });
          apiOk = res.ok;
        } catch {}

        return {
          api_url: NOTES_API,
          api_reachable: apiOk,
          active_exhibition: exh,
          hint: exh
            ? `Активна: ${exh.name || exh.event_key}. Можно добавлять заметки и работать со сделками.`
            : 'Выставка не выбрана. Вызови flexi_set_exhibition(event_key).',
        };
      },
    },

    flexi_set_exhibition: {
      description:
        'Выбрать активную выставку. Сохраняется в context store — запоминается между сессиями.\n\n' +
        'Известные event_key: rosupack2026, stonefair2026, oborot2026, reindustry2026, ' +
        'interautomechanica2026, avtobusexpo2026, ipsa2026, cpmautumn2026, textilesalon2026, otdykhleisure2026',
      inputSchema: {
        type: 'object',
        required: ['event_key'],
        properties: {
          event_key: { type: 'string', description: 'Ключ выставки, напр. rosupack2026' },
          name: { type: 'string', description: 'Понятное название (если не стандартный event_key)' },
        },
      },
      handler: async ({ event_key, name }) => {
        const resolvedName = clean(name) || EVENT_NAMES[event_key] || event_key;
        const value = { event_key: clean(event_key), name: resolvedName };
        writeContext('flexi', 'active_exhibition', value);
        return { ok: true, active_exhibition: value };
      },
    },

    flexi_get_notes: {
      description:
        'Прочитать заметки и статус по компании на выставке.\n\n' +
        'company_id = номер стенда (A12, 14B08) — стабильный идентификатор. ' +
        'Если не знаешь id — используй company_name, id сгенерируется автоматически.',
      inputSchema: {
        type: 'object',
        properties: {
          company_id: { type: 'string', description: 'ID компании или номер стенда' },
          company_name: { type: 'string', description: 'Название компании (если нет company_id)' },
          event_key: { type: 'string', description: 'Ключ выставки (если не установлен через flexi_set_exhibition)' },
        },
      },
      handler: async ({ company_id, company_name, event_key }) => {
        const eventKey = resolveEventKey(event_key);
        if (!eventKey) return { error: 'Выставка не выбрана. Вызови flexi_set_exhibition.' };

        const cid = clean(company_id) || companyIdFromStand(company_name) || companyIdFromName(company_name || '');
        if (!cid) return { error: 'Нужен company_id или company_name' };

        const data = await apiGet({ eventKey, companyId: cid });
        if (!data.ok) return { error: `API вернул ошибку: ${data.error || data.httpStatus}` };

        const notes = (data.notes || []).map(n => ({ text: n.text || '', at: n.createdAt || '' }));
        return {
          event_key: eventKey,
          company_id: cid,
          has_deal: data.hasDeal || false,
          notes,
          note_count: notes.length,
          rejected: data.status?.rejected || false,
          rejection_reason: data.status?.rejectionReason || null,
        };
      },
    },

    flexi_get_notes_bulk: {
      description:
        'Получить заметки и статусы по нескольким компаниям сразу (до 50). ' +
        'Передавай список номеров стендов. Удобно для дайджеста — кто в работе, кто с заметками.',
      inputSchema: {
        type: 'object',
        required: ['company_ids'],
        properties: {
          company_ids: {
            type: 'array', items: { type: 'string' },
            description: 'Список company_id (номеров стендов)',
          },
          event_key: { type: 'string' },
        },
      },
      handler: async ({ company_ids, event_key }) => {
        const eventKey = resolveEventKey(event_key);
        if (!eventKey) return { error: 'Выставка не выбрана. Вызови flexi_set_exhibition.' };
        if (!Array.isArray(company_ids) || !company_ids.length) return { error: 'company_ids должен быть непустым массивом' };

        const ids = company_ids.slice(0, 50).map(clean).filter(Boolean);
        const data = await apiGet({ eventKey, 'companyId[]': ids });
        if (!data.ok) return { error: `API error: ${data.error || data.httpStatus}` };

        const result = Object.entries(data.companies || {}).map(([cid, info]) => ({
          company_id: cid,
          has_notes: info.hasNotes,
          note_count: info.noteCount,
          last_note_at: info.lastNoteAt,
          has_deal: info.hasDeal,
          rejected: info.rejected,
        })).sort((a, b) => b.note_count - a.note_count);

        return {
          event_key: eventKey,
          total: result.length,
          with_notes: result.filter(c => c.note_count > 0).length,
          with_deal: result.filter(c => c.has_deal).length,
          rejected: result.filter(c => c.rejected).length,
          companies: result,
        };
      },
    },

    flexi_add_note: {
      description:
        'Добавить заметку по компании на выставке. ' +
        'Заметка сохраняется в системе прелидов (Cloudflare D1).\n\n' +
        'company_id = номер стенда (напр. B12 или 14A08) — один и тот же id = одна компания. ' +
        'Если стенда нет — используй название компании как id.\n\n' +
        'Weeek-сделку создай отдельно через weeek_create_deal — flexi_add_note только сохраняет заметку.',
      inputSchema: {
        type: 'object',
        required: ['company_name', 'note_text'],
        properties: {
          company_name: { type: 'string' },
          note_text: { type: 'string' },
          company_id: { type: 'string', description: 'Номер стенда или id из каталога. Если не указан — генерируется из stand или company_name.' },
          stand: { type: 'string', description: 'Номер стенда (для генерации id если company_id не указан)' },
          hall: { type: 'string', description: 'Павильон / зал' },
          event_key: { type: 'string' },
        },
      },
      handler: async ({ company_name, note_text, company_id, stand, hall, event_key }) => {
        const eventKey = resolveEventKey(event_key);
        if (!eventKey) return { error: 'Выставка не выбрана. Вызови flexi_set_exhibition.' };
        if (!clean(company_name)) return { error: 'company_name обязателен' };
        if (!clean(note_text)) return { error: 'note_text обязателен' };

        const cid = clean(company_id) || companyIdFromStand(stand) || companyIdFromName(company_name);

        const data = await apiPost({
          eventKey,
          companyId: cid,
          companyName: company_name,
          noteText: note_text,
          ...(stand ? { stand } : {}),
          ...(hall ? { hall } : {}),
        });

        if (!data.ok) return { error: `Ошибка API: ${data.error || JSON.stringify(data)}` };
        return {
          ok: true,
          company_id: cid,
          company_name,
          event_key: eventKey,
          prelead_id: data.preleadId,
          note_count: (data.notes || []).length,
        };
      },
    },

    flexi_reject_company: {
      description:
        'Пометить компанию как отказ (не целевая, уже работаем с конкурентом, отказали). ' +
        'Статус виден в каталоге на сайте и в системе прелидов. Отменить — flexi_unreject_company.',
      inputSchema: {
        type: 'object',
        required: ['company_name'],
        properties: {
          company_name: { type: 'string' },
          company_id: { type: 'string', description: 'Номер стенда или id' },
          stand: { type: 'string' },
          hall: { type: 'string' },
          event_key: { type: 'string' },
        },
      },
      handler: async ({ company_name, company_id, stand, hall, event_key }) => {
        const eventKey = resolveEventKey(event_key);
        if (!eventKey) return { error: 'Выставка не выбрана.' };

        const cid = clean(company_id) || companyIdFromStand(stand) || companyIdFromName(company_name);
        const data = await apiPost({
          eventKey, companyId: cid, companyName: company_name, statusAction: 'reject',
          ...(stand ? { stand } : {}), ...(hall ? { hall } : {}),
        });

        if (!data.ok) return { error: `API error: ${data.error || JSON.stringify(data)}` };
        return { ok: true, company_id: cid, company_name, event_key: eventKey,
          rejected: data.status?.rejected, message: `${company_name} помечена как отказ` };
      },
    },

    flexi_unreject_company: {
      description: 'Снять статус отказа с компании — вернуть в работу.',
      inputSchema: {
        type: 'object',
        required: ['company_name'],
        properties: {
          company_name: { type: 'string' },
          company_id: { type: 'string' },
          stand: { type: 'string' },
          event_key: { type: 'string' },
        },
      },
      handler: async ({ company_name, company_id, stand, event_key }) => {
        const eventKey = resolveEventKey(event_key);
        if (!eventKey) return { error: 'Выставка не выбрана.' };

        const cid = clean(company_id) || companyIdFromStand(stand) || companyIdFromName(company_name);
        const data = await apiPost({ eventKey, companyId: cid, companyName: company_name, statusAction: 'unreject' });

        if (!data.ok) return { error: `API error: ${data.error || JSON.stringify(data)}` };
        return { ok: true, company_id: cid, company_name, message: `Отказ снят с ${company_name}` };
      },
    },

  },
};
