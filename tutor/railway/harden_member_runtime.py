#!/usr/bin/env python3
"""Harden member auth, chat scrolling, and first-attempt Deep Solve recovery."""
from __future__ import annotations

from pathlib import Path
import sys


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"Expected one {label} in {path}, found {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def patch_member_session_refresh(root: Path) -> None:
    path = root / "deeptutor/api/routers/auth.py"
    replace_once(
        path,
        '''async def auth_status(
    authorization: str | None = Header(default=None, alias="Authorization"),
    dt_token: str | None = Cookie(default=None, alias=_COOKIE_NAME),
) -> AuthStatusResponse:
''',
        '''async def auth_status(
    response: Response,
    authorization: str | None = Header(default=None, alias="Authorization"),
    dt_token: str | None = Cookie(default=None, alias=_COOKIE_NAME),
) -> AuthStatusResponse:
''',
        "auth-status response injection",
    )
    replace_once(
        path,
        '''    payload = decode_token(token) if token else None
    avatar = ""
''',
        '''    payload = decode_token(token) if token else None
    # Member sessions are sliding: every normal auth-status read renews the
    # signed cookie. Guest workspaces keep their bounded guest-session policy
    # and explicit logout still deletes the cookie immediately.
    if (
        payload is not None
        and not str(payload.username).startswith("guest_")
        and not POCKETBASE_ENABLED
    ):
        response.set_cookie(
            value=create_token(payload.username, payload.role, payload.user_id),
            max_age=_COOKIE_MAX_AGE,
            **_cookie_attrs(),
        )
        response.headers["Cache-Control"] = "no-store"
    avatar = ""
''',
        "sliding member cookie refresh",
    )


def patch_app_shell_scroll(root: Path) -> None:
    path = root / "web/components/layout/AppShell.tsx"
    replace_once(
        path,
        '''          <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
''',
        '''          <div
            className={
              pathname === "/diagram-design"
                ? "min-h-0 flex-1 overflow-y-auto overscroll-y-contain touch-pan-y"
                : "min-h-0 flex-1 overflow-hidden"
            }
          >
            {children}
          </div>
''',
        "workspace page scroll owner",
    )


def patch_chat_scroll(root: Path) -> None:
    path = root / "web/hooks/useChatAutoScroll.ts"
    replace_once(
        path,
        '''  const shouldAutoScrollRef = useRef(true);

  const pinToBottom = useCallback(() => {
''',
        '''  const shouldAutoScrollRef = useRef(true);
  const lastObservedScrollTopRef = useRef(0);

  const pinToBottom = useCallback(() => {
''',
        "chat previous-scroll tracking",
    )
    replace_once(
        path,
        '''  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    shouldAutoScrollRef.current = distanceFromBottom < 80;
  }, []);
''',
        '''  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const current = container.scrollTop;
    const previous = lastObservedScrollTopRef.current;
    lastObservedScrollTopRef.current = current;

    // Position is a stronger signal than the 80px threshold: as soon as the
    // reader actually moves upward, release the live-bottom pin. This covers
    // scrollbar-thumb drags, PageUp/Home and trackpads as well as wheel/touch,
    // so a long transcript never feels as though scrolling has frozen.
    if (current < previous - 1) {
      shouldAutoScrollRef.current = false;
      return;
    }
    const distanceFromBottom =
      container.scrollHeight - current - container.clientHeight;
    if (distanceFromBottom < 80) {
      shouldAutoScrollRef.current = true;
    }
  }, []);
''',
        "chat upward-scroll release",
    )

    workspace = root / "web/features/chat/components/ChatWorkspace.tsx"
    replace_once(
        workspace,
        '''className={`w-full flex-1 min-h-0 overflow-y-auto [scrollbar-gutter:stable_both-edges] ${hasMessages ? "pt-6" : "pt-2 pb-6"}`}
''',
        '''className={`w-full flex-1 min-h-0 overflow-y-auto overscroll-y-contain touch-pan-y [scrollbar-gutter:stable_both-edges] ${hasMessages ? "pt-6" : "pt-2 pb-6"}`}
''',
        "chat scroll-root touch/overscroll policy",
    )


def patch_deep_solve_repair(root: Path) -> None:
    path = root / "deeptutor/agents/loop/agent_loop.py"
    old = '''        if not final_text and not allow_empty:
            # The finish round produced no usable text; nothing streamed to
            # the user, so emit a fallback answer here.
            final_text = self.pipeline._t(
                "notices.empty_final_response",
                default=(
                    "I could not produce a useful response from the model "
                    "output. Please try again or narrow the request."
                ),
            )
            await self.pipeline._emit_protocol_fallback_final_response(self.stream, final_text)
'''
    new = '''        if (
            not final_text
            and not allow_empty
            and bool(self.context.metadata.get("solve_mode"))
            and not bool(self.context.metadata.get("_murikah_solve_repair_attempted"))
        ):
            # Deep Solve is expensive and users should not have to press Retry
            # after a long multi-step run just because the final round spent
            # its budget on reasoning. Perform one hidden, tool-less settlement
            # call using the work already gathered, then publish only if it
            # contains a real user-facing solution.
            self.context.metadata["_murikah_solve_repair_attempted"] = True
            repair_messages = (
                list(self._last_request.messages)
                if self._last_request is not None
                else self.pipeline._build_loop_messages(
                    context=self.context,
                    enabled_tools=[],
                    include_tool_manifest=False,
                )
            )
            self._append_loop_instruction(
                repair_messages,
                (
                    "The solve work is complete but the learner-facing answer "
                    "was empty. Do not call tools and do not restart the analysis. "
                    "Using the work already gathered, write the final direct "
                    "solution now. Show the useful steps, state assumptions, and "
                    "finish with the answer or recommendation. Do not expose "
                    "private chain-of-thought."
                ),
            )
            await self.stream.progress(
                "Finishing the solution…",
                source=self.source,
                stage=self.stage,
                metadata={"trace_kind": "progress", "murikah_internal_repair": True},
            )
            try:
                repair = await self._call_llm(
                    messages=repair_messages,
                    label="Final solution",
                    call_kind="solve_final_repair",
                    trace_role="response",
                    max_tokens=self.pipeline.loop_max_tokens,
                    tool_schemas=None,
                    defer_visible_output=True,
                )
                repaired = self._clean(repair.text)
                if repaired:
                    await self._release_deferred_output(repair)
                    final_text = repaired
                    provider_response_state = _provider_response_state(
                        repair.response_output_items,
                        repair.reasoning_content,
                        repair.thinking_blocks,
                    )
                else:
                    await self._discard_deferred_output(repair)
            except Exception as exc:
                logger.warning("Murikah solve final repair failed: %s", type(exc).__name__)

        if not final_text and not allow_empty:
            # Only after the hidden repair has also failed do we surface the
            # generic fallback. Ordinary successful solves never see it.
            final_text = self.pipeline._t(
                "notices.empty_final_response",
                default=(
                    "Murikah could not finish this solution right now. "
                    "Please try the prompt again."
                ),
            )
            await self.pipeline._emit_protocol_fallback_final_response(self.stream, final_text)
'''
    replace_once(path, old, new, "Deep Solve hidden final repair")


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: harden_member_runtime.py <deeptutor-root>")
    root = Path(sys.argv[1]).resolve()
    patch_member_session_refresh(root)
    patch_app_shell_scroll(root)
    patch_chat_scroll(root)
    patch_deep_solve_repair(root)
    print(
        "[Murikah Tutor] Sliding member auth, free history scrolling and "
        "first-attempt Deep Solve repair enabled."
    )


if __name__ == "__main__":
    main()
