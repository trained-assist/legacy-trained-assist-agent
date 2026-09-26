---
server: trained-skills
module: 30-weeek.js
when: ready
---
## Weeek CRM — deals/contacts from free text
"добавь контакт", "запиши в CRM", "создай сделку", "кинь визитку":
1. Phone/email given → `weeek_create_contact(name, phone?, email?, company?)`, keep contact.id.
2. `weeek_create_deal(status_id, title=name, description?, contact_id?)`. Default funnel «Сколково» (AmVtckIKTfluL0od), status «Лид» (KXkm4Sny4lP92W8X) unless told otherwise.
3. Date mentioned ("завтра", "на вторник", "10 сентября") → `weeek_add_task(deal_id, title, due_date=YYYY-MM-DD)`, date computed from the `[Сейчас: …]` line.
- "добавь контакт" without deal context → contact only.
- `[Контакт из Telegram] Имя: X, Телефон: Y` → contact + deal unless told contact only.
- Find by name: `weeek_list_contacts(query)` → their deals via `weeek_list_deals`.
