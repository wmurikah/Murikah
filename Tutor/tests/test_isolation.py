"""Guard Tutor's standalone build context and separation from the core apps."""
from pathlib import Path
import json
import unittest

ROOT = Path(__file__).resolve().parents[1]


class IsolationTests(unittest.TestCase):
    def test_container_inputs_are_all_inside_tutor(self):
        for line in (ROOT / 'Dockerfile.railway').read_text().splitlines():
            if not line.startswith(('COPY ', 'ADD ')) or '--from=' in line:
                continue
            for source in line.split()[1:-1]:
                with self.subTest(source=source):
                    path = (ROOT / source).resolve()
                    self.assertTrue(path.is_relative_to(ROOT))
                    self.assertTrue(path.exists())

    def test_worker_packages_have_independent_lockfiles(self):
        for package in ('cloudflare', 'wake-worker'):
            manifest = json.loads((ROOT / package / 'package.json').read_text())
            lock = json.loads((ROOT / package / 'package-lock.json').read_text())
            self.assertEqual(manifest['name'], lock['name'])
            for spec in manifest.get('dependencies', {}).values():
                self.assertFalse(spec.startswith(('file:..', 'link:', 'workspace:')))

    def test_materialization_uses_owned_brand_asset(self):
        script = (ROOT / 'scripts/materialize.sh').read_text()
        self.assertIn('$TUTOR_ROOT/assets/murikah-logo.png', script)
        self.assertNotIn('MURIKAH_ROOT', script)
        self.assertTrue((ROOT / 'assets/murikah-logo.png').is_file())
