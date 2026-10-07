# План: мониторинг семейных MTProto-прокси (tg_proxy_check)

> Исполняется скиллом execute: свежий исполнитель на задачу; задача видит
> только собственный текст. Шаги — чекбоксы `- [ ]`.

**Спека:** docs/sberpowers/specs/proxy-check-baseline.md (REQ-pxc-01…REQ-pxc-09)
**Цель:** отдельный Cloudflare Worker раз в 5 минут проверяет TCP-порты прокси и шлёт ⚠️/✅ владельцу через
/notify дайджеста; скрипт проверки стенда лежит в том же репозитории; всё выкладывается одной командой.
**Архитектура:** чистая логика (разбор `PROXIES`, переходы состояния) — экспортируемые функции в `worker.js`,
тестируются в node с подменой сокета, хранилища и binding'а. Скрипт стенда — POSIX sh без изменения поведения.
Выкладка — REST API Cloudflare из `deploy.sh` (без wrangler), секреты из Bitwarden.

## Глобальные ограничения
- Бесплатный тариф Workers: вызов ≤ 10 мс CPU (ожидание сокета не считается), ≤ 50 подзапросов. Cron `*/5 * * * *`.
- Хранилище — бакет R2 `tg-proxy-check`, binding `STATE`, ключ `proxy:<host>`, значение `{"fails":n,"down":bool}`.
- Binding `NOTIFY` — service binding на Worker `tg-digest`; секрет `ADMIN_KEY` (тот же, что у tg-digest); `PROXIES` — plain text.
- Скрипты хостов — POSIX sh, только curl и systemctl. Пути и cron на стенде прежние: `/usr/local/bin/mtg-check`, `/etc/cron.d/mtg-check`.
- Публичный репозиторий: ни IP, ни ключей, ни имени бота (в примерах — `@your_bot`, `proxy1.example.org`).
- Node 18+, без npm-зависимостей; `package.json` = `{"type":"module"}`.
- Каждый файл с кодом начинается с двух строк комментария: что это; `YYYY-MM-DD HH:MM · vX.Y · Nick Churkin` (время MSK, `TZ=Europe/Moscow date '+%F %H:%M'`).
- Коммиты: автор Nick Churkin <nickchur@users.noreply.github.com> (уже в `git config` репозитория), в конце сообщения строка
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Волны
- Волна 1: задачи 1.1, 1.2 — без блокеров; параллельны (разные файлы)
- Волна 2: задача 2.1 (blocked by 1.1, 1.2)
- Волна 3: задача 3.1 (blocked by 2.1) — исполняет оператор (Claude), не agy: нужны секреты и сеть

---

### Задача 1.1: Worker проверки портов с тестом (волна 1)

**REQ:** REQ-pxc-01, REQ-pxc-02, REQ-pxc-03, REQ-pxc-04, REQ-pxc-05, REQ-pxc-06, REQ-pxc-09
**model-hint:** any
**Blocked by:** нет блокеров

**Контекст:** Worker на Cloudflare с cron раз в 5 минут. Для каждого прокси из `env.PROXIES` («host:port,host:port»,
порт по умолчанию 443) пытается открыть TCP за 10 с. Счётчик неудач подряд и флаг «объявлено падение» хранятся в R2.
2 неудачи подряд → одно сообщение ⚠️; первая удача после объявленного падения → одно ✅. Сообщения уходят
`POST https://tg-digest/notify?key=<ADMIN_KEY>` через service binding `env.NOTIFY` (хост в URL роли не играет).
Состояние пишется только при изменении.

**Файлы:**
- Создать: `worker.js`
- Создать: `package.json`
- Тест: `test/test_check.mjs`

**Интерфейсы:**
- Производит (экспорт `worker.js`):
  - `parseProxies(s: string | undefined) -> Array<{hostname: string, port: number}>`
  - `nextState(was: {fails: number, down: boolean}, ok: boolean) -> {fails: number, down: boolean}`
  - `checkProxy(env, proxy, connect) -> Promise<void>` — `connect` совместим с `cloudflare:sockets.connect`
  - `export default { scheduled(event, env) }`
  - константы `FAILS = 2`, `TIMEOUT_MS = 10000`, `PERIOD_MIN = 5`
