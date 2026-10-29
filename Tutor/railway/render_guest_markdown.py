#!/usr/bin/env python3
"""Render Murikah guest assistant replies with DeepTutor's normal Markdown renderer."""
from __future__ import annotations

from pathlib import Path
import sys


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"Expected exactly one {label}, found {count}")
    return text.replace(old, new, 1)


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: render_guest_markdown.py <deeptutor-checkout>", file=sys.stderr)
        return 2

    root = Path(sys.argv[1]).resolve()
    target = root / "web" / "components" / "chat" / "MurikahGuestChat.tsx"
    if not target.is_file():
        raise RuntimeError(f"Murikah guest component is missing: {target}")

    text = target.read_text(encoding="utf-8")

    text = replace_once(
        text,
        'import MurikahSocialButtons from "@/components/auth/MurikahSocialButtons";\n',
        'import MurikahSocialButtons from "@/components/auth/MurikahSocialButtons";\nimport MarkdownRenderer from "@/components/common/MarkdownRenderer";\n',
        "guest MarkdownRenderer import",
    )

    text = replace_once(
        text,
        '                    <div className="whitespace-pre-wrap text-[15px] leading-7">{message.content}</div>',
        '''                    {message.role === "assistant" ? (\n                      <MarkdownRenderer\n                        content={message.content}\n                        className="text-[15px] leading-7"\n                      />\n                    ) : (\n                      <div className="whitespace-pre-wrap text-[15px] leading-7">{message.content}</div>\n                    )}''',
        "guest message renderer",
    )

    target.write_text(text, encoding="utf-8")
    print("Enabled formatted Markdown rendering for Murikah guest assistant responses.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
