// Popup: включение перевода на текущей вкладке, язык, провайдер, автоперевод сайта.

const $ = (id) => document.getElementById(id);

function fillSelect(select, items, value) {
  for (const [v, label] of items) select.add(new Option(label, v));
  select.value = value;
}

function setStatus(text, kind = '') {
  const el = $('status');
  el.hidden = !text;
  el.textContent = text || '';
  el.className = `status ${kind}`;
}

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const settings = { ...PT_DEFAULTS, ...(await chrome.storage.local.get(Object.keys(PT_DEFAULTS))) };

  fillSelect($('targetLang'), PT_LANGUAGES, settings.targetLang);
  fillSelect($('provider'), PT_PROVIDERS.map((p) => [p.id, p.name]), settings.provider);

  let host = '';
  try {
    const url = new URL(tab?.url || '');
    if (/^https?:$/.test(url.protocol)) host = url.hostname;
  } catch {
    /* служебная страница */
  }

  if (!host) {
    setStatus('На этой странице расширения работать не могут (служебная страница Chrome или магазин).', 'err');
    $('auto').disabled = true;
  } else {
    $('host').textContent = host;
    $('auto').checked = PT_hostMatches(host, settings.autoSites);
    $('toggle').disabled = false;
  }

  // ---- Кнопка перевода ----
  let active = false;
  const render = () => {
    $('toggle').textContent = active ? 'Показать оригинал' : 'Перевести страницу';
    $('toggle').classList.toggle('on', active);
  };
  if (host) {
    active = Boolean((await chrome.runtime.sendMessage({ type: 'pt:getTabState', tabId: tab.id }))?.active);
    render();
  }

  $('toggle').addEventListener('click', async () => {
    active = !active;
    render();
    await chrome.runtime.sendMessage({ type: 'pt:setActive', tabId: tab.id, active });
  });

  // ---- Язык и провайдер ----
  $('targetLang').addEventListener('change', (e) => chrome.storage.local.set({ targetLang: e.target.value }));
  $('provider').addEventListener('change', async (e) => {
    await chrome.storage.local.set({ provider: e.target.value });
    checkProvider();
  });

  // ---- Автоперевод сайта ----
  $('auto').addEventListener('change', async (e) => {
    const { autoSites = [] } = await chrome.storage.local.get('autoSites');
    const base = host.replace(/^www\./, '');
    const list = autoSites.filter((s) => !PT_hostMatches(host, [s]));
    if (e.target.checked) list.push(base);
    await chrome.storage.local.set({ autoSites: list });
    if (e.target.checked && !active) $('toggle').click();
  });

  // ---- Подсказка с текущими сочетаниями клавиш ----
  const cmd = (await chrome.commands.getAll()).find((c) => c.name === 'toggle-translation');
  const combos = [...new Set([cmd?.shortcut, settings.hotkey].filter(Boolean))];
  $('shortcutHint').textContent = combos.length
    ? `${combos.join(' или ')} — переключить`
    : 'Горячая клавиша — в настройках';

  $('openOptions').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  // ---- Проверка провайдера ----
  async function checkProvider() {
    if (!host && $('provider').value === 'builtin') return;
    setStatus('Проверяю провайдера…');
    const res = await chrome.runtime.sendMessage({ type: 'pt:checkProvider', tabId: host ? tab.id : undefined });
    if (res?.ok) setStatus('', '');
    else setStatus(res?.message || res?.error?.message || 'Провайдер не отвечает.', 'err');
  }
  if (host) checkProvider();
})();
