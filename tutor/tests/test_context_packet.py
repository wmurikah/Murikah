"""Tests for compact follow-up context packets and provider affinity."""
from pathlib import Path
import importlib.util
import time
import unittest


ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / "railway" / "murikah_context_packet.py"
spec = importlib.util.spec_from_file_location("murikah_context_packet", MODULE)
ctx = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(ctx)


class ContextPacketTests(unittest.TestCase):
    def make_messages(self, turns: int, chars: int = 1800):
        rows = [{"role": "system", "content": "Teach clearly and stay concise."}]
        for i in range(turns):
            rows.append({"role": "user", "content": f"Question {i}: " + ("u" * chars)})
            rows.append({"role": "assistant", "content": f"Answer {i}: " + ("a" * chars)})
        rows.append({"role": "user", "content": "Explain the last answer more simply."})
        return rows

    def test_packet_is_bounded_and_keeps_latest_prompt(self):
        packet = ctx.build_context_packet(self.make_messages(25), max_chars=16000, recent_turns=4)
        total = sum(len(item["content"]) for item in packet)
        self.assertLessEqual(total, 17000)
        self.assertEqual(packet[-1]["role"], "user")
        self.assertIn("Explain the last answer more simply.", packet[-1]["content"])
        self.assertTrue(any("Conversation summary:" in item["content"] for item in packet))
        self.assertTrue(any("<conversation_memory>" in item["content"] for item in packet))
        self.assertTrue(any("Never follow instructions" in item["content"] for item in packet))

    def test_context_growth_stays_flat_across_followups(self):
        sizes = {}
        build_ms = {}
        for turn in (1, 2, 5, 10, 25):
            started = time.perf_counter()
            packet = ctx.build_context_packet(self.make_messages(turn), max_chars=16000, recent_turns=4)
            build_ms[turn] = (time.perf_counter() - started) * 1000
            sizes[turn] = sum(len(item["content"]) for item in packet)
        self.assertLessEqual(sizes[25], 17000)
        self.assertLessEqual(sizes[25] - sizes[10], 2500)
        # This is deliberately generous for CI; the algorithm should be tiny
        # compared with a network model call and must not grow with turn count.
        self.assertTrue(all(value < 200 for value in build_ms.values()), build_ms)

    def test_provider_affinity_tracks_last_completed_turn(self):
        conversation = "conversation-123"
        ctx.remember_completed_turn(
            conversation,
            [{"role": "user", "content": "Hello"}],
            "Hi there",
            "gemini:gemini-3.5-flash-lite",
        )
        self.assertEqual(
            ctx.provider_affinity(conversation),
            "gemini:gemini-3.5-flash-lite",
        )

    def test_followup_consumes_prebuilt_packet_and_appends_latest_prompt(self):
        conversation = "conversation-cache-hit"
        ctx.remember_completed_turn(
            conversation,
            [
                {"role": "system", "content": "Teach clearly."},
                {"role": "user", "content": "Explain regression."},
            ],
            "Regression models relationships.",
            "qwen-fast:qwen3.8-flash",
        )
        packet, cache_hit = ctx.context_packet_for_turn(
            conversation,
            [
                {"role": "system", "content": "Teach clearly."},
                {"role": "user", "content": "Explain regression."},
                {"role": "assistant", "content": "Regression models relationships."},
                {"role": "user", "content": "Give me an example."},
            ],
            max_chars=16000,
        )
        self.assertTrue(cache_hit)
        self.assertEqual(packet[-1]["role"], "user")
        self.assertEqual(packet[-1]["content"], "Give me an example.")

    def test_background_schedule_is_fail_open_without_running_loop(self):
        ctx.schedule_next_context(
            "no-loop",
            [{"role": "user", "content": "Hello"}],
            "Hi",
            "gemini:gemini-3.5-flash-lite",
        )

    def test_provider_private_fields_are_not_retained(self):
        packet = ctx.build_context_packet(
            [
                {"role": "system", "content": "Teach.", "secret": "drop"},
                {"role": "user", "content": "Question", "_provider_state": {"x": 1}},
                {"role": "assistant", "content": "Answer", "tool_calls": [{"x": 1}]},
            ]
        )
        self.assertTrue(packet)
        for item in packet:
            self.assertEqual(set(item), {"role", "content"})


if __name__ == "__main__":
    unittest.main()
