// LRU-кеш переводов в chrome.storage.local.
//
// Ключ: провайдер + целевой язык + хеш исходного текста.
// В памяти держим Map (порядок вставки = порядок использования),
// на диск сбрасываем с задержкой, чтобы не писать на каждый перевод.
// Service worker может быть выгружен в любой момент — поэтому кеш лениво
// загружается заново при первом обращении.

const STORAGE_KEY = 'pt_cache_v1';
const MAX_ENTRIES = 30000;
const MAX_CHARS = 2_500_000; // суммарная длина значений
const FLUSH_DELAY_MS = 1500;

let map = null; // Map<key, translation>
let loading = null;
let totalChars = 0;
let flushTimer = null;

async function ensureLoaded() {
  if (map) return;
  if (!loading) {
    loading = chrome.storage.local.get(STORAGE_KEY).then((data) => {
      map = new Map(Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : []);
      totalChars = 0;
      for (const v of map.values()) totalChars += v.length;
    });
  }
  await loading;
}

/** Быстрый 53-битный хеш строки (cyrb53). */
export function hashString(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function makeKey(providerId, lang, text) {
  // Длина в ключе дополнительно снижает шанс коллизии.
  return `${providerId}|${lang}|${text.length}|${hashString(text)}`;
}

/** Возвращает массив переводов (или undefined) и поднимает найденные записи в LRU. */
export async function getMany(keys) {
  await ensureLoaded();
  return keys.map((k) => {
    const v = map.get(k);
    if (v !== undefined) {
      map.delete(k);
      map.set(k, v);
    }
    return v;
  });
}

export async function setMany(entries) {
  await ensureLoaded();
  for (const [k, v] of entries) {
    const old = map.get(k);
    if (old !== undefined) {
      totalChars -= old.length;
      map.delete(k);
    }
    map.set(k, v);
    totalChars += v.length;
  }
  evict();
  scheduleFlush();
}

function evict() {
  // Самые старые записи — в начале Map.
  const it = map.keys();
  while (map.size > MAX_ENTRIES || totalChars > MAX_CHARS) {
    const k = it.next().value;
    if (k === undefined) break;
    totalChars -= map.get(k).length;
    map.delete(k);
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
}

export async function flush() {
  clearTimeout(flushTimer);
  flushTimer = null;
  if (!map) return;
  await chrome.storage.local.set({ [STORAGE_KEY]: [...map.entries()] });
}

export async function clear() {
  clearTimeout(flushTimer);
  flushTimer = null;
  map = new Map();
  loading = Promise.resolve();
  totalChars = 0;
  await chrome.storage.local.remove(STORAGE_KEY);
}

export async function stats() {
  await ensureLoaded();
  return { entries: map.size, chars: totalChars, maxEntries: MAX_ENTRIES, maxChars: MAX_CHARS };
}
