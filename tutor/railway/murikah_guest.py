"""Public, bounded Murikah Tutor guest preview.

The preview is deliberately separate from DeepTutor sessions: no workspace,
files, tools, memory, RAG or persisted conversation is exposed before sign-in.
A signed HttpOnly cookie tracks the guest allowance without creating a local
account.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
from typing import Literal

from fastapi import APIRouter, Cookie, HTTPException, Response, status
from pydantic import BaseModel, Field

from deeptutor.services.auth import AUTH_SECRET
from deeptutor.services.llm import get_llm_client

router = APIRouter()

_COOKIE_NAME = "mt_guest"
_DEFAULT_LIMIT = 7
_MAX_PROMPT_CHARS = 6000
_MAX_HISTORY_ITEMS = 6
_MAX_CONFIGURATION_ITEMS = 24
_MAX_CONFIGURATION_VALUE_CHARS = 500
_SYSTEM_PROMPT = """You are Murikah Tutor, an AI-powered personalised learning companion.
Teach clearly and rigorously. Start with intuition, then formal reasoning when useful,
then a concrete example or application. Adapt depth to the learner's apparent level.
Answer direct questions directly. This is a bounded guest experience, so do not claim
that conversation history, files, preferences, progress, memory, tools, browsing, or
connected knowledge sources are being saved or used when they are not."""

ModeName = Literal[
    "chat",
    "questions",
    "quiz",
    "research",
    "visualize",
    "solve",
    "course",
    "mastery",
    "reading",
    "watching",
]
SpaceName = Literal[
    "home",
    "partners",
    "agents",
    "cowriter",
    "book",
    "mastery",
    "reading",
    "learning-space",
    "memory",
    "knowledge",
]
GuestConfigValue = str | bool | int | float

_MODE_GUIDANCE: dict[str, str] = {
    "chat": "Use a flexible conversational tutoring style and follow the learner's intent.",
    "questions": "Lead mainly by asking one useful question at a time, then use the learner's answer to probe gaps and deepen understanding.",
    "quiz": "Create a compact quiz or practice sequence, let the learner answer, then give clear feedback and corrections rather than dumping all answers up front.",
    "research": "Structure the topic into claims, evidence, uncertainties, counterpoints, and next research steps. Do not claim live web browsing or source retrieval in guest mode.",
    "visualize": "Prefer diagrams, tables, comparisons, flows, timelines, or Mermaid-style structures when they make the idea easier to see.",
    "solve": "Work through the problem step by step, surface assumptions, show the reasoning, and check the result.",
    "course": "Treat the prompt as course study: identify the objective, explain the core idea, give an example, and finish with a short check for understanding.",
    "mastery": "Turn the goal into a staged mastery path with prerequisites, deliberate practice, checkpoints, and a clear next action.",
    "reading": "Use an immersive reading loop: clarify the passage, explain difficult ideas, ask recall or interpretation questions, and connect the text to the larger topic.",
    "watching": "Use an immersive watching style based only on the video topic or transcript the learner provides. Build checkpoints, questions, and summaries without claiming direct video access in guest mode.",
}

_SPACE_GUIDANCE: dict[str, str] = {
    "home": "No additional workspace lens is needed.",
    "partners": "Use a collaborative Partner-style tutoring approach and honor the guest-selected Partner identity, persona, model preference, tools, assets, and channel settings as behavioural guidance. Do not claim external channels, private assets, or tools were actually connected or executed.",
    "agents": "Use an agent-like planning and execution style and honor the selected role, autonomy, planning, self-check, tool and session-context settings. Do not claim external tools were actually executed.",
    "cowriter": "Act as a focused co-writer and honor the selected task, tone, audience, revision and challenge settings while preserving the learner's intent.",
    "book": "Treat the interaction as book study and honor the selected study style, depth and learning controls. Work from any passage or book context the learner provides and avoid implying access to an unprovided full text.",
    "mastery": "Keep the interaction oriented to staged mastery, practice and measurable checkpoints, following the selected level, pace, timeframe and adaptation settings.",
    "reading": "Keep the interaction oriented to close reading, comprehension, interpretation and recall, following the selected reading level, mode and reading controls.",
    "learning-space": "Frame the session around the selected objective, session length, teaching style, pace, examples, practice and assessment controls.",
    "memory": "Demonstrate personalised tutoring from the current conversation only and honor the selected personalisation settings. Do not claim saved memory exists before sign-in.",
    "knowledge": "Synthesize the learner's topic and any text they provide using the selected synthesis, depth, citation and comparison controls. Do not claim access to private knowledge libraries before sign-in.",
}


class GuestMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=6000)


class GuestChatRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=_MAX_PROMPT_CHARS)
    history: list[GuestMessage] = Field(default_factory=list, max_length=_MAX_HISTORY_ITEMS)
    mode: ModeName = "chat"
    space: SpaceName = "home"
    configuration: dict[str, GuestConfigValue] = Field(default_factory=dict, max_length=_MAX_CONFIGURATION_ITEMS)


def _limit() -> int:
    try:
        return max(1, min(7, int(os.getenv("MURIKAH_GUEST_PROMPT_LIMIT", str(_DEFAULT_LIMIT)))))
    except ValueError:
        return _DEFAULT_LIMIT


def _secret() -> bytes:
    if not AUTH_SECRET:
        raise RuntimeError("Murikah guest preview requires authentication to be enabled")
    return AUTH_SECRET.encode("utf-8")


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _sign_count(count: int) -> str:
    payload = json.dumps({"v": 1, "count": count}, separators=(",", ":")).encode("utf-8")
    encoded = _b64(payload)
    signature = _b64(hmac.new(_secret(), encoded.encode("ascii"), hashlib.sha256).digest())
    return f"{encoded}.{signature}"


def _read_count(raw: str | None) -> int:
    if not raw or "." not in raw:
        return 0
    encoded, supplied = raw.rsplit(".", 1)
    expected = _b64(hmac.new(_secret(), encoded.encode("ascii"), hashlib.sha256).digest())
    if not hmac.compare_digest(supplied, expected):
        return 0
    try:
        padded = encoded + "=" * (-len(encoded) % 4)
        data = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
        return max(0, int(data.get("count", 0)))
    except Exception:
        return 0


def _set_count(response: Response, count: int) -> None:
    response.set_cookie(
        key=_COOKIE_NAME,
        value=_sign_count(count),
        httponly=True,
        secure=True,
        samesite="lax",
        max_age=60 * 60 * 24 * 30,
        path="/",
    )


def _configuration_guidance(configuration: dict[str, GuestConfigValue]) -> str:
    if not configuration:
        return ""

    rendered: list[str] = []
    for key, raw_value in list(configuration.items())[:_MAX_CONFIGURATION_ITEMS]:
        safe_key = " ".join(str(key).replace("_", " ").split())[:80]
        if isinstance(raw_value, bool):
            safe_value = "enabled" if raw_value else "disabled"
        else:
            safe_value = " ".join(str(raw_value).split())[:_MAX_CONFIGURATION_VALUE_CHARS]
        if safe_key and safe_value:
            rendered.append(f"- {safe_key}: {safe_value}")

    if not rendered:
        return ""

    return (
        "\n\nGuest-selected configuration for this turn (ephemeral, not persisted):\n"
        + "\n".join(rendered)
        + "\nHonor these preferences where relevant. They describe desired behaviour only; "
        "do not claim that disabled or unavailable external services, private assets, channels, "
        "browsing, memory, tools, or integrations were actually connected or executed."
    )


def _system_prompt(mode: ModeName, space: SpaceName, configuration: dict[str, GuestConfigValue]) -> str:
    return (
        f"{_SYSTEM_PROMPT}\n\n"
        f"Current learning mode: {mode}. {_MODE_GUIDANCE[mode]}\n"
        f"Current learning space: {space}. {_SPACE_GUIDANCE[space]}"
        f"{_configuration_guidance(configuration)}"
    )


@router.get("/guest-status")
async def guest_status(mt_guest: str | None = Cookie(default=None, alias=_COOKIE_NAME)) -> dict:
    used = _read_count(mt_guest)
    limit = _limit()
    return {
        "limit": limit,
        "used": min(used, limit),
        "remaining": max(0, limit - used),
        "requires_auth": used >= limit,
    }


@router.post("/guest-chat")
async def guest_chat(
    body: GuestChatRequest,
    response: Response,
    mt_guest: str | None = Cookie(default=None, alias=_COOKIE_NAME),
) -> dict:
    used = _read_count(mt_guest)
    limit = _limit()
    if used >= limit:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Guest access complete. Create an account or sign in to continue learning.",
        )

    prompt = body.prompt.strip()
    if not prompt:
        raise HTTPException(status_code=422, detail="Prompt cannot be empty")

    history = [
        {"role": item.role, "content": item.content.strip()}
        for item in body.history[-_MAX_HISTORY_ITEMS:]
        if item.content.strip()
    ]

    client = get_llm_client()
    answer = await client.complete(
        prompt,
        system_prompt=_system_prompt(body.mode, body.space, body.configuration),
        history=history,
        max_tokens=1100,
    )

    next_used = used + 1
    _set_count(response, next_used)
    return {
        "answer": str(answer),
        "used": next_used,
        "remaining": max(0, limit - next_used),
        "requires_auth": next_used >= limit,
    }
