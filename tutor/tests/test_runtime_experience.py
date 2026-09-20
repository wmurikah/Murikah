"""Regression checks for member-session, scroll, solve, and Math Animator hardening."""
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class RuntimeExperienceTests(unittest.TestCase):
    def test_member_sessions_are_long_lived_and_sliding(self):
        bootstrap = (ROOT / "railway/bootstrap_runtime.py").read_text(encoding="utf-8")
        access = (ROOT / "railway/murikah_access.py").read_text(encoding="utf-8")
        overlay = (ROOT / "railway/harden_member_runtime.py").read_text(encoding="utf-8")
        self.assertIn('MURIKAH_TUTOR_TOKEN_EXPIRE_HOURS", "9600"', bootstrap)
        self.assertIn("Sliding member auth", overlay)
        self.assertIn("response.set_cookie(", overlay)
        self.assertIn('not str(payload.username).startswith("guest_")', overlay)
        self.assertIn("TOKEN_EXPIRE_HOURS", access)

    def test_google_is_first_social_provider_when_configured(self):
        social = (ROOT / "railway/MurikahSocialButtons.tsx.txt").read_text(encoding="utf-8")
        oauth = (ROOT / "railway/murikah_oauth.py").read_text(encoding="utf-8")
        self.assertIn("google: 0", social)
        self.assertIn("Continue with {provider.label}", social)
        self.assertIn("MURIKAH_GOOGLE_CLIENT_ID", oauth)
        self.assertIn("MURIKAH_GOOGLE_CLIENT_SECRET", oauth)

    def test_deep_solve_has_hidden_final_repair(self):
        overlay = (ROOT / "railway/harden_member_runtime.py").read_text(encoding="utf-8")
        self.assertIn("_murikah_solve_repair_attempted", overlay)
        self.assertIn("solve_final_repair", overlay)
        self.assertIn("Finishing the solution", overlay)
        self.assertIn("tool_schemas=None", overlay)

    def test_scroll_release_and_diagram_scroll_owner_are_pinned(self):
        overlay = (ROOT / "railway/harden_member_runtime.py").read_text(encoding="utf-8")
        self.assertIn('pathname === "/diagram-design"', overlay)
        self.assertIn("lastObservedScrollTopRef", overlay)
        self.assertIn("current < previous - 1", overlay)
        self.assertIn("overscroll-y-contain touch-pan-y", overlay)

    def test_math_animator_is_a_built_image_contract(self):
        dockerfile = (ROOT.parent / "Dockerfile.railway").read_text(encoding="utf-8")
        self.assertIn('"manim>=0.19.0,<0.20"', dockerfile)
        self.assertIn("texlive-latex-base", dockerfile)
        self.assertIn("dvisvgm", dockerfile)
        self.assertIn("assert shutil.which('ffmpeg')", dockerfile)


if __name__ == "__main__":
    unittest.main()
