"""Exercise the final stream filter and hedged failover without provider traffic."""
import ast
import asyncio
import importlib.util
from pathlib import Path
import sys
import time
import unittest

root = Path(__file__).resolve().parents[1]
source = root / "railway/murikah_fast_lane.py"
if not source.exists(): source = Path("/app/deeptutor/murikah_fast_lane.py")
spec = importlib.util.spec_from_file_location("fast_lane_under_test", source)
fast = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = fast
spec.loader.exec_module(fast)
if not hasattr(fast, "validated_stream"):
    # Locally materialize the exact appended function from the overlay script.
    tree = ast.parse((root / "railway/apply_workspace_access.py").read_text())
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and "async def validated_stream(source):" in node.value:
            exec(node.value, fast.__dict__)
            break


async def stream(*chunks):
    for chunk in chunks:
        yield chunk


class ProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_split_overload_never_becomes_content(self):
        visible = []
        with self.assertRaises(RuntimeError):
            async for item in fast.validated_stream(stream("Err", "or:", " {'code': 529}")):
                visible.append(item)
        self.assertEqual(visible, [])

    async def test_midstream_error_not_rendered(self):
        visible = []
        with self.assertRaises(RuntimeError):
            async for item in fast.validated_stream(stream("The answer is ", "Error calling LLM: Connection error.")):
                visible.append(item)
        self.assertEqual(visible, ["The answer is "])

    async def test_whitespace_is_not_first_visible_token(self):
        self.assertEqual([x async for x in fast.validated_stream(stream(" ", "Hello"))], [" Hello"])

    async def test_normal_prose_and_json_survive(self):
        for chunks in [("Hello", " world"), ("Errors", " are useful."), ('{"answer":', '42}')]:
            self.assertEqual("".join([x async for x in fast.validated_stream(stream(*chunks))]), "".join(chunks))

    async def test_overloaded_provider_loses_to_healthy_fallback(self):
        # Source checkout's race is patched by apply_workspace_access in-image.
        def guarded(*chunks): return fast.validated_stream(stream(*chunks))
        winner = await fast.race_first_visible([
            fast.HedgeCandidate("overloaded", 0, lambda: guarded("Error: {'code': 529}")),
            fast.HedgeCandidate("healthy", .001, lambda: guarded("Let's learn data science.")),
        ], request_started=time.perf_counter(), first_token_timeout=.1, overall_timeout=.2)
        self.assertIsNotNone(winner)
        self.assertEqual(winner.name, "healthy")
        await fast.close_stream(winner.stream)

    async def test_all_providers_failing_returns_no_raw_error(self):
        winner = await fast.race_first_visible([
            fast.HedgeCandidate("bad", 0, lambda: fast.validated_stream(stream("Error calling LLM: Connection error."))),
        ], request_started=time.perf_counter(), first_token_timeout=.1, overall_timeout=.2)
        self.assertIsNone(winner)

    async def test_delayed_fallback_receives_full_first_token_allowance(self):
        async def delayed_answer():
            await asyncio.sleep(.05)
            yield "A healthy follow-up answer."

        winner = await fast.race_first_visible([
            fast.HedgeCandidate("primary", 0, lambda: stream()),
            fast.HedgeCandidate("fallback", .08, delayed_answer),
        ], request_started=time.perf_counter(), first_token_timeout=.1, overall_timeout=.1)
        self.assertIsNotNone(winner)
        self.assertEqual(winner.name, "fallback")
        await fast.close_stream(winner.stream)

    async def test_portable_followup_history_strips_provider_private_state(self):
        messages = [
            {"role": "system", "content": "Teach clearly.", "_provider_response_state": {"x": 1}},
            {"role": "user", "content": "Teach me data science", "unexpected": "drop"},
            {
                "role": "assistant",
                "content": "Data science combines programming and statistics.",
                "reasoning_content": "private",
                "thinking_blocks": [{"type": "thinking", "text": "private"}],
            },
            {"role": "tool", "content": "must not leak into ordinary fast chat"},
            {"role": "user", "content": "Proceed"},
        ]
        portable = fast.portable_chat_messages(messages)
        self.assertEqual([item["role"] for item in portable], ["system", "user", "assistant", "user"])
        self.assertTrue(all(set(item) == {"role", "content"} for item in portable))
        self.assertEqual(portable[-1]["content"], "Proceed")

    async def test_portable_history_keeps_latest_turn_under_budget(self):
        messages = [
            {"role": "system", "content": "System instruction"},
            {"role": "user", "content": "old-" + ("x" * 12000)},
            {"role": "assistant", "content": "answer-" + ("y" * 12000)},
            {"role": "user", "content": "latest follow-up"},
        ]
        portable = fast.portable_chat_messages(messages, max_chars=8000)
        self.assertEqual(portable[-1], {"role": "user", "content": "latest follow-up"})
        self.assertLessEqual(
            sum(len(item["content"]) for item in portable if item["role"] != "system"),
            8000,
        )

    async def test_followup_history_is_valid_gemini_conversation(self):
        payload = fast._gemini_payload([
            {"role": "system", "content": "Teach clearly."},
            {"role": "user", "content": "Teach me data science"},
            {"role": "assistant", "content": "Data science combines programming and statistics."},
            {"role": "user", "content": "I am a novice in programming and statistics"},
        ], 600)
        self.assertEqual(
            [item["role"] for item in payload["contents"]],
            ["user", "model", "user"],
        )
        self.assertEqual(
            payload["contents"][-1]["parts"][0]["text"],
            "I am a novice in programming and statistics",
        )
        self.assertEqual(
            payload["systemInstruction"]["parts"][0]["text"],
            "Teach clearly.",
        )


if __name__ == "__main__": unittest.main()
