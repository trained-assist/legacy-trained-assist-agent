---
server: trained-skills
module: 04-cron.js
when: present
---
## Scheduling (cron_*) — temporarily unavailable (#1489)
cron_create / cron_hh_digest / cron_run_now return ok:false SCHEDULER_UNAVAILABLE. Never say a schedule was created unless a tool returned ok:true with an id. Asked to schedule → one line that schedules are being rebuilt (#1489) + offer to run it now.
