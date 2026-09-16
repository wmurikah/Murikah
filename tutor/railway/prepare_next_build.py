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
    if "MURIKAH_FAST_LANE_FAILOVER_V3" not in text:
        text = replace_once(
            text,
            'logger = logging.getLogger(__name__)\n',
            'logger = logging.getLogger(__name__)\n\n# MURIKAH_FAST_LANE_FAILOVER_V3\n',
            "fast-lane marker",
        )
        text = replace_once(
            text,
            '    async with httpx.AsyncClient(timeout=timeout) as client:\n',
            '    # Cloudflare provides direct container egress. Ignore inherited proxy\n'
            '    # variables so a stale proxy cannot turn provider calls into generic\n'
            '    # connection failures.\n'
            '    async with httpx.AsyncClient(\n'
            '        timeout=timeout, follow_redirects=True, trust_env=False\n'
            '    ) as client:\n',
            "Gemini HTTP client",
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
            '        if normalized.startswith("error calling llm:") or normalized.startswith("llm call failed:"):\n'
            '            raise RuntimeError("Provider returned an error payload instead of model output")\n'
            '        return text\n'
            '    raise StopAsyncIteration\n',
            "provider error-token guard",
        )
        fast.write_text(text, encoding="utf-8")

    chat = root / "deeptutor" / "agents" / "chat" / "capability.py"
    text = chat.read_text(encoding="utf-8")
    if "gemini_compat =" not in text:
        old = '''        non_gemini = [config for config in resolved if str(config.model) != gemini_model]\n        if resolved and not selected_is_gemini:\n            hedges.append(deep_candidate(resolved[0], 0.0))\n            if gemini_on:\n                hedges.append(\n                    HedgeCandidate(\n                        name=f"gemini:{gemini_model}",\n                        delay_seconds=2.5,\n                        factory=lambda: gemini_stream(\n                            messages,\n                            max_tokens=min(2400, prompt_pipeline.respond_max_tokens),\n                        ),\n                    )\n                )\n            remainder = [config for config in non_gemini if config is not resolved[0]]\n            for index, config in enumerate(remainder[:2]):\n                hedges.append(deep_candidate(config, 4.5 + (index * 2.0)))\n        else:\n            if gemini_on:\n                hedges.append(\n                    HedgeCandidate(\n                        name=f"gemini:{gemini_model}",\n                        delay_seconds=0.0,\n                        factory=lambda: gemini_stream(\n                            messages,\n                            max_tokens=min(2400, prompt_pipeline.respond_max_tokens),\n                        ),\n                    )\n                )\n            for index, config in enumerate(non_gemini[:3]):\n                delay = 2.5 + (index * 2.0) if gemini_on else index * 2.5\n                hedges.append(deep_candidate(config, delay))\n'''
        new = '''        gemini_compat = [config for config in resolved if str(config.model) == gemini_model]\n        non_gemini = [config for config in resolved if str(config.model) != gemini_model]\n        if resolved and not selected_is_gemini:\n            hedges.append(deep_candidate(resolved[0], 0.0))\n            if gemini_on:\n                hedges.append(\n                    HedgeCandidate(\n                        name=f"gemini-native:{gemini_model}",\n                        delay_seconds=2.5,\n                        factory=lambda: gemini_stream(\n                            messages,\n                            max_tokens=min(2400, prompt_pipeline.respond_max_tokens),\n                        ),\n                    )\n                )\n            if gemini_compat:\n                hedges.append(deep_candidate(gemini_compat[0], 3.5))\n            remainder = [config for config in non_gemini if config is not resolved[0]]\n            for index, config in enumerate(remainder[:2]):\n                hedges.append(deep_candidate(config, 4.5 + (index * 2.0)))\n        else:\n            if gemini_on:\n                hedges.append(\n                    HedgeCandidate(\n                        name=f"gemini-native:{gemini_model}",\n                        delay_seconds=0.0,\n                        factory=lambda: gemini_stream(\n                            messages,\n                            max_tokens=min(2400, prompt_pipeline.respond_max_tokens),\n                        ),\n                    )\n                )\n            # The pinned release already supports Google's OpenAI-compatible\n            # endpoint. Start it one second later as an independent Gemini path\n            # before falling back to NVIDIA. The first real model token wins.\n            if gemini_compat:\n                hedges.append(deep_candidate(gemini_compat[0], 1.0))\n            for index, config in enumerate(non_gemini[:3]):\n                delay = 2.5 + (index * 2.0) if gemini_on else index * 2.5\n                hedges.append(deep_candidate(config, delay))\n'''
        text = replace_once(text, old, new, "authenticated hedge block")
        chat.write_text(text, encoding="utf-8")

    guest = root / "deeptutor" / "api" / "routers" / "murikah_guest.py"
    text = guest.read_text(encoding="utf-8")
    marker = "Provider returned an error payload instead of guest output"
    if marker not in text:
        text = replace_once(
            text,
            '''            if in_think or not text:\n                continue\n            return text\n        raise RuntimeError("Provider stream ended before producing visible text")\n''',
            '''            if in_think or not text:\n                continue\n            normalized = text.strip().lower()\n            if normalized.startswith("error calling llm:") or normalized.startswith("llm call failed:"):\n                raise RuntimeError("Provider returned an error payload instead of guest output")\n            return text\n        raise RuntimeError("Provider stream ended before producing visible text")\n''',
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
    print("Prepared pinned DeepTutor build configuration and fast-lane failover.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
