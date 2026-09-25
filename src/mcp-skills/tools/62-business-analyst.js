'use strict';

// Business/systems analyst skill — task formulation BEFORE any execution skill
// (dev/ci-cd/qa/deploy) starts work. This is analysis, not coding: classify how
// big a task really is, ask only the questions that matter for that size, and —
// once a task is big enough to drift — pin requirements down in a durable spec.md
// that execution skills implement against instead of re-litigating from chat memory.
//
// Workflow (spec-driven, tiered by size — see ba_clarify_requirements for the tiers):
//   1. ba_clarify_requirements — classify size, clarify the User Story before any work starts
//   2. ba_write_spec — ONLY for feature-tier work: write a durable EARS-style spec.md
//      into the target workspace (requirements + acceptance criteria + tasks), so intent
//      survives the chat and drift is checkable against something concrete
//   3. hand off to the relevant execution skill (dev_workspace_setup for coding, etc.)
//      which implements against the spec and checks tasks off as it goes

const fs            = require('fs');
const os            = require('os');
const path          = require('path');
const crypto        = require('crypto');
const { execFile }  = require('child_process');
const { promisify } = require('util');
const { PlaybookStore } = require('../../playbook-store');
const execFileAsync = promisify(execFile);

module.exports = {
  isReady: () => true,
  setupTools: [],

  tools: {
    ba_development_playbook: {
      description: 'Engineering playbook for durable planning (Playbook v1 "development", resolved from profile → sibling repo → system). Expand into concrete items, then persist atomically with task_create. No model call or execution. Optional: if the playbook is not connected, returns available:false and the caller just works without the process scaffold.',
      inputSchema: { type: 'object', properties: {} },
      handler: async (_args, ctx) => {
        // Opt-in: the playbook lives in its domain repo (trained-assist-engineering),
        // not the Control Plane. Absence is a normal state, never an error — an agent
        // without it simply codes without the process scaffold.
        const playbook = new PlaybookStore({ profileId: ctx?.userId }).get('development');
        if (!playbook) {
          return {
            available: false,
            message: 'Плейбук разработки не подключён — работай как обычно, без пошагового контракта.',
          };
        }
        return { available: true, playbook };
      },
    },


    ba_clarify_requirements: {
      description: 'Classify a task by size and generate structured clarification questions BEFORE any execution skill (dev/ci-cd/qa/deploy) starts work. Call for every non-trivial task, even ones that look clear — the tier decision itself (trivial/small/feature) is the point: it tells you whether to skip ceremony or write a durable spec via ba_write_spec. Ask only the questions that are actually unclear for that tier.',
      inputSchema: {
        type: 'object',
        required: ['description'],
        properties: {
          description: { type: 'string', description: 'User\'s raw task description' },
          context: { type: 'string', description: 'Optional: what\'s already known about the project' },
        },
      },
      handler: async ({ description, context }) => {
        const known = context ? `\n\nИзвестно: ${context}` : '';
        return {
          instruction: `Задача: "${description.slice(0, 300)}"${known}\n\nШаг 1 — определи размер задачи (см. tiers). Шаг 2 — задай ТОЛЬКО неясные из описания вопросы для этого уровня. Не задавай все вопросы подряд — если задача маленькая, достаточно 1–2, а trivial вообще без вопросов.`,
          tiers: {
            trivial: 'Опечатка, переименование, однострочный багфикс, обновление версии зависимости. Не задавай вопросов, не пиши spec — просто делай.',
            small: 'Один чётко очерченный баг/правка в известном месте, объём — единицы файлов. Максимум 1–2 точечных вопроса из "required" ниже, ba_write_spec НЕ нужен.',
            feature: 'Новая функциональность, неоднозначный объём, несколько файлов/модулей, поведение, которое кто-то будет проверять на "готово/не готово". Пройди все три блока вопросов, затем ПЕРЕД передачей в исполнение вызови ba_write_spec — устный список вопрос-ответ забывается между сессиями, файл в репозитории — нет.',
          },
          questions: {
            required: [
              'Кто пользователь этой фичи? (конечный user, внутренняя команда, API-клиент)',
              'Опиши сценарий: "Как [роль], я хочу [действие], чтобы [цель]"',
              'Acceptance criteria в формате EARS: "КОГДА <триггер/событие>, <система> ДОЛЖНА <наблюдаемая реакция>" — если готового ответа нет, сформулируй сам и покажи на подтверждение, не жди пока сформулируют за тебя',
            ],
            scope: [
              'Какой стек/платформа? (Web/iOS/Android/CLI/API/Telegram bot/другое)',
              'Расширяем существующее или с нуля?',
              'Что точно НЕ входит в эту итерацию? (out of scope — фиксируй явно, это тоже часть спеки)',
            ],
            technical: [
              'Есть ли ограничения по технологиям/библиотекам?',
              'Нужна ли интеграция с чем-то внешним (API, БД, очередь)?',
              'Ожидаемый масштаб: сотни запросов в день или миллионы?',
            ],
          },
          note: 'Спека — не бюрократия ради бюрократии: она нужна только пока задача достаточно большая, чтобы "что мы вообще строим" могло разъехаться между сессиями или файлами. Для trivial/small она — чистые накладные расходы, пропускай без сожаления.',
        };
      },
    },

    ba_write_spec: {
      description: 'Write a durable spec.md into a workspace BEFORE execution starts — only for feature-tier work per ba_clarify_requirements. Captures requirements, EARS-style acceptance criteria, explicit out-of-scope, and a task breakdown as a file committed alongside the code, so intent survives across sessions and can be checked against instead of re-litigated from chat memory. Skip this for trivial/small tasks — it is deliberate overhead that only pays off once a feature is big enough to drift.',
      inputSchema: {
        type: 'object',
        required: ['workspace', 'feature', 'requirements', 'acceptance_criteria'],
        properties: {
          workspace: { type: 'string', description: 'Path to the target workspace (e.g. returned by dev_workspace_setup / dev_new_repo)' },
          feature: { type: 'string', description: 'Short feature name, e.g. "CSV export for reports"' },
          requirements: { type: 'string', description: 'What/why in a few sentences — the user story and its motivation' },
          acceptance_criteria: {
            type: 'array', items: { type: 'string' },
            description: 'EARS-style statements, e.g. "КОГДА пользователь нажимает Export, система ДОЛЖНА скачать CSV с текущим фильтром"',
          },
          out_of_scope: { type: 'array', items: { type: 'string' }, description: 'Explicitly excluded from this iteration' },
          tasks: { type: 'array', items: { type: 'string' }, description: 'Implementation steps, checked off as work progresses' },
        },
      },
      handler: async ({ workspace, feature, requirements, acceptance_criteria, out_of_scope, tasks }) => {
        if (!fs.existsSync(workspace)) throw new Error(`Workspace not found: ${workspace}. Set it up first (e.g. dev_workspace_setup).`);

        const slug = feature.toLowerCase().trim()
          .replace(/[^a-z0-9а-яё\s-]/gi, '')
          .replace(/\s+/g, '-')
          .slice(0, 60) || 'feature';

        const specDir = path.join(workspace, 'specs', slug);
        fs.mkdirSync(specDir, { recursive: true });
        const specPath = path.join(specDir, 'spec.md');

        const criteriaBlock = (acceptance_criteria || []).map(c => `- ${c}`).join('\n') || '- (не заполнено)';
        const outOfScopeBlock = (out_of_scope || []).map(c => `- ${c}`).join('\n') || '- (не заполнено)';
        const tasksBlock = (tasks || []).map(t => `- [ ] ${t}`).join('\n') || '- [ ] (не заполнено)';

        const content = `# ${feature}\n\n` +
          `## Requirements\n${requirements}\n\n` +
          `## Acceptance criteria (EARS)\n${criteriaBlock}\n\n` +
          `## Out of scope\n${outOfScopeBlock}\n\n` +
          `## Tasks\n${tasksBlock}\n`;

        fs.writeFileSync(specPath, content);

        return {
          spec_path: specPath,
          note: 'Файл в рабочей копии, не закоммичен. Добавь его в первый коммит фичи (git add specs/), чтобы спека жила рядом с кодом и её было видно в PR — ревьюер валидирует код против неё, а не против переписки в чате.',
          next_steps: [
            `git -C ${workspace} add ${path.relative(workspace, specPath)}`,
            '# ... implement against tasks above, checking them off as you go ...',
          ],
        };
      },
    },

    // ── Client-facing ТЗ: template + document export ──────────────────────────
    // Separate from ba_write_spec (which is an internal EARS engineering spec).
    // This is the document that goes TO the client/partner — a different genre
    // with its own required sections and its own DOCX/PDF layout pitfalls,
    // both discovered the hard way while producing a real client ТЗ by hand
    // (pandoc + ad-hoc Playwright script per document, no reusable skill code).

    ba_client_spec_template: {
      description: [
        'Вернуть обязательную структуру разделов клиентского ТЗ (не engineering-спека, а документ для клиента/партнёра).',
        'Вызывай перед тем как писать сам текст ТЗ — часть разделов (Input Info, Допущения) раньше выпадали,',
        'пока их не просили отдельно; теперь они часть дефолтной структуры, а не опция.',
      ].join(' '),
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({
        sections: [
          { name: 'Видение и цель проекта', required: true, note: 'Что строим и зачем, в 2-4 абзацах, без деталей реализации.' },
          {
            name: 'Допущения', required: true,
            note: 'На каждое допущение: формулировка, основание (почему предполагаем именно так), риск если неверно, что нужно подтвердить у клиента. Без обоснования допущение выглядит как гадание, а не анализ.',
          },
          { name: 'Пользовательские сценарии', required: true, note: 'Кто и что делает, от лица пользователя/врача/оператора — не только от лица системы.' },
          { name: 'Интеграции', required: true, note: 'Внешние системы/API, авторизация, направление потоков данных.' },
          { name: 'План проекта', required: true, note: 'Фазы, задачи по фазе, сроки в днях.' },
          { name: 'Коммерческие условия', required: true, note: 'Стоимость, порядок оплаты, что входит/не входит.' },
          {
            name: 'Input Info', required: true,
            note: 'ДОСЛОВНЫЕ исходные материалы, не саммари: голосовые — построчно (расшифровка целиком), PDF/документы — полный текст, скриншоты — весь видимый текст. ' +
                  'Цель — чтобы клиент/ревьюер мог свериться, какая именно строка легла в основу какого вывода. Раньше это приходилось отдельно просить.',
          },
        ],
        note: 'Разделы — минимальный обязательный набор. Добавляй специфичные для проекта (напр. "Юридический трек", "Безопасность") по необходимости, но не убирай ни один из этих семи.',
      }),
    },

    ba_export_client_doc: {
      description: [
        'Собрать клиентское ТЗ (markdown) в HTML+PDF+DOCX с проверенной вёрсткой.',
        'Решает накопленные проблемы ручной сборки: DOCX не отставал бы от PDF (общий HTML-источник для обоих форматов),',
        'в PDF нет задвоенного заголовка и служебного file://-пути в футере (рендер через Playwright page.pdf с явными header/footerTemplate),',
        'таблицы не рвутся посередине страницы (page-break-inside:avoid), а широкие по тексту таблицы (допущения и т.п.)',
        'автоматически переключаются на блочную вёрстку "заголовок + буллеты" вместо нечитаемых узких колонок.',
        'После вызова ОБЯЗАТЕЛЬНО визуально проверь и PDF, и DOCX — фикс в одном формате не гарантирует фикс в другом.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        required: ['markdown', 'title', 'slug'],
        properties: {
          markdown:   { type: 'string', description: 'Полный текст ТЗ в markdown (пайп-таблицы поддерживаются и автоматически преобразуются в блоки при необходимости).' },
          title:      { type: 'string', description: 'Заголовок документа (используется как <title> и в футере не используется).' },
          slug:       { type: 'string', description: 'Короткий идентификатор для имени файлов и папки вывода.' },
          output_dir: { type: 'string', description: 'Куда сохранить html/pdf/docx. По умолчанию ./client-docs/<slug> относительно рабочей директории.' },
          footer_signature: { type: 'string', description: 'Текст подписи в футере PDF (например, "Компания / Имя"). Пусто = только номер страницы, НИКОГДА не системный путь.' },
          wide_table_char_threshold: { type: 'number', description: 'Если максимальная длина текста в ячейке таблицы превышает это число символов — таблица конвертируется в блочную вёрстку. По умолчанию 45.' },
        },
      },
      handler: async ({ markdown, title, slug, output_dir, footer_signature = '', wide_table_char_threshold = 45 }) => {
        const cleanSlug = String(slug).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60) || 'doc';
        const outDir = output_dir || path.join(process.cwd(), 'client-docs', cleanSlug);
        fs.mkdirSync(outDir, { recursive: true });

        const processedMd = transformWideTables(markdown, wide_table_char_threshold);
        const mdPath   = path.join(outDir, `${cleanSlug}.md`);
        const htmlPath = path.join(outDir, `${cleanSlug}.html`);
        const pdfPath  = path.join(outDir, `${cleanSlug}.pdf`);
        const docxPath = path.join(outDir, `${cleanSlug}.docx`);
        fs.writeFileSync(mdPath, processedMd, 'utf8');

        const cssPath = path.join(outDir, `.${cleanSlug}-style.css.tmp`);
        fs.writeFileSync(cssPath, `<style>${DOC_CSS}</style>`, 'utf8');

        try {
          await execFileAsync('pandoc', [
            mdPath, '-s', '--metadata', `title=${title}`,
            '--include-in-header', cssPath,
            '-o', htmlPath,
          ]);
        } catch (e) {
          throw new Error(`pandoc (markdown→html) failed — проверь что pandoc установлен: ${e.message}`);
        }

        try {
          await execFileAsync('pandoc', [mdPath, '-s', '--metadata', `title=${title}`, '-o', docxPath]);
        } catch (e) {
          throw new Error(`pandoc (markdown→docx) failed: ${e.message}`);
        } finally {
          fs.rmSync(cssPath, { force: true });
        }

        try {
          const { chromium } = require('playwright');
          const browser = await chromium.launch();
          const page = await browser.newPage();
          await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle' });
          const footerHtml = footer_signature
            ? `<div style="width:100%;font-size:8px;color:#666;padding:0 1.3cm;display:flex;justify-content:space-between;font-family:Arial,sans-serif;">
                 <span>${footer_signature.replace(/</g, '&lt;')}</span>
                 <span><span class="pageNumber"></span>/<span class="totalPages"></span></span>
               </div>`
            : `<div style="width:100%;font-size:8px;color:#666;padding:0 1.3cm;display:flex;justify-content:flex-end;font-family:Arial,sans-serif;">
                 <span><span class="pageNumber"></span>/<span class="totalPages"></span></span>
               </div>`;
          await page.pdf({
            path: pdfPath,
            format: 'A4',
            printBackground: true,
            margin: { top: '1.4cm', bottom: '1.6cm', left: '1.3cm', right: '1.3cm' },
            displayHeaderFooter: true,
            headerTemplate: '<span></span>', // empty — suppresses Chrome's default date/title header
            footerTemplate: footerHtml,
          });
          await browser.close();
        } catch (e) {
          throw new Error(`Playwright PDF render failed: ${e.message}`);
        }

        return {
          html_path: htmlPath,
          pdf_path:  pdfPath,
          docx_path: docxPath,
          checklist: [
            'Открой PDF — проверь: один заголовок (не задвоен), таблицы/блоки не рвутся между страницами, в футере нет file://-пути.',
            'Открой DOCX ОТДЕЛЬНО (не только PDF) — узкие таблицы и переносы там проверяются самостоятельно, конвертер не гарантирует идентичный результат.',
          ],
        };
      },
    },

  },
};

