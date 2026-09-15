#!/usr/bin/env python3
"""Patch DeepTutor's ordinary authenticated chat for low-latency streaming.

The full agent loop remains available whenever the learner explicitly enables
or attaches capabilities that require tools, knowledge bases, or files. Plain
Chat uses the same DeepTutor prompt assembly and selected model catalog, but
starts a direct streamed completion immediately and falls back to the other
already-configured models only when no visible first token arrives promptly.
"""
from __future__ import annotations

from pathlib import Path
import sys


MARKER = "MURIKAH_FAST_CHAT_FIRST_TOKEN"

OLD_IMPORTS = '''from deeptutor.agents.chat.agentic_pipeline import CHAT_OPTIONAL_TOOLS, AgenticChatPipeline
from deeptutor.core.capability_protocol import CapabilityManifest, TurnCapability
from deeptutor.core.context import UnifiedContext
from deeptutor.runtime.request_contracts import get_capability_request_schema
from deeptutor.runtime.stream_bus import StreamBus
'''

NEW_IMPORTS = '''import asyncio
import logging
from typing import Any

from deeptutor.agents._shared.capability_result import emit_capability_result
from deeptutor.agents.chat.agentic_pipeline import CHAT_OPTIONAL_TOOLS, AgenticChatPipeline
from deeptutor.core.capability_protocol import CapabilityManifest, TurnCapability
from deeptutor.core.context import UnifiedContext
from deeptutor.core.trace import build_trace_metadata, merge_trace_metadata, new_call_id
from deeptutor.runtime.request_contracts import get_capability_request_schema
from deeptutor.runtime.stream_bus import StreamBus
from deeptutor.services.config import get_model_catalog_service
from deeptutor.services.llm import factory as llm_factory
from deeptutor.services.model_selection.llm import list_llm_options
from deeptutor.services.model_selection.runtime import resolve_llm_config_for_selection

logger = logging.getLogger(__name__)

# MURIKAH_FAST_CHAT_FIRST_TOKEN
_FIRST_TOKEN_BUDGETS = (8.0, 5.0, 5.0)
_STREAM_IDLE_TIMEOUT_SECONDS = 25.0
'''

OLD_RUN = '''    async def run(self, context: UnifiedContext, stream: StreamBus) -> None:
        pipeline = AgenticChatPipeline(language=context.language)
        await pipeline.run(context, stream)
'''

