"""Проверки сборки для Firefox: python -m unittest discover -s tests -p "test_*.py" """
import json
import sys
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import build_firefox  # noqa: E402


class FirefoxManifest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.src = json.loads((ROOT / "page-translator" / "manifest.json").read_text(encoding="utf-8"))
        cls.ff = build_firefox.firefox_manifest()

    def test_background_is_event_page(self):
        self.assertEqual(self.ff["background"]["scripts"], ["background/service-worker.js"])
        self.assertNotIn("service_worker", self.ff["background"])

    def test_gecko_settings(self):
        g = self.ff["browser_specific_settings"]["gecko"]
        self.assertRegex(g["id"], r"^[^@\s]+@[^@\s]+$")
        self.assertIn("data_collection_permissions", g)
        self.assertIn("gecko_android", self.ff["browser_specific_settings"])

    def test_chrome_only_keys_removed(self):
        self.assertNotIn("minimum_chrome_version", self.ff)

    def test_everything_else_matches_chrome_manifest(self):
        skip = {"background", "browser_specific_settings", "minimum_chrome_version"}
        for k, v in self.src.items():
            if k not in skip:
                self.assertEqual(self.ff[k], v, k)

    def test_source_manifest_unchanged_for_chrome(self):
        self.assertIn("service_worker", self.src["background"])
        self.assertIn("minimum_chrome_version", self.src)


class XpiPackage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.path = build_firefox.main()
        cls.zip = zipfile.ZipFile(cls.path)

    def test_name_has_version(self):
        self.assertIn(f"v{build_firefox.firefox_manifest()['version']}", self.path.name)
        self.assertEqual(self.path.suffix, ".xpi")

    def test_zip_is_valid_and_paths_use_forward_slashes(self):
        self.assertIsNone(self.zip.testzip())
        for n in self.zip.namelist():
            self.assertNotIn("\\", n)

    def test_manifest_in_root_and_is_firefox_flavoured(self):
        m = json.loads(self.zip.read("manifest.json"))
        self.assertIn("scripts", m["background"])

    def test_every_file_referenced_by_manifest_is_packaged(self):
        m = json.loads(self.zip.read("manifest.json"))
        names = set(self.zip.namelist())
        refs = set(m["background"]["scripts"])
        for cs in m["content_scripts"]:
            refs.update(cs["js"])
        refs.add(m["action"]["default_popup"])
        refs.add(m["options_page"])
        refs.update(m["icons"].values())
        for r in refs:
            self.assertIn(r, names, r)

    def test_all_sources_packaged_exactly_once(self):
        src_dir = ROOT / "page-translator"
        src_files = {p.relative_to(src_dir).as_posix() for p in src_dir.rglob("*") if p.is_file()}
        names = self.zip.namelist()
        self.assertEqual(len(names), len(set(names)))
        self.assertEqual(set(names), src_files)


if __name__ == "__main__":
    unittest.main()
