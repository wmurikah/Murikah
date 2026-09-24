"""Authenticated learner-facing API for Virtual Internship workplace and Phase 5 work artifacts."""
from __future__ import annotations

import json
import uuid
from typing import Any, AsyncIterator

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response, StreamingResponse
from urllib.parse import unquote
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


class AcknowledgeAssignmentRequest(BaseModel):
    internship_id: str = Field(min_length=1,max_length=128)
    request_id: str = Field(min_length=3,max_length=128)


class ArtifactCreateRequest(BaseModel):
    internship_id: str = Field(min_length=1,max_length=128)
    task_id: str = Field(min_length=1,max_length=128)
    deliverable_type: str = Field(min_length=1,max_length=64)
    title: str = Field(min_length=1,max_length=200)
    request_id: str = Field(min_length=3,max_length=128)


class ArtifactTextSaveRequest(BaseModel):
    internship_id: str = Field(min_length=1,max_length=128)
    content: str = Field(min_length=1,max_length=120000)
    request_id: str = Field(min_length=3,max_length=128)
    prior_review_id: str = Field(default="",max_length=128)


class ArtifactSubmitRequest(BaseModel):
    internship_id: str = Field(min_length=1,max_length=128)
    artifact_version_id: str = Field(min_length=1,max_length=128)
    request_id: str = Field(min_length=3,max_length=128)


class ArtifactReviewRequest(BaseModel):
    internship_id: str = Field(min_length=1,max_length=128)
    request_id: str = Field(min_length=3,max_length=128)


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


def _artifact_http(exc: Exception, fallback: str = "That work update could not be completed. Try again.") -> HTTPException:
    text = str(exc)
    if "upload_too_large" in text or "supported file size" in text:
        return HTTPException(413,"That file is larger than the 10 MB internship upload limit.")
    if "unsupported_artifact_type" in text:
        return HTTPException(415,"That file type is not supported for internship work.")
    if "HTTP 404" in text or "not_found" in text:
        return HTTPException(404,"That internship work item is not available.")
    if "HTTP 401" in text or "authentication_required" in text:
        return HTTPException(401,"Sign in to continue.")
    if "HTTP 400" in text or "invalid_" in text or "deliverable_not_allowed" in text:
        return HTTPException(400,"That work request is not valid for this assignment.")
    if "HTTP 409" in text or "stopped" in text or "already_" in text:
        return HTTPException(409,"That action is not available in the current work state.")
    return HTTPException(503,fallback)


def _member(current: TokenPayload, action: str) -> str:
    actor_id, _username, guest = _identity(current)
    if guest:
        raise HTTPException(401,f"Sign in to {action}.")
    return actor_id


def _ensure_phase2_task_completed(
    actor_id: str,
    internship_id: str,
    task_id: str,
    *,
    logical_request_id: str,
    persistence: Any,
) -> None:
    state = ScenarioStateService()
    try:
        state.transition_task(
            actor_id,
            internship_id,
            task_id,
            "completed",
            request_id=logical_request_id + ":task-complete",
        )
    except Exception:
        learner = state.learner_view(actor_id, internship_id)
        view = learner.get("view") if isinstance(learner,dict) else {}
        rows = view.get("tasks") if isinstance(view,dict) else []
        current = next(
            (
                row for row in (rows if isinstance(rows,list) else [])
                if isinstance(row,dict) and str(row.get("task_id") or "") == task_id
            ),
            None,
        )
        if not isinstance(current,dict) or str(current.get("status") or "") != "completed":
            raise
    state.evaluate(
        actor_id,
        internship_id,
        request_id=logical_request_id + ":events",
    )
    persistence.internship_artifact_task_completed(
        actor_id,
        internship_id,
        task_id,
        request_id=logical_request_id + ":activity-complete",
    )


