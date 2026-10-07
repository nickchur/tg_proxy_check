#!/usr/bin/env bash
# Выкладка tg-proxy-check: Worker на Cloudflare (REST, без wrangler) + скрипт проверки на хост прокси.
# 2026-10-07 21:28 · v1.0 · Nick Churkin
#
# Настройки — секрет tg-proxy-check в Bitwarden Secrets Manager (утилита `secret`):
#   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN (Workers Scripts Edit, R2 Edit), ADMIN_KEY (тот же, что у tg-digest),
#   PROXIES («host:port,host:port»), STAND_HOST (ssh-адрес хоста прокси, root).
set -euo pipefail
cd "$(dirname "$0")"
node test/test_check.mjs
S=$(secret tg-proxy-check)
set -a; eval "$S"; set +a; unset S

NAME=tg-proxy-check
API="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID"
AUTH=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN")
ok() { python3 -c 'import json,sys; d=json.load(sys.stdin); d["success"] or sys.exit(sys.argv[1] + ": " + str(d["errors"]))' "$1"; }

curl -s "${AUTH[@]}" "$API/r2/buckets/$NAME" | grep -q '"success":true' ||
  curl -s "${AUTH[@]}" -H 'Content-Type: application/json' -d "{\"name\":\"$NAME\"}" "$API/r2/buckets" | ok bucket

META=$(mktemp); trap 'rm -f "$META"' EXIT; chmod 600 "$META"
python3 - > "$META" <<'PY'
import json, os
print(json.dumps({
    'main_module': 'worker.js',
    'compatibility_date': '2026-09-01',
    'bindings': [
        {'type': 'r2_bucket', 'name': 'STATE', 'bucket_name': 'tg-proxy-check'},
        {'type': 'service', 'name': 'NOTIFY', 'service': 'tg-digest'},
        {'type': 'secret_text', 'name': 'ADMIN_KEY', 'text': os.environ['ADMIN_KEY']},
        {'type': 'plain_text', 'name': 'PROXIES', 'text': os.environ.get('PROXIES', '')},
    ],
}))
PY
curl -s "${AUTH[@]}" -X PUT "$API/workers/scripts/$NAME" \
  -F "metadata=@$META;type=application/json" \
  -F "worker.js=@worker.js;type=application/javascript+module" | ok script
curl -s "${AUTH[@]}" -X PUT -H 'Content-Type: application/json' -d '[{"cron":"*/5 * * * *"}]' \
  "$API/workers/scripts/$NAME/schedules" | ok schedules

scp -q host/mtg-check "$STAND_HOST:/usr/local/bin/mtg-check"
scp -q host/mtg-check.cron "$STAND_HOST:/etc/cron.d/mtg-check"
ssh "$STAND_HOST" 'chmod 755 /usr/local/bin/mtg-check && chmod 644 /etc/cron.d/mtg-check && test -f /etc/mtg-check.env'
echo "выложен: Worker $NAME (cron */5), mtg-check на хосте прокси"
