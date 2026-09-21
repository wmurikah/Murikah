"""Regression checks for an immediate guest-first root experience."""
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class GuestEntryTests(unittest.TestCase):
    def test_root_paints_chat_shell_without_auth_flash(self):
        source = (ROOT / "railway/MurikahWorkspaceEntry.tsx.txt").read_text(encoding="utf-8")
        self.assertIn("How can I help you learn today?", source)
        self.assertIn("Ask anything…", source)
        self.assertNotIn('href="/login"', source)
        self.assertNotIn('href="/register"', source)

    def test_guest_session_retries_transient_server_failure(self):
        source = (ROOT / "railway/MurikahWorkspaceEntry.tsx.txt").read_text(encoding="utf-8")
        self.assertIn("attempt < 2", source)
        self.assertIn("response.status < 500", source)
        self.assertIn('cache: "no-store"', source)

    def test_guest_workspace_keeps_voluntary_account_actions(self):
        access = (ROOT / "railway/MurikahGuestAccess.tsx.txt").read_text(encoding="utf-8")
        patch = (ROOT / "railway/apply_workspace_access.py").read_text(encoding="utf-8")
        guest_chat = (ROOT / "railway/MurikahGuestChatV2.tsx.txt").read_text(encoding="utf-8")

        self.assertIn('status.username?.startsWith("guest_")', access)
        self.assertIn('const SIGN_IN = "/login?next=%2Fchat"', access)
        self.assertIn('const SIGN_UP = "/register?next=%2Fchat"', access)
        self.assertIn("MurikahGuestAccess", patch)
        self.assertIn("<MurikahGuestAccess />", patch)
        self.assertIn('username?: string', guest_chat)
        self.assertIn(
            'auth?.authenticated && !auth.username?.startsWith("guest_")',
            guest_chat,
        )


if __name__ == "__main__":
    unittest.main()
