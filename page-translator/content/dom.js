// Обход DOM: что переводить, что пропускать, как группировать в блоки.

PT.dom = (() => {
  // Элементы, содержимое которых никогда не переводим.
  const SKIP_TAGS = new Set([
    'script', 'style', 'noscript', 'template', 'code', 'pre', 'textarea', 'input',
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
    // Jupyter (JupyterLab/nbconvert и классический Notebook): код и вывод
    '.jp-CodeCell .jp-Cell-inputWrapper', '.jp-InputPrompt', '.jp-OutputPrompt',
    '.jp-OutputArea', '.jp-Cell-outputWrapper',
    '.code_cell .input', '.cell .input_area', '.cell .output_wrapper', '.cell .prompt',
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

  function isSkipped(el) {
    return SKIP_TAGS.has(el.localName) || el.matches(SKIP_SELECTOR);
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
   * onShadow(shadowRoot) — для каждого найденного shadow root.
   */
  function walk(root, onText, onShadow) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.TEXT_NODE) {
          return HAS_LETTER.test(node.data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        }
        // FILTER_REJECT отбрасывает всё поддерево сразу — это быстро.
        return isSkipped(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
      },
    });

    // TreeWalker не входит в shadow DOM — обходим хосты отдельно.
    const visitShadow = (el) => {
      const sr = shadowOf(el);
      if (sr) {
        onShadow?.(sr);
        walk(sr, onText, onShadow);
      }
    };
    if (root.nodeType === Node.ELEMENT_NODE && !isSkipped(root)) visitShadow(root);

    // Хосты shadow DOM ищем отдельным проходом по элементам.
    const elWalker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode: (el) => (isSkipped(el) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    let n;
    while ((n = walker.nextNode())) onText(n);
    while ((n = elWalker.nextNode())) visitShadow(n);
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
        if (isSkipped(node)) return NodeFilter.FILTER_REJECT;
        if (!isInline(node)) return NodeFilter.FILTER_REJECT; // вложенный блок
        return NodeFilter.FILTER_SKIP;
      },
    });
    let n;
    while ((n = walker.nextNode())) {
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

  return { isSkipped, isInsideSkipped, blockOf, targetOf, walk, segmentsOf, HAS_LETTER };
})();
