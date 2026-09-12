# Murikah Tutor social sign-in

Murikah Tutor can expose Google, Microsoft and Apple as public account-creation/sign-in providers while keeping the existing local username/password login for administrators and manually managed accounts.

Provider credentials are runtime secrets. Do not commit them to this repository, `wrangler.toml`, Dockerfiles or Tutor data files.

## Public callback URLs

Configure the provider applications with these exact HTTPS callbacks:

- Google: `https://tutor.murikah.com/api/auth/oauth/google/callback`
- Microsoft: `https://tutor.murikah.com/api/auth/oauth/microsoft/callback`
- Apple: `https://tutor.murikah.com/api/auth/oauth/apple/callback`

The public base URL defaults to `https://tutor.murikah.com` and can be set explicitly with `MURIKAH_PUBLIC_BASE_URL`.

## Runtime secrets

Google:

- `MURIKAH_GOOGLE_CLIENT_ID`
- `MURIKAH_GOOGLE_CLIENT_SECRET`

Microsoft:

- `MURIKAH_MICROSOFT_CLIENT_ID`
- `MURIKAH_MICROSOFT_CLIENT_SECRET`
- `MURIKAH_MICROSOFT_TENANT` — optional; defaults to `common`

Apple:

- `MURIKAH_APPLE_CLIENT_ID` — Services ID / client identifier
- `MURIKAH_APPLE_TEAM_ID`
- `MURIKAH_APPLE_KEY_ID`
- one of:
  - `MURIKAH_APPLE_PRIVATE_KEY`
  - `MURIKAH_APPLE_PRIVATE_KEY_B64` — preferred for multiline `.p8` material in secret stores

Guest access:

- `MURIKAH_GUEST_PROMPT_LIMIT` — defaults to `7`, bounded by the server to 1–7

## Codespaces

Store provider credentials as GitHub **Codespaces secrets** scoped to `wmurikah/Murikah`. `tutor/codespaces/start.sh` and `autostart.sh` forward only provider variables that are present in the Codespace environment. Values are not written to Git.

After adding or changing provider secrets, recreate the Tutor container once with:

```bash
git pull origin main
bash tutor/codespaces/start.sh
```

A later Codespace resume reuses those container settings automatically. If Docker state is lost and the container is recreated, `autostart.sh` forwards the Codespaces secrets again.

## Account model

Social sign-in creates an ordinary Murikah Tutor user on first successful provider authentication. Provider subject identifiers are mapped to local user IDs under the persistent Tutor auth directory. A matching email address alone never auto-links an existing local account, so a social identity cannot silently take over an administrator account.

Password self-registration remains closed after the bootstrap administrator. `/register` routes users to the social-first sign-in page instead.

## Guest access boundary

Unauthenticated learners receive seven model interactions by default. The public shell exposes Murikah Tutor's learning modes and learning-space navigation so a new learner can understand and try the product before registration. The remaining allowance is deliberately not displayed in the interface; the account-creation gate appears only when the allowance is exhausted.

Guest learning modes use the configured LLM with mode-specific tutoring instructions. The guest surface still does **not** expose or persist DeepTutor sessions, tools, files, private knowledge bases, saved memory, workspace state, connected agents, Partners, or user settings. Those authenticated capabilities remain behind the normal account boundary.
