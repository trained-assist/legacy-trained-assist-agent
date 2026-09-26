'use strict';

// expo_pipeline_run — полный оркестратор expo-пайплайна в одном инструменте.
//
// Шаги:
//   1. expo_find_participants (если нет exhibitors.json)
//   2. inn_enrich_batch батчами (max_batches за один вызов)
//   3. expo_pipeline_qualify + expo_build_catalog (когда всё обогащено)
//
// Возвращает прогресс после каждого вызова.
// Агент должен вызвать снова если next_action == 'call_again'.
// Если юзер хочет автодобивание без участия — создать крон через cron_create.

const fs   = require('fs');
const path = require('path');
const { expoDataDir, isExpoEnabled } = require('../expo-paths.js');

function slugify(url) {
  try {
    const u = new URL(url);
    return (u.hostname + u.pathname)
      .replace(/^www\./, '')
      .replace(/[^a-zA-Z0-9а-яёА-ЯЁ]+/g, '-')
      .replace(/-+/g, '-').replace(/^-|-$/g, '')
      .slice(0, 64).toLowerCase();
  } catch {
    return url.replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 64).toLowerCase();
  }
}

function fmtProgress(done, total) {
  const pct = total ? Math.round(done / total * 100) : 0;
  const bar = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));
  return `${bar} ${done}/${total} (${pct}%)`;
}

