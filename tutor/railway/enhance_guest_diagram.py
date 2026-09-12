#!/usr/bin/env python3
"""Add Murikah Diagram Design and harden public completion failures."""
from __future__ import annotations

from pathlib import Path
import shutil
import sys


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"Expected exactly one {label}, found {count}")
    return text.replace(old, new, 1)


def patch_frontend(root: Path) -> None:
    target = root / "web" / "components" / "chat" / "MurikahGuestChat.tsx"
    if not target.is_file():
        raise RuntimeError(f"Murikah guest component is missing: {target}")
    text = target.read_text(encoding="utf-8")

    text = replace_once(
        text,
        '  | "learning-space"\n  | "memory"',
        '  | "learning-space"\n  | "diagram"\n  | "memory"',
        "diagram guest space type",
    )

    learning_space = '''  {\n    id: "learning-space",\n    label: "Learning Space",\n    description: "Open a focused learning session with sensible default pacing and assessment.",\n    icon: Grid3X3,\n  },\n'''
    text = replace_once(
        text,
        learning_space,
        learning_space
        + '''  {\n    id: "diagram",\n    label: "Diagram Design",\n    description: "Turn an idea, process, architecture or data story into an editorial diagram.",\n    icon: BarChart3,\n  },\n''',
        "diagram guest space option",
    )

    text = replace_once(
        text,
        '  memory: [\n',
        '  diagram: [],\n  memory: [\n',
        "diagram space configuration",
    )
    text = replace_once(
        text,
        '    "learning-space": {},\n    memory: {},',
        '    "learning-space": {},\n    diagram: {},\n    memory: {},',
        "diagram empty overrides",
    )
    text = replace_once(
        text,
        '  "learning-space": "course",\n  memory: "chat",',
        '  "learning-space": "course",\n  diagram: "visualize",\n  memory: "chat",',
        "diagram default mode",
    )
    text = replace_once(
        text,
        '  "learning-space": "What topic or learning objective should we work on?",\n  memory:',
        '  "learning-space": "What topic or learning objective should we work on?",\n  diagram: "What should the diagram explain, compare or map?",\n  memory:',
        "diagram composer placeholder",
    )
    text = replace_once(
        text,
        '  "learning-space",\n];',
        '  "learning-space",\n  "diagram",\n];',
        "diagram public guest navigation",
    )

    diagram_helpers = r'''

function extractDiagramSvg(content: string): { narrative: string; svg: string } | null {
  const fenced = content.match(/```svg\s*([\s\S]*?)```/i);
  const inline = content.match(/<svg\b[\s\S]*?<\/svg>/i);
  const raw = fenced?.[1] || inline?.[0] || "";
  const start = raw.search(/<svg\b/i);
  const end = raw.toLowerCase().lastIndexOf("</svg>");
  if (start < 0 || end < 0) return null;
  const svg = raw.slice(start, end + 6)
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<foreignObject\b[\s\S]*?<\/foreignObject>/gi, "")
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(?:href|xlink:href)\s*=\s*(?:"(?:https?:|\/\/)[^"]*"|'(?:https?:|\/\/)[^']*')/gi, "");
  const narrative = (fenced ? content.replace(fenced[0], "") : content.replace(inline?.[0] || "", "")).trim();
  return { narrative, svg };
}

function DiagramMessage({ content }: { content: string }) {
  const diagram = extractDiagramSvg(content);
  if (!diagram) {
    return <MarkdownRenderer content={content} className="text-[15px] leading-7" />;
  }
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;padding:0;background:#f7f5f0}body{display:grid;place-items:center;min-height:100vh;padding:18px;box-sizing:border-box}svg{display:block;max-width:100%;height:auto}</style></head><body>${diagram.svg}</body></html>`;
  return (
    <div className="space-y-3">
      {diagram.narrative && <MarkdownRenderer content={diagram.narrative} className="text-[15px] leading-7" />}
      <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[#f7f5f0] shadow-sm">
        <iframe
          title="Murikah Tutor generated diagram"
          sandbox=""
          srcDoc={srcDoc}
          className="h-[380px] w-full border-0 sm:h-[520px]"
          loading="lazy"
        />
      </div>
      <p className="text-[11px] leading-5 text-[var(--muted-foreground)]">Diagram preview is isolated from the Tutor page and cannot run scripts or load external resources.</p>
    </div>
  );
}
'''
    text = replace_once(
        text,
        '\n\nexport default function MurikahGuestChat() {',
        diagram_helpers + '\n\nexport default function MurikahGuestChat() {',
        "diagram preview renderer",
    )

    markdown_block = '''                    {message.role === "assistant" ? (\n                      <MarkdownRenderer\n                        content={message.content}\n                        className="text-[15px] leading-7"\n                      />\n                    ) : ('''
    diagram_block = '''                    {message.role === "assistant" ? (\n                      activeSpace.id === "diagram" ? (\n                        <DiagramMessage content={message.content} />\n                      ) : (\n                        <MarkdownRenderer\n                          content={message.content}\n                          className="text-[15px] leading-7"\n                        />\n                      )\n                    ) : ('''
    text = replace_once(text, markdown_block, diagram_block, "diagram assistant rendering")

    text = replace_once(
        text,
        '          typeof data.detail === "string" ? data.detail : "Tutor could not answer that prompt.",',
        '          typeof data.detail === "string" ? data.detail : "Tutor is temporarily unavailable. Your prompt is still here — please try again.",',
        "guest response fallback",
    )
    text = replace_once(
        text,
        '    } catch (cause) {\n      setError(cause instanceof Error ? cause.message : "Tutor could not answer that prompt.");\n    } finally {',
        '    } catch (cause) {\n      setDraft(prompt);\n      setError(cause instanceof Error ? cause.message : "We lost the connection before Tutor replied. Your prompt is still here — please try again.");\n    } finally {',
        "guest retryable prompt preservation",
    )

    target.write_text(text, encoding="utf-8")


