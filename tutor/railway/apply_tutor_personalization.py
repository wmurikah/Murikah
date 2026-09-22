#!/usr/bin/env python3
"""Apply Murikah Tutor personalization and visible-text policy to pinned DeepTutor."""
from __future__ import annotations

from pathlib import Path
import re
import shutil
import sys

EM_DASH = chr(0x2014)
ENTITY_RE = re.compile(r"(?i)&mdash;|&#8212;|&#x0*2014;")
RUNTIME_SUFFIXES = {".ts", ".tsx", ".js", ".jsx", ".json", ".css", ".mjs", ".cjs", ".html", ".mdx"}


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"Expected one {label} in {path}, found {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def copy_personalization_sources(root: Path, overlay: Path) -> None:
    copies = {
        "murikah_personalization.py": "deeptutor/murikah_personalization.py",
        "murikah_visible_text.py": "deeptutor/murikah_visible_text.py",
        "murikah-personalization.ts.txt": "web/lib/murikah-personalization.ts",
        "MurikahPreferredName.tsx.txt": "web/components/auth/MurikahPreferredName.tsx",
    }
    for source, target in copies.items():
        shutil.copy2(overlay / source, root / target)


def patch_auth_bootstrap(root: Path) -> None:
    path = root / "deeptutor/api/routers/auth.py"
    replace_once(
        path,
        '''    learning_policy: dict | None = None
''',
        '''    learning_policy: dict | None = None
    preferred_name: str | None = None
    derived_name: str | None = None
    needs_name_prompt: bool = False
''',
        "auth personalization response fields",
    )
    replace_once(
        path,
        '''    return AuthStatusResponse(
        enabled=True,
''',
        '''    personalization = {
        "preferred_name": None,
        "derived_name": None,
        "needs_name_prompt": False,
    }
    if payload is not None and not str(payload.username).startswith("guest_"):
        from deeptutor.murikah_personalization import personalization_for_actor

        personalization = personalization_for_actor(payload.user_id, payload.username)
    return AuthStatusResponse(
        enabled=True,
''',
        "auth personalization bootstrap",
    )
    replace_once(
        path,
        '''        learning_policy=learning_policy,
    )
''',
        '''        learning_policy=learning_policy,
        preferred_name=personalization["preferred_name"],
        derived_name=personalization["derived_name"],
        needs_name_prompt=personalization["needs_name_prompt"],
    )
''',
        "auth personalization response values",
    )


def patch_auth_frontend(root: Path) -> None:
    auth = root / "web/lib/auth.ts"
    replace_once(
        auth,
        '''  is_admin?: boolean;
''',
        '''  is_admin?: boolean;
  preferred_name?: string | null;
  derived_name?: string | null;
  needs_name_prompt?: boolean;
''',
        "frontend auth personalization fields",
    )

    hook = root / "web/hooks/useAuthStatus.ts"
    replace_once(
        hook,
        '''  userId: string | null;
''',
        '''  userId: string | null;
  preferredName: string | null;
  derivedName: string | null;
  needsNamePrompt: boolean;
''',
        "auth hook personalization fields",
    )
    replace_once(
        hook,
        '''  userId: null,
  statusAvailable: false,
''',
        '''  userId: null,
  preferredName: null,
  derivedName: null,
  needsNamePrompt: false,
  statusAvailable: false,
''',
        "auth hook personalization defaults",
    )
    replace_once(
        hook,
        '''    userId:
      typeof status?.user_id === "string" && status.user_id.trim()
        ? status.user_id
        : null,
    statusAvailable: status !== null,
''',
        '''    userId:
      typeof status?.user_id === "string" && status.user_id.trim()
        ? status.user_id
        : null,
    preferredName:
      typeof status?.preferred_name === "string" && status.preferred_name.trim()
        ? status.preferred_name
        : null,
    derivedName:
      typeof status?.derived_name === "string" && status.derived_name.trim()
        ? status.derived_name
        : null,
    needsNamePrompt: Boolean(status?.needs_name_prompt),
    statusAvailable: status !== null,
''',
        "auth hook personalization mapping",
    )



