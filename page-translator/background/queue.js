// Очередь запросов к провайдерам.
//
// Content scripts всех фреймов присылают тексты пачками; очередь
//  * объединяет одинаковые тексты (дедупликация «в полёте»),
//  * собирает батчи с учётом лимитов провайдера (символы и число строк),
//  * ограничивает параллельность запросов,
//  * повторяет запрос с экспоненциальной паузой при временных ошибках.

const FLUSH_DELAY_MS = 15; // небольшое окно, чтобы склеить пачки из разных фреймов
const MAX_RETRIES = 3;

class Group {
  constructor(provider, ctx) {
    this.provider = provider;
    this.ctx = ctx;
    this.waiting = []; // [{text, resolve, reject}]
    this.inflight = new Map(); // text -> Promise<string>
    this.active = 0;
    this.timer = null;
  }
}

export class TranslationQueue {
  constructor() {
    this.groups = new Map();
  }

  /**
   * Перевести массив строк. Возвращает Promise<string[]>.
   * ctx: {target, settings, tabId}
   */
  translate(provider, texts, ctx) {
    // Встроенный переводчик привязан к вкладке — у каждой своя группа.
    const gk = `${provider.id}|${ctx.target}|${provider.id === 'builtin' ? ctx.tabId : ''}`;
    let g = this.groups.get(gk);
    if (!g) {
      g = new Group(provider, ctx);
      this.groups.set(gk, g);
    }
    g.ctx = ctx; // всегда свежие настройки (ключи могли смениться)

    const promises = texts.map((text) => {
      const existing = g.inflight.get(text);
      if (existing) return existing;
      const p = new Promise((resolve, reject) => g.waiting.push({ text, resolve, reject }));
      g.inflight.set(text, p);
      const cleanup = () => g.inflight.delete(text);
      p.then(cleanup, cleanup);
      return p;
    });
    this.#schedule(g);
    return Promise.all(promises);
  }

  #schedule(g) {
    if (g.timer) return;
    g.timer = setTimeout(() => {
      g.timer = null;
      this.#pump(g);
    }, FLUSH_DELAY_MS);
  }

  #pump(g) {
    const { provider } = g;
    while (g.active < provider.concurrency && g.waiting.length) {
      const batch = [];
      let chars = 0;
      while (g.waiting.length && batch.length < provider.maxItems) {
        const len = g.waiting[0].text.length;
        if (batch.length && chars + len > provider.maxChars) break;
        batch.push(g.waiting.shift());
        chars += len;
      }
      g.active++;
      this.#run(g, batch).finally(() => {
        g.active--;
        this.#pump(g);
      });
    }
  }

  async #run(g, batch) {
    const texts = batch.map((j) => j.text);
    for (let attempt = 0; ; attempt++) {
      try {
        const out = await g.provider.translate(texts, g.ctx);
        batch.forEach((j, i) => j.resolve(out[i]));
        return;
      } catch (e) {
        if (!e.retryable || attempt >= MAX_RETRIES) {
          batch.forEach((j) => j.reject(e));
          return;
        }
        const base = e.retryAfterMs || 700;
        const delay = base * Math.pow(2.5, attempt) + Math.random() * 300;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
}
