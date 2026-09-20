"""Regression checks for ordinary follow-up routing and D1 journaling."""
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class FollowupChatTests(unittest.TestCase):
    def test_fast_lane_never_recovers_into_agent_loop(self):
        source = (ROOT / "railway/accelerate_chat.py").read_text(encoding="utf-8")
        self.assertIn("MURIKAH_DUAL_LANE_CHAT_V4", source)
        self.assertIn("terminal_provider_unavailable", source)
        self.assertIn("_FAST_TURN_TIMEOUT_SECONDS", source)
        self.assertNotIn("recover_with_standard_pipeline", source)
        self.assertNotIn("fast_lane_recovery", source)
        self.assertNotIn("await prompt_pipeline.run(context, stream)", source)
        self.assertIn("nvidia_stream(", source)
        self.assertIn("Murikah is reconnecting…", source)
        self.assertNotIn("Murikah fast chat timed out before the first visible response.", source)
        self.assertNotIn("candidates[0]", source)

    def test_inherited_source_metadata_does_not_promote_followup(self):
        source = (ROOT / "railway/accelerate_chat.py").read_text(encoding="utf-8")
        self.assertNotIn('if context.source_manifest:', source)
        self.assertNotIn('if metadata.get("source_index"):', source)
        self.assertIn('"force_agentic_chat"', source)
        self.assertIn('"research_mode"', source)

    def test_user_facing_reasoning_is_murikah_branded(self):
        source = (ROOT / "railway/brand_chat_status.py").read_text(encoding="utf-8")
        self.assertIn('"{{name}} Reasoning…": "Murikah is reasoning…"', source)
        self.assertIn('"Working…": "Murikah is working…"', source)

    def test_turn_journal_is_fail_closed_before_generation(self):
        source = (ROOT / "railway/persist_learning_journal.py").read_text(encoding="utf-8")
        self.assertIn("learning_turn_start", source)
        self.assertIn("learning_turn_finish", source)
        self.assertIn("learning_turn_fail", source)
        self.assertIn("before context building or model", source)


if __name__ == "__main__":
    unittest.main()
