"""Behavioral tests for Murikah Tutor em-dash elimination."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
VISIBLE = ROOT / "railway" / "murikah_visible_text.py"
if not VISIBLE.exists():
    VISIBLE = Path("/app/deeptutor/murikah_visible_text.py")

spec = importlib.util.spec_from_file_location("muri_visible", VISIBLE)
visible = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(visible)


def source(relative: str) -> str:
    path = ROOT / relative
    return path.read_text(encoding="utf-8") if path.exists() else ""


class TutorVisibleTextTests(unittest.TestCase):
    def test_plain_em_dash_and_entities_are_removed(self):
        dash = chr(0x2014)
        values = (
            f"Hello {dash} what are you learning?",
            f"A {dash} B {dash} C",
            "Hello &mdash; world",
            "Hello &#8212; world",
            "Hello &#x2014; world",
        )
        for value in values:
            with self.subTest(value=value):
                result = visible.sanitize_murikah_visible_text(value)
                self.assertNotIn(dash, result)
                self.assertNotIn("&mdash;", result.lower())
                self.assertNotIn("&#8212;", result.lower())
                self.assertNotIn("&#x2014;", result.lower())

    def test_hyphen_and_en_dash_are_preserved(self):
        value = "well-being and 2025–2026"
        self.assertEqual(visible.sanitize_murikah_visible_text(value), value)

    def test_code_and_urls_remain_structurally_safe(self):
        dash = chr(0x2014)
        tick = chr(96)
        result = visible.sanitize_murikah_visible_text(
            "Use " + tick + "a " + dash + " b" + tick
            + " and https://example.com/a" + dash + "b outside."
        )
        self.assertNotIn(dash, result)
        self.assertIn("\\u2014", result)
        self.assertIn("%E2%80%94", result)
        self.assertIn(tick, result)
        self.assertIn("https://example.com/", result)

    def test_style_instruction_is_small_and_explicit(self):
        self.assertEqual(
            visible.MURIKAH_VISIBLE_STYLE_RULE,
            "Do not use em dashes. Use commas, periods, colons or semicolons instead.",
        )

    def test_overlay_sanitizes_stream_before_emit_and_final_persistence(self):
        overlay = source("railway/apply_tutor_personalization.py")
        if not overlay:
            return
        self.assertIn("event.content = sanitize_murikah_visible_text(event.content)", overlay)
        self.assertIn('"response": sanitize_murikah_visible_text(response)', overlay)
        self.assertIn("return sanitize_murikah_visible_text(", overlay)
        self.assertIn("yield sanitize_murikah_visible_text(first_chunk)", overlay)
        self.assertIn("yield sanitize_murikah_visible_text(text)", overlay)

    def test_overlay_does_not_rewrite_user_input(self):
        overlay = source("railway/apply_tutor_personalization.py")
        if not overlay:
            return
        self.assertNotIn("raw_user_content = sanitize_murikah_visible_text", overlay)
        self.assertNotIn("user_message = sanitize_murikah_visible_text", overlay)

    def test_runtime_ui_validator_reports_exact_file_and_line(self):
        overlay_path = ROOT / "railway" / "apply_tutor_personalization.py"
        if not overlay_path.exists():
            return
        overlay_spec = importlib.util.spec_from_file_location("muri_overlay", overlay_path)
        module = importlib.util.module_from_spec(overlay_spec)
        assert overlay_spec.loader is not None
        overlay_spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            target = root / "web/components/Bad.tsx"
            target.parent.mkdir(parents=True)
            target.write_text("export const label = 'Bad " + chr(0x2014) + " copy';\n", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, r"web/components/Bad\.tsx:1"):
                module.validate_no_em_dash_in_runtime_ui(root)


if __name__ == "__main__":
    unittest.main()
