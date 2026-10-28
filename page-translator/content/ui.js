// Интерфейс на странице: индикатор прогресса, подсказка с оригиналом,
// всплывающий перевод выделенного. Всё живёт в закрытом shadow root,
// поэтому стили сайта на него не влияют, а наши — не ломают сайт.

PT.ui = (() => {
  let host = null;
  let root = null;
  let els = {};
  let hideTimer = null;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .pill {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
      display: none; align-items: center; gap: 10px;
      max-width: min(420px, calc(100vw - 32px));
      padding: 8px 10px 8px 12px; border-radius: 10px;
      background: #1f2328; color: #f0f3f6; font-size: 13px; line-height: 1.35;
      box-shadow: 0 4px 16px rgba(0,0,0,.25); opacity: .93;
    }
    .pill.show { display: flex; }
    .pill.error { background: #5c1d1d; }
    .bar { width: 64px; height: 4px; border-radius: 2px; background: rgba(255,255,255,.2); flex: none; overflow: hidden; }
    .bar > i { display: block; height: 100%; width: 0; background: #4c9bff; transition: width .2s; }
    .pill.error .bar { display: none; }
    .msg { flex: 1; }
    button {
      all: unset; cursor: pointer; padding: 3px 8px; border-radius: 6px;
      background: rgba(255,255,255,.14); color: inherit; font-size: 12px; white-space: nowrap;
    }
    button:hover { background: rgba(255,255,255,.25); }
    button.x { background: none; padding: 0 4px; font-size: 16px; opacity: .7; }
    .tip, .bubble {
      position: fixed; z-index: 2147483647; display: none;
      max-width: min(480px, calc(100vw - 24px)); max-height: 40vh; overflow: auto;
      padding: 8px 10px; border-radius: 8px; font-size: 13px; line-height: 1.45;
      background: #ffffff; color: #1f2328; border: 1px solid #d0d7de;
      box-shadow: 0 6px 24px rgba(0,0,0,.18); white-space: pre-wrap; pointer-events: none;
    }
    .tip.show, .bubble.show { display: block; }
    .bubble { pointer-events: auto; }
    .bubble .orig { color: #656d76; font-size: 12px; margin-bottom: 6px; }
    .bubble .err { color: #b42318; }
    .label { font-size: 11px; color: #656d76; margin-bottom: 3px; text-transform: uppercase; letter-spacing: .03em; }
    @media (prefers-color-scheme: dark) {
      .tip, .bubble { background: #22272e; color: #e6edf3; border-color: #444c56; }
      .bubble .orig, .label { color: #9198a1; }
      .bubble .err { color: #ff8b8b; }
    }
  `;

  function ensure() {
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.setAttribute('data-pt-ui', '');
    host.setAttribute('translate', 'no');
    root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>${CSS}</style>
      <div class="pill" role="status" aria-live="polite">
        <span class="bar"><i></i></span><span class="msg"></span>
        <button class="act" hidden></button><button class="x" title="Скрыть">×</button>
      </div>
      <div class="tip"><div class="label">Оригинал</div><div class="tip-text"></div></div>
      <div class="bubble"><div class="orig"></div><div class="tr"></div></div>`;
    els = {
      pill: root.querySelector('.pill'),
      bar: root.querySelector('.bar > i'),
      msg: root.querySelector('.msg'),
      act: root.querySelector('.act'),
      close: root.querySelector('.x'),
      tip: root.querySelector('.tip'),
      tipText: root.querySelector('.tip-text'),
      bubble: root.querySelector('.bubble'),
      bOrig: root.querySelector('.bubble .orig'),
      bTr: root.querySelector('.bubble .tr'),
    };
    els.close.addEventListener('click', () => els.pill.classList.remove('show'));
    // documentElement, а не body: на него реже влияют transform/overflow сайта.
    (document.documentElement || document).appendChild(host);
  }

  function showPill({ text, percent = null, error = false, action = null }) {
    ensure();
    clearTimeout(hideTimer);
    els.pill.classList.add('show');
    els.pill.classList.toggle('error', error);
    els.msg.textContent = text;
    els.bar.style.width = percent == null ? '0' : `${percent}%`;
    if (action) {
      els.act.hidden = false;
      els.act.textContent = action.label;
      els.act.onclick = action.onClick;
    } else {
      els.act.hidden = true;
      els.act.onclick = null;
    }
  }

  function hidePill(delay = 0) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => els.pill?.classList.remove('show'), delay);
  }

  /** Сводный прогресс по всем фреймам вкладки (показывается в главном фрейме). */
  function showProgress({ pending, done, error, errorCode }) {
    if (errorCode === 'needs-activation') {
      showModelPrompt();
      return;
    }
    if (error) {
      showError(error);
      return;
    }
    const total = pending + done;
    if (!pending) {
      if (total) {
        showPill({ text: 'Перевод готов', percent: 100 });
        hidePill(1200);
      } else {
        hidePill();
      }
      return;
    }
    showPill({ text: `Перевод… ${done} из ${total}`, percent: Math.round((done / total) * 100) });
  }

  function showError(message) {
    showPill({
      text: message,
      error: true,
      action: { label: 'Повторить', onClick: () => PT.send({ type: 'pt:retryAll' }) },
    });
  }

  function showStatus(text) {
    showPill({ text });
  }

  function showModelPrompt() {
    showPill({
      text: 'Встроенному переводчику нужна языковая модель.',
      action: { label: 'Загрузить модель', onClick: () => PT.builtin.prepareFromClick() },
    });
  }

  // --- Подсказка с оригиналом ---
  function showTooltip(text, x, y) {
    ensure();
    els.tipText.textContent = text;
    els.tip.classList.add('show');
    place(els.tip, x, y);
  }

  function hideTooltip() {
    els.tip?.classList.remove('show');
  }

  // --- Перевод выделенного ---
  function showSelection({ original, translation, error }) {
    ensure();
    els.bOrig.textContent = original.length > 300 ? original.slice(0, 300) + '…' : original;
    els.bTr.textContent = error || translation;
    els.bTr.className = error ? 'tr err' : 'tr';
    els.bubble.classList.add('show');

    let x = innerWidth / 2;
    let y = innerHeight / 3;
    const sel = getSelection();
    if (sel && sel.rangeCount) {
      const r = sel.getRangeAt(0).getBoundingClientRect();
      if (r.width || r.height) (x = r.left), (y = r.bottom + 4);
    }
    place(els.bubble, x, y);

    const close = (e) => {
      if (e.type === 'keydown' && e.key !== 'Escape') return;
      if (e.type === 'mousedown' && e.composedPath().includes(host)) return;
      els.bubble.classList.remove('show');
      document.removeEventListener('mousedown', close, true);
      document.removeEventListener('keydown', close, true);
    };
    setTimeout(() => {
      document.addEventListener('mousedown', close, true);
      document.addEventListener('keydown', close, true);
    });
  }

  /** Размещает всплывающий элемент у точки, не выходя за края окна. */
  function place(el, x, y) {
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = Math.min(x + 12, innerWidth - w - 8);
    let top = y + 16;
    if (top + h > innerHeight - 8) top = Math.max(8, y - h - 12);
    el.style.left = `${Math.max(8, left)}px`;
    el.style.top = `${top}px`;
  }

  return { showProgress, showError, showStatus, showModelPrompt, showTooltip, hideTooltip, showSelection, hidePill };
})();
