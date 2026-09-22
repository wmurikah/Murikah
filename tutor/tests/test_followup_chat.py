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
    def test_fast_lane_has_bounded_followup_sla_and_never_recovers_into_agent_loop(self):
        source = (ROOT / "railway/accelerate_chat.py").read_text(encoding="utf-8")
        self.assertIn("MURIKAH_FOLLOWUP_FAST_PATH_V2", source)
        self.assertIn("build_fast_context_window", source)
        self.assertIn("terminal_first_token_timeout", source)
        self.assertIn("_OVERALL_FIRST_TOKEN_SECONDS", source)
        self.assertIn("MURIKAH_CHAT_STREAM_IDLE_TIMEOUT_SECONDS", source)
        self.assertIn("MURIKAH_CHAT_FAST_TURN_TIMEOUT_SECONDS", source)
        self.assertIn("MURIKAH_CHAT_FAST_OUTPUT_TOKENS", source)
        self.assertIn("MURIKAH_CHAT_LONG_OUTPUT_TOKENS", source)
        self.assertIn("MURIKAH_CHAT_MAX_CONTINUATIONS", source)
        self.assertIn("Continuing response…", source)
        self.assertIn("finish_reason_needs_continuation", source)
        self.assertIn("continuation_messages", source)
        self.assertIn("terminal_incomplete_response", source)
        self.assertIn("The response was interrupted.", source)
        self.assertIn("nvidia-fast:", source)
        self.assertIn("qwen-fast:", source)
        self.assertIn("_PROVIDER_HEDGE_DELAYS = (0.0, 0.4, 0.8)", source)
        self.assertNotIn("retry_hedges", source)
        self.assertNotIn("gemini-retry:", source)
        self.assertNotIn("nvidia-retry:", source)
        self.assertNotIn("qwen-retry:", source)
        self.assertNotIn("recover_with_standard_pipeline", source)
        self.assertNotIn("fast_lane_recovery", source)
        # accelerate_chat.py is an overlay and deliberately contains OLD_RUN as
        # well as NEW_RUN. Validate only the replacement runtime body.
        new_run = assigned_string(source, "NEW_RUN")
        self.assertNotIn("await prompt_pipeline.run(context, stream)", new_run)
        self.assertEqual(new_run.count("await pipeline.run(context, stream)"), 1)

    def test_inherited_metadata_cannot_promote_followup(self):
        source = (ROOT / "railway/accelerate_chat.py").read_text(encoding="utf-8")
        self.assertNotIn('if context.source_manifest:', source)
        self.assertNotIn('if metadata.get("source_index"):', source)
        self.assertIn('current = metadata.get("murikah_current_turn")', source)
        self.assertIn('"force_agentic_chat"', source)
        self.assertIn('"research_mode"', source)
        self.assertNotIn('if metadata.get(key):', source)

    def test_user_facing_reasoning_is_murikah_branded(self):
        source = (ROOT / "railway/brand_chat_status.py").read_text(encoding="utf-8")
        self.assertIn('"{{name}} Reasoning…": "Murikah is reasoning…"', source)
        self.assertIn('"Working…": "Murikah is working…"', source)

    def test_turn_journal_is_fail_closed_and_carries_followup_packet_metrics(self):
        source = (ROOT / "railway/persist_learning_journal.py").read_text(encoding="utf-8")
        self.assertIn("learning_turn_start", source)
        self.assertIn("_murikah_turn_start = await asyncio.to_thread", source)
        self.assertIn('"murikah_context_packet"', source)
        self.assertIn('"murikah_current_turn"', source)
        self.assertIn("learning_turn_finish", source)
        self.assertIn("history_chars=int(context.metadata.get", source)
        self.assertIn("context_packet_chars=int(context.metadata.get", source)
        self.assertIn("stream_idle_timeout_ms=int(context.metadata.get", source)
        self.assertIn("continuation_count=int(context.metadata.get", source)
        self.assertIn("learning_turn_fail", source)
        self.assertIn("before context building or model", source)


if __name__ == "__main__":
    unittest.main()
