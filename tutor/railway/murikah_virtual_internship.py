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
from deeptutor.virtual_internship.ai.roles import ASSESSOR_PROMPT_VERSION
from deeptutor.virtual_internship.assessment.engine import FORMAL_ASSESSOR_SCHEMA_VERSION
from deeptutor.virtual_internship.assessment.evidence import build_text_evidence_packet
from deeptutor.virtual_internship.assessment.rubrics import (
    RUBRIC_CALCULATION_VERSION,
    rubric_hash,
    validate_rubric,
)
from deeptutor.virtual_internship.assessment.reviews import (
    attach_review_signals,
    build_review_snapshot,
    deterministic_review_findings,
    review_eligibility,
)
from deeptutor.virtual_internship.passport.export import build_passport_export
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

class FormalAssessmentRequest(BaseModel):
    internship_id: str = Field(min_length=1,max_length=128)
    request_id: str = Field(min_length=3,max_length=128)


class PerformanceReviewRequest(BaseModel):
    internship_id: str = Field(min_length=1,max_length=128)
    request_id: str = Field(min_length=3,max_length=128)


class ExternalAssistanceRequest(BaseModel):
    internship_id: str = Field(min_length=1,max_length=128)
    request_id: str = Field(min_length=3,max_length=128)
    task_id: str = Field(default="",max_length=128)
    assistance_level: int = Field(ge=0,le=5)
    category: str = Field(default="external_tool",min_length=1,max_length=80)
    summary: str = Field(default="",max_length=1000)


class PassportExportRequest(BaseModel):
    include_display_name: bool = False



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


def _assessment_by_id(summary: dict[str,Any], assessment_id: str) -> dict[str,Any] | None:
    rows = summary.get("assessments") if isinstance(summary,dict) else []
    return next(
        (
            row for row in (rows if isinstance(rows,list) else [])
            if isinstance(row,dict) and str(row.get("id") or "") == assessment_id
        ),
        None,
    )


