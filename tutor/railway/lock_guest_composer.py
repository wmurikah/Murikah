#!/usr/bin/env python3
"""Keep the Murikah guest composer visible while the transcript scrolls."""
from __future__ import annotations

from pathlib import Path
import sys


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"Expected exactly one {label}, found {count}")
    return text.replace(old, new, 1)


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: lock_guest_composer.py <deeptutor-checkout>", file=sys.stderr)
        return 2

    root = Path(sys.argv[1]).resolve()
    target = root / "web" / "components" / "chat" / "MurikahGuestChat.tsx"
    if not target.is_file():
        raise RuntimeError(f"Murikah guest component is missing: {target}")

    text = target.read_text(encoding="utf-8")

    text = replace_once(
        text,
        "  const endRef = useRef<HTMLDivElement>(null);\n",
        "  const transcriptRef = useRef<HTMLDivElement>(null);\n  const endRef = useRef<HTMLDivElement>(null);\n",
        "guest transcript ref",
    )

    text = replace_once(
        text,
        '''  useEffect(() => {\n    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });\n  }, [messages, busy, authNeeded]);''',
        '''  useEffect(() => {\n    const transcript = transcriptRef.current;\n    if (!transcript) return;\n    const frame = requestAnimationFrame(() => {\n      transcript.scrollTo({\n        top: transcript.scrollHeight,\n        behavior: messages.length > 1 ? "smooth" : "auto",\n      });\n    });\n    return () => cancelAnimationFrame(frame);\n  }, [messages, busy, authNeeded]);''',
        "guest transcript autoscroll effect",
    )

    text = replace_once(
        text,
        '''    requestAnimationFrame(() => {\n      window.scrollTo({ top: 0, behavior: "smooth" });\n    });''',
        '''    requestAnimationFrame(() => {\n      transcriptRef.current?.scrollTo({ top: 0, behavior: "auto" });\n    });''',
        "fresh guest transcript reset",
    )

    text = replace_once(
        text,
        '          <section className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-5xl flex-col px-4 py-6 sm:px-6 sm:py-8">',
        '          <section className="mx-auto flex h-[calc(100dvh-4rem)] min-h-0 max-w-5xl flex-col overflow-hidden px-4 pt-4 sm:px-6 sm:pt-6">',
        "guest viewport shell",
    )

    text = replace_once(
        text,
        '              <div className="mx-auto w-full max-w-3xl flex-1 space-y-6 pb-8">',
        '              <div ref={transcriptRef} className="mx-auto min-h-0 w-full max-w-3xl flex-1 space-y-6 overflow-y-auto overscroll-y-contain scroll-smooth pb-6 pr-1 touch-pan-y">',
        "guest transcript scroller",
    )

    text = replace_once(
        text,
        '              <form onSubmit={submit} className="mx-auto w-full max-w-3xl">',
        '              <form onSubmit={submit} className="mx-auto w-full max-w-3xl shrink-0 bg-[var(--background)] pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">',
        "persistent guest composer",
    )

    text = replace_once(
        text,
        '              <div className="mx-auto w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--card)] p-6 shadow-sm">',
        '              <div className="mx-auto w-full max-w-md shrink-0 rounded-2xl border border-[var(--border)] bg-[var(--card)] p-6 shadow-sm">',
        "guest limit card viewport fit",
    )

    target.write_text(text, encoding="utf-8")
    print("Locked the Murikah guest composer and enabled transcript autoscroll.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
