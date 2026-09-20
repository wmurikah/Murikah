#!/usr/bin/env python3
"""Keep generated Tutor media inside the chat viewport and preserve scrolling."""
from __future__ import annotations

from pathlib import Path
import sys


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"Expected one {label} in {path}, found {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def replace_count(path: Path, old: str, new: str, expected: int, label: str) -> None:
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != expected:
        raise RuntimeError(f"Expected {expected} {label} markers in {path}, found {count}")
    path.write_text(text.replace(old, new), encoding="utf-8")


def patch_mermaid(root: Path) -> None:
    path = root / "web/components/Mermaid.tsx"
    replace_once(
        path,
        'className={`my-6 flex justify-center overflow-x-auto ${className}`}',
        'className={`my-6 flex w-full min-w-0 max-w-full justify-center overflow-auto overscroll-contain rounded-xl touch-auto ${className} [&>svg]:h-auto [&>svg]:max-h-[70dvh] [&>svg]:max-w-full`}',
        "responsive Mermaid container",
    )


def patch_visualization(root: Path) -> None:
    path = root / "web/components/visualize/VisualizationViewer.tsx"
    replace_once(
        path,
        '<div className="dt-chart-wrap relative w-full">\n      <canvas ref={canvasRef} />\n    </div>',
        '<div className="dt-chart-wrap relative h-[clamp(280px,55dvh,640px)] w-full min-w-0 max-w-full overflow-hidden">\n      <canvas ref={canvasRef} className="!h-full !max-h-full !w-full !max-w-full" />\n    </div>',
        "responsive Chart.js container",
    )
    replace_once(
        path,
        'className="w-full rounded-lg border border-[var(--border)] bg-[var(--card)]"\n        style={{ minHeight: 320, height }}',
        'className="block w-full max-w-full rounded-lg border border-[var(--border)] bg-[var(--card)]"\n        style={{ minHeight: 280, height: `min(${height}px, 70dvh)`, maxHeight: "70dvh" }}',
        "responsive HTML visualization iframe",
    )
    replace_once(
        path,
        'className="w-full rounded-lg border-0 bg-[var(--card)]"\n      style={{ minHeight: 320, height }}',
        'className="block w-full max-w-full rounded-lg border-0 bg-[var(--card)]"\n      style={{ minHeight: 280, height: `min(${height}px, 70dvh)`, maxHeight: "70dvh" }}',
        "responsive plugin visualization iframe",
    )
    replace_once(
        path,
        'className="dt-svg-root flex justify-center overflow-x-auto"',
        'className="dt-svg-root flex w-full min-w-0 max-w-full justify-center overflow-auto overscroll-contain touch-auto [&>svg]:h-auto [&>svg]:max-h-[70dvh] [&>svg]:max-w-full"',
        "responsive SVG visualization",
    )
    replace_once(
        path,
        '<div className="space-y-3">',
        '<div className="min-w-0 max-w-full space-y-3 overflow-hidden">',
        "visualization viewer root",
    )
    replace_once(
        path,
        '? "overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--background)]"\n            : "overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--background)] p-4"',
        '? "min-w-0 max-w-full overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--background)]"\n            : "min-w-0 max-w-full overflow-auto overscroll-contain rounded-xl border border-[var(--border)] bg-[var(--background)] p-4"',
        "visualization viewport",
    )
    replace_once(
        path,
        'className="flex flex-1 overflow-auto rounded-xl bg-[var(--card)] p-6 shadow-2xl"',
        'className="flex min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain touch-auto rounded-xl bg-[var(--card)] p-4 sm:p-6 shadow-2xl"',
        "fullscreen visualization scroller",
    )
    replace_once(
        path,
        'className="dt-viz-fullscreen m-auto w-full max-w-[1600px]"',
        'className="dt-viz-fullscreen m-auto min-w-0 w-full max-w-[1600px]"',
        "fullscreen visualization width",
    )


def patch_chat_media(root: Path) -> None:
    path = root / "web/features/chat/messages/ChatMessageList.tsx"
    replace_count(
        path,
        'w-full max-w-[min(520px,90%)]',
        'w-full max-w-full sm:max-w-[min(520px,90%)]',
        4,
        "generated media width",
    )
    replace_count(
        path,
        'max-h-[360px] w-full',
        'max-h-[70dvh] w-full max-w-full',
        2,
        "generated media height",
    )
    replace_once(
        path,
        '      ) : visualizeResult ? (\n        <VisualizationViewer result={visualizeResult} />\n      ) : quizQuestions && quizQuestions.length > 0 ? (',
        '      ) : visualizeResult ? (\n        <div className="min-w-0 max-w-full overflow-hidden">\n          <VisualizationViewer result={visualizeResult} />\n        </div>\n      ) : quizQuestions && quizQuestions.length > 0 ? (',
        "visualization message width guard",
    )


def patch_markdown_images(root: Path) -> None:
    for relative in (
        "web/components/common/SimpleMarkdownRenderer.tsx",
        "web/components/common/RichMarkdownRenderer.tsx",
    ):
        path = root / relative
        replace_once(
            path,
            'const className = `${gap} inline-block max-w-full rounded-lg border border-[var(--border)]`;',
            'const className = `${gap} inline-block h-auto max-h-[70dvh] max-w-full object-contain rounded-lg border border-[var(--border)]`;',
            "responsive markdown image",
        )


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: fluid_visual_outputs.py <deeptutor-root>")
    root = Path(sys.argv[1]).resolve()
    patch_mermaid(root)
    patch_visualization(root)
    patch_chat_media(root)
    patch_markdown_images(root)
    print("[Murikah Tutor] Generated media is viewport-bounded and independently scrollable.")


if __name__ == "__main__":
    main()
