"""Regression checks for Murikah Math Animator structured-output hardening."""
from __future__ import annotations

import asyncio
import importlib
from pathlib import Path
import unittest

from pydantic import BaseModel


ROOT = Path(__file__).resolve().parents[1]


class _Payload(BaseModel):
    value: str = ""


class _FakeAgent:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = 0

    async def call_llm(self, **_kwargs):
        self.calls += 1
        if not self.responses:
            return ""
        value = self.responses.pop(0)
        if isinstance(value, Exception):
            raise value
        return value


class MathAnimatorStructuredTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.mod = importlib.import_module(
            "deeptutor.agents.math_animator.structured_output"
        )
        self._orig = {
            "gemini_configured": self.mod.gemini_configured,
            "qwen_configured": self.mod.qwen_configured,
            "nvidia_configured": self.mod.nvidia_configured,
            "gemini_stream": self.mod.gemini_stream,
            "qwen_stream": self.mod.qwen_stream,
            "nvidia_stream": self.mod.nvidia_stream,
        }

    async def asyncTearDown(self):
        for key, value in self._orig.items():
            setattr(self.mod, key, value)

    async def test_direct_provider_returns_valid_structured_object(self):
        async def fake_stream(_messages, *, max_tokens=1800):
            del max_tokens
            yield '{"value":"ready"}'

        self.mod.gemini_configured = lambda: True
        self.mod.qwen_configured = lambda: False
        self.mod.nvidia_configured = lambda: False
        self.mod.gemini_stream = fake_stream

        result = await self.mod.direct_structured_payload(
            model_cls=_Payload,
            system_prompt="Return JSON.",
            user_prompt="test",
        )
        self.assertIsNotNone(result)
        self.assertEqual(result.value, "ready")

    async def test_malformed_output_falls_back_instead_of_raising_json_error(self):
        self.mod.gemini_configured = lambda: False
        self.mod.qwen_configured = lambda: False
        self.mod.nvidia_configured = lambda: False
        agent = _FakeAgent(["not json"])

        result = await self.mod.request_structured_payload(
            agent=agent,
            model_cls=_Payload,
            user_prompt="test",
            system_prompt="Return JSON.",
            stage="test_stage",
            trace_meta={},
            fallback=lambda: _Payload(value="fallback"),
        )
        self.assertEqual(result.value, "fallback")
        self.assertEqual(agent.calls, 1)

    async def test_required_nonempty_field_rejects_empty_direct_output(self):
        async def fake_stream(_messages, *, max_tokens=1800):
            del max_tokens
            yield '{"value":""}'

        self.mod.gemini_configured = lambda: True
        self.mod.qwen_configured = lambda: False
        self.mod.nvidia_configured = lambda: False
        self.mod.gemini_stream = fake_stream

        result = await self.mod.direct_structured_payload(
            model_cls=_Payload,
            system_prompt="Return JSON.",
            user_prompt="test",
            required_nonempty="value",
        )
        self.assertIsNone(result)

    def test_overlay_removes_one_shot_json_parsing_from_planning_stages(self):
        overlay = (ROOT / "railway/harden_math_animator.py").read_text(
            encoding="utf-8"
        )
        self.assertIn("MURIKAH_MATH_ANIMATOR_STRUCTURED_V1", overlay)
        self.assertIn("request_structured_payload", overlay)
        self.assertIn("direct_structured_payload", overlay)
        self.assertIn("Your math animation is ready.", overlay)
        self.assertIn(
            "Murikah could not prepare animation code after bounded retries.",
            overlay,
        )

    def test_installed_capability_does_not_publish_raw_provider_error(self):
        capability = Path(
            "/app/deeptutor/agents/math_animator/capability.py"
        )
        if not capability.exists():
            return
        text = capability.read_text(encoding="utf-8")
        self.assertIn(
            "# Provider/backend details belong in server logs",
            text,
        )
        self.assertNotIn(
            'await stream.error(\n                    str(update.get("response", "") or fallback)',
            text,
        )


if __name__ == "__main__":
    unittest.main()