def install_authenticated_diagram(root: Path) -> None:
    overlay = Path(__file__).resolve().parent
    studio_source = overlay / "MurikahDiagramStudio.tsx"
    page_source = overlay / "murikah-diagram-page.tsx"
    if not studio_source.is_file() or not page_source.is_file():
        raise RuntimeError("Diagram Design overlay sources are missing")

    studio_target = root / "web" / "components" / "diagram" / "MurikahDiagramStudio.tsx"
    page_target = root / "web" / "app" / "(workspace)" / "diagram-design" / "page.tsx"
    studio_target.parent.mkdir(parents=True, exist_ok=True)
    page_target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(studio_source, studio_target)
    shutil.copy2(page_source, page_target)

    nav = root / "web" / "components" / "sidebar" / "nav-entries.ts"
    nav_text = nav.read_text(encoding="utf-8")
    nav_text = replace_once(
        nav_text,
        '  Settings,\n  type LucideIcon,',
        '  Settings,\n  Workflow,\n  type LucideIcon,',
        "Diagram Design sidebar icon import",
    )
    cowriter = '''  {\n    href: "/co-writer",\n    label: "Co-Writer",\n    icon: PenLine,\n    tooltipKey: "Co-Writer tooltip",\n    requires: "llm",\n  },\n'''
    nav_text = replace_once(
        nav_text,
        cowriter,
        cowriter
        + '''  {\n    href: "/diagram-design",\n    label: "Diagram Design",\n    icon: Workflow,\n    tooltipKey: "Turn ideas into editorial diagrams",\n    requires: "llm",\n  },\n''',
        "Diagram Design authenticated nav entry",
    )
    nav.write_text(nav_text, encoding="utf-8")


