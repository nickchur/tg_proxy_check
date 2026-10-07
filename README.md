# tg_proxy_check

Мониторинг MTProto-прокси (mtg) с уведомлениями в Telegram через бота дайджеста ([tg_news_digest](https://github.com/nickchur/tg_news_digest), `POST /notify`).

| Что | Где | Проверяет |
|---|---|---|
| `worker.js` | Cloudflare Worker `tg-proxy-check`, cron раз в 5 мин | TCP-порт каждого прокси из `PROXIES` снаружи |
| `host/mtg-check` | хост прокси, `/etc/cron.d/mtg-check` раз в 5 мин | служба mtg активна, SOCKS-выход доводит до api.telegram.org |

Обе проверки: 2 неудачи подряд — одно ⚠️, первая удача после падения — одно ✅.
Обратный туннель, через который mtg выходит в Telegram, — отдельный проект tg_tunnel.

## Настройки

Worker: R2-бакет `tg-proxy-check` (binding `STATE`, ключ `proxy:<host>:<port>`), service binding `NOTIFY` → Worker `tg-digest`, секрет `ADMIN_KEY`,
`PROXIES` вида `proxy1.example.org:443,proxy2.example.org:443`.
Хост прокси: `/etc/mtg-check.env` с `NOTIFY=https://<worker tg-digest>/notify?key=<ADMIN_KEY>`.

## Выкладка

`./deploy.sh` — тест, бакет, Worker с binding'ами и cron, скрипт на хост. Настройки — из секрета `tg-proxy-check`
(см. заголовок `deploy.sh`).

## Тест

`node test/test_check.mjs`
