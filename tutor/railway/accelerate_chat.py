#!/usr/bin/env python3
"""Route ordinary Tutor chat through a low-latency streamed fast lane."""
from __future__ import annotations

from pathlib import Path
import sys

MARKER = "MURIKAH_FOLLOWUP_FAST_PATH_V2"

OLD_IMPORTS = '''from deeptutor.agents.chat.agentic_pipeline import CHAT_OPTIONAL_TOOLS, AgenticChatPipeline
from deeptutor.core.capability_protocol import CapabilityManifest, TurnCapability
from deeptutor.core.context import UnifiedContext
from deeptutor.runtime.request_contracts import get_capability_request_schema
from deeptutor.runtime.stream_bus import StreamBus
'''

NEW_IMPORTS = '''import asyncio
import logging
import os
import re
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
    build_fast_context_window,
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

# MURIKAH_FOLLOWUP_FAST_PATH_V2
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


_FIRST_TOKEN_TIMEOUT_SECONDS = min(
    8.0, _positive_seconds("MURIKAH_CHAT_FIRST_TOKEN_TIMEOUT_SECONDS", 8.0)
)
_OVERALL_FIRST_TOKEN_SECONDS = min(
    10.0, _positive_seconds("MURIKAH_CHAT_OVERALL_FIRST_TOKEN_SECONDS", 10.0)
)
_STREAM_IDLE_TIMEOUT_SECONDS = min(
    15.0, _positive_seconds("MURIKAH_CHAT_STREAM_IDLE_TIMEOUT_SECONDS", 14.0)
)
_FAST_TURN_TIMEOUT_SECONDS = min(
    45.0, _positive_seconds("MURIKAH_CHAT_FAST_TURN_TIMEOUT_SECONDS", 45.0)
)
_LONG_FAST_TURN_TIMEOUT_SECONDS = min(
    60.0, _positive_seconds("MURIKAH_CHAT_LONG_TURN_TIMEOUT_SECONDS", 60.0)
)
_FAST_OUTPUT_TOKENS = min(
    1800, _positive_int("MURIKAH_CHAT_FAST_OUTPUT_TOKENS", 1600)
)
_LONG_OUTPUT_TOKENS = min(
    3000, _positive_int("MURIKAH_CHAT_LONG_OUTPUT_TOKENS", 3000)
)
_FAST_CONTEXT_CHARS = min(
    24000, _positive_int("MURIKAH_CHAT_CONTEXT_CHARS", 16000)
)
_MAX_CONTINUATIONS = min(
    1, _positive_int("MURIKAH_CHAT_MAX_CONTINUATIONS", 1)
)
_PROVIDER_HEDGE_DELAYS = (0.0, 0.4, 0.8)
_CATALOG_HEDGE_DELAY = 1.2


def _long_answer_requested(context: UnifiedContext) -> bool:
    prompt = str(context.user_message or "").strip().lower()
    if not prompt:
        return False
    if re.search(r"\b\d{4,}\s*(?:words?|tokens?)\b", prompt):
        return True
    return any(
        marker in prompt
        for marker in (
            "detailed answer",
            "detailed explanation",
            "comprehensive answer",
            "comprehensive explanation",
            "in-depth",
            "in depth",
            "long-form",
            "long form",
            "write an essay",
            "write a report",
        )
    )


def _output_token_budget(context: UnifiedContext) -> int:
    return _LONG_OUTPUT_TOKENS if _long_answer_requested(context) else _FAST_OUTPUT_TOKENS
'''

OLD_RUN = '''    async def run(self, context: UnifiedContext, stream: StreamBus) -> None:
        pipeline = AgenticChatPipeline(language=context.language)
        await pipeline.run(context, stream)
'''

