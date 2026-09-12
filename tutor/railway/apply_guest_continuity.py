#!/usr/bin/env python3
"""Apply Murikah Tutor guest-to-account continuation to pinned DeepTutor source."""
from __future__ import annotations

import shutil
import sys
from pathlib import Path


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"Expected exactly one match in {path}, found {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: apply_guest_continuity.py <deeptutor-root> <resume-component>")

    root = Path(sys.argv[1]).resolve()
    resume_source = Path(sys.argv[2]).resolve()
    if not root.is_dir():
        raise RuntimeError(f"DeepTutor root not found: {root}")
    if not resume_source.is_file():
        raise RuntimeError(f"Resume component not found: {resume_source}")

    destination = root / "web/components/chat/MurikahGuestResume.tsx"
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(resume_source, destination)

    chat_page = root / "web/app/(workspace)/chat/page.tsx"
    replace_once(
        chat_page,
        'import ChatWorkspace from "@/features/chat/components/ChatWorkspace";\n\n'
        'export default function ChatPage() {\n'
        '  return <ChatWorkspace />;\n'
        '}\n',
        'import ChatWorkspace from "@/features/chat/components/ChatWorkspace";\n'
        'import MurikahGuestResume from "@/components/chat/MurikahGuestResume";\n\n'
        'export default function ChatPage() {\n'
        '  return (\n'
        '    <>\n'
        '      <MurikahGuestResume />\n'
        '      <ChatWorkspace />\n'
        '    </>\n'
        '  );\n'
        '}\n',
    )


if __name__ == "__main__":
    main()
