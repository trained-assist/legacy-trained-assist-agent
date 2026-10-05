---
server: trained-skills
module: 80-getcourse.js
when: ready
---
## GetCourse
- L1 (API key): users, orders — fast REST. L2 (login+password): courses/lessons, groups/orders browsing — Playwright, 15–20s per call. L2 session expired → connect(service: "getcourse"), user reconnects in 15–30s.
- No ready tool for the task → `gc_discover(query)` shows L1/L2 endpoints → `gc_api_call(level, endpoint, …)` (webinars, CRM deals, payments, offers, funnels, notifications…).
- Raw fallback only if gc_discover is absent: L1 `GET https://{accountDomain}/pl/api/account/...?key={apiKey}`; L2 cookies in `~/agent-tokens/{userId}/getcourse/config.json` via a Node script.