def patch_chat_display_sanitizer(root: Path) -> None:
    """Sanitize accumulated assistant display text, including split stream entities."""
    path = root / "web/features/chat/ChatStateAdapter.tsx"
    replace_once(
        path,
        '''import { normalizeMessageContent } from "@/lib/message-content";
''',
        '''import { normalizeMessageContent } from "@/lib/message-content";
import { sanitizeTutorVisibleText } from "@/lib/murikah-personalization";
''',
        "chat display visible-text import",
    )
    replace_once(
        path,
        '''              message.role === "assistant"
                ? normalizeMarkdownForDisplay(raw)
                : raw,
''',
        '''              message.role === "assistant"
                ? sanitizeTutorVisibleText(normalizeMarkdownForDisplay(raw))
                : raw,
''',
        "hydrated assistant display sanitizer",
    )
    replace_once(
        path,
        '''        content = repairChineseEmphasis(rawContent, language);
''',
        '''        content = sanitizeTutorVisibleText(
          repairChineseEmphasis(rawContent, language),
        );
''',
        "narration recompute sanitizer",
    )
    replace_once(
        path,
        '''        content = appendWithEmphasisRepair(content, delta, rawContent, language);
''',
        '''        content = sanitizeTutorVisibleText(
          appendWithEmphasisRepair(content, delta, rawContent, language),
        );
''',
        "stream accumulated display sanitizer",
    )


def patch_member_chat(root: Path) -> None:
    path = root / "web/features/chat/components/ChatWorkspace.tsx"
    replace_once(
        path,
        '''import { useSetupSync } from "@/hooks/useSetupSync";
''',
        '''import { useSetupSync } from "@/hooks/useSetupSync";
import { useAuthStatus } from "@/hooks/useAuthStatus";
import {
  composerPlaceholderForIndex,
  greetingForContext,
  sanitizeTutorVisibleText,
} from "@/lib/murikah-personalization";
import { MurikahNamePrompt } from "@/components/auth/MurikahPreferredName";
''',
        "chat personalization imports",
    )

    old = '''  // Time-of-day greeting: seeded once on mount from the user's local clock so
  // the heading stays stable while they're on the page. State (not useMemo)
  // because the random pick would otherwise mismatch SSR ↔ client hydration.
  const [welcomeGreeting, setWelcomeGreeting] = useState<string>(
    "What would you like to learn?",
  );
  useEffect(() => {
    const hour = new Date().getHours();
    let bucket: string[];
    if (hour >= 5 && hour < 12) {
      bucket = [
        "Good morning.",
        "Morning ''' + EM_DASH + ''' let's learn something.",
        "What would you like to learn?",
      ];
    } else if (hour >= 12 && hour < 17) {
      bucket = [
        "Good afternoon.",
        "Afternoon ''' + EM_DASH + ''' what's on your mind?",
        "What would you like to learn?",
      ];
    } else if (hour >= 17 && hour < 22) {
      bucket = [
        "Good evening.",
        "Evening ''' + EM_DASH + ''' what shall we explore?",
        "What would you like to learn?",
      ];
    } else {
      bucket = [
        "It's late today.",
        "Burning the midnight oil?",
        "What would you like to learn?",
      ];
    }
    setWelcomeGreeting(bucket[Math.floor(Math.random() * bucket.length)]);
  }, []);
'''
    new = '''  const authStatus = useAuthStatus();
  const greetingChoiceRef = useRef<number | null>(null);
  const [nameOverride, setNameOverride] = useState<string | null>(null);
  const [welcomeGreeting, setWelcomeGreeting] = useState("What's on your mind?");
  const [emptyComposerPlaceholder, setEmptyComposerPlaceholder] =
    useState("Ask anything.");
  useEffect(() => {
    if (authStatus.loading) return;
    if (greetingChoiceRef.current === null) {
      greetingChoiceRef.current = Math.floor(Math.random() * 1_000_000);
    }
    const choice = greetingChoiceRef.current;
    const name =
      nameOverride ?? authStatus.preferredName ?? authStatus.derivedName ?? null;
    setWelcomeGreeting(
      greetingForContext(
        {
          name,
          localHour: new Date().getHours(),
          returningUser: authStatus.authenticated,
        },
        choice,
      ),
    );
    setEmptyComposerPlaceholder(composerPlaceholderForIndex(choice + 1));
  }, [
    authStatus.authenticated,
    authStatus.derivedName,
    authStatus.loading,
    authStatus.preferredName,
    nameOverride,
  ]);
'''
    replace_once(path, old, new, "member greeting engine")

    replace_once(
        path,
        '''                <div className="flex w-full flex-1 min-h-0 items-end justify-center pb-14 animate-fade-in px-6">
                  <div className="w-full max-w-[960px] flex items-center justify-center gap-4">
                    <img
                      src="/logo_black.png"
                      alt="DeepTutor"
                      width={40}
                      height={40}
                      className="h-10 w-10 select-none"
                      draggable={false}
                    />
                    <h1 className="font-serif text-[40px] font-medium leading-[1.1] tracking-[-0.015em] text-[var(--foreground)]">
                      {t(welcomeGreeting)}
                    </h1>
                  </div>
                </div>
''',
        '''                <div className="flex w-full flex-1 min-h-0 items-end justify-center pb-14 animate-fade-in px-6">
                  <div className="w-full max-w-[960px]">
                    <div className="flex items-center justify-center gap-4 text-center">
                      <img
                        src="/logo_black.png"
                        alt="Murikah Tutor"
                        width={40}
                        height={40}
                        className="h-10 w-10 select-none"
                        draggable={false}
                      />
                      <h1 className="font-serif text-[40px] font-medium leading-[1.1] tracking-[-0.015em] text-[var(--foreground)]">
                        {welcomeGreeting}
                      </h1>
                    </div>
                    <MurikahNamePrompt
                      userId={authStatus.userId}
                      derivedName={authStatus.derivedName}
                      needsPrompt={authStatus.needsNamePrompt}
                      onSaved={(name) => setNameOverride(name)}
                    />
                  </div>
                </div>
''',
        "member greeting surface",
    )
    replace_once(
        path,
        '''                inputPlaceholder={askHint || undefined}
''',
        '''                inputPlaceholder={
                  askHint || (!hasMessages ? emptyComposerPlaceholder : undefined)
                }
''',
        "personalized empty composer placeholder",
    )


