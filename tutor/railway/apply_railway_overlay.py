#!/usr/bin/env python3
"""Apply Railway-only routing additions to a pinned DeepTutor checkout."""
from __future__ import annotations

from pathlib import Path
import shutil
import sys


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(
            f"Expected exactly one Railway overlay target in {path}, found {count}. "
            "The pinned upstream source may have changed."
        )
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: apply_railway_overlay.py <deeptutor-checkout> <health-route.ts>", file=sys.stderr)
        return 2

    root = Path(sys.argv[1]).resolve()
    health_source = Path(sys.argv[2]).resolve()
    if not (root / "web" / "lib" / "proxy-policy.ts").is_file():
        raise RuntimeError(f"Not a DeepTutor checkout: {root}")
    if not health_source.is_file():
        raise RuntimeError(f"Missing health route source: {health_source}")

    proxy_policy = root / "web" / "lib" / "proxy-policy.ts"
    replace_once(
        proxy_policy,
        '''    pathname.startsWith(LOGIN_PATH) ||\n    pathname.startsWith("/register") ||''',
        '''    pathname.startsWith(LOGIN_PATH) ||\n    pathname.startsWith("/register") ||\n    pathname === "/health" ||''',
    )

    health_dir = root / "web" / "app" / "health"
    health_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(health_source, health_dir / "route.ts")

    print("Applied Murikah Tutor Railway routing overlay.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
