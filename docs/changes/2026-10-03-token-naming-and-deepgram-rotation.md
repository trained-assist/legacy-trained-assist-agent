# 2026-10-03 — Канонические имена токенов + ротация Deepgram (PR #2054, speech-skill #8; эпик #2046)

Сжатая выжимка: что решили и почему. Живой сценарий —
`docs/user-scenarios/engineering/03-credential-reachability.md` (US-CRED-04) и
`docs/user-scenarios/speech/01-speech-transcribe.md` (Шаг 0-бис).
Issue [#2046](https://github.com/trained-assist/trained-assist-agent/issues/2046).

## Решения

1. **Переименование аддитивное, не жёсткий переключатель.** Канонические имена
   `{SCOPE}_{SERVICE}_{TYPE}` (`ADMIN_CLOUDFLARE_API_TOKEN`, `SYSTEM_DEEPGRAM_API_KEY`,
   `ADMIN_GITHUB_API_TOKEN`, `SYSTEM_HEADHUNTER_CLIENT_ID/SECRET`) вводятся рядом со
   старыми. `loadSecrets()` отдаёт оба поля; каноническое побеждает, старое — фолбэк.
   Хост, чей Secret Manager ещё не мигрирован, продолжает работать через aliases.
2. **`ADMIN_GITHUB_API_TOKEN` не добавлен в deploy printf.** Резолвится из Secret
   Manager; legacy `GITHUB_ISSUES_TOKEN` остаётся в `secrets.env` для обратной
   совместимости. Остальные канонические имена уже `written_to: []`.
3. **`engineEnv` и MCP tool env несут оба имени.** Скиллы читают привычные
   `DEEPGRAM_API_KEY`/`CLOUDFLARE_API_TOKEN`/`HH_CLIENT_ID`; контракт достижимости
   проверяет каноническое имя — поэтому оба присутствуют.
4. **Пользовательский CF-токен — profile-credential.** `core:cloudflare-user` в
   реестре; читается напрямую `cf-pages.js`, в env движка не попадает.
5. **Deepgram: несколько ключей с ротацией по лимитам** (speech-skill #8).
   `key.txt` принимает JSON-массив; `transcribeRotated` выбирает ключ с наибольшим
   остатком по `X-RateLimit-*` и переключается при 401/403/429. Журнал квот —
   `keys.json` (телеметрия, не секрет). Новые тулы: `speech_add_key` (добавить без
   затирания), `speech_list_keys` (лимиты, не ключи).

## Что НЕ трогали

- **Cloudflare** — только публикация сайтов (`cf-pages.js`). В токенах Deepgram не
  участвует; ключи лежат на GCP VM в `~/agent-tokens/<user>/deepgram/`.
- **Шифрование** — уже было (epic #1789, AES-256-GCM). Ротация использует тот же
  `credential-store`.
- **HH** — авторизацию владелец проходит в UI; канонические имена в реестре, legacy
  работает через aliases.

## Проверки

- `node --test` — 57/58 pass (1 skipped), 0 fail
- `npm run test:cjs` — 196/199 (3 предсуществующих падения)
- `npm run lint` / `npm run check` — clean
- `node scripts/check-env-sync.js` — all checks passed
- speech-skill: `npm test` — 49/49, `manifest:check` — clean
