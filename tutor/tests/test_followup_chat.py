"""Regression checks for ordinary follow-up routing and D1 journaling."""
import ast
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


def assigned_string(source: str, name: str) -> str:
    """Return a top-level string constant assigned to *name* in an overlay script."""
    tree = ast.parse(source)
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        if not any(isinstance(target, ast.Name) and target.id == name for target in node.targets):
            continue
        value = ast.literal_eval(node.value)
        if isinstance(value, str):
            return value
    raise AssertionError(f"{name} string assignment not found")


class FollowupChatTests(unittest.TestCase):
    def test_fast_lane_never_recovers_into_agent_loop(self):
        source = (ROOT / "railway/accelerate_chat.py").read_text(encoding="utf-8")
        self.assertIn("MURIKAH_DUAL_LANE_CHAT_V7", source)
        self.assertIn("terminal_first_token_timeout", source)
        self.assertIn("_FAST_TURN_TIMEOUT_SECONDS", source)
        self.assertIn("MURIKAH_CHAT_FAST_OUTPUT_TOKENS", source)
        self.assertIn("MURIKAH_CHAT_MAX_CONTINUATIONS", source)
        self.assertIn("Continuing response…", source)
        self.assertIn("finish_reason_needs_continuation", source)
        self.assertIn("continuation_messages", source)
        self.assertIn("partial_response_preserved", source)
        self.assertIn("nvidia-fast:", source)
        self.assertIn("qwen-fast:", source)
        self.assertIn("context_packet_for_turn", source)
        self.assertIn("schedule_next_context", source)
        self.assertIn("provider_affinity", source)
        self.assertIn("MURIKAH_CHAT_CONTEXT_CHARS", source)
        self.assertIn("1800", source)
        self.assertIn("10.0", source)
        self.assertIn("15.0", source)
        self.assertIn("45.0", source)
        self.assertIn('min(\n    1, _positive_int("MURIKAH_CHAT_MAX_CONTINUATIONS", 1)', source)
        self.assertIn("publish=True", source)
        self.assertIn("turn_deadline = request_started + _FAST_TURN_TIMEOUT_SECONDS", source)
        self.assertIn("selected_lane=fast", source)
        self.assertIn("selected_lane=deep_agent", source)
        self.assertNotIn("recover_with_standard_pipeline", source)
        self.assertNotIn("fast_lane_recovery", source)
        # accelerate_chat.py is an overlay and deliberately contains OLD_RUN as
        # well as NEW_RUN. Validate only the replacement runtime body; counting
        # strings across the whole overlay also counts the legacy source fixture.
        new_run = assigned_string(source, "NEW_RUN")
        self.assertNotIn("await prompt_pipeline.run(context, stream)", new_run)
        self.assertEqual(new_run.count("await pipeline.run(context, stream)"), 1)

    def test_inherited_source_metadata_does_not_promote_followup(self):
        source = (ROOT / "railway/accelerate_chat.py").read_text(encoding="utf-8")
        self.assertNotIn('if context.source_manifest:', source)
        self.assertNotIn('if metadata.get("source_index"):', source)
        self.assertNotIn('if metadata.get("force_agentic_chat"):', source)
        self.assertIn('"murikah_current_turn_flags"', source)
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
