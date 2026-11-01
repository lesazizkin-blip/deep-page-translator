// Перевод комментариев в живых редакторах кода (CodeMirror 5/6, Monaco):
// редактор ноутбука Kaggle, JupyterLab и т.п.
//
// Менять DOM редактора нельзя: CodeMirror считает такие изменения вводом
// пользователя и правит сам код. Поэтому перевод рисуется в отдельном слое
// поверх комментария — тем же шрифтом и на том же фоне. Клики проходят сквозь
// слой в редактор, а пока ячейка в фокусе (её редактируют), перевод скрыт.

PT.editors = (() => {
  const LINE_SELECTOR = '.cm-editor .cm-line, .CodeMirror .CodeMirror-line, .monaco-editor .view-line';
  const FOCUSED_SELECTOR = '.cm-editor.cm-focused, .CodeMirror.CodeMirror-focused, .monaco-editor.focused';
  const COMMENT_CLASS = /(^|\s)(cm-comment|tok-comment)(\s|$)/;
  // Тот же разбор строки комментария, что и для статичной подсветки.
  const COMMENT_RE = /^(\s*(?:#+:?|\/\/+!?)\s*)(.*?)(\s*)$/;

  let active = false;
  let cache = new Map(); // исходный текст комментария -> перевод целиком (с маркером) или null
  let waiting = new Set(); // тексты, ожидающие перевода
  let flushTimer = null;
  const tracked = new Map(); // span комментария -> div в слое
  let rafId = 0;
  let frame = 0;
  const covered = new WeakMap(); // span -> закрыт ли чем-то (меню, диалог)
  const bgCache = new WeakMap(); // редактор -> цвет фона

  /** Похож ли листовой span строки редактора на комментарий. */
  function isCommentSpan(span) {
    if (span.childElementCount) return false;
    return COMMENT_CLASS.test(span.getAttribute('class') || '') || /^\s*(#|\/\/)/.test(span.textContent);
  }

  /** Найти комментарии в root (строка редактора, редактор, документ). */
  function scan(root) {
    if (!active || !root) return;
    const lines = [];
    const own = root.nodeType === Node.ELEMENT_NODE ? root.closest(LINE_SELECTOR) : null;
    if (own) lines.push(own);
    else if (root.querySelectorAll) lines.push(...root.querySelectorAll(LINE_SELECTOR));
    for (const line of lines) {
      for (const span of line.querySelectorAll('span')) {
        if (tracked.has(span) || !isCommentSpan(span)) continue;
        const text = span.textContent;
        const m = text.match(COMMENT_RE);
        if (!m || !PT.markup.looksLikeProse(m[2], 'comment')) continue;
        tracked.set(span, null);
        if (!cache.has(text)) waiting.add(text);
      }
    }
    if (waiting.size) scheduleFlush();
    if (tracked.size) loop();
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, 150);
  }

  async function flush() {
    flushTimer = null;
    const texts = [...waiting].filter((t) => !cache.has(t)).slice(0, 80);
    waiting = new Set([...waiting].filter((t) => !texts.includes(t)));
    if (!texts.length || !active) return;
    texts.forEach((t) => cache.set(t, null)); // «в работе», повторно не запрашиваем
    const parts = texts.map((t) => t.match(COMMENT_RE));
    const resp = await PT.send({ type: 'pt:translate', texts: parts.map((m) => PT.markup.protectCode(m[2])) });
    if (!resp?.translations) {
      texts.forEach((t) => cache.delete(t)); // попробуем при следующей перерисовке
      return;
    }
    texts.forEach((t, i) => {
      const m = parts[i];
      cache.set(t, m[1] + PT.markup.tidy(PT.decodeHtml(resp.translations[i])) + m[3]);
    });
    if (waiting.size) scheduleFlush();
    loop();
  }

  /**
   * Фон под комментарием: первый полностью непрозрачный фон вверх по дереву.
   * Полупрозрачные (подсветка активной строки) пропускаем — сквозь них виден оригинал.
   */
  function backgroundOf(span) {
    const editor = span.closest('.cm-editor, .CodeMirror, .monaco-editor') || span;
    if (bgCache.has(editor)) return bgCache.get(editor);
    let bg = 'rgb(255, 255, 255)';
    for (let el = span; el; el = el.parentElement) {
      const c = getComputedStyle(el).backgroundColor;
      const alpha = c.startsWith('rgba') ? parseFloat(c.split(',')[3]) : c === 'transparent' ? 0 : 1;
      if (alpha >= 1) {
        bg = c;
        break;
      }
    }
    bgCache.set(editor, bg);
    return bg;
  }

  function createOverlay(span, text) {
    const cs = getComputedStyle(span);
    const div = document.createElement('div');
    div.textContent = text;
    Object.assign(div.style, {
      position: 'fixed',
      whiteSpace: 'pre',
      pointerEvents: 'none',
      overflow: 'visible',
      fontFamily: cs.fontFamily,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      fontStyle: cs.fontStyle,
      letterSpacing: cs.letterSpacing,
      color: cs.color,
      background: backgroundOf(span),
      margin: '0',
      padding: '0',
    });
    PT.ui.overlayLayer().appendChild(div);
    return div;
  }

  /** Каждый кадр подгоняем слои под комментарии (прокрутка, правки, перерисовка). */
  function loop() {
    if (rafId || !active) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      if (!active) return;
      const vh = innerHeight;
      const checkCover = ++frame % 6 === 0; // проверка «не закрыт ли комментарий меню» — не каждый кадр
      for (const [span, div] of tracked) {
        if (!span.isConnected) {
          div?.remove();
          tracked.delete(span);
          continue;
        }
        const source = span.textContent;
        if (!cache.has(source) && !waiting.has(source)) {
          // Комментарий отредактировали — переводим новый текст (если это всё ещё текст).
          const m = source.match(COMMENT_RE);
          if (m && isCommentSpan(span) && PT.markup.looksLikeProse(m[2], 'comment')) {
            waiting.add(source);
            scheduleFlush();
          } else {
            cache.set(source, null);
          }
        }
        const text = cache.get(source);
        let el = div;
        if (text && !el) tracked.set(span, (el = createOverlay(span, text)));
        if (!el) continue;
        if (el.textContent !== text && text) el.textContent = text;
        const r = span.getBoundingClientRect();
        if (checkCover && r.width) {
          // Слой лежит поверх всего; если комментарий закрыт меню или диалогом сайта — прячемся.
          const hit = document.elementFromPoint(r.left + 1, r.top + r.height / 2);
          covered.set(span, Boolean(hit) && !(span.closest(LINE_SELECTOR) || span).contains(hit));
        }
        const hidden =
          !text || covered.get(span) || span.closest(FOCUSED_SELECTOR) || r.bottom < 0 || r.top > vh || !r.width;
        el.style.display = hidden ? 'none' : 'block';
        if (hidden) continue;
        el.style.left = `${r.left}px`;
        el.style.top = `${r.top}px`;
        el.style.height = `${r.height}px`;
        el.style.lineHeight = `${r.height}px`;
        el.style.minWidth = `${r.width}px`;
      }
      if (tracked.size) loop();
    });
  }

  function start() {
    active = true;
  }

  function stop() {
    active = false;
    cancelAnimationFrame(rafId);
    rafId = 0;
    for (const div of tracked.values()) div?.remove();
    tracked.clear();
    waiting.clear();
  }

  /** Смена языка: старые переводы не годятся. */
  function reset() {
    cache = new Map();
  }

  return { start, stop, reset, scan };
})();
