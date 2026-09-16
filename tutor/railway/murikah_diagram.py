"""Bounded, streamed Diagram Design using the current user's allowed models."""
import asyncio
import html.entities
import json
import logging
import re
import uuid
import xml.etree.ElementTree as ET

from fastapi.responses import StreamingResponse
from deeptutor.murikah_fast_lane import (
    HedgeCandidate, close_stream, configured_gemini_model, gemini_configured,
    gemini_stream, validated_stream,
)

from deeptutor.murikah_er import ER_SYSTEM_PROMPT, InvalidERPlan, er_answer, uses_er_plan

logger = logging.getLogger(__name__)
TOTAL_SECONDS = 90
IDLE_SECONDS = 20
FIRST_OUTPUT_SECONDS = 25
CANDIDATE_SECONDS = 75
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
        candidates.append(HedgeCandidate(f"diagram-model-{len(candidates)}", len(candidates) * 2.5,
            lambda c=config: factory.stream(
                prompt="", system_prompt="", messages=messages,
                model=c.model, api_key=c.api_key,
                base_url=c.effective_url or c.base_url, api_version=c.api_version,
                binding=c.provider_name or c.binding, extra_headers=c.extra_headers,
                reasoning_effort=c.reasoning_effort, max_retries=0, max_tokens=6000,
                stream_coalesce_chars=64, stream_coalesce_seconds=0.05,
            )))
    return candidates


class InvalidDiagram(ValueError):
    pass


def validate_answer(answer):
    match = re.search(r"<svg\b[\s\S]*?</svg>", answer, re.I)
    if not match:
        raise InvalidDiagram("Diagram did not contain a complete SVG")
    raw = match.group(0)
    # Models often produce browser-valid label text that is not valid XML.
    # Normalize only entities; never guess missing elements or invent a diagram.
    def entity(match):
        name = match.group(1)
        if name in {"amp", "lt", "gt", "quot", "apos"}:
            return match.group(0)
        code = html.entities.name2codepoint.get(name)
        return f"&#{code};" if code else "&amp;" + name + ";"
    raw = re.sub(r"&([A-Za-z][A-Za-z0-9]+);", entity, raw)
    raw = re.sub(r"&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)", "&amp;", raw)
    try:
        svg = ET.fromstring(raw)
    except ET.ParseError as exc:
        raise InvalidDiagram("Diagram contains malformed SVG") from exc
    if svg.tag.split("}")[-1] != "svg" or not svg.get("viewBox"):
        raise InvalidDiagram("Diagram is missing its viewBox")
    return answer[:match.start()] + raw + answer[match.end():]


async def collect_candidate(candidate, updates, reference, validator=validate_answer, structured=False):
    """A provider wins only after producing a complete, validated diagram."""
    stream = None
    try:
        await asyncio.sleep(candidate.delay_seconds)
        async with asyncio.timeout(CANDIDATE_SECONDS):
            stream = validated_stream(candidate.factory())
            parts, length, in_think = [], 0, False
            while True:
                try:
                    chunk = await asyncio.wait_for(anext(stream),
                        IDLE_SECONDS if length else FIRST_OUTPUT_SECONDS)
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
                    raise InvalidDiagram("Diagram is too large")
                if updates.qsize() < 4:
                    updates.put_nowait(("progress", length))
                # Do not wait for extra prose after a finished SVG.
                if (structured and "}" in chunk) or "</svg>" in "".join(parts).lower():
                    try:
                        answer = validator("".join(parts))
                    except (InvalidDiagram, InvalidERPlan):
                        continue
                    updates.put_nowait(("done", answer))
                    return
            updates.put_nowait(("done", validator("".join(parts))))
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        # Log the stage/type only: never prompts, provider URLs or secrets.
        code = "invalid_svg" if isinstance(exc, (InvalidDiagram, InvalidERPlan)) else "timeout" if isinstance(exc, TimeoutError) else "provider_unavailable"
        logger.warning("Diagram candidate failed [%s] candidate=%s reason=%s", reference, candidate.name, code)
        updates.put_nowait(("failed", code))
    finally:
        await close_stream(stream)


def event(kind, **fields):
    return json.dumps({"type": kind, **fields}) + "\n"


async def diagram_events(prompt, system_prompt, scope, diagram_type="auto", style="editorial"):
    reference = uuid.uuid4().hex[:10]
    tasks = []
    completed = False
    try:
        yield event("status", message="Connecting to a design model…")
        async with asyncio.timeout(TOTAL_SECONDS):
            messages = [{"role": "system", "content": system_prompt +
                "\nReturn a concise explanation and one complete fenced SVG. "
                "Keep labels short, fit all elements inside the viewBox, and close every tag. "
                "Escape ampersands in labels as &amp;. Do not include a reasoning trace."},
                {"role": "user", "content": prompt}]
            structured = uses_er_plan(prompt, diagram_type)
            validator = (lambda answer: er_answer(answer, style)) if structured else validate_answer
            if structured:
                messages[0]["content"] = ER_SYSTEM_PROMPT
                yield event("status", message="Planning entities, keys and relationships…")
            candidates = candidates_for(messages)
            if not candidates:
                raise RuntimeError("no_models")
            updates = asyncio.Queue()
            tasks = [asyncio.create_task(collect_candidate(c, updates, reference, validator, structured)) for c in candidates]
            remaining = len(tasks)
            failures = []
            characters = 0
            while remaining:
                try:
                    kind, value = await asyncio.wait_for(updates.get(), 5)
                except TimeoutError:
                    yield event("status", message="Waiting for a complete diagram…", characters=characters)
                    continue
                if kind == "progress":
                    characters = max(characters, value)
                    yield event("status", message="Drawing the diagram…", characters=characters)
                elif kind == "failed":
                    remaining -= 1
                    failures.append(value)
                    if remaining:
                        yield event("status", message="Trying another design model…", characters=characters)
                else:
                    completed = True
                    scope["murikah_prompt_completed"] = True
                    yield event("done", answer=value)
                    return
            if "invalid_svg" in failures:
                raise InvalidDiagram("No complete diagram")
            if failures and all(code == "timeout" for code in failures):
                raise TimeoutError()
            raise RuntimeError("providers_unavailable")
    except asyncio.CancelledError:
        if not completed:
            scope["murikah_prompt_failed"] = True
        raise
    except Exception as exc:
        scope["murikah_prompt_failed"] = True
        code = "invalid_svg" if isinstance(exc, (InvalidDiagram, InvalidERPlan)) else "timeout" if isinstance(exc, TimeoutError) else "provider_unavailable"
        logger.warning("Diagram failed [%s] reason=%s type=%s", reference, code, type(exc).__name__)
        message = {
            "invalid_svg": "The design models returned incomplete diagrams.",
            "timeout": "The design models did not finish in time.",
            "provider_unavailable": "The design models are currently unavailable.",
        }[code]
        yield event("error", code=code, message=f"{message} Your brief is still here. Please try again. Reference {reference}.")
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


def diagram_response(prompt, system_prompt, scope, diagram_type="auto", style="editorial"):
    return StreamingResponse(diagram_events(prompt, system_prompt, scope, diagram_type, style),
        media_type="application/x-ndjson", headers={
            "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no",
        })