def patch_profile_settings(root: Path) -> None:
    path = root / "web/app/(utility)/profile/page.tsx"
    replace_once(
        path,
        '''import { formatDate, type Language } from "@/lib/datetime";
''',
        '''import { formatDate, type Language } from "@/lib/datetime";
import { MurikahPreferredNameSettings } from "@/components/auth/MurikahPreferredName";
''',
        "profile preferred-name import",
    )
    replace_once(
        path,
        '''  const [error, setError] = useState<string | null>(null);
''',
        '''  const [error, setError] = useState<string | null>(null);
  const [preferredName, setPreferredName] = useState<string | null>(null);
  const [derivedName, setDerivedName] = useState<string | null>(null);
''',
        "profile personalization state",
    )
    replace_once(
        path,
        '''      if (!status.authenticated) {
        router.replace("/login");
        return;
      }
      try {
''',
        '''      if (!status.authenticated) {
        router.replace("/login");
        return;
      }
      setPreferredName(
        typeof status.preferred_name === "string" && status.preferred_name.trim()
          ? status.preferred_name
          : null,
      );
      setDerivedName(
        typeof status.derived_name === "string" && status.derived_name.trim()
          ? status.derived_name
          : null,
      );
      try {
''',
        "profile personalization bootstrap",
    )
    replace_once(
        path,
        '''            {/* Avatar card */}
''',
        '''            <MurikahPreferredNameSettings
              initialPreferredName={preferredName}
              initialDerivedName={derivedName}
            />

            {/* Avatar card */}
''',
        "profile preferred-name settings",
    )


