# Deep Page Translator для Firefox (в том числе Android)

Chrome на телефоне расширения не поддерживает, поэтому для Android (например, Samsung Galaxy S25)
есть сборка под **Firefox**. Исходный код общий с Chrome-версией ([`page-translator/`](../page-translator));
отличается только `manifest.json`, который собирает скрипт [`tools/build_firefox.py`](../tools/build_firefox.py):

| Chrome | Firefox |
|---|---|
| `background.service_worker` | `background.scripts` (event page) |
| `minimum_chrome_version` | `browser_specific_settings.gecko` (`id`, `strict_min_version`, `data_collection_permissions`) и `gecko_android` |

## Сборка

```bash
python tools/build_firefox.py
```

Результат: `dist/deep-page-translator-firefox-vX.Y.Z.xpi` (обычный zip, пути через `/`).
Проверить пакет линтером Mozilla: распаковать `.xpi` и выполнить `npx web-ext lint -s <папка>`.

## Установка на Android

Обычный Firefox не ставит неподписанные расширения. Два способа:

1. **Подпись через AMO (удобнее).** На [addons.mozilla.org/developers](https://addons.mozilla.org/developers/)
   загрузите `.xpi` как **«On your own» (unlisted)**: Mozilla подпишет его автоматически за несколько минут.
   Скачайте подписанный `.xpi`, перекиньте на телефон, откройте в Firefox и подтвердите установку.
2. **Firefox Nightly.** В нём можно использовать собственную коллекцию расширений
   (Настройки → «О Firefox Nightly» → 5 раз тапнуть по логотипу → «Custom Add-on collection»)
   или ставить расширение по USB через `about:debugging` с компьютера.

Использование: откройте сайт → меню Firefox (⋮) → **Расширения** → *Deep Page Translator* → «Перевести страницу».
Включить «Автоматически переводить на этом сайте» можно там же.

## Установка в Firefox для компьютера

`about:debugging#/runtime/this-firefox` → «Загрузить временное дополнение» → выберите `manifest.json`
из папки `page-translator` (временно, до перезапуска) или подписанный `.xpi` через `about:addons`.

## Что работает

Работает так же, как в Chrome: Google, DeepL и LibreTranslate, cross-origin iframe, Shadow DOM,
динамический контент, комментарии в коде и вывод ячеек Jupyter, кеш, автоперевод сайтов.

Недоступно на Android (в API расширений Firefox для Android этого нет):

- горячие клавиши (`commands`);
- «Перевести выделенное» (контекстное меню);
- подсказка с оригиналом при наведении (нет курсора).

Во всём Firefox нет провайдера «Встроенный в Chrome» (Translator API есть только в Chrome 138+ на компьютере),
он скрыт в списке.

Минимальные версии: Firefox 140 на компьютере, Firefox 142 для Android.

## Тесты

```bash
npm test
```

Манифест и пакет `.xpi` проверяет `tests/test_build_firefox.py`, фоновый скрипт без `commands` и
`contextMenus` (как на Android) — `tests/service-worker.test.mjs`.
Вручную на телефоне стоит проверить: popup открывается и помещается на экран, перевод включается и
выключается, перевод страницы с iframe (например, урок Kaggle).
