#!/usr/bin/env python3
"""Apply Murikah Tutor deployment/product additions to a pinned DeepTutor checkout."""
from __future__ import annotations

from pathlib import Path
import shutil
import sys


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(
            f"Expected exactly one Murikah overlay target in {path}, found {count}. "
            "The pinned upstream source may have changed."
        )
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def copy_required(source: Path, destination: Path) -> None:
    if not source.is_file():
        raise RuntimeError(f"Missing Murikah overlay source: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: apply_railway_overlay.py <deeptutor-checkout> <health-route.ts>", file=sys.stderr)
        return 2

    root = Path(sys.argv[1]).resolve()
    health_source = Path(sys.argv[2]).resolve()
    overlay = Path(__file__).resolve().parent
    if not (root / "web" / "lib" / "proxy-policy.ts").is_file():
        raise RuntimeError(f"Not a DeepTutor checkout: {root}")
    if not health_source.is_file():
        raise RuntimeError(f"Missing health route source: {health_source}")

    # Public frontend entry points: the root guest preview, auth pages and health
    # check must remain reachable without a dt_token. All actual DeepTutor
    # workspace pages remain behind the upstream auth gate.
    proxy_policy = root / "web" / "lib" / "proxy-policy.ts"
    replace_once(
        proxy_policy,
        '''    pathname.startsWith(LOGIN_PATH) ||\n    pathname.startsWith("/register") ||\n    pathname.startsWith("/_next") ||''',
        '''    pathname.startsWith(LOGIN_PATH) ||\n    pathname.startsWith("/register") ||\n    pathname === "/" ||\n    pathname === "/health" ||\n    pathname.startsWith("/_next") ||''',
    )

    health_dir = root / "web" / "app" / "health"
    health_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(health_source, health_dir / "route.ts")

    # Guest-first web experience. Remove the route-group root because Next.js
    # cannot have both /(workspace)/page.tsx and /page.tsx resolving to `/`.
    workspace_root = root / "web" / "app" / "(workspace)" / "page.tsx"
    if not workspace_root.is_file():
        raise RuntimeError("Pinned DeepTutor workspace root page is missing")
    workspace_root.unlink()
    copy_required(overlay / "murikah-entry-page.tsx", root / "web" / "app" / "page.tsx")
    copy_required(
        overlay / "MurikahGuestChat.tsx",
        root / "web" / "components" / "chat" / "MurikahGuestChat.tsx",
    )
    copy_required(
        overlay / "MurikahSocialButtons.tsx",
        root / "web" / "components" / "auth" / "MurikahSocialButtons.tsx",
    )
    copy_required(
        overlay / "murikah-login-page.tsx",
        root / "web" / "app" / "(auth)" / "login" / "page.tsx",
    )
    copy_required(
        overlay / "murikah-register-page.tsx",
        root / "web" / "app" / "(auth)" / "register" / "page.tsx",
    )

    # Public backend surfaces remain deliberately narrow: a stateless 3-prompt
    # LLM preview and social sign-in callbacks. DeepTutor's normal routers keep
    # their existing require_auth/require_admin dependencies.
    copy_required(
        overlay / "murikah_guest.py",
        root / "deeptutor" / "api" / "routers" / "murikah_guest.py",
    )
    copy_required(
        overlay / "murikah_oauth.py",
        root / "deeptutor" / "api" / "routers" / "murikah_oauth.py",
    )
    api_main = root / "deeptutor" / "api" / "main.py"
    replace_once(
        api_main,
        'from deeptutor.api.routers.multi_user import router as multi_user_router  # noqa: E402',
        '''from deeptutor.api.routers.murikah_guest import router as murikah_guest_router  # noqa: E402\nfrom deeptutor.api.routers.murikah_oauth import router as murikah_oauth_router  # noqa: E402\nfrom deeptutor.api.routers.multi_user import router as multi_user_router  # noqa: E402''',
    )
    replace_once(
        api_main,
        '''# Auth router is public — login/logout/register/status require no token\napp.include_router(auth.router, prefix="/api/auth", tags=["auth"])\napp.include_router(outputs.router, prefix="/files/outputs", tags=["outputs"])''',
        '''# Auth router is public — login/logout/register/status require no token\napp.include_router(auth.router, prefix="/api/auth", tags=["auth"])\napp.include_router(murikah_oauth_router, prefix="/api/auth/oauth", tags=["murikah-oauth"])\napp.include_router(murikah_guest_router, prefix="/api/murikah", tags=["murikah-guest"])\napp.include_router(outputs.router, prefix="/files/outputs", tags=["outputs"])''',
    )

    # Developer resources stay visible to administrators only. Ordinary users
    # get a non-interactive Apache-2.0 label instead of version/docs/GitHub
    # links, keeping the learner chrome focused on the product.
    sidebar = root / "web" / "components" / "sidebar" / "SidebarShell.tsx"
    replace_once(
        sidebar,
        'import { useDevice } from "@/hooks/useDevice";\nimport { VersionBadge } from "@/components/sidebar/VersionBadge";',
        'import { useDevice } from "@/hooks/useDevice";\nimport { useAuthStatus } from "@/hooks/useAuthStatus";\nimport { VersionBadge } from "@/components/sidebar/VersionBadge";',
    )
    replace_once(
        sidebar,
        '''  const { isMobile } = useDevice();\n  const drawer = useSidebarDrawer();\n  const recentsScrollRef = useRef<HTMLDivElement>(null);''',
        '''  const { isMobile } = useDevice();\n  const { isAdmin } = useAuthStatus();\n  const drawer = useSidebarDrawer();\n  const recentsScrollRef = useRef<HTMLDivElement>(null);''',
    )
    replace_once(
        sidebar,
        '''          <a\n            href={DOCS_URL}\n            target="_blank"\n            rel="noreferrer noopener"\n            title={t("Docs") as string}\n            aria-label={t("Docs") as string}\n            className="mt-1 flex h-9 w-9 items-center justify-center rounded-xl text-[var(--muted-foreground)]/70 transition-colors hover:bg-[var(--background)]/50 hover:text-[var(--foreground)]"\n          >\n            <BookText\n              size={15}\n              strokeWidth={1.8}\n              className="text-blue-600 dark:text-blue-400"\n            />\n          </a>\n          <GitHubMarkLink className="flex h-9 w-9 items-center justify-center rounded-xl text-[var(--muted-foreground)]/70 transition-colors hover:bg-[var(--background)]/50 hover:text-[var(--foreground)]" />\n          <VersionBadge collapsed />''',
        '''          {isAdmin && (\n            <>\n              <a\n                href={DOCS_URL}\n                target="_blank"\n                rel="noreferrer noopener"\n                title={t("Docs") as string}\n                aria-label={t("Docs") as string}\n                className="mt-1 flex h-9 w-9 items-center justify-center rounded-xl text-[var(--muted-foreground)]/70 transition-colors hover:bg-[var(--background)]/50 hover:text-[var(--foreground)]"\n              >\n                <BookText size={15} strokeWidth={1.8} className="text-blue-600 dark:text-blue-400" />\n              </a>\n              <GitHubMarkLink className="flex h-9 w-9 items-center justify-center rounded-xl text-[var(--muted-foreground)]/70 transition-colors hover:bg-[var(--background)]/50 hover:text-[var(--foreground)]" />\n            </>\n          )}\n          <VersionBadge collapsed />''',
    )
    replace_once(
        sidebar,
        '''          <VersionBadge />\n          <a\n            href={DOCS_URL}\n            target="_blank"\n            rel="noreferrer noopener"\n            title={t("Docs") as string}\n            aria-label={t("Docs") as string}\n            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)]/55 transition-colors hover:bg-[var(--background)]/50 hover:text-[var(--muted-foreground)]"\n          >\n            <BookText\n              size={15}\n              strokeWidth={1.9}\n              className="text-blue-600 dark:text-blue-400"\n            />\n          </a>\n          <GitHubMarkLink />''',
        '''          <VersionBadge />\n          {isAdmin && (\n            <>\n              <a\n                href={DOCS_URL}\n                target="_blank"\n                rel="noreferrer noopener"\n                title={t("Docs") as string}\n                aria-label={t("Docs") as string}\n                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)]/55 transition-colors hover:bg-[var(--background)]/50 hover:text-[var(--muted-foreground)]"\n              >\n                <BookText size={15} strokeWidth={1.9} className="text-blue-600 dark:text-blue-400" />\n              </a>\n              <GitHubMarkLink />\n            </>\n          )}''',
    )

    version_badge = root / "web" / "components" / "sidebar" / "VersionBadge.tsx"
    replace_once(
        version_badge,
        'import { useTranslation } from "react-i18next";\n',
        'import { useTranslation } from "react-i18next";\nimport { useAuthStatus } from "@/hooks/useAuthStatus";\n',
    )
    replace_once(
        version_badge,
        '''  const { t } = useTranslation();\n  const pathname = usePathname();''',
        '''  const { t } = useTranslation();\n  const { isAdmin } = useAuthStatus();\n  const pathname = usePathname();''',
    )
    replace_once(
        version_badge,
        '''  // Keep the collapsed sidebar entirely free of version chrome.\n  if (collapsed) return null;\n\n  const tag =''',
        '''  // Learners see only the non-interactive licence type; developer/update\n  // chrome remains an administrator concern.\n  if (!isAdmin) {\n    if (collapsed) return null;\n    return (\n      <span className="min-w-0 flex-1 px-3 py-1.5 text-[12px] font-medium text-[var(--muted-foreground)]" title="Licence: Apache-2.0">\n        Apache-2.0\n      </span>\n    );\n  }\n\n  // Keep the collapsed sidebar entirely free of version chrome.\n  if (collapsed) return null;\n\n  const tag =''',
    )

    print("Applied Murikah Tutor deployment and product overlay.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
