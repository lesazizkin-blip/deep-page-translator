// Общий интерфейс провайдера перевода.
//
// Каждый провайдер получает массив строк в HTML-формате (текст экранирован,
// inline-разметка передаётся тегами <b id=N>) и обязан вернуть массив
// переводов той же длины и в том же порядке.

export class ProviderError extends Error {
  /**
   * @param {string} message  понятное пользователю сообщение (на русском)
   * @param {{code?: string, retryable?: boolean, retryAfterMs?: number}} [opts]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = opts.code || 'error';
    this.retryable = Boolean(opts.retryable);
    this.retryAfterMs = opts.retryAfterMs || 0;
  }
}

export class Provider {
  /** Уникальный идентификатор (совпадает со значением в настройках). */
  id = 'base';
  /** Максимум символов в одном запросе. */
  maxChars = 4000;
  /** Максимум строк в одном запросе. */
  maxItems = 50;
  /** Сколько запросов к провайдеру можно выполнять параллельно. */
  concurrency = 3;

  /**
   * @param {string[]} texts
   * @param {{target: string, settings: object, tabId?: number}} ctx
   * @returns {Promise<string[]>}
   */
  // eslint-disable-next-line no-unused-vars
  async translate(texts, ctx) {
    throw new ProviderError('Провайдер не реализован');
  }

  /**
   * Проверка доступности: пробный перевод короткой фразы.
   * @returns {Promise<{ok: boolean, message: string}>}
   */
  async check(ctx) {
    try {
      const [res] = await this.translate(['Hello, world'], ctx);
      return { ok: true, message: `Работает: «Hello, world» → «${res}»` };
    } catch (e) {
      return { ok: false, message: e.message || String(e) };
    }
  }
}

/** Ошибка из HTTP-ответа: решаем, можно ли повторить запрос. */
export function httpError(providerName, status, extra = '') {
  if (status === 429) {
    return new ProviderError(
      `${providerName}: слишком много запросов (429). Повторяю с паузой…`,
      { code: 'rate-limit', retryable: true, retryAfterMs: 4000 }
    );
  }
  if (status >= 500) {
    return new ProviderError(`${providerName}: ошибка сервера (${status}).`, {
      code: 'server',
      retryable: true,
    });
  }
  return new ProviderError(
    `${providerName}: запрос отклонён (HTTP ${status})${extra ? ': ' + extra : ''}.`,
    { code: 'http-' + status }
  );
}

/** fetch с таймаутом и понятной ошибкой сети. */
export async function fetchWithTimeout(url, init = {}, timeoutMs = 20000, providerName = 'Провайдер') {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    const msg =
      e.name === 'AbortError'
        ? `${providerName}: сервер не ответил за ${timeoutMs / 1000} с.`
        : `${providerName}: нет соединения (${e.message}).`;
    throw new ProviderError(msg, { code: 'network', retryable: true });
  } finally {
    clearTimeout(timer);
  }
}