- Потребляет: ничего из других задач

**Шаги:**
- [ ] Создай `package.json`:
```json
{"type":"module"}
```
- [ ] Напиши падающий тест `test/test_check.mjs`:
```js
// Тест логики tg-proxy-check в node: сокет, R2 и binding подменены.
// <дата> · v1.0 · Nick Churkin
import assert from 'node:assert/strict';
import { parseProxies, nextState, checkProxy, FAILS } from '../worker.js';

assert.deepEqual(parseProxies(''), []);
assert.deepEqual(parseProxies(undefined), []);
assert.deepEqual(parseProxies('a.example.org:443, b.example.org'),
  [{ hostname: 'a.example.org', port: 443 }, { hostname: 'b.example.org', port: 443 }]);
assert.deepEqual(parseProxies('c.example.org:8443,'), [{ hostname: 'c.example.org', port: 8443 }]);

assert.equal(FAILS, 2);
assert.deepEqual(nextState({ fails: 0, down: false }, false), { fails: 1, down: false });
assert.deepEqual(nextState({ fails: 1, down: false }, false), { fails: 2, down: true });
assert.deepEqual(nextState({ fails: 2, down: true }, false), { fails: 3, down: true });
assert.deepEqual(nextState({ fails: 3, down: true }, true), { fails: 0, down: false });
assert.deepEqual(nextState({ fails: 1, down: false }, true), { fails: 0, down: false });

// подмены: R2 в памяти, binding копит тексты, сокет открывается или нет по флагу
const store = new Map();
let puts = 0;
const sent = [];
const env = {
  ADMIN_KEY: 'k',
  STATE: {
    get: async (k) => (store.has(k) ? { text: async () => store.get(k) } : null),
    put: async (k, v) => { puts++; store.set(k, v); },
  },
  NOTIFY: {
    fetch: async (url, init) => {
      assert.equal(new URL(url).pathname, '/notify');
      assert.equal(new URL(url).searchParams.get('key'), 'k');
      sent.push(init.body);
      return new Response('ok');
    },
  },
};
let up = false;
const connect = () => ({
  opened: up ? Promise.resolve() : Promise.reject(new Error('refused')),
  close: async () => {},
});
const p = { hostname: 'a.example.org', port: 443 };

up = true; await checkProxy(env, p, connect);          // живой с самого начала — ничего не пишем
assert.equal(puts, 0); assert.equal(sent.length, 0);
up = false; await checkProxy(env, p, connect);         // 1-я неудача — пишем, молчим
assert.equal(sent.length, 0);
await checkProxy(env, p, connect);                     // 2-я — ⚠️
assert.equal(sent.length, 1); assert.match(sent[0], /⚠️.*a\.example\.org:443.*10 мин/);
await checkProxy(env, p, connect);                     // 3-я — молчим
assert.equal(sent.length, 1);
up = true; await checkProxy(env, p, connect);          // ожил — ✅
assert.equal(sent.length, 2); assert.match(sent[1], /✅.*a\.example\.org:443/);
const before = puts;
await checkProxy(env, p, connect);                     // живой дальше — не пишем
assert.equal(puts, before);
assert.deepEqual(JSON.parse(store.get('proxy:a.example.org')), { fails: 0, down: false });

console.log('ok');
```
- [ ] Запусти `node test/test_check.mjs` — ожидай FAIL: `Cannot find module '.../worker.js'`
- [ ] Реализуй `worker.js`:
```js
// tg-proxy-check — раз в 5 минут TCP до каждого прокси из PROXIES; 2 неудачи подряд — ⚠️ владельцу, ожил — ✅.
// <дата> · v1.0 · Nick Churkin
//
// PROXIES — «host:port,host:port» (порт по умолчанию 443), пусто — проверять нечего.
// Состояние — R2 `STATE`, ключ `proxy:<host>` = {fails, down}; пишется только при изменении.
// Сообщения — POST /notify?key=<ADMIN_KEY> Worker'а tg-digest через service binding `NOTIFY`.
export const FAILS = 2;          // подряд неудач до тревоги: перезагрузка хоста — не повод
export const TIMEOUT_MS = 10000;
export const PERIOD_MIN = 5;     // cron */5 — для текста «не отвечает N мин»

export const parseProxies = (s) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean)
  .map((x) => { const [hostname, port = '443'] = x.split(':'); return { hostname, port: +port }; });

export const nextState = (was, ok) =>
  ok ? { fails: 0, down: false } : { fails: was.fails + 1, down: was.down || was.fails + 1 >= FAILS };

const notify = (env, text) =>
  env.NOTIFY.fetch(`https://tg-digest/notify?key=${encodeURIComponent(env.ADMIN_KEY)}`, { method: 'POST', body: text });

