#!/usr/bin/env python3
"""Brand user-visible chat progress states as Murikah."""
from __future__ import annotations

import json
from pathlib import Path
import sys


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: brand_chat_status.py <deeptutor-checkout>", file=sys.stderr)
        return 2
    root = Path(sys.argv[1]).resolve()
    locale_path = root / "web/locales/en/app.json"
    data = json.loads(locale_path.read_text(encoding="utf-8"))

    replacements = {
        "{{name}} Reasoning…": "Murikah is reasoning…",
        "{{name}} Planning…": "Murikah is planning…",
        "{{name}} Exploring…": "Murikah is exploring…",
        "{{name}} Quizzing…": "Murikah is preparing a quiz…",
        "{{name}} Reflecting…": "Murikah is reflecting…",
        "DeepTutor Exploring…": "Murikah is exploring…",
        "DeepTutor Reflecting…": "Murikah is reflecting…",
        "Working...": "Murikah is working…",
        "Working…": "Murikah is working…",
        "Thinking...": "Murikah is thinking…",
        "Thinking…": "Murikah is thinking…",
    }
    missing = [key for key in replacements if key not in data]
    if missing:
        raise RuntimeError(f"Pinned DeepTutor chat-status keys changed: {missing}")
    for key, value in replacements.items():
        data[key] = value

    locale_path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print("Applied Murikah chat-status branding.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
