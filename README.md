# tg_proxy_check

Мониторинг MTProto-прокси (mtg) с уведомлениями в Telegram от своего бота.

| Что | Где | Проверяет |
|---|---|---|
| `worker.js` | Cloudflare Worker `tg-proxy-check`, cron раз в 5 мин | TCP-порт каждого прокси из `PROXIES` снаружи |
| `host/mtg-check` | хост прокси, `/etc/cron.d/mtg-check` раз в 5 мин | служба mtg активна, SOCKS-выход доводит до api.telegram.org |

Обе проверки: 2 неудачи подряд — одно ⚠️, первая удача после падения — одно ✅.
Обратный туннель, через который mtg выходит в Telegram, — отдельный проект tg_tunnel.

## Настройки

Worker: R2-бакет `tg-proxy-check` (binding `STATE`, ключ `proxy:<host>:<port>`); секреты `BOT_TOKEN` (бот мониторинга —
заведите у @BotFather и напишите ему `/start`, иначе он не сможет написать первым) и `ADMIN_KEY`; переменные `OWNER_ID` (ваш
числовой id) и `PROXIES` вида `proxy1.example.org:443,proxy2.example.org:443`.

`POST https://tg-proxy-check.<subdomain>.workers.dev/notify?key=<ADMIN_KEY>`, тело — текст (HTML Telegram можно):
сообщение владельцу от бота. Ответы: 200 — отправлено, 403 — ключ, 400 — пустое тело, 502 — Telegram не принял.
Текст длиннее 4000 символов уходит несколькими сообщениями простым текстом (без HTML).
Им пользуется скрипт хоста и любые свои скрипты.

Хост прокси: `/etc/mtg-check.env` с `NOTIFY=https://tg-proxy-check.<subdomain>.workers.dev/notify?key=<ADMIN_KEY>`.

## Выкладка

`./deploy.sh` — тест, бакет, Worker с binding'ами и cron, скрипт на хост. В конце печатает адрес /notify. Настройки — из секрета `tg-proxy-check`
(см. заголовок `deploy.sh`).

## Тест

`node test/test_check.mjs`