async def _run_formal_assessment(
    *,
    actor_id: str,
    internship_id: str,
    submission_id: str,
    logical_request_id: str,
) -> dict[str,Any]:
    persistence = _persistence()
    material_result = persistence.internship_artifact_review_material(
        actor_id, internship_id, submission_id
    )
    material = material_result.get("material") if isinstance(material_result,dict) else None
    if not isinstance(material,dict):
        raise HTTPException(404,"That submitted work is not available.")
    task = material.get("task") if isinstance(material.get("task"),dict) else {}
    authored_rubric = task.get("rubric") if isinstance(task,dict) else None
    if not isinstance(authored_rubric,dict):
        raise HTTPException(409,"Formal assessment is not authored for this assignment.")
    try:
        rubric = validate_rubric(authored_rubric)
        evidence_packet = build_text_evidence_packet(material)
    except ValueError as exc:
        raise HTTPException(409,"This submission cannot be formally assessed with the current authored rubric.") from exc

    start = persistence.internship_assessment_start(
        actor_id,
        internship_id,
        submission_id,
        rubric_id=str(rubric.get("rubric_id") or ""),
        rubric_schema_version=int(rubric.get("schema_version") or 1),
        rubric_hash=rubric_hash(rubric),
        calculation_version=RUBRIC_CALCULATION_VERSION,
        assessor_prompt_version=ASSESSOR_PROMPT_VERSION,
        assessor_schema_version=FORMAL_ASSESSOR_SCHEMA_VERSION,
        request_id=logical_request_id,
    )
    assessment = start.get("assessment") if isinstance(start,dict) else None
    if not isinstance(assessment,dict):
        raise RuntimeError("assessment_start_failed")
    assessment_id = str(assessment.get("id") or "")
    if not assessment_id:
        raise RuntimeError("assessment_start_failed")
    if start.get("cached") or str(assessment.get("status") or "") == "completed":
        current = persistence.internship_assessment_summary(actor_id,internship_id)
        return {"status":"completed","cached":True,"assessment":_assessment_by_id(current,assessment_id) or assessment}

    references = evidence_packet.get("references") if isinstance(evidence_packet,dict) else []
    if not references:
        persistence.internship_assessment_fail(
            actor_id,internship_id,assessment_id,
            reason="No safe extracted evidence representation is available for formal automated assessment.",
        )
        return {
            "status":"failed",
            "assessment_id":assessment_id,
            "message":"Formal assessment is not available for this submitted file representation. The submission remains safely stored and unchanged.",
        }

    phase6 = persistence.internship_assessment_summary(actor_id,internship_id)
    submitted_at = int(material.get("submitted_at") or 0)
    assistance_events = [
        row for row in (
            phase6.get("assistance_events",[]) if isinstance(phase6,dict) else []
        )
        if isinstance(row,dict) and int(row.get("event_time") or 0) <= submitted_at
    ]
    prior_reviews = material.get("prior_reviews") if isinstance(material.get("prior_reviews"),list) else []
    try:
        result, metadata = await VirtualInternshipAIOrchestrator(
            ScenarioStateService()
        ).invoke_formal_assessor(
            owner_actor_id=actor_id,
            internship_id=internship_id,
            task_id=str(material.get("task_id") or ""),
            assessment_id=assessment_id,
            rubric=rubric,
            evidence_packet=evidence_packet,
            assistance_events=assistance_events,
            workflow_feedback=prior_reviews,
        )
        persistence.internship_assessment_complete(
            actor_id,
            internship_id,
            assessment_id,
            model_invocation_id=str(metadata.get("invocation_id") or ""),
            aggregate_numeric=(
                str(result.get("aggregate_numeric"))
                if result.get("aggregate_numeric") is not None else None
            ),
            overall_summary=str(result.get("overall_summary") or ""),
            limitations=[
                str(item) for item in result.get("limitations",[])
                if isinstance(item,str)
            ],
            criterion_results=[
                row for row in result.get("criterion_results",[])
                if isinstance(row,dict)
            ],
        )
        # Phase 6 completion remains authoritative even if Phase 7 derivation is
        # temporarily unavailable. Reconciliation is idempotent and also runs
        # on the learner Passport read path, so evidence cannot disappear forever.
        try:
            persistence.internship_passport_reconcile(actor_id,internship_id)
        except Exception:
            pass
        current = persistence.internship_assessment_summary(actor_id,internship_id)
        return {"status":"completed","assessment":_assessment_by_id(current,assessment_id)}
    except AIOrchestrationError:
        persistence.internship_assessment_fail(
            actor_id,internship_id,assessment_id,
            reason="The structured assessor was unavailable or returned an invalid result.",
        )
        return {
            "status":"failed",
            "assessment_id":assessment_id,
            "message":"Formal assessment is temporarily unavailable. No score or assessment result was awarded.",
        }
    except Exception:
        try:
            persistence.internship_assessment_fail(
                actor_id,internship_id,assessment_id,
                reason="Formal assessment failed validation or persistence.",
            )
        except Exception:
            pass
        raise


