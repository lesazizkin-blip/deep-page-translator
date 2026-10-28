// Страница настроек: ключи API, списки сайтов, подсказка, кеш.

const $ = (id) => document.getElementById(id);

const parseList = (text) =>
  [...new Set(text.split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];

async function load() {
  const s = { ...PT_DEFAULTS, ...(await chrome.storage.local.get(Object.keys(PT_DEFAULTS))) };
  for (const [v, label] of PT_LANGUAGES) $('targetLang').add(new Option(label, v));
  for (const p of PT_PROVIDERS) $('provider').add(new Option(p.name, p.id));
  $('targetLang').value = s.targetLang;
  $('provider').value = s.provider;
  $('deeplKey').value = s.deeplKey;
  $('libreUrl').value = s.libreUrl;
  $('libreKey').value = s.libreKey;
  $('autoSites').value = s.autoSites.join('\n');
  $('excludedSites').value = s.excludedSites.join('\n');
  $('showTooltip').checked = s.showTooltip;
  refreshCacheStats();
}

async function save() {
  const libreUrl = $('libreUrl').value.trim().replace(/\/+$/, '');
  if (libreUrl && !/^https?:\/\//i.test(libreUrl)) {
    flash('URL LibreTranslate должен начинаться с http:// или https://', 'err');
    return false;
  }
  await chrome.storage.local.set({
    targetLang: $('targetLang').value,
    provider: $('provider').value,
    deeplKey: $('deeplKey').value.trim(),
    libreUrl,
    libreKey: $('libreKey').value.trim(),
    autoSites: parseList($('autoSites').value),
    excludedSites: parseList($('excludedSites').value),
    showTooltip: $('showTooltip').checked,
  });
  flash('Сохранено', 'ok');
  return true;
}

function flash(text, kind) {
  $('saved').textContent = text;
  $('saved').className = `note ${kind}`;
  clearTimeout(flash.t);
  flash.t = setTimeout(() => ($('saved').textContent = ''), 3000);
}

async function refreshCacheStats() {
  const st = await chrome.runtime.sendMessage({ type: 'pt:cacheStats' });
  if (!st || st.error) return;
  const kb = Math.round(st.chars / 1024);
  $('cacheStats').textContent =
    `Записей: ${st.entries} из ${st.maxEntries}, объём переводов ≈ ${kb} тыс. символов. ` +
    'Старые записи вытесняются автоматически (LRU).';
}

$('save').addEventListener('click', save);

$('check').addEventListener('click', async () => {
  if (!(await save())) return;
  $('checkResult').textContent = 'Проверяю…';
  $('checkResult').className = 'note';
  const res = await chrome.runtime.sendMessage({ type: 'pt:checkProvider' });
  $('checkResult').textContent = res?.message || res?.error?.message || 'Нет ответа';
  $('checkResult').className = `note ${res?.ok ? 'ok' : 'err'}`;
});

$('clearCache').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'pt:clearCache' });
  refreshCacheStats();
  flash('Кеш очищен', 'ok');
});

$('shortcuts').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

load();
