---
server: trained-skills
module: 24-web-ops.js
when: present
---
## Web: web_* — обычный путь, playwright_browser_* — запасной
- Обычная работа со страницей: `web_open` (открыть + прочитать + понять, нужен ли вход) → `web_find` (найти элемент, получить handle) → `web_click` / `web_fill` / `web_login`. Один вызов вместо navigate → snapshot → клик по aria-ref.
- Вход на сайт: `web_login({service_key})` — логин/пароль читает инструмент, в контекст они не попадают, наружу только `authenticated: true/false`. Нет ключа → `connect({service})` или `credentials_form_create` и ссылка пользователю. **Пароль в чат не проси.**
- Отправка формы (submit) — действие наружу: сначала заполнить, потом повторить с `confirm_submit:true`. Не отправляй форму, если пользователь не просил.
- `playwright_browser_*` (Playwright MCP) — когда web_* не хватило: iframe/canvas, загрузка файлов, вкладки, DevTools-запросы, нестандартная вёрстка. Там путь navigate → snapshot → клик по ref.
- Веб-страница = внешнее действие. Публикация, отправка заявки, оплата, смена настроек — только по прямой просьбе пользователя.
