"""Low-latency model routing shared by Murikah Tutor chat surfaces."""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
import json
import logging
import os
import time
from typing import Any
from urllib.parse import quote

import httpx

logger = logging.getLogger(__name__)

DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite"
GEMINI_API_ROOT = "https://generativelanguage.googleapis.com/v1beta"
DEFAULT_NVIDIA_FAST_MODEL = "nvidia/nemotron-3.5-lightning-30b-a3b"
DEFAULT_NVIDIA_API_ROOT = "https://integrate.api.nvidia.com/v1"
DEFAULT_HEDGE_DELAY_SECONDS = 2.5
DEFAULT_FIRST_TOKEN_TIMEOUT_SECONDS = 12.0
DEFAULT_OVERALL_FIRST_TOKEN_SECONDS = 20.0


@dataclass(frozen=True)
class HedgeCandidate:
    name: str
    delay_seconds: float
    factory: Callable[[], AsyncIterator[str]]


@dataclass
class HedgeWinner:
    name: str
    first_chunk: str
    stream: AsyncIterator[str]
    first_token_ms: int


def latency_ms(started_at: float) -> int:
    return max(0, int((time.perf_counter() - started_at) * 1000))


def configured_gemini_model() -> str:
    return os.environ.get("MURIKAH_FAST_CHAT_MODEL", "").strip() or DEFAULT_GEMINI_MODEL


def gemini_configured() -> bool:
    return bool(os.environ.get("MURIKAH_GEMINI_API_KEY", "").strip())


def configured_nvidia_model() -> str:
    return (
        os.environ.get("MURIKAH_FAST_CHAT_NVIDIA_MODEL", "").strip()
        or os.environ.get("MURIKAH_LLM_TERTIARY_MODEL", "").strip()
        or DEFAULT_NVIDIA_FAST_MODEL
    )


def nvidia_configured() -> bool:
    return bool(os.environ.get("MURIKAH_NVIDIA_NIM_API_KEY", "").strip())


def _gemini_thinking_level(model: str) -> str:
    # Gemini 3.7/3.8 do not support minimal thinking. Flash-Lite does, and is
    # the latency-critical default for normal Tutor chat.
    normalized = model.strip().lower()
    return "low" if normalized.startswith(("gemini-3.7", "gemini-3.8")) else "minimal"


def _text_content(value: Any) -> str:
    if isinstance(value, str):
        return value
    if not isinstance(value, list):
        return str(value or "")
    parts: list[str] = []
    for item in value:
        if isinstance(item, str):
            parts.append(item)
            continue
        if not isinstance(item, dict):
            continue
        if isinstance(item.get("text"), str):
            parts.append(item["text"])
        elif item.get("type") == "text" and isinstance(item.get("content"), str):
            parts.append(item["content"])
    return "\n".join(part for part in parts if part).strip()


def _gemini_payload(messages: list[dict[str, Any]], max_tokens: int) -> dict[str, Any]:
    system_parts: list[str] = []
    contents: list[dict[str, Any]] = []

    for message in messages:
        role = str(message.get("role") or "user").strip().lower()
        text = _text_content(message.get("content"))
        if not text:
            continue
        if role == "system":
            system_parts.append(text)
            continue
        gemini_role = "model" if role == "assistant" else "user"
        if contents and contents[-1].get("role") == gemini_role:
            existing_parts = contents[-1].setdefault("parts", [])
            existing_parts.append({"text": text})
        else:
            contents.append({"role": gemini_role, "parts": [{"text": text}]})

    if not contents:
        raise RuntimeError("Fast chat has no user-visible conversation content.")

    payload: dict[str, Any] = {
        "contents": contents,
        "generationConfig": {
            "maxOutputTokens": max(128, int(max_tokens)),
            "thinkingConfig": {"thinkingLevel": _gemini_thinking_level(configured_gemini_model())},
        },
    }
    if system_parts:
        payload["systemInstruction"] = {
            "parts": [{"text": "\n\n".join(system_parts)}]
        }
    return payload


