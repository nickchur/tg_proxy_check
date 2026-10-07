// tg-proxy-check — раз в 5 минут TCP до каждого прокси из PROXIES; 2 неудачи подряд — ⚠️ владельцу, ожил — ✅.
// 2026-10-08 00:24 · v1.2 · Nick Churkin
//
// PROXIES — «host:port,host:port» (порт по умолчанию 443), пусто — проверять нечего.
// Состояние — R2 `STATE`, ключ `proxy:<host>:<port>` = {fails, down}; пишется только при изменении.
// Сообщения — свой бот (BOT_TOKEN) владельцу (OWNER_ID); POST /notify?key=<ADMIN_KEY> — то же для внешних скриптов.
export const FAILS = 2;          // подряд неудач до тревоги: перезагрузка хоста — не повод
export const TIMEOUT_MS = 10000;
export const PERIOD_MIN = 5;     // cron */5 — для текста «не отвечает N мин»

export const parseProxies = (s) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean)
  .map((item) => {
    const idx = item.indexOf(':');
    if (idx === -1) {
      return { hostname: item, port: 443 };
    }
    const hostname = item.slice(0, idx);
    const portStr = item.slice(idx + 1);
    if (!/^[0-9]+$/.test(portStr)) {
      throw new Error(`PROXIES: неверный порт в «${item}»`);
    }
    const port = Number(portStr);
    if (port < 1 || port > 65535) {
      throw new Error(`PROXIES: неверный порт в «${item}»`);
    }
    return { hostname, port };
  });

export const nextState = (was, ok) =>
  ok ? { fails: 0, down: false } : { fails: was.fails + 1, down: was.down || was.fails + 1 >= FAILS };

export const TG_LIMIT = 4000;   // у Telegram 4096 на сообщение
export const chunks = (text) => {
  const out = [];
  for (let i = 0; i < text.length; i += TG_LIMIT) out.push(text.slice(i, i + TG_LIMIT));
  return out;
};

// Сообщение владельцу в личку от бота мониторинга. Длинное — несколькими сообщениями.
// ponytail: режем по длине, а не по тегам — HTML-тег на стыке кусков Telegram отвергнет (502 у /notify)
export async function sendOwner(env, text) {
  for (const part of chunks(text)) {
    const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.OWNER_ID, text: part, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || !d.ok) throw new Error(`telegram: ${d.description ?? res.status}`);
  }
}

export async function checkProxy(env, proxy, connect) {
  let ok = false;
  let timer;
  try {
    const sock = connect(proxy);
    const timeout = new Promise((r) => { timer = setTimeout(r, TIMEOUT_MS, false); });
    ok = await Promise.race([sock.opened.then(() => true, () => false), timeout]);
    sock.close().catch(() => {});
  } catch (e) {
    console.error(`connect ${proxy.hostname}:${proxy.port}: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  const key = `proxy:${proxy.hostname}:${proxy.port}`;
  const was = JSON.parse((await (await env.STATE.get(key))?.text()) ?? 'null') ?? { fails: 0, down: false };
  const now = nextState(was, ok);
  if (now.fails === was.fails && now.down === was.down) return;
  const where = `${proxy.hostname}:${proxy.port}`;
  if (now.down && !was.down) await sendOwner(env, `⚠️ Прокси ${where} не отвечает ${now.fails * PERIOD_MIN} мин`);
  if (!now.down && was.down) await sendOwner(env, `✅ Прокси ${where} снова отвечает`);
  await env.STATE.put(key, JSON.stringify(now));
}

export default {
  // POST /notify?key=<ADMIN_KEY>, тело — текст: владельцу в личку. Для скриптов хостов и tg-me.
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/notify' || request.method !== 'POST') return new Response('not found', { status: 404 });
    if (!env.ADMIN_KEY || url.searchParams.get('key') !== env.ADMIN_KEY) return new Response('forbidden', { status: 403 });
    const text = (await request.text()).trim();
    if (!text) return new Response('empty', { status: 400 });
    try {
      await sendOwner(env, text);
    } catch (e) {
      console.error(`notify: ${e.message}`);
      return new Response(e.message, { status: 502 });
    }
    return new Response('ok');
  },

  async scheduled(event, env) {
    const connect = env.SOCKETS?.connect ?? (await import('cloudflare:sockets')).connect;
    const items = (env.PROXIES ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    const errors = [];
    const tasks = items.map(async (raw) => {
      let p;
      try {
        [p] = parseProxies(raw);
      } catch (e) {
        const idx = raw.indexOf(':');
        const host = idx === -1 ? raw : raw.slice(0, idx);
        const port = idx === -1 ? 443 : raw.slice(idx + 1);
        console.error(`прокси ${host}:${port}: ${e.message}`);
        throw e;
      }
      try {
        await checkProxy(env, p, connect);
      } catch (e) {
        console.error(`прокси ${p.hostname}:${p.port}: ${e.message}`);
        throw e;
      }
    });
    const results = await Promise.allSettled(tasks);
    for (const r of results) {
      if (r.status === 'rejected') {
        errors.push(r.reason);
      }
    }
    if (errors.length) {
      throw new AggregateError(errors, `не удалось проверить ${errors.length} из ${items.length}`);
    }
  },
};
