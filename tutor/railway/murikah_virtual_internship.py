"""Authenticated learner-facing API for Virtual Internship Phase 4."""
from __future__ import annotations

import json
import uuid
from typing import Any, AsyncIterator

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from deeptutor.api.routers.auth import require_auth
from deeptutor.murikah_access import check_origin
from deeptutor.services.auth import TokenPayload
from deeptutor.virtual_internship.ai.orchestrator import AIOrchestrationError, VirtualInternshipAIOrchestrator
from deeptutor.virtual_internship.state import ScenarioStateService
from deeptutor.virtual_internship.workspace import VirtualInternshipWorkspaceService

router = APIRouter()
SAFE_LOAD_ERROR = "We could not load your internship right now. Try again."
SAFE_THREAD_ERROR = "This conversation could not be loaded. Try again."
SAFE_SAVE_ERROR = "That update could not be saved. Try again."


class StartInternshipRequest(BaseModel):
    scenario_slug: str = Field(min_length=3,max_length=128)
    request_id: str = Field(min_length=3,max_length=128)


class ReflectionRequest(BaseModel):
    internship_id: str = Field(min_length=1,max_length=128)
    period_key: str = Field(min_length=1,max_length=80)
    content: str = Field(min_length=1,max_length=20000)


class MessageRequest(BaseModel):
    internship_id: str = Field(min_length=1,max_length=128)
    text: str = Field(min_length=1,max_length=8000)
    request_id: str = Field(min_length=3,max_length=128)
    task_id: str = Field(default="",max_length=128)


class ActorMessageRequest(MessageRequest):
    scenario_actor_id: str = Field(min_length=1,max_length=128)


def _identity(payload: TokenPayload) -> tuple[str,str,bool]:
    actor_id = str(getattr(payload,"user_id","") or "")
    username = str(getattr(payload,"username","") or "")
    return actor_id, username, username.startswith("guest_")


def _guest_workspace() -> dict[str,Any]:
    return {
        "state":"guest",
        "simulation":True,
        "title":"Murikah Virtual Internship",
        "description":"A persistent simulated workplace for practising real knowledge-work responsibilities over time.",
        "sections":["overview","inbox","work","company","documents","meetings","mentor","activity"],
    }


def _safe_http(exc: Exception, fallback: str = SAFE_LOAD_ERROR) -> HTTPException:
    text = str(exc)
    if "HTTP 404" in text or "not_found" in text:
        return HTTPException(404,"That internship item is not available.")
    if "HTTP 409" in text or "stopped" in text:
        return HTTPException(409,"This internship is stopped and is available in read-only mode.")
    if "HTTP 401" in text or "authentication_required" in text:
        return HTTPException(401,"Sign in to continue.")
    return HTTPException(503,fallback)


def _workspace_service() -> VirtualInternshipWorkspaceService:
    return VirtualInternshipWorkspaceService()


def _persistence():
    from deeptutor import murikah_persistence
    return murikah_persistence


def _thread_conversation(
    actor_id: str,
    internship_id: str,
    thread_id: str,
    *,
    exclude_request_id: str,
) -> list[dict[str,str]]:
    if not thread_id:
        return []
    result = _persistence().internship_ui_thread(actor_id,internship_id,thread_id)
    rows = result.get("messages") if isinstance(result,dict) else []
    conversation: list[dict[str,str]] = []
    for item in (rows if isinstance(rows,list) else [])[-24:]:
        if not isinstance(item,dict):
            continue
        request_id = str(item.get("request_id") or "")
        if request_id in {exclude_request_id,exclude_request_id + ":reply"}:
            continue
        sender = str(item.get("sender_type") or "")
        body = str(item.get("body") or "")
        if not body or sender not in {"learner","actor","mentor"}:
            continue
        conversation.append({"role":"user" if sender == "learner" else "assistant","content":body})
    return conversation


def _find_task(workspace: dict[str,Any], task_id: str) -> dict[str,Any] | None:
    for task in workspace.get("tasks",[]) if isinstance(workspace.get("tasks"),list) else []:
        if isinstance(task,dict) and str(task.get("task_id") or "") == task_id:
            return task
    return None


