// Общие константы: подключается в content scripts, popup, options
// и импортируется (как модуль с побочным эффектом) в service worker.
// Пишем в globalThis, чтобы один файл работал во всех контекстах без сборщика.

globalThis.PT_DEFAULTS = Object.freeze({
  targetLang: 'ru',
  provider: 'google', // google | builtin | deepl | libre
  deeplKey: '',
  libreUrl: '',
  libreKey: '',
  autoSites: [], // хосты, где перевод включается автоматически
  excludedSites: [], // хосты, где расширение ничего не делает
  showTooltip: true, // подсказка с оригиналом при наведении
});

globalThis.PT_PROVIDERS = Object.freeze([
  { id: 'google', name: 'Google Translate (без ключа)' },
  { id: 'builtin', name: 'Встроенный в Chrome (on-device, 138+)' },
  { id: 'deepl', name: 'DeepL API (нужен ключ)' },
  { id: 'libre', name: 'LibreTranslate (свой сервер)' },
]);

// Коды в формате Google; провайдеры сами приводят их к своему виду.
globalThis.PT_LANGUAGES = Object.freeze([
  ['ru', 'Русский'],
  ['en', 'English'],
  ['uk', 'Українська'],
  ['be', 'Беларуская'],
  ['kk', 'Қазақ'],
  ['de', 'Deutsch'],
  ['fr', 'Français'],
  ['es', 'Español'],
  ['it', 'Italiano'],
  ['pt', 'Português'],
  ['pl', 'Polski'],
  ['tr', 'Türkçe'],
  ['ja', '日本語'],
  ['ko', '한국어'],
  ['zh-CN', '中文 (简体)'],
  ['zh-TW', '中文 (繁體)'],
  ['ar', 'العربية'],
]);

// Совпадение хоста со списком: "kaggle.com" покрывает "www.kaggle.com".
globalThis.PT_hostMatches = function (host, list) {
  if (!host || !Array.isArray(list)) return false;
  host = host.toLowerCase();
  return list.some((entry) => {
    const e = String(entry).trim().toLowerCase().replace(/^\*\./, '');
    return e && (host === e || host.endsWith('.' + e));
  });
};
