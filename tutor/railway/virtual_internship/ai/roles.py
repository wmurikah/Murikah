"""Phase 3 Virtual Internship model roles and deterministic role policies."""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class VirtualInternshipModelRole(str, Enum):
    ACTOR = "actor"
    MENTOR = "mentor"
    ASSESSOR = "assessor"
    SCENARIO_DIRECTOR = "scenario_director"


ORCHESTRATION_SCHEMA_VERSION = 1
ACTOR_PROMPT_VERSION = 1
MENTOR_PROMPT_VERSION = 1
ASSESSOR_PROMPT_VERSION = 1
DIRECTOR_PROMPT_VERSION = 1
ASSESSOR_OUTPUT_SCHEMA_VERSION = 1
DIRECTOR_OUTPUT_SCHEMA_VERSION = 1
INTERNSHIP_CONTEXT_MAX_CHARS = 14_000
INTERNSHIP_RECENT_TURNS = 6


@dataclass(frozen=True)
class RolePolicy:
    role: VirtualInternshipModelRole
    max_tokens: int
    first_token_timeout_seconds: float
    total_timeout_seconds: float
    max_attempts: int
    candidate_limit: int
    structured_output: bool
    prompt_version: int
    output_schema_version: int | None = None


ROLE_POLICIES: dict[VirtualInternshipModelRole, RolePolicy] = {
    VirtualInternshipModelRole.ACTOR: RolePolicy(
        role=VirtualInternshipModelRole.ACTOR,
        max_tokens=500,
        first_token_timeout_seconds=7.0,
        total_timeout_seconds=25.0,
        max_attempts=2,
        candidate_limit=2,
        structured_output=False,
        prompt_version=ACTOR_PROMPT_VERSION,
    ),
    VirtualInternshipModelRole.MENTOR: RolePolicy(
        role=VirtualInternshipModelRole.MENTOR,
        max_tokens=1200,
        first_token_timeout_seconds=9.0,
        total_timeout_seconds=40.0,
        max_attempts=2,
        candidate_limit=2,
        structured_output=False,
        prompt_version=MENTOR_PROMPT_VERSION,
    ),
    VirtualInternshipModelRole.ASSESSOR: RolePolicy(
        role=VirtualInternshipModelRole.ASSESSOR,
        max_tokens=1400,
        first_token_timeout_seconds=0.0,
        total_timeout_seconds=55.0,
        max_attempts=2,
        candidate_limit=2,
        structured_output=True,
        prompt_version=ASSESSOR_PROMPT_VERSION,
        output_schema_version=ASSESSOR_OUTPUT_SCHEMA_VERSION,
    ),
    VirtualInternshipModelRole.SCENARIO_DIRECTOR: RolePolicy(
        role=VirtualInternshipModelRole.SCENARIO_DIRECTOR,
        max_tokens=800,
        first_token_timeout_seconds=0.0,
        total_timeout_seconds=35.0,
        max_attempts=2,
        candidate_limit=2,
        structured_output=True,
        prompt_version=DIRECTOR_PROMPT_VERSION,
        output_schema_version=DIRECTOR_OUTPUT_SCHEMA_VERSION,
    ),
}


def role_policy(role: VirtualInternshipModelRole | str) -> RolePolicy:
    try:
        normalized = role if isinstance(role, VirtualInternshipModelRole) else VirtualInternshipModelRole(role)
    except ValueError as exc:
        raise ValueError(f"unknown Virtual Internship model role: {role}") from exc
    return ROLE_POLICIES[normalized]


__all__ = [
    "ACTOR_PROMPT_VERSION",
    "ASSESSOR_OUTPUT_SCHEMA_VERSION",
    "ASSESSOR_PROMPT_VERSION",
    "DIRECTOR_OUTPUT_SCHEMA_VERSION",
    "DIRECTOR_PROMPT_VERSION",
    "INTERNSHIP_CONTEXT_MAX_CHARS",
    "INTERNSHIP_RECENT_TURNS",
    "MENTOR_PROMPT_VERSION",
    "ORCHESTRATION_SCHEMA_VERSION",
    "ROLE_POLICIES",
    "RolePolicy",
    "VirtualInternshipModelRole",
    "role_policy",
]
