#!/usr/bin/env python3
"""Hide account-only controls for anonymous guest workspaces."""
from pathlib import Path
import sys


def replace(path: Path, old: str, new: str) -> None:
    text = path.read_text(encoding="utf-8")
    if text.count(old) != 1:
        raise RuntimeError(f"Expected one guest-account UI anchor in {path}: {old[:120]}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def main(root: Path) -> None:
    logout = root / "web/components/auth/LogoutButton.tsx"
    replace(
        logout,
        'import { useRouter } from "next/navigation";\n',
        'import { useRouter } from "next/navigation";\nimport { useEffect, useState } from "react";\n',
    )
    replace(
        logout,
        'import { logout } from "@/lib/auth";\nimport { useAuthStatus } from "@/hooks/useAuthStatus";\n',
        'import { fetchAuthStatus, logout } from "@/lib/auth";\n',
    )
    replace(
        logout,
        '  const { t } = useTranslation();\n  const { enabled } = useAuthStatus();\n\n  if (!enabled) return null;\n',
        '''  const { t } = useTranslation();\n  const [visible, setVisible] = useState(false);\n\n  useEffect(() => {\n    let alive = true;\n    fetchAuthStatus().then((status) => {\n      if (!alive) return;\n      setVisible(\n        Boolean(\n          status?.enabled &&\n            status?.authenticated &&\n            !status.username?.startsWith("guest_"),\n        ),\n      );\n    });\n    return () => {\n      alive = false;\n    };\n  }, []);\n\n  if (!visible) return null;\n''',
    )

    profile_link = root / "web/components/auth/ProfileLink.tsx"
    replace(
        profile_link,
        '      if (next?.enabled && next?.authenticated) setStatus(next);',
        '      if (next?.enabled && next?.authenticated && !next.username?.startsWith("guest_")) setStatus(next);',
    )

    print("Hidden account profile/sign-out controls from guest workspaces.")


if __name__ == "__main__":
    main(Path(sys.argv[1]).resolve())
