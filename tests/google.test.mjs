import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';

const { GoogleProvider } = await load('background/providers/google.js');
const { getProvider } = await load('background/providers/index.js');
const { httpError } = await load('background/providers/base.js');

const realFetch = globalThis.fetch;
afterEach(() => (globalThis.fetch = realFetch));

const reply = (body, status = 200) => async () => ({
  ok: status < 400,
  status,
  json: async () => {
    if (body === undefined) throw new SyntaxError('bad json');
    return body;
  },
});

test('отправляет все тексты как q=..., язык и format=html', async () => {
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 200, json: async () => ['А', 'Б'] };
  };
  await new GoogleProvider().translate(['a', 'b'], { target: 'ru' });
  assert.match(seen.url, /tl=ru/);
  assert.match(seen.url, /format=html/);
  assert.equal(seen.init.credentials, 'omit');
  assert.deepEqual(seen.init.body.getAll('q'), ['a', 'b']);
});

test('понимает все три формата ответа', async () => {
  const g = new GoogleProvider();
  globalThis.fetch = reply(['А', 'Б']);
  assert.deepEqual(await g.translate(['a', 'b'], { target: 'ru' }), ['А', 'Б']);
  globalThis.fetch = reply([['А', 'en'], ['Б', 'en']]);
  assert.deepEqual(await g.translate(['a', 'b'], { target: 'ru' }), ['А', 'Б']);
  globalThis.fetch = reply('А');
  assert.deepEqual(await g.translate(['a'], { target: 'ru' }), ['А']);
});

test('число переводов не совпало → временная ошибка', async () => {
  globalThis.fetch = reply(['А']);
  await assert.rejects(new GoogleProvider().translate(['a', 'b'], { target: 'ru' }), { retryable: true });
});

test('не JSON → временная ошибка', async () => {
  globalThis.fetch = reply(undefined);
  await assert.rejects(new GoogleProvider().translate(['a'], { target: 'ru' }), { retryable: true });
});

test('сеть недоступна → code=network, можно повторить', async () => {
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed');
  };
  await assert.rejects(new GoogleProvider().translate(['a'], { target: 'ru' }), {
    code: 'network',
    retryable: true,
  });
});

test('httpError: 429 и 5xx повторяются, 403 — нет', () => {
  assert.equal(httpError('X', 429).retryable, true);
  assert.equal(httpError('X', 429).retryAfterMs, 4000);
  assert.equal(httpError('X', 503).retryable, true);
  assert.equal(httpError('X', 403).retryable, false);
  assert.equal(httpError('X', 403).code, 'http-403');
});

test('getProvider: неизвестный id → google', () => {
  assert.equal(getProvider('google').id, 'google');
  assert.equal(getProvider('deepl').id, 'deepl');
  assert.equal(getProvider('nope').id, 'google');
});

test('check() возвращает ok/сообщение', async () => {
  globalThis.fetch = reply(['Привет, мир']);
  const res = await new GoogleProvider().check({ target: 'ru' });
  assert.equal(res.ok, true);
  assert.match(res.message, /Привет, мир/);
  globalThis.fetch = reply({}, 500);
  assert.equal((await new GoogleProvider().check({ target: 'ru' })).ok, false);
});
