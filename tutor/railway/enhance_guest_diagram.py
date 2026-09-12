#!/usr/bin/env python3
"""Add Murikah guest diagram design and harden public completion failures."""
from __future__ import annotations

from pathlib import Path
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
        '_MAX_ATTACHMENT_TEXT_CHARS = 12000\n_GUEST_COMPLETION_TIMEOUT_SECONDS = 75\nlogger = logging.getLogger(__name__)\n_SYSTEM_PROMPT =',
        "guest completion timeout",
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

    completion = '''    client = _client_for_selection(body.llm_selection)\n    answer = await client.complete(\n        _prompt_with_attachments(prompt, body.attachments),\n        system_prompt=_system_prompt(body.mode, body.space, body.configuration, body.persona),\n        history=history,\n        max_tokens=1100,\n    )\n\n    next_used = used + 1\n'''
    resilient = '''    client = _client_for_selection(body.llm_selection)\n    incident_id = uuid.uuid4().hex[:10]\n    max_tokens = 1800 if body.space == "diagram" else 1100\n    try:\n        answer = await asyncio.wait_for(\n            client.complete(\n                _prompt_with_attachments(prompt, body.attachments),\n                system_prompt=_system_prompt(body.mode, body.space, body.configuration, body.persona),\n                history=history,\n                max_tokens=max_tokens,\n            ),\n            timeout=_GUEST_COMPLETION_TIMEOUT_SECONDS,\n        )\n    except asyncio.TimeoutError as exc:\n        logger.warning("Guest completion timed out [%s]", incident_id)\n        raise HTTPException(\n            status_code=status.HTTP_504_GATEWAY_TIMEOUT,\n            detail=f"Tutor took too long to respond. Please try again. Reference {incident_id}.",\n        ) from exc\n    except Exception as exc:\n        logger.exception("Guest completion failed [%s] (%s)", incident_id, type(exc).__name__)\n        raise HTTPException(\n            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,\n            detail=f"Tutor is temporarily unavailable. Please try again. Reference {incident_id}.",\n        ) from exc\n\n    next_used = used + 1\n'''
    text = replace_once(text, completion, resilient, "resilient guest completion")

    target.write_text(text, encoding="utf-8")


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: enhance_guest_diagram.py <deeptutor-checkout>", file=sys.stderr)
        return 2
    root = Path(sys.argv[1]).resolve()
    patch_frontend(root)
    patch_backend(root)
    print("Added Murikah Diagram Design guest experience and resilient guest completion errors.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