async def _run_workflow_review(
    *,
    actor_id: str,
    internship_id: str,
    submission_id: str,
    logical_request_id: str,
) -> dict[str,Any]:
    persistence = _persistence()
    start_request_id = logical_request_id + ":start"
    review_request_id = logical_request_id + ":decision"
    try:
        start_result = persistence.internship_artifact_review_start(
            actor_id,internship_id,submission_id,request_id=start_request_id
        )
        if isinstance(start_result,dict) and start_result.get("already_reviewed"):
            review = start_result.get("review") if isinstance(start_result.get("review"),dict) else {}
            task_id = str(review.get("task_id") or "")
            completed = False
            if start_result.get("task_ready_for_completion") and task_id:
                _ensure_phase2_task_completed(
                    actor_id,
                    internship_id,
                    task_id,
                    logical_request_id=logical_request_id,
                    persistence=persistence,
                )
                completed = True
            return {
                "status":"reviewed",
                "idempotent_replay":True,
                "review":review,
                "task_completed":completed,
            }
        material_result = persistence.internship_artifact_review_material(
            actor_id,internship_id,submission_id
        )
        material = material_result.get("material") if isinstance(material_result,dict) else None
        if not isinstance(material,dict):
            raise RuntimeError("review_material_unavailable")
        if not material.get("extractable"):
            return {
                "status":"under_review",
                "review_unavailable":True,
                "message":"Supervisor review is temporarily unavailable for this file format. Your submitted version remains safely stored and unchanged.",
            }
        reviewer_actor_id = str(material.get("reviewer_actor_id") or "")
        task_id = str(material.get("task_id") or "")
        if not reviewer_actor_id or not task_id:
            raise RuntimeError("reviewer_unavailable")
        result, metadata = await VirtualInternshipAIOrchestrator(
            ScenarioStateService()
        ).invoke_workflow_review(
            owner_actor_id=actor_id,
            internship_id=internship_id,
            task_id=task_id,
            reviewer_actor_id=reviewer_actor_id,
            task=material.get("task") if isinstance(material.get("task"),dict) else {},
            artifact=material,
            prior_reviews=material.get("prior_reviews") if isinstance(material.get("prior_reviews"),list) else [],
        )
        persisted = persistence.internship_artifact_review_record(
            actor_id,
            internship_id,
            submission_id,
            decision=str(result.get("decision") or ""),
            feedback=str(result.get("feedback") or ""),
            requested_changes=[
                str(item)
                for item in result.get("requested_changes",[])
                if isinstance(item,str)
            ],
            model_invocation_id=str(metadata.get("invocation_id") or ""),
            request_id=review_request_id,
        )
        if persisted.get("task_ready_for_completion"):
            _ensure_phase2_task_completed(
                actor_id,
                internship_id,
                task_id,
                logical_request_id=logical_request_id,
                persistence=persistence,
            )
            persisted["task_completed"] = True
        return {"status":"reviewed",**persisted}
    except AIOrchestrationError:
        return {
            "status":"under_review",
            "review_unavailable":True,
            "message":"Supervisor review is temporarily unavailable. Please try again later.",
        }