NEW_RUN = '''    @staticmethod
    def _agent_reason(context: UnifiedContext) -> str:
        """Promote only from explicit inputs belonging to *this* turn.

        Session metadata is intentionally not consulted directly: DeepTutor can
        carry flags forward in conversation context, which used to make an
        ordinary follow-up inherit a previous deep/tool route.
        """
        metadata = context.metadata or {}
        current = metadata.get("murikah_current_turn")
        if not isinstance(current, dict):
            current = {
                "knowledge_base": bool(context.knowledge_bases),
                "attachments": bool(context.attachments),
            }
        ordered = (
            "knowledge_base",
            "attachments",
            "mastery_mode",
            "immersive_reading_mode",
            "question_bank_context",
            "deep_mode",
            "research_mode",
            "force_agentic_chat",
            "tool_execution_requested",
        )
        for key in ordered:
            if current.get(key):
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
        context_build_started = time.perf_counter()
        prompt_pipeline = AgenticChatPipeline(language=context.language)
        raw_messages = prompt_pipeline._build_loop_messages(
            context=context,
            enabled_tools=[],
            include_tool_manifest=False,
        )

        # Follow-up Fast Path V2 uses the packet prepared at the end of the
        # previous turn plus only the newest exchanges. Raw transcript growth
        # therefore cannot make turn 10 or turn 25 progressively slower.
        packet = (context.metadata or {}).get("murikah_context_packet") or {}
        context_window = build_fast_context_window(
            raw_messages,
            context_packet=packet,
            max_chars=_FAST_CONTEXT_CHARS,
        )
        messages = context_window.messages
        context_build_ms = latency_ms(context_build_started)
        output_token_budget = min(
            _output_token_budget(context),
            prompt_pipeline.respond_max_tokens,
        )
        turn_number = max(1, int((context.metadata or {}).get("murikah_turn_number") or 1))
        is_followup = bool((context.metadata or {}).get("murikah_is_followup") or turn_number > 1)
        context.metadata["murikah_history_chars"] = context_window.payload_chars
        context.metadata["murikah_history_messages"] = context_window.history_messages
        context.metadata["murikah_context_packet_chars"] = context_window.context_packet_chars
        context.metadata["murikah_context_build_ms"] = context_build_ms
        context.metadata["murikah_output_token_budget"] = output_token_budget
        context.metadata["murikah_first_token_deadline_ms"] = int(
            _OVERALL_FIRST_TOKEN_SECONDS * 1000
        )
        context.metadata["murikah_stream_idle_timeout_ms"] = int(
            _STREAM_IDLE_TIMEOUT_SECONDS * 1000
        )
        context.metadata["murikah_turn_number"] = turn_number
        context.metadata["murikah_is_followup"] = is_followup
        logger.info(
            "MURIKAH_LATENCY route=fast event=context_ready followup=%s turn=%s "
            "payload_chars=%s history_messages=%s packet_chars=%s build_ms=%s output_tokens=%s",
            is_followup,
            turn_number,
            context_window.payload_chars,
            context_window.history_messages,
            context_window.context_packet_chars,
            context_build_ms,
            output_token_budget,
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
        nvidia_model = configured_nvidia_fast_model()
        nvidia_on = nvidia_configured()
        qwen_model = configured_qwen_fast_model()
        qwen_on = qwen_configured()

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
                    max_tokens=output_token_budget,
                    stream_coalesce_chars=24,
                    stream_coalesce_seconds=0.02,
                ),
            )

        direct: list[HedgeCandidate] = []
        if gemini_on:
            direct.append(
                HedgeCandidate(
                    name=f"gemini:{gemini_model}",
                    delay_seconds=0.0,
                    factory=lambda: gemini_stream(messages, max_tokens=output_token_budget),
                )
            )
        if nvidia_on:
            direct.append(
                HedgeCandidate(
                    name=f"nvidia-fast:{nvidia_model}",
                    delay_seconds=0.0,
                    factory=lambda: nvidia_stream(messages, max_tokens=output_token_budget),
                )
            )
        if qwen_on:
            direct.append(
                HedgeCandidate(
                    name=f"qwen-fast:{qwen_model}",
                    delay_seconds=0.0,
                    factory=lambda: qwen_stream(messages, max_tokens=output_token_budget),
                )
            )

        preferred_provider = (
            str(packet.get("preferred_provider") or "").strip().lower()
            if isinstance(packet, dict)
            else ""
        )

        def provider_family(name: str) -> str:
            value = name.lower()
            if value.startswith("gemini"):
                return "gemini"
            if value.startswith("nvidia"):
                return "nvidia"
            if value.startswith("qwen"):
                return "qwen"
            return value.split(":", 1)[0]

        preferred_family = provider_family(preferred_provider) if preferred_provider else ""
        default_order = {"gemini": 0, "nvidia": 1, "qwen": 2}
        direct.sort(
            key=lambda item: (
                0 if preferred_family and provider_family(item.name) == preferred_family else 1,
                default_order.get(provider_family(item.name), 9),
            )
        )
        hedges: list[HedgeCandidate] = [
            HedgeCandidate(
                name=item.name,
                delay_seconds=_PROVIDER_HEDGE_DELAYS[
                    min(index, len(_PROVIDER_HEDGE_DELAYS) - 1)
                ],
                factory=item.factory,
            )
            for index, item in enumerate(direct)
        ]

        fallback_configs = [
            config
            for config in resolved
            if str(getattr(config, "model", "")) not in {gemini_model, nvidia_model, qwen_model}
        ]
        if fallback_configs:
            hedges.append(deep_candidate(fallback_configs[0], _CATALOG_HEDGE_DELAY))

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
                {"trace_kind": "call_status", "call_state": "running", "murikah_lane": "fast"},
            ),
        )

        winner = await race_first_visible(
            hedges,
            request_started=request_started,
            first_token_timeout=_FIRST_TOKEN_TIMEOUT_SECONDS,
            overall_timeout=_OVERALL_FIRST_TOKEN_SECONDS,
        )
        # One bounded hedged race is the whole first-token budget. Starting a
        # second race after the deadline made ordinary follow-ups wait 15–20s
        # before even beginning to answer. Provider failover already happens
        # inside the concurrent hedge set above.

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
        if winner.name.startswith("gemini:"):
            winner_model = gemini_model
        elif winner.name.startswith("nvidia-fast:"):
            winner_model = nvidia_model
        elif winner.name.startswith("qwen-fast:"):
            winner_model = qwen_model
        else:
            winner_model = winner.name.split(":", 1)[1] if ":" in winner.name else ""
        context.metadata["murikah_model"] = winner_model
        context.metadata["murikah_first_token_ms"] = winner.first_token_ms
        stream_started = time.perf_counter()
        turn_timeout_seconds = (
            _LONG_FAST_TURN_TIMEOUT_SECONDS
            if output_token_budget > _FAST_OUTPUT_TOKENS
            else _FAST_TURN_TIMEOUT_SECONDS
        )
        turn_deadline = request_started + turn_timeout_seconds

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
            try:
                while True:
                    remaining = turn_deadline - time.perf_counter()
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
            remaining_turn = turn_deadline - time.perf_counter()
            if remaining_turn <= 0.75:
                break
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
            recovery_direct: list[HedgeCandidate] = []
            if gemini_on:
                recovery_direct.append(
                    HedgeCandidate(
                        name=f"gemini-continuation:{gemini_model}",
                        delay_seconds=0.0,
                        factory=lambda recovery_messages=recovery_messages: gemini_stream(
                            recovery_messages,
                            max_tokens=output_token_budget,
                        ),
                    )
                )
            if nvidia_on:
                recovery_direct.append(
                    HedgeCandidate(
                        name=f"nvidia-continuation:{nvidia_model}",
                        delay_seconds=0.0,
                        factory=lambda recovery_messages=recovery_messages: nvidia_stream(
                            recovery_messages,
                            max_tokens=output_token_budget,
                        ),
                    )
                )
            if qwen_on:
                recovery_direct.append(
                    HedgeCandidate(
                        name=f"qwen-continuation:{qwen_model}",
                        delay_seconds=0.0,
                        factory=lambda recovery_messages=recovery_messages: qwen_stream(
                            recovery_messages,
                            max_tokens=output_token_budget,
                        ),
                    )
                )

            winner_family = provider_family(winner.name)
            recovery_direct.sort(
                key=lambda item: (
                    0 if provider_family(item.name) == winner_family else 1,
                    default_order.get(provider_family(item.name), 9),
                )
            )
            recovery_hedges: list[HedgeCandidate] = [
                HedgeCandidate(
                    name=item.name,
                    delay_seconds=(0.0, 0.35, 0.7)[min(index, 2)],
                    factory=item.factory,
                )
                for index, item in enumerate(recovery_direct)
            ]
            if fallback_configs:
                recovery_config = fallback_configs[0]
                recovery_name = (
                    f"{recovery_config.provider_name or recovery_config.binding or 'provider'}:"
                    f"{recovery_config.model}"
                )
                recovery_hedges.append(
                    HedgeCandidate(
                        name=f"catalog-continuation:{recovery_name}",
                        delay_seconds=0.9,
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
                            max_tokens=output_token_budget,
                            stream_coalesce_chars=24,
                            stream_coalesce_seconds=0.02,
                        ),
                    )
                )

            recovery_started = time.perf_counter()
            remaining_turn = max(0.0, turn_deadline - recovery_started)
            if remaining_turn <= 0.75:
                break
            recovery_winner = await race_first_visible(
                recovery_hedges,
                request_started=recovery_started,
                first_token_timeout=min(6.0, _FIRST_TOKEN_TIMEOUT_SECONDS, remaining_turn),
                overall_timeout=min(7.5, _OVERALL_FIRST_TOKEN_SECONDS, remaining_turn),
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

            # Publish the continuation as soon as it begins. Only the first
            # visible chunk is overlap-trimmed; the rest streams live instead
            # of being hidden until an entire repair segment finishes.
            continuation_head = trim_continuation_overlap(
                answer,
                recovery_winner.first_chunk,
            )
            if answer and continuation_head and not continuation_head[0].isspace():
                if (
                    answer[-1:].isalnum()
                    and continuation_head[0].isalnum()
                ) or (
                    answer[-1:] in ",;:.!?)]}"
                    and continuation_head[0].isalnum()
                ):
                    continuation_head = " " + continuation_head
            if continuation_head:
                answer += continuation_head
                await stream.content(
                    continuation_head,
                    source="chat",
                    stage="responding",
                    metadata=recovery_meta,
                )

            recovery_tail, recovery_finish_reason, recovery_failure = await collect_remaining(
                recovery_winner,
                publish=True,
                metadata=recovery_meta,
            )
            if recovery_tail:
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

        context.metadata["murikah_incomplete"] = bool(incomplete)
        if incomplete:
            logger.warning(
                "MURIKAH_LATENCY route=fast event=terminal_incomplete_response finish_reason=%s failure=%s continuations=%s elapsed_ms=%s",
                finish_reason or "unknown",
                stream_failure or "none",
                continuation_count,
                latency_ms(request_started),
            )
            interruption_note = (
                "\n\n*The response was interrupted. Send “continue” and I’ll pick up from here.*"
            )
            answer += interruption_note
            await stream.content(
                interruption_note,
                source="chat",
                stage="responding",
                metadata=merge_trace_metadata(
                    trace_meta,
                    {
                        "trace_kind": "llm_chunk",
                        "murikah_lane": "fast",
                        "interrupted": True,
                    },
                ),
            )

        context.capability_output.agent_output = answer
        context.capability_output.answer_published = True
        total_ms = latency_ms(request_started)
        context.metadata["murikah_stream_ms"] = latency_ms(stream_started)
        context.metadata["murikah_total_ms"] = total_ms
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
            context.metadata["murikah_lane"] = "deep_agent"
            context.metadata["murikah_route_reason"] = reason
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
        context.metadata["murikah_lane"] = "fast"
        context.metadata["murikah_route_reason"] = "ordinary_chat"
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