module.exports = {
  isReady: isExpoEnabled,
  setupTools: [],
  tools: {

  expo_pipeline_run: {
    description: `Full expo pipeline orchestrator — runs all steps in sequence, reports progress.

Steps (auto-detected which ones are needed):
  1. expo_find_participants — scrape exhibitor list from expo website
  2. inn_enrich_batch — enrich companies with INN/revenue in batches (saves after each)
  3. expo_pipeline_qualify — filter by target criteria
  4. expo_build_catalog — generate HTML site ready to deploy

IMPORTANT USAGE PATTERN:
- Call once to start. Check next_action in the response:
  • "call_again" — enrichment in progress, call again with same params to continue
  • "done" — full pipeline complete, site built, deploy with deploy_cmd
  • "create_cron" — too many companies to finish in one session, suggest cron to user

When next_action == "call_again", simply call expo_pipeline_run again with identical params.
The tool resumes from where it stopped — no data loss.

⚠️ НИКОГДА не пиши Python-скрипты для парсинга/обогащения вместо этого инструмента.
Причина: скрипты в /tmp теряют данные при перезапуске VM. Этот инструмент сохраняет
на диск после каждого батча и умеет продолжить с места остановки.

Для задач > 50 компаний используй auto_deploy: true — каталог деплоится на Cloudflare Pages
после каждого батча, данные доступны по URL даже если сессия прервётся.

For hands-free completion without user interaction, create a cron:
  cron_create with schedule "every 10 minutes" and prompt:
  "expo_pipeline_run для <expo_url> event_key=<key> пока не done"`,

    inputSchema: {
      type: 'object',
      required: ['expo_url', 'event_key', 'expo_title'],
      properties: {
        expo_url:      { type: 'string', description: 'URL страницы участников выставки' },
        event_key:     { type: 'string', description: 'Короткий ключ события, e.g. flowersexpo2026' },
        expo_title:    { type: 'string', description: 'Название для сайта, e.g. "Flowers Expo 2026"' },
        catalog_base:  { type: 'string', description: 'URL цифрового каталога выставки (или "")', default: '' },
        favicon_emoji: { type: 'string', description: 'Emoji для favicon', default: '🌸' },
        batch_size:    { type: 'number', description: 'Компаний за батч ИНН (default 20)', default: 20 },
        max_batches:   { type: 'number', description: 'Макс. батчей за один вызов (default 2)', default: 2 },
        production_okved: { type: 'array', items: { type: 'string' }, description: 'ОКВЭД-префиксы производства для t:1/nt:1. Default: ["13.","14."] (текстиль). Для цветов: ["01.","16.","20.","22.","23.","25.","26.","27.","28.","32."]' },
        auto_cron: { type: 'boolean', description: 'Если true и осталось >5 батчей — автоматически создать крон-задачу на каждые 10 минут для продолжения. По умолчанию false.', default: false },
        auto_deploy: { type: 'boolean', description: 'Если true — деплоить каталог на Cloudflare Pages после каждого батча. Данные доступны по URL даже если VM упадёт. Рекомендуется для задач > 50 компаний.', default: false },
        project_name: { type: 'string', description: 'Имя Cloudflare Pages проекта для авто-деплоя (default: expo_id slug)' },
      },
    },

    handler: async ({ expo_url, event_key, expo_title, catalog_base = '', favicon_emoji = '🌸', batch_size = 20, max_batches = 2, production_okved, auto_cron = false, auto_deploy = false, project_name }, ctx) => {
      const workDir = ctx?.workDir || process.cwd();
      const expoId  = slugify(expo_url);
      // Project-aware: writes into the project's data/ when the session is bound
      // to an expo project, else the legacy expo-pipeline/<id>/ dir.
      const expoDir = expoDataDir(workDir, expoId);
      fs.mkdirSync(expoDir, { recursive: true });

      const log     = [];
      const stepLog = (msg) => { log.push(msg); process.stdout.write(msg + '\n'); };

      // ── Шаг 1: expo_find_participants ──────────────────────────────────────
      const exhibitorsPath = path.join(expoDir, 'exhibitors.json');
      let totalCompanies   = 0;

      if (!fs.existsSync(exhibitorsPath)) {
        stepLog(`🔍 Шаг 1/4: Ищу участников ${expo_url} …`);
        const expoTool = require('./85-expo.js').tools.expo_find_participants;
        const found    = await expoTool.handler({ site_url: expo_url, max_companies: 1000 });

        if (found.error || found.warning) {
          return {
            ok: false,
            step: 'find_participants',
            error: found.error || found.warning,
            hint: found.hint || 'Попробуй передать HTML страницы участников в expo_parse_participants.',
            expo_id: expoId,
          };
        }

        const companies = found.companies || [];
        fs.writeFileSync(exhibitorsPath, JSON.stringify(companies, null, 2), 'utf8');

        // Save pipeline meta
        const pipelinePath = path.join(expoDir, 'pipeline.json');
        fs.writeFileSync(pipelinePath, JSON.stringify({
          source_url: expo_url, expo_id: expoId, event_key, expo_title,
          catalog_base, favicon_emoji,
          steps: { find: { done: true, count: companies.length, at: new Date().toISOString() } },
        }, null, 2), 'utf8');

        stepLog(`✅ Найдено ${companies.length} участников`);
        totalCompanies = companies.length;
      } else {
        const ex = JSON.parse(fs.readFileSync(exhibitorsPath, 'utf8'));
        totalCompanies = ex.length;
        stepLog(`✅ Шаг 1/4: Участники уже собраны (${totalCompanies})`);
      }

      // ── Шаг 2: inn_enrich_batch (до max_batches батчей) ──────────────────
      const enrichTool = require('./70-inn-enrichment.js').tools.inn_enrich_batch;

      let batchesDone  = 0;
      let lastEnrichResult;
      let lastBuiltPath = null;

      const buildTool   = require('./88-expo-catalog.js').tools.expo_build_catalog;
      const deployTool  = require('./88-expo-catalog.js').tools.expo_deploy_catalog;
      let lastDeployUrl = null;

      while (batchesDone < max_batches) {
        const result = await enrichTool.handler({
          file: exhibitorsPath,
          out_dir: expoDir,
          batch_size,
          resume: true,
        }, ctx);

        lastEnrichResult = result;

        if (result.error) {
          return { ok: false, step: 'inn_enrich_batch', error: result.error, expo_id: expoId };
        }

        batchesDone++;
        stepLog(`🔍 Шаг 2/4: ИНН ${fmtProgress(result.done, result.total)} — ИНН найдено: ${result.with_inn ?? '?'}`);

        // Rebuild catalog after every batch so the site is always fresh with partial data
        const built = await buildTool.handler({
          expo_id: expoId, event_key, expo_title, catalog_base, favicon_emoji,
          use_targets: false,
          ...(production_okved ? { production_okved } : {}),
        }, ctx);
        if (!built.error) lastBuiltPath = built.outputPath;

        // Deploy partial catalog if auto_deploy is enabled
        if (auto_deploy && lastBuiltPath) {
          const deployed = await deployTool.handler({
            expo_id: expoId,
            ...(project_name ? { project_name } : {}),
          }, ctx);
          if (!deployed.error) {
            lastDeployUrl = deployed.url;
            stepLog(`🌐 Частичный каталог задеплоен: ${lastDeployUrl} (${result.done}/${result.total} компаний)`);
          } else {
            stepLog(`⚠️ Деплой не удался: ${deployed.error}`);
          }
        }

        if (result.remaining === 0) break;
      }

      const enrichDone      = lastEnrichResult?.done      ?? 0;
      const enrichTotal     = lastEnrichResult?.total     ?? totalCompanies;
      const enrichRemaining = lastEnrichResult?.remaining ?? 0;

      // Ещё не всё обогащено — вернём прогресс + путь к частичному сайту
      if (enrichRemaining > 0) {
        const batchesLeft = Math.ceil(enrichRemaining / batch_size);
        const offerCron   = batchesLeft > 5;

        let cronResult = null;
        let cronError = null;
        if (auto_cron && offerCron) {
          try {
            const cronTool = require('./04-cron.js').tools.cron_create;
            const cronPrompt = `expo_pipeline_run для ${expo_url} с event_key=${event_key} и expo_title="${expo_title}" пока next_action != "done". Продолжай обогащение батчами.`;
            const res = await cronTool.handler({ schedule: '*/10 * * * *', task: cronPrompt, label: `expo-${event_key}` }, ctx);
            // Only a real ok:true counts — an {error} object used to be reported as «✅ Крон создан» (#1489).
            if (res && res.ok === true) {
              cronResult = res;
              stepLog(`🕐 Крон создан: ${res.id}`);
            } else {
              cronError = res?.error || 'unknown error';
              stepLog(`⚠️ Крон не создан: ${cronError}`);
            }
          } catch (e) {
            stepLog(`⚠️ Не удалось создать крон: ${e.message}`);
          }
        }

        const msg = [
          `⏳ Обработано ${enrichDone} из ${enrichTotal} компаний`,
          `Осталось: ${enrichRemaining} (≈ ${batchesLeft} батчей по ${batch_size})`,
          lastDeployUrl ? `🌐 Каталог доступен онлайн: ${lastDeployUrl}` : (lastBuiltPath ? `🏗️ Частичный сайт обновлён: ${lastBuiltPath}` : ''),
          '',
          cronResult
            ? `✅ Крон-задача создана — пайплайн продолжится автоматически каждые 10 минут.`
            : cronError
              ? `⚠️ Автопродолжение по расписанию не включено: ${cronError}\n▶️ Напиши "продолжить" — обработаю следующий батч.`
            : offerCron
              ? '▶️ Напиши "продолжить" — обработаю следующий батч. (Автодобивание по расписанию временно недоступно, #1489.)'
              : '▶️ Напиши "продолжить" — обработаю следующий батч.',
        ].filter(Boolean).join('\n');

        return {
          ok: true,
          next_action:   cronResult ? 'cron_scheduled' : 'call_again',
          step:          'inn_enrich_batch',
          progress:      { done: enrichDone, total: enrichTotal, remaining: enrichRemaining, pct: Math.round(enrichDone / enrichTotal * 100) },
          partial_site:  lastBuiltPath,
          partial_url:   lastDeployUrl,
          message:       msg,
          cron_id:       cronResult?.id || null,
          cron_prompt:   offerCron ? `Продолжай вызывать expo_pipeline_run для ${expo_url} с event_key=${event_key} и expo_title="${expo_title}" пока next_action != "done". Вызывай каждые 10 минут.` : null,
          expo_id:       expoId,
          log,
        };
      }

      // ── Шаг 3: expo_pipeline_qualify ──────────────────────────────────────
      stepLog('🎯 Шаг 3/4: Квалификация целевых компаний…');
      const qualifyTool = require('./87-expo-pipeline.js').tools.expo_pipeline_qualify;
      const qualified   = await qualifyTool.handler({ expo_id: expoId }, ctx);

      if (qualified.error) {
        stepLog(`⚠️ Квалификация: ${qualified.error}`);
      } else {
        stepLog(`✅ Целевых: ${qualified.qualified}, отсеяно: ${qualified.rejected}`);
      }

      // ── Шаг 4: expo_build_catalog (финальный — все данные есть) ──────────
      stepLog('🏗️ Шаг 4/4: Финальный каталог…');
      const built = await buildTool.handler({
        expo_id: expoId, event_key, expo_title, catalog_base, favicon_emoji,
        use_targets: false,
        ...(production_okved ? { production_okved } : {}),
      }, ctx);

      if (built.error) {
        return { ok: false, step: 'expo_build_catalog', error: built.error, expo_id: expoId };
      }

      stepLog(`✅ Сайт готов: ${built.outputPath}`);

      // Final deploy if auto_deploy is enabled
      if (auto_deploy) {
        const deployed = await deployTool.handler({
          expo_id: expoId,
          ...(project_name ? { project_name } : {}),
        }, ctx);
        if (!deployed.error) {
          lastDeployUrl = deployed.url;
          stepLog(`🌐 Финальный каталог задеплоен: ${lastDeployUrl}`);
        }
      }

      const summary = [
        `✅ Пайплайн завершён для "${expo_title}"`,
        '',
        `📋 Участников: ${enrichTotal}`,
        `🔍 С ИНН: ${lastEnrichResult?.with_inn ?? '?'}`,
        !qualified.error ? `🎯 Целевых: ${qualified.qualified} | Почти целевых: —` : '',
        '',
        lastDeployUrl
          ? `🌐 Сайт: ${lastDeployUrl}`
          : [`🚀 Задеплой сайт:`, built.deploy_cmd].join('\n'),
      ].filter(s => s !== undefined).join('\n');

      return {
        ok: true,
        next_action: 'done',
        step: 'complete',
        message: summary,
        stats: {
          total:     enrichTotal,
          with_inn:  lastEnrichResult?.with_inn,
          targets:   qualified.qualified,
          rejected:  qualified.rejected,
        },
        output_path: built.outputPath,
        deploy_cmd:  built.deploy_cmd,
        deployed_url: lastDeployUrl,
        expo_id:     expoId,
        log,
      };
    },
  },

}};
