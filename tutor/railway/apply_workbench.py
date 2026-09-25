#!/usr/bin/env python3
"""Install Murikah Workbench and wire source-backed Tutor outputs into it."""
from __future__ import annotations

from pathlib import Path
import shutil
import sys


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"Expected one {label} in {path}, found {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def copy_required(source: Path, destination: Path) -> None:
    if not source.is_file():
        raise RuntimeError(f"Missing Workbench overlay source: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)


def install_sources(root: Path, overlay: Path) -> None:
    for source_name, relative in (
        ("murikah-workbench.ts", "web/lib/murikah-workbench.ts"),
        ("MurikahWorkbenchHost.tsx", "web/components/workbench/MurikahWorkbenchHost.tsx"),
        ("MurikahWorkbenchPanel.tsx", "web/components/workbench/MurikahWorkbenchPanel.tsx"),
        ("MurikahCopyableTable.tsx", "web/components/workbench/MurikahCopyableTable.tsx"),
    ):
        copy_required(overlay / source_name, root / relative)


def patch_app_shell(root: Path) -> None:
    path = root / "web/components/layout/AppShell.tsx"
    replace_once(
        path,
        'import { useDevice } from "@/hooks/useDevice";\n',
        'import { useDevice } from "@/hooks/useDevice";\nimport MurikahWorkbenchHost from "@/components/workbench/MurikahWorkbenchHost";\n',
        "Workbench AppShell import",
    )
    replace_once(
        path,
        '''        </main>
      </div>
    </SidebarDrawerContext.Provider>''',
        '''        </main>
        <MurikahWorkbenchHost />
      </div>
    </SidebarDrawerContext.Provider>''',
        "Workbench AppShell host",
    )


def patch_markdown_tables(root: Path) -> None:
    simple = root / "web/components/common/SimpleMarkdownRenderer.tsx"
    rich = root / "web/components/common/RichMarkdownRenderer.tsx"
    for path in (simple, rich):
        replace_once(
            path,
            'import type { MarkdownRendererProps } from "./markdown-renderer-types";\n',
            'import type { MarkdownRendererProps } from "./markdown-renderer-types";\nimport MurikahCopyableTable from "@/components/workbench/MurikahCopyableTable";\n',
            "copyable table import",
        )

    simple_trace = '''    table: ({ node, children, ...props }: any) =>
      hasRenderableChildren(children) ? (
        <div className="my-1 overflow-x-auto rounded border border-[var(--border)]/50">
          <table className="min-w-full text-[inherit]" {...props}>
            {children}
          </table>
        </div>
      ) : null,'''.replace("border-[var(--border)]/50", "border-[var(--border)]/50")
    simple_trace_actual = '''    table: ({ node, children, ...props }: any) =>
      hasRenderableChildren(children) ? (
        <div className="my-1 overflow-x-auto rounded border border-[var(--border)]/50">
          <table className="min-w-full text-[inherit]" {...props}>
            {children}
          </table>
        </div>
      ) : null,'''
    simple_trace_new = '''    table: ({ node, children, ...props }: any) =>
      hasRenderableChildren(children) ? (
        <MurikahCopyableTable className="my-1 overflow-x-auto rounded border border-[var(--border)]/50">
          <table className="min-w-full text-[inherit]" {...props}>
            {children}
          </table>
        </MurikahCopyableTable>
      ) : null,'''
    replace_once(simple, simple_trace_actual, simple_trace_new, "Simple trace table")

    simple_normal = '''    table: ({ node, children, ...props }: any) =>
      hasRenderableChildren(children) ? (
        <div
          className={`overflow-x-auto rounded-lg border border-[var(--border)] shadow-sm ${gap}`}
        >
          <table
            className="min-w-full divide-y divide-[var(--border)] text-sm"
            {...props}
          >
            {children}
          </table>
        </div>
      ) : null,'''
    simple_normal_new = '''    table: ({ node, children, ...props }: any) =>
      hasRenderableChildren(children) ? (
        <MurikahCopyableTable
          className={`overflow-x-auto rounded-lg border border-[var(--border)] shadow-sm ${gap}`}
        >
          <table
            className="min-w-full divide-y divide-[var(--border)] text-sm"
            {...props}
          >
            {children}
          </table>
        </MurikahCopyableTable>
      ) : null,'''
    replace_once(simple, simple_normal, simple_normal_new, "Simple normal table")

    rich_trace = simple_trace_actual
    rich_trace_new = simple_trace_new
    replace_once(rich, rich_trace, rich_trace_new, "Rich trace table")

    rich_normal = '''    table: ({ node, children, ...props }: any) =>
      hasRenderableChildren(children) ? (
        <div
          className={`overflow-x-auto rounded-lg border border-[var(--border)] shadow-sm ${gap}`}
          {...lineAttr(node)}
        >
          <table
            className="min-w-full divide-y divide-[var(--border)] text-sm"
            {...props}
          >
            {children}
          </table>
        </div>
      ) : null,'''
    rich_normal_new = '''    table: ({ node, children, ...props }: any) =>
      hasRenderableChildren(children) ? (
        <MurikahCopyableTable
          className={`overflow-x-auto rounded-lg border border-[var(--border)] shadow-sm ${gap}`}
          {...lineAttr(node)}
        >
          <table
            className="min-w-full divide-y divide-[var(--border)] text-sm"
            {...props}
          >
            {children}
          </table>
        </MurikahCopyableTable>
      ) : null,'''
    replace_once(rich, rich_normal, rich_normal_new, "Rich normal table")


def patch_mermaid(root: Path) -> None:
    path = root / "web/components/Mermaid.tsx"
    replace_once(
        path,
        'import { subscribeToThemeChanges } from "@/lib/theme";\n',
        'import { subscribeToThemeChanges } from "@/lib/theme";\nimport { Pencil } from "lucide-react";\nimport { openMurikahWorkbench } from "@/lib/murikah-workbench";\n',
        "Mermaid Workbench imports",
    )
    old = '''  return (
    <div
      ref={containerRef}
      className={`my-6 flex w-full min-w-0 max-w-full justify-center overflow-auto overscroll-contain rounded-xl touch-auto ${className} [&>svg]:h-auto [&>svg]:max-h-[70dvh] [&>svg]:max-w-full`}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );'''
    new = '''  return (
    <div className={`group/mermaid relative my-6 min-w-0 max-w-full ${className}`}>
      <button
        type="button"
        onClick={() =>
          openMurikahWorkbench({
            kind: "diagram",
            renderer: "mermaid",
            title: "Mermaid diagram",
            content: chart,
          })
        }
        className="absolute right-2 top-2 z-10 inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--background)]/95 px-2 py-1 text-[10.5px] font-medium text-[var(--muted-foreground)] opacity-100 shadow-sm backdrop-blur hover:text-[var(--foreground)] sm:opacity-0 sm:group-hover/mermaid:opacity-100 sm:group-focus-within/mermaid:opacity-100"
        aria-label={t("Edit diagram in Workbench")}
        title={t("Edit diagram in Workbench")}
      >
        <Pencil size={11} strokeWidth={1.7} />
        {t("Edit")}
      </button>
      <div
        ref={containerRef}
        className="flex w-full min-w-0 max-w-full justify-center overflow-auto overscroll-contain rounded-xl touch-auto [&>svg]:h-auto [&>svg]:max-h-[70dvh] [&>svg]:max-w-full"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  );'''
    replace_once(path, old, new, "Mermaid editable renderer")


def patch_code_blocks(root: Path) -> None:
    path = root / "web/components/common/RichCodeBlock.tsx"
    replace_once(
        path,
        'import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";\n',
        'import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";\nimport { Pencil } from "lucide-react";\nimport { openMurikahWorkbench } from "@/lib/murikah-workbench";\n',
        "code Workbench imports",
    )
    replace_once(
        path,
        '''    <div
      className={`md-code-block overflow-hidden rounded-xl border border-[var(--border)] ${''',
        '''    <div
      className={`group/murikah-code relative md-code-block overflow-hidden rounded-xl border border-[var(--border)] ${''',
        "code Workbench wrapper",
    )
    marker = '''      {!isPlain ? (
        <div'''
    insertion = '''      <button
        type="button"
        onClick={() =>
          openMurikahWorkbench({
            kind: "code",
            renderer: "code",
            title: normalizedLang ? `${normalizedLang} code` : "Code",
            content: raw,
            language: normalizedLang || "text",
          })
        }
        className="absolute right-2 top-1.5 z-10 inline-flex items-center gap-1 rounded-md border border-white/15 bg-black/35 px-2 py-1 text-[10.5px] font-medium text-white/80 opacity-100 backdrop-blur hover:text-white sm:opacity-0 sm:group-hover/murikah-code:opacity-100 sm:group-focus-within/murikah-code:opacity-100"
        aria-label="Edit code in Workbench"
        title="Edit code in Workbench"
      >
        <Pencil size={11} strokeWidth={1.7} />
        Edit
      </button>
      {!isPlain ? (
        <div'''
    replace_once(path, marker, insertion, "code Workbench action")


def patch_chat_actions(root: Path) -> None:
    path = root / "web/features/chat/messages/ChatMessageList.tsx"
    replace_once(
        path,
        '''  Pencil,
  RefreshCcw,''',
        '''  Pencil,
  PanelRightOpen,
  RefreshCcw,''',
        "Workbench chat action icon",
    )
    replace_once(
        path,
        'import { hasVisibleMarkdownContent } from "@/lib/markdown-display";\n',
        'import { hasVisibleMarkdownContent } from "@/lib/markdown-display";\nimport { openMurikahWorkbench } from "@/lib/murikah-workbench";\n',
        "Workbench chat action import",
    )
    old = '''                    {showActions && (
                      <PlayAudioButton
                        content={msg.content}
                        conversationKey={sessionId ?? undefined}
                        autoPlayFresh={
                          isLastAssistant && freshlyCompletedIndex === i
                        }
                      />
                    )}'''
    new = '''                    {showActions && (
                      <RoughActionButton
                        icon={PanelRightOpen}
                        label={t("Open in Workbench")}
                        onClick={() =>
                          openMurikahWorkbench({
                            id: msg.id != null ? `message:${msg.id}` : undefined,
                            sourceId: msg.id != null ? `message:${msg.id}` : undefined,
                            kind: "document",
                            renderer: "markdown",
                            title: "Tutor response",
                            content: msg.content,
                          })
                        }
                      />
                    )}
                    {showActions && (
                      <PlayAudioButton
                        content={msg.content}
                        conversationKey={sessionId ?? undefined}
                        autoPlayFresh={
                          isLastAssistant && freshlyCompletedIndex === i
                        }
                      />
                    )}'''
    replace_once(path, old, new, "assistant Workbench action")


def patch_chat_workspace(root: Path) -> None:
    path = root / "web/features/chat/components/ChatWorkspace.tsx"
    set_open = '''  const setViewerOpen = useCallback((next: boolean) => {
    setViewerPanelOpen(next);
    if (typeof window !== "undefined") {
      browserStorage.writeRaw(
        "local",
        "dt:chat:viewer-panel",
        next ? "1" : "0",
      );
    }
  }, []);'''
    set_open_new = '''  const setViewerOpen = useCallback((next: boolean) => {
    setViewerPanelOpen(next);
    if (typeof window !== "undefined") {
      if (next) window.dispatchEvent(new Event("murikah:close-workbench"));
      browserStorage.writeRaw(
        "local",
        "dt:chat:viewer-panel",
        next ? "1" : "0",
      );
    }
  }, []);
  useEffect(() => {
    const closeActivityForWorkbench = () => setViewerPanelOpen(false);
    window.addEventListener("murikah:open-workbench", closeActivityForWorkbench);
    return () =>
      window.removeEventListener("murikah:open-workbench", closeActivityForWorkbench);
  }, []);'''
    replace_once(path, set_open, set_open_new, "Workbench and Activity ownership")

    toggle = '''  const toggleViewerPanel = useCallback(() => {
    setViewerPanelOpen((prev) => {
      const next = !prev;
      if (typeof window !== "undefined") {
        browserStorage.writeRaw(
          "local",
          "dt:chat:viewer-panel",
          next ? "1" : "0",
        );
      }
      return next;
    });
  }, []);'''
    toggle_new = '''  const toggleViewerPanel = useCallback(() => {
    setViewerPanelOpen((prev) => {
      const next = !prev;
      if (typeof window !== "undefined") {
        if (next) window.dispatchEvent(new Event("murikah:close-workbench"));
        browserStorage.writeRaw(
          "local",
          "dt:chat:viewer-panel",
          next ? "1" : "0",
        );
      }
      return next;
    });
  }, []);'''
    replace_once(path, toggle, toggle_new, "Activity closes Workbench")


def patch_visualizations(root: Path) -> None:
    path = root / "web/components/visualize/VisualizationViewer.tsx"
    replace_once(
        path,
        'import { Code2, Copy, Check, ExternalLink, Maximize2, X } from "lucide-react";',
        'import { Code2, Copy, Check, ExternalLink, Maximize2, Pencil, X } from "lucide-react";',
        "visualization Workbench icon",
    )
    replace_once(
        path,
        'import { prepareIframeHtml } from "@/lib/iframe-html";\n',
        'import { prepareIframeHtml } from "@/lib/iframe-html";\nimport { openMurikahWorkbench } from "@/lib/murikah-workbench";\n',
        "visualization Workbench import",
    )
    replace_once(
        path,
        '''export default function VisualizationViewer({
  result,
}: {
  result: VisualizeResult;
}) {''',
        '''export default function VisualizationViewer({
  result,
  workbenchMode = false,
}: {
  result: VisualizeResult;
  workbenchMode?: boolean;
}) {''',
        "visualization Workbench mode prop",
    )
    old_manim = '''  if (isManimResult(result)) {
    return <MathAnimatorViewer result={result.manim} />;
  }'''
    new_manim = '''  if (isManimResult(result)) {
    return (
      <div className="space-y-3">
        <MathAnimatorViewer result={result.manim} />
        {!workbenchMode && result.manim.code.content ? (
          <button
            type="button"
            onClick={() =>
              openMurikahWorkbench({
                kind: "code",
                renderer: "code",
                title: "Animation source",
                content: result.manim.code.content,
                language: result.manim.code.language,
              })
            }
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--background)] px-2.5 py-1.5 text-[11px] font-medium text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
          >
            <Pencil size={12} strokeWidth={1.8} />
            {t("Edit source")}
          </button>
        ) : null}
      </div>
    );
  }'''
    replace_once(path, old_manim, new_manim, "Manim source Workbench action")

    anchor = '''  const supportsFullscreen =
    result.renderer.target !== "iframe" &&
    result.renderer.native_renderer !== "html";

  const handleCopy = async () => {'''
    replacement = '''  const supportsFullscreen =
    result.renderer.target !== "iframe" &&
    result.renderer.native_renderer !== "html";

  const openVisualizationWorkbench = () => {
    const renderer = result.renderer.native_renderer || result.render_type;
    const payloadMode =
      result.renderer.target === "iframe" ||
      (renderer === "geogebra" &&
        result.payload.data !== null &&
        typeof result.payload.data === "object");
    openMurikahWorkbench({
      kind: "visualization",
      renderer: payloadMode ? "visualization-payload" : "visualization-code",
      title: result.presentation.title || visualizationLabel(result),
      content: payloadMode
        ? JSON.stringify(result.payload.data, null, 2)
        : result.code.content,
      language: payloadMode ? "json" : result.code.language,
      visualizationResult: result,
    });
  };

  const handleCopy = async () => {'''
    replace_once(path, anchor, replacement, "visualization Workbench opener")

    copy_button = '''        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--background)] px-2.5 py-1.5 text-[11px] font-medium text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
        >
          {copied ? (
            <Check size={12} strokeWidth={1.8} />
          ) : (
            <Copy size={12} strokeWidth={1.8} />
          )}
          {copied ? t("Copied") : t("Copy code")}
        </button>'''
    copy_plus_edit = copy_button + '''

        {!workbenchMode && (
          <button
            type="button"
            onClick={openVisualizationWorkbench}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--background)] px-2.5 py-1.5 text-[11px] font-medium text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
          >
            <Pencil size={12} strokeWidth={1.8} />
            {t("Edit in Workbench")}
          </button>
        )}'''
    replace_once(path, copy_button, copy_plus_edit, "visualization Workbench toolbar")


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: apply_workbench.py <deeptutor-root>")
    root = Path(sys.argv[1]).resolve()
    overlay = Path(__file__).resolve().parent
    install_sources(root, overlay)
    patch_app_shell(root)
    patch_markdown_tables(root)
    patch_mermaid(root)
    patch_code_blocks(root)
    patch_chat_actions(root)
    patch_chat_workspace(root)
    patch_visualizations(root)
    print("[Murikah Tutor] Workbench, editable visuals and copyable tables installed.")


if __name__ == "__main__":
    main()
