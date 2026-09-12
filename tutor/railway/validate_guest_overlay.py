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
            "Choose Learning Mode",
            'const [learningModeOpen, setLearningModeOpen] = useState(false);',
            "murikah:tutor:guest-handoff:v2",
            "/api/murikah/guest-models",
            "Voice input",
            "const PERSONAS = [",
            'label: "Tutor"',
            'label: "Peer"',
            'label: "Research Assistant"',
            "Persona · {activePersona.label}",
            "DEFAULT_MODE_BY_SPACE",
            "Upload text file",
            "You have used up 7 of the 7 Guest Interactions. Please sign in.",
            "overflow-y-auto overscroll-contain scroll-smooth",
        ),
    )
    forbid_markers(
        guest_chat,
        (
            "Tutor persona / personalisation",
            ">Personalise</span>",
            "of 7 guest interactions remaining",
            'guest {remaining === 1 ? "interaction" : "interactions"} left',
            "<SpaceConfigurator space={activeSpace}",
            "setLlmSelection(",
            "setSpaceConfigOverrides({ ...emptyOverrides(), ...stored.spaceConfigOverrides })",
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
