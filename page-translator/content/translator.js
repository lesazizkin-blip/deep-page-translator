// Движок перевода фрейма: очередь блоков, приоритет видимой области,
// отслеживание нового контента, переключение «оригинал ↔ перевод».

PT.engine = (() => {
  const MAX_INFLIGHT = 3; // параллельных пачек от одного фрейма
  const BATCH_CHARS = 6000;
  const BATCH_BLOCKS = 40;
  const MO_OPTIONS = { childList: true, subtree: true, characterData: true };

  let active = false;
  let gen = 0; // поколение: ответы от «старых» запусков игнорируются
  let settings = { ...PT_DEFAULTS };

  let queued = new Set(); // блоки (Element | ShadowRoot), ожидающие перевода
  let visible = new Set(); // элементы-цели, сейчас попадающие в видимую область
  let known = new WeakSet(); // цели, о которых IntersectionObserver уже сообщил
  let failed = new Set(); // блоки, перевод которых завершился ошибкой
  let observedRoots = new WeakSet();
  const originals = new WeakMap(); // элемент блока -> исходный текст (для подсказки)

  // Атрибуты placeholder/title: переводятся после текста, отдельной очередью.
  let attrQueue = new Set(); // элементы, ожидающие перевода атрибутов
  let attrInfo = new WeakMap(); // элемент -> {имя атрибута: {orig, tr}}
  const translatedAttrs = new Set(); // элементы с переведёнными атрибутами

  let inflight = 0;
  let inflightBlocks = 0;
  let doneBlocks = 0;
  let lastError = null;
  let pumpTimer = null;
  let rescanTimers = [];

  // ---------- Наблюдатели ----------

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        known.add(e.target);
        if (e.isIntersecting) visible.add(e.target);
        else visible.delete(e.target);
      }
      schedulePump();
    },
    { rootMargin: '300px 0px' } // чуть заранее — пока пользователь прокручивает
  );

  const mo = new MutationObserver(onMutations);
  let pendingNodes = new Set();
  const processPendingSoon = debounceMax(processPending, 300, 1000);

  /** Debounce с ограничением максимального ожидания (страница может меняться непрерывно). */
  function debounceMax(fn, wait, maxWait) {
    let t = null;
    let first = 0;
    return () => {
      const now = Date.now();
      if (!t) first = now;
      clearTimeout(t);
      const delay = Math.max(0, Math.min(wait, maxWait - (now - first)));
      t = setTimeout(() => {
        t = null;
        fn();
      }, delay);
    };
  }

  function observeRoot(root) {
    if (observedRoots.has(root)) return;
    observedRoots.add(root);
    mo.observe(root, MO_OPTIONS);
  }

  function onMutations(records) {
    if (!active) return;
    for (const r of records) {
      if (r.type === 'characterData') {
        // Наши собственные записи перевода сюда тоже попадают — отсекаем их.
        if (!PT.markup.isTranslated(r.target)) pendingNodes.add(r.target);
      } else {
        for (const n of r.addedNodes) {
          if (n.nodeType === Node.ELEMENT_NODE || n.nodeType === Node.TEXT_NODE) pendingNodes.add(n);
        }
      }
    }
    if (pendingNodes.size) processPendingSoon();
  }

  function processPending() {
    const nodes = [...pendingNodes];
    pendingNodes.clear();
    if (!active) return;
    for (const n of nodes) {
      if (!n.isConnected || PT.dom.isInsideSkipped(n)) continue;
      if (n.nodeType === Node.TEXT_NODE) {
        if (PT.dom.HAS_LETTER.test(n.data) && !PT.markup.isTranslated(n)) enqueue(PT.dom.blockOf(n));
      } else {
        scan(n);
      }
    }
  }

  // ---------- Сбор блоков ----------

  function enqueue(block) {
    if (!block || queued.has(block)) return;
    const target = PT.dom.targetOf(block);
    if (!target || target.nodeType !== Node.ELEMENT_NODE) return;
    queued.add(block);
    io.observe(target);
    schedulePump();
  }

  function scan(root) {
    PT.dom.walk(
      root,
      (text) => {
        if (!PT.markup.isTranslated(text)) enqueue(PT.dom.blockOf(text));
      },
      observeRoot, // новые shadow roots тоже наблюдаем на изменения
      (el) => {
        attrQueue.add(el);
        schedulePump();
      }
    );
  }

  // ---------- Атрибуты ----------

  /** Исходное значение атрибута или null, если он уже переведён нами. */
  function attrSource(el, name) {
    const cur = el.getAttribute(name);
    if (!cur || !PT.dom.HAS_LETTER.test(cur)) return null;
    const info = attrInfo.get(el)?.[name];
    return info && cur === info.tr ? null : cur;
  }

  async function runAttrs(myGen) {
    const items = [];
    for (const el of attrQueue) {
      attrQueue.delete(el);
      if (!el.isConnected) continue;
      for (const name of PT.dom.TEXT_ATTRS) {
        const src = attrSource(el, name);
        if (src) items.push({ el, name, src });
      }
      if (items.length >= 60) break;
    }
    if (!items.length) return;
    const resp = await PT.send({ type: 'pt:translate', texts: items.map((i) => PT.markup.protect(i.src.trim())) });
    if (myGen !== gen || !resp?.translations) return;
    items.forEach((it, k) => {
      if (it.el.getAttribute(it.name) !== it.src) return; // сайт уже поменял значение
      const tr = PT.markup.tidy(PT.decodeHtml(resp.translations[k]));
      const info = attrInfo.get(it.el) || {};
      info[it.name] = { orig: it.src, tr };
      attrInfo.set(it.el, info);
      translatedAttrs.add(it.el);
      it.el.setAttribute(it.name, tr);
    });
  }

  /** Переключает атрибуты между оригиналом и переводом. */
  function swapAttrs(toTranslation) {
    for (const el of translatedAttrs) {
      const info = attrInfo.get(el);
      if (!el.isConnected || !info) {
        translatedAttrs.delete(el);
        continue;
      }
      for (const [name, { orig, tr }] of Object.entries(info)) {
        const [from, to] = toTranslation ? [orig, tr] : [tr, orig];
        if (el.getAttribute(name) === from) el.setAttribute(name, to);
      }
    }
  }

  // ---------- Отправка пачек ----------

  function schedulePump(delay = 0) {
    if (pumpTimer || !active) return;
    pumpTimer = setTimeout(() => {
      pumpTimer = null;
      pump(delay > 0);
    }, delay);
  }

  /**
   * Выбирает блоки для следующей пачки: сначала видимые, затем остальные,
   * о которых IntersectionObserver уже отчитался; force — брать и «неизвестные».
   */
  function pickBatch(force) {
    const plainOnly = settings.provider === 'builtin';
    const picked = [];
    let chars = 0;

    const take = (block) => {
      queued.delete(block);
      const target = PT.dom.targetOf(block);
      io.unobserve(target);
      visible.delete(target);
      if (!target.isConnected) return;
      const res = PT.markup.build(block, { plainOnly });
      if (!res) return;
      res.target = target;
      picked.push(res);
      chars += res.units.reduce((n, u) => n + u.htmls.reduce((m, h) => m + h.length, 0), 0);
    };
    const full = () => chars >= BATCH_CHARS || picked.length >= BATCH_BLOCKS;

    const passes = [
      (t) => visible.has(t),
      (t) => known.has(t),
      () => force,
    ];
    for (const pass of passes) {
      for (const block of queued) {
        if (full()) return picked;
        if (pass(PT.dom.targetOf(block))) take(block);
      }
    }
    return picked;
  }

  function pump(force = false) {
    if (!active) return;
    while (inflight < MAX_INFLIGHT) {
      const blocks = pickBatch(force);
      if (!blocks.length) break;
      inflight++;
      inflightBlocks += blocks.length;
      const myGen = gen;
      run(blocks, myGen).finally(() => {
        if (myGen !== gen) return; // счётчики уже сброшены при выключении
        inflight--;
        inflightBlocks -= blocks.length;
        reportProgress();
        pump();
      });
    }
    // Атрибуты — когда текст уже разобран (они менее заметны).
    if (inflight < MAX_INFLIGHT && !queued.size && attrQueue.size) {
      inflight++;
      const myGen = gen;
      runAttrs(myGen).finally(() => {
        if (myGen !== gen) return;
        inflight--;
        pump();
      });
    }
    // Остались блоки, о которых IntersectionObserver ещё не сообщил
    // (например, в скрытом iframe) — через паузу заберём и их.
    if (queued.size && inflight === 0 && !force) schedulePump(400);
    reportProgress();
  }

  async function run(blocks, myGen) {
    const units = blocks.flatMap((b) => b.units);
    const resp = await PT.send({ type: 'pt:translate', texts: units.flatMap((u) => u.htmls) });
    if (myGen !== gen) return;
    if (!resp || resp.error) {
      blocks.forEach((b) => failed.add(b.units[0].block));
      lastError = resp?.error || { message: 'Нет связи с расширением — обновите страницу.', code: 'no-bg' };
      return;
    }

    const fallback = [];
    let k = 0;
    for (const u of units) {
      const outs = resp.translations.slice(k, (k += u.htmls.length));
      if (!PT.markup.apply(u, outs)) fallback.push(...PT.markup.splitToPlain(u));
    }

    // Переводчик потерял разметку — переводим узлы такого блока по одному.
    if (fallback.length) {
      const resp2 = await PT.send({ type: 'pt:translate', texts: fallback.flatMap((u) => u.htmls) });
      if (myGen !== gen) return;
      if (resp2?.translations) {
        let j = 0;
        for (const u of fallback) PT.markup.apply(u, resp2.translations.slice(j, (j += u.htmls.length)));
      }
    }

    for (const b of blocks) originals.set(b.target, b.text);
    doneBlocks += blocks.length;
    lastError = null;
  }

  // ---------- Прогресс ----------

  let reportTimer = null;
  let lastReport = '';
  function reportProgress() {
    if (reportTimer) return;
    reportTimer = setTimeout(() => {
      reportTimer = null;
      const msg = {
        type: 'pt:progress',
        pending: active ? queued.size + inflightBlocks : 0,
        done: active ? doneBlocks : 0,
        error: lastError?.message || null,
        errorCode: lastError?.code || null,
      };
      const key = JSON.stringify(msg);
      if (key === lastReport) return;
      // Фрейм без текста ничего не сообщает — не засоряем индикатор.
      if (!lastReport && !msg.pending && !msg.done && !msg.error) return;
      lastReport = key;
      PT.send(msg);
    }, 250);
  }

  // ---------- Включение / выключение ----------

  /** Возвращает узлам сохранённый перевод (мгновенно, без сети). */
  function reapply() {
    for (const node of PT.store.translated) {
      const info = PT.store.nodeInfo.get(node);
      if (!node.isConnected || !info) PT.store.translated.delete(node);
      else if (node.data === info.orig) node.data = info.tr;
    }
  }

  /** Возвращает оригинальный текст. */
  function restore() {
    for (const node of PT.store.translated) {
      const info = PT.store.nodeInfo.get(node);
      if (!node.isConnected || !info) PT.store.translated.delete(node);
      else if (node.data === info.tr) node.data = info.orig;
    }
  }

  function start() {
    active = true;
    gen++;
    doneBlocks = 0;
    lastError = null;
    reapply(); // до подключения MutationObserver, чтобы не ловить свои же изменения
    swapAttrs(true);
    observeRoot(document);
    scan(document);
    // Повторные проходы ловят shadow roots, прикреплённые уже после загрузки.
    const myGen = gen;
    rescanTimers = [1500, 5000].map((ms) => setTimeout(() => active && gen === myGen && scan(document), ms));
  }

  function stop() {
    active = false;
    gen++;
    mo.disconnect();
    io.disconnect();
    rescanTimers.forEach(clearTimeout);
    clearTimeout(pumpTimer);
    pumpTimer = null;
    observedRoots = new WeakSet();
    queued = new Set();
    visible = new Set();
    known = new WeakSet();
    failed = new Set();
    attrQueue = new Set();
    pendingNodes.clear();
    inflight = 0;
    inflightBlocks = 0;
    lastError = null;
    restore();
    swapAttrs(false);
    PT.ui.hideTooltip();
    reportProgress();
  }

  function setActive(on) {
    if (on === active) return;
    on ? start() : stop();
  }

  /** Смена языка/провайдера: старые переводы больше не годятся. */
  function reset() {
    const wasActive = active;
    if (wasActive) stop();
    PT.store.translated.clear();
    PT.store.nodeInfo = new WeakMap();
    translatedAttrs.clear();
    attrInfo = new WeakMap();
    if (wasActive) start();
  }

  function retryFailed() {
    if (!active) return;
    lastError = null;
    const blocks = [...failed];
    failed = new Set();
    blocks.forEach(enqueue);
    scan(document);
    reportProgress();
  }

  function setSettings(s) {
    settings = { ...settings, ...s };
  }

  /** Оригинал блока для подсказки (только когда перевод показан). */
  function originalFor(el) {
    return active ? originals.get(el) : undefined;
  }

  return {
    setActive,
    reset,
    retryFailed,
    setSettings,
    originalFor,
    get active() {
      return active;
    },
  };
})();
