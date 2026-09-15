#!/usr/bin/env python3
"""Prepare the Cloudflare Worker proxy for WebSocket pass-through.

Cloudflare Container fetch() can return a WebSocket upgrade response. Re-wrapping
that response in a new Response drops the Workers-specific WebSocket attachment
(and status 101 is not a normal body response), so upgrade requests must be
returned unchanged.
"""
from __future__ import annotations

from pathlib import Path
import sys


TARGET = Path(__file__).resolve().parent / "src" / "index.ts"
MARKER = "const isWebSocketUpgrade ="

OLD = '''        const response = await tutor.fetch(request);\n        const headers = new Headers(response.headers);\n        headers.set("x-murikah-tutor-runtime", "cloudflare-container");\n        return new Response(response.body, {\n          status: response.status,\n          statusText: response.statusText,\n          headers,\n        });\n'''

NEW = '''        const response = await tutor.fetch(request);\n        // A Workers WebSocket upgrade carries a non-standard `webSocket`\n        // attachment on the original 101 response. Re-wrapping it in a new\n        // Response loses that attachment and breaks /ws after sign-in.\n        const isWebSocketUpgrade =\n          request.headers.get("upgrade")?.toLowerCase() === "websocket" ||\n          response.status === 101;\n        if (isWebSocketUpgrade) return response;\n\n        const headers = new Headers(response.headers);\n        headers.set("x-murikah-tutor-runtime", "cloudflare-container");\n        return new Response(response.body, {\n          status: response.status,\n          statusText: response.statusText,\n          headers,\n        });\n'''


def main() -> int:
    text = TARGET.read_text(encoding="utf-8")
    if MARKER in text:
        print("[Murikah Tutor] Cloudflare WebSocket pass-through already prepared.")
        return 0
    count = text.count(OLD)
    if count != 1:
        print(
            f"Expected exactly one Cloudflare proxy response block, found {count}",
            file=sys.stderr,
        )
        return 1
    TARGET.write_text(text.replace(OLD, NEW, 1), encoding="utf-8")
    print("[Murikah Tutor] Prepared Cloudflare WebSocket pass-through.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
