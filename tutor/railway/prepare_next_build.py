#!/usr/bin/env python3
"""Prepare the pinned DeepTutor frontend for Murikah's constrained Docker build."""
from __future__ import annotations

from pathlib import Path
import sys


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(
            f"Expected one pinned DeepTutor {label}, found {count}. "
            "The pinned upstream source may have changed."
        )
    return text.replace(old, new, 1)


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: prepare_next_build.py <deeptutor-checkout>", file=sys.stderr)
        return 2

    root = Path(sys.argv[1]).resolve()
    config = root / "web" / "next.config.js"
    if not config.is_file():
        raise RuntimeError(f"Pinned DeepTutor next.config.js is missing: {config}")

    text = config.read_text(encoding="utf-8")

    text = replace_once(
        text,
        '''  typescript: {\n    tsconfigPath: process.env.DEEPTUTOR_NEXT_TSCONFIG || "tsconfig.json",\n  },''',
        '''  typescript: {\n    tsconfigPath: process.env.DEEPTUTOR_NEXT_TSCONFIG || "tsconfig.json",\n    // The pinned upstream release is already type-checked upstream. Murikah's\n    // Docker build applies a narrow, validated overlay and runs in constrained\n    // Codespaces/Railway builders where Next 16's extra TypeScript worker can\n    // be terminated after compilation. Skip only that duplicate full-project\n    // check when the production image explicitly opts in below.\n    ignoreBuildErrors: process.env.MURIKAH_SKIP_NEXT_TYPECHECK === "1",\n  },''',
        "TypeScript config block",
    )

    # The pinned app already has a custom webpack hook, which means Next does
    # not automatically enable its lower-memory webpack build worker. Recent
    # guest UI additions pushed the small Codespaces builder past its memory
    # ceiling during the webpack compilation itself (SIGTERM/143, before type
    # checking). Next 16.2.3 officially supports these experimental controls:
    # - webpackBuildWorker isolates webpack from the parent build process;
    # - webpackMemoryOptimizations lowers webpack's peak memory usage;
    # - cpus=1 bounds build-worker concurrency.
    # Apply them only to Murikah's constrained production-image build so normal
    # upstream/dev behaviour remains unchanged.
    text = replace_once(
        text,
        '''  experimental: {\n    proxyClientMaxBodySize: 210 * 1024 * 1024,\n    // Agentic reads and full-draft edits routinely exceed Next's 30-second\n    // rewrite default; the browser remains responsible for cancelling them.\n    proxyTimeout: 30 * 60 * 1000,\n  },''',
        '''  experimental: {\n    proxyClientMaxBodySize: 210 * 1024 * 1024,\n    // Agentic reads and full-draft edits routinely exceed Next's 30-second\n    // rewrite default; the browser remains responsible for cancelling them.\n    proxyTimeout: 30 * 60 * 1000,\n    ...(process.env.MURIKAH_CONSTRAINED_BUILD === "1"\n      ? {\n          webpackBuildWorker: true,\n          webpackMemoryOptimizations: true,\n          cpus: 1,\n        }\n      : {}),\n  },''',
        "experimental config block",
    )

    config.write_text(text, encoding="utf-8")
    print("Prepared pinned DeepTutor Next.js build configuration for constrained builders.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
