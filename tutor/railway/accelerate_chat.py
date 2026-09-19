#!/usr/bin/env python3
"""Route ordinary Tutor chat through a low-latency streamed fast lane."""
from __future__ import annotations

from pathlib import Path
import sys

MARKER = "MURIKAH_DUAL_LANE_CHAT_V2"

OLD_IMPORTS = '''from deeptutor.agents.chat.agentic_pipeline import CHAT_OPTIONAL_TOOLS, AgenticChatPipeline
from deeptutor.core.capability_protocol import CapabilityManifest, TurnCapability
from deeptutor.core.context import UnifiedContext
from deeptutor.runtime.request_contracts import get_capability_request_schema
from deeptutor.runtime.stream_bus import StreamBus
'''

NEW_IMPORTS = '''import asyncio
import logging
import os
import time
from typing import Any

from deeptutor.agents._shared.capability_result import emit_capability_result
from deeptutor.agents.chat.agentic_pipeline import CHAT_OPTIONAL_TOOLS, AgenticChatPipeline
from deeptutor.core.capability_protocol import CapabilityManifest, TurnCapability
from deeptutor.core.context import UnifiedContext
from deeptutor.core.trace import build_trace_metadata, merge_trace_metadata, new_call_id
from deeptutor.multi_user.model_access import allowed_llm_options
from deeptutor.murikah_fast_lane import (
    HedgeCandidate,
    close_stream,
    configured_gemini_model,
    gemini_configured,
    gemini_stream,
    latency_ms,
    race_first_visible,
)
from deeptutor.runtime.request_contracts import get_capability_request_schema
from deeptutor.runtime.stream_bus import StreamBus
from deeptutor.services.llm import factory as llm_factory
from deeptutor.services.model_selection.runtime import resolve_llm_config_for_selection

logger = logging.getLogger(__name__)

# MURIKAH_DUAL_LANE_CHAT_V2
def _positive_seconds(name: str, default: float) -> float:
    try:
        value = float(os.environ.get(name, "") or default)
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


_FIRST_TOKEN_TIMEOUT_SECONDS = _positive_seconds(
    "MURIKAH_CHAT_FIRST_TOKEN_TIMEOUT_SECONDS", 12.0
)
_OVERALL_FIRST_TOKEN_SECONDS = _positive_seconds(
    "MURIKAH_CHAT_OVERALL_FIRST_TOKEN_SECONDS", 20.0
)
_STREAM_IDLE_TIMEOUT_SECONDS = _positive_seconds(
    "MURIKAH_CHAT_STREAM_IDLE_TIMEOUT_SECONDS", 45.0
)
'''

OLD_RUN = '''    async def run(self, context: UnifiedContext, stream: StreamBus) -> None:
        pipeline = AgenticChatPipeline(language=context.language)
        await pipeline.run(context, stream)
'''