export async function checkProxy(env, proxy, connect) {
  let ok = false;
  let timer;
  try {
    const sock = connect(proxy);
    const timeout = new Promise((r) => { timer = setTimeout(r, TIMEOUT_MS, false); });
    ok = await Promise.race([sock.opened.then(() => true, () => false), timeout]);
    sock.close().catch(() => {});
  } catch { /* ok = false */ } finally { clearTimeout(timer); }  // таймер не держит node после теста
  const key = `proxy:${proxy.hostname}`;
  const was = JSON.parse((await (await env.STATE.get(key))?.text()) ?? 'null') ?? { fails: 0, down: false };
  const now = nextState(was, ok);
  if (now.fails === was.fails && now.down === was.down) return;
  await env.STATE.put(key, JSON.stringify(now));
  const where = `${proxy.hostname}:${proxy.port}`;
  if (now.down && !was.down) await notify(env, `⚠️ Прокси ${where} не отвечает ${now.fails * PERIOD_MIN} мин`);
  if (!now.down && was.down) await notify(env, `✅ Прокси ${where} снова отвечает`);
}

export default {
  async scheduled(event, env) {
    // динамически: тест грузит модуль в node, где cloudflare:sockets нет
    const { connect } = await import('cloudflare:sockets');
    await Promise.all(parseProxies(env.PROXIES).map((p) =>
      checkProxy(env, p, connect).catch((e) => console.log(`прокси ${p.hostname}: ${e.message}`))));
  },
};
```
  Замени `<дата>` в обоих файлах на вывод `TZ=Europe/Moscow date '+%F %H:%M'`.
- [ ] Запусти `node test/test_check.mjs` — ожидай PASS: последняя строка `ok`
- [ ] Проверь, что тест ловит поломку порога: временно поставь `FAILS = 3`, запусти — ожидай `AssertionError`; верни `2`
- [ ] Commit: `feat(pxc-1.1): Worker проверки портов прокси и тест (REQ-pxc-01..06, 09)`

**Критерии выхода:**
- `node test/test_check.mjs` печатает `ok`, код возврата 0
- экспорт `worker.js` совпадает с блоком «Производит»
- `grep -nE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' worker.js test/test_check.mjs` пуст

---

### Задача 1.2: Скрипт проверки стенда в репозитории (волна 1)

**REQ:** REQ-pxc-07
**model-hint:** cheap
**Blocked by:** нет блокеров

**Контекст:** на хосте прокси cron раз в 5 минут проверяет, что служба mtg активна и что SOCKS-выход
127.0.0.1:1080 доводит до api.telegram.org. 2 неудачи подряд → ⚠️, ожил → ✅ через /notify (URL с ключом — в
`/etc/mtg-check.env`, переменная `NOTIFY`). Скрипт переносится в репозиторий без изменения поведения; меняется
только упоминание «из Хельсинки» (выход туннеля теперь с GCP, см. репозиторий tg_tunnel).

**Файлы:**
- Создать: `host/mtg-check`
- Создать: `host/mtg-check.cron`

**Интерфейсы:**
- Производит: исполняемый `host/mtg-check` и строку cron `host/mtg-check.cron` — их раскладывает задача 2.1
- Потребляет: ничего

