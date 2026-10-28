// LibreTranslate — собственный или публичный сервер пользователя.
// POST {url}/translate с массивом q и format=html.

import { Provider, ProviderError, httpError, fetchWithTimeout } from './base.js';

const TARGET_MAP = { 'zh-CN': 'zh', 'zh-TW': 'zt' };

export class LibreProvider extends Provider {
  id = 'libre';
  maxChars = 5000;
  maxItems = 25;
  concurrency = 2;

  async translate(texts, { target, settings }) {
    const base = (settings.libreUrl || '').trim().replace(/\/+$/, '');
    if (!base) {
      throw new ProviderError('LibreTranslate: не указан URL сервера. Задайте его в настройках.', {
        code: 'no-url',
      });
    }
    const payload = {
      q: texts,
      source: 'auto',
      target: TARGET_MAP[target] || target,
      format: 'html',
    };
    if (settings.libreKey) payload.api_key = settings.libreKey;

    const res = await fetchWithTimeout(
      `${base}/translate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
      30000,
      'LibreTranslate'
    );
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.json()).error || '';
      } catch {
        /* тело не JSON — игнорируем */
      }
      if (res.status === 400 || res.status === 403) {
        throw new ProviderError(`LibreTranslate: ${detail || 'запрос отклонён'} (HTTP ${res.status}).`, {
          code: 'http-' + res.status,
        });
      }
      throw httpError('LibreTranslate', res.status, detail);
    }

    const data = await res.json();
    let out = data.translatedText;
    if (typeof out === 'string') out = [out];
    if (!Array.isArray(out) || out.length !== texts.length) {
      throw new ProviderError('LibreTranslate: неожиданный формат ответа.', { retryable: false });
    }
    return out;
  }
}
