#!/usr/bin/env python3
"""Install the Virtual Internship foundation placeholder into DeepTutor."""
from __future__ import annotations

from pathlib import Path
import shutil
import sys


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"Expected exactly one {label}, found {count}")
    return text.replace(old, new, 1)


def main() -> int:
    if len(sys.argv) != 3:
        print(
            "usage: add_virtual_internship_placeholder.py <deeptutor-checkout> <page.tsx>",
            file=sys.stderr,
        )
        return 2

    root = Path(sys.argv[1]).resolve()
    page_source = Path(sys.argv[2]).resolve()
    if not page_source.is_file():
        raise RuntimeError(f"Missing Virtual Internship page source: {page_source}")

    page_target = root / "web" / "app" / "(workspace)" / "virtual-internship" / "page.tsx"
    page_target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(page_source, page_target)

    nav = root / "web" / "components" / "sidebar" / "nav-entries.ts"
    nav_text = nav.read_text(encoding="utf-8")
    nav_text = replace_once(
        nav_text,
        "  BookText,\n  Bot,",
        "  BookText,\n  Bot,\n  Briefcase,",
        "Virtual Internship sidebar icon import",
    )

    diagram_entry = '''  {
    href: "/diagram-design",
    label: "Diagram Design",
    icon: Workflow,
    tooltipKey: "Turn ideas into editorial diagrams",
    requires: "llm",
  },
'''
    virtual_entry = '''  {
    href: "/virtual-internship",
    label: "Virtual Internship",
    icon: GraduationCap,
    tooltipKey: "A 3+ month simulated workplace with evidence-based competency tracking",
    requires: "llm",
  },
'''
    nav_text = replace_once(
        nav_text,
        diagram_entry,
        diagram_entry + virtual_entry,
        "Virtual Internship authenticated nav entry",
    )
    nav.write_text(nav_text, encoding="utf-8")

    print("Installed Virtual Internship foundation placeholder.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
