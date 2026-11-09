"""Сборка Deep Page Translator для Firefox (в том числе Firefox для Android).

Исходники общие с Chrome-версией; отличается только manifest.json:
  - background.scripts вместо service_worker (в Firefox фоновый скрипт — event page);
  - browser_specific_settings.gecko / gecko_android;
  - убраны ключи, которые Firefox не знает (minimum_chrome_version).

Запуск:  python tools/build_firefox.py
Результат: dist/deep-page-translator-firefox-vX.Y.Z.xpi (обычный zip, пути через "/").
"""
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "page-translator"
GECKO_ID = "deep-page-translator@glagol"


def firefox_manifest() -> dict:
    m = json.loads((SRC / "manifest.json").read_text(encoding="utf-8"))
    m.pop("minimum_chrome_version", None)
    m["background"] = {"scripts": ["background/service-worker.js"], "type": "module"}
    m["browser_specific_settings"] = {
        "gecko": {
            "id": GECKO_ID,
            "strict_min_version": "140.0",
            # Тексты страниц уходят выбранному провайдеру перевода.
            "data_collection_permissions": {"required": ["websiteContent"]},
        },
        "gecko_android": {"strict_min_version": "142.0"},
    }
    return m


def main() -> Path:
    manifest = firefox_manifest()
    out = ROOT / "dist" / f"deep-page-translator-firefox-v{manifest['version']}.xpi"
    out.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(SRC.rglob("*")):
            if f.is_file() and f.name != "manifest.json":
                z.write(f, f.relative_to(SRC).as_posix())
        z.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
    print(out)
    return out


if __name__ == "__main__":
    main()
