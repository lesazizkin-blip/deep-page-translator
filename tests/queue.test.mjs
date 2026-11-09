import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';

const { TranslationQueue } = await load('background/queue.js');
const { ProviderError } = await load('background/providers/base.js');

function fakeProvider(over = {}) {
  const calls = [];
  return {
    id: 'fake',
    maxChars: 100,
    maxItems: 3,
    concurrency: 1,
    calls,
    async translate(texts) {
      calls.push([...texts]);
      return texts.map((t) => t.toUpperCase());
    },
    ...over,
  };
}
const ctx = { target: 'ru', settings: {}, tabId: 1 };

test('переводит и сохраняет порядок', async () => {
  const q = new TranslationQueue();
  assert.deepEqual(await q.translate(fakeProvider(), ['a', 'b'], ctx), ['A', 'B']);
});

test('одинаковые тексты из разных пачек уходят провайдеру один раз', async () => {
  const q = new TranslationQueue();
  const p = fakeProvider();
  const [r1, r2] = await Promise.all([q.translate(p, ['hi', 'x'], ctx), q.translate(p, ['hi'], ctx)]);
  assert.deepEqual(r1, ['HI', 'X']);
  assert.deepEqual(r2, ['HI']);
  assert.equal(p.calls.flat().filter((t) => t === 'hi').length, 1);
});

test('батчи ограничены maxItems', async () => {
  const q = new TranslationQueue();
  const p = fakeProvider();
  await q.translate(p, ['a', 'b', 'c', 'd', 'e'], ctx);
  assert.deepEqual(p.calls.map((c) => c.length), [3, 2]);
});

test('батчи ограничены maxChars', async () => {
  const q = new TranslationQueue();
  const p = fakeProvider({ maxChars: 10, maxItems: 50 });
  await q.translate(p, ['aaaaaa', 'bbbbbb', 'cc'], ctx);
  assert.deepEqual(p.calls, [['aaaaaa'], ['bbbbbb', 'cc']]);
});

test('слишком длинный одиночный текст всё равно отправляется', async () => {
  const q = new TranslationQueue();
  const p = fakeProvider({ maxChars: 3 });
  assert.deepEqual(await q.translate(p, ['abcdef'], ctx), ['ABCDEF']);
});

test('параллельность не превышает concurrency', async () => {
  const q = new TranslationQueue();
  let active = 0;
  let peak = 0;
  const p = fakeProvider({
    maxItems: 1,
    concurrency: 2,
    async translate(texts) {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return texts;
    },
  });
  await q.translate(p, ['1', '2', '3', '4', '5'], ctx);
  assert.equal(peak, 2);
});

test('временная ошибка повторяется и в итоге проходит', async () => {
  const q = new TranslationQueue();
  let attempts = 0;
  const p = fakeProvider({
    async translate(texts) {
      if (++attempts < 2) throw new ProviderError('сервер', { retryable: true, retryAfterMs: 1 });
      return texts.map((t) => t + '!');
    },
  });
  assert.deepEqual(await q.translate(p, ['a'], ctx), ['a!']);
  assert.equal(attempts, 2);
});

test('постоянная ошибка не повторяется и отклоняет все тексты пачки', async () => {
  const q = new TranslationQueue();
  let attempts = 0;
  const p = fakeProvider({
    async translate() {
      attempts++;
      throw new ProviderError('неверный ключ', { code: 'http-403' });
    },
  });
  await assert.rejects(q.translate(p, ['a', 'b'], ctx), { code: 'http-403' });
  assert.equal(attempts, 1);
});

test('после ошибки тот же текст можно перевести снова', async () => {
  const q = new TranslationQueue();
  let fail = true;
  const p = fakeProvider({
    async translate(texts) {
      if (fail) throw new ProviderError('нет', {});
      return texts;
    },
  });
  await assert.rejects(q.translate(p, ['a'], ctx));
  fail = false;
  assert.deepEqual(await q.translate(p, ['a'], ctx), ['a']);
});
