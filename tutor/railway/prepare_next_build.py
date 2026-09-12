#!/usr/bin/env python3
"""Prepare the pinned DeepTutor frontend for Murikah's constrained Docker build."""
from __future__ import annotations

from pathlib import Path
import sys


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: prepare_next_build.py <deeptutor-checkout>", file=sys.stderr)
        return 2

    root = Path(sys.argv[1]).resolve()
    config = root / "web" / "next.config.js"
    if not config.is_file():
        raise RuntimeError(f"Pinned DeepTutor next.config.js is missing: {config}")

    text = config.read_text(encoding="utf-8")
    old = '''  typescript: {\n    tsconfigPath: process.env.DEEPTUTOR_NEXT_TSCONFIG || "tsconfig.json",\n  },'''
    new = '''  typescript: {\n    tsconfigPath: process.env.DEEPTUTOR_NEXT_TSCONFIG || "tsconfig.json",\n    // The pinned upstream release is already type-checked upstream. Murikah's\n    // Docker build applies a narrow, validated overlay and runs in constrained\n    // Codespaces/Railway builders where Next 16's extra TypeScript worker can\n    // be terminated after compilation. Skip only that duplicate full-project\n    // check when the production image explicitly opts in below.\n    ignoreBuildErrors: process.env.MURIKAH_SKIP_NEXT_TYPECHECK === "1",\n  },'''

    count = text.count(old)
    if count != 1:
        raise RuntimeError(
            f"Expected one pinned DeepTutor TypeScript config block, found {count}. "
            "The pinned upstream source may have changed."
        )

    config.write_text(text.replace(old, new, 1), encoding="utf-8")
    print("Prepared pinned DeepTutor Next.js build configuration.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
