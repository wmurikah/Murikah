"""Fakes shared by Virtual Internship Phase 3 orchestration tests."""
from __future__ import annotations

from types import SimpleNamespace


class FakeStateService:
    def __init__(self, *, owner="learner_a"):
        self.owner = owner
        self.mutations = []
        self.definition_payload = {
            "actors": [
                {
                    "actor_id": "actor_supervisor",
                    "authority": ["assign work"],
                    "goals": ["complete review"],
                    "communication_style": {"tone": "direct", "formality": "medium"},
                    "learner_relationship": "supervisor",
                }
            ],
            "tasks": [
                {
                    "task_id": "task_one",
                    "title": "Review background",
                    "category": "analytical",
                    "business_context": "Review the supplied process.",
                    "learner_objective": "Identify the relevant control.",
                    "brief": "Review the background and prepare notes.",
                    "allowed_tools": ["notes"],
                    "allowed_mentor_support": "light_coaching",
                    "stakeholder_actor_ids": ["actor_supervisor"],
                }
            ],
            "events": [
                {
                    "event_id": "event_known",
                    "event_type": "management_update",
                    "priority": 10,
                    "audit_label": "Known event",
                    "actor_ids": ["actor_supervisor"],
                }
            ],
            "decisions": [
                {
                    "decision_id": "decision_escalation",
                    "label": "Escalation choice",
                    "options": [
                        {"option_id": "escalate", "label": "Escalate"},
                        {"option_id": "wait", "label": "Wait"},
                    ],
                }
            ],
        }

    def _own(self, actor_id):
        if actor_id != self.owner:
            raise RuntimeError("internship_not_found")

    def definition(self, actor_id, internship_id):
        self._own(actor_id)
        return {"ok": True, "scenario_version_id": "sv_demo_v1", "definition": self.definition_payload}

    def actor_view(self, actor_id, internship_id, scenario_actor_id):
        self._own(actor_id)
        if scenario_actor_id != "actor_supervisor":
            raise RuntimeError("scenario_actor_not_found")
        return {
            "ok": True,
            "view": {
                "actor": {
                    "actor_id": "actor_supervisor",
                    "name": "Amina Kato",
                    "actor_class": "supervisor",
                    "job_title": "Review Supervisor",
                    "department_id": "department_review",
                },
                "facts": [
                    {"fact_id": "fact_public", "value": "Policy applies"},
                    {"fact_id": "fact_team", "value": "Team procedure"},
                ],
            },
        }

    def learner_view(self, actor_id, internship_id):
        self._own(actor_id)
        return {
            "ok": True,
            "view": {
                "internship_id": internship_id,
                "scenario_version_id": "sv_demo_v1",
                "facts": [{"fact_id": "fact_public", "value": "Policy applies"}],
                "tasks": [{"task_id": "task_one", "title": "Review background", "category": "analytical", "status": "available", "due_at": 123}],
                "fired_events": [],
            },
        }

    def record_decision(self, actor_id, internship_id, decision_id, option_id, **kwargs):
        self._own(actor_id)
        self.mutations.append(("decision", decision_id, option_id))
        return {"ok": True, "revision": 1}

    def evaluate(self, actor_id, internship_id, **kwargs):
        self._own(actor_id)
        self.mutations.append(("evaluate",))
        return {"ok": True, "revision": 2, "fired_events": []}


class FakeConfig(SimpleNamespace):
    pass


def candidate(profile="shared", model_id="m1", provider="openai", model="vendor/m1"):
    from virtual_internship.ai.providers import ProviderCandidate
    config = FakeConfig(
        provider_name=provider,
        binding=provider,
        model=model,
        api_key="secret-never-audited",
        effective_url="https://provider.invalid/v1",
        base_url="https://provider.invalid/v1",
        api_version="",
        reasoning_effort=None,
        extra_headers={},
    )
    return ProviderCandidate(profile, model_id, provider, model, config)


class FakeStream:
    def __init__(self, chunks=None, *, error=None, delay=0):
        self.chunks = list(chunks or [])
        self.error = error
        self.delay = delay
        self.closed = False
        self.index = 0

    def __aiter__(self):
        return self

    async def __anext__(self):
        import asyncio
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.index < len(self.chunks):
            value = self.chunks[self.index]
            self.index += 1
            return value
        if self.error is not None:
            error = self.error
            self.error = None
            raise error
        raise StopAsyncIteration

    async def aclose(self):
        self.closed = True


class AuditSink:
    def __init__(self):
        self.rows = []

    def __call__(self, actor_id, internship_id, metadata):
        self.rows.append((actor_id, internship_id, dict(metadata)))
        return {"ok": True}
