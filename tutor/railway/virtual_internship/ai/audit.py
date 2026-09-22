"""Audit metadata helpers for Phase 3 model invocations."""
from __future__ import annotations

import hashlib
import json
import uuid
from typing import Any, Callable


def invocation_id() -> str:
    return "viai_" + uuid.uuid4().hex


def output_hash(value: Any) -> str:
    if isinstance(value, str):
        raw = value.encode("utf-8")
    else:
        raw = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def persist_invocation(
    actor_id: str,
    internship_id: str,
    metadata: dict[str, Any],
    *,
    recorder: Callable[..., Any] | None = None,
) -> None:
    if recorder is None:
        try:
            from deeptutor import murikah_persistence
            recorder = murikah_persistence.internship_ai_invocation_record
        except Exception:
            return
    recorder(actor_id, internship_id, metadata)


__all__ = ["invocation_id", "output_hash", "persist_invocation"]
