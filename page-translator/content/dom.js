// Обход DOM: что переводить, что пропускать, как группировать в блоки.

PT.dom = (() => {
  // Элементы, содержимое которых никогда не переводим.
  // <pre> здесь нет: код в нём пропускаем, а обычный текст (лицензии, .txt) переводим — см. isCodePre.
  const SKIP_TAGS = new Set([
    'script', 'style', 'noscript', 'template', 'code', 'textarea', 'input',
    'select', 'option', 'kbd', 'samp', 'var', 'svg', 'math', 'canvas', 'iframe',
    'frame', 'object', 'embed', 'video', 'audio', 'head', 'title',
  ]);

  // Селекторы пропускаемых областей: редактируемое, формулы, ячейки Jupyter, явный отказ.
  const SKIP_SELECTOR = [
    '[data-pt-ui]',
    '[translate="no"]',
    '.notranslate',
    '[contenteditable=""]',
    '[contenteditable="true"]',
    '[contenteditable="plaintext-only"]',
    // KaTeX / MathJax
    '.katex', '.katex-display', '.katex-mathml', 'mjx-container', '.MathJax',
    '.MathJax_Display', '.MathJax_Preview', '.MathJax_SVG', '.MJX_Assistive_MathML',
    // Jupyter (JupyterLab/nbconvert и классический Notebook): код и «технический» вывод —
    // текст программы, stdout/stderr, ошибки, таблицы pandas. HTML/Markdown-вывод
    // (подсказки learntools на Kaggle, пояснения) не пропускаем — это обычный текст.
    '.jp-CodeCell .jp-Cell-inputWrapper', '.jp-InputPrompt', '.jp-OutputPrompt', '.jp-OutputArea-prompt',
    '.jp-OutputArea-output[data-mime-type="text/plain"]',
    '.jp-OutputArea-output[data-mime-type="application/vnd.jupyter.stdout"]',
    '.jp-OutputArea-output[data-mime-type="application/vnd.jupyter.stderr"]',
    '.jp-RenderedText', '.jp-RenderedJavaScript',
    '.code_cell .input', '.cell .input_area', '.cell .prompt',
    '.cell .output_text', '.cell .output_stream', '.cell .output_stderr', '.cell .output_error',
    '.cell .output_javascript', 'table.dataframe',
    // Редакторы кода
    '.CodeMirror', '.cm-editor', '.monaco-editor',
  ].join(',');

  // Inline-элементы: текст внутри них принадлежит родительскому блоку.
  const INLINE_TAGS = new Set([
    'a', 'abbr', 'acronym', 'b', 'bdi', 'bdo', 'big', 'br', 'cite', 'code', 'data',
    'del', 'dfn', 'em', 'font', 'i', 'img', 'ins', 'kbd', 'label', 'mark', 'nobr',
    'q', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time',
    'tt', 'u', 'var', 'wbr',
  ]);

  // Inline-элементы, которые остаются в тексте блока как контекст, но не переводятся.
  const FIXED_INLINE_TAGS = new Set(['code', 'kbd', 'samp', 'var']);

  const HAS_LETTER = /\p{L}/u;

  // Признаки того, что <pre> содержит код: подсветка синтаксиса и т.п.
  const CODE_PRE_SELECTOR = [
    '.highlight', '.sourceCode', '.hljs', '.prism', '.codehilite', '.code', '.blob-code',
    '[class*="language-"]', '[class*="lang-"]', '[data-lang]', '[data-language]',
  ].join(',');
  const codePreCache = new WeakMap();

  /**
   * Код или обычный текст в <pre>? Код пропускаем; текст (GitHub показывает
   * LICENSE и .txt как <div class="plain"><pre>) переводим по абзацам.
   */
  function isCodePre(pre) {
    if (codePreCache.has(pre)) return codePreCache.get(pre);
    let code = true;
    if (!pre.querySelector('code, samp, kbd') && !pre.closest(CODE_PRE_SELECTOR) && !pre.querySelector(CODE_PRE_SELECTOR)) {
      const text = pre.textContent.slice(0, 4000);
      const letters = (text.match(/\p{L}/gu) || []).length;
      const symbols = (text.match(/[{}()[\];=<>$#*\\|&^~`@]/g) || []).length;
      const sentences = (text.match(/\p{L}{2,}[.!?](\s|$)/gu) || []).length;
      // Проза: много букв, мало «программных» символов, есть предложения.
      code = !(letters >= 120 && symbols / letters < 0.04 && sentences >= 2);
    }
    codePreCache.set(pre, code);
    return code;
  }

  function isProsePre(el) {
    return el?.nodeType === Node.ELEMENT_NODE && el.localName === 'pre' && !isCodePre(el);
  }

  /**
   * Иконка-лигатура: шрифт Material/Google Symbols рисует слово «arrow_drop_down» как значок.
   * Если такое слово перевести, вместо значка появится текст («Кодarrow_drop_down»).
   */
  function isIconLigature(el) {
    if (el.childElementCount) return false;
    const cls = el.getAttribute('class') || '';
    if (!/icon|symbol/i.test(cls) && el.getAttribute('aria-hidden') !== 'true' && el.localName !== 'mat-icon') return false;
    return /^[a-z][a-z0-9_]{2,}$/.test(el.textContent.trim());
  }

  function isSkipped(el) {
    if (el.localName === 'pre') return isCodePre(el) || el.matches(SKIP_SELECTOR);
    return SKIP_TAGS.has(el.localName) || el.matches(SKIP_SELECTOR) || isIconLigature(el);
  }

  // «Отдельные пункты»: вкладки, кнопки, теги-ссылки, пункты меню. Если в блоке
  // нет своего текста между ними, это список, а не предложение, и переводить
  // их нужно по одному: иначе «Tutorial | Data» превращается в «Учебные | данные».
  const ITEM_TAGS = new Set(['a', 'button', 'label']);
  function isItem(el) {
    if (ITEM_TAGS.has(el.localName)) return true;
    const role = el.getAttribute('role');
    return Boolean(role) && role !== 'presentation' && role !== 'none' && role !== 'text';
  }

  /** Непосредственный потомок block, внутри которого лежит node. */
  function topChildOf(node, block) {
    let n = node;
    while (n && n.parentNode !== block) n = n.parentNode;
    return n;
  }

  // Атрибуты с видимым текстом: подсказка в поле ввода и всплывающая подсказка.
  const TEXT_ATTRS = ['placeholder', 'title'];
  function hasTextAttr(el) {
    return TEXT_ATTRS.some((a) => HAS_LETTER.test(el.getAttribute(a) || ''));
  }

  function isInline(el) {
    return INLINE_TAGS.has(el.localName);
  }

  function isFixedInline(el) {
    return FIXED_INLINE_TAGS.has(el.localName);
  }

  /** Открытый shadowRoot; в content script доступен и закрытый через chrome.dom. */
  function shadowOf(el) {
    if (el.shadowRoot) return el.shadowRoot;
    if (el.hasAttribute('data-pt-ui')) return null;
    try {
      return chrome.dom?.openOrClosedShadowRoot?.(el) || null;
    } catch {
      return null;
    }
  }

  /** Родитель с переходом через границу shadow DOM. */
  function parentAcross(node) {
    const p = node.parentNode;
    if (p instanceof ShadowRoot) return p.host;
    return p;
  }

  /** Лежит ли узел внутри пропускаемой области (с учётом shadow DOM)? */
  function isInsideSkipped(node) {
    let el = node.nodeType === Node.ELEMENT_NODE ? node : parentAcross(node);
    while (el && el.nodeType === Node.ELEMENT_NODE) {
      if (isSkipped(el)) return true;
      el = parentAcross(el);
    }
    return false;
  }

  /**
   * Блок текстового узла: ближайший предок, не являющийся inline-элементом.
   * Может вернуть Element или ShadowRoot (если текст лежит прямо в нём).
   */
  function blockOf(textNode) {
    let el = textNode.parentNode;
    while (el && el.nodeType === Node.ELEMENT_NODE && isInline(el)) {
      const p = el.parentNode;
      if (!p || p.nodeType !== Node.ELEMENT_NODE) break;
      el = p;
    }
    return el;
  }

  /** Элемент, за которым следит IntersectionObserver и подсказка. */
  function targetOf(block) {
    return block instanceof ShadowRoot ? block.host : block;
  }

  /**
   * Обходит поддерево root (включая открытые shadow roots) и вызывает
   * onText(textNode) для каждого текстового узла с буквами,
   * onShadow(shadowRoot) — для каждого найденного shadow root,
   * onAttr(element) — для элементов с placeholder/title.
   */
  function walk(root, onText, onShadow, onAttr) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.TEXT_NODE) {
          return HAS_LETTER.test(node.data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        }
        // Поля ввода пропускаем, но их placeholder переводим; явный отказ (translate="no" и т.п.) — уважаем.
        if (onAttr && hasTextAttr(node) && !node.matches(SKIP_SELECTOR)) onAttr(node);
        // FILTER_REJECT отбрасывает всё поддерево сразу — это быстро.
        return isSkipped(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
      },
    });

    // TreeWalker не входит в shadow DOM — обходим хосты отдельно.
    const visitShadow = (el) => {
      const sr = shadowOf(el);
      if (sr) {
        onShadow?.(sr);
        walk(sr, onText, onShadow, onAttr);
      }
    };
    if (onAttr && root.nodeType === Node.ELEMENT_NODE && hasTextAttr(root) && !root.matches(SKIP_SELECTOR)) onAttr(root);
    if (root.nodeType === Node.ELEMENT_NODE && !isSkipped(root)) visitShadow(root);

    // Хосты shadow DOM ищем отдельным проходом по элементам.
    const elWalker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode: (el) => (isSkipped(el) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    let n;
    while ((n = walker.nextNode())) onText(n);
    while ((n = elWalker.nextNode())) visitShadow(n);
  }

  const PLACEHOLDER_SELECTOR = '.katex, mjx-container, .MathJax, math, [translate="no"], .notranslate';

  /** Текст-заменитель для пропускаемого inline-элемента внутри предложения (или null). */
  function placeholderText(el) {
    if (isIconLigature(el)) return el.textContent.trim();
    if (!(isInline(el) || el.localName === 'mjx-container' || el.localName === 'math')) return null;
    if (!el.matches(PLACEHOLDER_SELECTOR)) return null;
    // У KaTeX textContent дублирует формулу (MathML + HTML) — берём исходный TeX.
    const tex = el.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    const text = (tex || el.textContent || '').replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, 60) : null;
  }

  /**
   * Сегменты блока: текстовые узлы, принадлежащие именно этому блоку
   * (вложенные блочные элементы — отдельные блоки).
   * fixed=true — текст внутри <code> и т.п.: виден переводчику, но не меняется.
   */
  function segmentsOf(block) {
    const segs = [];
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
        if (isFixedInline(node)) return NodeFilter.FILTER_SKIP;
        if (isSkipped(node)) {
          // Формула или translate="no" посреди предложения: переводчик видит её
          // как неизменяемый кусок, чтобы текст вокруг не съезжал (acceptNode
          // вызывается в порядке документа, так что порядок сегментов верный).
          const text = placeholderText(node);
          if (text) segs.push({ node, fixed: true, placeholder: text });
          return NodeFilter.FILTER_REJECT;
        }
        if (!isInline(node)) return NodeFilter.FILTER_REJECT; // вложенный блок
        return NodeFilter.FILTER_SKIP;
      },
    });
    let n;
    while ((n = walker.nextNode())) {
      if (n.nodeType !== Node.TEXT_NODE) continue;
      let fixed = false;
      for (let p = n.parentNode; p && p !== block; p = p.parentNode) {
        if (p.nodeType === Node.ELEMENT_NODE && isFixedInline(p)) {
          fixed = true;
          break;
        }
      }
      segs.push({ node: n, fixed });
    }
    return segs;
  }

  // ---------- Комментарии в коде и текстовый вывод программ ----------
  // Код целиком пропускается, но внутри него есть две «зоны» с обычным текстом:
  // комментарии (подсветка синтаксиса размечает их отдельными span) и вывод print().

  const COMMENT_SELECTOR = [
    '.highlight .c', '.highlight .c1', '.highlight .cm', '.highlight .cs', // Pygments (Jupyter, Kaggle, Sphinx)
    '.hljs-comment', // highlight.js
    '.token.comment', // Prism
    '.pl-c', // GitHub
  ].join(',');
  const OUTPUT_SELECTOR = [
    '.output_stdout > pre', // Jupyter classic / nbconvert (Kaggle)
    '.jp-OutputArea-output[data-mime-type="application/vnd.jupyter.stdout"] > pre', // JupyterLab
  ].join(',');
  // Живые редакторы трогать нельзя: правка их DOM превратится в правку самого кода.
  const LIVE_EDITOR = '.CodeMirror, .cm-editor, .monaco-editor, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"], [data-pt-ui]';

  /** 'comment' | 'output' | null. Для вложенных комментариев (GitHub) зона — внешний. */
  function codeZoneKind(el) {
    if (el.nodeType !== Node.ELEMENT_NODE || el.closest(LIVE_EDITOR)) return null;
    if (el.matches(COMMENT_SELECTOR) && !el.parentElement?.closest(COMMENT_SELECTOR)) return 'comment';
    if (el.matches(OUTPUT_SELECTOR)) return 'output';
    return null;
  }

  /** Все зоны внутри root (и сам root, если он зона). kinds: {comment: bool, output: bool}. */
  function findCodeZones(root, kinds) {
    const sel = [kinds.comment && COMMENT_SELECTOR, kinds.output && OUTPUT_SELECTOR].filter(Boolean).join(',');
    if (!sel || !root.querySelectorAll) return [];
    const list = root.nodeType === Node.ELEMENT_NODE && root.matches(sel) ? [root] : [];
    list.push(...root.querySelectorAll(sel));
    return list.filter((el) => kinds[codeZoneKind(el)]);
  }

  /** Зона, в которой лежит узел (для текста, изменённого уже после перевода). */
  function codeZoneOf(node, kinds) {
    let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    let zone = null;
    for (; el; el = el.parentElement) if (kinds[codeZoneKind(el)]) zone = el;
    return zone;
  }

  function textNodesOf(el) {
    const out = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }

  return {
    isSkipped, isInsideSkipped, isProsePre, isItem, topChildOf, blockOf, targetOf, walk, segmentsOf,
    codeZoneKind, findCodeZones, codeZoneOf, textNodesOf,
    HAS_LETTER, TEXT_ATTRS,
  };
})();
