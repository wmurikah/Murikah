#!/usr/bin/env python3
"""Apply after the legacy overlays; fail closed when the pinned contracts change."""
from pathlib import Path
import shutil
import sys


def replace(path, old, new):
    text = path.read_text()
    if text.count(old) != 1:
        raise RuntimeError(f"Expected one workspace access anchor in {path}: {old[:100]}")
    path.write_text(text.replace(old, new, 1))


def main(root, overlay):
    for source, target in {
        "murikah_access.py": "deeptutor/murikah_access.py",
        "murikah_email_verification.py": "deeptutor/murikah_email_verification.py",
        "disposable_email_domains.txt": "deeptutor/disposable_email_domains.txt",
        "MurikahWorkspaceEntry.tsx.txt": "web/app/page.tsx",
        "MurikahGuestBanner.tsx.txt": "web/components/auth/MurikahGuestBanner.tsx",
        "MurikahAccountPage.tsx.txt": "web/components/auth/MurikahAccountPage.tsx",
        "MurikahInviteFriends.tsx.txt": "web/components/auth/MurikahInviteFriends.tsx",
    }.items():
        shutil.copy2(overlay / source, root / target)
    for page in ("login", "register"):
        (root / f"web/app/(auth)/{page}/page.tsx").write_text(
            'import MurikahAccountPage from "@/components/auth/MurikahAccountPage";\n'
            f'export default function Page() {{ return <MurikahAccountPage signup={{{str(page == "register").lower()}}} />; }}\n'
        )
    proxy = root / "web/proxy.ts"
    replace(proxy, 'loginUrl.pathname = LOGIN_PATH;', 'loginUrl.pathname = "/";')
    layout = root / "web/components/layout/AppShell.tsx"
    replace(layout, 'import Image from "next/image";', 'import Image from "next/image";\nimport MurikahGuestBanner from "@/components/auth/MurikahGuestBanner";')
    replace(layout, '<main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--background)]">', '<main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--background)]">\n          <MurikahGuestBanner />')
    # Guests and members share this message component and the existing branch editor.
    # Keep the action visible without hover so touch users can discover it too.
    messages = root / "web/features/chat/messages/ChatMessageList.tsx"
    replace(messages,
        'className="flex h-7 items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"',
        'className="flex min-h-9 items-center justify-end gap-1"')
    replace(messages, '''              <RoughActionButton
                icon={Pencil}
                label={t("Edit")}
                onClick={startEdit}
              />''', '''              <button
                type="button"
                onClick={startEdit}
                className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md px-2 text-xs text-[var(--muted-foreground)] hover:bg-[var(--muted)]/50 hover:text-[var(--foreground)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                <Pencil size={15} strokeWidth={1.5} aria-hidden="true" />
                {t("Edit")}
              </button>''')
    main_py = root / "deeptutor/api/main.py"
    # Imported here after auth/router modules, avoiding initialization cycles.
    replace(main_py, '# Auth router is public — login/logout/register/status require no token',
        'from deeptutor.murikah_access import router as access_router, GuestBudgetMiddleware\n'
        'app.include_router(access_router, prefix="/api/murikah/access", tags=["murikah-access"])\n'
        'app.add_middleware(GuestBudgetMiddleware)\n\n'
        '# Auth router is public — login/logout/register/status require no token')
    auth = root / "deeptutor/services/auth.py"
    replace(auth, '        device_credential_id = str(payload.get("dcid") or "")',
        '        # Guest JWTs are revoked by signup/rename and expire with their ledger.\n'
        '        if str(username).startswith("guest_"):\n'
        '            record = _load_users().get(str(username))\n'
        '            if not record or record.get("id") != user_id or record.get("disabled"):\n'
        '                return None\n'
        '        device_credential_id = str(payload.get("dcid") or "")')
    service = root / "deeptutor/app/service.py"
    replace(service, 'from .contracts import TurnRequest', 'from .contracts import TurnRequest\nfrom deeptutor.murikah_access import guest_prompt')
    for name in ("start_turn", "regenerate_last_turn"):
        replace(service, f'    async def {name}(', f'    @guest_prompt\n    async def {name}(')
    # Old guest endpoint must never offer a second unmetered allowance.
    guest = root / "deeptutor/api/routers/murikah_guest.py"
    replace(guest, '    used = _read_count(mt_guest)\n    limit = _limit()\n    if used >= limit:',
        '    raise HTTPException(status_code=410, detail="Reload Tutor to open your full guest workspace.")\n'
        '    used = _read_count(mt_guest)\n    limit = _limit()\n    if used >= limit:')
    fast = root / "deeptutor/murikah_fast_lane.py"
    replace(fast, '            stream = candidate.factory()', '            stream = validated_stream(candidate.factory())')
    replace(fast, '                text = _gemini_text(event)',
        '                if event.get("error"):\n'
        '                    raise RuntimeError("Tutor provider is temporarily unavailable. Please try again.")\n'
        '                text = _gemini_text(event)')
    with fast.open("a") as output:
        output.write('''

async def validated_stream(source):
    """Reject serialized provider errors, including prefixes split over tokens.

    Keep ambiguous error prefixes buffered until they can be classified. This
    filter stays around the winning stream, not just its first token.
    """
    pending = ""
    prefixes = ("error:", "error calling llm:", "llm call failed:", '{"error":', "{'error':")
    try:
        async for chunk in source:
            text = str(chunk or "")
            if not text:
                continue
            # Finish metadata is an internal control frame, not learner text.
            # Flush any ambiguous buffered content first so the sentinel cannot
            # be concatenated into a JSON/code fragment and leak to the UI.
            if parse_finish_signal(text) is not None:
                if pending:
                    yield pending
                    pending = ""
                yield text
                continue
            pending += text
            normalized = pending.lstrip().lower()
            if not normalized:
                continue
            if any(prefix.startswith(normalized) for prefix in prefixes):
                continue
            if any(normalized.startswith(prefix) for prefix in prefixes):
                raise RuntimeError("Tutor is temporarily unavailable. Please try again.")
            if normalized.startswith(("{", "[")) and len(pending) < 512:
                if "overloaded" in normalized or '"code":529' in normalized.replace(" ", ""):
                    raise RuntimeError("Tutor is temporarily unavailable. Please try again.")
                if "}" not in pending and "]" not in pending:
                    continue
            yield pending
            pending = ""
        if pending.strip():
            normalized = pending.lstrip().lower()
            if any(prefix.startswith(normalized) or normalized.startswith(prefix) for prefix in prefixes):
                raise RuntimeError("Tutor is temporarily unavailable. Please try again.")
            yield pending
    finally:
        await close_stream(source)
''')
    print("Applied full guest workspace, shared prompt budget and public signup.")


if __name__ == "__main__":
    main(Path(sys.argv[1]).resolve(), Path(__file__).resolve().parent)