@router.get("/workspace")
async def workspace(
    internship_id: str = Query(default="",max_length=128),
    current: TokenPayload = Depends(require_auth),
):
    actor_id, _username, guest = _identity(current)
    if guest:
        return _guest_workspace()
    try:
        return _workspace_service().workspace(actor_id,internship_id)
    except Exception as exc:
        raise _safe_http(exc) from exc


@router.post("/start")
async def start_internship(
    body: StartInternshipRequest,
    request: Request,
    current: TokenPayload = Depends(require_auth),
):
    check_origin(request)
    actor_id, _username, guest = _identity(current)
    if guest:
        raise HTTPException(401,"Create an account or sign in to start an internship.")
    service = _workspace_service()
    try:
        allowed = {row["scenario_slug"] for row in service.start_options(actor_id)}
        if body.scenario_slug not in allowed:
            raise HTTPException(404,"That qualifying internship is not available.")
        result = _persistence().internship_start(
            actor_id,
            scenario_slug=body.scenario_slug,
            request_id=body.request_id,
        )
        internship = result.get("internship") if isinstance(result,dict) else {}
        internship_id = str((internship or {}).get("internship_id") or "")
        if not internship_id:
            raise RuntimeError("internship_start_failed")
        return service.workspace(actor_id,internship_id)
    except HTTPException:
        raise
    except Exception as exc:
        raise _safe_http(exc,"We could not start that internship right now. Try again.") from exc


@router.get("/threads/{thread_id}")
async def thread(
    thread_id: str,
    internship_id: str = Query(min_length=1,max_length=128),
    current: TokenPayload = Depends(require_auth),
):
    actor_id, _username, guest = _identity(current)
    if guest:
        raise HTTPException(401,"Sign in to use workplace conversations.")
    try:
        return _persistence().internship_ui_thread(actor_id,internship_id,thread_id)
    except Exception as exc:
        raise _safe_http(exc,SAFE_THREAD_ERROR) from exc


@router.get("/documents/{document_id}")
async def document(
    document_id: str,
    internship_id: str = Query(min_length=1,max_length=128),
    current: TokenPayload = Depends(require_auth),
):
    actor_id, _username, guest = _identity(current)
    if guest:
        raise HTTPException(401,"Sign in to view internship documents.")
    try:
        return {"ok":True,"document":_workspace_service().document(actor_id,internship_id,document_id)}
    except LookupError as exc:
        raise HTTPException(404,"That document is not available.") from exc
    except Exception as exc:
        raise _safe_http(exc) from exc


