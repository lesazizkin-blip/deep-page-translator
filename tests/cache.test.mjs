import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { load, fakeStorage } from './helpers.mjs';

let n = 0;
let cache;
let storage;

// Каждый тест — свежий экземпляр модуля (у кеша состояние на уровне модуля).
beforeEach(async () => {
  storage = fakeStorage();
  globalThis.chrome = { storage: { local: storage } };
  cache = await load('background/cache.js', `?${++n}`);
});

test('makeKey различает провайдера, язык и текст', () => {
  const k = cache.makeKey('google', 'ru', 'Hello');
  assert.equal(k, cache.makeKey('google', 'ru', 'Hello'));
  assert.notEqual(k, cache.makeKey('deepl', 'ru', 'Hello'));
  assert.notEqual(k, cache.makeKey('google', 'de', 'Hello'));
  assert.notEqual(k, cache.makeKey('google', 'ru', 'Hello!'));
});

test('hashString стабилен и зависит от seed', () => {
  assert.equal(cache.hashString('abc'), cache.hashString('abc'));
  assert.notEqual(cache.hashString('abc'), cache.hashString('abd'));
  assert.notEqual(cache.hashString('abc'), cache.hashString('abc', 1));
});

test('setMany/getMany: попадания и промахи', async () => {
  await cache.setMany([['a', 'А'], ['b', 'Б']]);
  assert.deepEqual(await cache.getMany(['a', 'x', 'b']), ['А', undefined, 'Б']);
  assert.deepEqual(await cache.stats(), { entries: 2, chars: 2, maxEntries: 30000, maxChars: 2_500_000 });
  await cache.clear(); // гасим отложенный таймер сброса
});

test('перезапись значения корректно пересчитывает объём', async () => {
  await cache.setMany([['a', '12345']]);
  await cache.setMany([['a', '12']]);
  assert.equal((await cache.stats()).chars, 2);
  assert.equal((await cache.stats()).entries, 1);
  await cache.clear();
});

test('flush сохраняет в storage, новый экземпляр читает оттуда', async () => {
  await cache.setMany([['a', 'А']]);
  await cache.flush();
  assert.deepEqual(storage.data.pt_cache_v1, [['a', 'А']]);

  const again = await load('background/cache.js', `?${++n}`);
  assert.deepEqual(await again.getMany(['a']), ['А']);
});

test('clear очищает память и storage', async () => {
  await cache.setMany([['a', 'А']]);
  await cache.flush();
  await cache.clear();
  assert.equal('pt_cache_v1' in storage.data, false);
  assert.deepEqual(await cache.getMany(['a']), [undefined]);
  assert.equal((await cache.stats()).entries, 0);
});

test('вытеснение по объёму: старые записи уходят первыми, использованные — живут', async () => {
  const big = 'x'.repeat(1_000_000);
  await cache.setMany([['old', big], ['keep', big]]);
  await cache.getMany(['old']); // «old» стал самым свежим, «keep» — самым старым
  await cache.setMany([['new', big]]); // 3 млн > 2,5 млн → вытесняется самый старый
  assert.deepEqual(await cache.getMany(['keep']), [undefined]);
  assert.equal((await cache.getMany(['old']))[0], big);
  assert.equal((await cache.getMany(['new']))[0], big);
  await cache.clear();
});
