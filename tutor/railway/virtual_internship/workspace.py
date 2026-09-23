"""Learner-safe Virtual Internship workplace read model through Phase 5.

This module consumes Phase 1 lifecycle state, Phase 2 learner-safe state and
Phase 4 UI records and Phase 5 owner-bound artifact summaries. It never returns raw canonical scenario state.
"""
from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Any

from .state import ScenarioStateService

MENTOR_SUPPORT = {
    "none": (0, "No Mentor support"),
    "clarification": (1, "Clarification only"),
    "light_coaching": (2, "Light guidance"),
    "moderate_coaching": (3, "Moderate coaching"),
}
VISIBLE_TASK_STATES = {"available", "in_progress", "completed", "cancelled"}


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _text(value: Any, limit: int = 500) -> str:
    text = str(value or "").strip()
    return text[:limit]


def _label(value: Any) -> str:
    raw = _text(value, 160).replace("_", " ").replace("-", " ")
    return " ".join(part.capitalize() for part in raw.split())


def _summary(value: Any, limit: int = 220) -> str:
    if isinstance(value, str):
        raw = value
    else:
        raw = json.dumps(value, ensure_ascii=False, sort_keys=True)
    raw = " ".join(raw.split())
    return raw if len(raw) <= limit else raw[: max(0, limit - 1)].rstrip() + "…"


@dataclass
class WorkspaceContext:
    status: dict[str, Any]
    learner: dict[str, Any]
    definition: dict[str, Any]
    threads: list[dict[str, Any]]
    reflections: list[dict[str, Any]]
    artifacts: dict[str, Any]


