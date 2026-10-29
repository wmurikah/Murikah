#!/usr/bin/env python3
"""Prepare the Cloudflare Worker proxy for WebSocket pass-through.

Cloudflare Container fetch() can return a WebSocket upgrade response. Re-wrapping
that response in a new Response drops the Workers-specific WebSocket attachment
(and status 101 is not a normal body response), so upgrade requests must be
returned unchanged.

This helper is intentionally idempotent. The Worker may already contain either
the original expanded pass-through block or the newer compact equivalent; both
are valid and must not make a deployment fail.
"""
from __future__ import annotations

from pathlib import Path
import re
import sys


TARGET = Path(__file__).resolve().parent / "src" / "index.ts"


def normalized_source(text: str) -> str:
    """Ignore source formatting while preserving the proxy's semantics."""
    return re.sub(r"\s+", "", text).replace('"', "'")


def has_websocket_passthrough(text: str) -> bool:
    """Recognize the guarded proxy block regardless of Prettier's layout."""
    source = normalized_source(text)
    fetch = "constresponse=awaittutor.fetch(request);"
    headers = "constheaders=newHeaders(response.headers);"
    start = source.find(fetch)
    end = source.find(headers, start + len(fetch)) if start >= 0 else -1
    if start < 0 or end < 0:
        return False

    guard = source[start + len(fetch) : end]
    checks_upgrade = "request.headers.get('upgrade')?.toLowerCase()==='websocket'" in guard
    checks_status = "response.status===101" in guard
    returns_original = "returnresponse;" in guard
    return checks_upgrade and checks_status and returns_original

OLD = '''        const response = await tutor.fetch(request);\n        const headers = new Headers(response.headers);\n        headers.set("x-murikah-tutor-runtime", "cloudflare-container");\n        return new Response(response.body, {\n          status: response.status,\n          statusText: response.statusText,\n          headers,\n        });\n'''

NEW = '''        const response = await tutor.fetch(request);\n        // A Workers WebSocket upgrade carries a non-standard `webSocket`\n        // attachment on the original 101 response. Re-wrapping it in a new\n        // Response loses that attachment and breaks /ws after sign-in.\n        const isWebSocketUpgrade =\n          request.headers.get("upgrade")?.toLowerCase() === "websocket" ||\n          response.status === 101;\n        if (isWebSocketUpgrade) return response;\n\n        const headers = new Headers(response.headers);\n        headers.set("x-murikah-tutor-runtime", "cloudflare-container");\n        return new Response(response.body, {\n          status: response.status,\n          statusText: response.statusText,\n          headers,\n        });\n'''


def main() -> int:
    text = TARGET.read_text(encoding="utf-8")

    # Treat compact and expanded implementations as prepared. Prettier may
    # change quotes and line wrapping, neither of which changes the guard.
    if has_websocket_passthrough(text):
        print("[Murikah Tutor] Cloudflare WebSocket pass-through already prepared.")
        return 0

    count = text.count(OLD)
    if count != 1:
        print(
            "Cloudflare proxy is not in a recognized safe state: expected an "
            f"unprepared proxy block exactly once, found {count}",
            file=sys.stderr,
        )
        return 1

    TARGET.write_text(text.replace(OLD, NEW, 1), encoding="utf-8")
    print("[Murikah Tutor] Prepared Cloudflare WebSocket pass-through.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
