"""Public, bounded Murikah Tutor guest preview.

The preview is deliberately separate from DeepTutor sessions: no workspace,
files, tools, memory, RAG or persisted conversation is exposed before sign-in.
A signed HttpOnly cookie tracks the small preview allowance without creating a
local account.
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
_DEFAULT_LIMIT = 3
_MAX_PROMPT_CHARS = 6000
_MAX_HISTORY_ITEMS = 6
_SYSTEM_PROMPT = """You are Murikah Tutor, an AI-powered personalised learning companion.
Teach clearly and rigorously. Start with intuition, then formal reasoning when useful,
then a concrete example or application. Adapt depth to the learner's apparent level.
Answer direct questions directly. This is a short guest preview, so do not claim that
conversation history, files, preferences, or progress will be saved."""


class GuestMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=6000)


class GuestChatRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=_MAX_PROMPT_CHARS)
    history: list[GuestMessage] = Field(default_factory=list, max_length=_MAX_HISTORY_ITEMS)


def _limit() -> int:
    try:
        return max(1, min(5, int(os.getenv("MURIKAH_GUEST_PROMPT_LIMIT", str(_DEFAULT_LIMIT)))))
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
            detail="Guest preview complete. Sign in or create an account to continue learning.",
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
        system_prompt=_SYSTEM_PROMPT,
        history=history,
        max_tokens=900,
    )

    next_used = used + 1
    _set_count(response, next_used)
    return {
        "answer": str(answer),
        "used": next_used,
        "remaining": max(0, limit - next_used),
        "requires_auth": next_used >= limit,
    }