// ── Markdown table → block layout (for wide-cell tables) ────────────────────
// A table where any data cell exceeds the threshold becomes unreadable as narrow
// columns (e.g. 5-column assumption tables). Convert it into one card per row:
// header cells become bold labels, so it reads as a block instead of a strip.
function transformWideTables(markdown, threshold) {
  const lines = markdown.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const isTableStart = /^\s*\|.*\|\s*$/.test(line) &&
      lines[i + 1] && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-');
    if (!isTableStart) { out.push(line); i++; continue; }

    const headerCells = splitRow(line);
    const rows = [];
    let j = i + 2;
    for (; j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j]); j++) {
      rows.push(splitRow(lines[j]));
    }
    const maxLen = Math.max(0, ...rows.flat().map(c => c.length));

    if (maxLen <= threshold) {
      // Keep as a normal table — it's narrow enough to read.
      out.push(...lines.slice(i, j));
    } else {
      for (const row of rows) {
        out.push('<div class="spec-block">');
        out.push('<ul>');
        for (let c = 0; c < headerCells.length; c++) {
          if (row[c] === undefined || row[c] === '') continue;
          out.push(`<li><em>${escapeHtml(headerCells[c])}:</em> ${escapeHtml(row[c])}</li>`);
        }
        out.push('</ul>');
        out.push('</div>');
        out.push('');
      }
    }
    i = j;
  }
  return out.join('\n');
}

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const DOC_CSS = `
/* pandoc -s injects its own "#title-block-header > h1.title" from --metadata title=
   on top of whatever H1 the markdown source already has — a second, pandoc-only
   doubled title distinct from the Chrome print-header one (which page.pdf's empty
   headerTemplate already suppresses). The <title> tag itself is kept for the PDF/tab
   title; only the visible duplicate heading in the body is hidden. */
#title-block-header{display:none}
body{font-family:"Helvetica Neue",Arial,"PT Sans",sans-serif;color:#1a1a1a;line-height:1.5;max-width:880px;margin:0 auto;padding:2em 1.5em;font-size:15px}
h1,h2,h3{page-break-after:avoid;break-after:avoid-page}
h2{margin-top:1.6em;border-bottom:2px solid #2a5b8c;padding-bottom:.2em}
h3{margin-top:1.3em;color:#2a5b8c}
table{border-collapse:collapse;width:100%;margin:.8em 0;page-break-inside:avoid;break-inside:avoid;font-size:.95em}
th,td{border:1px solid #cdd6df;padding:.4em .7em;text-align:left;vertical-align:top}
th{background:#eef3f8}
tr:nth-child(even){background:#fbfcfd}
.spec-block{page-break-inside:avoid;break-inside:avoid;border:1px solid #dde4ea;border-left:4px solid #2a5b8c;border-radius:4px;padding:.7em 1em;margin:.9em 0;background:#f8fafc}
.spec-block ul{margin:.2em 0 0 0}
.spec-block li{margin:.25em 0;font-size:.94em}
.spec-block em{font-style:normal;color:#2a5b8c;font-weight:600}
@media print{body{max-width:100%;padding:0 .3cm;font-size:12.5px}.spec-block,table,h2,h3{page-break-inside:avoid;break-inside:avoid}}
`;

module.exports._internal = { transformWideTables };
