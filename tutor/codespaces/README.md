# Murikah Tutor in GitHub Codespaces

This is a zero-cost testing path for **Murikah Tutor — AI-powered personalised learning** using GitHub Codespaces included usage.

It is for development, demos and evaluation. It is not the permanent production host for `tutor.murikah.com`.

## What it does

The Codespace uses the same `tutor/Dockerfile.railway` production image prepared for Murikah Tutor. It does not install DeepTutor dependencies into the existing Murikah Astro/Cloudflare/Turso application.

The Codespace:

- provides Docker through an isolated dev-container configuration;
- builds the pinned Murikah Tutor image;
- forwards only frontend port `3782`;
- keeps FastAPI port `8001` internal to the Tutor container;
- stores test state under `tutor/.codespaces-data` inside the persistent Codespaces workspace;
- enables Tutor authentication before the first browser session; and
- removes the one-time bootstrap container after authentication is created so the plaintext bootstrap password is not kept in the long-running container configuration.

## Create the Codespace

1. Open `wmurikah/Murikah` on GitHub.
2. Select **Code** → **Codespaces**.
3. Open the Codespaces creation options.
4. Choose the dev container configuration named **Murikah Tutor** (`.devcontainer/murikah-tutor/devcontainer.json`).
5. Prefer the smallest available machine initially to conserve included Codespaces core-hours.
6. Create the Codespace.

Do not use the repository's default Codespaces configuration for Tutor. The **Murikah Tutor** configuration is the one that supplies Docker and automatically forwards port `3782`.

## Start Tutor

In the Codespace terminal run:

```bash
bash tutor/codespaces/start.sh
```

On first start you will be prompted for:

- an administrator username (defaults to `admin`); and
- a strong password of at least 14 characters.

The password is not written to the repository or a `.env` file. The application stores only its bcrypt authentication state in the persistent Tutor data directory.

The first image build can take materially longer than later starts because the Codespace must pull and build DeepTutor dependencies.

## Open Tutor

When the launcher reports that Tutor is healthy:

1. open the **PORTS** tab;
2. find **Murikah Tutor** on port `3782`; and
3. open its forwarded URL.

GitHub Codespaces makes forwarded ports private by default. Keep port `3782` private while testing alone.

If you need to demonstrate Tutor to someone else temporarily, change port `3782` visibility to **Public** from the PORTS tab and share the generated `app.github.dev` URL. Anyone who has that public URL can reach the web service, so Tutor authentication must remain enabled.

Never expose port `8001` publicly.

## Stop Tutor and conserve quota

Run:

```bash
bash tutor/codespaces/stop.sh
```

Then stop the Codespace itself from GitHub when you are finished. Codespaces consumes compute while it is running, including idle time before its timeout.

The Codespace normally stops automatically after the configured idle timeout. GitHub's default is currently 30 minutes unless you change your personal setting.

## Persistence

Runtime state is stored at:

```text
tutor/.codespaces-data
```

This directory is under `/workspaces`, so it survives ordinary Codespace stop/start and dev-container rebuilds. It is ignored by Git and must never be committed.

Deleting the Codespace deletes its Codespaces storage. Treat this environment as disposable test infrastructure; do not put irreplaceable production data in it.

## Included usage

Codespaces is metered in core-hours rather than ordinary clock hours. Check **GitHub Settings → Billing and licensing → Codespaces** for your remaining included usage before long sessions.

A two-core Codespace consumes two core-hours for every hour that it is running. Stop the Codespace after testing rather than leaving it online as a permanent service.

## Production path later

This Codespaces path does not replace the production architecture. When budget or a suitable free long-running host is available, deploy the same Murikah Tutor container with persistent `/app/data` storage and then connect `tutor.murikah.com` through Cloudflare.
