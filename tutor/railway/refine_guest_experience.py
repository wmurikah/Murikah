#!/usr/bin/env python3
"""Refine the Murikah guest shell after the pinned DeepTutor overlay is applied."""
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
        print("usage: refine_guest_experience.py <deeptutor-checkout>", file=sys.stderr)
        return 2

    root = Path(sys.argv[1]).resolve()
    target = root / "web" / "components" / "chat" / "MurikahGuestChat.tsx"
    if not target.is_file():
        raise RuntimeError(f"Murikah guest component is missing: {target}")

    text = target.read_text(encoding="utf-8")

    text = remove_once(text, "  Cpu,\n", "Cpu icon import")
    text = remove_once(text, "  Settings2,\n", "Settings2 icon import")
    text = remove_once(
        text,
        '''type GuestModelOption = LLMSelection & {\n  profile_name?: string;\n  model_name?: string;\n  provider_label?: string;\n  is_active_default?: boolean;\n};\n\ntype GuestModelsResponse = {\n  active?: { profile_id?: string; model_id?: string } | null;\n  options?: GuestModelOption[];\n};\n\n''',
        "guest model option types",
    )

    constants_anchor = 'const USERNAME_SIGN_IN = `/login?next=${encodeURIComponent(RESUME_NEXT)}`;\n'
    constants = '''const USERNAME_SIGN_IN = `/login?next=${encodeURIComponent(RESUME_NEXT)}`;\n\nconst PERSONAS = [\n  {\n    id: "teacher",\n    label: "Tutor",\n    description: "Clear teaching, examples and checks for understanding.",\n    prompt: "Act as a patient, clear and rigorous tutor. Explain concepts with examples, check understanding, and adapt the depth to the learner.",\n  },\n  {\n    id: "peer",\n    label: "Peer",\n    description: "Collaborative discussion that thinks alongside you.",\n    prompt: "Act as a thoughtful learning peer. Think alongside the learner, compare ideas, ask useful questions, and challenge weak reasoning without becoming overly formal.",\n  },\n  {\n    id: "research-assistant",\n    label: "Research Assistant",\n    description: "Evidence-focused help with claims, sources and research questions.",\n    prompt: "Act as a rigorous research assistant. Separate claims from evidence, surface uncertainty, compare sources or viewpoints, and help the learner form precise research questions.",\n  },\n] as const;\n\nconst DEFAULT_MODE_BY_SPACE: Record<SpaceId, ModeId> = {\n  home: "chat",\n  partners: "chat",\n  agents: "chat",\n  cowriter: "chat",\n  book: "reading",\n  mastery: "mastery",\n  reading: "reading",\n  "learning-space": "course",\n  memory: "chat",\n  knowledge: "research",\n};\n\nconst SPACE_PLACEHOLDERS: Partial<Record<SpaceId, string>> = {\n  partners: "What would you like to work through with your study partner?",\n  agents: "What goal should your learning agent help you plan or work through?",\n  cowriter: "What would you like to write, revise or improve?",\n  book: "What book, chapter or passage are you studying?",\n  mastery: "What do you want to master?",\n  reading: "Paste a passage or describe what you want to read closely.",\n  "learning-space": "What topic or learning objective should we work on?",\n  memory: "What should we continue from this conversation?",\n  knowledge: "What topic or material should we synthesize or compare?",\n};\n'''
    text = replace_once(text, constants_anchor, constants, "guest constants anchor")

    description_updates = {
        "Configure a collaborative tutor partner, its persona, tools, assets and channel.": "Work with a collaborative tutor partner using the default learner setup.",
        "Configure an agent-style learning workflow, tools, autonomy and checkpoints.": "Open an agent-guided learning workflow using the default learner setup.",
        "Configure a focused learning session around an objective, pace and assessment style.": "Open a focused learning session with sensible default pacing and assessment.",
        "Try personalised tutoring controls using the current guest conversation context.": "Continue learning with context from the current guest conversation.",
        "Configure how the Tutor should synthesize, compare and explain supplied knowledge.": "Explore, compare and explain supplied knowledge using the default learner setup.",
    }
    for old, new in description_updates.items():
        text = replace_once(text, old, new, f"space description {old!r}")

    # Guest learning spaces are user-facing surfaces. Keep the default
    # configuration data for behavioural guidance, but remove the configurator
    # itself so unauthenticated learners do not edit advanced workspace setup.
    text = replace_between_once(
        text,
        "function SpaceConfigurator({\n",
        "\n\nexport default function MurikahGuestChat() {\n",
        "",
        "guest space configurator component",
    )

    text = replace_once(
        text,
        '  const [learningModeOpen, setLearningModeOpen] = useState(true);',
        '  const [learningModeOpen, setLearningModeOpen] = useState(false);',
        "learning mode default state",
    )
    text = replace_once(
        text,
        '  const [persona, setPersona] = useState("Patient, clear and rigorous. Use examples and check understanding.");',
        '  const [persona, setPersona] = useState<string>(PERSONAS[0].prompt);',
        "default persona state",
    )
    text = replace_once(
        text,
        '  const [llmSelection, setLlmSelection] = useState<LLMSelection | null>(null);',
        '  const [llmSelection] = useState<LLMSelection | null>(null);',
        "guest model state",
    )
    text = remove_once(
        text,
        '  const [modelOptions, setModelOptions] = useState<GuestModelOption[]>([]);\n',
        "guest model options state",
    )
    text = replace_once(
        text,
        '  const endRef = useRef<HTMLDivElement>(null);\n',
        '  const contentRef = useRef<HTMLDivElement>(null);\n  const endRef = useRef<HTMLDivElement>(null);\n',
        "content scroll ref",
    )

    text = replace_once(
        text,
        '  const ActiveSpaceIcon = activeSpace.icon;\n',
        '  const ActiveSpaceIcon = activeSpace.icon;\n  const activePersona = PERSONAS.find((option) => option.prompt === persona) || PERSONAS[0];\n  const composerPlaceholder = spaceId === "home" ? activeMode.placeholder : (SPACE_PLACEHOLDERS[spaceId] || activeMode.placeholder);\n',
        "active guest surface derivation",
    )
    text = replace_between_once(
        text,
        "  const selectedModelLabel = useMemo(() => {\n",
        "\n\n  useEffect(() => {\n",
        "",
        "guest model label derivation",
    )

    text = remove_once(
        text,
        '''        if (stored.spaceConfigOverrides && typeof stored.spaceConfigOverrides === "object") {\n          setSpaceConfigOverrides({ ...emptyOverrides(), ...stored.spaceConfigOverrides });\n        }\n''',
        "stored guest configuration restoration",
    )
    text = replace_once(
        text,
        '        if (typeof stored.persona === "string") setPersona(stored.persona.slice(0, 1200));',
        '''        if (typeof stored.persona === "string" && PERSONAS.some((option) => option.prompt === stored.persona)) {\n          setPersona(stored.persona);\n        }''',
        "stored persona restoration",
    )
    text = remove_once(
        text,
        '''        if (stored.llmSelection && typeof stored.llmSelection === "object") {\n          setLlmSelection(stored.llmSelection as LLMSelection);\n        }\n''',
        "stored guest model restoration",
    )

    text = remove_once(
        text,
        '''      fetch("/api/murikah/guest-models", { cache: "no-store" }).then(async (response) =>\n        response.ok ? ((await response.json()) as GuestModelsResponse) : null,\n      ),\n''',
        "guest model catalogue request",
    )
    text = replace_once(
        text,
        "      .then(([auth, guest, models]) => {",
        "      .then(([auth, guest]) => {",
        "guest bootstrap result destructuring",
    )
    text = remove_once(
        text,
        "        if (Array.isArray(models?.options)) setModelOptions(models.options);\n",
        "guest model options hydration",
    )

    select_space = '''  function selectSpace(nextSpace: SpaceId) {\n    setSpaceId(nextSpace);\n    setModeId(DEFAULT_MODE_BY_SPACE[nextSpace]);\n    setLearningModeOpen(false);\n    setModeMenuOpen(false);\n    setPreferencesOpen(false);\n    requestAnimationFrame(() => {\n      contentRef.current?.scrollTo({ top: 0, behavior: "smooth" });\n    });\n  }\n'''
    text = replace_between_once(
        text,
        "  function updateSpaceConfiguration(key: string, value: ConfigValue) {\n",
        "\n\n  async function handleFiles",
        select_space,
        "guest space selection handler",
    )

    text = replace_once(
        text,
        '                  onSelect={() => setSpaceId(option.id)}',
        '                  onSelect={() => selectSpace(option.id)}',
        "desktop space selection",
    )
    text = replace_once(
        text,
        '                    onClick={() => setSpaceId(option.id)}',
        '                    onClick={() => selectSpace(option.id)}',
        "mobile space selection",
    )
    text = replace_once(
        text,
        '                          onClick={() => setModeId(mode.id)}',
        '                          onClick={() => { setModeId(mode.id); setLearningModeOpen(false); }}',
        "sidebar learning mode selection",
    )

    text = replace_once(
        text,
        '<main className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">',
        '<main className="h-screen overflow-hidden bg-[var(--background)] text-[var(--foreground)]">',
        "guest root scroll container",
    )
    text = replace_once(
        text,
        '<div className="flex min-h-screen">',
        '<div className="flex h-full min-h-0">',
        "guest root flex container",
    )
    text = replace_once(
        text,
        '<div className="min-w-0 flex-1">',
        '<div ref={contentRef} className="h-screen min-w-0 flex-1 overflow-y-auto overscroll-contain scroll-smooth">',
        "guest content scroll container",
    )

    text = remove_once(
        text,
        '                <span className="hidden text-xs text-[var(--muted-foreground)] sm:inline">{remaining} guest {remaining === 1 ? "interaction" : "interactions"} left</span>\n',
        "header guest allowance counter",
    )

    text = replace_once(
        text,
        '                  Explore the Tutor before signing in. Your seven guest interactions can use learning modes, uploads, persona, voice and model selection — interface changes do not reduce the allowance.',
        '                  Explore the Tutor before signing in. Learning modes, uploads, Persona and voice are available with sensible defaults.',
        "guest hero copy",
    )
    text = replace_once(
        text,
        '                <h1 className="mt-2 text-2xl font-semibold tracking-[-0.025em] sm:text-3xl">Set it up the way you want to learn.</h1>',
        '                <h1 className="mt-2 text-2xl font-semibold tracking-[-0.025em] sm:text-3xl">Start in {activeSpace.label}.</h1>',
        "learning space heading",
    )

    text = replace_once(
        text,
        '                  <h2 className="text-xl font-semibold tracking-tight">Sign in to keep learning</h2>',
        '                  <h2 className="text-xl font-semibold tracking-tight">You have used up 7 of the 7 Guest Interactions. Please sign in.</h2>',
        "guest limit heading",
    )
    text = replace_once(
        text,
        '                    You have reached the seven-interaction guest limit. Your guest conversation is retained in this browser and will be continued in your account after sign-in — you will not lose the chat or start again.',
        '                    Your guest conversation is saved in this browser and will continue in your account after sign-in.',
        "guest limit detail",
    )

    text = remove_once(
        text,
        '                <SpaceConfigurator space={activeSpace} values={activeOverrides} onChange={updateSpaceConfiguration} />\n\n',
        "guest space configurator invocation",
    )

    preferences_start = '                {preferencesOpen && (\n'
    attachments_marker = '                {attachments.length > 0 && (\n'
    preferences_replacement = '''                {preferencesOpen && (\n                  <div className="mb-3 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 shadow-sm">\n                    <div className="mb-2 text-xs font-semibold text-[var(--foreground)]">Persona</div>\n                    <div className="grid gap-2 sm:grid-cols-3">\n                      {PERSONAS.map((option) => {\n                        const active = option.id === activePersona.id;\n                        return (\n                          <button\n                            key={option.id}\n                            type="button"\n                            aria-pressed={active}\n                            onClick={() => { setPersona(option.prompt); setPreferencesOpen(false); }}\n                            className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${active ? "border-[#A9822E]/45 bg-[#A9822E]/10" : "border-[var(--border)] hover:bg-[var(--muted)]/60"}`}\n                          >\n                            <span className="block text-xs font-semibold text-[var(--foreground)]">{option.label}</span>\n                            <span className="mt-1 block text-[11px] leading-4 text-[var(--muted-foreground)]">{option.description}</span>\n                          </button>\n                        );\n                      })}\n                    </div>\n                  </div>\n                )}\n\n'''
    text = replace_between_once(
        text,
        preferences_start,
        attachments_marker,
        preferences_replacement,
        "guest persona panel",
    )

    old_personalise = '''                      <button type="button" onClick={() => setPreferencesOpen((open) => !open)} title="Persona and model" className={`inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs ${preferencesOpen ? "bg-[var(--muted)] text-[var(--foreground)]" : "text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]"}`}>\n                        <Settings2 size={16} />\n                        <span className="hidden sm:inline">Personalise</span>\n                      </button>\n                      <span title={`Model: ${selectedModelLabel}`} className="hidden max-w-44 items-center gap-1.5 truncate rounded-lg px-2 py-1.5 text-[11px] text-[var(--muted-foreground)] md:inline-flex">\n                        <Cpu size={14} />{selectedModelLabel}\n                      </span>\n'''
    new_persona_button = '''                      <button type="button" onClick={() => setPreferencesOpen((open) => !open)} title={`Persona: ${activePersona.label}`} className={`inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs ${preferencesOpen ? "bg-[var(--muted)] text-[var(--foreground)]" : "text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]"}`}>\n                        <Users size={16} />\n                        <span className="hidden sm:inline">Persona · {activePersona.label}</span>\n                      </button>\n'''
    text = replace_once(text, old_personalise, new_persona_button, "guest persona composer control")

    text = replace_once(
        text,
        "                    placeholder={activeMode.placeholder}",
        "                    placeholder={composerPlaceholder}",
        "space-aware composer placeholder",
    )

    text = remove_once(
        text,
        '''                <p className="mt-3 text-center text-[11px] text-[var(--muted-foreground)]">\n                  {remaining} of 7 guest interactions remaining · UI controls do not count · your chat can continue after sign-in\n                </p>\n''',
        "footer guest allowance counter",
    )

    target.write_text(text, encoding="utf-8")
    print("Refined Murikah guest learning experience.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