def _gemini_text(event: dict[str, Any]) -> str:
    chunks: list[str] = []
    for candidate in event.get("candidates", []) or []:
        content = candidate.get("content") if isinstance(candidate, dict) else None
        if not isinstance(content, dict):
            continue
        for part in content.get("parts", []) or []:
            if not isinstance(part, dict) or part.get("thought") is True:
                continue
            text = part.get("text")
            if isinstance(text, str) and text:
                chunks.append(text)
    return "".join(chunks)


async def gemini_stream(
    messages: list[dict[str, Any]],
    *,
    max_tokens: int = 1800,
) -> AsyncIterator[str]:
    """Stream Gemini directly using SSE with low thinking for interactive chat."""
    api_key = os.environ.get("MURIKAH_GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("MURIKAH_GEMINI_API_KEY is not configured.")
    model = configured_gemini_model()
    url = (
        f"{GEMINI_API_ROOT}/models/{quote(model, safe='')}:"
        "streamGenerateContent?alt=sse"
    )
    payload = _gemini_payload(messages, max_tokens)
    request_started = time.perf_counter()
    timeout = httpx.Timeout(connect=5.0, read=None, write=15.0, pool=5.0)

    async with httpx.AsyncClient(timeout=timeout) as client:
        async with client.stream(
            "POST",
            url,
            headers={
                "x-goog-api-key": api_key,
                "content-type": "application/json",
                "accept": "text/event-stream",
            },
            json=payload,
        ) as response:
            response.raise_for_status()
            logger.info(
                "MURIKAH_LATENCY route=fast provider=gemini event=headers model=%s elapsed_ms=%s",
                model,
                latency_ms(request_started),
            )
            async for line in response.aiter_lines():
                if not line.startswith("data:"):
                    continue
                raw = line[5:].strip()
                if not raw or raw == "[DONE]":
                    continue
                try:
                    event = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                text = _gemini_text(event)
                if text:
                    yield text


def _nvidia_payload(messages: list[dict[str, Any]], max_tokens: int) -> dict[str, Any]:
    normalized_messages: list[dict[str, str]] = []
    for message in messages:
        role = str(message.get("role") or "user").strip().lower()
        if role not in {"system", "user", "assistant"}:
            role = "user"
        content = _text_content(message.get("content"))
        if content:
            normalized_messages.append({"role": role, "content": content})
    if not normalized_messages:
        raise RuntimeError("Fast chat has no user-visible conversation content.")
    return {
        "model": configured_nvidia_model(),
        "messages": normalized_messages,
        "stream": True,
        "max_tokens": max(128, int(max_tokens)),
        "temperature": 0.2,
        "top_p": 0.7,
        # Nemotron Lightning can answer directly without spending the user's
        # latency budget on hidden reasoning for ordinary conversational turns.
        "chat_template_kwargs": {"enable_thinking": False},
    }


async def nvidia_stream(
    messages: list[dict[str, Any]],
    *,
    max_tokens: int = 1800,
) -> AsyncIterator[str]:
    """Stream the existing NVIDIA NIM fallback directly for low-latency chat."""
    api_key = os.environ.get("MURIKAH_NVIDIA_NIM_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("NVIDIA NIM is not configured.")
    base_url = (
        os.environ.get("MURIKAH_NVIDIA_NIM_BASE_URL", "").strip()
        or DEFAULT_NVIDIA_API_ROOT
    ).rstrip("/")
    model = configured_nvidia_model()
    request_started = time.perf_counter()
    timeout = httpx.Timeout(connect=5.0, read=None, write=15.0, pool=5.0)

    async with httpx.AsyncClient(timeout=timeout) as client:
        async with client.stream(
            "POST",
            f"{base_url}/chat/completions",
            headers={
                "authorization": f"Bearer {api_key}",
                "content-type": "application/json",
                "accept": "text/event-stream",
            },
            json=_nvidia_payload(messages, max_tokens),
        ) as response:
            response.raise_for_status()
            logger.info(
                "MURIKAH_LATENCY route=fast provider=nvidia event=headers model=%s elapsed_ms=%s",
                model,
                latency_ms(request_started),
            )
            async for line in response.aiter_lines():
                if not line.startswith("data:"):
                    continue
                raw = line[5:].strip()
                if not raw or raw == "[DONE]":
                    continue
                try:
                    event = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if event.get("error"):
                    raise RuntimeError("Tutor provider is temporarily unavailable.")
                for choice in event.get("choices", []) or []:
                    if not isinstance(choice, dict):
                        continue
                    delta = choice.get("delta")
                    if not isinstance(delta, dict):
                        continue
                    text = delta.get("content")
                    if isinstance(text, str) and text:
                        yield text


async def close_stream(stream: AsyncIterator[str] | None) -> None:
    if stream is None:
        return
    closer = getattr(stream, "aclose", None)
    if closer is None:
        return
    try:
        await closer()
    except Exception:
        pass


async def _next_visible(stream: AsyncIterator[str]) -> str:
    in_think = False
    async for chunk in stream:
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
    raise StopAsyncIteration


async def race_first_visible(
    candidates: list[HedgeCandidate],
    *,
    request_started: float,
    first_token_timeout: float = DEFAULT_FIRST_TOKEN_TIMEOUT_SECONDS,
    overall_timeout: float = DEFAULT_OVERALL_FIRST_TOKEN_SECONDS,
) -> HedgeWinner | None:
    """Hedge providers and keep the first one that produces visible text.

    A delayed candidate must receive the same first-token allowance as the
    primary candidate. Previously the fixed race deadline cut the last
    fallback's allowance short, which was most visible on follow-up turns.
    """
    if not candidates:
        return None

    latest_start = max(max(0.0, candidate.delay_seconds) for candidate in candidates)
    effective_overall_timeout = max(
        max(0.0, overall_timeout),
        latest_start + max(0.0, first_token_timeout) + 0.5,
    )

    async def probe(candidate: HedgeCandidate) -> HedgeWinner | None:
        stream: AsyncIterator[str] | None = None
        keep_open = False
        try:
            if candidate.delay_seconds > 0:
                await asyncio.sleep(candidate.delay_seconds)
            logger.info(
                "MURIKAH_LATENCY route=fast event=provider_start provider=%s elapsed_ms=%s",
                candidate.name,
                latency_ms(request_started),
            )
            stream = candidate.factory()
            first = await asyncio.wait_for(
                _next_visible(stream),
                timeout=first_token_timeout,
            )
            if not first:
                return None
            keep_open = True
            winner = HedgeWinner(
                name=candidate.name,
                first_chunk=first,
                stream=stream,
                first_token_ms=latency_ms(request_started),
            )
            logger.info(
                "MURIKAH_LATENCY route=fast event=first_token provider=%s elapsed_ms=%s",
                candidate.name,
                winner.first_token_ms,
            )
            return winner
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning(
                "MURIKAH_LATENCY route=fast event=provider_failed provider=%s elapsed_ms=%s type=%s",
                candidate.name,
                latency_ms(request_started),
                type(exc).__name__,
            )
            return None
        finally:
            if stream is not None and not keep_open:
                await close_stream(stream)

    tasks = {asyncio.create_task(probe(candidate)) for candidate in candidates}
    deadline = time.perf_counter() + effective_overall_timeout
    try:
        pending = set(tasks)
        while pending:
            remaining = deadline - time.perf_counter()
            if remaining <= 0:
                break
            done, pending = await asyncio.wait(
                pending,
                timeout=remaining,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if not done:
                break
            winners: list[HedgeWinner] = []
            for task in done:
                try:
                    result = task.result()
                except Exception:
                    result = None
                if result is not None:
                    winners.append(result)
            if winners:
                winner = min(winners, key=lambda item: item.first_token_ms)
                for extra in winners:
                    if extra is not winner:
                        await close_stream(extra.stream)
                for task in pending:
                    task.cancel()
                await asyncio.gather(*pending, return_exceptions=True)
                return winner
        return None
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
