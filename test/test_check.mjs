// Тест логики tg-proxy-check в node: сокет, R2 и Telegram API подменены.
// 2026-10-08 00:34 · v1.2 · Nick Churkin
import assert from 'node:assert/strict';
import worker, { parseProxies, nextState, checkProxy, FAILS, chunks, TG_LIMIT, sendOwner } from '../worker.js';

assert.deepEqual(parseProxies(''), []);
assert.deepEqual(parseProxies(undefined), []);
assert.deepEqual(parseProxies('a.example.org:443, b.example.org'),
  [{ hostname: 'a.example.org', port: 443 }, { hostname: 'b.example.org', port: 443 }]);
assert.deepEqual(parseProxies('c.example.org:8443,'), [{ hostname: 'c.example.org', port: 8443 }]);

for (const bad of ['a.example.org:abc', 'a.example.org:', 'a.example.org:0', 'a.example.org:70000']) {
  assert.throws(() => parseProxies(bad), {
    name: 'Error',
    message: `PROXIES: неверный порт в «${bad}»`,
  });
}

assert.equal(FAILS, 2);
assert.deepEqual(nextState({ fails: 0, down: false }, false), { fails: 1, down: false });
assert.deepEqual(nextState({ fails: 1, down: false }, false), { fails: 2, down: true });
assert.deepEqual(nextState({ fails: 2, down: true }, false), { fails: 3, down: true });
assert.deepEqual(nextState({ fails: 3, down: true }, true), { fails: 0, down: false });
assert.deepEqual(nextState({ fails: 1, down: false }, true), { fails: 0, down: false });

// подмена Telegram: копит отправленные тексты; ответ задаётся tg.reply
const tg = { sent: [], modes: [], reply: { status: 200, body: { ok: true } } };
globalThis.fetch = async (url, init) => {
  assert.match(String(url), /^https:\/\/api\.telegram\.org\/botT0KEN\/sendMessage$/);
  assert.equal(init.method, 'POST');
  const body = JSON.parse(init.body);
  assert.equal(body.chat_id, '42');
  tg.sent.push(body.text);
  tg.modes.push(body.parse_mode);
  return new Response(JSON.stringify(tg.reply.body), { status: tg.reply.status });
};

// подмены: R2 в памяти, сокет открывается или нет по флагу
const store = new Map();
let puts = 0;
const env = {
  ADMIN_KEY: 'k',
  BOT_TOKEN: 'T0KEN',
  OWNER_ID: '42',
  STATE: {
    get: async (k) => (store.has(k) ? { text: async () => store.get(k) } : null),
    put: async (k, v) => { puts++; store.set(k, v); },
  },
};
let up = false;
const connect = () => ({
  opened: up ? Promise.resolve() : Promise.reject(new Error('refused')),
  close: async () => {},
});
const p = { hostname: 'a.example.org', port: 443 };

up = true; await checkProxy(env, p, connect);          // живой с самого начала — ничего не пишем
assert.equal(puts, 0); assert.equal(tg.sent.length, 0);
up = false; await checkProxy(env, p, connect);         // 1-я неудача — пишем, молчим
assert.equal(tg.sent.length, 0);
await checkProxy(env, p, connect);                     // 2-я — ⚠️
assert.equal(tg.sent.length, 1); assert.match(tg.sent[0], /⚠️.*a\.example\.org:443.*10 мин/);
await checkProxy(env, p, connect);                     // 3-я — молчим
assert.equal(tg.sent.length, 1);
up = true; await checkProxy(env, p, connect);          // ожил — ✅
assert.equal(tg.sent.length, 2); assert.match(tg.sent[1], /✅.*a\.example\.org:443/);
const before = puts;
await checkProxy(env, p, connect);                     // живой дальше — не пишем
assert.equal(puts, before);
assert.deepEqual(JSON.parse(store.get('proxy:a.example.org:443')), { fails: 0, down: false });

// REQ-pxc-10: Telegram отвечает ошибкой на 2-й неудаче -> checkProxy бросает, в хранилище остаётся {fails:1, down:false}
const storeFail = new Map();
const envFail = {
  ADMIN_KEY: 'k',
  BOT_TOKEN: 'T0KEN',
  OWNER_ID: '42',
  STATE: {
    get: async (k) => (storeFail.has(k) ? { text: async () => storeFail.get(k) } : null),
    put: async (k, v) => { storeFail.set(k, v); },
  },
};
const failConnect = () => ({
  opened: Promise.reject(new Error('refused')),
  close: async () => {},
});
const pFail = { hostname: 'a.example.org', port: 443 };
await checkProxy(envFail, pFail, failConnect);
assert.deepEqual(JSON.parse(storeFail.get('proxy:a.example.org:443')), { fails: 1, down: false });
tg.reply = { status: 400, body: { ok: false, description: 'Bad Request: chat not found' } };
await assert.rejects(checkProxy(envFail, pFail, failConnect), /telegram: Bad Request: chat not found/);
assert.deepEqual(JSON.parse(storeFail.get('proxy:a.example.org:443')), { fails: 1, down: false });
tg.reply = { status: 200, body: { ok: true } };
tg.sent.length = 0;
tg.modes.length = 0;
await checkProxy(envFail, pFail, failConnect);
assert.equal(tg.sent.length, 1);
assert.match(tg.sent[0], /⚠️.*a\.example\.org:443/);
assert.deepEqual(JSON.parse(storeFail.get('proxy:a.example.org:443')), { fails: 2, down: true });

