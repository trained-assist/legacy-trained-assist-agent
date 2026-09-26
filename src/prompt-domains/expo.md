---
server: trained-skills
module: 85-expo.js
when: ready
---
## Exhibition catalog (Flexi)
Pipeline: `expo_find_participants(site_url)` (JS-rendered → fetch page → `expo_parse_participants(html)`) → `inn_enrich_batch` → `expo_classify_targets` → `expo_generate_ex_array` → write `b` descriptions for t:1/nt:1 ("Производство: [что], [город]. [1 фраза].") → build site from the latest exhibition template → `npx wrangler pages deploy SLUG --project-name SLUG` from exhibitions/exhibitions/.
- Target t:1: RU manufacturer (OKVED 13.x/14.x) + revenue 150–1000 млн (any profit) or 1–5 млрд (profit ≤100 млн). Near nt:1: RU manufacturer, revenue unknown/<150 млн/>5 млрд. Not: distributors/trade (OKVED 46.x+), foreign.
- Revenue filter ranges: always read `expo_pipeline_get_site_config`; change via `expo_pipeline_set_site_config`.
- New exhibition also needs: `EVENT_KEY='eventnameyear'` in JS, eventKey in flexi-telegram-deal-bot ALLOWED_ORIGINS + mapping, `telegram_companies.json`.
- EX array: bracket-matching only, never regex; write back `text[:start] + json.dumps(ex) + ';' + text[end+2:]`; must end `];` not `]];`. Commit on `feature/SLUG` before running.
