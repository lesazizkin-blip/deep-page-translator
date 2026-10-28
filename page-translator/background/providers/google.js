// Google Translate через неофициальный endpoint translate.googleapis.com (client=gtx).
// Ключ не нужен. Поддерживает format=html: теги <b id=N> сохраняются,
// а содержимое с class="notranslate" не переводится.

import { Provider, ProviderError, httpError, fetchWithTimeout } from './base.js';

const ENDPOINT = 'https://translate.googleapis.com/translate_a/t';

export class GoogleProvider extends Provider {
  id = 'google';
  maxChars = 4500;
  maxItems = 64;
  concurrency = 4;

  async translate(texts, { target }) {
    const url = `${ENDPOINT}?client=gtx&sl=auto&tl=${encodeURIComponent(target)}&format=html&dt=t`;
    const body = new URLSearchParams();
    for (const t of texts) body.append('q', t);

    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body,
        credentials: 'omit',
      },
      20000,
      'Google'
    );
    if (!res.ok) throw httpError('Google', res.status);

    let data;
    try {
      data = await res.json();
    } catch {
      throw new ProviderError('Google: неожиданный ответ сервера (не JSON).', { retryable: true });
    }

    // Форматы ответа: ["перевод"], [["перевод","en"], ...] или просто "перевод".
    const list = Array.isArray(data) ? data : [data];
    const out = list.map((item) => (Array.isArray(item) ? item[0] : item));
    if (out.length !== texts.length || out.some((s) => typeof s !== 'string')) {
      throw new ProviderError('Google: число переводов не совпало с запросом.', { retryable: true });
    }
    return out;
  }
}
