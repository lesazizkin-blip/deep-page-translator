// Общее пространство имён для content scripts.
// Все файлы из manifest.json выполняются в одном изолированном мире фрейма
// по порядку, поэтому делят объект PT. Странице он не виден.

var PT = (globalThis.PT = globalThis.PT || {});

PT.isTop = window === window.top;

/** Безопасная отправка сообщения в background (контекст мог стать недействительным
 *  после перезагрузки расширения — тогда тихо возвращаем null). */
PT.send = async function (msg) {
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch {
    return null;
  }
};

PT.escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// DOMParser создаёт инертный документ: скрипты не выполняются, ресурсы не грузятся.
const ptParser = new DOMParser();
PT.parseHtml = (html) => ptParser.parseFromString(`<body>${html}</body>`, 'text/html').body;
PT.decodeHtml = (html) => PT.parseHtml(html).textContent;

PT.debounce = function (fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};
