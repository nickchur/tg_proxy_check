// Тест логики tg-proxy-check в node: сокет, R2 и binding подменены.
// 2026-10-07 19:17 · v1.0 · Nick Churkin
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
