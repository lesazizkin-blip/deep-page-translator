import { pathToFileURL } from 'node:url';
import path from 'node:path';

export const SRC = path.resolve(import.meta.dirname, '..', 'page-translator');
export const load = (rel, query = '') => import(pathToFileURL(path.join(SRC, rel)).href + query);

/** Минимальная имитация chrome.storage.local в памяти. */
export function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(keys) {
      if (typeof keys === 'string') keys = [keys];
      const out = {};
      for (const k of keys ?? Object.keys(data)) if (k in data) out[k] = data[k];
      return out;
    },
    async set(obj) {
      Object.assign(data, obj);
    },
    async remove(k) {
      delete data[k];
    },
  };
}

/** Событие chrome.*.onX с возможностью вызвать подписчиков. */
export function fakeEvent() {
  const listeners = [];
  return { addListener: (fn) => listeners.push(fn), listeners };
}