def _build_performance_review(
    actor_id: str,
    internship_id: str,
    review_type: str,
    request_id: str,
) -> dict[str,Any]:
    if review_type not in {"midpoint","final"}:
        raise HTTPException(404,"That performance review type is not available.")
    workspace = _workspace_service().workspace(actor_id,internship_id)
    internship = workspace.get("internship") if isinstance(workspace,dict) else None
    if not isinstance(internship,dict):
        raise HTTPException(404,"That internship is not available.")
    state = str(workspace.get("state") or "")
    if state != "active":
        raise HTTPException(409,"This internship is read-only. Performance reviews cannot be created after it is stopped.")
    definition_result = ScenarioStateService().definition(actor_id,internship_id)
    definition = definition_result.get("definition") if isinstance(definition_result,dict) else None
    manifest = definition.get("manifest") if isinstance(definition,dict) and isinstance(definition.get("manifest"),dict) else {}
    now = int(internship.get("current_server_time") or 0)
    started_at = int(internship.get("started_at") or 0)
    eligibility = review_eligibility(
        review_type=review_type,
        manifest=manifest,
        started_at=started_at,
        now=now,
    )
    if not eligibility.get("eligible"):
        raise HTTPException(
            409,
            f"This {review_type} performance review becomes available after internship day {eligibility.get('required_day')}.",
        )

    persistence = _persistence()
    phase6 = persistence.internship_assessment_summary(actor_id,internship_id)
    phase5 = persistence.internship_artifact_summary(actor_id,internship_id)
    reflections_result = persistence.internship_ui_reflections(actor_id,internship_id)
    definition_tasks = (
        definition.get("tasks",[])
        if isinstance(definition,dict) and isinstance(definition.get("tasks"),list)
        else []
    )
    rubrics_by_task = {
        str(task.get("task_id") or ""):task.get("rubric")
        for task in definition_tasks
        if isinstance(task,dict) and isinstance(task.get("rubric"),dict)
    }
    review_assessments = []
    for row in phase6.get("assessments",[]) if isinstance(phase6,dict) else []:
        if not isinstance(row,dict):
            continue
        authored_rubric=rubrics_by_task.get(str(row.get("task_id") or ""))
        review_assessments.append(
            attach_review_signals(row,authored_rubric)
            if isinstance(authored_rubric,dict) else dict(row)
        )
    snapshot = build_review_snapshot(
        review_type=review_type,
        cutoff_at=now,
        assessments=review_assessments,
        workflow_reviews=[
            row for row in phase5.get("reviews",[])
            if isinstance(row,dict)
        ] if isinstance(phase5,dict) else [],
        reflections=[
            row for row in reflections_result.get("reflections",[])
            if isinstance(row,dict)
        ] if isinstance(reflections_result,dict) else [],
        assistance_events=[
            row for row in phase6.get("assistance_events",[])
            if isinstance(row,dict)
        ] if isinstance(phase6,dict) else [],
        activity=[
            row for row in phase5.get("activity",[])
            if isinstance(row,dict)
        ] if isinstance(phase5,dict) else [],
    )
    snapshot_hash = str(snapshot.pop("snapshot_hash"))
    findings = deterministic_review_findings(snapshot)
    stored = persistence.internship_performance_review_record(
        actor_id,
        internship_id,
        review_type=review_type,
        cutoff_at=now,
        evidence_snapshot=snapshot,
        evidence_snapshot_hash=snapshot_hash,
        strengths=findings["strengths"],
        development_areas=findings["development_areas"],
        priorities=findings["priorities"],
        assistance_summary=findings["assistance_summary"],
        narrative=findings["narrative"],
        request_id=request_id,
    )
    review = stored.get("performance_review") if isinstance(stored,dict) else {}
    return {
        "ok":True,
        "review":{
            "id":str((review or {}).get("id") or ""),
            "review_type":review_type,
            "cutoff_at":now,
            "evidence_snapshot_hash":snapshot_hash,
            **findings,
        },
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


@router.get("/assessments")
async def assessment_summary(
    internship_id: str = Query(min_length=1,max_length=128),
    current: TokenPayload = Depends(require_auth),
):
    actor_id = _member(current,"view formal internship assessments")
    try:
        return _persistence().internship_assessment_summary(actor_id,internship_id)
    except Exception as exc:
        raise _safe_http(exc,"Formal assessment history could not be loaded. Try again.") from exc


@router.post("/submissions/{submission_id}/assessment")
async def request_formal_assessment(
    submission_id: str,
    body: FormalAssessmentRequest,
    request: Request,
    current: TokenPayload = Depends(require_auth),
):
    check_origin(request)
    actor_id = _member(current,"request formal internship assessment")
    try:
        return await _run_formal_assessment(
            actor_id=actor_id,
            internship_id=body.internship_id,
            submission_id=submission_id,
            logical_request_id=body.request_id,
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise _safe_http(exc,"Formal assessment could not be completed. Try again later.") from exc


@router.post("/performance-reviews/{review_type}")
async def create_performance_review(
    review_type: str,
    body: PerformanceReviewRequest,
    request: Request,
    current: TokenPayload = Depends(require_auth),
):
    check_origin(request)
    actor_id = _member(current,"create an internship performance review")
    try:
        return _build_performance_review(
            actor_id,body.internship_id,review_type,body.request_id
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise _safe_http(exc,"That performance review could not be created. Try again later.") from exc


@router.post("/assistance/external")
async def declare_external_assistance(
    body: ExternalAssistanceRequest,
    request: Request,
    current: TokenPayload = Depends(require_auth),
):
    check_origin(request)
    actor_id = _member(current,"declare external assistance")
    try:
        return _persistence().internship_assistance_record(
            actor_id,
            body.internship_id,
            task_id=body.task_id,
            source="external_declared",
            provenance="learner_declared",
            assistance_level=body.assistance_level,
            category=body.category,
            summary=body.summary,
            request_id=body.request_id,
        )
    except Exception as exc:
        raise _safe_http(exc,"That assistance declaration could not be saved. Try again.") from exc



@router.get("/passport")
async def competency_passport(
    current: TokenPayload = Depends(require_auth),
):
    actor_id=_member(current,"view your Competency Passport")
    persistence=_persistence()
    try:
        try:
            persistence.internship_passport_reconcile(actor_id)
        except Exception:
            pass
        return persistence.internship_passport_summary(actor_id)
    except Exception as exc:
        raise _safe_http(exc,"Your Competency Passport could not be loaded. Try again.") from exc


@router.get("/passport/evidence")
async def competency_passport_evidence(
    competency_id: str = Query(default="",max_length=128),
    current: TokenPayload = Depends(require_auth),
):
    actor_id=_member(current,"view your Competency Passport evidence")
    try:
        return _persistence().internship_passport_evidence(actor_id,competency_id)
    except Exception as exc:
        raise _safe_http(exc,"Your competency evidence could not be loaded. Try again.") from exc


@router.post("/passport/export")
async def export_competency_passport(
    body: PassportExportRequest,
    request: Request,
    current: TokenPayload = Depends(require_auth),
):
    check_origin(request)
    actor_id=_member(current,"export your Competency Passport")
    persistence=_persistence()
    try:
        try:
            persistence.internship_passport_reconcile(actor_id)
        except Exception:
            pass
        source=persistence.internship_passport_export_source(actor_id)
        payload=build_passport_export(
            passport={"competencies":source.get("competencies",[])},
            evidence=[row for row in source.get("evidence",[]) if isinstance(row,dict)],
            definitions=[row for row in source.get("definitions",[]) if isinstance(row,dict)],
            include_display_name=False,
        )
        return Response(
            content=json.dumps(payload,ensure_ascii=False,sort_keys=True,indent=2).encode("utf-8"),
            media_type="application/json",
            headers={
                "cache-control":"private, no-store",
                "content-disposition":'attachment; filename="murikah-competency-passport.json"',
                "x-content-type-options":"nosniff",
            },
        )
    except Exception as exc:
        raise _safe_http(exc,"Your Competency Passport export could not be created. Try again.") from exc


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
                persistence.internship_assistance_record(
                    actor_id,
                    body.internship_id,
                    task_id=body.task_id,
                    source="murikah_mentor",
                    provenance="system_observed",
                    assistance_level=assistance_level,
                    category="mentor_guidance",
                    summary=f"Murikah Mentor guidance provided at {assistance_label}.",
                    model_invocation_id=str(metadata.get("invocation_id") or ""),
                    request_id=body.request_id + ":assistance",
                )
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
