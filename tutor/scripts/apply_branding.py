#!/usr/bin/env python3
"""Apply the Murikah Tutor presentation overlay to a pinned DeepTutor checkout.

This intentionally changes only user-facing web branding. Internal package names,
API routes, environment variables, persistence paths and DeepTutor runtime names
remain untouched so upstream compatibility is preserved.
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

    app_shell = root / "web" / "components" / "layout" / "AppShell.tsx"
    replace_once(
        app_shell,
        '''            <Link href="/" className="flex items-center gap-1.5">\n              <Image\n                src="/logo.png"\n                alt="DeepTutor"\n                width={20}\n                height={20}\n                className="h-5 w-5"\n              />\n              <Image\n                src="/banner.png"\n                alt="DeepTutor"\n                width={897}\n                height={236}\n                className="h-[18px] w-auto"\n              />\n            </Link>''',
        '''            <Link href="/" className="flex items-center gap-2" aria-label="Murikah Tutor">\n              <Image\n                src="/murikah-logo.png"\n                alt="Murikah"\n                width={2172}\n                height={693}\n                className="h-[18px] w-auto"\n                priority\n              />\n              <span className="text-sm font-semibold tracking-tight text-[var(--foreground)]">Tutor</span>\n            </Link>''',
    )

    sidebar = root / "web" / "components" / "sidebar" / "SidebarShell.tsx"
    replace_once(
        sidebar,
        '''          <Link\n            href="/"\n            aria-label="DeepTutor"\n            className="flex items-center justify-center transition-opacity duration-150 group-hover/sb:opacity-0"\n          >\n            <Image\n              src="/logo.png"\n              alt="DeepTutor"\n              width={22}\n              height={22}\n              className="h-[22px] w-[22px] rounded-md"\n            />\n          </Link>''',
        '''          <Link\n            href="/"\n            aria-label="Murikah Tutor"\n            className="flex items-center justify-center transition-opacity duration-150 group-hover/sb:opacity-0"\n          >\n            <span\n              aria-hidden\n              className="flex h-[22px] w-[22px] items-center justify-center rounded-md bg-[var(--foreground)] text-[11px] font-bold text-[var(--background)]"\n            >\n              M\n            </span>\n          </Link>''',
    )
    replace_once(
        sidebar,
        '''        <Link href="/" className="group flex items-center gap-1.5">\n          <Image\n            src="/logo.png"\n            alt="DeepTutor"\n            width={22}\n            height={22}\n            className="h-[22px] w-[22px] transition-transform duration-200 group-hover:scale-105"\n          />\n          <Image\n            src="/banner.png"\n            alt="DeepTutor"\n            width={897}\n            height={236}\n            priority\n            className="h-[22px] w-auto transition-transform duration-200 group-hover:scale-105"\n          />\n        </Link>''',
        '''        <Link href="/" className="group flex items-center gap-2" aria-label="Murikah Tutor">\n          <Image\n            src="/murikah-logo.png"\n            alt="Murikah"\n            width={2172}\n            height={693}\n            priority\n            className="h-[20px] w-auto transition-transform duration-200 group-hover:scale-105"\n          />\n          <span className="text-sm font-semibold tracking-tight text-[var(--foreground)]">Tutor</span>\n        </Link>''',
    )

    print("Applied Murikah Tutor web branding overlay.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