def patch_backend(root: Path) -> None:
    target = root / "deeptutor" / "api" / "routers" / "murikah_guest.py"
    if not target.is_file():
        raise RuntimeError(f"Murikah guest router is missing: {target}")
    text = target.read_text(encoding="utf-8")

    text = replace_once(
        text,
        'import base64\nimport hashlib\nimport hmac\nimport json\nimport os\nfrom typing import Any, Literal\n',
        'import asyncio\nimport base64\nimport hashlib\nimport hmac\nimport json\nimport logging\nimport os\nfrom typing import Any, Literal\nimport uuid\n',
        "guest resilience imports",
    )
    text = replace_once(
        text,
        '_MAX_ATTACHMENT_TEXT_CHARS = 12000\n_SYSTEM_PROMPT =',
        '''_MAX_ATTACHMENT_TEXT_CHARS = 12000\n_GUEST_COMPLETION_TIMEOUT_SECONDS = 75\nlogger = logging.getLogger(__name__)\n_DIAGRAM_TYPES = {\n    "auto", "architecture", "flowchart", "sequence", "state machine", "er / data model",\n    "timeline", "swimlane", "quadrant", "radar", "loop / flywheel", "nested hierarchy",\n    "tree", "org chart", "layer stack", "venn", "pyramid / funnel", "bar chart", "treemap",\n    "line chart", "gantt", "scatter plot", "high-level system", "process", "medallion",\n    "data flow", "integration", "security matrix", "sankey", "fishbone", "wardley map",\n    "kanban", "user journey", "deployment", "dependency graph", "uml class", "story map",\n    "database schema", "polar chart", "waterfall",\n}\n_SYSTEM_PROMPT =''',
        "guest completion timeout and diagram grammar set",
    )
    text = replace_once(
        text,
        '    "learning-space",\n    "memory",',
        '    "learning-space",\n    "diagram",\n    "memory",',
        "backend diagram space type",
    )
    text = replace_once(
        text,
        '    "learning-space": "Frame the session around the selected objective, session length, teaching style, pace, examples, practice and assessment controls.",\n    "memory":',
        '    "learning-space": "Frame the session around the selected objective, session length, teaching style, pace, examples, practice and assessment controls.",\n    "diagram": "Design an editorial-quality diagram that makes the learner\'s idea easier to understand. Choose the most suitable grammar from architecture, flowchart, sequence, state, ER/data model, timeline, swimlane, quadrant, radar, loop/flywheel, nested hierarchy, tree, org chart, layers, Venn, pyramid/funnel, bar, treemap, line, Gantt, scatter, high-level system, process, medallion, data flow, integration, security matrix, Sankey, fishbone, Wardley map, kanban, user journey, deployment, dependency graph, UML class, story map, database schema, polar or waterfall. Keep visual density restrained, reserve the brass accent for the most important 1–2 elements, and avoid decorative shadows. Return a short explanation followed by one fenced svg block containing a self-contained SVG with a viewBox. Use no scripts, foreignObject, hyperlinks, remote images, external fonts or network resources. Prefer Murikah ink #1E2A30, brass #A9822E, graphite and warm paper #F7F5F0.",\n    "memory":',
        "diagram space guidance",
    )

    text = replace_once(
        text,
        '\n\nclass GuestHandoffRequest(BaseModel):',
        '''\n\nclass DiagramDesignRequest(BaseModel):\n    prompt: str = Field(min_length=1, max_length=_MAX_PROMPT_CHARS)\n    diagram_type: str = Field(default="auto", max_length=80)\n    style: Literal["editorial", "minimal-light", "minimal-dark"] = "editorial"\n\n\nclass GuestHandoffRequest(BaseModel):''',
        "authenticated diagram request model",
    )

    completion = '''    client = _client_for_selection(body.llm_selection)\n    answer = await client.complete(\n        _prompt_with_attachments(prompt, body.attachments),\n        system_prompt=_system_prompt(body.mode, body.space, body.configuration, body.persona),\n        history=history,\n        max_tokens=1100,\n    )\n\n    next_used = used + 1\n'''
    resilient = '''    client = _client_for_selection(body.llm_selection)\n    incident_id = uuid.uuid4().hex[:10]\n    max_tokens = 1800 if body.space == "diagram" else 1100\n    try:\n        answer = await asyncio.wait_for(\n            client.complete(\n                _prompt_with_attachments(prompt, body.attachments),\n                system_prompt=_system_prompt(body.mode, body.space, body.configuration, body.persona),\n                history=history,\n                max_tokens=max_tokens,\n            ),\n            timeout=_GUEST_COMPLETION_TIMEOUT_SECONDS,\n        )\n    except asyncio.TimeoutError as exc:\n        logger.warning("Guest completion timed out [%s]", incident_id)\n        raise HTTPException(\n            status_code=status.HTTP_504_GATEWAY_TIMEOUT,\n            detail=f"Tutor took too long to respond. Please try again. Reference {incident_id}.",\n        ) from exc\n    except Exception as exc:\n        logger.exception("Guest completion failed [%s] (%s)", incident_id, type(exc).__name__)\n        raise HTTPException(\n            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,\n            detail=f"Tutor is temporarily unavailable. Please try again. Reference {incident_id}.",\n        ) from exc\n\n    next_used = used + 1\n'''
    text = replace_once(text, completion, resilient, "resilient guest completion")

    handoff_marker = '\n\n@router.post("/guest-handoff")\n'
    diagram_endpoint = '''\n\n@router.post("/diagram")\nasync def diagram_design(\n    body: DiagramDesignRequest,\n    _: Any = Depends(require_auth),\n) -> dict[str, str]:\n    prompt = body.prompt.strip()\n    if not prompt:\n        raise HTTPException(status_code=422, detail="Prompt cannot be empty")\n\n    requested = " ".join(body.diagram_type.strip().lower().split())\n    if requested not in _DIAGRAM_TYPES:\n        requested = "auto"\n    style_guidance = {\n        "editorial": "Use a full editorial composition with clear hierarchy, restrained annotation and purposeful brass accents.",\n        "minimal-light": "Use a minimal light composition on warm paper with only essential labels and lines.",\n        "minimal-dark": "Use a minimal dark composition with high-contrast labels and restrained brass accents.",\n    }[body.style]\n    type_guidance = (\n        "Choose the best grammar yourself."\n        if requested == "auto"\n        else f"Use the requested diagram grammar: {requested}."\n    )\n    system_prompt = (\n        f"{_SYSTEM_PROMPT}\\n\\n{_SPACE_GUIDANCE['diagram']}\\n"\n        f"{type_guidance} {style_guidance}"\n    )\n    client = _client_for_selection(None)\n    incident_id = uuid.uuid4().hex[:10]\n    try:\n        answer = await asyncio.wait_for(\n            client.complete(prompt, system_prompt=system_prompt, max_tokens=2200),\n            timeout=_GUEST_COMPLETION_TIMEOUT_SECONDS,\n        )\n    except asyncio.TimeoutError as exc:\n        logger.warning("Diagram Design completion timed out [%s]", incident_id)\n        raise HTTPException(\n            status_code=status.HTTP_504_GATEWAY_TIMEOUT,\n            detail=f"Diagram Design took too long to respond. Please try again. Reference {incident_id}.",\n        ) from exc\n    except Exception as exc:\n        logger.exception("Diagram Design completion failed [%s] (%s)", incident_id, type(exc).__name__)\n        raise HTTPException(\n            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,\n            detail=f"Diagram Design is temporarily unavailable. Please try again. Reference {incident_id}.",\n        ) from exc\n    return {"answer": str(answer)}\n'''
    text = replace_once(
        text,
        handoff_marker,
        diagram_endpoint + handoff_marker,
        "authenticated diagram endpoint",
    )

    target.write_text(text, encoding="utf-8")


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: enhance_guest_diagram.py <deeptutor-checkout>", file=sys.stderr)
        return 2
    root = Path(sys.argv[1]).resolve()
    patch_frontend(root)
    install_authenticated_diagram(root)
    patch_backend(root)
    print("Added Murikah Diagram Design and resilient guest completion errors.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
