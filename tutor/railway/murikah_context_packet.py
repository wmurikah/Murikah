"""Compact conversation context and provider affinity for Murikah fast chat."""
from __future__ import annotations

from collections import OrderedDict
import asyncio
import re
import threading
import time
from typing import Any

MAX_PACKETS = 512
DEFAULT_PACKET_CHARS = 16000
DEFAULT_RECENT_TURNS = 4

_lock = threading.Lock()
_packets: "OrderedDict[str, dict[str, Any]]" = OrderedDict()


def _text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = []
        for item in value:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                item_text = item.get("text") or item.get("content")
                if isinstance(item_text, str):
                    parts.append(item_text)
        return "\n".join(parts)
    return str(value or "")


def _clean_messages(messages: list[dict[str, Any]]) -> list[dict[str, str]]:
    cleaned: list[dict[str, str]] = []
    for item in messages:
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or "").lower().strip()
        if role not in {"system", "user", "assistant"}:
            continue
        text = _text(item.get("content")).strip()
        if text:
            cleaned.append({"role": role, "content": text})
    return cleaned


def _short(text: str, limit: int = 420) -> str:
    value = re.sub(r"\s+", " ", str(text or "")).strip()
    if len(value) <= limit:
        return value
    return value[: max(1, limit - 1)].rstrip() + "…"


def _build_summary(older: list[dict[str, str]], max_chars: int) -> str:
    if not older:
        return ""
    lines = ["Conversation summary:"]
    for item in older[-12:]:
        label = "Learner" if item["role"] == "user" else "Tutor"
        lines.append(f"- {label}: {_short(item['content'])}")
        if sum(len(line) for line in lines) >= max_chars:
            break
    return "\n".join(lines)[:max_chars]


def build_context_packet(
    messages: list[dict[str, Any]],
    *,
    max_chars: int = DEFAULT_PACKET_CHARS,
    recent_turns: int = DEFAULT_RECENT_TURNS,
) -> list[dict[str, str]]:
    """Return a compact provider-portable context packet.

    Keep system instructions, a compact summary of older conversation, and the
    newest user/assistant exchanges. The newest learner turn is never dropped.
    """
    cleaned = _clean_messages(messages)
    system = [m for m in cleaned if m["role"] == "system"]
    conversation = [m for m in cleaned if m["role"] != "system"]
    if not conversation:
        return system[-1:] if system else []

    recent_messages = max(2, recent_turns * 2)
    recent = conversation[-recent_messages:]
    older = conversation[:-recent_messages]

    sys_text = system[-1]["content"] if system else ""
    sys_budget = min(5000, max(2500, max_chars // 4))
    summary_budget = min(5000, max(2000, max_chars // 3))
    packet: list[dict[str, str]] = []
    if sys_text:
        packet.append({"role": "system", "content": sys_text[:sys_budget]})
    summary = _build_summary(older, summary_budget)
    if summary:
        packet.append(
            {
                "role": "system",
                "content": (
                    "Use this compact summary only as conversation memory. "
                    "Prefer the recent verbatim turns when there is any conflict.\n"
                    + summary
                ),
            }
        )

    reserved = sum(len(x["content"]) for x in packet)
    remaining = max(4000, max_chars - reserved)
    selected: list[dict[str, str]] = []
    used = 0
    for item in reversed(recent):
        size = len(item["content"])
        if selected and used + size > remaining:
            break
        if not selected and size > remaining:
            item = {**item, "content": item["content"][-remaining:]}
            size = len(item["content"])
        selected.append(item)
        used += size
    selected.reverse()
    return [*packet, *selected]


def get_cached_packet(conversation_id: str) -> dict[str, Any] | None:
    key = str(conversation_id or "").strip()
    if not key:
        return None
    with _lock:
        value = _packets.get(key)
        if value is None:
            return None
        _packets.move_to_end(key)
        return dict(value)


def provider_affinity(conversation_id: str) -> str:
    cached = get_cached_packet(conversation_id)
    return str((cached or {}).get("provider") or "")


def remember_completed_turn(
    conversation_id: str,
    messages: list[dict[str, Any]],
    answer: str,
    provider: str,
) -> None:
    key = str(conversation_id or "").strip()
    if not key:
        return
    enriched = [*messages, {"role": "assistant", "content": str(answer or "")}]
    packet = build_context_packet(enriched)
    value = {
        "messages": packet,
        "provider": str(provider or ""),
        "updated_at": time.time(),
        "chars": sum(len(item["content"]) for item in packet),
    }
    with _lock:
        _packets[key] = value
        _packets.move_to_end(key)
        while len(_packets) > MAX_PACKETS:
            _packets.popitem(last=False)


async def prepare_next_context(
    conversation_id: str,
    messages: list[dict[str, Any]],
    answer: str,
    provider: str,
) -> None:
    """Build the next-turn packet outside the learner-facing critical path."""
    await asyncio.to_thread(
        remember_completed_turn,
        conversation_id,
        messages,
        answer,
        provider,
    )
