#!/usr/bin/env python3
"""Route ordinary Tutor chat through a low-latency streamed fast lane."""
from __future__ import annotations

from pathlib import Path
import sys

MARKER = "MURIKAH_DUAL_LANE_CHAT_V7"

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
from deeptutor.murikah_context_packet import (
    context_packet_for_turn,
    provider_affinity,
    schedule_next_context,
)
from deeptutor.murikah_fast_lane import (
    HedgeCandidate,
    close_stream,
    configured_gemini_model,
    configured_nvidia_fast_model,
    configured_qwen_fast_model,
    continuation_messages,
    finish_reason_needs_continuation,
    gemini_configured,
    gemini_stream,
    latency_ms,
    likely_incomplete_answer,
    nvidia_configured,
    nvidia_stream,
    parse_finish_signal,
    portable_chat_messages,
    qwen_configured,
    qwen_stream,
    race_first_visible,
    trim_continuation_overlap,
)
from deeptutor.runtime.request_contracts import get_capability_request_schema
from deeptutor.runtime.stream_bus import StreamBus
from deeptutor.services.llm import factory as llm_factory
from deeptutor.services.model_selection.runtime import resolve_llm_config_for_selection

logger = logging.getLogger(__name__)

# MURIKAH_DUAL_LANE_CHAT_V7
def _positive_seconds(name: str, default: float) -> float:
    try:
        value = float(os.environ.get(name, "") or default)
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


def _positive_int(name: str, default: int) -> int:
    try:
        value = int(os.environ.get(name, "") or default)
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


_FIRST_TOKEN_TIMEOUT_SECONDS = _positive_seconds(
    "MURIKAH_CHAT_FIRST_TOKEN_TIMEOUT_SECONDS", 8.0
)
_OVERALL_FIRST_TOKEN_SECONDS = _positive_seconds(
    "MURIKAH_CHAT_OVERALL_FIRST_TOKEN_SECONDS", 10.0
)
_STREAM_IDLE_TIMEOUT_SECONDS = _positive_seconds(
    "MURIKAH_CHAT_STREAM_IDLE_TIMEOUT_SECONDS", 15.0
)
_FAST_TURN_TIMEOUT_SECONDS = _positive_seconds(
    "MURIKAH_CHAT_FAST_TURN_TIMEOUT_SECONDS", 45.0
)
_FAST_OUTPUT_TOKENS = _positive_int(
    "MURIKAH_CHAT_FAST_OUTPUT_TOKENS", 1800
)
_MAX_CONTINUATIONS = min(
    1, _positive_int("MURIKAH_CHAT_MAX_CONTINUATIONS", 1)
)
_FAST_CONTEXT_CHARS = _positive_int(
    "MURIKAH_CHAT_CONTEXT_CHARS", 16000
)
'''

OLD_RUN = '''    async def run(self, context: UnifiedContext, stream: StreamBus) -> None:
        pipeline = AgenticChatPipeline(language=context.language)
        await pipeline.run(context, stream)
