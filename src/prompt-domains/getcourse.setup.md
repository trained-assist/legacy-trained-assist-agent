---
server: trained-skills
module: 80-getcourse.js
when: not-ready
---
## GetCourse — not connected
On "подключи GetCourse" call connect(service: "getcourse") and reply: "Получишь ссылку для подключения. Введи домен + API ключ (L1: ученики/заказы) и/или логин+пароль (L2: курсы/уроки)."
