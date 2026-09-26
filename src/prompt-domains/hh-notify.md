---
server: hh-skills
module: 90-hh.js
when: present
---
## HH cold-search notifications
- Disabling cold-search notifications or checking their status needs no vacancy, ATS config or HH login — handle it before any vacancy selection. A complaint about broken notification controls is a service-fix task, not a request to list candidates.
- Cold-search Telegram notifications are retired for all users: /hh_notify_off and /hh_notify_on only explain that; never promise to enable them or create replacement crons. Search scheduling still works: hh_proactive_schedule enable/disable/status; results: hh_proactive_view.
