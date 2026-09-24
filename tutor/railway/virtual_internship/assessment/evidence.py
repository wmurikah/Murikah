"""Exact Phase 5 submission evidence packets and locator validation for Phase 6."""
from __future__ import annotations

from typing import Any

MAX_EVIDENCE_REFS = 32
LINES_PER_REFERENCE = 80
MAX_EXCERPT_CHARS = 6000


class EvidenceError(ValueError):
    pass


def build_text_evidence_packet(material: dict[str, Any]) -> dict[str, Any]:
    version_id = str(material.get("artifact_version_id") or "")
    artifact_id = str(material.get("artifact_id") or "")
    submission_id = str(material.get("submission_id") or "")
    content = str(material.get("content") or "")
    if not version_id or not artifact_id or not submission_id:
        raise EvidenceError("artifact lineage is incomplete")
    if not material.get("extractable") or not content:
        return {
            "artifact_id": artifact_id,
            "artifact_version_id": version_id,
            "submission_id": submission_id,
            "references": [],
            "limitations": ["The submitted file has no safe extracted text representation for formal automated assessment."],
        }
    lines = content.splitlines() or [content]
    refs: list[dict[str, Any]] = []
    for start in range(0, len(lines), LINES_PER_REFERENCE):
        if len(refs) >= MAX_EVIDENCE_REFS:
            break
        end = min(len(lines), start + LINES_PER_REFERENCE)
        excerpt = "\n".join(lines[start:end])[:MAX_EXCERPT_CHARS]
        refs.append({
            "evidence_ref": f"ev_{len(refs) + 1}",
            "artifact_id": artifact_id,
            "artifact_version_id": version_id,
            "submission_id": submission_id,
            "source_kind": "artifact_text",
            "locator": {"kind": "line_range", "start_line": start + 1, "end_line": end},
            "excerpt": excerpt,
        })
    limitations: list[str] = []
    if len(lines) > MAX_EVIDENCE_REFS * LINES_PER_REFERENCE:
        limitations.append("The extracted text exceeded the bounded evidence packet; unseen lines were not assessed.")
    return {
        "artifact_id": artifact_id,
        "artifact_version_id": version_id,
        "submission_id": submission_id,
        "references": refs,
        "limitations": limitations,
    }


def evidence_reference_map(packet: dict[str, Any]) -> dict[str, dict[str, Any]]:
    refs = packet.get("references")
    if not isinstance(refs, list):
        raise EvidenceError("evidence references are invalid")
    out: dict[str, dict[str, Any]] = {}
    for ref in refs:
        if not isinstance(ref, dict):
            raise EvidenceError("evidence reference is invalid")
        ref_id = str(ref.get("evidence_ref") or "")
        if not ref_id or ref_id in out:
            raise EvidenceError("evidence reference identity is invalid")
        if str(ref.get("artifact_version_id") or "") != str(packet.get("artifact_version_id") or ""):
            raise EvidenceError("evidence references another artifact version")
        locator = ref.get("locator")
        if not isinstance(locator, dict) or locator.get("kind") != "line_range":
            raise EvidenceError("unsupported evidence locator")
        start = locator.get("start_line")
        end = locator.get("end_line")
        if isinstance(start, bool) or isinstance(end, bool) or not isinstance(start, int) or not isinstance(end, int) or start < 1 or end < start:
            raise EvidenceError("invalid line-range locator")
        out[ref_id] = ref
    return out


__all__ = ["EvidenceError", "build_text_evidence_packet", "evidence_reference_map"]
