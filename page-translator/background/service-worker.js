// Background service worker: маршрутизация сообщений, очередь, кеш,
// состояние вкладок, горячая клавиша и контекстное меню.

import '../shared/constants.js';
import { getProvider } from './providers/index.js';
import { TranslationQueue } from './queue.js';
import * as cache from './cache.js';

const queue = new TranslationQueue();

// ---------- Настройки ----------

async function getSettings() {
  const data = await chrome.storage.local.get(Object.keys(PT_DEFAULTS));
  return { ...PT_DEFAULTS, ...data };
}

// Content scripts работают в процессах чужих сайтов — не даём им читать
// storage (там лежат API-ключи). Настройки без ключей рассылаем сами.
chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});

function publicSettings(s) {
  const { deeplKey, libreKey, ...rest } = s;
  return rest;
}

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !Object.keys(changes).some((k) => k in PT_DEFAULTS)) return;
  const msg = { type: 'pt:settings', settings: publicSettings(await getSettings()) };
  for (const tab of await chrome.tabs.query({})) chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
});

// ---------- Состояние вкладок (переживает перезапуск service worker) ----------

const tabKey = (tabId) => `tab_${tabId}`;

async function getTabState(tabId) {
  const data = await chrome.storage.session.get(tabKey(tabId));
  return data[tabKey(tabId)] || { active: false };
}

async function setTabActive(tabId, active) {
  await chrome.storage.session.set({ [tabKey(tabId)]: { active } });
  progress.delete(tabId);
  // Без frameId сообщение получают content scripts всех фреймов вкладки.
  chrome.tabs.sendMessage(tabId, { type: 'pt:setActive', active }).catch(() => {});
}

chrome.tabs.onUpdated.addListener((tabId, info) => {
  // Полная навигация — сбрасываем ручное состояние (автоперевод включится сам).
  if (info.status === 'loading' && info.url) {
    chrome.storage.session.remove(tabKey(tabId));
    progress.delete(tabId);
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(tabKey(tabId));
  progress.delete(tabId);
});

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

// ---------- Перевод ----------

/** Перевод массива HTML-строк с учётом кеша. */
async function translateTexts(texts, tabId) {
  const settings = await getSettings();
  const provider = getProvider(settings.provider);
  const target = settings.targetLang;

  const keys = texts.map((t) => cache.makeKey(provider.id, target, t));
  const result = await cache.getMany(keys);

  const missIdx = [];
  result.forEach((v, i) => v === undefined && missIdx.push(i));
  if (missIdx.length) {
    const fresh = await queue.translate(
      provider,
      missIdx.map((i) => texts[i]),
      { target, settings, tabId }
    );
    const entries = [];
    missIdx.forEach((i, j) => {
      result[i] = fresh[j];
      entries.push([keys[i], fresh[j]]);
    });
    cache.setMany(entries);
  }
  return result;
}

function errorPayload(e) {
  return { message: e?.message || String(e), code: e?.code || 'error' };
}

// ---------- Прогресс: собираем со всех фреймов, показываем в главном ----------

const progress = new Map(); // tabId -> Map(frameId -> {pending, done})

function reportProgress(tabId, frameId, msg) {
  if (tabId == null) return;
  let frames = progress.get(tabId);
  if (!frames) progress.set(tabId, (frames = new Map()));
  frames.set(frameId, { pending: msg.pending, done: msg.done, error: msg.error, errorCode: msg.errorCode });

  let pending = 0;
  let done = 0;
  let error = null;
  let errorCode = null;
  for (const f of frames.values()) {
    pending += f.pending;
    done += f.done;
    if (f.error && !error) ({ error, errorCode } = f);
  }
  chrome.tabs
    .sendMessage(tabId, { type: 'pt:progressUpdate', pending, done, error, errorCode }, { frameId: 0 })
    .catch(() => {});
}

// ---------- Сообщения ----------

const handlers = {
  // Content script фрейма запрашивает начальное состояние.
  async 'pt:init'(msg, sender) {
    const settings = await getSettings();
    const tabId = sender.tab?.id;
    const topHost = hostOf(sender.tab?.url || '');
    const frameHost = hostOf(sender.url || '');
    const state = tabId != null ? await getTabState(tabId) : { active: false };

    const frameExcluded = sender.frameId !== 0 && PT_hostMatches(frameHost, settings.excludedSites);
    const auto =
      PT_hostMatches(topHost, settings.autoSites) && !PT_hostMatches(topHost, settings.excludedSites);
    if (auto && !state.active && tabId != null) {
      await chrome.storage.session.set({ [tabKey(tabId)]: { active: true } });
      state.active = true;
    }
    return {
      settings: publicSettings(settings),
      topHost,
      frameId: sender.frameId,
      active: state.active && !frameExcluded,
      disabled: frameExcluded,
    };
  },

  async 'pt:translate'(msg, sender) {
    try {
      return { translations: await translateTexts(msg.texts, sender.tab?.id) };
    } catch (e) {
      return { error: errorPayload(e) };
    }
  },

  async 'pt:progress'(msg, sender) {
    reportProgress(sender.tab?.id, sender.frameId, msg);
    return true;
  },

  // Своя горячая клавиша на странице (из любого фрейма).
  async 'pt:toggle'(msg, sender) {
    if (sender.tab?.id == null) return false;
    return { active: await toggleTab(sender.tab.id) };
  },

  // Повторить неудавшиеся блоки во всех фреймах (например, после загрузки модели).
  async 'pt:retryAll'(msg, sender) {
    const tabId = msg.tabId ?? sender.tab?.id;
    if (tabId != null) chrome.tabs.sendMessage(tabId, { type: 'pt:retry' }).catch(() => {});
    return true;
  },

  // --- popup / options ---
  async 'pt:getTabState'(msg) {
    return getTabState(msg.tabId);
  },

  async 'pt:setActive'(msg) {
    await setTabActive(msg.tabId, msg.active);
    return { active: msg.active };
  },

  async 'pt:checkProvider'(msg) {
    const settings = await getSettings();
    const provider = getProvider(msg.provider || settings.provider);
    return provider.check({ target: settings.targetLang, settings, tabId: msg.tabId });
  },

  async 'pt:clearCache'() {
    await cache.clear();
    return cache.stats();
  },

  async 'pt:cacheStats'() {
    return cache.stats();
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  handler(msg, sender)
    .then(sendResponse)
    .catch((e) => sendResponse({ error: errorPayload(e) }));
  return true; // ответ асинхронный
});

// ---------- Горячая клавиша ----------

async function toggleTab(tabId) {
  const { active } = await getTabState(tabId);
  await setTabActive(tabId, !active);
  return !active;
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-translation') return;
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) await toggleTab(tab.id);
});

// ---------- Контекстное меню ----------

const MENU_ID = 'pt-translate-selection';

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: MENU_ID,
    title: 'Перевести выделенное: «%s»',
    contexts: ['selection'],
  });
});

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) return;
  const original = info.selectionText || '';
  const msg = { type: 'pt:showSelection', original };
  try {
    // Ответ — HTML-строка; content script сам раскодирует сущности.
    [msg.translationHtml] = await translateTexts([escapeHtml(original)], tab.id);
  } catch (e) {
    msg.error = errorPayload(e).message;
  }
  chrome.tabs.sendMessage(tab.id, msg, { frameId: info.frameId ?? 0 }).catch(() => {});
});

// Перед выгрузкой service worker кеш может не успеть сохраниться —
// сбрасываем его при приостановке.
chrome.runtime.onSuspend?.addListener(() => {
  cache.flush();
});
