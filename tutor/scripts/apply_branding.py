#!/usr/bin/env python3
"""Apply the Murikah Tutor product overlay to a pinned DeepTutor checkout.

This intentionally changes only user-facing identity, presentation, and the
baseline teaching posture. Internal package names, API routes, environment
variables, persistence paths and DeepTutor runtime names remain untouched so
upstream compatibility is preserved.
"""
from __future__ import annotations

from pathlib import Path
import sys


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(
            f"Expected exactly one branding target in {path}, found {count}. "
            "The pinned upstream source may have changed."
        )
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: apply_branding.py <deeptutor-checkout>", file=sys.stderr)
        return 2

    root = Path(sys.argv[1]).resolve()
    if not (root / "web" / "app" / "layout.tsx").is_file():
        raise RuntimeError(f"Not a DeepTutor checkout: {root}")

    layout = root / "web" / "app" / "layout.tsx"
    replace_once(layout, 'title: "DeepTutor",', 'title: "Murikah Tutor",')
    replace_once(
        layout,
        'description: "Agent-native intelligent learning companion",',
        'description: "AI-powered personalised learning",',
    )

    # Keep murikah-logo.png packaged as a brand asset, but use a text wordmark
    # in compact navigation surfaces so "Murikah" stays crisp at small sizes.
    app_shell = root / "web" / "components" / "layout" / "AppShell.tsx"
    replace_once(
        app_shell,
        '''            <Link href="/" className="flex items-center gap-1.5">\n              <Image\n                src="/logo.png"\n                alt="DeepTutor"\n                width={20}\n                height={20}\n                className="h-5 w-5"\n              />\n              <Image\n                src="/banner.png"\n                alt="DeepTutor"\n                width={897}\n                height={236}\n                className="h-[18px] w-auto"\n              />\n            </Link>''',
        '''            <Link\n              href="/"\n              className="flex items-center gap-2.5 rounded-lg bg-[#1E2A30] px-3 py-1.5 shadow-sm"\n              aria-label="Murikah Tutor"\n            >\n              <span className="text-sm font-semibold tracking-tight text-white">Murikah</span>\n              <span aria-hidden className="h-4 w-px bg-[#A9822E]" />\n              <span className="text-sm font-semibold tracking-tight text-white">Tutor</span>\n            </Link>''',
    )

    sidebar = root / "web" / "components" / "sidebar" / "SidebarShell.tsx"
    replace_once(
        sidebar,
        '''          <Link\n            href="/"\n            aria-label="DeepTutor"\n            className="flex items-center justify-center transition-opacity duration-150 group-hover/sb:opacity-0"\n          >\n            <Image\n              src="/logo.png"\n              alt="DeepTutor"\n              width={22}\n              height={22}\n              className="h-[22px] w-[22px] rounded-md"\n            />\n          </Link>''',
        '''          <Link\n            href="/"\n            aria-label="Murikah Tutor"\n            className="flex items-center justify-center transition-opacity duration-150 group-hover/sb:opacity-0"\n          >\n            <span\n              aria-hidden\n              className="flex h-6 w-6 items-center justify-center rounded-md bg-[#1E2A30] text-[11px] font-bold text-white ring-1 ring-[#A9822E]/60"\n            >\n              M\n            </span>\n          </Link>''',
    )
    replace_once(
        sidebar,
        '''        <Link href="/" className="group flex items-center gap-1.5">\n          <Image\n            src="/logo.png"\n            alt="DeepTutor"\n            width={22}\n            height={22}\n            className="h-[22px] w-[22px] transition-transform duration-200 group-hover:scale-105"\n          />\n          <Image\n            src="/banner.png"\n            alt="DeepTutor"\n            width={897}\n            height={236}\n            priority\n            className="h-[22px] w-auto transition-transform duration-200 group-hover:scale-105"\n          />\n        </Link>''',
        '''        <Link\n          href="/"\n          className="group flex items-center gap-2.5 rounded-lg bg-[#1E2A30] px-3 py-1.5 shadow-sm transition-transform duration-200 hover:scale-[1.01]"\n          aria-label="Murikah Tutor"\n        >\n          <span className="text-sm font-semibold tracking-tight text-white">Murikah</span>\n          <span aria-hidden className="h-4 w-px bg-[#A9822E]" />\n          <span className="text-sm font-semibold tracking-tight text-white">Tutor</span>\n        </Link>''',
    )

    chat_prompt = (
        root
        / "deeptutor"
        / "agents"
        / "chat"
        / "prompts"
        / "en"
        / "agentic_chat.yaml"
    )
    replace_once(
        chat_prompt,
        '''general: |-\n  You are DeepTutor, an interactive tutor and learning companion.\n  Never describe internal stages, prompt blocks, or implementation details\n  unless the user explicitly asks about the system design.''',
        '''general: |-\n  You are Murikah Tutor, an AI-powered personalised learning companion.\n  For learning requests, default to rigorous university-level teaching unless the user asks for a different level. Build understanding in layers: begin with intuition, then formal concepts or derivations, then concrete examples or applications, and use a brief check for understanding when it adds value.\n  Adapt depth, notation, terminology, and examples to the learner's field and apparent level. Define specialised terms before relying on them; distinguish assumptions from established facts; show meaningful intermediate steps for quantitative work; and connect theory to practice where useful.\n  Answer direct questions directly. Do not force Socratic dialogue, quizzes, or long lessons when the user asks for a concise answer, and follow any explicit teaching style or level the user requests.\n  Never describe internal stages, prompt blocks, or implementation details\n  unless the user explicitly asks about the system design.''',
    )

    print("Applied Murikah Tutor product overlay.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
