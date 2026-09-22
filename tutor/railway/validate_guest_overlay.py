#!/usr/bin/env python3
"""Build-time invariants for the Murikah Tutor guest experience overlay."""
from __future__ import annotations

import sys
from pathlib import Path


def require_markers(path: Path, markers: tuple[str, ...]) -> None:
    if not path.is_file():
        raise RuntimeError(f"missing guest overlay file: {path}")
    content = path.read_text(encoding="utf-8")
    for marker in markers:
        if marker not in content:
            raise RuntimeError(f"guest overlay invariant missing in {path}: {marker!r}")


def forbid_markers(path: Path, markers: tuple[str, ...]) -> None:
    if not path.is_file():
        raise RuntimeError(f"missing guest overlay file: {path}")
    content = path.read_text(encoding="utf-8")
    for marker in markers:
        if marker in content:
            raise RuntimeError(f"guest overlay forbidden marker present in {path}: {marker!r}")


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: validate_guest_overlay.py <deeptutor-root>")
    root = Path(sys.argv[1]).resolve()
    guest_chat = root / "web/components/chat/MurikahGuestChat.tsx"

    require_markers(
        guest_chat,
        (
            "murikah:tutor:guest-handoff:v2",
            "Voice input",
            "const PERSONAS = [",
            'label: "Tutor"',
            'label: "Peer"',
            'label: "Research Assistant"',
            "Persona · {activePersona.label}",
            "DEFAULT_MODE_BY_SPACE",
            "SPACE_PLACEHOLDERS",
            "composerPlaceholder",
            "const GUEST_SPACE_IDS: SpaceId[]",
            '"cowriter"',
            '"book"',
            '"mastery"',
            '"reading"',
            '"learning-space"',
            '"diagram"',
            'label: "Diagram Design"',
            "function DiagramMessage({ content }",
            "extractDiagramSvg",
            'sandbox=""',
            "Content-Security-Policy",
            "Diagram preview is isolated from the Tutor page",
            "const [mobileExploreOpen, setMobileExploreOpen] = useState(false);",
            "function resetGuestConversation()",
            "setMessages([]);",
            "handoffIdRef.current = createHandoffId();",
            "function selectMode(nextMode: ModeId)",
            "onClick={() => selectMode(mode.id)}",
            "Guest learning experiences",
            "More when you sign in",
            "animate-pulse text-[#A9822E]",
            "Upload text file",
            "You have used up 7 of the 7 Guest Interactions. Please sign in.",
            'import MarkdownRenderer from "@/components/common/MarkdownRenderer";',
            'message.role === "assistant" ? (',
            "<MarkdownRenderer",
            "content={message.content}",
            "setDraft(prompt);",
            "Your prompt is still here",
            "const transcriptRef = useRef<HTMLDivElement>(null);",
            "transcript.scrollTo({",
            'h-[calc(100dvh-4rem)]',
            'ref={transcriptRef} className="mx-auto min-h-0 w-full max-w-3xl flex-1 space-y-6 overflow-y-auto overscroll-y-contain scroll-smooth',
            'shrink-0 bg-[var(--background)] pb-[max(1rem,env(safe-area-inset-bottom))] pt-3',
            'const SIGN_UP =',
            '<MurikahInviteFriends',
            'href={USERNAME_SIGN_IN}',
            'href={SIGN_UP}',
            'href="/register?next=%2Fvirtual-internship"',
            'aria-label="Virtual Internship, coming soon"',
        ),
    )
    forbid_markers(
        guest_chat,
        (
            "Tutor persona / personalisation",
            ">Personalise</span>",
            "of 7 guest interactions remaining",
            'guest {remaining === 1 ? "interaction" : "interactions"} left',
            "function SpaceConfigurator({",
            "<SpaceConfigurator space={activeSpace}",
            "setLlmSelection(",
            "/api/murikah/guest-models",
            "setSpaceConfigOverrides({ ...emptyOverrides(), ...stored.spaceConfigOverrides })",
            'className="h-screen overflow-hidden bg-[var(--background)]',
            "ref={contentRef}",
            "overflow-y-auto overscroll-contain scroll-smooth",
            "Choose Learning Mode",
            "Tutor could not answer that prompt.",
            'endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });',
        ),
    )
    require_markers(
        root / "web/components/chat/MurikahGuestResume.tsx",
        (
            "/api/murikah/guest-handoff",
            "Continuing your guest conversation",
            "resume_guest",
            "children: ReactNode",
            'status === "idle"',
            "browser-retained guest state is authoritative",
        ),
    )
    require_markers(
        root / "web/app/(workspace)/chat/page.tsx",
        ("MurikahGuestResume", "<MurikahGuestResume>", "<ChatWorkspace />"),
    )
    require_markers(
        root / "web/components/sidebar/nav-entries.ts",
        (
            'href: "/diagram-design"',
            'label: "Diagram Design"',
            "icon: Workflow",
            'href: "/virtual-internship"',
            'label: "Virtual Internship"',
            "icon: GraduationCap",
            'A 3+ month simulated workplace with evidence-based competency tracking',
            'requires: "llm"',
        ),
    )
    require_markers(
        root / "web/app/(workspace)/virtual-internship/page.tsx",
        (
            "Virtual Internship",
            "at least three months",
            "AI workplace actors",
            "Competency Passport",
            "Start internship, coming later",
        ),
    )
    require_markers(
        root / "web/components/diagram/MurikahDiagramStudio.tsx",
        (
            'fetch("/api/murikah/diagram"',
            "const DIAGRAM_TYPES = [",
            'sandbox=""',
            "Content-Security-Policy",
            "Download SVG",
            "Design diagram",
            "max-h-[720px]",
            "overscroll-behavior:contain",
            'border-t border-[var(--border)]',
        ),
    )
    require_markers(
        root / "web/app/(workspace)/diagram-design/page.tsx",
        ("MurikahDiagramStudio", "<MurikahDiagramStudio />"),
    )
    require_markers(
        root / "web/components/auth/MurikahGuestBanner.tsx",
        (
            "fixed inset-0 z-[200]",
            "You've used all 7 guest interactions.",
            "The guest composer is locked",
            "guest_exhausted=1",
        ),
    )
    require_markers(
        root / "web/components/auth/MurikahAccountPage.tsx",
        (
            "preserveGuestConversation",
            'const RESUME_NEXT = "/chat?resume_guest=1"',
            "Your 7 guest interactions are complete.",
            "resolveNext={continuationForAccountChange}",
            "/api/murikah/access/signup",
            'aria-label="Account access"',
            'aria-current={!isSignup ? "page" : undefined}',
            'aria-current={isSignup ? "page" : undefined}',
            "bg-[#1E2A30] text-white shadow-md",
            'verify_email',
            '/api/murikah/access/signup/verify',
            '/api/auth/oauth/verify-email',
            "Verify your email",
            'autoComplete="one-time-code"',
            "<MurikahInviteFriends />",
        ),
    )
    require_markers(
        root / "web/components/auth/MurikahInviteFriends.tsx",
        (
            "Invite friends to Murikah Tutor",
            "mailto:?subject=",
            "https://wa.me/?text=",
            "navigator.share",
            "Copy link",
        ),
    )
    require_markers(
        root / "web/components/auth/MurikahSocialButtons.tsx",
        (
            "resolveNext?: () => string | Promise<string>",
            "event.preventDefault()",
            "await resolveNext()",
            'data-google-logo="true"',
            'fill="#4285F4"',
            'fill="#34A853"',
            'fill="#FBBC05"',
            'fill="#EA4335"',
            'aria-label="Single sign-on"',
            'data-provider={provider.id}',
            "or continue with email or username",
        ),
    )
    require_markers(
        root / "web/components/Mermaid.tsx",
        (
            "[&>svg]:max-h-[70dvh]",
            "overflow-auto overscroll-contain",
        ),
    )
    require_markers(
        root / "web/components/visualize/VisualizationViewer.tsx",
        (
            'maxHeight: "70dvh"',
            "h-[clamp(280px,55dvh,640px)]",
            "min-w-0 max-w-full space-y-3 overflow-hidden",
            "[&>svg]:max-h-[70dvh]",
        ),
    )
    require_markers(
        root / "web/features/chat/messages/ChatMessageList.tsx",
        (
            "max-h-[70dvh] w-full max-w-full",
            "sm:max-w-[min(520px,90%)]",
            '<div className="min-w-0 max-w-full overflow-hidden">',
        ),
    )
    for markdown_renderer in (
        "web/components/common/SimpleMarkdownRenderer.tsx",
        "web/components/common/RichMarkdownRenderer.tsx",
    ):
        require_markers(
            root / markdown_renderer,
            ("max-h-[70dvh] max-w-full object-contain",),
        )

    require_markers(
        root / "web/components/layout/AppShell.tsx",
        (
            'pathname === "/diagram-design"',
            "overflow-y-auto overscroll-y-contain touch-pan-y",
        ),
    )
    require_markers(
        root / "web/hooks/useChatAutoScroll.ts",
        (
            "lastObservedScrollTopRef",
            "current < previous - 1",
        ),
    )
    require_markers(
        root / "web/features/chat/components/ChatWorkspace.tsx",
        (
            "overflow-y-auto overscroll-y-contain touch-pan-y",
            'data-chat-scroll-root="true"',
        ),
    )
    require_markers(
        root / "deeptutor/multi_user/model_access.py",
        (
            "def deployment_llm_rows(",
            "inherited = deployment_llm_rows(catalog)",
            "unique: list[dict[str, Any]] = []",
            "if active is None and options:",
            "is_owner_bound(profile)",
            '"source": "admin"',
        ),
    )
    settings_nav = root / "web/features/settings/navigation/settings-nav.ts"
    settings_nav_text = settings_nav.read_text(encoding="utf-8")
    model_start = settings_nav_text.find("const MODEL_CHILDREN: SettingsLeaf[] = [")
    model_end = settings_nav_text.find("const CHAT_CHILDREN: SettingsLeaf[] = [", model_start)
    if model_start < 0 or model_end < 0:
        raise RuntimeError(f"could not isolate model settings section in {settings_nav}")
    model_section = settings_nav_text[model_start:model_end]
    for key in (
        "connections",
        "llm",
        "task-models",
        "embedding",
        "search",
        "tts",
        "stt",
        "imagegen",
        "videogen",
    ):
        key_pos = model_section.find(f'key: "{key}"')
        if key_pos < 0:
            raise RuntimeError(f"missing model settings leaf {key!r} in {settings_nav}")
        next_item = model_section.find("\n  {", key_pos + 1)
        item = model_section[key_pos : len(model_section) if next_item < 0 else next_item]
        if "adminOnly: true" not in item:
            raise RuntimeError(
                f"ordinary users can still see admin model settings leaf {key!r}"
            )

    require_markers(
        root / "deeptutor/api/routers/settings.py",
        (
            "change_deployment_settings",
            "model_provider_configuration",
            "Model and provider configuration is managed by an administrator.",
            "def _require_codex_oauth_actor() -> None:",
            "_require_settings_admin()",
        ),
    )
    require_markers(
        root / "deeptutor/murikah_persistence.py",
        (
            "def object_ownership(",
            "x-murikah-object-owner-kind",
            "def account_upsert(",
            "def access_audit(",
            "def reconcile_ownership(",
            "def reconcile_accounts(",
            "def email_verification_start(",
            "def email_verification_resend(",
            "def email_verification_verify(",
        ),
    )
    require_markers(
        root / "deeptutor/murikah_email_verification.py",
        (
            "MURIKAH_VERIFIED_EMAIL_V1 = True",
            "disposable_domains",
            "privaterelay.appleid.com",
            "cloudflare-dns.com/dns-query",
            "Temporary or disposable email addresses cannot be used",
        ),
    )
    disposable = root / "deeptutor/disposable_email_domains.txt"
    if not disposable.is_file():
        raise RuntimeError(f"missing disposable email blocklist: {disposable}")
    disposable_count = sum(
        1
        for line in disposable.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    )
    if disposable_count < 5000:
        raise RuntimeError(
            f"disposable email blocklist unexpectedly small: {disposable_count}"
        )
    require_markers(
        root / "deeptutor/murikah_access.py",
        (
            "durable.account_upsert(",
            "durable_identity.account_upsert(",
            '@router.post("/signup", status_code=202)',
            '@router.post("/signup/verify", status_code=201)',
            '@router.post("/email/resend")',
            "verification_required",
            "email_verified_at=verified_at",
        ),
    )
    require_markers(
        root / "deeptutor/api/routers/murikah_oauth.py",
        (
            "def _persist_social_account(",
            "murikah_persistence.account_upsert(",
            "Social account storage is temporarily unavailable.",
            '_PENDING_COOKIE = "mt_oauth_pending"',
            "def _existing_social_username(",
            "async def _login_or_verify_redirect(",
            '@router.post("/verify-email")',
            "email_verified_at=verified_at",
        ),
    )

    require_markers(
        root / "deeptutor/api/routers/auth.py",
        (
            "sliding: every normal auth-status read renews",
            'not str(payload.username).startswith("guest_")',
            "response.set_cookie(",
        ),
    )
    require_markers(
        root / "deeptutor/agents/math_animator/structured_output.py",
        (
            "async def direct_structured_payload(",
            "async def request_structured_payload(",
            "MURIKAH_MATH_STRUCTURED_TIMEOUT_SECONDS",
            "finish_reason_needs_continuation",
            "primary_attempts = 2 if attachments else 1",
        ),
    )
    require_markers(
        root / "deeptutor/agents/math_animator/agents/concept_analysis_agent.py",
        (
            "request_structured_payload",
            "Explain visually:",
            "Create a clear",
        ),
    )
    require_markers(
        root / "deeptutor/agents/math_animator/agents/concept_design_agent.py",
        (
            "request_structured_payload",
            "Use Manim Community Edition APIs only.",
            "Do not require network access or external assets.",
        ),
    )
    require_markers(
        root / "deeptutor/agents/math_animator/agents/code_generator_agent.py",
        (
            "direct_structured_payload",
            'required_nonempty="code"',
            "Murikah could not prepare animation code after bounded retries.",
        ),
    )
    require_markers(
        root / "deeptutor/agents/math_animator/agents/summary_agent.py",
        (
            "request_structured_payload",
            "Your math animation is ready.",
        ),
    )
    require_markers(
        root / "deeptutor/agents/math_animator/capability.py",
        (
            "Provider/backend details belong in server logs",
            "await stream.error(\n                    fallback,",
        ),
    )

    require_markers(
        root / "deeptutor/agents/loop/agent_loop.py",
        (
            "_murikah_solve_repair_attempted",
            "solve_final_repair",
            "Finishing the solution",
        ),
    )
    require_markers(
        root / "deeptutor/murikah_diagram.py",
        (
            "Return one complete SVG FIRST",
            "Diagram Design is an artifact-first surface",
        ),
    )

    guest_router = root / "deeptutor/api/routers/murikah_guest.py"
    require_markers(
        guest_router,
        (
            '@router.get("/guest-models")',
            '@router.post("/guest-handoff")',
            '@router.post("/diagram")',
            "class DiagramDesignRequest(BaseModel):",
            "Depends(require_auth)",
            "next_used = used + 1",
            "resolve_llm_config_for_selection",
            '"diagram",',
            '"diagram": "Design an editorial-quality diagram',
            "_GUEST_COMPLETION_TIMEOUT_SECONDS = 75",
            "await asyncio.wait_for(",
            "HTTP_504_GATEWAY_TIMEOUT",
            "HTTP_503_SERVICE_UNAVAILABLE",
            "Reference {incident_id}",
        ),
    )


if __name__ == "__main__":
    main()
