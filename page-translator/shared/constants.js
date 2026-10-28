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
  hotkey: '', // своё сочетание клавиш на странице, например "Ctrl+Shift+Y" или "F2"
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

// Сочетание клавиш из события в виде "Ctrl+Shift+Y".
// Берём физическую клавишу (e.code), а не символ (e.key), чтобы сочетание
// одинаково работало в русской и английской раскладке.
globalThis.PT_hotkeyFromEvent = function (e) {
  const code = e.code || '';
  if (!code || /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/.test(code)) return '';
  const names = {
    Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  };
  const key = names[code] || code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num');
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Meta');
  parts.push(key);
  return parts.join('+');
};

// Без Ctrl/Alt/Meta сочетание мешало бы набору текста; исключение — F1–F12.
globalThis.PT_isFunctionKey = (combo) => /(^|\+)F([1-9]|1[0-2])$/.test(combo);
globalThis.PT_hotkeyValid = (combo) => /(^|\+)(Ctrl|Alt|Meta)\+/.test(combo) || PT_isFunctionKey(combo);

// Совпадение хоста со списком: "kaggle.com" покрывает "www.kaggle.com".
globalThis.PT_hostMatches = function (host, list) {
  if (!host || !Array.isArray(list)) return false;
  host = host.toLowerCase();
  return list.some((entry) => {
    const e = String(entry).trim().toLowerCase().replace(/^\*\./, '');
    return e && (host === e || host.endsWith('.' + e));
  });
};
