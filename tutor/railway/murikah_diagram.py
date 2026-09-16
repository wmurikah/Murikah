"""Bounded, streamed Diagram Design using the current user's allowed models."""
import asyncio
import json
import logging
import re
import time
import uuid
import xml.etree.ElementTree as ET

from fastapi.responses import StreamingResponse
from deeptutor.murikah_fast_lane import (
    HedgeCandidate, close_stream, configured_gemini_model, gemini_configured,
    gemini_stream, race_first_visible,
)

logger = logging.getLogger(__name__)
TOTAL_SECONDS = 90
IDLE_SECONDS = 20
MAX_CHARS = 100_000


def candidates_for(messages):
    from deeptutor.multi_user.model_access import allowed_llm_options
    from deeptutor.services.model_selection.runtime import resolve_llm_config_for_selection
    from deeptutor.services.llm import factory

    options = allowed_llm_options()
    selections = [options.get("active"), *(options.get("options") or [])]
    configs, seen = [], set()
    for selection in selections:
        if not selection:
            continue
        key = (selection.get("profile_id"), selection.get("model_id"))
        if key in seen:
            continue
        seen.add(key)
        try:
            configs.append(resolve_llm_config_for_selection(selection))
        except Exception:
            logger.warning("Diagram model configuration unavailable")
    candidates = []
    # Native Gemini is eligible only if that model is granted to this user.
    if gemini_configured() and any(c.model == configured_gemini_model() for c in configs):
        candidates.append(HedgeCandidate("diagram-gemini", 0,
            lambda: gemini_stream(messages, max_tokens=6000)))
    for config in configs[:3]:
        candidates.append(HedgeCandidate("diagram-model", len(candidates) * 2.5,
            lambda c=config: factory.stream(
                prompt="", system_prompt="", messages=messages,
                model=c.model, api_key=c.api_key,
                base_url=c.effective_url or c.base_url, api_version=c.api_version,
                binding=c.provider_name or c.binding, extra_headers=c.extra_headers,
                reasoning_effort=c.reasoning_effort, max_retries=0, max_tokens=6000,
                stream_coalesce_chars=64, stream_coalesce_seconds=0.05,
            )))
    return candidates


def validate_answer(answer):
    match = re.search(r"<svg\b[\s\S]*?</svg>", answer, re.I)
    if not match:
        raise ValueError("Diagram did not contain a complete SVG")
    svg = ET.fromstring(match.group(0))
    if svg.tag.split("}")[-1] != "svg" or not svg.get("viewBox"):
        raise ValueError("Diagram is missing its viewBox")
    return answer


def event(kind, **fields):
    return json.dumps({"type": kind, **fields}) + "\n"


async def diagram_events(prompt, system_prompt, scope):
    reference = uuid.uuid4().hex[:10]
    winner = None
    completed = False
    try:
        # Flush immediately: the browser can animate while providers start.
        yield event("status", message="Connecting to a design model…")
        async with asyncio.timeout(TOTAL_SECONDS):
            messages = [{"role": "system", "content": system_prompt +
                "\nReturn a concise explanation and one complete fenced SVG. "
                "Keep labels short, fit all elements inside the viewBox, and close every tag. "
                "Do not include a reasoning trace."}, {"role": "user", "content": prompt}]
            winner = await race_first_visible(candidates_for(messages),
                request_started=time.perf_counter(), first_token_timeout=8, overall_timeout=14)
            if winner is None:
                raise RuntimeError("No responsive design model")
            parts = [winner.first_chunk]
            length = len(winner.first_chunk)
            in_think = False
            yield event("status", message="Drawing the diagram…", characters=length)
            while True:
                try:
                    chunk = await asyncio.wait_for(anext(winner.stream), IDLE_SECONDS)
                except StopAsyncIteration:
                    break
                if chunk == "<think>":
                    in_think = True
                    continue
                if chunk == "</think>":
                    in_think = False
                    continue
                if in_think or not chunk:
                    continue
                parts.append(chunk)
                length += len(chunk)
                if length > MAX_CHARS:
                    raise ValueError("Diagram is too large")
                yield event("status", message="Drawing the diagram…", characters=length)
            yield event("status", message="Checking the finished diagram…")
            answer = validate_answer("".join(parts))
            completed = True
            scope["murikah_prompt_completed"] = True
            yield event("done", answer=answer)
    except asyncio.CancelledError:
        if not completed:
            scope["murikah_prompt_failed"] = True
        raise
    except Exception as exc:
        scope["murikah_prompt_failed"] = True
        logger.warning("Diagram failed [%s] (%s)", reference, type(exc).__name__)
        message = ("Diagram Design took too long to respond." if isinstance(exc, TimeoutError)
                   else "Diagram Design could not finish this diagram.")
        yield event("error", message=f"{message} Your brief is still here. Please try again. Reference {reference}.")
    finally:
        if winner is not None:
            await close_stream(winner.stream)


def diagram_response(prompt, system_prompt, scope):
    return StreamingResponse(diagram_events(prompt, system_prompt, scope),
        media_type="application/x-ndjson", headers={
            "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no",
        })
