---
server: trained-skills
module: 92-flexi-sales.js
when: ready
---
## Flexi sales at exhibitions
- `flexi_set_exhibition(event_key)` once (e.g. rosupack2026) — persists in context.
- Notes: `flexi_add_note(company_name, note_text, stand?)` → D1, visible on {eventKey}-floorplans-2026.pages.dev. Read: `flexi_get_notes` / `flexi_get_notes_bulk`. Reject/undo: `flexi_reject_company` / `flexi_unreject_company`.
- company_id = stand number (A12, 14B08) when known, else sanitized name — one consistent id per company.
- Deals are created with `weeek_create_deal`; flexi_* only manages notes/status.
