"""Regression coverage for verified-email signup and voluntary guest auth."""
from pathlib import Path
import asyncio
import importlib.util
import unittest


ROOT = Path(__file__).resolve().parents[1]


def source(relative: str) -> str:
    path = ROOT / relative
    return path.read_text(encoding="utf-8") if path.exists() else ""


class VerifiedEmailSignupTests(unittest.TestCase):
    def test_email_helper_blocks_disposable_and_accepts_known_domains(self):
        module_path = ROOT / "railway/murikah_email_verification.py"
        spec = importlib.util.spec_from_file_location("muri_email_verification", module_path)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        self.assertTrue(module.MURIKAH_VERIFIED_EMAIL_V1)
        self.assertTrue(module._is_disposable("mailinator.com"))
        self.assertTrue(module._is_disposable("sub.mailinator.com"))
        self.assertEqual(
            asyncio.run(module.validate_signup_email("Student@Gmail.com")),
            "student@gmail.com",
        )
        self.assertEqual(
            asyncio.run(
                module.validate_signup_email("relay@privaterelay.appleid.com")
            ),
            "relay@privaterelay.appleid.com",
        )

    def test_blocklist_is_substantial(self):
        blocklist = ROOT / "railway/disposable_email_domains.txt"
        self.assertTrue(blocklist.exists())
        rows = [
            row.strip()
            for row in blocklist.read_text(encoding="utf-8").splitlines()
            if row.strip() and not row.lstrip().startswith("#")
        ]
        self.assertGreater(len(rows), 5000)
        self.assertIn("mailinator.com", rows)

    def test_local_signup_does_not_issue_member_session_before_verification(self):
        access = source("railway/murikah_access.py")
        start = access.index('@router.post("/signup", status_code=202)')
        verify = access.index('@router.post("/signup/verify", status_code=201)')
        resend = access.index('@router.post("/email/resend")')
        start_block = access[start:verify]
        verify_block = access[verify:resend]

        self.assertIn("start_challenge(", start_block)
        self.assertIn('"verification_required": True', start_block)
        self.assertNotIn("set_session(", start_block)
        self.assertNotIn("identity._write_users", start_block)

        self.assertIn("verify_challenge(", verify_block)
        self.assertIn("identity._write_users", verify_block)
        self.assertIn("set_session(response, email, record", verify_block)
        self.assertIn("email_verified_at=verified_at", verify_block)

    def test_existing_sso_identity_bypasses_new_account_verification(self):
        oauth = source("railway/murikah_oauth.py")
        self.assertIn("def _existing_social_username(", oauth)
        start = oauth.index("async def _login_or_verify_redirect(")
        end = oauth.index("\n\ndef _error_redirect(", start)
        block = oauth[start:end]
        self.assertIn("if existing:", block)
        self.assertIn("return _session_redirect(existing, next_path)", block)
        self.assertIn('purpose="social_signup"', block)
        self.assertIn("_PENDING_COOKIE", block)
        self.assertIn('@router.post("/verify-email")', oauth)
        self.assertIn("email_verified_at=verified_at", oauth)

    def test_d1_challenge_stores_digest_not_plaintext_code(self):
        migration = source("cloudflare/migrations/0005_tutor_email_verification.sql")
        if not migration:
            return
        self.assertIn("CREATE TABLE IF NOT EXISTS tutor_email_verifications", migration)
        self.assertIn("code_digest TEXT NOT NULL", migration)
        self.assertNotIn(" code TEXT", migration)
        self.assertIn("email_verified_at INTEGER", migration)
        self.assertIn("email_verification_schema_version", migration)

    def test_worker_enforces_expiry_attempts_rate_limits_and_resend_cooldown(self):
        worker = source("cloudflare/src/index.ts")
        if not worker:
            return
        for marker in (
            "EMAIL_CODE_TTL_SECONDS = 10 * 60",
            "EMAIL_RESEND_SECONDS = 60",
            "EMAIL_MAX_ATTEMPTS = 5",
            "EMAIL_MAX_SENDS = 3",
            "verification_rate_limited",
            "verification_resend_cooldown",
            "code_digest",
            "sendVerificationEmail",
            "RESEND_API_KEY",
        ):
            self.assertIn(marker, worker)

    def test_missing_resend_key_does_not_block_worker_deploy_or_bypass_verification(self):
        wrangler = source("cloudflare/wrangler.toml")
        required_block = wrangler.split("[secrets]", 1)[1].split("[[d1_databases]]", 1)[0]
        self.assertNotIn('"RESEND_API_KEY"', required_block)
        self.assertIn("RESEND_API_KEY is intentionally not deploy-required", wrangler)

        worker = source("cloudflare/src/index.ts")
        self.assertIn(
            "if (!apiKey) throw new Error('verification_email_not_configured')",
            worker,
        )
        self.assertIn("verification_email_unavailable", worker)

    def test_invite_and_guest_voluntary_auth_surfaces_exist(self):
        invite = source("railway/MurikahInviteFriends.tsx.txt")
        guest = source("railway/MurikahGuestChatV2.tsx.txt")
        polished = source("railway/polish_guest_shell.py")
        account = source("railway/MurikahAccountPage.tsx.txt")
        entry = source("railway/MurikahWorkspaceEntry.tsx.txt")

        self.assertIn("Invite friends to Murikah Tutor", invite)
        self.assertIn("mailto:?subject=", invite)
        self.assertIn("https://wa.me/?text=", invite)
        self.assertIn("navigator.share", invite)
        self.assertIn("const SIGN_UP =", guest)
        self.assertIn("href={SIGN_UP}", polished)
        self.assertIn("<MurikahInviteFriends", polished)
        self.assertIn("<MurikahInviteFriends />", account)
        self.assertIn('href="/login?next=%2Fchat"', entry)
        self.assertIn('href="/register?next=%2Fchat"', entry)


if __name__ == "__main__":
    unittest.main()