'''

NEW_RUN = '''    @staticmethod
    def _agent_reason(context: UnifiedContext) -> str:
        """Return why the *current* turn needs the full DeepTutor agent lane.

        Ordinary Chat is fast by default. Persistent metadata from a previous
        answer must never silently promote a follow-up into the agent loop.
        Current-turn promotion is explicit through murikah_current_turn_flags.
        """
        metadata = context.metadata or {}
        if context.knowledge_bases:
            return "knowledge_base"
        if context.attachments:
            return "attachments"
        current = metadata.get("murikah_current_turn_flags")
        if isinstance(current, (list, tuple, set)):
            allowed = {
                "deep_mode",
                "research_mode",
                "force_agentic_chat",
                "tool_execution_requested",
            }
            for key in current:
                value = str(key or "").strip()
                if value in allowed:
                    return value
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
        logger.info(
            "MURIKAH_LATENCY event=lane selected_lane=fast routing_reason=ordinary_chat"
        )
        prompt_pipeline = AgenticChatPipeline(language=context.language)
        messages = prompt_pipeline._build_loop_messages(
            context=context,
            enabled_tools=[],
            include_tool_manifest=False,
        )

        # Build a compact conversation packet for every ordinary follow-up.
        # Older transcript is summarized and only the newest turns stay verbatim,
        # so turn 20 is not forced to replay tens of thousands of characters.
        conversation_id = str(getattr(context, "session_id", "") or "")
        raw_history_chars = sum(
            len(str(item.get("content") or ""))
            for item in messages
            if isinstance(item, dict)
        )
        context_build_started = time.perf_counter()
        messages, context_cache_hit = context_packet_for_turn(
            conversation_id,
            messages,
            max_chars=_FAST_CONTEXT_CHARS,
            recent_turns=4,
        )
        packet_chars = sum(len(str(item.get("content") or "")) for item in messages)
        context_build_ms = latency_ms(context_build_started)
        follow_up = sum(1 for item in messages if item.get("role") == "user") > 1
        latest_user_text = next(
            (
                str(item.get("content") or "")
                for item in reversed(messages)
                if item.get("role") == "user"
            ),
            "",
        ).lower()
        long_answer_requested = any(
            marker in latest_user_text
            for marker in (
                "detailed",
                "comprehensive",
                "in depth",
                "in-depth",
                "long answer",
                "long explanation",
                "deep explanation",
                "word essay",
                "words essay",
                "3000 words",
                "2500 words",
                "2000 words",
            )
        )
        turn_output_tokens = min(
            2800 if long_answer_requested else _FAST_OUTPUT_TOKENS,
            prompt_pipeline.respond_max_tokens,
        )
        logger.info(
            "MURIKAH_LATENCY route=fast event=context_packet conversation=%s follow_up=%s cache_hit=%s raw_history_chars=%s packet_chars=%s context_build_ms=%s output_tokens=%s",
            conversation_id or "unknown",
            follow_up,
            context_cache_hit,
            raw_history_chars,
            packet_chars,
            context_build_ms,
            turn_output_tokens,
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
            effective_delay = 0.0 if provider_affinity(conversation_id) == name else delay_seconds
            return HedgeCandidate(
                name=name,
                delay_seconds=effective_delay,
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
                    max_tokens=turn_output_tokens,
                    stream_coalesce_chars=24,
                    stream_coalesce_seconds=0.02,
                ),
            )

        # Three independent fast-chat routes: Google's lowest-latency stable
        # Flash-Lite model, NVIDIA Nemotron Lightning with hidden thinking off,
        # and Qwen Flash through DashScope. A catalog model remains a fourth
        # safety net, but ordinary Chat never falls into the multi-agent loop.
        nvidia_model = configured_nvidia_fast_model()
        nvidia_on = nvidia_configured()
        qwen_model = configured_qwen_fast_model()
        qwen_on = qwen_configured()
        preferred_provider = provider_affinity(conversation_id)

        if gemini_on:
            hedges.append(
                HedgeCandidate(
                    name=f"gemini:{gemini_model}",
                    delay_seconds=0.0 if preferred_provider.startswith("gemini") or not preferred_provider else 0.8,
                    factory=lambda: gemini_stream(
                        messages,
                        max_tokens=turn_output_tokens,
                    ),
                )
            )
        if nvidia_on:
            hedges.append(
                HedgeCandidate(
                    name=f"nvidia-fast:{nvidia_model}",
                    delay_seconds=0.0 if preferred_provider.startswith("nvidia") else (0.4 if gemini_on else 0.0),
                    factory=lambda: nvidia_stream(
                        messages,
                        max_tokens=turn_output_tokens,
                    ),
                )
            )
        if qwen_on:
            hedges.append(
                HedgeCandidate(
                    name=f"qwen-fast:{qwen_model}",
                    delay_seconds=0.0 if preferred_provider.startswith("qwen") else (0.8 if (gemini_on or nvidia_on) else 0.0),
                    factory=lambda: qwen_stream(
                        messages,
                        max_tokens=turn_output_tokens,
                    ),
                )
            )

        fallback_configs = [
            config
            for config in resolved
            if str(getattr(config, "model", "")) not in {gemini_model, nvidia_model, qwen_model}
        ]
        if fallback_configs:
            hedges.append(deep_candidate(fallback_configs[0], 1.2))

        if not hedges:
            logger.error("MURIKAH_LATENCY route=fast event=no_candidates")
            raise RuntimeError("Murikah is temporarily unavailable. Please try again.")

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
                {
                    "trace_kind": "call_status",
                    "call_state": "running",
                    "murikah_lane": "fast",
                    "follow_up": follow_up,
                    "history_chars": raw_history_chars,
                    "context_packet_chars": packet_chars,
                    "context_build_ms": context_build_ms,
                    "context_cache_hit": context_cache_hit,
                },
            ),
        )

        winner = await race_first_visible(
            hedges,
            request_started=request_started,
            first_token_timeout=_FIRST_TOKEN_TIMEOUT_SECONDS,
            overall_timeout=_OVERALL_FIRST_TOKEN_SECONDS,
        )
        if winner is None:
            elapsed = latency_ms(request_started)
            context.metadata["murikah_provider"] = ""
            context.metadata["murikah_model"] = ""
            context.metadata["murikah_first_token_ms"] = 0
            logger.warning(
                "MURIKAH_LATENCY route=fast event=terminal_first_token_timeout elapsed_ms=%s",
                elapsed,
            )
            await stream.progress(
                "Murikah is reconnecting. Please try again.",
                source="chat",
                stage="failed",
                metadata=merge_trace_metadata(
                    trace_meta,
                    {
                        "trace_kind": "call_status",
                        "call_state": "failed",
                        "status_code": "provider_unavailable",
                        "retryable": True,
                        "murikah_lane": "fast",
                    },
                ),
            )
            # Ordinary chat never falls through to the multi-agent pipeline.
            # Raising gives the turn runtime a terminal ERROR + DONE event and
            # releases the composer instead of leaving Reasoning spinning.
            raise RuntimeError("Murikah is temporarily unavailable. Please try again.")

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

        context.metadata["murikah_provider"] = winner.name
        if winner.name.startswith(("gemini:", "gemini-retry:")):
            winner_model = gemini_model
        elif winner.name.startswith(("nvidia-fast:", "nvidia-retry:")):
            winner_model = nvidia_model
        elif winner.name.startswith(("qwen-fast:", "qwen-retry:")):
            winner_model = qwen_model
        else:
            winner_model = winner.name.split(":", 1)[1] if ":" in winner.name else ""
        context.metadata["murikah_model"] = winner_model
        context.metadata["murikah_first_token_ms"] = winner.first_token_ms
        turn_deadline = request_started + _FAST_TURN_TIMEOUT_SECONDS

        async def collect_remaining(
            active_winner: Any,
            *,
            publish: bool,
            metadata: dict[str, Any],
        ) -> tuple[str, str, str]:
            """Return visible text, provider finish reason, and recoverable failure kind."""
            segment_parts: list[str] = []
            finish_reason = ""
            failure_kind = ""
            in_think = False
            segment_deadline = turn_deadline
            try:
                while True:
                    remaining = segment_deadline - time.perf_counter()
                    if remaining <= 0:
                        raise asyncio.TimeoutError
                    try:
                        chunk = await asyncio.wait_for(
                            active_winner.stream.__anext__(),
                            timeout=min(_STREAM_IDLE_TIMEOUT_SECONDS, remaining),
                        )
                    except StopAsyncIteration:
                        break
                    text = str(chunk or "")
                    reason = parse_finish_signal(text)
                    if reason is not None:
                        finish_reason = reason
                        continue
                    if text == "<think>":
                        in_think = True
                        continue
                    if text == "</think>":
                        in_think = False
                        continue
                    if in_think or not text:
                        continue
                    segment_parts.append(text)
                    if publish:
                        await stream.content(
                            text,
                            source="chat",
                            stage="responding",
                            metadata=metadata,
                        )
            except asyncio.TimeoutError:
                failure_kind = "stream_timeout"
                logger.warning(
                    "MURIKAH_LATENCY route=fast event=stream_recovery_needed provider=%s reason=timeout elapsed_ms=%s",
                    active_winner.name,
                    latency_ms(request_started),
                )
            except Exception as exc:
                failure_kind = "stream_error"
                logger.warning(
                    "MURIKAH_LATENCY route=fast event=stream_recovery_needed provider=%s reason=%s elapsed_ms=%s",
                    active_winner.name,
                    type(exc).__name__,
                    latency_ms(request_started),
                )
            finally:
                await close_stream(active_winner.stream)
            return "".join(segment_parts), finish_reason, failure_kind

        initial_tail, finish_reason, stream_failure = await collect_remaining(
            winner,
            publish=True,
            metadata=chunk_meta,
        )
        answer_parts.append(initial_tail)
        answer = "".join(answer_parts).strip()

        def should_continue(current_answer: str, reason: str, failure: str) -> bool:
            if failure:
                return True
            if finish_reason_needs_continuation(reason):
                return True
            if not reason and likely_incomplete_answer(current_answer):
                return True
            return False

        continuation_count = 0
        continuation_providers: list[str] = []
        incomplete = should_continue(answer, finish_reason, stream_failure)

        while incomplete and continuation_count < _MAX_CONTINUATIONS:
            continuation_count += 1
            await stream.progress(
                "Continuing response…",
                source="chat",
                stage="responding",
                metadata=merge_trace_metadata(
                    trace_meta,
                    {
                        "trace_kind": "call_status",
                        "call_state": "running",
                        "call_role": "continuation",
                        "murikah_lane": "fast",
                        "continuation": continuation_count,
                    },
                ),
            )

            recovery_messages = continuation_messages(messages, answer)
            recovery_hedges: list[HedgeCandidate] = []
            if gemini_on:
                recovery_hedges.append(
                    HedgeCandidate(
                        name=f"gemini-continuation:{gemini_model}",
                        delay_seconds=0.0,
                        factory=lambda recovery_messages=recovery_messages: gemini_stream(
                            recovery_messages,
                            max_tokens=min(
                                _FAST_OUTPUT_TOKENS,
                                prompt_pipeline.respond_max_tokens,
                            ),
                        ),
                    )
                )
            if nvidia_on:
                recovery_hedges.append(
                    HedgeCandidate(
                        name=f"nvidia-continuation:{nvidia_model}",
                        delay_seconds=0.0,
                        factory=lambda recovery_messages=recovery_messages: nvidia_stream(
                            recovery_messages,
                            max_tokens=min(
                                _FAST_OUTPUT_TOKENS,
                                prompt_pipeline.respond_max_tokens,
                            ),
                        ),
                    )
                )
            if qwen_on:
                recovery_hedges.append(
                    HedgeCandidate(
                        name=f"qwen-continuation:{qwen_model}",
                        delay_seconds=0.0,
                        factory=lambda recovery_messages=recovery_messages: qwen_stream(
                            recovery_messages,
                            max_tokens=min(
                                _FAST_OUTPUT_TOKENS,
                                prompt_pipeline.respond_max_tokens,
                            ),
                        ),
                    )
                )
            if fallback_configs:
                recovery_config = fallback_configs[0]
                recovery_name = (
                    f"{recovery_config.provider_name or recovery_config.binding or 'provider'}:"
                    f"{recovery_config.model}"
                )
                recovery_hedges.append(
                    HedgeCandidate(
                        name=f"catalog-continuation:{recovery_name}",
                        delay_seconds=0.75,
                        factory=lambda config=recovery_config, recovery_messages=recovery_messages: llm_factory.stream(
                            prompt="",
                            system_prompt="",
                            model=config.model,
                            api_key=config.api_key,
                            base_url=config.effective_url or config.base_url,
                            api_version=config.api_version,
                            binding=config.provider_name or config.binding,
                            messages=recovery_messages,
                            max_retries=1,
                            reasoning_effort=config.reasoning_effort,
                            extra_headers=config.extra_headers,
                            temperature=prompt_pipeline._chat_temperature,
                            max_tokens=min(
                                _FAST_OUTPUT_TOKENS,
                                prompt_pipeline.respond_max_tokens,
                            ),
                            stream_coalesce_chars=24,
                            stream_coalesce_seconds=0.02,
                        ),
                    )
                )

            recovery_started = time.perf_counter()
            recovery_winner = await race_first_visible(
                recovery_hedges,
                request_started=recovery_started,
                first_token_timeout=min(8.0, _FIRST_TOKEN_TIMEOUT_SECONDS),
                overall_timeout=min(10.0, _OVERALL_FIRST_TOKEN_SECONDS),
            )
            if recovery_winner is None:
                logger.warning(
                    "MURIKAH_LATENCY route=fast event=continuation_unavailable attempt=%s elapsed_ms=%s",
                    continuation_count,
                    latency_ms(request_started),
                )
                break

            continuation_providers.append(recovery_winner.name)
            recovery_meta = merge_trace_metadata(
                trace_meta,
                {
                    "trace_kind": "llm_chunk",
                    "murikah_lane": "fast",
                    "provider": recovery_winner.name,
                    "continuation": continuation_count,
                },
            )
            continuation_text = trim_continuation_overlap(
                answer,
                recovery_winner.first_chunk,
            )
            if answer and continuation_text and not continuation_text[0].isspace():
                if (
                    answer[-1:].isalnum()
                    and continuation_text[0].isalnum()
                ) or (
                    answer[-1:] in ",;:.!?)]}"
                    and continuation_text[0].isalnum()
                ):
                    continuation_text = " " + continuation_text
            if continuation_text:
                answer += continuation_text
                await stream.content(
                    continuation_text,
                    source="chat",
                    stage="responding",
                    metadata=recovery_meta,
                )
            recovery_tail, recovery_finish_reason, recovery_failure = await collect_remaining(
                recovery_winner,
                publish=True,
                metadata=recovery_meta,
            )
            answer += recovery_tail
            finish_reason = recovery_finish_reason
            stream_failure = recovery_failure
            incomplete = should_continue(answer, finish_reason, stream_failure)
            logger.info(
                "MURIKAH_LATENCY route=fast event=continuation_complete provider=%s attempt=%s finish_reason=%s failure=%s total_ms=%s",
                recovery_winner.name,
                continuation_count,
                finish_reason or "unknown",
                stream_failure or "none",
                latency_ms(request_started),
            )

        context.metadata["murikah_finish_reason"] = finish_reason
        context.metadata["murikah_continuations"] = continuation_count
        if continuation_providers:
            context.metadata["murikah_continuation_providers"] = continuation_providers

        if incomplete:
            logger.warning(
                "MURIKAH_LATENCY route=fast event=partial_response_preserved finish_reason=%s failure=%s continuations=%s elapsed_ms=%s",
                finish_reason or "unknown",
                stream_failure or "none",
                continuation_count,
                latency_ms(request_started),
            )
            # The learner already has useful streamed text. Do not hold the whole
            # turn open for another long hidden repair cycle.
            await stream.progress(
                "Response was interrupted. Ask me to continue if you need the rest.",
                source="chat",
                stage="responding",
                metadata=merge_trace_metadata(
                    trace_meta,
                    {
                        "trace_kind": "call_status",
                        "call_state": "partial",
                        "retryable": True,
                        "murikah_lane": "fast",
                    },
                ),
            )

        context.capability_output.agent_output = answer
        context.capability_output.answer_published = True
        total_ms = latency_ms(request_started)
        context.metadata["murikah_total_ms"] = total_ms
        logger.info(
            "MURIKAH_LATENCY route=fast event=complete provider=%s first_token_ms=%s total_ms=%s history_chars=%s packet_chars=%s context_build_ms=%s continuations=%s",
            winner.name,
            winner.first_token_ms,
            total_ms,
            raw_history_chars,
            packet_chars,
            context_build_ms,
            continuation_count,
        )
        # Prepare the next follow-up packet after the answer is complete. This
        # is intentionally outside the learner-facing generation critical path.
        schedule_next_context(
            conversation_id,
            messages,
            answer,
            winner.name,
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
                "rounds": 1 + continuation_count,
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
                "MURIKAH_LATENCY event=lane selected_lane=deep_agent routing_reason=%s",
                reason,
            )
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
