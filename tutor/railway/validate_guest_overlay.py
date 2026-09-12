#!/usr/bin/env python3
"""Build-time invariants for the Murikah Tutor guest experience overlay."""
from __future__ import annotations

import sys
from pathlib import Path


def require_markers(path: Path, markers: tuple[str, ...]) -> None:
    if not path.is_file():
        raise RuntimeError(f"missing guest overlay file: {path}")
    content = path.read_text(encoding="utf-8")
    for marker in markers:
        if marker not in content:
            raise RuntimeError(f"guest overlay invariant missing in {path}: {marker!r}")


def forbid_markers(path: Path, markers: tuple[str, ...]) -> None:
    if not path.is_file():
        raise RuntimeError(f"missing guest overlay file: {path}")
    content = path.read_text(encoding="utf-8")
    for marker in markers:
        if marker in content:
            raise RuntimeError(f"guest overlay forbidden marker present in {path}: {marker!r}")


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: validate_guest_overlay.py <deeptutor-root>")
    root = Path(sys.argv[1]).resolve()
    guest_chat = root / "web/components/chat/MurikahGuestChat.tsx"

    require_markers(
        guest_chat,
        (
            "murikah:tutor:guest-handoff:v2",
            "Voice input",
            "const PERSONAS = [",
            'label: "Tutor"',
            'label: "Peer"',
            'label: "Research Assistant"',
            "Persona · {activePersona.label}",
            "DEFAULT_MODE_BY_SPACE",
            "SPACE_PLACEHOLDERS",
            "composerPlaceholder",
            "const GUEST_SPACE_IDS: SpaceId[]",
            '"cowriter"',
            '"book"',
            '"mastery"',
            '"reading"',
            '"learning-space"',
            "const [mobileExploreOpen, setMobileExploreOpen] = useState(false);",
            "function resetGuestConversation()",
            "setMessages([]);",
            "handoffIdRef.current = createHandoffId();",
            "function selectMode(nextMode: ModeId)",
            "onClick={() => selectMode(mode.id)}",
            "Guest learning experiences",
            "More when you sign in",
            "animate-pulse text-[#A9822E]",
            "Upload text file",
            "You have used up 7 of the 7 Guest Interactions. Please sign in.",
            'import MarkdownRenderer from "@/components/common/MarkdownRenderer";',
            'message.role === "assistant" ? (',
            "<MarkdownRenderer",
            "content={message.content}",
        ),
    )
    forbid_markers(
        guest_chat,
        (
            "Tutor persona / personalisation",
            ">Personalise</span>",
            "of 7 guest interactions remaining",
            'guest {remaining === 1 ? "interaction" : "interactions"} left',
            "function SpaceConfigurator({",
            "<SpaceConfigurator space={activeSpace}",
            "setLlmSelection(",
            "/api/murikah/guest-models",
            "setSpaceConfigOverrides({ ...emptyOverrides(), ...stored.spaceConfigOverrides })",
            'className="h-screen overflow-hidden bg-[var(--background)]',
            "ref={contentRef}",
            "overflow-y-auto overscroll-contain scroll-smooth",
            "Choose Learning Mode",
        ),
    )
    require_markers(
        root / "web/components/chat/MurikahGuestResume.tsx",
        (
            "/api/murikah/guest-handoff",
            "Continuing your guest conversation",
            "resume_guest",
        ),
    )
    require_markers(
        root / "web/app/(workspace)/chat/page.tsx",
        ("MurikahGuestResume", "<ChatWorkspace />"),
    )
    require_markers(
        root / "deeptutor/api/routers/murikah_guest.py",
        (
            '@router.get("/guest-models")',
            '@router.post("/guest-handoff")',
            "next_used = used + 1",
            "resolve_llm_config_for_selection",
        ),
    )


if __name__ == "__main__":
    main()