@router.post("/reflections")
async def save_reflection(
    body: ReflectionRequest,
    request: Request,
    current: TokenPayload = Depends(require_auth),
):
    check_origin(request)
    actor_id, _username, guest = _identity(current)
    if guest:
        raise HTTPException(401,"Sign in to save reflections.")
    try:
        workspace = _workspace_service().workspace(actor_id,body.internship_id)
        if workspace.get("state") != "active":
            raise HTTPException(409,"This internship is read-only.")
        return _persistence().internship_ui_reflection_save(
            actor_id,
            body.internship_id,
            period_key=body.period_key,
            content=body.content,
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise _safe_http(exc,SAFE_SAVE_ERROR) from exc


def _stored_reply(actor_id: str, internship_id: str, request_id: str) -> dict[str,Any] | None:
    try:
        result = _persistence().internship_ui_message_by_request(
            actor_id,internship_id,request_id + ":reply"
        )
        message = result.get("message") if isinstance(result,dict) else None
        return message if isinstance(message,dict) else None
    except Exception:
        return None


async def _actor_stream(
    *,
    actor_id: str,
    workspace: dict[str,Any],
    body: ActorMessageRequest,
) -> AsyncIterator[bytes]:
    persistence = _persistence()
    prior_reply = _stored_reply(actor_id,body.internship_id,body.request_id)
    if prior_reply:
        replay = str(prior_reply.get("body") or "")
        yield (json.dumps({"type":"chunk","text":replay},ensure_ascii=False) + "\n").encode()
        yield (json.dumps({"type":"final","text":replay,"message_id":str(prior_reply.get("id") or ""),"idempotent_replay":True}) + "\n").encode()
        return

    people = {
        str(person.get("actor_id") or ""):person
        for person in workspace.get("people",[])
        if isinstance(person,dict)
    }
    person = people.get(body.scenario_actor_id)
    if not person or not person.get("active"):
        yield (json.dumps({"type":"error","message":"That workplace contact is not available.","retryable":False}) + "\n").encode()
        return

    title = str(person.get("name") or person.get("job_title") or "Workplace conversation")
    existing = persistence.internship_ui_message_by_request_optional(
        actor_id,body.internship_id,body.request_id
    )
    existing_message = existing.get("message") if isinstance(existing,dict) else None
    thread_id = str((existing_message or {}).get("thread_id") or "")
    conversation = _thread_conversation(
        actor_id,body.internship_id,thread_id,exclude_request_id=body.request_id
    ) if thread_id else []

    saved = persistence.internship_ui_message_record(
        actor_id,body.internship_id,
        thread_kind="workplace",
        scenario_actor_id=body.scenario_actor_id,
        sender_type="learner",
        body=body.text,
        request_id=body.request_id,
        thread_title=title,
        related_task_id=body.task_id,
    )
    learner_message = saved.get("message") if isinstance(saved,dict) else {}
    thread_id = str((learner_message or {}).get("thread_id") or thread_id)

    orchestrator = VirtualInternshipAIOrchestrator(ScenarioStateService())
    final_text = ""
    try:
        async for event in orchestrator.stream_actor(
            owner_actor_id=actor_id,
            internship_id=body.internship_id,
            scenario_actor_id=body.scenario_actor_id,
            learner_message=body.text,
            conversation=conversation,
            task_id=body.task_id or None,
        ):
            kind = str(event.get("type") or "")
            if kind == "chunk":
                chunk = str(event.get("text") or "")
                final_text += chunk
                yield (json.dumps({"type":"chunk","text":chunk},ensure_ascii=False) + "\n").encode()
            elif kind == "error":
                yield (json.dumps({"type":"error","message":str(event.get("message") or "This workplace response is temporarily unavailable. Please try again."),"retryable":True}) + "\n").encode()
                return
            elif kind == "final":
                metadata = event.get("metadata") if isinstance(event.get("metadata"),dict) else {}
                persisted = persistence.internship_ui_message_record(
                    actor_id,body.internship_id,
                    thread_kind="workplace",
                    scenario_actor_id=body.scenario_actor_id,
                    sender_type="actor",
                    body=final_text or str(event.get("text") or ""),
                    request_id=body.request_id + ":reply",
                    thread_title=title,
                    related_task_id=body.task_id,
                    related_model_invocation_id=str(metadata.get("invocation_id") or ""),
                )
                message = persisted.get("message") if isinstance(persisted,dict) else {}
                yield (json.dumps({"type":"final","text":final_text,"message_id":str((message or {}).get("id") or "")},ensure_ascii=False) + "\n").encode()
                return
    except AIOrchestrationError as exc:
        yield (json.dumps({"type":"error","message":exc.safe_message,"retryable":True}) + "\n").encode()
    except Exception:
        yield (json.dumps({"type":"error","message":"This workplace response is temporarily unavailable. Please try again.","retryable":True}) + "\n").encode()


@router.post("/actor/messages/stream")
async def actor_message(
    body: ActorMessageRequest,
    request: Request,
    current: TokenPayload = Depends(require_auth),
):
    check_origin(request)
    actor_id, _username, guest = _identity(current)
    if guest:
        raise HTTPException(401,"Sign in to message workplace contacts.")
    try:
        workspace = _workspace_service().workspace(actor_id,body.internship_id)
        if workspace.get("state") != "active":
            raise HTTPException(409,"This internship is read-only.")
    except HTTPException:
        raise
    except Exception as exc:
        raise _safe_http(exc) from exc
    return StreamingResponse(
        _actor_stream(actor_id=actor_id,workspace=workspace,body=body),
        media_type="application/x-ndjson",
        headers={"cache-control":"no-store","x-content-type-options":"nosniff"},
    )


async def _mentor_stream(
    *,
    actor_id: str,
    workspace: dict[str,Any],
    body: MessageRequest,
) -> AsyncIterator[bytes]:
    persistence = _persistence()
    prior_reply = _stored_reply(actor_id,body.internship_id,body.request_id)
    if prior_reply:
        replay = str(prior_reply.get("body") or "")
        yield (json.dumps({"type":"chunk","text":replay},ensure_ascii=False) + "\n").encode()
        yield (json.dumps({"type":"final","text":replay,"message_id":str(prior_reply.get("id") or ""),"idempotent_replay":True}) + "\n").encode()
        return

    task = _find_task(workspace,body.task_id) if body.task_id else None
    assistance_level, assistance_label = VirtualInternshipWorkspaceService.mentor_support_level(task)
    existing = persistence.internship_ui_message_by_request_optional(
        actor_id,body.internship_id,body.request_id
    )
    existing_message = existing.get("message") if isinstance(existing,dict) else None
    thread_id = str((existing_message or {}).get("thread_id") or "")
    conversation = _thread_conversation(
        actor_id,body.internship_id,thread_id,exclude_request_id=body.request_id
    ) if thread_id else []

    saved = persistence.internship_ui_message_record(
        actor_id,body.internship_id,
        thread_kind="mentor",
        scenario_actor_id="",
        sender_type="learner",
        body=body.text,
        request_id=body.request_id,
        thread_title="Murikah Mentor",
        related_task_id=body.task_id,
    )
    learner_message = saved.get("message") if isinstance(saved,dict) else {}
    thread_id = str((learner_message or {}).get("thread_id") or thread_id)

    orchestrator = VirtualInternshipAIOrchestrator(ScenarioStateService())
    final_text = ""
    try:
        async for event in orchestrator.stream_mentor(
            owner_actor_id=actor_id,
            internship_id=body.internship_id,
            learner_question=body.text,
            assistance_level=assistance_level,
            conversation=conversation,
            task_id=body.task_id or None,
        ):
            kind = str(event.get("type") or "")
            if kind == "chunk":
                chunk = str(event.get("text") or "")
                final_text += chunk
                yield (json.dumps({"type":"chunk","text":chunk},ensure_ascii=False) + "\n").encode()
            elif kind == "error":
                yield (json.dumps({"type":"error","message":str(event.get("message") or "The Mentor is temporarily unavailable. Please try again."),"retryable":True}) + "\n").encode()
                return
            elif kind == "final":
                metadata = event.get("metadata") if isinstance(event.get("metadata"),dict) else {}
                persisted = persistence.internship_ui_message_record(
                    actor_id,body.internship_id,
                    thread_kind="mentor",
                    scenario_actor_id="",
                    sender_type="mentor",
                    body=final_text or str(event.get("text") or ""),
                    request_id=body.request_id + ":reply",
                    thread_title="Murikah Mentor",
                    related_task_id=body.task_id,
                    related_model_invocation_id=str(metadata.get("invocation_id") or ""),
                )
                message = persisted.get("message") if isinstance(persisted,dict) else {}
                yield (json.dumps({"type":"final","text":final_text,"message_id":str((message or {}).get("id") or ""),"assistance_label":assistance_label},ensure_ascii=False) + "\n").encode()
                return
    except AIOrchestrationError as exc:
        yield (json.dumps({"type":"error","message":exc.safe_message,"retryable":True}) + "\n").encode()
    except Exception:
        yield (json.dumps({"type":"error","message":"The Mentor is temporarily unavailable. Please try again.","retryable":True}) + "\n").encode()


@router.post("/mentor/messages/stream")
async def mentor_message(
    body: MessageRequest,
    request: Request,
    current: TokenPayload = Depends(require_auth),
):
    check_origin(request)
    actor_id, _username, guest = _identity(current)
    if guest:
        raise HTTPException(401,"Sign in to use the Murikah Mentor.")
    try:
        workspace = _workspace_service().workspace(actor_id,body.internship_id)
        if workspace.get("state") != "active":
            raise HTTPException(409,"This internship is read-only.")
    except HTTPException:
        raise
    except Exception as exc:
        raise _safe_http(exc) from exc
    return StreamingResponse(
        _mentor_stream(actor_id=actor_id,workspace=workspace,body=body),
        media_type="application/x-ndjson",
        headers={"cache-control":"no-store","x-content-type-options":"nosniff"},
    )
