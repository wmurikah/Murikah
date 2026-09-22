#!/usr/bin/env python3
"""Patch pinned DeepTutor turn execution with Murikah's D1 learning journal."""
from __future__ import annotations

from pathlib import Path
import sys


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"Expected one pinned DeepTutor {label}, found {count}.")
    return text.replace(old, new, 1)


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: persist_learning_journal.py <deeptutor-checkout>", file=sys.stderr)
        return 2
    root = Path(sys.argv[1]).resolve()
    target = root / "deeptutor/services/session/turns/executor.py"
    text = target.read_text(encoding="utf-8")

    if "MURIKAH_D1_LEARNING_JOURNAL_V2" in text:
        return 0

    text = replace_once(
        text,
        """        provider_response_state: dict[str, Any] | None = None
""",
        """        provider_response_state: dict[str, Any] | None = None
        # MURIKAH_D1_LEARNING_JOURNAL_V2
        # D1 is the durable system of record for learner turns. DeepTutor's
        # SQLite session store remains an execution cache for the pinned
        # upstream engine, but no completed Murikah chat exists only there.
        murikah_journal_started = False
        murikah_journal_terminal = False
        murikah_journal_started_at = asyncio.get_running_loop().time()
        _murikah_journal = None
        _murikah_turn_start = {}
""",
        "journal lifecycle state",
    )

    text = replace_once(
        text,
        """            raw_user_content = str(payload.get("content", "") or "")
""",
        """            raw_user_content = str(payload.get("content", "") or "")

            # Persist the learner turn to D1 before context building or model
            # generation. Fail closed on Cloudflare if the journal is unavailable.
            from deeptutor import murikah_persistence as _murikah_journal
            from deeptutor.multi_user.context import get_current_user as _murikah_current_user

            _murikah_actor = _murikah_current_user()
            _murikah_username = str(getattr(_murikah_actor, "username", "") or "")
            _murikah_actor_id = str(
                getattr(_murikah_actor, "id", "")
                or getattr(_murikah_actor, "user_id", "")
                or ""
            )
            _murikah_actor_type = (
                "guest"
                if _murikah_username.startswith("guest_")
                else ("admin" if bool(getattr(_murikah_actor, "is_admin", False)) else "member")
            )
            _murikah_turn_start = await asyncio.to_thread(
                _murikah_journal.learning_turn_start,
                turn_id=turn_id,
                conversation_id=session_id,
                actor_id=_murikah_actor_id,
                actor_type=_murikah_actor_type,
                username=_murikah_username,
                prompt=raw_user_content,
                capability=capability_name or "chat",
                language=str(payload.get("language", "en") or "en"),
                llm_selection=payload.get("llm_selection"),
                regenerate=is_regenerate,
            ) or {}
            murikah_journal_started = True
""",
        "D1 prompt journal",
    )

    text = replace_once(
        text,
        """                    "history_budget": history_result.budget,
                    "turn_id": turn_id,
                    "question_followup_context": followup_question_context or {},
""",
        """                    "history_budget": history_result.budget,
                    "turn_id": turn_id,
                    "murikah_pre_model_ms": max(
                        0,
                        int(
                            (asyncio.get_running_loop().time() - murikah_journal_started_at)
                            * 1000
                        ),
                    ),
                    # Follow-up Fast Path V2: only current-request routing flags
                    # may promote this turn into the deep agent lane. Persisted
                    # conversation metadata is intentionally excluded.
                    "murikah_context_packet": (
                        _murikah_turn_start.get("context_packet", {})
                        if isinstance(_murikah_turn_start, dict)
                        else {}
                    ),
                    "murikah_turn_number": (
                        int(_murikah_turn_start.get("turn_number") or 1)
                        if isinstance(_murikah_turn_start, dict)
                        else 1
                    ),
                    "murikah_is_followup": (
                        bool(_murikah_turn_start.get("is_followup"))
                        if isinstance(_murikah_turn_start, dict)
                        else False
                    ),
                    "murikah_current_turn": {
                        "knowledge_base": bool(payload.get("knowledge_bases") or []),
                        "attachments": bool(attachments),
                        "mastery_mode": workspace_mode == WORKSPACE_MODE_MASTERY,
                        "immersive_reading_mode": workspace_mode == WORKSPACE_MODE_READING,
                        "question_bank_context": bool(question_bank_context),
                        "deep_mode": bool(payload.get("deep_mode")),
                        "research_mode": bool(payload.get("research_mode")),
                        "force_agentic_chat": bool(payload.get("force_agentic_chat")),
                        "tool_execution_requested": bool(payload.get("tool_execution_requested")),
                    },
                    "question_followup_context": followup_question_context or {},
""",
        "turn-scoped fast/deep routing and context packet",
    )

    text = replace_once(
        text,
        """            # Assistant continues the same branch as the user message it
""",
        """            # Commit the full answer and compact response summary to
            # D1 before declaring the turn complete in the local execution cache.
            _murikah_outcome, _murikah_outcome_error = _resolve_turn_outcome(
                assistant_events,
                pending_done_event,
            )
            _murikah_finish_status = (
                _murikah_outcome
                if _murikah_outcome in {"completed", "failed", "timed_out", "cancelled"}
                else "failed"
            )
            _murikah_total_ms = max(
                0,
                int((asyncio.get_running_loop().time() - murikah_journal_started_at) * 1000),
            )
            await asyncio.to_thread(
                _murikah_journal.learning_turn_finish,
                turn_id=turn_id,
                response=assistant_content,
                status=_murikah_finish_status,
                provider=str(context.metadata.get("murikah_provider") or ""),
                model_id=str(context.metadata.get("murikah_model") or ""),
                first_token_ms=int(context.metadata.get("murikah_first_token_ms") or 0),
                total_ms=_murikah_total_ms,
                error_text=str(_murikah_outcome_error or ""),
                retryable=_murikah_finish_status != "completed",
                lane=str(context.metadata.get("murikah_lane") or ""),
                route_reason=str(context.metadata.get("murikah_route_reason") or ""),
                turn_number=int(context.metadata.get("murikah_turn_number") or 1),
                is_followup=bool(context.metadata.get("murikah_is_followup")),
                history_chars=int(context.metadata.get("murikah_history_chars") or 0),
                history_messages=int(context.metadata.get("murikah_history_messages") or 0),
                context_packet_chars=int(context.metadata.get("murikah_context_packet_chars") or 0),
                context_build_ms=int(context.metadata.get("murikah_context_build_ms") or 0),
                output_token_budget=int(context.metadata.get("murikah_output_token_budget") or 0),
                first_token_deadline_ms=int(context.metadata.get("murikah_first_token_deadline_ms") or 0),
                stream_idle_timeout_ms=int(context.metadata.get("murikah_stream_idle_timeout_ms") or 0),
                stream_ms=int(context.metadata.get("murikah_stream_ms") or 0),
                continuation_count=int(context.metadata.get("murikah_continuations") or 0),
                incomplete=bool(context.metadata.get("murikah_incomplete")),
            )
            murikah_journal_terminal = True

            # Assistant continues the same branch as the user message it
""",
        "D1 assistant journal",
    )

    text = replace_once(
        text,
        """        except asyncio.CancelledError:
            if execution.lease_lost:
""",
        """        except asyncio.CancelledError:
            if murikah_journal_started and not murikah_journal_terminal and _murikah_journal is not None:
                with contextlib.suppress(Exception):
                    await asyncio.to_thread(
                        _murikah_journal.learning_turn_fail,
                        turn_id=turn_id,
                        error="Server shutdown interrupted this turn" if execution.shutdown_requested else "Turn cancelled",
                        status="failed" if execution.shutdown_requested else "cancelled",
                        error_code="server_shutdown" if execution.shutdown_requested else "cancelled",
                        retryable=bool(execution.shutdown_requested),
                        total_ms=max(
                            0,
                            int((asyncio.get_running_loop().time() - murikah_journal_started_at) * 1000),
                        ),
                    )
                murikah_journal_terminal = True
            if execution.lease_lost:
""",
        "D1 cancellation journal",
    )

    text = replace_once(
        text,
        """        except Exception as exc:
            if stream_done_sent:
""",
        """        except Exception as exc:
            _murikah_timed_out = isinstance(exc, (TimeoutError, asyncio.TimeoutError))
            _murikah_public_error = "Murikah could not complete this response right now. Please retry."
            if murikah_journal_started and not murikah_journal_terminal and _murikah_journal is not None:
                with contextlib.suppress(Exception):
                    await asyncio.to_thread(
                        _murikah_journal.learning_turn_fail,
                        turn_id=turn_id,
                        error=str(exc),
                        status="timed_out" if _murikah_timed_out else "failed",
                        error_code="fast_lane_timeout" if _murikah_timed_out else "internal_error",
                        retryable=True,
                        total_ms=max(
                            0,
                            int((asyncio.get_running_loop().time() - murikah_journal_started_at) * 1000),
                        ),
                    )
                murikah_journal_terminal = True
            if stream_done_sent:
""",
        "D1 failure journal",
    )

    # DeepTutor normally publishes str(exc) into the user-facing ERROR event.
    # Keep the raw exception in server logs/D1, but never render provider or
    # backend internals in a learner's chat bubble.
    text = replace_once(
        text,
        """                        content=str(exc),
                        metadata={"turn_terminal": True, "status": "failed"},
""",
        """                        content=_murikah_public_error,
                        metadata={
                            "turn_terminal": True,
                            "status": "failed",
                            "error_code": "fast_lane_timeout" if _murikah_timed_out else "internal_error",
                            "retryable": True,
                        },
""",
        "learner-safe terminal error",
    )
    text = replace_once(
        text,
        """                        metadata={"status": "failed"},
""",
        """                        metadata={
                            "status": "failed",
                            "error_code": "fast_lane_timeout" if _murikah_timed_out else "internal_error",
                            "retryable": True,
                        },
""",
        "learner-safe terminal done metadata",
    )

    target.write_text(text, encoding="utf-8")
    print("Applied Murikah D1 learning journal to pinned turn executor.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
