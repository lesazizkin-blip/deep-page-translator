// Превращение блока в «единицы перевода» и обратная раскладка перевода по узлам.
//
// Блок «Use <code>pd.read_csv</code> to load <a>the data</a>.» отправляется как
//   <b id=0>Use</b> <b id=1 class="notranslate">pd.read_csv</b> <b id=2>to load</b> <b id=3>the data</b><b id=4>.</b>
// Переводчик переводит предложение целиком, сохраняя теги, а мы потом
// записываем текст каждого <b id=N> обратно в N-й текстовый узел.
// Элементы страницы не пересоздаются — меняется только node.data.

PT.store = {
  // Text -> {orig, tr}: оригинал и наш перевод узла (для переключения и проверки).
  nodeInfo: new WeakMap(),
  // Все переведённые узлы (для «Показать оригинал»).
  translated: new Set(),
};

PT.markup = (() => {
  const MAX_UNIT_CHARS = 3500; // крупнее — режем, чтобы влезть в лимиты провайдеров
  const { HAS_LETTER } = PT.dom;

  /** Исходный текст узла: если узел уже переведён нами — его оригинал. */
  function sourceOf(node) {
    const info = PT.store.nodeInfo.get(node);
    return info && node.data === info.tr ? info.orig : node.data;
  }

  function isTranslated(node) {
    const info = PT.store.nodeInfo.get(node);
    return Boolean(info) && node.data === info.tr;
  }

  /** Текст блока целиком (для подсказки с оригиналом). */
  function blockText(segs) {
    return segs.map((s) => s.src).join('').replace(/\s+/g, ' ').trim();
  }

  /** Делит очень длинный текст по предложениям на куски не длиннее limit. */
  function splitLong(text, limit = MAX_UNIT_CHARS) {
    if (text.length <= limit) return [text];
    const sentences = text.split(/(?<=[.!?。！？;])\s+/);
    const parts = [];
    let cur = '';
    for (let s of sentences) {
      while (s.length > limit) {
        // Предложение-монстр без точек — режем по пробелу.
        let cut = s.lastIndexOf(' ', limit);
        if (cut < limit / 2) cut = limit;
        if (cur) parts.push(cur), (cur = '');
        parts.push(s.slice(0, cut));
        s = s.slice(cut).trimStart();
      }
      if (cur && cur.length + s.length + 1 > limit) parts.push(cur), (cur = '');
      cur = cur ? cur + ' ' + s : s;
    }
    if (cur) parts.push(cur);
    return parts;
  }

  function plainUnit(block, seg) {
    return {
      kind: 'plain',
      block,
      segs: [seg],
      htmls: splitLong(seg.src.trim()).map(PT.escapeHtml),
    };
  }

  function markupUnit(block, segs) {
    let html = '';
    segs.forEach((s, i) => {
      const lead = /^\s/.test(s.src) ? ' ' : '';
      const trail = /\s$/.test(s.src) ? ' ' : '';
      const cls = s.fixed ? ' class="notranslate"' : '';
      html += `${lead}<b id=${i}${cls}>${PT.escapeHtml(s.src.trim())}</b>${trail}`;
    });
    return { kind: 'markup', block, segs, htmls: [html.replace(/ {2,}/g, ' ').trim()] };
  }

  /**
   * Строит единицы перевода для блока.
   * plainOnly — для провайдеров без поддержки HTML: каждый узел отдельно.
   * Возвращает {units, text} или null, если переводить нечего.
   */
  function build(block, { plainOnly = false } = {}) {
    const segs = PT.dom
      .segmentsOf(block)
      .map((s) => ({ ...s, src: sourceOf(s.node) }))
      .filter((s) => /\S/.test(s.src));
    const translatable = segs.filter((s) => !s.fixed && HAS_LETTER.test(s.src));
    if (!translatable.length || translatable.every((s) => isTranslated(s.node))) return null;

    const units = [];
    if (plainOnly) {
      for (const s of translatable) if (!isTranslated(s.node)) units.push(plainUnit(block, s));
    } else if (translatable.length === 1 && segs.length === 1) {
      units.push(plainUnit(block, translatable[0]));
    } else {
      // Режем длинный блок на куски по границам узлов.
      let chunk = [];
      let size = 0;
      const flush = () => {
        if (chunk.some((s) => !s.fixed && HAS_LETTER.test(s.src))) units.push(markupUnit(block, chunk));
        chunk = [];
        size = 0;
      };
      for (const s of segs) {
        const len = s.src.length + 24; // + обёртка тега
        if (len > MAX_UNIT_CHARS) {
          flush();
          if (!s.fixed && HAS_LETTER.test(s.src)) units.push(plainUnit(block, s));
          continue;
        }
        if (size + len > MAX_UNIT_CHARS) flush();
        chunk.push(s);
        size += len;
      }
      flush();
    }
    return units.length ? { units, text: blockText(segs) } : null;
  }

  /** Записывает перевод в текстовый узел, сохраняя пробелы по краям оригинала. */
  function setSegment(seg, translated) {
    const node = seg.node;
    if (!node.isConnected || sourceOf(node) !== seg.src) return; // сайт уже изменил текст
    const core = translated.replace(/\s+/g, ' ').trim();
    // Перед знаком препинания пробел оригинала не нужен: «pd.read_csv, чтобы…», а не «pd.read_csv , чтобы…».
    const lead = /^[,.;:!?)\]»%]/.test(core) ? '' : seg.src.match(/^\s*/)[0];
    const trail = seg.src.match(/\s*$/)[0];
    const data = lead + core + trail;
    if (node.data !== data) node.data = data;
    PT.store.nodeInfo.set(node, { orig: seg.src, tr: data });
    PT.store.translated.add(node);
  }

  /**
   * Применяет перевод единицы. Возвращает false, если разметку не удалось
   * разобрать (переводчик потерял теги) — тогда вызывающий переводит узлы по одному.
   */
  function apply(unit, outs) {
    if (unit.kind === 'plain') {
      setSegment(unit.segs[0], PT.decodeHtml(outs.join(' ')));
      return true;
    }

    const texts = new Map(); // id -> текст
    let prefix = '';
    let lastText = null; // последний нефиксированный id — к нему «прилипает» текст вне тегов
    const isFixed = (id) => unit.segs[id]?.fixed;

    const visit = (node, cur) => {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          const target = cur != null && !isFixed(cur) ? cur : lastText;
          if (cur != null && isFixed(cur)) continue; // перевод «непереводимого» игнорируем
          if (target == null) prefix += child.data;
          else if (cur != null || /\S/.test(child.data)) texts.set(target, (texts.get(target) || '') + child.data);
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const idAttr = child.localName === 'b' ? child.getAttribute('id') : null;
          if (idAttr != null && /^\d+$/.test(idAttr) && +idAttr < unit.segs.length) {
            const id = +idAttr;
            if (!texts.has(id)) texts.set(id, '');
            visit(child, id);
            if (!isFixed(id)) lastText = id;
          } else {
            visit(child, cur);
          }
        }
      }
    };
    visit(PT.parseHtml(outs[0]), null);

    const ids = unit.segs.map((s, i) => i).filter((i) => !unit.segs[i].fixed && HAS_LETTER.test(unit.segs[i].src));
    if (ids.some((i) => !/\S/.test(texts.get(i) || ''))) return false;
    if (/\S/.test(prefix)) texts.set(ids[0], prefix + texts.get(ids[0]));

    for (const i of ids) setSegment(unit.segs[i], texts.get(i));
    return true;
  }

  /** Запасной вариант: каждый узел единицы отдельной plain-единицей. */
  function splitToPlain(unit) {
    return unit.segs.filter((s) => !s.fixed && HAS_LETTER.test(s.src)).map((s) => plainUnit(unit.block, s));
  }

  return { build, apply, splitToPlain, sourceOf, isTranslated };
})();
