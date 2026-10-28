// Точка входа content script: инициализация фрейма, сообщения от background,
// реакция на смену настроек, подсказка с оригиналом.

(async () => {
  if (PT.started) return; // защита от повторного внедрения
  PT.started = true;

  const init = await PT.send({ type: 'pt:init' });
  if (!init) return; // страница расширению недоступна

  let settings = init.settings;
  const isTopFrame = init.frameId === 0;
  const disabled = init.disabled; // хост фрейма в списке исключений
  PT.engine.setSettings(settings);

  // ---------- Сообщения ----------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg?.type) {
      case 'pt:setActive':
        if (!disabled) PT.engine.setActive(msg.active);
        return false;

      case 'pt:settings':
        applySettings(msg.settings);
        return false;

      case 'pt:retry':
        PT.engine.retryFailed();
        return false;

      case 'pt:progressUpdate':
        if (isTopFrame) PT.ui.showProgress(msg);
        return false;

      case 'pt:showSelection':
        PT.ui.showSelection({
          original: msg.original,
          translation: msg.translationHtml != null ? PT.decodeHtml(msg.translationHtml) : '',
          error: msg.error,
        });
        return false;

      // Встроенный Translator API — только главный фрейм.
      case 'pt:builtinTranslate':
        if (!isTopFrame) return false;
        PT.builtin
          .translate(msg.texts, msg.target)
          .then((translations) => sendResponse({ translations }))
          .catch((e) => sendResponse({ error: { message: e.message, code: e.code || 'error' } }));
        return true;

      case 'pt:builtinCheck':
        if (!isTopFrame) return false;
        PT.builtin.check(msg.target).then(sendResponse);
        return true;
    }
    return false;
  });

  // ---------- Настройки (присылает background; storage content script'ам закрыт) ----------

  function applySettings(next) {
    const needRetranslate = next.targetLang !== settings.targetLang || next.provider !== settings.provider;
    settings = next;
    PT.engine.setSettings(settings);
    if (needRetranslate) PT.engine.reset();
  }

  // ---------- Подсказка с оригиналом ----------

  let tipTarget = null;
  let tipTimer = null;

  const hideTip = () => {
    clearTimeout(tipTimer);
    tipTarget = null;
    PT.ui.hideTooltip();
  };

  document.addEventListener(
    'pointerover',
    (e) => {
      if (!settings.showTooltip || !PT.engine.active || e.pointerType === 'touch') return;
      // composedPath проходит и через открытые shadow roots.
      let found = null;
      let text;
      for (const el of e.composedPath()) {
        if (el === document) break;
        if (el.nodeType === Node.ELEMENT_NODE && (text = PT.engine.originalFor(el))) {
          found = el;
          break;
        }
      }
      if (found === tipTarget) return;
      hideTip();
      if (!found) return;
      tipTarget = found;
      const { clientX, clientY } = e;
      tipTimer = setTimeout(() => PT.ui.showTooltip(text, clientX, clientY), 600);
    },
    { capture: true, passive: true }
  );
  document.addEventListener('pointerdown', hideTip, { capture: true, passive: true });
  window.addEventListener('scroll', hideTip, { capture: true, passive: true });

  // ---------- Своя горячая клавиша ----------
  // Слушаем во всех фреймах: фокус может быть внутри iframe (урок Kaggle),
  // а сочетание Chrome (Alt+T) туда не всегда «долетает» без настройки.

  const isEditable = (el) =>
    el?.nodeType === Node.ELEMENT_NODE &&
    (el.isContentEditable || /^(input|textarea|select)$/i.test(el.localName));

  window.addEventListener(
    'keydown',
    (e) => {
      if (!settings.hotkey || e.repeat || e.isComposing) return;
      const combo = PT_hotkeyFromEvent(e);
      if (combo !== settings.hotkey) return;
      // В полях ввода срабатываем только на F-клавиши, чтобы не мешать набору (AltGr = Ctrl+Alt).
      if (isEditable(e.composedPath()[0]) && !PT_isFunctionKey(combo)) return;
      e.preventDefault();
      e.stopPropagation();
      PT.send({ type: 'pt:toggle' });
    },
    true
  );

  // ---------- Старт ----------

  if (init.active && !disabled) PT.engine.setActive(true);
})();