NEW_RUN = '''    @staticmethod
    def _agent_reason(context: UnifiedContext) -> str:
        """Return why this turn genuinely needs the full DeepTutor agent lane.

        Tool availability alone is deliberately not a reason. DeepTutor can expose
        optional tools on ordinary Chat by default; routing every such turn through
        the agent loop is what made simple prompts take minutes.
        """
        metadata = context.metadata or {}
        if context.knowledge_bases:
            return "knowledge_base"
        if context.attachments:
            return "attachments"
        if context.source_manifest:
            return "sources"
        if metadata.get("source_index"):
            return "source_index"
        for key in (
            "mastery_mode",
            "immersive_reading_mode",
            "question_bank_context",
            "deep_mode",
            "research_mode",
            "force_agentic_chat",
            "tool_execution_requested",
        ):
            if metadata.get(key):
                return key
        return ""

    @staticmethod
    def _candidate_selections(context: UnifiedContext) -> list[dict[str, str]]:
        """Selected model first, followed by models the current account may use."""
        candidates: list[dict[str, str]] = []

        def add(value: Any) -> None:
            if not isinstance(value, dict):
                return
            profile_id = str(value.get("profile_id") or "").strip()
            model_id = str(value.get("model_id") or "").strip()
            if not profile_id or not model_id:
                return
            candidate = {"profile_id": profile_id, "model_id": model_id}
            effort = str(value.get("reasoning_effort") or "").strip().lower()
            if effort:
                candidate["reasoning_effort"] = effort
            if not any(
                existing.get("profile_id") == profile_id
                and existing.get("model_id") == model_id
                for existing in candidates
            ):
                candidates.append(candidate)

        add((context.metadata or {}).get("llm_selection"))
        try:
            options = allowed_llm_options()
        except Exception:
            options = {"active": None, "options": []}
        add(options.get("active"))
        for item in options.get("options", []) or []:
            add(item)
        return candidates

    async def _run_fast_chat(self, context: UnifiedContext, stream: StreamBus) -> None:
        request_started = time.perf_counter()
        prompt_pipeline = AgenticChatPipeline(language=context.language)
        messages = prompt_pipeline._build_loop_messages(
            context=context,
            enabled_tools=[],
            include_tool_manifest=False,
        )

        resolved: list[Any] = []
        seen: set[tuple[str, str]] = set()
        for candidate in self._candidate_selections(context):
            try:
                config = resolve_llm_config_for_selection(candidate)
            except Exception as exc:
                logger.warning(
                    "MURIKAH_LATENCY route=fast event=config_failed model=%s type=%s",
                    candidate.get("model_id", "unknown"),
                    type(exc).__name__,
                )
                continue
            key = (str(config.provider_name or config.binding or ""), str(config.model or ""))
            if key in seen:
                continue
            seen.add(key)
            resolved.append(config)

        gemini_model = configured_gemini_model()
        gemini_on = gemini_configured()
        selected_is_gemini = bool(
            resolved and str(getattr(resolved[0], "model", "")) == gemini_model
        )
        hedges: list[HedgeCandidate] = []

        def deep_candidate(config: Any, delay_seconds: float) -> HedgeCandidate:
            name = f"{config.provider_name or config.binding or 'provider'}:{config.model}"
            return HedgeCandidate(
                name=name,
                delay_seconds=delay_seconds,
                factory=lambda config=config: llm_factory.stream(
                    prompt="",
                    system_prompt="",
                    model=config.model,
                    api_key=config.api_key,
                    base_url=config.effective_url or config.base_url,
                    api_version=config.api_version,
                    binding=config.provider_name or config.binding,
                    messages=messages,
                    max_retries=1,
                    reasoning_effort=config.reasoning_effort,
                    extra_headers=config.extra_headers,
                    temperature=prompt_pipeline._chat_temperature,
                    max_tokens=min(2400, prompt_pipeline.respond_max_tokens),
                    stream_coalesce_chars=24,
                    stream_coalesce_seconds=0.02,
                ),
            )

        # Honour an explicitly selected non-Gemini model first. Otherwise Gemini
        # is the normal interactive lane. After 2.5s a second provider is launched
        # instead of waiting serially for a slow endpoint.
        non_gemini = [config for config in resolved if str(config.model) != gemini_model]
        if resolved and not selected_is_gemini:
            hedges.append(deep_candidate(resolved[0], 0.0))
            if gemini_on:
                hedges.append(
                    HedgeCandidate(
                        name=f"gemini:{gemini_model}",
                        delay_seconds=2.5,
                        factory=lambda: gemini_stream(
                            messages,
                            max_tokens=min(2400, prompt_pipeline.respond_max_tokens),
                        ),
                    )
                )
            remainder = [config for config in non_gemini if config is not resolved[0]]
            for index, config in enumerate(remainder[:2]):
                hedges.append(deep_candidate(config, 4.5 + (index * 2.0)))
        else:
            if gemini_on:
                hedges.append(
                    HedgeCandidate(
                        name=f"gemini:{gemini_model}",
                        delay_seconds=0.0,
                        factory=lambda: gemini_stream(
                            messages,
                            max_tokens=min(2400, prompt_pipeline.respond_max_tokens),
                        ),
                    )
                )
            for index, config in enumerate(non_gemini[:3]):
                delay = 2.5 + (index * 2.0) if gemini_on else index * 2.5
                hedges.append(deep_candidate(config, delay))

        if not hedges:
            logger.warning("MURIKAH_LATENCY route=fast event=no_candidates")
            await prompt_pipeline.run(context, stream)
            return

        call_id = new_call_id("chat-responding")
        trace_meta = build_trace_metadata(
            call_id=call_id,
            phase="responding",
            label="Answering",
            call_kind="llm_final_response",
            trace_id=call_id,
            trace_role="response",
            trace_group="stage",
        )
        await stream.progress(
            "Answering",
            source="chat",
            stage="responding",
            metadata=merge_trace_metadata(
                trace_meta,
                {"trace_kind": "call_status", "call_state": "running", "murikah_lane": "fast"},
            ),
        )

        winner = await race_first_visible(
            hedges,
            request_started=request_started,
            first_token_timeout=_FIRST_TOKEN_TIMEOUT_SECONDS,
            overall_timeout=_OVERALL_FIRST_TOKEN_SECONDS,
        )
        if winner is None:
            logger.warning(
                "MURIKAH_LATENCY route=fast event=recover_with_standard_pipeline elapsed_ms=%s",
                latency_ms(request_started),
            )
            await stream.progress(
                "Still working on your answer",
                source="chat",
                stage="responding",
                metadata=merge_trace_metadata(
                    trace_meta,
                    {
                        "trace_kind": "call_status",
                        "call_state": "running",
                        "status_code": "fast_lane_recovery",
                        "retryable": True,
                        "murikah_lane": "fast",
                    },
                ),
            )
            await prompt_pipeline.run(context, stream)
            return

        answer_parts = [winner.first_chunk]
        chunk_meta = merge_trace_metadata(
            trace_meta,
            {
                "trace_kind": "llm_chunk",
                "murikah_lane": "fast",
                "provider": winner.name,
                "first_token_ms": winner.first_token_ms,
            },
        )
        await stream.content(
            winner.first_chunk,
            source="chat",
            stage="responding",
            metadata=chunk_meta,
        )

        in_think = False
        try:
            while True:
                try:
                    chunk = await asyncio.wait_for(
                        winner.stream.__anext__(),
                        timeout=_STREAM_IDLE_TIMEOUT_SECONDS,
                    )
                except StopAsyncIteration:
                    break
                text = str(chunk or "")
                if text == "<think>":
                    in_think = True
                    continue
                if text == "</think>":
                    in_think = False
                    continue
                if in_think or not text:
                    continue
                answer_parts.append(text)
                await stream.content(text, source="chat", stage="responding", metadata=chunk_meta)
        finally:
            await close_stream(winner.stream)

        answer = "".join(answer_parts).strip()
        context.capability_output.agent_output = answer
        context.capability_output.answer_published = True
        total_ms = latency_ms(request_started)
        logger.info(
            "MURIKAH_LATENCY route=fast event=complete provider=%s first_token_ms=%s total_ms=%s",
            winner.name,
            winner.first_token_ms,
            total_ms,
        )
        await stream.progress(
            "",
            source="chat",
            stage="responding",
            metadata=merge_trace_metadata(
                trace_meta,
                {
                    "trace_kind": "call_status",
                    "call_state": "complete",
                    "call_role": "finish",
                    "murikah_lane": "fast",
                    "provider": winner.name,
                    "first_token_ms": winner.first_token_ms,
                    "total_ms": total_ms,
                },
            ),
        )
        await emit_capability_result(
            stream,
            {
                "response": answer,
                "completed": True,
                "engine": "murikah_fast_chat",
                "rounds": 1,
                "tool_steps": 0,
                "provider": winner.name,
                "first_token_ms": winner.first_token_ms,
            },
            source="chat",
        )

    async def run(self, context: UnifiedContext, stream: StreamBus) -> None:
        reason = self._agent_reason(context)
        if reason:
            started = time.perf_counter()
            logger.info(
                "MURIKAH_LATENCY route=deep_agent event=start reason=%s enabled_tools=%s",
                reason,
                len(context.enabled_tools or []),
            )
            pipeline = AgenticChatPipeline(language=context.language)
            await pipeline.run(context, stream)
            logger.info(
                "MURIKAH_LATENCY route=deep_agent event=complete reason=%s total_ms=%s",
                reason,
                latency_ms(started),
            )
            return
        await self._run_fast_chat(context, stream)
'''


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"Expected exactly one {label}, found {count}")
    return text.replace(old, new, 1)


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: accelerate_chat.py <deeptutor-checkout>", file=sys.stderr)
        return 2
    root = Path(sys.argv[1]).resolve()
    target = root / "deeptutor" / "agents" / "chat" / "capability.py"
    text = target.read_text(encoding="utf-8")
    if MARKER in text:
        print("[Murikah Tutor] Dual-lane chat already applied.")
        return 0
    try:
        text = replace_once(text, OLD_IMPORTS, NEW_IMPORTS, "chat capability imports")
        text = replace_once(text, OLD_RUN, NEW_RUN, "chat capability run method")
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    target.write_text(text, encoding="utf-8")
    print("[Murikah Tutor] Added dual-lane fast chat and deep agent routing.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
