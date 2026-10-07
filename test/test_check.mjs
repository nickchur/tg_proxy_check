// Тест логики tg-proxy-check в node: сокет, R2 и binding подменены.
// 2026-10-07 21:20 · v1.1 · Nick Churkin
import assert from 'node:assert/strict';
import worker, { parseProxies, nextState, checkProxy, FAILS } from '../worker.js';

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
      assert.equal(init?.method, 'POST');
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
assert.deepEqual(JSON.parse(store.get('proxy:a.example.org:443')), { fails: 0, down: false });

// REQ-pxc-10: /notify отвечает 500 на 2-й неудаче -> checkProxy бросает, в хранилище остаётся {fails:1, down:false}
const storeFail = new Map();
let notifyStatus = 500;
const sentFail = [];
const envFail = {
  ADMIN_KEY: 'k',
  STATE: {
    get: async (k) => (storeFail.has(k) ? { text: async () => storeFail.get(k) } : null),
    put: async (k, v) => { storeFail.set(k, v); },
  },
  NOTIFY: {
    fetch: async (url, init) => {
      assert.equal(init?.method, 'POST');
      if (notifyStatus !== 200) {
        return new Response('internal error', { status: notifyStatus });
      }
      sentFail.push(init.body);
      return new Response('ok');
    },
  },
};
const failConnect = () => ({
  opened: Promise.reject(new Error('refused')),
  close: async () => {},
});
const pFail = { hostname: 'a.example.org', port: 443 };
await checkProxy(envFail, pFail, failConnect);
assert.deepEqual(JSON.parse(storeFail.get('proxy:a.example.org:443')), { fails: 1, down: false });
notifyStatus = 500;
await assert.rejects(checkProxy(envFail, pFail, failConnect), /notify: 500/);
assert.deepEqual(JSON.parse(storeFail.get('proxy:a.example.org:443')), { fails: 1, down: false });
assert.equal(sentFail.length, 0);
notifyStatus = 200;
await checkProxy(envFail, pFail, failConnect);
assert.equal(sentFail.length, 1);
assert.match(sentFail[0], /⚠️.*a\.example\.org:443/);
assert.deepEqual(JSON.parse(storeFail.get('proxy:a.example.org:443')), { fails: 2, down: true });

// Причина синхронного броска connect логируется в console.error
let connectLogged = null;
const origErr = console.error;
console.error = (msg) => { connectLogged = msg; };
try {
  const storeConn = new Map();
  const envConn = {
    ADMIN_KEY: 'k',
    STATE: {
      get: async () => null,
      put: async (k, v) => { storeConn.set(k, v); },
    },
    NOTIFY: { fetch: async () => new Response('ok') },
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
  NOTIFY: { fetch: async () => new Response('ok') },
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

console.log('ok');
