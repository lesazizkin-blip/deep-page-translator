// Фоновый скрипт должен загружаться и в Chrome, и в Firefox для Android,
// где нет chrome.commands и chrome.contextMenus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, fakeStorage, fakeEvent } from './helpers.mjs';

let n = 0;
const NONE = { withCommands: false, withMenus: false };

function makeChrome({ withCommands, withMenus }) {
  const c = {
    storage: {
      local: fakeStorage({ provider: 'google' }),
      session: fakeStorage(),
      onChanged: fakeEvent(),
    },
    tabs: {
      onUpdated: fakeEvent(),
      onRemoved: fakeEvent(),
      query: async () => [],
      sendMessage: async () => {},
    },
    runtime: { onMessage: fakeEvent(), onInstalled: fakeEvent(), onSuspend: fakeEvent() },
  };
  if (withCommands) c.commands = { onCommand: fakeEvent() };
  if (withMenus) {
    c.contextMenus = {
      onClicked: fakeEvent(),
      created: [],
      removeAll: async () => {},
      create(o) {
        this.created.push(o);
      },
    };
  }
  return c;
}

async function boot(opts) {
  await load('shared/constants.js');
  globalThis.chrome = makeChrome(opts);
  await load('background/service-worker.js', `?${++n}`);
  return globalThis.chrome;
}

const SENDER = { tab: { id: 7, url: 'https://kaggle.com/x' }, frameId: 0, url: 'https://kaggle.com/x' };

const send = (chrome, msg, sender = SENDER) =>
  new Promise((resolve) => {
    const [listener] = chrome.runtime.onMessage.listeners;
    assert.equal(listener(msg, sender, resolve), true, 'ответ асинхронный');
  });

const withFetch = async (impl, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
};

test('загружается без commands и contextMenus (Firefox для Android)', async () => {
  const chrome = await boot(NONE);
  assert.equal(chrome.runtime.onMessage.listeners.length, 1);
  await Promise.all(chrome.runtime.onInstalled.listeners.map((fn) => fn()));
});

test('в Chrome регистрирует команду и пункт контекстного меню', async () => {
  const chrome = await boot({ withCommands: true, withMenus: true });
  assert.equal(chrome.commands.onCommand.listeners.length, 1);
  await Promise.all(chrome.runtime.onInstalled.listeners.map((fn) => fn()));
  assert.equal(chrome.contextMenus.created[0].id, 'pt-translate-selection');
  assert.equal(chrome.contextMenus.onClicked.listeners.length, 1);
});

test('pt:init: без автоперевода вкладка неактивна, ключи API не раскрываются', async () => {
  const chrome = await boot(NONE);
  await chrome.storage.local.set({ deeplKey: 'SECRET', libreKey: 'SECRET2' });
  const res = await send(chrome, { type: 'pt:init' });
  assert.equal(res.active, false);
  assert.equal(res.topHost, 'kaggle.com');
  assert.equal('deeplKey' in res.settings, false);
  assert.equal('libreKey' in res.settings, false);
});

test('pt:init: сайт из autoSites включает перевод и запоминает состояние вкладки', async () => {
  const chrome = await boot(NONE);
  await chrome.storage.local.set({ autoSites: ['kaggle.com'] });
  assert.equal((await send(chrome, { type: 'pt:init' })).active, true);
  assert.equal((await send(chrome, { type: 'pt:getTabState', tabId: 7 })).active, true);
});

test('исключённый сайт не включается автоматически', async () => {
  const chrome = await boot(NONE);
  await chrome.storage.local.set({ autoSites: ['kaggle.com'], excludedSites: ['kaggle.com'] });
  assert.equal((await send(chrome, { type: 'pt:init' })).active, false);
});

test('pt:setActive и pt:toggle переключают состояние вкладки и оповещают фреймы', async () => {
  const chrome = await boot(NONE);
  const sent = [];
  chrome.tabs.sendMessage = async (id, msg) => void sent.push([id, msg]);
  await send(chrome, { type: 'pt:setActive', tabId: 7, active: true });
  assert.deepEqual(sent, [[7, { type: 'pt:setActive', active: true }]]);
  assert.equal((await send(chrome, { type: 'pt:getTabState', tabId: 7 })).active, true);
  await send(chrome, { type: 'pt:toggle' });
  assert.equal((await send(chrome, { type: 'pt:getTabState', tabId: 7 })).active, false);
});

test('закрытие вкладки сбрасывает её состояние', async () => {
  const chrome = await boot(NONE);
  await send(chrome, { type: 'pt:setActive', tabId: 7, active: true });
  chrome.tabs.onRemoved.listeners.forEach((fn) => fn(7));
  await new Promise((r) => setTimeout(r));
  assert.equal((await send(chrome, { type: 'pt:getTabState', tabId: 7 })).active, false);
});

test('pt:translate: переводит через провайдера и кеширует', async () => {
  const chrome = await boot(NONE);
  let calls = 0;
  await withFetch(
    async (url, init) => {
      calls++;
      return { ok: true, status: 200, json: async () => init.body.getAll('q').map((t) => `[${t}]`) };
    },
    async () => {
      const a = await send(chrome, { type: 'pt:translate', texts: ['cache-me', 'two'] });
      assert.deepEqual(a.translations, ['[cache-me]', '[two]']);
      const b = await send(chrome, { type: 'pt:translate', texts: ['cache-me'] });
      assert.deepEqual(b.translations, ['[cache-me]']);
      assert.equal(calls, 1, 'второй раз — из кеша');
      await send(chrome, { type: 'pt:clearCache' }); // гасим таймер сброса кеша
    }
  );
});

test('pt:translate: ошибка провайдера → { error } без падения', async () => {
  const chrome = await boot(NONE);
  await withFetch(
    async () => ({ ok: false, status: 403, json: async () => ({}) }),
    async () => {
      const res = await send(chrome, { type: 'pt:translate', texts: ['err-case'] });
      assert.equal(res.error.code, 'http-403');
    }
  );
});
