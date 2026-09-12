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
        '''  typescript: {\n    tsconfigPath: process.env.DEEPTUTOR_NEXT_TSCONFIG || "tsconfig.json",\n    // The pinned upstream release is already type-checked upstream. Murikah's\n    // Docker build applies a narrow, validated overlay and runs in constrained\n    // builders where Next 16's extra TypeScript worker can be terminated after\n    // compilation. Skip only that duplicate full-project check when the\n    // production image explicitly opts in below.\n    ignoreBuildErrors: process.env.MURIKAH_SKIP_NEXT_TYPECHECK === "1",\n  },''',
        "TypeScript config block",
    )

    text = replace_once(
        text,
        '''  experimental: {\n    proxyClientMaxBodySize: 210 * 1024 * 1024,\n    // Agentic reads and full-draft edits routinely exceed Next's 30-second\n    // rewrite default; the browser remains responsible for cancelling them.\n    proxyTimeout: 30 * 60 * 1000,\n  },''',
        '''  experimental: {\n    proxyClientMaxBodySize: 210 * 1024 * 1024,\n    // Agentic reads and full-draft edits routinely exceed Next's 30-second\n    // rewrite default; the browser remains responsible for cancelling them.\n    proxyTimeout: 30 * 60 * 1000,\n    ...(process.env.MURIKAH_CONSTRAINED_BUILD === "1"\n      ? {\n          webpackBuildWorker: true,\n          webpackMemoryOptimizations: true,\n          cpus: 1,\n        }\n      : {}),\n  },''',
        "experimental config block",
    )

    # DeepTutor already needs a custom webpack hook for Cytoscape. In a small
    # builder, webpack's normal high parallelism and persistent build cache can
    # create a larger peak than the JavaScript heap cap itself. Limit module
    # work to one task and disable webpack's build cache only for the
    # reproducible production image. A clean Docker build gets little value
    # from an in-process cache anyway.
    text = replace_once(
        text,
        '''  webpack: (config) => {\n    const path = require("path");\n    config.resolve.alias = {\n      ...config.resolve.alias,\n      cytoscape: path.resolve(\n        __dirname,\n        "node_modules/cytoscape/dist/cytoscape.cjs.js",\n      ),\n    };\n    return config;\n  },''',
        '''  webpack: (config) => {\n    const path = require("path");\n    config.resolve.alias = {\n      ...config.resolve.alias,\n      cytoscape: path.resolve(\n        __dirname,\n        "node_modules/cytoscape/dist/cytoscape.cjs.js",\n      ),\n    };\n    if (process.env.MURIKAH_CONSTRAINED_BUILD === "1") {\n      config.parallelism = 1;\n      config.cache = false;\n    }\n    return config;\n  },''',
        "webpack config block",
    )

    config.write_text(text, encoding="utf-8")
    print("Prepared pinned DeepTutor Next.js build configuration for constrained builders.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
