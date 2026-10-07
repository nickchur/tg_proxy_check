// tg-proxy-check — раз в 5 минут TCP до каждого прокси из PROXIES; 2 неудачи подряд — ⚠️ владельцу, ожил — ✅.
// 2026-10-07 19:17 · v1.0 · Nick Churkin
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