**Шаги:**
- [ ] Создай `host/mtg-check` (права 755):
```sh
#!/bin/sh
# Семейный прокси: mtg жив и обратный туннель доводит до Telegram? Cron раз в 5 мин.
# <дата> · v1.0 · Nick Churkin
# 2 неудачи подряд — ⚠️ владельцу через /notify дайджеста, ожил — ✅. Состояние — число неудач подряд.
# /etc/mtg-check.env: NOTIFY=https://<worker tg-digest>/notify?key=<ADMIN_KEY>
. /etc/mtg-check.env
STATE=/var/lib/mtg-check.fails
was=$(cat $STATE 2>/dev/null || echo 0)
if ! systemctl is-active -q mtg; then why="служба mtg не работает"
elif ! curl -s -m 15 -o /dev/null --socks5-hostname 127.0.0.1:1080 https://api.telegram.org; then why="туннель не доводит до Telegram"
else why=""; fi
if [ -z "$why" ]; then now=0; else now=$((was + 1)); fi
echo $now > $STATE
notify() { curl -s -m 30 -o /dev/null --data-binary "$1" "$NOTIFY"; }
[ "$now" -eq 2 ] && notify "⚠️ Прокси Telegram: $why (10 мин)"
[ "$now" -eq 0 ] && [ "$was" -ge 2 ] && notify "✅ Прокси Telegram снова работает"
exit 0
```
- [ ] Создай `host/mtg-check.cron`:
```
*/5 * * * * root /usr/local/bin/mtg-check
```
- [ ] Запусти `sh -n host/mtg-check && echo syntax-ok` — ожидай `syntax-ok`
- [ ] Commit: `feat(pxc-1.2): скрипт проверки mtg и туннеля на стенде (REQ-pxc-07)`

**Критерии выхода:**
- `sh -n host/mtg-check` без ошибок; `test -x host/mtg-check`
- в файлах нет IP и ключей: `grep -nE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+|key=[^<]' host/*` пуст

---

### Задача 2.1: Выкладка одной командой и README (волна 2)

**REQ:** REQ-pxc-08
**model-hint:** any
**Blocked by:** задача 1.1, задача 1.2

**Контекст:** `./deploy.sh` берёт настройки из секрета Bitwarden `tg-proxy-check` (утилита `secret` печатает
строки `NAME=value`): `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` (Workers Scripts Edit, R2 Edit), `ADMIN_KEY`,
`PROXIES`, `STAND_HOST` (ssh-адрес хоста прокси, root). Через REST Cloudflare: создаёт бакет R2, если нет;
загружает Worker с binding'ами; ставит cron. Затем кладёт `host/mtg-check` и `host/mtg-check.cron` на стенд.
`/etc/mtg-check.env` на стенде уже есть и не трогается.

**Файлы:**
- Создать: `deploy.sh` (права 755)
- Создать: `README.md`
- Создать: `.gitignore`

**Интерфейсы:**
- Потребляет: `worker.js` (задача 1.1); `host/mtg-check`, `host/mtg-check.cron` (задача 1.2)
- Производит: команда `./deploy.sh` — её запускает задача 3.1

**Шаги:**
- [ ] Создай `deploy.sh`:
```bash
#!/usr/bin/env bash
# Выкладка tg-proxy-check: Worker на Cloudflare (REST, без wrangler) + скрипт проверки на хост прокси.
# <дата> · v1.0 · Nick Churkin
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
```
- [ ] Создай `.gitignore`:
```
*.env
node_modules/
```
- [ ] Создай `README.md`:
````markdown
# tg_proxy_check