def patch_stream_and_persistence(root: Path) -> None:
    stream = root / "deeptutor/runtime/stream_bus.py"
    replace_once(
        stream,
        '''from deeptutor.core.trace import merge_trace_metadata
''',
        '''from deeptutor.core.trace import merge_trace_metadata
from deeptutor.murikah_visible_text import sanitize_murikah_visible_text
''',
        "stream visible-text import",
    )
    replace_once(
        stream,
        '''        if self._closed:
            return
        if self._assign_seq:
''',
        '''        if self._closed:
            return
        if event.content:
            event.content = sanitize_murikah_visible_text(event.content)
        if event.type == StreamEventType.RESULT and isinstance(event.metadata, dict):
            response = event.metadata.get("response")
            if isinstance(response, str):
                event.metadata = {
                    **event.metadata,
                    "response": sanitize_murikah_visible_text(response),
                }
        if self._assign_seq:
''',
        "stream pre-paint sanitizer",
    )

    shared = root / "deeptutor/services/session/_turn_runtime_shared.py"
    replace_once(
        shared,
        '''from deeptutor.core.stream import StreamEvent, StreamEventType
''',
        '''from deeptutor.core.stream import StreamEvent, StreamEventType
from deeptutor.murikah_visible_text import sanitize_murikah_visible_text
''',
        "persisted visible-text import",
    )
    replace_once(
        shared,
        '''    return clean_thinking_tags(
        "".join(
            text
            for call_id, text in content_segments
            if not (call_id and call_id in narration_call_ids)
        )
    )
''',
        '''    return sanitize_murikah_visible_text(
        clean_thinking_tags(
            "".join(
                text
                for call_id, text in content_segments
                if not (call_id and call_id in narration_call_ids)
            )
        )
    )
''',
        "persisted assistant sanitizer",
    )

    pipeline = root / "deeptutor/agents/loop/pipeline.py"
    replace_once(
        pipeline,
        '''from deeptutor.core.context import UnifiedContext
''',
        '''from deeptutor.core.context import UnifiedContext
from deeptutor.murikah_visible_text import MURIKAH_VISIBLE_STYLE_RULE
''',
        "chat style-rule import",
    )
    replace_once(
        pipeline,
        '''        system_prompt = self._build_system_prompt(
            enabled_tools,
            context,
            include_tool_manifest=include_tool_manifest,
        )
''',
        '''        system_prompt = self._build_system_prompt(
            enabled_tools,
            context,
            include_tool_manifest=include_tool_manifest,
        )
        system_prompt = (
            system_prompt
            + "\\n\\n[Visible style]\\n"
            + MURIKAH_VISIBLE_STYLE_RULE
        )
''',
        "chat visible-style instruction",
    )


def patch_guest_runtime(root: Path) -> None:
    guest = root / "deeptutor/api/routers/murikah_guest.py"
    replace_once(
        guest,
        '''from deeptutor.services.model_selection.runtime import resolve_llm_config_for_selection
''',
        '''from deeptutor.services.model_selection.runtime import resolve_llm_config_for_selection
from deeptutor.murikah_visible_text import (
    MURIKAH_VISIBLE_STYLE_RULE,
    sanitize_murikah_visible_text,
)
''',
        "guest visible-text import",
    )
    replace_once(
        guest,
        '''            "content": _system_prompt(body.mode, body.space, body.configuration, body.persona),
''',
        '''            "content": (
                _system_prompt(body.mode, body.space, body.configuration, body.persona)
                + "\\n\\n"
                + MURIKAH_VISIBLE_STYLE_RULE
            ),
''',
        "guest visible-style instruction",
    )
    replace_once(
        guest,
        '''        yield first_chunk
''',
        '''        yield sanitize_murikah_visible_text(first_chunk)
''',
        "guest first streamed chunk sanitizer",
    )
    replace_once(
        guest,
        '''                yield text
''',
        '''                yield sanitize_murikah_visible_text(text)
''',
        "guest streamed chunk sanitizer",
    )


