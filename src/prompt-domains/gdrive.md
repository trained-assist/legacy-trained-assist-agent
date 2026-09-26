---
server: trained-skills
module: 50-gdrive.js
when: present
---
## Google Drive — reading files
1. Public file/sheet ("всем по ссылке") → gdrive_public_sheet / gdrive_public_folder, no service account needed.
2. Otherwise gdrive_status first. connected → gdrive_read_file; on 403 say: "Поделись файлом/папкой с <sa_email из gdrive_status> — это сервисный аккаунт агента. После шаринга пришли ссылку ещё раз."
3. not_configured → gdrive_setup, then: "Готово! Расшарь нужные папки/файлы с этим email: <sa_email>. После шаринга пришли ссылку — прочитаю."
Never claim you can read a private file before verifying access; only ever ask to share with the SA email.
