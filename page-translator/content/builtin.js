// Встроенный Translator API Chrome (138+). Работает только в главном фрейме:
// background пересылает сюда тексты из всех фреймов вкладки.
// Документация: https://developer.chrome.com/docs/ai/translator-api

PT.builtin = (() => {
  const translators = new Map(); // "en>ru" -> Translator
  let detector = null;
  let pendingPair = null; // пара языков, для которой нужна загрузка модели по клику

  // Google-коды → BCP 47 для Translator API.
  const toBcp47 = (code) => ({ 'zh-CN': 'zh', 'zh-TW': 'zh-Hant' })[code] || code;

  function fail(message, code) {
    const e = new Error(message);
    e.code = code;
    throw e;
  }

  function ensureApi() {
    if (typeof self.Translator === 'undefined') {
      fail(
        'Встроенный Translator API недоступен: нужен Chrome 138+ на компьютере (Windows/macOS/Linux) ' +
          'с поддержкой on-device моделей. Выберите другого провайдера.',
        'unavailable'
      );
    }
  }

  /** Определяем язык источника; без LanguageDetector считаем, что это английский. */
  async function detectSource(sample) {
    try {
      if (typeof self.LanguageDetector === 'undefined') return 'en';
      if (!detector) {
        const av = await LanguageDetector.availability();
        if (av !== 'available') return 'en';
        detector = await LanguageDetector.create();
      }
      const [best] = await detector.detect(sample);
      return best && best.confidence > 0.4 && best.detectedLanguage !== 'und' ? best.detectedLanguage : 'en';
    } catch {
      return 'en';
    }
  }

  async function getTranslator(sourceLanguage, targetLanguage) {
    const key = `${sourceLanguage}>${targetLanguage}`;
    if (translators.has(key)) return translators.get(key);

    const av = await Translator.availability({ sourceLanguage, targetLanguage });
    if (av === 'unavailable') {
      fail(`Встроенный переводчик не поддерживает пару ${sourceLanguage} → ${targetLanguage}.`, 'unsupported');
    }
    if (av !== 'available' && !navigator.userActivation?.isActive) {
      // Скачивание модели требует жеста пользователя на странице.
      pendingPair = { sourceLanguage, targetLanguage };
      PT.ui?.showModelPrompt();
      fail(
        'Встроенному переводчику нужно скачать языковую модель. Нажмите «Загрузить модель» в индикаторе на странице.',
        'needs-activation'
      );
    }
    const t = await create(sourceLanguage, targetLanguage);
    translators.set(key, t);
    return t;
  }

  function create(sourceLanguage, targetLanguage) {
    return Translator.create({
      sourceLanguage,
      targetLanguage,
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          PT.ui?.showStatus(`Загрузка модели перевода… ${Math.round(e.loaded * 100)}%`);
        });
      },
    });
  }

  /** Перевод массива HTML-строк без тегов (сущности раскодируем и кодируем обратно). */
  async function translate(htmls, target) {
    ensureApi();
    const texts = htmls.map(PT.decodeHtml);
    const targetLanguage = toBcp47(target);
    const source = await detectSource(texts.join('\n').slice(0, 1500));
    if (source.split('-')[0] === targetLanguage.split('-')[0]) return htmls; // уже на нужном языке
    const translator = await getTranslator(source, targetLanguage);
    const out = [];
    for (const t of texts) out.push(PT.escapeHtml(await translator.translate(t)));
    return out;
  }

  /** Вызывается из обработчика клика (есть жест пользователя). */
  async function prepareFromClick() {
    if (!pendingPair) return;
    const { sourceLanguage, targetLanguage } = pendingPair;
    try {
      const t = await create(sourceLanguage, targetLanguage);
      translators.set(`${sourceLanguage}>${targetLanguage}`, t);
      pendingPair = null;
      PT.ui?.showStatus('Модель загружена, продолжаю перевод…');
      PT.send({ type: 'pt:retryAll' });
    } catch (e) {
      PT.ui?.showError(`Не удалось загрузить модель: ${e.message}`);
    }
  }

  async function check(target) {
    try {
      ensureApi();
      const av = await Translator.availability({ sourceLanguage: 'en', targetLanguage: toBcp47(target) });
      const text = {
        available: 'модель en → ' + target + ' загружена и готова',
        downloadable: 'модель доступна, будет скачана при первом переводе',
        downloading: 'модель скачивается',
        unavailable: 'пара языков не поддерживается',
      }[av] || av;
      return { ok: av !== 'unavailable', message: `Встроенный переводчик: ${text}.` };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  }

  return { translate, check, prepareFromClick };
})();
