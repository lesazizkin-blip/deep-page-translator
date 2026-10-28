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
    const text = segs.map((s) => s.src).join('').replace(/\s+/g, ' ').trim();
    return text.length > 2000 ? text.slice(0, 2000) + '…' : text;
  }

  // ---------- Слова, которые не переводим (названия языков, библиотек, сервисов) ----------

  let builtinRe = null; // регистр важен: «Python», но не «python» в смысле «питон»
  let userRe = null; // свой список пользователя — без учёта регистра

  function termsRegex(terms, flags) {
    const list = [...new Set(terms.map((t) => String(t).trim()).filter(Boolean))]
      .sort((a, b) => b.length - a.length) // длинные раньше: «scikit-learn» до «scikit»
      .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!list.length) return null;
    return new RegExp(`(?<![\\p{L}\\p{N}_-])(?:${list.join('|')})(?![\\p{L}\\p{N}_])`, flags);
  }

  let wholeRes = []; // те же списки, но «весь текст — одно слово»

  function setProtectedTerms(userTerms) {
    builtinRe = termsRegex(globalThis.PT_PROTECTED_TERMS || [], 'gu');
    userRe = termsRegex(userTerms || [], 'giu');
    wholeRes = [userRe, builtinRe].filter(Boolean).map((re) => new RegExp(`^(?:${re.source})$`, re.flags.replace('g', '')));
  }
  setProtectedTerms([]);

  /** Экранирует текст и оборачивает защищённые слова в notranslate. */
  function protect(text) {
    let html = PT.escapeHtml(text);
    for (const re of [userRe, builtinRe]) {
      if (!re) continue;
      // Не трогаем то, что уже внутри notranslate-обёртки.
      html = html.replace(/(<span class="notranslate">.*?<\/span>)|([^<]+)/g, (m, wrapped, plain) =>
        wrapped ? wrapped : plain.replace(re, (t) => `<span class="notranslate">${t}</span>`)
      );
    }
    return html;
  }

  /** Весь текст — одно защищённое слово (тег «pandas», «Python»): переводить нечего. */
  function isFullyProtected(text) {
    const t = text.trim();
    return wholeRes.some((re) => re.test(t));
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
      htmls: splitLong(seg.src.trim()).map(protect),
    };
  }

  function markupUnit(block, segs) {
    let html = '';
    segs.forEach((s, i) => {
      const lead = /^\s/.test(s.src) ? ' ' : '';
      const trail = /\s$/.test(s.src) ? ' ' : '';
      const cls = s.fixed ? ' class="notranslate"' : '';
      const body = s.fixed ? PT.escapeHtml(s.src.trim()) : protect(s.src.trim());
      html += `${lead}<b id=${i}${cls}>${body}</b>${trail}`;
    });
    return { kind: 'markup', block, segs, htmls: [html.replace(/ {2,}/g, ' ').trim()] };
  }

  /**
   * Текст в <pre> (лицензия, .txt): узел может быть огромным, а строки — с жёсткими
   * переносами. Делим на абзацы по пустым строкам, абзац переводим одной строкой,
   * а потом снова переносим по исходной ширине, сохраняя отступы.
   */
  function proseUnit(block, seg) {
    // Куски текста: абзацы и разделители (пустые строки). Абзацы-заголовки
    // (все строки с большим отступом, как «GNU GENERAL PUBLIC LICENSE» по центру)
    // дробим на отдельные строки, чтобы не склеивать их в одну.
    const parts = []; // чётные индексы — текст, нечётные — разделители
    for (const [k, p] of seg.src.split(/(\n[ \t]*\n+)/).entries()) {
      if (k % 2) {
        parts[parts.length - 1] += p; // пустая строка — к предыдущему разделителю
        continue;
      }
      const lines = p.split('\n');
      const centered = lines.filter((l) => /\S/.test(l)).every((l) => l.match(/^\s*/)[0].length >= 8);
      if (centered && lines.length > 1) lines.forEach((l, j) => parts.push(l, j < lines.length - 1 ? '\n' : ''));
      else parts.push(p, '');
    }

    const paras = [];
    parts.forEach((p, i) => {
      if (i % 2 || !HAS_LETTER.test(p)) return;
      const lines = p.split('\n');
      // Строки до первой строки с буквами (например, «>» после ссылки) оставляем как есть.
      const first = lines.findIndex((l) => HAS_LETTER.test(l));
      const body = lines.slice(first);
      const trailing = body[body.length - 1].match(/\s*$/)[0];
      paras.push({
        index: i,
        before: lines.slice(0, first).join('\n') + (first > 0 ? '\n' : ''),
        indent: body[0].match(/^\s*/)[0],
        contIndent: body.length > 1 ? body[1].match(/^\s*/)[0] : body[0].match(/^\s*/)[0],
        width: Math.max(...body.map((l) => l.trimEnd().length)),
        multiline: body.length > 1,
        after: trailing,
        text: body.map((l) => l.trim()).join(' '),
      });
    });
    return {
      kind: 'prose',
      block,
      segs: [seg],
      parts,
      paras,
      htmls: paras.map((p) => protect(p.text)),
    };
  }

  /** Жадный перенос строк по ширине. */
  function wrap(text, width, indent, contIndent) {
    const lines = [];
    let cur = '';
    for (const w of text.split(' ')) {
      if (!cur) cur = (lines.length ? contIndent : indent) + w;
      else if (cur.length + 1 + w.length > width) {
        lines.push(cur);
        cur = contIndent + w;
      } else cur += ' ' + w;
    }
    if (cur) lines.push(cur);
    return lines.join('\n');
  }

  /**
   * Строит единицы перевода для блока.
   * plainOnly — для провайдеров без поддержки HTML: каждый узел отдельно.
   * Возвращает {units, text} или null, если переводить нечего.
   */
  function build(block, { plainOnly = false } = {}) {
    const segs = PT.dom
      .segmentsOf(block)
      .map((s) => ({ ...s, src: s.placeholder ?? sourceOf(s.node) }))
      .filter((s) => /\S/.test(s.src));
    // Сегмент целиком из защищённого слова («pandas») ведёт себя как <code>: контекст, но не перевод.
    for (const s of segs) if (!s.fixed && isFullyProtected(s.src)) s.fixed = true;
    const translatable = segs.filter((s) => !s.fixed && HAS_LETTER.test(s.src));
    if (!translatable.length || translatable.every((s) => isTranslated(s.node))) return null;

    const units = [];
    if (PT.dom.isProsePre(block)) {
      // Текст в <pre>: каждый узел — абзацами; ссылки внутри (<a>) — как отдельные куски.
      for (const s of translatable) {
        if (isTranslated(s.node)) continue;
        units.push(s.src.includes('\n') ? proseUnit(block, s) : plainUnit(block, s));
      }
    } else if (plainOnly) {
      for (const s of translatable) if (!isTranslated(s.node)) units.push(plainUnit(block, s));
    } else if (translatable.length === 1 && segs.length === 1) {
      units.push(plainUnit(block, translatable[0]));
    } else if (isItemList(block, segs)) {
      // Вкладки, теги, кнопки: каждый пункт — отдельно.
      const groups = new Map();
      for (const s of segs) {
        const top = PT.dom.topChildOf(s.node, block);
        if (!groups.has(top)) groups.set(top, []);
        groups.get(top).push(s);
      }
      for (const g of groups.values()) {
        const tr = g.filter((s) => !s.fixed && HAS_LETTER.test(s.src));
        if (!tr.length) continue;
        units.push(g.length === 1 ? plainUnit(block, g[0]) : markupUnit(block, g));
      }
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

  /**
   * Список пунктов, а не предложение: в блоке нет своего текста с буквами между
   * элементами, а все элементы с текстом — ссылки/кнопки/элементы с role, и их несколько.
   */
  function isItemList(block, segs) {
    const tops = new Set();
    for (const s of segs) {
      if (s.node.parentNode === block) {
        if (HAS_LETTER.test(s.src)) return false; // свой текст блока — это предложение
        continue;
      }
      const top = PT.dom.topChildOf(s.node, block);
      if (!top || top.nodeType !== Node.ELEMENT_NODE || !PT.dom.isItem(top)) return false;
      tops.add(top);
    }
    return tops.size > 1;
  }

  /** Записывает готовый текст в узел и запоминает оригинал. */
  function writeNode(seg, data) {
    const node = seg.node;
    if (!node.isConnected || sourceOf(node) !== seg.src) return; // сайт уже изменил текст
    if (node.data !== data) node.data = data;
    PT.store.nodeInfo.set(node, { orig: seg.src, tr: data });
    PT.store.translated.add(node);
  }

  /**
   * Приводит пробелы в порядок. Переводчик ставит пробел после notranslate-обёртки
   * даже перед точкой: «Python и pandas .» → «Python и pandas.».
   */
  function tidy(text) {
    return text.replace(/\s+/g, ' ').replace(/ ([,.])(?= |$)/g, '$1').trim();
  }

  /** Записывает перевод в текстовый узел, сохраняя пробелы по краям оригинала. */
  function setSegment(seg, translated) {
    const core = tidy(translated);
    // Перед знаком препинания пробел оригинала не нужен: «pd.read_csv, чтобы…», а не «pd.read_csv , чтобы…».
    const lead = /^[,.;:!?)\]»%]/.test(core) ? '' : seg.src.match(/^\s*/)[0];
    const trail = seg.src.match(/\s*$/)[0];
    writeNode(seg, lead + core + trail);
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

    if (unit.kind === 'prose') {
      const parts = unit.parts.slice();
      unit.paras.forEach((p, i) => {
        const text = tidy(PT.decodeHtml(outs[i]));
        const body = p.multiline && p.width >= 30 ? wrap(text, p.width, p.indent, p.contIndent) : p.indent + text;
        parts[p.index] = p.before + body + p.after;
      });
      writeNode(unit.segs[0], parts.join(''));
      return true;
    }

    // Перевод в виде последовательности кусков: {id или null (текст вне тегов), text}.
    const runs = [];
    const visit = (node, cur) => {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          runs.push({ id: cur, text: child.data });
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const idAttr = child.localName === 'b' ? child.getAttribute('id') : null;
          const ok = idAttr != null && /^\d+$/.test(idAttr) && +idAttr < unit.segs.length;
          visit(child, ok ? +idAttr : cur);
        }
      }
    };
    visit(PT.parseHtml(outs[0]), null);

    const segs = unit.segs;
    const isFixed = (id) => segs[id]?.fixed;
    // «Оформленные» узлы — внутри <a>, <em>, <code>…; «простые» — текст самого блока.
    const styled = segs.map((s, i) => i).filter((i) => isStyled(segs[i], unit.block));
    const needText = segs.map((s, i) => i).filter((i) => !isFixed(i) && HAS_LETTER.test(segs[i].src));

    const texts = applyByGaps(runs, segs, styled, unit.block) || applyByIds(runs, isFixed);
    if (!texts || needText.some((i) => texts.get(i) === undefined)) return false;
    // Числа не должны теряться: Google иногда «съедает» их рядом с разметкой
    // («1 of 6 [иконка]» → «1 из [иконка]»). Тогда переводим узлы по одному.
    const digits = (list) => list.flatMap((t) => t.match(/\d+/g) || []).sort().join(',');
    const srcTexts = segs.filter((s, i) => !isFixed(i)).map((s) => s.src);
    const outTexts = [...texts].filter(([i]) => !isFixed(i)).map(([, t]) => t);
    if (digits(srcTexts) !== digits(outTexts)) return false;
    // Оформленный узел (ссылка) не должен остаться пустым — иначе ссылка «исчезнет».
    if (needText.some((i) => styled.includes(i) && !/\S/.test(texts.get(i)))) return false;

    for (const i of needText) setSegment(segs[i], texts.get(i));
    // Простые узлы без букв («.», « — ») тоже получают свою часть, если переводчик её туда положил.
    for (const [i, t] of texts) if (!needText.includes(i) && !isFixed(i) && !styled.includes(i)) setSegment(segs[i], t);
    return true;
  }

  function isStyled(seg, block) {
    return seg.fixed || seg.node.parentNode !== block;
  }

  /**
   * Основной способ: оформленные узлы получают текст своих тегов, а текст
   * между ними раскладывается по «промежуткам» в порядке перевода. Так
   * «Read <a>the guide</a> before you start» → «Прежде чем начать, прочтите <a>руководство</a>»
   * остаётся правильным, хотя переводчик переставил части предложения.
   * Работает, только если оформленные узлы сохранили порядок; иначе — null.
   */
  function applyByGaps(runs, segs, styled, block) {
    const order = [];
    for (const r of runs) if (r.id != null && styled.includes(r.id) && !order.includes(r.id)) order.push(r.id);
    if (order.length !== styled.length || order.some((id, k) => id !== styled[k])) return null;

    const texts = new Map();
    const gapText = new Array(styled.length + 1).fill('');
    let gap = 0;
    for (const r of runs) {
      if (r.id != null && styled.includes(r.id)) {
        if (!segs[r.id].fixed) texts.set(r.id, (texts.get(r.id) || '') + r.text);
        gap = styled.indexOf(r.id) + 1;
      } else {
        gapText[gap] += r.text;
      }
    }

    // Простые узлы DOM по промежуткам: сколько оформленных узлов стоит перед ними.
    const slots = gapText.map(() => []);
    const orphans = [];
    segs.forEach((s, i) => {
      if (styled.includes(i)) return;
      slots[styled.filter((j) => j < i).length].push(i);
    });
    gapText.forEach((t, g) => {
      if (slots[g].length) {
        slots[g].forEach((i, k) => texts.set(i, k === 0 ? t : ''));
      } else if (/\S/.test(t)) {
        // Переводчик поставил текст туда, где в DOM нет простого узла (например, после
        // иконки: «1 of 6 [icon]» → «1 из [icon] 6»). Терять его нельзя — приклеиваем
        // к соседнему оформленному узлу или к ближайшему простому.
        orphans.push({ g, t });
      }
    });
    for (const { g, t } of orphans) {
      const prevStyled = styled[g - 1] != null && !segs[styled[g - 1]].fixed ? styled[g - 1] : null;
      const nextStyled = styled[g] != null && !segs[styled[g]].fixed ? styled[g] : null;
      // Текст промежутка лежит в его первом узле (остальные очищены).
      const prevPlain = slots.slice(0, g).filter((s) => s.length).map((s) => s[0]).pop();
      const nextPlain = slots.slice(g + 1).filter((s) => s.length).map((s) => s[0])[0];
      const target = prevStyled ?? prevPlain ?? nextStyled ?? nextPlain;
      if (target == null) return null; // некуда положить — пусть сработает запасной способ
      const before = target === prevStyled || target === prevPlain;
      const cur = texts.get(target) || '';
      texts.set(target, before ? `${cur} ${t}` : `${t} ${cur}`);
    }
    return texts;
  }

  /** Запасной способ: каждый id получает текст своего тега (текст вне тегов — предыдущему). */
  function applyByIds(runs, isFixed) {
    const texts = new Map();
    let prefix = '';
    let last = null;
    for (const r of runs) {
      if (r.id != null) {
        if (isFixed(r.id)) continue;
        texts.set(r.id, (texts.get(r.id) || '') + r.text);
        last = r.id;
      } else if (last == null) {
        prefix += r.text;
      } else if (/\S/.test(r.text)) {
        texts.set(last, texts.get(last) + r.text);
      }
    }
    const first = [...texts.keys()].sort((a, b) => a - b)[0];
    if (/\S/.test(prefix) && first != null) texts.set(first, prefix + texts.get(first));
    return texts;
  }

  /** Запасной вариант: каждый узел единицы отдельной plain-единицей. */
  function splitToPlain(unit) {
    return unit.segs.filter((s) => !s.fixed && HAS_LETTER.test(s.src)).map((s) => plainUnit(unit.block, s));
  }

  return { build, apply, splitToPlain, sourceOf, isTranslated, protect, setProtectedTerms, tidy };
})();
