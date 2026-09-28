"""Trusted administrator API for Phase 10 institution-created scenarios."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from deeptutor.api.routers.auth import require_auth
from deeptutor.murikah_access import check_origin
from deeptutor.services.auth import TokenPayload
from deeptutor.virtual_internship.institution import (
    InstitutionScenarioError,
    create_draft,
    get_draft,
    publish_saved_draft,
    retire_published_scenario,
    validate_saved_draft,
)

router = APIRouter()


class InstitutionDraftRequest(BaseModel):
    draft_id: str = Field(min_length=3, max_length=128)
    draft: dict[str, Any]


def _actor(current: TokenPayload) -> str:
    actor_id = str(getattr(current, "user_id", "") or "")
    username = str(getattr(current, "username", "") or "")
    if not actor_id or username.startswith("guest_"):
        raise HTTPException(401, "Sign in as an administrator to manage institution scenarios.")
    return actor_id


def _http(exc: Exception) -> HTTPException:
    message = str(exc)
    if "admin_required" in message or "HTTP 403" in message:
        return HTTPException(403, "Administrator permission is required for institution scenario publishing.")
    if "not_found" in message or "HTTP 404" in message:
        return HTTPException(404, "That institution scenario draft is not available.")
    if "immutable" in message or "not_validated" in message or "HTTP 409" in message:
        return HTTPException(409, "That institution scenario cannot be changed in its current state.")
    if isinstance(exc, InstitutionScenarioError) or "HTTP 400" in message:
        return HTTPException(400, message[:1000])
    return HTTPException(503, "The institution scenario workflow is temporarily unavailable.")


@router.post("/drafts")
async def institution_draft(
    body: InstitutionDraftRequest,
    request: Request,
    current: TokenPayload = Depends(require_auth),
):
    check_origin(request)
    actor_id = _actor(current)
    try:
        return create_draft(actor_id, body.draft_id, body.draft)
    except Exception as exc:
        raise _http(exc) from exc


@router.get("/drafts/{draft_id}")
async def institution_draft_status(
    draft_id: str,
    current: TokenPayload = Depends(require_auth),
):
    actor_id = _actor(current)
    try:
        return get_draft(actor_id, draft_id)
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/drafts/{draft_id}/validate")
async def institution_validate(
    draft_id: str,
    request: Request,
    current: TokenPayload = Depends(require_auth),
):
    check_origin(request)
    actor_id = _actor(current)
    try:
        return validate_saved_draft(actor_id, draft_id)
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/drafts/{draft_id}/publish")
async def institution_publish(
    draft_id: str,
    request: Request,
    current: TokenPayload = Depends(require_auth),
):
    check_origin(request)
    actor_id = _actor(current)
    try:
        return publish_saved_draft(actor_id, draft_id)
    except Exception as exc:
        raise _http(exc) from exc


@router.post("/drafts/{draft_id}/retire")
async def institution_retire(
    draft_id: str,
    request: Request,
    current: TokenPayload = Depends(require_auth),
):
    check_origin(request)
    actor_id = _actor(current)
    try:
        return retire_published_scenario(actor_id, draft_id)
    except Exception as exc:
        raise _http(exc) from exc