NEW_RUN = '''    @staticmethod
    def _requires_agent_loop(context: UnifiedContext) -> bool:
        """Keep DeepTutor's full agent loop when the turn actually needs it."""
        return bool(
            context.enabled_tools
            or context.knowledge_bases
            or context.attachments
            or context.source_manifest
            or context.skills_manifest
            or context.metadata.get("source_index")
            or context.metadata.get("mastery_mode")
            or context.metadata.get("immersive_reading_mode")
            or context.metadata.get("question_bank_context")
        )

    @staticmethod
    def _candidate_selections(context: UnifiedContext) -> list[dict[str, str]]:
        """Selected model first, then catalog default and remaining configured models."""
        candidates: list[dict[str, str]] = []

        def add(value: Any) -> None:
            if not isinstance(value, dict):
                return
            profile_id = str(value.get("profile_id") or "").strip()
            model_id = str(value.get("model_id") or "").strip()
            if not profile_id or not model_id:
                return
            candidate = {"profile_id": profile_id, "model_id": model_id}
            reasoning_effort = str(value.get("reasoning_effort") or "").strip().lower()
            if reasoning_effort:
                candidate["reasoning_effort"] = reasoning_effort
            if not any(
                item.get("profile_id") == profile_id and item.get("model_id") == model_id
                for item in candidates
            ):
                candidates.append(candidate)

        add((context.metadata or {}).get("llm_selection"))
        try:
            options = list_llm_options(get_model_catalog_service().load())
        except Exception:
            options = {"active": None, "options": []}
        add(options.get("active"))
        for item in options.get("options", []) or []:
            add(item)
        return candidates

    @staticmethod
    async def _next_visible_chunk(iterator: Any, timeout: float) -> str:
        """Return the next user-visible chunk, hiding provider reasoning blocks."""
        in_think = False
        deadline = asyncio.get_running_loop().time() + timeout
        while True:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                raise asyncio.TimeoutError
            chunk = await asyncio.wait_for(iterator.__anext__(), timeout=remaining)
            text = str(chunk or "")
            if text == "<think>":
                in_think = True
                continue
            if text == "</think>":
                in_think = False
                continue
            if in_think or not text:
                continue
            return text

    async def _run_fast_chat(self, context: UnifiedContext, stream: StreamBus) -> None:
        # Reuse DeepTutor's own prompt assembler and conversation formatting so
        # direct Chat keeps persona, memory, sidebar context and compressed
        # history. Only tool exploration is skipped for a plain chat turn.
        prompt_pipeline = AgenticChatPipeline(language=context.language)
        messages = prompt_pipeline._build_loop_messages(
            context=context,
            enabled_tools=[],
            include_tool_manifest=False,
        )

        candidates = self._candidate_selections(context)
        if not candidates:
            # Defensive fallback: preserve upstream behaviour if the catalog is
            # unexpectedly unavailable rather than inventing a provider config.
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
                {"trace_kind": "call_status", "call_state": "running"},
            ),
        )

        chosen_stream: Any | None = None
        first_chunk = ""
        chosen_model = ""
        last_error: Exception | None = None

        for attempt, candidate in enumerate(candidates[: len(_FIRST_TOKEN_BUDGETS)]):
            candidate_stream: Any | None = None
            try:
                config = resolve_llm_config_for_selection(candidate)
                candidate_stream = llm_factory.stream(
                    prompt="",
                    system_prompt="",
                    model=config.model,
                    api_key=config.api_key,
                    base_url=config.effective_url or config.base_url,
                    api_version=config.api_version,
                    binding=config.provider_name or config.binding,
                    messages=messages,
                    max_retries=0,
                    reasoning_effort=config.reasoning_effort,
                    extra_headers=config.extra_headers,
                    max_tokens=min(2400, prompt_pipeline.respond_max_tokens),
                    stream_coalesce_chars=24,
                    stream_coalesce_seconds=0.02,
                )
                first_chunk = await self._next_visible_chunk(
                    candidate_stream,
                    _FIRST_TOKEN_BUDGETS[attempt],
                )
                chosen_stream = candidate_stream
                chosen_model = str(config.model or candidate.get("model_id") or "")
                logger.info(
                    "Murikah fast chat started model=%s attempt=%s",
                    chosen_model,
                    attempt + 1,
                )
                break
            except (asyncio.TimeoutError, StopAsyncIteration) as exc:
                last_error = exc
                logger.warning(
                    "Murikah fast chat first-token timeout model=%s attempt=%s",
                    candidate.get("model_id", "unknown"),
                    attempt + 1,
                )
            except Exception as exc:
                last_error = exc
                logger.warning(
                    "Murikah fast chat provider failed model=%s attempt=%s type=%s",
                    candidate.get("model_id", "unknown"),
                    attempt + 1,
                    type(exc).__name__,
                )
            finally:
                if chosen_stream is not candidate_stream and candidate_stream is not None:
                    try:
                        await candidate_stream.aclose()
                    except Exception:
                        pass

        if chosen_stream is None or not first_chunk:
            await stream.progress(
                "",
                source="chat",
                stage="responding",
                metadata=merge_trace_metadata(
                    trace_meta,
                    {
                        "trace_kind": "call_status",
                        "call_state": "failed",
                        "error_code": "provider_timeout",
                        "retryable": True,
                    },
                ),
            )
            if last_error is not None:
                raise RuntimeError("No configured Tutor model produced a timely response") from last_error
            raise RuntimeError("No configured Tutor model produced a timely response")

        answer_parts = [first_chunk]
        chunk_meta = merge_trace_metadata(trace_meta, {"trace_kind": "llm_chunk"})
        await stream.content(
            first_chunk,
            source="chat",
            stage="responding",
            metadata=chunk_meta,
        )

        # Once the first visible text is on screen, keep streaming that same
        # response. A post-first-token stall is surfaced as a transport failure
        # instead of silently replaying another model and duplicating prose.
        in_think = False
        try:
            while True:
                try:
                    chunk = await asyncio.wait_for(
                        chosen_stream.__anext__(),
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
                await stream.content(
                    text,
                    source="chat",
                    stage="responding",
                    metadata=chunk_meta,
                )
        finally:
            try:
                await chosen_stream.aclose()
            except Exception:
                pass

        answer = "".join(answer_parts).strip()
        context.capability_output.agent_output = answer
        context.capability_output.answer_published = True
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
                    "murikah_fast_chat": True,
                    "model": chosen_model,
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
            },
            source="chat",
        )

    async def run(self, context: UnifiedContext, stream: StreamBus) -> None:
        if self._requires_agent_loop(context):
            pipeline = AgenticChatPipeline(language=context.language)
            await pipeline.run(context, stream)
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
        print("[Murikah Tutor] Fast authenticated chat already applied.")
        return 0
    try:
        text = replace_once(text, OLD_IMPORTS, NEW_IMPORTS, "chat capability imports")
        text = replace_once(text, OLD_RUN, NEW_RUN, "chat capability run method")
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    target.write_text(text, encoding="utf-8")
    print("[Murikah Tutor] Added fast first-token authenticated Chat path.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
