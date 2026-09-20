#!/usr/bin/env python3
"""Prepare the pinned DeepTutor frontend and Murikah runtime overlay."""
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


def harden_fast_lane(root: Path) -> None:
    fast = root / "deeptutor" / "murikah_fast_lane.py"
    text = fast.read_text(encoding="utf-8")
    if "MURIKAH_FAST_LANE_FAILOVER_V4" not in text:
        text = replace_once(
            text,
            'logger = logging.getLogger(__name__)\n',
            'logger = logging.getLogger(__name__)\n\n# MURIKAH_FAST_LANE_FAILOVER_V4\n',
            "fast-lane marker",
        )
        client_anchor = '    async with httpx.AsyncClient(timeout=timeout) as client:\n'
        client_count = text.count(client_anchor)
        if client_count not in {1, 2}:
            raise RuntimeError(
                f"Expected one or two pinned DeepTutor fast-provider HTTP clients, found {client_count}. "
                "The pinned upstream source may have changed."
            )
        text = text.replace(
            client_anchor,
            '    # Cloudflare provides direct container egress. Ignore inherited proxy\n'
            '    # variables so a stale proxy cannot turn provider calls into generic\n'
            '    # connection failures.\n'
            '    async with httpx.AsyncClient(\n'
            '        timeout=timeout, follow_redirects=True, trust_env=False\n'
            '    ) as client:\n',
        )
        text = replace_once(
            text,
            '            response.raise_for_status()\n'
            '            logger.info(\n'
            '                "MURIKAH_LATENCY route=fast provider=gemini event=headers model=%s elapsed_ms=%s",\n'
            '                model,\n'
            '                latency_ms(request_started),\n'
            '            )\n',
            '            if response.status_code >= 400:\n'
            '                logger.warning(\n'
            '                    "MURIKAH_LATENCY route=fast provider=gemini event=http_error "\n'
            '                    "model=%s status=%s elapsed_ms=%s",\n'
            '                    model,\n'
            '                    response.status_code,\n'
            '                    latency_ms(request_started),\n'
            '                )\n'
            '            response.raise_for_status()\n'
            '            logger.info(\n'
            '                "MURIKAH_LATENCY route=fast provider=gemini event=headers model=%s elapsed_ms=%s",\n'
            '                model,\n'
            '                latency_ms(request_started),\n'
            '            )\n',
            "Gemini status diagnostics",
        )
        text = replace_once(
            text,
            '        if in_think or not text:\n'
            '            continue\n'
            '        return text\n'
            '    raise StopAsyncIteration\n',
            '        if in_think or not text:\n'
            '            continue\n'
            '        normalized = text.strip().lower()\n'
            '        overloaded_payload = (\n'
            '            "service temporarily overloaded" in normalized\n'
            '            or "overloaded_error" in normalized\n'
            '            or "\'type\': \'overloaded\'" in normalized\n'
            '            or "\\\"type\\\": \\"overloaded\\\"" in normalized\n'
            '            or "\'code\': 529" in normalized\n'
            '            or "\\\"code\\\": 529" in normalized\n'
            '            or "\\\"code\\\":529" in normalized\n'
            '        )\n'
            '        if (\n'
            '            normalized.startswith("error calling llm:")\n'
            '            or normalized.startswith("llm call failed:")\n'
            '            or (normalized.startswith("error:") and overloaded_payload)\n'
            '            or overloaded_payload\n'
            '        ):\n'
            '            raise RuntimeError("Provider returned a retryable error payload instead of model output")\n'
            '        return text\n'
            '    raise StopAsyncIteration\n',
            "provider error-token guard",
        )
        fast.write_text(text, encoding="utf-8")

    chat = root / "deeptutor" / "agents" / "chat" / "capability.py"
    chat_text = chat.read_text(encoding="utf-8")
    if "MURIKAH_DUAL_LANE_CHAT_V4" not in chat_text:
        raise RuntimeError(
            "Murikah dual-provider Chat overlay is missing before final build hardening."
        )

    guest = root / "deeptutor" / "api" / "routers" / "murikah_guest.py"
    text = guest.read_text(encoding="utf-8")
    marker = "Provider returned a retryable error payload instead of guest output"
    if marker not in text:
        text = replace_once(
            text,
            '''            if in_think or not text:\n                continue\n            return text\n        raise RuntimeError("Provider stream ended before producing visible text")\n''',
            '''            if in_think or not text:\n                continue\n            normalized = text.strip().lower()\n            overloaded_payload = (\n                "service temporarily overloaded" in normalized\n                or "overloaded_error" in normalized\n                or "'type': 'overloaded'" in normalized\n                or '"type": "overloaded"' in normalized\n                or "'code': 529" in normalized\n                or '"code": 529' in normalized\n                or '"code":529' in normalized\n            )\n            if (\n                normalized.startswith("error calling llm:")\n                or normalized.startswith("llm call failed:")\n                or (normalized.startswith("error:") and overloaded_payload)\n                or overloaded_payload\n            ):\n                raise RuntimeError("Provider returned a retryable error payload instead of guest output")\n            return text\n        raise RuntimeError("Provider stream ended before producing visible text")\n''',
            "guest error-token guard",
        )
        guest.write_text(text, encoding="utf-8")


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

    text = replace_once(
        text,
        '''  webpack: (config) => {\n    const path = require("path");\n    config.resolve.alias = {\n      ...config.resolve.alias,\n      cytoscape: path.resolve(\n        __dirname,\n        "node_modules/cytoscape/dist/cytoscape.cjs.js",\n      ),\n    };\n    return config;\n  },''',
        '''  webpack: (config) => {\n    const path = require("path");\n    config.resolve.alias = {\n      ...config.resolve.alias,\n      cytoscape: path.resolve(\n        __dirname,\n        "node_modules/cytoscape/dist/cytoscape.cjs.js",\n      ),\n    };\n    if (process.env.MURIKAH_CONSTRAINED_BUILD === "1") {\n      config.parallelism = 1;\n      config.cache = false;\n    }\n    return config;\n  },''',
        "webpack config block",
    )

    config.write_text(text, encoding="utf-8")
    harden_fast_lane(root)
    print("Prepared pinned DeepTutor build configuration and dual-provider fast-lane failover.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