@router.post("/tasks/{task_id}/acknowledge")
async def acknowledge_assignment(
    task_id: str,
    body: AcknowledgeAssignmentRequest,
    request: Request,
    current: TokenPayload = Depends(require_auth),
):
    check_origin(request)
    actor_id = _member(current,"acknowledge internship assignments")
    try:
        workspace = _workspace_service().workspace(actor_id,body.internship_id)
        if workspace.get("state") != "active":
            raise HTTPException(409,"This internship is read-only.")
        task = _find_task(workspace,task_id)
        if not task:
            raise HTTPException(404,"That assignment is not available.")
        status = str(task.get("status") or "")
        if status == "available":
            ScenarioStateService().transition_task(
                actor_id,body.internship_id,task_id,"in_progress",
                request_id=body.request_id + ":task",
            )
        elif status != "in_progress":
            raise HTTPException(409,"That assignment cannot be acknowledged in its current state.")
        return _persistence().internship_assignment_acknowledge(
            actor_id,body.internship_id,task_id,request_id=body.request_id
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise _artifact_http(exc) from exc


@router.get("/artifacts")
async def artifact_summary(
    internship_id: str = Query(min_length=1,max_length=128),
    current: TokenPayload = Depends(require_auth),
):
    actor_id = _member(current,"view internship work")
    try:
        return _persistence().internship_artifact_summary(actor_id,internship_id)
    except Exception as exc:
        raise _artifact_http(exc) from exc


@router.post("/artifacts")
async def create_artifact(
    body: ArtifactCreateRequest,
    request: Request,
    current: TokenPayload = Depends(require_auth),
):
    check_origin(request)
    actor_id = _member(current,"create internship work")
    try:
        return _persistence().internship_artifact_create(
            actor_id,body.internship_id,body.task_id,
            deliverable_type=body.deliverable_type,
            title=body.title,
            request_id=body.request_id,
        )
    except Exception as exc:
        raise _artifact_http(exc) from exc


@router.get("/artifacts/{artifact_id}")
async def artifact_history(
    artifact_id: str,
    internship_id: str = Query(min_length=1,max_length=128),
    current: TokenPayload = Depends(require_auth),
):
    actor_id = _member(current,"view internship work")
    try:
        return _persistence().internship_artifact_history(actor_id,internship_id,artifact_id)
    except Exception as exc:
        raise _artifact_http(exc) from exc


@router.post("/artifacts/{artifact_id}/versions/text")
async def save_text_version(
    artifact_id: str,
    body: ArtifactTextSaveRequest,
    request: Request,
    current: TokenPayload = Depends(require_auth),
):
    check_origin(request)
    actor_id = _member(current,"save internship work")
    try:
        return _persistence().internship_artifact_save_text(
            actor_id,body.internship_id,artifact_id,
            content=body.content,
            request_id=body.request_id,
            prior_review_id=body.prior_review_id,
        )
    except Exception as exc:
        raise _artifact_http(exc) from exc


@router.post("/artifacts/{artifact_id}/versions/upload")
async def upload_artifact_version(
    artifact_id: str,
    request: Request,
    internship_id: str = Query(min_length=1,max_length=128),
    current: TokenPayload = Depends(require_auth),
):
    check_origin(request)
    actor_id = _member(current,"upload internship work")
    max_bytes = _persistence().PHASE5_MAX_FILE_BYTES
    try:
        declared_length = request.headers.get("content-length")
        if declared_length and int(declared_length) > max_bytes:
            raise HTTPException(413,"That file is larger than the 10 MB internship upload limit.")
        chunks: list[bytes] = []
        total = 0
        async for chunk in request.stream():
            total += len(chunk)
            if total > max_bytes:
                raise HTTPException(413,"That file is larger than the 10 MB internship upload limit.")
            chunks.append(bytes(chunk))
        data = b"".join(chunks)
        if not data:
            raise HTTPException(400,"Choose a file to upload.")
        filename = unquote(str(request.headers.get("x-murikah-artifact-filename") or "artifact"))
        request_id = str(request.headers.get("x-murikah-request-id") or "")
        prior_review_id = str(request.headers.get("x-murikah-prior-review-id") or "")
        return _persistence().internship_artifact_upload(
            actor_id,internship_id,artifact_id,
            data=data,
            filename=filename,
            content_type=request.headers.get("content-type") or "application/octet-stream",
            request_id=request_id,
            prior_review_id=prior_review_id,
        )
    except HTTPException:
        raise
    except (TypeError, ValueError) as exc:
        raise HTTPException(400,"That upload request is invalid.") from exc
    except Exception as exc:
        raise _artifact_http(exc) from exc


@router.get("/artifacts/{artifact_id}/versions/{version_id}/text")
async def artifact_version_text(
    artifact_id: str,
    version_id: str,
    internship_id: str = Query(min_length=1,max_length=128),
    current: TokenPayload = Depends(require_auth),
):
    actor_id = _member(current,"view internship work")
    try:
        history = _persistence().internship_artifact_history(actor_id,internship_id,artifact_id)
        versions = history.get("versions") if isinstance(history,dict) else []
        if not any(isinstance(row,dict) and str(row.get("id") or "") == version_id for row in (versions or [])):
            raise HTTPException(404,"That work version is not available.")
        return _persistence().internship_artifact_text(actor_id,internship_id,version_id)
    except HTTPException:
        raise
    except Exception as exc:
        raise _artifact_http(exc) from exc


@router.get("/artifacts/{artifact_id}/versions/{version_id}/download")
async def artifact_version_download(
    artifact_id: str,
    version_id: str,
    internship_id: str = Query(min_length=1,max_length=128),
    current: TokenPayload = Depends(require_auth),
):
    actor_id = _member(current,"download internship work")
    try:
        history = _persistence().internship_artifact_history(actor_id,internship_id,artifact_id)
        versions = history.get("versions") if isinstance(history,dict) else []
        if not any(isinstance(row,dict) and str(row.get("id") or "") == version_id for row in (versions or [])):
            raise HTTPException(404,"That work version is not available.")
        data, headers = _persistence().internship_artifact_download(
            actor_id,internship_id,version_id
        )
        response_headers = {
            "cache-control":"private, no-store",
            "x-content-type-options":"nosniff",
        }
        disposition = headers.get("content-disposition")
        if disposition:
            response_headers["content-disposition"] = disposition
        return Response(
            content=data,
            media_type=headers.get("content-type","application/octet-stream"),
            headers=response_headers,
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise _artifact_http(exc,"That work file could not be downloaded right now.") from exc


@router.post("/artifacts/{artifact_id}/submit")
async def submit_artifact(
    artifact_id: str,
    body: ArtifactSubmitRequest,
    request: Request,
    current: TokenPayload = Depends(require_auth),
):
    check_origin(request)
    actor_id = _member(current,"submit internship work")
    try:
        result = _persistence().internship_artifact_submit(
            actor_id,body.internship_id,artifact_id,body.artifact_version_id,
            request_id=body.request_id,
        )
        submission = result.get("submission") if isinstance(result,dict) else {}
        submission_id = str((submission or {}).get("id") or "")
        if not submission_id:
            raise RuntimeError("submission_not_found")
        review = await _run_workflow_review(
            actor_id=actor_id,
            internship_id=body.internship_id,
            submission_id=submission_id,
            logical_request_id=body.request_id + ":review",
        )
        return {**result,"workflow_review":review}
    except Exception as exc:
        raise _artifact_http(exc) from exc


@router.post("/submissions/{submission_id}/review")
async def retry_workflow_review(
    submission_id: str,
    body: ArtifactReviewRequest,
    request: Request,
    current: TokenPayload = Depends(require_auth),
):
    check_origin(request)
    actor_id = _member(current,"request supervisor review")
    try:
        return await _run_workflow_review(
            actor_id=actor_id,
            internship_id=body.internship_id,
            submission_id=submission_id,
            logical_request_id=body.request_id,
        )
    except Exception as exc:
        raise _artifact_http(exc,"Supervisor review is temporarily unavailable. Please try again later.") from exc


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
