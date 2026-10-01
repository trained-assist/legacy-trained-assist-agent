---
server: trained-skills
module: 24-web-ops.js
when: present
---
## Web: web_* — обычный путь, playwright_browser_* — запасной
- Обычная работа со страницей: `web_open` (открыть + прочитать + понять, нужен ли вход) → `web_find` (найти элемент, получить handle) → `web_click` / `web_fill` / `web_login`. Один вызов вместо navigate → snapshot → клик по aria-ref.
- Страница не влезла в ответ: `web_open` вернул `truncated` и `totalChars` — продолжай через `web_text({offset: nextOffset})`. Повторный `web_open` с бОльшим max_chars — не продолжение: страница загрузится заново и текст сместится.
- «Набери и жми Enter»: `web_fill({fields, press:"Enter"})`. `press` и `submit` вместе нельзя. Если поле внутри формы, Enter её отправит — только по прямой просьбе пользователя.
- Вход на сайт: `web_login({service_key})` — логин/пароль читает инструмент, в контекст они не попадают, наружу только `authenticated: true/false`. Нет ключа → `connect({service})` или `credentials_form_create` и ссылка пользователю. **Пароль в чат не проси.**
- Отправка формы (submit) — действие наружу: сначала заполнить, потом повторить с `confirm_submit:true`. Не отправляй форму, если пользователь не просил.
- `playwright_browser_*` (Playwright MCP) — когда web_* не хватило: iframe/canvas, загрузка файлов, вкладки, DevTools-запросы, нестандартная вёрстка. Там путь navigate → snapshot → клик по ref.
- Веб-страница = внешнее действие. Публикация, отправка заявки, оплата, смена настроек — только по прямой просьбе пользователя.
