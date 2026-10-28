// Встроенный Translator API Chrome (on-device, Chrome 138+).
//
// API доступно только в контексте окна (не в service worker) и только
// в главном фрейме или same-origin iframe. Поэтому провайдер — прокси:
// пересылает тексты в content script главного фрейма вкладки (frameId 0),
// а тот уже вызывает Translator.create()/translate().

import { Provider, ProviderError } from './base.js';

export class BuiltinProvider extends Provider {
  id = 'builtin';
  maxChars = 6000;
  maxItems = 40;
  concurrency = 1; // модель локальная, параллелизм не ускоряет

  async translate(texts, { target, tabId }) {
    if (tabId == null || tabId < 0) {
      throw new ProviderError('Встроенный переводчик работает только на вкладке со страницей.', {
        code: 'no-tab',
      });
    }
    let resp;
    try {
      resp = await chrome.tabs.sendMessage(tabId, { type: 'pt:builtinTranslate', texts, target }, { frameId: 0 });
    } catch (e) {
      throw new ProviderError(
        'Встроенный переводчик: страница недоступна для расширения (обновите вкладку).',
        { code: 'no-frame' }
      );
    }
    if (!resp) throw new ProviderError('Встроенный переводчик: нет ответа от страницы.', { code: 'no-frame' });
    if (resp.error) throw new ProviderError(resp.error.message, { code: resp.error.code });
    return resp.translations;
  }

  async check({ target, tabId }) {
    if (tabId == null) return { ok: false, message: 'Откройте обычную веб-страницу, чтобы проверить.' };
    try {
      const resp = await chrome.tabs.sendMessage(tabId, { type: 'pt:builtinCheck', target }, { frameId: 0 });
      return resp || { ok: false, message: 'Нет ответа от страницы.' };
    } catch {
      return { ok: false, message: 'Страница недоступна для расширения (обновите вкладку).' };
    }
  }
}
