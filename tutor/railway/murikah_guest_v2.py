"""Public Murikah Tutor guest experience with authenticated handoff.

Guest turns remain bounded by the signed ``mt_guest`` cookie. Interface actions
(sidebar, learning mode, upload selection, persona, voice and model selection)
do not consume the allowance; only successful calls to ``/guest-chat`` do.

When a learner signs in, ``/guest-handoff`` imports the visible guest transcript
into the authenticated DeepTutor session store so the conversation continues
instead of restarting.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
from typing import Any, Literal

from fastapi import APIRouter, Cookie, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field

from deeptutor.api.routers.auth import require_auth
from deeptutor.services.auth import AUTH_SECRET
from deeptutor.services.config import get_model_catalog_service
from deeptutor.services.llm.client import LLMClient
from deeptutor.services.model_selection.llm import LLMSelection, list_llm_options
from deeptutor.services.model_selection.runtime import resolve_llm_config_for_selection
from deeptutor.services.session import get_session_store

router = APIRouter()

_COOKIE_NAME = "mt_guest"
_DEFAULT_LIMIT = 7
_MAX_PROMPT_CHARS = 6000
_MAX_HISTORY_ITEMS = 12
_MAX_HANDOFF_MESSAGES = 24
_MAX_CONFIGURATION_ITEMS = 32
_MAX_CONFIGURATION_VALUE_CHARS = 800
_MAX_ATTACHMENT_ITEMS = 4
_MAX_ATTACHMENT_TEXT_CHARS = 12000
_SYSTEM_PROMPT = """You are Murikah Tutor, an AI-powered personalised learning companion.
Teach clearly and rigorously. Start with intuition, then formal reasoning when useful,
then a concrete example or application. Adapt depth to the learner's apparent level.
Answer direct questions directly. This is a bounded guest experience. Guest transcript
state is retained in the learner's browser and can be imported after sign-in, but do
not claim persistent account memory, connected private sources, browsing or external
tools unless they are actually available in this request."""

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
    "partners": "Use a collaborative Partner-style tutoring approach and honor the guest-selected Partner identity, persona, tools, assets and channel settings as behavioural guidance. Do not claim external channels, private assets or tools were actually connected or executed.",
    "agents": "Use an agent-like planning and execution style and honor the selected role, autonomy, planning, self-check, tool and session-context settings. Do not claim external tools were actually executed.",
    "cowriter": "Act as a focused co-writer and honor the selected task, tone, audience, revision and challenge settings while preserving the learner's intent.",
    "book": "Treat the interaction as book study and honor the selected study style, depth and learning controls. Work from any passage or book context the learner provides and avoid implying access to an unprovided full text.",
    "mastery": "Keep the interaction oriented to staged mastery, practice and measurable checkpoints, following the selected level, pace, timeframe and adaptation settings.",
    "reading": "Keep the interaction oriented to close reading, comprehension, interpretation and recall, following the selected reading level, mode and reading controls.",
    "learning-space": "Frame the session around the selected objective, session length, teaching style, pace, examples, practice and assessment controls.",
    "memory": "Demonstrate personalised tutoring from the current conversation only and honor the selected personalisation settings. Do not claim saved account memory exists before sign-in.",
    "knowledge": "Synthesize the learner's topic and any text they provide using the selected synthesis, depth, citation and comparison controls. Do not claim access to private knowledge libraries before sign-in.",
}


class GuestMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=12000)


class GuestLLMSelection(BaseModel):
    profile_id: str = Field(min_length=1, max_length=200)
    model_id: str = Field(min_length=1, max_length=200)
    reasoning_effort: str | None = Field(default=None, max_length=24)


class GuestTextAttachment(BaseModel):
    name: str = Field(min_length=1, max_length=240)
    text: str = Field(min_length=1, max_length=_MAX_ATTACHMENT_TEXT_CHARS)


class GuestChatRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=_MAX_PROMPT_CHARS)
    history: list[GuestMessage] = Field(default_factory=list, max_length=_MAX_HISTORY_ITEMS)
    mode: ModeName = "chat"
    space: SpaceName = "home"
    configuration: dict[str, GuestConfigValue] = Field(default_factory=dict, max_length=_MAX_CONFIGURATION_ITEMS)
    persona: str = Field(default="", max_length=1200)
    llm_selection: GuestLLMSelection | None = None
    attachments: list[GuestTextAttachment] = Field(default_factory=list, max_length=_MAX_ATTACHMENT_ITEMS)


class GuestHandoffRequest(BaseModel):
    handoff_id: str = Field(default="", max_length=120)
    messages: list[GuestMessage] = Field(default_factory=list, max_length=_MAX_HANDOFF_MESSAGES)
    mode: ModeName = "chat"
    space: SpaceName = "home"
    configuration: dict[str, GuestConfigValue] = Field(default_factory=dict, max_length=_MAX_CONFIGURATION_ITEMS)
    persona: str = Field(default="", max_length=1200)
    llm_selection: GuestLLMSelection | None = None


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
        "\n\nGuest-selected configuration for this turn:\n"
        + "\n".join(rendered)
        + "\nHonor these preferences where relevant. They describe desired behaviour only; "
        "do not claim unavailable services or private integrations were executed."
    )


def _system_prompt(
    mode: ModeName,
    space: SpaceName,
    configuration: dict[str, GuestConfigValue],
    persona: str,
) -> str:
    persona_guidance = ""
    safe_persona = " ".join(persona.split())[:1200]
    if safe_persona:
        persona_guidance = f"\n\nLearner-selected Tutor persona: {safe_persona}\nHonor it unless it conflicts with safety or factual accuracy."
    return (
        f"{_SYSTEM_PROMPT}\n\n"
        f"Current learning mode: {mode}. {_MODE_GUIDANCE[mode]}\n"
        f"Current learning space: {space}. {_SPACE_GUIDANCE[space]}"
        f"{persona_guidance}"
        f"{_configuration_guidance(configuration)}"
    )


def _prompt_with_attachments(prompt: str, attachments: list[GuestTextAttachment]) -> str:
    if not attachments:
        return prompt
    blocks = [prompt, "\n\nText supplied by the learner for this turn:"]
    for item in attachments[:_MAX_ATTACHMENT_ITEMS]:
        text = item.text.strip()[:_MAX_ATTACHMENT_TEXT_CHARS]
        if text:
            blocks.append(f"\n--- {item.name} ---\n{text}")
    return "".join(blocks)


def _selection_payload(selection: GuestLLMSelection | None) -> dict[str, str] | None:
    if selection is None:
        return None
    payload: dict[str, str] = {
        "profile_id": selection.profile_id.strip(),
        "model_id": selection.model_id.strip(),
    }
    if selection.reasoning_effort:
        payload["reasoning_effort"] = selection.reasoning_effort.strip().lower()
    try:
        return LLMSelection.from_payload(payload).to_dict()
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def _client_for_selection(selection: GuestLLMSelection | None) -> LLMClient:
    payload = _selection_payload(selection)
    try:
        config = resolve_llm_config_for_selection(payload)
    except (KeyError, ValueError) as exc:
        raise HTTPException(status_code=422, detail="The selected model is not available.") from exc
    return LLMClient(config=config, configure_env=False)


def _handoff_title(messages: list[GuestMessage]) -> str:
    first = next((m.content.strip() for m in messages if m.role == "user" and m.content.strip()), "")
    if not first:
        return "Guest learning session"
    compact = " ".join(first.split())
    return compact[:77] + ("…" if len(compact) > 77 else "")


def _handoff_context(body: GuestHandoffRequest) -> str:
    parts = [
        "[Murikah Tutor guest session continued after sign-in]",
        f"Learning mode: {body.mode}",
        f"Learning space: {body.space}",
    ]
    if body.persona.strip():
        parts.append(f"Tutor persona preference: {' '.join(body.persona.split())[:1200]}")
    if body.configuration:
        parts.append(_configuration_guidance(body.configuration).strip())
    parts.append("Continue from the transcript below without asking the learner to repeat prior work.")
    return "\n".join(part for part in parts if part)


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


@router.get("/guest-models")
async def guest_models() -> dict[str, Any]:
    """Redacted configured model choices; credentials never leave the server."""
    try:
        payload = list_llm_options(get_model_catalog_service().load())
    except Exception:
        return {"active": None, "options": []}
    options = []
    for item in payload.get("options", []) or []:
        if not isinstance(item, dict):
            continue
        options.append(
            {
                "profile_id": str(item.get("profile_id") or ""),
                "model_id": str(item.get("model_id") or ""),
                "profile_name": str(item.get("profile_name") or ""),
                "model_name": str(item.get("model_name") or item.get("model") or "Model"),
                "provider_label": str(item.get("provider_label") or ""),
                "is_active_default": bool(item.get("is_active_default")),
                "supported_reasoning_efforts": item.get("supported_reasoning_efforts") or [],
            }
        )
    return {"active": payload.get("active"), "options": options}


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

    client = _client_for_selection(body.llm_selection)
    answer = await client.complete(
        _prompt_with_attachments(prompt, body.attachments),
        system_prompt=_system_prompt(body.mode, body.space, body.configuration, body.persona),
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


@router.post("/guest-handoff")
async def guest_handoff(
    body: GuestHandoffRequest,
    _: Any = Depends(require_auth),
) -> dict[str, str]:
    """Import a browser-retained guest transcript into the signed-in account."""
    try:
        from deeptutor.multi_user.learning_access import assert_learning_surface

        assert_learning_surface("chat")
    except PermissionError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc

    clean_messages = [
        GuestMessage(role=item.role, content=item.content.strip())
        for item in body.messages[-_MAX_HANDOFF_MESSAGES:]
        if item.content.strip()
    ]
    if not clean_messages:
        raise HTTPException(status_code=422, detail="There is no guest conversation to continue.")

    store = get_session_store()
    session = await store.create_session(title=_handoff_title(clean_messages))
    session_id = str(session.get("session_id") or session.get("id") or "").strip()
    if not session_id:
        raise HTTPException(status_code=500, detail="Could not create the continued Tutor session.")

    parent_message_id: int | str | None = await store.add_message(
        session_id=session_id,
        role="system",
        content=_handoff_context(body),
        metadata={
            "murikah_guest_handoff": True,
            "handoff_id": body.handoff_id,
            "guest_mode": body.mode,
            "guest_space": body.space,
        },
    )

    for item in clean_messages:
        parent_message_id = await store.add_message(
            session_id=session_id,
            role=item.role,
            content=item.content,
            capability="",
            metadata={"murikah_guest_handoff": True},
            parent_message_id=parent_message_id,
        )

    preferences: dict[str, Any] = {
        "murikah_guest_handoff": True,
        "murikah_guest_mode": body.mode,
        "murikah_guest_space": body.space,
        "murikah_guest_configuration": body.configuration,
    }
    selection = _selection_payload(body.llm_selection)
    if selection:
        preferences["llm_selection"] = selection
    await store.update_session_preferences(session_id, preferences)

    return {"session_id": session_id, "status": "continued"}