// Причина синхронного броска connect логируется в console.error
let connectLogged = null;
const origErr = console.error;
console.error = (msg) => { connectLogged = msg; };
try {
  const storeConn = new Map();
  const envConn = {
    ADMIN_KEY: 'k',
    BOT_TOKEN: 'T0KEN',
    OWNER_ID: '42',
    STATE: {
      get: async () => null,
      put: async (k, v) => { storeConn.set(k, v); },
    },
  };
  await checkProxy(envConn, p, () => { throw new Error('immediate refusal'); });
  assert.equal(connectLogged, 'connect a.example.org:443: immediate refusal');
  assert.deepEqual(JSON.parse(storeConn.get('proxy:a.example.org:443')), { fails: 1, down: false });
} finally {
  console.error = origErr;
}

// REQ-pxc-11: scheduled с PROXIES='a.example.org:443,b.example.org:abc' бросает, а a.example.org:443 проверен
let connectedHost = null;
const schedStore = new Map();
const envSched = {
  ADMIN_KEY: 'k',
  BOT_TOKEN: 'T0KEN',
  OWNER_ID: '42',
  PROXIES: 'a.example.org:443,b.example.org:abc',
  SOCKETS: {
    connect: (proxy) => {
      connectedHost = proxy.hostname;
      return { opened: Promise.resolve(), close: async () => {} };
    },
  },
  STATE: {
    get: async (k) => (schedStore.has(k) ? { text: async () => schedStore.get(k) } : null),
    put: async (k, v) => { schedStore.set(k, v); },
  },
};
const schedLogged = [];
const origErrSched = console.error;
console.error = (msg) => { schedLogged.push(msg); };
try {
  await assert.rejects(worker.scheduled(null, envSched), AggregateError);
} finally {
  console.error = origErrSched;
}
assert.equal(connectedHost, 'a.example.org');
assert.ok(schedLogged.some((m) => m.includes('прокси b.example.org:abc: PROXIES: неверный порт в «b.example.org:abc»')));

// REQ-pxc-13: длинный текст — несколькими сообщениями без потерь
const long = 'а'.repeat(9000);
assert.deepEqual(chunks(long).map((c) => c.length), [4000, 4000, 1000]);
assert.equal(chunks(long).join(''), long);
assert.deepEqual(chunks('коротко'), ['коротко']);

// REQ-pxc-12: /notify
const nenv = { ADMIN_KEY: 'k', BOT_TOKEN: 'T0KEN', OWNER_ID: '42' };
const req = (path, init) => new Request(`https://tg-proxy-check.example.workers.dev${path}`, init);
tg.sent.length = 0;
tg.modes.length = 0;
let r = await worker.fetch(req('/notify?key=k', { method: 'POST', body: 'тест' }), nenv);
assert.equal(r.status, 200); assert.deepEqual(tg.sent, ['тест']);
assert.deepEqual(tg.modes, ['HTML']);
assert.equal((await worker.fetch(req('/notify?key=bad', { method: 'POST', body: 'x' }), nenv)).status, 403);
assert.equal((await worker.fetch(req('/notify', { method: 'POST', body: 'x' }), nenv)).status, 403);
assert.equal((await worker.fetch(req('/notify?key=k', { method: 'POST', body: '  ' }), nenv)).status, 400);
assert.equal((await worker.fetch(req('/notify?key=k'), nenv)).status, 404);
assert.equal((await worker.fetch(req('/other?key=k', { method: 'POST', body: 'x' }), nenv)).status, 404);
tg.reply = { status: 400, body: { ok: false, description: 'Bad Request: chat not found' } };
r = await worker.fetch(req('/notify?key=k', { method: 'POST', body: 'x' }), nenv);
assert.equal(r.status, 502); assert.match(await r.text(), /chat not found/);
tg.reply = { status: 200, body: { ok: false, description: 'x' } };
await assert.rejects(sendOwner(nenv, 'msg'), /telegram: x/);
r = await worker.fetch(req('/notify?key=k', { method: 'POST', body: 'msg' }), nenv);
assert.equal(r.status, 502); assert.match(await r.text(), /telegram: x/);
tg.reply = { status: 200, body: { ok: true } };
tg.sent.length = 0;
tg.modes.length = 0;
await worker.fetch(req('/notify?key=k', { method: 'POST', body: long }), nenv);
assert.equal(tg.sent.length, 3); assert.equal(tg.sent.join(''), long);
assert.deepEqual(tg.modes, [undefined, undefined, undefined]);

console.log('ok');
