#!/usr/bin/env bash
# Выкладка tg-proxy-check: Worker на Cloudflare (REST, без wrangler) + скрипт проверки на хост прокси.
# 2026-10-07 21:53 · v1.1 · Nick Churkin
#
# Настройки — секрет tg-proxy-check в Bitwarden Secrets Manager (утилита `secret`):
#   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN (Workers Scripts Edit, R2 Edit), ADMIN_KEY (тот же, что у tg-digest),
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

curl -sS "${AUTH[@]}" "$API/r2/buckets/$NAME" | grep -q '"success":true' ||
  curl -sS "${AUTH[@]}" -H 'Content-Type: application/json' -d "{\"name\":\"$NAME\"}" "$API/r2/buckets" | ok bucket
echo "бакет: ok"

python3 - > "$META" <<'PY'
import json, os
print(json.dumps({
    'main_module': 'worker.js',
    'compatibility_date': '2026-09-01',
    'bindings': [
        {'type': 'r2_bucket', 'name': 'STATE', 'bucket_name': 'tg-proxy-check'},
        {'type': 'service', 'name': 'NOTIFY', 'service': 'tg-digest'},
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

ssh "$STAND_HOST" test -f /etc/mtg-check.env || { echo "нет /etc/mtg-check.env на $STAND_HOST — создай его (NOTIFY=…)" >&2; exit 1; }
scp -q host/mtg-check "$STAND_HOST:/usr/local/bin/mtg-check"
scp -q host/mtg-check.cron "$STAND_HOST:/etc/cron.d/mtg-check"
ssh "$STAND_HOST" 'chmod 755 /usr/local/bin/mtg-check && chmod 644 /etc/cron.d/mtg-check'
echo "хост: ok"
echo "выложен: Worker $NAME (cron */5), mtg-check на хосте прокси"
