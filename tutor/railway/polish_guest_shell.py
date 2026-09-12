#!/usr/bin/env python3
"""Simplify and harden the public Murikah Tutor guest shell."""
from __future__ import annotations

from pathlib import Path
import sys


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"Expected exactly one {label}, found {count}")
    return text.replace(old, new, 1)


def remove_once(text: str, old: str, label: str) -> str:
    return replace_once(text, old, "", label)


def replace_between_once(
    text: str,
    start_marker: str,
    end_marker: str,
    replacement: str,
    label: str,
) -> str:
    start_count = text.count(start_marker)
    if start_count != 1:
        raise RuntimeError(f"Expected exactly one {label} start marker, found {start_count}")
    start = text.index(start_marker)
    end = text.find(end_marker, start + len(start_marker))
    if end < 0:
        raise RuntimeError(f"Missing {label} end marker")
    return text[:start] + replacement + text[end:]


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: polish_guest_shell.py <deeptutor-checkout>", file=sys.stderr)
        return 2

    root = Path(sys.argv[1]).resolve()
    target = root / "web" / "components" / "chat" / "MurikahGuestChat.tsx"
    if not target.is_file():
        raise RuntimeError(f"Murikah guest component is missing: {target}")

    text = target.read_text(encoding="utf-8")

    text = replace_once(
        text,
        "\nfunction emptyOverrides(): SpaceConfigOverrides {",
        '''\nconst GUEST_SPACE_IDS: SpaceId[] = [\n  "home",\n  "cowriter",\n  "book",\n  "mastery",\n  "reading",\n  "learning-space",\n];\n\nfunction emptyOverrides(): SpaceConfigOverrides {''',
        "guest space shortlist",
    )

    text = remove_once(
        text,
        '  const [learningModeOpen, setLearningModeOpen] = useState(false);\n',
        "guest sidebar learning mode state",
    )
    text = remove_once(
        text,
        '  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);\n',
        "guest sidebar collapse state",
    )
    text = replace_once(
        text,
        '  const [preferencesOpen, setPreferencesOpen] = useState(false);\n',
        '  const [preferencesOpen, setPreferencesOpen] = useState(false);\n  const [mobileExploreOpen, setMobileExploreOpen] = useState(false);\n',
        "mobile guest explore state",
    )
    text = remove_once(
        text,
        '  const contentRef = useRef<HTMLDivElement>(null);\n',
        "nested guest content scroll ref",
    )

    old_select_space = '''  function selectSpace(nextSpace: SpaceId) {\n    setSpaceId(nextSpace);\n    setModeId(DEFAULT_MODE_BY_SPACE[nextSpace]);\n    setLearningModeOpen(false);\n    setModeMenuOpen(false);\n    setPreferencesOpen(false);\n    requestAnimationFrame(() => {\n      contentRef.current?.scrollTo({ top: 0, behavior: "smooth" });\n    });\n  }\n'''
    new_navigation = '''  function resetGuestConversation() {\n    setMessages([]);\n    setDraft("");\n    setAttachments([]);\n    setError("");\n    setModeMenuOpen(false);\n    setPreferencesOpen(false);\n    setMobileExploreOpen(false);\n    handoffIdRef.current = createHandoffId();\n    requestAnimationFrame(() => {\n      window.scrollTo({ top: 0, behavior: "smooth" });\n    });\n  }\n\n  function selectSpace(nextSpace: SpaceId) {\n    if (nextSpace === spaceId || busy) {\n      setMobileExploreOpen(false);\n      return;\n    }\n    setSpaceId(nextSpace);\n    setModeId(DEFAULT_MODE_BY_SPACE[nextSpace]);\n    resetGuestConversation();\n  }\n\n  function selectMode(nextMode: ModeId) {\n    if (nextMode === modeId || busy) {\n      setModeMenuOpen(false);\n      return;\n    }\n    setModeId(nextMode);\n    resetGuestConversation();\n  }\n'''
    text = replace_once(text, old_select_space, new_navigation, "fresh guest navigation handlers")

    text = replace_once(
        text,
        '                                  onClick={() => { setModeId(mode.id); setModeMenuOpen(false); }}',
        '                                  onClick={() => selectMode(mode.id)}',
        "composer learning mode selection",
    )

    # Use normal document scrolling. The previous nested h-screen + overflow
    # container caused wheel/touch scroll to become trapped on desktop and mobile.
    text = replace_once(
        text,
        '<main className="h-screen overflow-hidden bg-[var(--background)] text-[var(--foreground)]">',
        '<main className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">',
        "guest root natural scroll",
    )
    text = replace_once(
        text,
        '<div className="flex h-full min-h-0">',
        '<div className="flex min-h-screen">',
        "guest root natural flex",
    )
    text = replace_once(
        text,
        '        </aside>\n\n        <div ref={contentRef} className="h-screen min-w-0 flex-1 overflow-y-auto overscroll-contain scroll-smooth">',
        '        </aside>\n\n        <div className="min-w-0 flex-1">',
        "remove nested guest scroll container",
    )

    aside_start = '        <aside\n'
    aside_end = '\n\n        <div className="min-w-0 flex-1">'
    aside = '''        <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-[var(--border)]/70 bg-[var(--background)] px-3 py-4 lg:flex">\n          <div className="mb-5 px-2">\n            <div className="inline-flex items-center gap-2.5 rounded-lg bg-[#1E2A30] px-3 py-1.5 text-sm font-semibold tracking-tight text-white shadow-sm" aria-label="Murikah Tutor">\n              <span>Murikah</span><span aria-hidden className="h-4 w-px bg-[#A9822E]" /><span>Tutor</span>\n            </div>\n          </div>\n\n          <div className="min-h-0 flex-1 overflow-y-auto pr-0.5">\n            <div className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--muted-foreground)]">Explore</div>\n            <nav className="space-y-1" aria-label="Guest learning experiences">\n              {SPACES.filter((option) => GUEST_SPACE_IDS.includes(option.id)).map((option) => (\n                <SidebarSpaceButton\n                  key={option.id}\n                  option={option}\n                  active={option.id === spaceId}\n                  collapsed={false}\n                  onSelect={() => selectSpace(option.id)}\n                />\n              ))}\n            </nav>\n          </div>\n\n          <div className="mt-4 border-t border-[var(--border)]/70 pt-4">\n            <div className="rounded-2xl border border-[#A9822E]/20 bg-[#A9822E]/[0.06] p-4">\n              <div className="flex items-center gap-2 text-xs font-semibold text-[var(--foreground)]">\n                <Sparkles size={14} className="animate-pulse text-[#A9822E]" />\n                More when you sign in\n              </div>\n              <p className="mt-2 text-[11px] leading-5 text-[var(--muted-foreground)]">\n                Save conversations and unlock Partners, Agents, Memory and your Knowledge Center.\n              </p>\n              <Link\n                href={USERNAME_SIGN_IN}\n                onClick={persistGuestState}\n                className="mt-3 block rounded-lg bg-[#1E2A30] px-3 py-2 text-center text-xs font-semibold text-white transition-opacity hover:opacity-90"\n              >\n                Sign in and continue\n              </Link>\n            </div>\n          </div>\n        </aside>'''
    text = replace_between_once(text, aside_start, aside_end, aside, "simplified guest desktop sidebar")

    header_start = '          <header className="sticky top-0 z-30 border-b border-[var(--border)]/70 bg-[var(--background)]/95 backdrop-blur">\n'
    section_marker = '          <section className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-5xl flex-col px-4 py-6 sm:px-6 sm:py-8">'
    header_and_mobile = '''          <header className="sticky top-0 z-30 border-b border-[var(--border)]/70 bg-[var(--background)]/95 backdrop-blur">\n            <div className="flex min-h-16 items-center justify-between gap-3 px-4 py-3 sm:px-6">\n              <div className="inline-flex items-center gap-2.5 rounded-lg bg-[#1E2A30] px-3 py-1.5 text-sm font-semibold tracking-tight text-white shadow-sm lg:hidden">\n                <span>Murikah</span><span aria-hidden className="h-4 w-px bg-[#A9822E]" /><span>Tutor</span>\n              </div>\n              <div className="hidden items-center gap-2 text-sm font-medium text-[var(--muted-foreground)] lg:flex">\n                <ActiveModeIcon size={15} className="text-[#A9822E]" />\n                <span>{activeMode.label}</span>\n                <span aria-hidden>·</span>\n                <span>{activeSpace.label}</span>\n              </div>\n              <div className="flex items-center gap-2 sm:gap-3">\n                <button\n                  type="button"\n                  onClick={() => setMobileExploreOpen((open) => !open)}\n                  aria-expanded={mobileExploreOpen}\n                  className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-2.5 py-2 text-xs font-medium text-[var(--foreground)] lg:hidden"\n                >\n                  <Grid3X3 size={14} className="text-[#A9822E]" />\n                  Explore\n                </button>\n                <Link\n                  href={USERNAME_SIGN_IN}\n                  onClick={persistGuestState}\n                  className="text-sm font-medium text-[var(--foreground)]/75 hover:text-[var(--foreground)]"\n                >\n                  Sign in\n                </Link>\n              </div>\n            </div>\n          </header>\n\n          {mobileExploreOpen && (\n            <div className="border-b border-[var(--border)]/60 bg-[var(--background)] px-4 py-3 lg:hidden">\n              <div className="grid grid-cols-2 gap-2" aria-label="Guest learning experiences">\n                {SPACES.filter((option) => GUEST_SPACE_IDS.includes(option.id)).map((option) => {\n                  const Icon = option.icon;\n                  const active = option.id === spaceId;\n                  return (\n                    <button\n                      key={option.id}\n                      type="button"\n                      onClick={() => selectSpace(option.id)}\n                      className={`flex min-h-14 items-center gap-2 rounded-xl border px-3 py-2.5 text-left text-xs font-medium transition-colors ${active ? "border-[#A9822E]/40 bg-[#A9822E]/10 text-[var(--foreground)]" : "border-[var(--border)] text-[var(--foreground)]/80 hover:bg-[var(--muted)]/60"}`}\n                    >\n                      <Icon size={15} className="shrink-0 text-[#A9822E]" />\n                      <span>{option.label}</span>\n                    </button>\n                  );\n                })}\n              </div>\n            </div>\n          )}\n\n'''
    text = replace_between_once(text, header_start, section_marker, header_and_mobile, "responsive guest header/navigation")

    text = replace_once(
        text,
        '                  Explore the Tutor before signing in. Learning modes, uploads, Persona and voice are available with sensible defaults.',
        '                  Explore Murikah Tutor before signing in. Choose an experience, ask naturally, and continue your work when you sign in.',
        "guest marketing hero copy",
    )

    target.write_text(text, encoding="utf-8")
    print("Polished Murikah guest navigation, fresh-context behaviour and responsive scrolling.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
