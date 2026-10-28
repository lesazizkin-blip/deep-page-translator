// DeepL API (официальный). Ключ вида "xxxx:fx" — бесплатный тариф (api-free),
// остальные — Pro (api.deepl.com). tag_handling=html сохраняет inline-разметку.

import { Provider, ProviderError, httpError, fetchWithTimeout } from './base.js';

// Google-коды → коды DeepL для target_lang.
const TARGET_MAP = {
  en: 'EN-US',
  pt: 'PT-BR',
  'zh-CN': 'ZH-HANS',
  'zh-TW': 'ZH-HANT',
};

export class DeepLProvider extends Provider {
  id = 'deepl';
  maxChars = 25000; // лимит DeepL — 128 KiB на запрос, оставляем запас
  maxItems = 50; // лимит DeepL — 50 текстов на запрос
  concurrency = 2;

  async translate(texts, { target, settings }) {
    const key = (settings.deeplKey || '').trim();
    if (!key) {
      throw new ProviderError('DeepL: не указан API-ключ. Добавьте его на странице настроек.', {
        code: 'no-key',
      });
    }
    const host = key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
    const res = await fetchWithTimeout(
      `${host}/v2/translate`,
      {
        method: 'POST',
        headers: {
          Authorization: `DeepL-Auth-Key ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: texts,
          target_lang: TARGET_MAP[target] || target.toUpperCase(),
          tag_handling: 'html',
          ignore_tags: ['code'],
        }),
      },
      30000,
      'DeepL'
    );

    if (res.status === 403) throw new ProviderError('DeepL: неверный API-ключ (403).', { code: 'auth' });
    if (res.status === 456) throw new ProviderError('DeepL: исчерпана квота символов (456).', { code: 'quota' });
    if (!res.ok) throw httpError('DeepL', res.status, await safeText(res));

    const data = await res.json();
    const out = (data.translations || []).map((t) => t.text);
    if (out.length !== texts.length) {
      throw new ProviderError('DeepL: число переводов не совпало с запросом.', { retryable: true });
    }
    return out;
  }
}

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return '';
  }
}