class VirtualInternshipWorkspaceService:
    def __init__(self, persistence: Any | None = None, state_service: Any | None = None):
        if persistence is None:
            from deeptutor import murikah_persistence as persistence_module
            persistence = persistence_module
        self.persistence = persistence
        self.state = state_service or ScenarioStateService()

    def current_internship_id(self, actor_id: str) -> str:
        result = _dict(self.persistence.internship_ui_current(actor_id))
        return _text(result.get("internship_id"), 128)

    def start_options(self, actor_id: str) -> list[dict[str, Any]]:
        result = _dict(self.persistence.internship_ui_start_options(actor_id))
        rows = []
        for item in _list(result.get("options")):
            row = _dict(item)
            if not row.get("scenario_slug"):
                continue
            rows.append({
                "scenario_slug": _text(row.get("scenario_slug"),128),
                "title": _text(row.get("title"),160),
                "role_title": _text(row.get("role_title"),120),
                "scenario_version": int(row.get("scenario_version") or 0),
                "minimum_duration_days": max(90,int(row.get("minimum_duration_days") or 90)),
                "expected_workload_band": _text(row.get("expected_workload_band"),32),
            })
        return rows

    def _context(self, actor_id: str, internship_id: str) -> WorkspaceContext:
        status_result = _dict(self.persistence.internship_status(actor_id, internship_id))
        status = _dict(status_result.get("internship"))
        if not status:
            raise LookupError("internship_not_found")
        learner_result = _dict(self.state.learner_view(actor_id, internship_id))
        learner = _dict(learner_result.get("view"))
        definition_result = _dict(self.state.definition(actor_id, internship_id))
        definition = _dict(definition_result.get("definition"))
        threads = _list(_dict(self.persistence.internship_ui_threads(actor_id, internship_id)).get("threads"))
        reflections = _list(_dict(self.persistence.internship_ui_reflections(actor_id, internship_id)).get("reflections"))
        artifact_reader = getattr(self.persistence,"internship_artifact_summary",None)
        artifacts = _dict(artifact_reader(actor_id,internship_id)) if callable(artifact_reader) else {}
        return WorkspaceContext(status,status and learner or {},definition,threads,reflections,artifacts)

    def _visible_tasks(self, context: WorkspaceContext) -> list[dict[str, Any]]:
        authored = {
            _text(row.get("task_id"),128): _dict(row)
            for row in _list(context.definition.get("tasks"))
            if isinstance(row,dict)
        }
        runtime = {
            _text(row.get("task_id"),128): _dict(row)
            for row in _list(context.learner.get("tasks"))
            if isinstance(row,dict)
        }
        acknowledgements = {
            _text(_dict(row).get("task_id"),128): int(_dict(row).get("acknowledged_at") or 0)
            for row in _list(context.artifacts.get("acknowledgements"))
        }
        artifact_rows = [_dict(row) for row in _list(context.artifacts.get("artifacts"))]
        version_rows = [_dict(row) for row in _list(context.artifacts.get("versions"))]
        submission_rows = [_dict(row) for row in _list(context.artifacts.get("submissions"))]
        review_rows = [_dict(row) for row in _list(context.artifacts.get("reviews"))]
        visible: list[dict[str,Any]] = []
        for task_id, current in runtime.items():
            status = _text(current.get("status"),32)
            if status not in VISIBLE_TASK_STATES:
                continue
            source = authored.get(task_id) or {}
            support_key = _text(source.get("allowed_mentor_support"),32)
            support = MENTOR_SUPPORT.get(support_key,(1,"Clarification only"))
            dependency_rows = []
            for dep_id in _list(source.get("dependencies")):
                dep_id = _text(dep_id,128)
                dep_runtime = runtime.get(dep_id) or {}
                if _text(dep_runtime.get("status"),32) not in VISIBLE_TASK_STATES:
                    continue
                dep_source = authored.get(dep_id) or {}
                dependency_rows.append({
                    "task_id":dep_id,
                    "title":_text(dep_source.get("title") or dep_id,160),
                    "status":_text(dep_runtime.get("status"),32),
                })
            task_artifacts = [row for row in artifact_rows if _text(row.get("task_id"),128) == task_id]
            work_artifacts = []
            for artifact in task_artifacts:
                artifact_id = _text(artifact.get("id"),128)
                versions = [row for row in version_rows if _text(row.get("artifact_id"),128) == artifact_id]
                submissions = [row for row in submission_rows if _text(row.get("artifact_id"),128) == artifact_id]
                reviews = [row for row in review_rows if _text(row.get("artifact_id"),128) == artifact_id]
                work_artifacts.append({
                    **artifact,
                    "versions":versions,
                    "submissions":submissions,
                    "reviews":reviews,
                })
            artifact_statuses = {_text(row.get("status"),32) for row in task_artifacts}
            if status == "completed" or (task_artifacts and artifact_statuses == {"accepted"}):
                work_status = "accepted"
            elif "changes_requested" in artifact_statuses:
                work_status = "changes_requested"
            elif "submitted" in artifact_statuses:
                work_status = "submitted"
            elif any(int(row.get("current_version_number") or 0) > 0 for row in task_artifacts):
                work_status = "draft_saved"
            elif acknowledgements.get(task_id):
                work_status = "in_progress"
            else:
                work_status = "not_acknowledged"
            visible.append({
                "task_id":task_id,
                "title":_text(source.get("title") or current.get("title"),160),
                "category":_text(source.get("category") or current.get("category"),64),
                "assigned_by_actor_id":_text(source.get("assigned_by_actor_id"),128),
                "business_context":_text(source.get("business_context"),2000),
                "learner_objective":_text(source.get("learner_objective"),2000),
                "brief":_text(source.get("brief"),2000),
                "expected_effort":_text(source.get("expected_effort"),80),
                "difficulty":_text(source.get("difficulty"),40),
                "due_at":int(current.get("due_at") or 0),
                "status":status,
                "dependencies":dependency_rows,
                "deliverable_types":[_text(x,64) for x in _list(source.get("deliverable_types")) if _text(x,64)],
                "allowed_tools":[_text(x,80) for x in _list(source.get("allowed_tools")) if _text(x,80)],
                "mentor_support":{"key":support_key,"level":support[0],"label":support[1]},
                "stakeholder_actor_ids":[_text(x,128) for x in _list(source.get("stakeholder_actor_ids")) if _text(x,128)],
                "acknowledged_at":acknowledgements.get(task_id,0),
                "work_status":work_status,
                "work_artifacts":work_artifacts,
            })
        return visible

    def _visible_people(
        self,
        context: WorkspaceContext,
        tasks: list[dict[str,Any]],
    ) -> list[dict[str,Any]]:
        actors = {
            _text(row.get("actor_id"),128): _dict(row)
            for row in _list(context.definition.get("actors"))
            if isinstance(row,dict)
        }
        visible_ids: set[str] = set()
        for task in tasks:
            if task.get("assigned_by_actor_id"):
                visible_ids.add(str(task["assigned_by_actor_id"]))
            visible_ids.update(str(x) for x in task.get("stakeholder_actor_ids",[]) if x)
        event_map = {
            _text(row.get("event_id"),128): _dict(row)
            for row in _list(context.definition.get("events"))
            if isinstance(row,dict)
        }
        for event in _list(context.learner.get("fired_events")):
            definition = event_map.get(_text(_dict(event).get("event_id"),128)) or {}
            visible_ids.update(_text(x,128) for x in _list(definition.get("actor_ids")) if _text(x,128))
        for thread in context.threads:
            actor_id = _text(_dict(thread).get("scenario_actor_id"),128)
            if actor_id:
                visible_ids.add(actor_id)

        people: list[dict[str,Any]] = []
        for actor_id in sorted(visible_ids):
            actor = actors.get(actor_id)
            if not actor:
                continue
            reports_to = _text(actor.get("reports_to_actor_id"),128)
            people.append({
                "actor_id":actor_id,
                "name":_text(actor.get("name"),120),
                "actor_class":_text(actor.get("actor_class"),64),
                "job_title":_text(actor.get("job_title"),120),
                "department_id":_text(actor.get("department_id"),64),
                "reports_to_actor_id":reports_to if reports_to in visible_ids else "",
                "learner_relationship":_text(actor.get("learner_relationship"),120),
                "active":bool(actor.get("active")),
            })
        return people

    def _documents(self, context: WorkspaceContext, include_content: bool = False) -> list[dict[str,Any]]:
        fact_defs = {
            _text(row.get("id"),128): _dict(row)
            for row in _list(context.definition.get("facts"))
            if isinstance(row,dict)
        }
        docs: list[dict[str,Any]] = []
        for row in _list(context.learner.get("facts")):
            fact = _dict(row)
            fact_id = _text(fact.get("fact_id"),128)
            if not fact_id:
                continue
            authored = fact_defs.get(fact_id) or {}
            source = _text(authored.get("source"),160)
            key = _text(authored.get("key"),160)
            value = fact.get("value")
            doc = {
                "document_id":"fact:" + fact_id,
                "title":_label(source or key or fact_id),
                "kind":"scenario_source",
                "source":source,
                "summary":_summary(value),
            }
            if include_content:
                doc["content"] = value
            docs.append(doc)
        return docs

    def _meetings(self, context: WorkspaceContext, people: list[dict[str,Any]]) -> list[dict[str,Any]]:
        person_map = {row["actor_id"]:row for row in people}
        event_defs = {
            _text(row.get("event_id"),128): _dict(row)
            for row in _list(context.definition.get("events"))
            if isinstance(row,dict)
        }
        meetings: list[dict[str,Any]] = []
        for fired in _list(context.learner.get("fired_events")):
            row = _dict(fired)
            event_id = _text(row.get("event_id"),128)
            authored = event_defs.get(event_id) or {}
            event_type = _text(authored.get("event_type"),64).lower()
            audit_label = _text(authored.get("audit_label") or row.get("audit_label"),180)
            if "meeting" not in event_type and "meeting" not in audit_label.lower() and "checkin" not in event_type and "check-in" not in audit_label.lower():
                continue
            participants = []
            for actor_id in _list(authored.get("actor_ids")):
                actor_id = _text(actor_id,128)
                if actor_id in person_map:
                    participants.append({
                        "actor_id":actor_id,
                        "name":person_map[actor_id]["name"],
                        "job_title":person_map[actor_id]["job_title"],
                    })
            meetings.append({
                "meeting_id":"event:" + event_id,
                "title":audit_label or _label(event_type),
                "scheduled_at":int(row.get("fired_at") or 0),
                "status":"completed",
                "participants":participants,
                "purpose":_text(authored.get("learning_objective"),500),
                "related_event_id":event_id,
            })
        return meetings

    def _company(self, context: WorkspaceContext, people: list[dict[str,Any]]) -> dict[str,Any]:
        company = _dict(context.definition.get("company"))
        visible_ids = {row["actor_id"] for row in people}
        relationships = []
        for rel in _list(company.get("reporting_relationships")):
            rel = _dict(rel)
            manager = _text(rel.get("manager_actor_id"),128)
            direct = _text(rel.get("direct_report_actor_id"),128)
            if manager in visible_ids and direct in visible_ids:
                relationships.append({"manager_actor_id":manager,"direct_report_actor_id":direct})
        return {
            "name":_text(company.get("name"),160),
            "fictional":True,
            "sector":_text(company.get("sector"),120),
            "country_region":_text(company.get("country_region"),160),
            "description":_text(company.get("description"),2000),
            "products_services":[_text(x,160) for x in _list(company.get("products_services")) if _text(x,160)],
            "departments":[
                {"id":_text(_dict(x).get("id"),64),"name":_text(_dict(x).get("name"),120)}
                for x in _list(company.get("departments"))
                if _text(_dict(x).get("id"),64)
            ],
            "systems":[_text(x,120) for x in _list(company.get("systems")) if _text(x,120)],
            "process_references":[_text(x,160) for x in _list(company.get("process_references")) if _text(x,160)],
            "communication_norms":[_text(x,300) for x in _list(company.get("communication_norms")) if _text(x,300)],
            "work_calendar":_dict(company.get("work_calendar")),
            "reporting_relationships":relationships,
        }

    def _threads(self, context: WorkspaceContext, people: list[dict[str,Any]]) -> list[dict[str,Any]]:
        person_map = {row["actor_id"]:row for row in people}
        rows = []
        for raw in context.threads:
            row = _dict(raw)
            kind = _text(row.get("thread_kind"),32)
            actor_id = _text(row.get("scenario_actor_id"),128)
            if kind == "workplace" and actor_id not in person_map:
                continue
            title = "Murikah Mentor" if kind == "mentor" else _text(row.get("title"),160)
            rows.append({
                "thread_id":_text(row.get("id"),128),
                "thread_kind":kind,
                "scenario_actor_id":actor_id,
                "title":title,
                "related_task_id":_text(row.get("related_task_id"),128),
                "last_message":_text(row.get("last_body"),500),
                "last_sender_type":_text(row.get("last_sender_type"),16),
                "last_message_at":int(row.get("last_message_at") or 0),
                "message_count":max(0,int(row.get("message_count") or 0)),
            })
        return rows

    def _activity(
        self,
        context: WorkspaceContext,
        threads: list[dict[str,Any]],
        meetings: list[dict[str,Any]],
    ) -> list[dict[str,Any]]:
        status = context.status
        items: list[dict[str,Any]] = [{
            "id":"internship:start",
            "type":"internship_started",
            "title":"Internship started",
            "detail":"Your simulated workplace record was created.",
            "timestamp":int(status.get("started_at") or 0),
            "href":"/virtual-internship",
        }]
        for event in _list(context.learner.get("fired_events")):
            row = _dict(event)
            event_id = _text(row.get("event_id"),128)
            items.append({
                "id":"event:" + event_id,
                "type":"scenario_event",
                "title":_text(row.get("audit_label"),180) or "Scenario update",
                "detail":"A learner-visible workplace event occurred.",
                "timestamp":int(row.get("fired_at") or 0),
                "href":"/virtual-internship/activity",
            })
        for thread in threads:
            if int(thread.get("last_message_at") or 0) <= 0:
                continue
            items.append({
                "id":"thread:" + str(thread.get("thread_id") or ""),
                "type":"mentor_message" if thread.get("thread_kind") == "mentor" else "workplace_message",
                "title":"Mentor conversation updated" if thread.get("thread_kind") == "mentor" else "Workplace conversation updated",
                "detail":_text(thread.get("title"),160),
                "timestamp":int(thread.get("last_message_at") or 0),
                "href":"/virtual-internship/mentor" if thread.get("thread_kind") == "mentor" else "/virtual-internship/inbox?thread=" + str(thread.get("thread_id") or ""),
            })
        for reflection in context.reflections:
            row = _dict(reflection)
            items.append({
                "id":"reflection:" + _text(row.get("id"),128),
                "type":"reflection",
                "title":"Reflection saved",
                "detail":_label(row.get("period_key")) or "Learning reflection",
                "timestamp":int(row.get("updated_at") or 0),
                "href":"/virtual-internship/activity",
            })
        activity_labels = {
            "assignment_acknowledged":("Assignment acknowledged","You acknowledged the assignment."),
            "draft_created":("Work product created","You created a work product for this assignment."),
            "artifact_version_saved":("Draft saved","You saved a new immutable work version."),
            "artifact_submitted":("Work submitted","You submitted a work version for supervisor review."),
            "artifact_resubmitted":("Work resubmitted","You submitted a revised work version for supervisor review."),
            "changes_requested":("Changes requested","Your simulated supervisor requested changes."),
            "artifact_accepted":("Work accepted","Your simulated supervisor accepted the work product."),
            "task_completed":("Assignment completed","All required work products for the assignment were accepted."),
        }
        for raw in _list(context.artifacts.get("activity")):
            row = _dict(raw)
            kind = _text(row.get("event_type"),64)
            title, detail = activity_labels.get(kind,("Work updated","Your internship work record changed."))
            task_id = _text(row.get("task_id"),128)
            items.append({
                "id":"artifact-activity:" + _text(row.get("id"),128),
                "type":kind,
                "title":title,
                "detail":detail,
                "timestamp":int(row.get("event_time") or 0),
                "href":"/virtual-internship/work" + (("?task=" + task_id) if task_id else ""),
            })
        if status.get("status") == "stopped" and int(status.get("stopped_at") or 0) > 0:
            items.append({
                "id":"internship:stopped",
                "type":"internship_stopped",
                "title":"Internship stopped",
                "detail":"History remains available in read-only mode.",
                "timestamp":int(status.get("stopped_at") or 0),
                "href":"/virtual-internship",
            })
        meeting_ids = {m["meeting_id"] for m in meetings}
        items.sort(key=lambda item:(int(item.get("timestamp") or 0),str(item.get("id") or "")),reverse=True)
        return items[:100]

    def workspace(self, actor_id: str, internship_id: str = "") -> dict[str,Any]:
        internship_id = internship_id or self.current_internship_id(actor_id)
        if not internship_id:
            return {
                "state":"none",
                "simulation":True,
                "start_options":self.start_options(actor_id),
                "sections":["overview","inbox","work","company","documents","meetings","mentor","activity"],
            }
        context = self._context(actor_id,internship_id)
        tasks = self._visible_tasks(context)
        people = self._visible_people(context,tasks)
        threads = self._threads(context,people)
        documents = self._documents(context,False)
        meetings = self._meetings(context,people)
        company = self._company(context,people)
        activity = self._activity(context,threads,meetings)
        status = context.status
        elapsed_days = max(0,int(status.get("elapsed_days") or 0))
        active_tasks = [t for t in tasks if t["status"] in {"available","in_progress"}]
        completed_tasks = [t for t in tasks if t["status"] == "completed"]
        next_deadline = min((int(t["due_at"]) for t in active_tasks if int(t["due_at"]) > 0),default=0)
        upcoming_meetings = [m for m in meetings if m["status"] == "upcoming"]
        next_meeting = min((int(m["scheduled_at"]) for m in upcoming_meetings if int(m["scheduled_at"]) > 0),default=0)
        manifest = _dict(context.definition.get("manifest"))
        return {
            "state":"stopped" if status.get("status") == "stopped" else "active",
            "simulation":True,
            "internship":{
                "internship_id":_text(status.get("internship_id"),128),
                "status":_text(status.get("status"),32),
                "lifecycle_stage":_text(status.get("lifecycle_stage"),64),
                "role_title":_text(_dict(status.get("scenario_pack")).get("role_title") or manifest.get("role_title"),120),
                "scenario_title":_text(_dict(status.get("scenario_pack")).get("title") or manifest.get("title"),160),
                "scenario_version":int(_dict(status.get("scenario_version")).get("version") or manifest.get("scenario_version") or 0),
                "classification":_text(manifest.get("classification"),32),
                "qualifying":bool(status.get("qualifying")),
                "started_at":int(status.get("started_at") or 0),
                "target_end_at":int(status.get("target_end_at") or 0),
                "current_server_time":int(status.get("current_server_time") or 0),
                "minimum_duration_days":max(90,int(status.get("minimum_duration_days") or 90)),
                "elapsed_days":elapsed_days,
                "current_day":elapsed_days + 1,
                "current_week":elapsed_days // 7 + 1,
                "expected_workload_band":_text(manifest.get("expected_workload_band"),32),
                "stopped_at":int(status.get("stopped_at") or 0),
            },
            "overview":{
                "active_task_count":len(active_tasks),
                "completed_task_count":len(completed_tasks),
                "next_deadline":next_deadline,
                "next_meeting":next_meeting,
                "recent_threads":threads[:4],
                "recent_activity":activity[:6],
            },
            "company":company,
            "people":people,
            "tasks":tasks,
            "documents":documents,
            "meetings":meetings,
            "threads":threads,
            "reflections":[
                {
                    "reflection_id":_text(_dict(row).get("id"),128),
                    "period_key":_text(_dict(row).get("period_key"),80),
                    "content":_text(_dict(row).get("content"),20000),
                    "created_at":int(_dict(row).get("created_at") or 0),
                    "updated_at":int(_dict(row).get("updated_at") or 0),
                }
                for row in context.reflections
            ],
            "activity":activity,
            "sections":["overview","inbox","work","company","documents","meetings","mentor","activity"],
        }

    def document(self, actor_id: str, internship_id: str, document_id: str) -> dict[str,Any]:
        context = self._context(actor_id,internship_id)
        for document in self._documents(context,True):
            if document.get("document_id") == document_id:
                return document
        raise LookupError("document_not_found")

    @staticmethod
    def mentor_support_level(task: dict[str,Any] | None) -> tuple[int,str]:
        support = _dict((task or {}).get("mentor_support"))
        level = int(support.get("level") or 1)
        return max(0,min(3,level)), _text(support.get("label"),80) or "Clarification only"


__all__ = ["MENTOR_SUPPORT","VirtualInternshipWorkspaceService"]
