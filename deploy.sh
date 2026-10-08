#!/usr/bin/env bash
# Выкладка tg-proxy-check: Worker на Cloudflare (REST, без wrangler) + скрипт проверки на хост прокси.
# 2026-10-08 08:53 · v1.3 · Nick Churkin
#
# Настройки — секрет tg-proxy-check в Bitwarden Secrets Manager (утилита `secret`):
#   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN (Workers Scripts Edit, R2 Edit), ADMIN_KEY (ключ /notify),
#   BOT_TOKEN (свой бот мониторинга; владелец пишет ему /start), OWNER_ID (кому слать),
#   PROXIES («host:port,host:port»), STAND_HOST (ssh-адрес хоста прокси, root).
set -euo pipefail
cd "$(dirname "$0")"
node test/test_check.mjs
S=$(secret tg-proxy-check | tr -d '\r')
set -a; eval "$S"; set +a; unset S
node -e 'import("./worker.js").then(m => { if (!m.parseProxies(process.env.PROXIES).length) throw new Error("PROXIES пуст"); })'

NAME=tg-proxy-check
API="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID"
HDR=$(umask 077; mktemp)
META=$(umask 077; mktemp)
trap 'rm -f "$HDR" "$META"' EXIT
printf 'Authorization: Bearer %s\n' "$CLOUDFLARE_API_TOKEN" > "$HDR"
AUTH=(-H @"$HDR")
ok() { python3 -c 'import json,sys; d=json.load(sys.stdin); d["success"] or sys.exit(sys.argv[1] + ": " + str(d["errors"]))' "$1"; }

case $(curl -sS -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$API/r2/buckets/$NAME") in
  200) ;;
  404) curl -sS "${AUTH[@]}" -H 'Content-Type: application/json' -d "{\"name\":\"$NAME\"}" "$API/r2/buckets" | ok bucket ;;
  *) echo "R2: не удалось проверить бакет $NAME" >&2; exit 1 ;;
esac
echo "бакет: ok"

python3 - > "$META" <<'PY'
import json, os
print(json.dumps({
    'main_module': 'worker.js',
    'compatibility_date': '2026-09-01',
    'bindings': [
        {'type': 'r2_bucket', 'name': 'STATE', 'bucket_name': 'tg-proxy-check'},
        {'type': 'secret_text', 'name': 'BOT_TOKEN', 'text': os.environ['BOT_TOKEN']},
        {'type': 'plain_text', 'name': 'OWNER_ID', 'text': os.environ['OWNER_ID']},
        {'type': 'secret_text', 'name': 'ADMIN_KEY', 'text': os.environ['ADMIN_KEY']},
        {'type': 'plain_text', 'name': 'PROXIES', 'text': os.environ['PROXIES']},
    ],
}))
PY
curl -sS "${AUTH[@]}" -X PUT "$API/workers/scripts/$NAME" \
  -F "metadata=@$META;type=application/json" \
  -F "worker.js=@worker.js;type=application/javascript+module" | ok script
echo "worker: ok"
curl -sS "${AUTH[@]}" -X PUT -H 'Content-Type: application/json' -d '[{"cron":"*/5 * * * *"}]' \
  "$API/workers/scripts/$NAME/schedules" | ok schedules
echo "cron: ok"
curl -sS "${AUTH[@]}" -X POST -H 'Content-Type: application/json' -d '{"enabled":true}' \
  "$API/workers/scripts/$NAME/subdomain" | ok subdomain
SUB=$(curl -sS "${AUTH[@]}" "$API/workers/subdomain" | python3 -c 'import json,sys; d=json.load(sys.stdin); s=d["success"] and (d.get("result") or {}).get("subdomain"); s or sys.exit("subdomain: нет поддомена workers.dev: " + str(d.get("errors"))); print(s)')
echo "notify: https://$NAME.$SUB.workers.dev/notify"

rc=0; ssh "$STAND_HOST" test -f /etc/mtg-check.env || rc=$?
case $rc in
  0) ;;
  1) echo "нет /etc/mtg-check.env на $STAND_HOST — создай его (NOTIFY=…)" >&2; exit 1 ;;
  *) echo "ssh $STAND_HOST: ошибка $rc" >&2; exit 1 ;;
esac
scp -q host/mtg-check "$STAND_HOST:/usr/local/bin/mtg-check.new"
scp -q host/mtg-check.cron "$STAND_HOST:/etc/cron.d/mtg-check"
ssh "$STAND_HOST" 'chmod 755 /usr/local/bin/mtg-check.new && mv /usr/local/bin/mtg-check.new /usr/local/bin/mtg-check && chmod 644 /etc/cron.d/mtg-check'
echo "хост: ok"
echo "выложен: Worker $NAME (cron */5), mtg-check на хосте прокси"