Мониторинг MTProto-прокси (mtg) с уведомлениями в Telegram через бота дайджеста ([tg_news_digest](https://github.com/nickchur/tg_news_digest), `POST /notify`).

| Что | Где | Проверяет |
|---|---|---|
| `worker.js` | Cloudflare Worker `tg-proxy-check`, cron раз в 5 мин | TCP-порт каждого прокси из `PROXIES` снаружи |
| `host/mtg-check` | хост прокси, `/etc/cron.d/mtg-check` раз в 5 мин | служба mtg активна, SOCKS-выход доводит до api.telegram.org |

Обе проверки: 2 неудачи подряд — одно ⚠️, первая удача после падения — одно ✅.
Обратный туннель, через который mtg выходит в Telegram, — отдельный проект tg_tunnel.

## Настройки

Worker: R2-бакет `tg-proxy-check` (binding `STATE`), service binding `NOTIFY` → Worker `tg-digest`, секрет `ADMIN_KEY`,
`PROXIES` вида `proxy1.example.org:443,proxy2.example.org:443`.
Хост прокси: `/etc/mtg-check.env` с `NOTIFY=https://<worker tg-digest>/notify?key=<ADMIN_KEY>`.

## Выкладка

`./deploy.sh` — тест, бакет, Worker с binding'ами и cron, скрипт на хост. Настройки — из секрета `tg-proxy-check`
(см. заголовок `deploy.sh`).

## Тест

`node test/test_check.mjs`
````
- [ ] Запусти `bash -n deploy.sh && echo syntax-ok` — ожидай `syntax-ok`
- [ ] Запусти `grep -rnE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' --exclude-dir=.git . ; echo rc=$?` — ожидай только `rc=1`
- [ ] Commit: `feat(pxc-2.1): выкладка одной командой и README (REQ-pxc-08)`

**Критерии выхода:**
- `bash -n deploy.sh` без ошибок; `test -x deploy.sh`
- в репозитории нет IP-адресов и ключей
- `node test/test_check.mjs` по-прежнему печатает `ok`

---

### Задача 3.1: Выкладка и приёмка на живых системах (волна 3, оператор)

**REQ:** REQ-pxc-01…REQ-pxc-08 (приёмка)
**model-hint:** frontier
**Blocked by:** задача 2.1
**Исполнитель:** Claude (оператор), не agy — нужны секреты Bitwarden, Cloudflare и ssh к хостам.

**Шаги:**
- [ ] Заведи секрет Bitwarden `tg-proxy-check`: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `ADMIN_KEY` — из секрета
  `tg-digest`; `PROXIES` — из секрета `tg-digest`; `STAND_HOST=testsrv`. Проверь: `secret tg-proxy-check | cut -d= -f1`
  печатает пять имён.
- [ ] `./deploy.sh` — ожидай последнюю строку `выложен: …`
- [ ] REQ-pxc-01/02: добавь в `PROXIES` заведомо закрытый порт (например, `<IP стенда>:1`), `./deploy.sh`;
  через 10–15 мин в личке одно ⚠️ по нему, по живым прокси сообщений нет; ещё через 15 мин повторов нет
- [ ] REQ-pxc-03: убери закрытый порт, вместо него открытый на том же хосте; через ≤5 мин одно ✅ —
  или проверь ✅ тестом 1.1, если открыть порт нечем, и отметь это в worklog
- [ ] REQ-pxc-04: в R2 `tg-proxy-check` есть `proxy:<host>` по каждому прокси (REST `GET …/r2/buckets/tg-proxy-check/objects`)
- [ ] REQ-pxc-05: в настройках Worker'а (`GET …/workers/scripts/tg-proxy-check/settings`) нет `BOT_TOKEN`
- [ ] REQ-pxc-07: `ssh testsrv systemctl stop mtg` → ≤10 мин ⚠️ «служба mtg не работает» → `systemctl start mtg` → ≤5 мин ✅;
  `ssh testsrv cmp …` или `sha256sum` — файлы на стенде совпадают с `host/`
- [ ] REQ-pxc-08: чистый клон в scratchpad + `./deploy.sh` проходит
- [ ] Через сутки: GraphQL `workersInvocationsAdaptive` по `tg-proxy-check` — нет `exceededResources`
- [ ] Публикация `nickchur/tg_proxy_check` (публичный) — по разрешению пользователя
- [ ] Обнови traceability спеки: статус по каждому REQ

**Критерии выхода:**
- все пункты выше отмечены; результаты — в worklog
