import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { load, SRC } from './helpers.mjs';

await load('shared/constants.js');

test('PT_hostMatches: домен покрывает поддомены, но не похожие хосты', () => {
  assert.equal(PT_hostMatches('www.kaggle.com', ['kaggle.com']), true);
  assert.equal(PT_hostMatches('kaggle.com', ['*.kaggle.com']), true);
  assert.equal(PT_hostMatches('notkaggle.com', ['kaggle.com']), false);
  assert.equal(PT_hostMatches('', ['kaggle.com']), false);
  assert.equal(PT_hostMatches('a.com', undefined), false);
  assert.equal(PT_hostMatches('A.COM', [' A.com ']), true);
});

test('PT_hotkeyFromEvent: физическая клавиша, модификаторы по порядку', () => {
  const ev = (o) => ({ code: '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...o });
  assert.equal(PT_hotkeyFromEvent(ev({ code: 'KeyY', ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+Y');
  assert.equal(PT_hotkeyFromEvent(ev({ code: 'Digit5', altKey: true })), 'Alt+5');
  assert.equal(PT_hotkeyFromEvent(ev({ code: 'Slash', metaKey: true })), 'Meta+/');
  assert.equal(PT_hotkeyFromEvent(ev({ code: 'F2' })), 'F2');
  assert.equal(PT_hotkeyFromEvent(ev({ code: 'ControlLeft', ctrlKey: true })), '', 'только модификатор');
  assert.equal(PT_hotkeyFromEvent(ev({})), '');
});

test('PT_hotkeyValid / PT_isFunctionKey', () => {
  assert.equal(PT_hotkeyValid('Ctrl+Y'), true);
  assert.equal(PT_hotkeyValid('Alt+T'), true);
  assert.equal(PT_hotkeyValid('F12'), true);
  assert.equal(PT_hotkeyValid('Shift+Y'), false);
  assert.equal(PT_hotkeyValid('Y'), false);
  assert.equal(PT_isFunctionKey('Ctrl+F5'), true);
  assert.equal(PT_isFunctionKey('F13'), false);
});

test('PT_DEFAULTS заморожен, язык по умолчанию — русский, провайдер — google', () => {
  assert.equal(Object.isFrozen(PT_DEFAULTS), true);
  assert.equal(PT_DEFAULTS.targetLang, 'ru');
  assert.equal(PT_DEFAULTS.provider, 'google');
});

// Каждый случай — в отдельном процессе Node: повторная загрузка того же модуля
// с другим navigator в одном процессе не пересчитывает значения.
function providersFor(userAgent) {
  const file = pathToFileURL(path.join(SRC, 'shared/constants.js')).href;
  const code =
    `Object.defineProperty(globalThis, 'navigator', { value: { userAgent: ${JSON.stringify(userAgent)} }, configurable: true });` +
    `await import(${JSON.stringify(file)});` +
    `console.log(JSON.stringify({ firefox: PT_IS_FIREFOX, ids: PT_PROVIDERS.map((p) => p.id) }));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('Провайдер «builtin» есть в Chrome и скрыт в Firefox', () => {
  const chrome = providersFor('Mozilla/5.0 (Linux; Android 15) Chrome/140.0 Mobile Safari/537.36');
  assert.equal(chrome.firefox, false);
  assert.deepEqual(chrome.ids, ['google', 'builtin', 'deepl', 'libre']);

  const ff = providersFor('Mozilla/5.0 (Android 15; Mobile; rv:142.0) Gecko/142.0 Firefox/142.0');
  assert.equal(ff.firefox, true);
  assert.deepEqual(ff.ids, ['google', 'deepl', 'libre']);
});
