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
- enables Tutor authentication before the first browser session;
- removes the one-time bootstrap container after authentication is created so the plaintext bootstrap password is not kept in the long-running container configuration; and
- automatically resumes Tutor after an established Codespace is stopped and started again.

## Create the Codespace

1. Open `wmurikah/Murikah` on GitHub.
2. Select **Code** → **Codespaces**.
3. Open the Codespaces creation options.
4. Choose the dev container configuration named **Murikah Tutor** (`.devcontainer/murikah-tutor/devcontainer.json`).
5. Prefer the smallest available machine initially to conserve included Codespaces core-hours.
6. Create the Codespace.

Do not use the repository's default Codespaces configuration for Tutor. The **Murikah Tutor** configuration is the one that supplies Docker and automatically forwards port `3782`.

## First start

In a brand-new Codespace, run once:

```bash
bash tutor/codespaces/start.sh
```

On first start you will be prompted for:

- an administrator username (defaults to `admin`); and
- a strong password of at least 14 characters.

The password is not written to the repository or a `.env` file. The application stores only its bcrypt authentication state in the persistent Tutor data directory.

The first image build can take materially longer than later starts because the Codespace must pull and build DeepTutor dependencies.

## Automatic resume

After first-boot authentication exists, the Murikah Tutor dev-container runs:

```bash
bash tutor/codespaces/autostart.sh
```

as its `postStartCommand` whenever the Codespace starts or resumes.

The resume hook is deliberately non-interactive:

- if Tutor is already running, it leaves it running;
- if the Docker container exists but is stopped, it starts it;
- if the container is missing but the image remains, it recreates the container against the persisted data directory;
- if Docker objects were lost but persisted Tutor data remains, it rebuilds the pinned image and recreates the container; and
- if first-boot authentication has never been configured, it does not prompt or hang — it tells the operator to run `start.sh` manually.

This removes the need to run `start.sh` after ordinary Codespace stop/start cycles. It does **not** prevent GitHub from suspending an idle Codespace; it only restores Tutor automatically when that Codespace is resumed.

### Existing Codespaces after this feature is merged

An existing Codespace must reload the updated dev-container configuration once so GitHub registers the new `postStartCommand`.

After pulling the updated `main` branch, use the Command Palette and choose **Codespaces: Rebuild Container**. Runtime data under `tutor/.codespaces-data` is inside the `/workspaces` tree and is intended to survive that rebuild.

## Open Tutor

When the launcher reports that Tutor is healthy:

1. open the **PORTS** tab;
2. find **Murikah Tutor** on port `3782`; and
3. open its forwarded URL.

GitHub Codespaces makes forwarded ports private by default. Keep port `3782` private while testing alone.

If you need to demonstrate Tutor to someone else temporarily, change port `3782` visibility to **Public** from the PORTS tab and share the generated `app.github.dev` URL. Anyone who has that public URL can reach the web service, so Tutor authentication must remain enabled.

Never expose port `8001` publicly.

## Manual stop and restart

To stop Tutor without deleting its data, run:

```bash
bash tutor/codespaces/stop.sh
```

An explicit manual stop creates a small marker under the ignored Tutor data directory so automatic resume remains disabled on future Codespace starts.

To start Tutor again and re-enable automatic resume, run:

```bash
bash tutor/codespaces/start.sh
```

## Codespaces idle timeout and quota

Stop the Codespace itself from GitHub when you are finished. Codespaces consumes compute while it is running, including idle time before its timeout.

GitHub's personal Codespaces setting allows an idle timeout up to 240 minutes (4 hours). Even at the maximum, Codespaces remains test/demo infrastructure rather than an always-on host: once GitHub suspends the Codespace, the public forwarded URL is unavailable until the Codespace is resumed.

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