def patch_guest_personalization(root: Path) -> None:
    path = root / "web/components/chat/MurikahGuestChat.tsx"
    replace_once(
        path,
        '''import MurikahInviteFriends from "@/components/auth/MurikahInviteFriends";
''',
        '''import MurikahInviteFriends from "@/components/auth/MurikahInviteFriends";
import {
  composerPlaceholderForIndex,
  greetingForContext,
} from "@/lib/murikah-personalization";
''',
        "guest greeting imports",
    )
    replace_once(
        path,
        '''  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>([]);
''',
        '''  const router = useRouter();
  const [guestGreeting, setGuestGreeting] = useState("What's on your mind?");
  const [guestComposerPlaceholder, setGuestComposerPlaceholder] =
    useState("Ask anything.");
  const [messages, setMessages] = useState<Message[]>([]);
''',
        "guest greeting state",
    )
    replace_once(
        path,
        '''  const ActiveSpaceIcon = activeSpace.icon;
''',
        '''  const ActiveSpaceIcon = activeSpace.icon;

  useEffect(() => {
    const choice = Math.floor(Math.random() * 1_000_000);
    setGuestGreeting(
      greetingForContext(
        { localHour: new Date().getHours(), returningUser: false },
        choice,
      ),
    );
    setGuestComposerPlaceholder(composerPlaceholderForIndex(choice + 1));
  }, []);
''',
        "guest stable greeting selection",
    )
    guest_text = path.read_text(encoding="utf-8")
    home_marker = 'messages.length === 0 && spaceId === "home"'
    home_start = guest_text.find(home_marker)
    if home_start < 0:
        raise RuntimeError("Guest home-view marker was not found")
    heading_start = guest_text.find("<h1", home_start)
    heading_open_end = guest_text.find(">", heading_start)
    heading_close = guest_text.find("</h1>", heading_open_end)
    if (
        heading_start < 0
        or heading_open_end < 0
        or heading_close < 0
        or heading_close - heading_start > 2500
    ):
        raise RuntimeError("Guest home-view heading was not found near its stable state marker")
    guest_text = (
        guest_text[: heading_open_end + 1]
        + "{guestGreeting}"
        + guest_text[heading_close:]
    )
    path.write_text(guest_text, encoding="utf-8")
    replace_once(
        path,
        '''                    placeholder={composerPlaceholder}
''',
        '''                    placeholder={
                      messages.length === 0 && spaceId === "home"
                        ? guestComposerPlaceholder
                        : composerPlaceholder
                    }
''',
        "guest varied composer placeholder",
    )
    guest_text = path.read_text(encoding="utf-8")
    visible_answer_source = "        const visibleAnswer = answer;\n"
    visible_answer_target = (
        "        const visibleAnswer = sanitizeTutorVisibleText(answer);\n"
    )
    visible_answer_count = guest_text.count(visible_answer_source)
    if visible_answer_count != 2:
        raise RuntimeError(
            "Expected two guest accumulated-answer boundaries in "
            f"{path}, found {visible_answer_count}"
        )
    path.write_text(
        guest_text.replace(visible_answer_source, visible_answer_target),
        encoding="utf-8",
    )


def sanitize_runtime_web_source(root: Path) -> None:
    web = root / "web"
    utility = web / "lib/murikah-personalization.ts"
    for path in web.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in RUNTIME_SUFFIXES:
            continue
        if path == utility:
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        updated = text.replace(" " + EM_DASH + " ", "; ").replace(EM_DASH, ", ")
        updated = ENTITY_RE.sub("; ", updated)
        if updated != text:
            path.write_text(updated, encoding="utf-8")


def validate_no_em_dash_in_runtime_ui(root: Path) -> None:
    web = root / "web"
    utility = web / "lib/murikah-personalization.ts"
    failures: list[str] = []
    for path in web.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in RUNTIME_SUFFIXES:
            continue
        if any(part in {"node_modules", ".next", "tests", "test", "__snapshots__"} for part in path.parts):
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        patterns = (EM_DASH,) if path == utility else (EM_DASH, "&mdash;", "&#8212;", "&#x2014;")
        for line_no, line in enumerate(text.splitlines(), start=1):
            if any(pattern.lower() in line.lower() for pattern in patterns):
                failures.append(f"{path.relative_to(root)}:{line_no}: {line.strip()[:180]}")
    if failures:
        raise RuntimeError(
            "Murikah Tutor runtime UI contains forbidden em-dash text:\\n"
            + "\\n".join(failures[:100])
        )


def main(root: Path, overlay: Path) -> None:
    copy_personalization_sources(root, overlay)
    patch_auth_bootstrap(root)
    patch_auth_frontend(root)
    patch_chat_display_sanitizer(root)
    patch_member_chat(root)
    patch_profile_settings(root)
    patch_stream_and_persistence(root)
    patch_guest_runtime(root)
    patch_guest_personalization(root)
    sanitize_runtime_web_source(root)
    validate_no_em_dash_in_runtime_ui(root)
    print("Applied Murikah Tutor personalization and visible-text policy.")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: apply_tutor_personalization.py <deeptutor-checkout> <overlay-dir>")
    main(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())
