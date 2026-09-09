# Murikah Tutor in GitHub Codespaces

This is a zero-cost testing and demonstration path for **Murikah Tutor — AI-powered personalised learning** using GitHub Codespaces included usage.

It is not a permanently always-on production host. GitHub can still suspend the Codespace after its configured idle timeout.

## What it does

The Codespace uses the same `tutor/Dockerfile.railway` production image prepared for Murikah Tutor. It does not install DeepTutor dependencies into the existing Murikah Astro/Cloudflare/Turso application.

The Codespace:

- provides Docker through an isolated dev-container configuration;
- builds the pinned Murikah Tutor image;
- forwards frontend port `3782` for private operator testing;
- keeps FastAPI port `8001` internal to the Tutor container;
- stores test state under `tutor/.codespaces-data` inside the persistent Codespaces workspace;
- enables Tutor authentication before the first browser session;
- removes the one-time bootstrap container after authentication is created so the plaintext bootstrap password is not kept in the long-running container configuration;
- automatically resumes Tutor after an established Codespace is stopped and started again; and
- can automatically start a named Cloudflare Tunnel for stable public ingress when `CLOUDFLARE_TUNNEL_TOKEN` is configured.

## Create the Codespace

1. Open `wmurikah/Murikah` on GitHub.
2. Select **Code** -> **Codespaces**.
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
- if Docker objects were lost but persisted Tutor data remains, it rebuilds the pinned image and recreates the container;
- if `CLOUDFLARE_TUNNEL_TOKEN` is available, it starts the named Cloudflare Tunnel after Tutor becomes healthy; and
- if first-boot authentication has never been configured, it does not prompt or hang — it tells the operator to run `start.sh` manually.

This removes the need to run `start.sh` after ordinary Codespace stop/start cycles. It does **not** prevent GitHub from suspending an idle Codespace; it only restores Tutor and the configured tunnel automatically when that Codespace is resumed.

## Public access through Cloudflare Tunnel

For public demonstrations, use a **remotely-managed named Cloudflare Tunnel**, not the GitHub `app.github.dev` public-port forwarding path.

The intended hostname is:

```text
https://tutor.murikah.com
```

The full setup runbook is in:

```text
tutor/codespaces/CLOUDFLARE.md
```

The tunnel connector runs in its own `cloudflare/cloudflared` container and shares a private Docker network with Tutor. The Cloudflare published application route must point to:

```text
http://murikah-tutor-codespaces:3782
```

The tunnel token must be stored as the GitHub Codespaces secret:

```text
CLOUDFLARE_TUNNEL_TOKEN
```

Never commit that token.

Once the named tunnel works, keep the GitHub Codespaces visibility for port `3782` **Private**. Public users should access only the Cloudflare hostname.

Never expose port `8001` publicly.

## Private operator access

For your own testing inside the Codespaces access boundary:

1. open the **PORTS** tab;
2. find **Murikah Tutor** on port `3782`; and
3. open its forwarded URL while the port remains **Private**.

This private forwarded URL is useful for diagnosis even when the public path is Cloudflare Tunnel.

## Manual tunnel management

To manage only the Cloudflare connector:

```bash
bash tutor/codespaces/cloudflare-tunnel.sh start
bash tutor/codespaces/cloudflare-tunnel.sh status
bash tutor/codespaces/cloudflare-tunnel.sh logs
bash tutor/codespaces/cloudflare-tunnel.sh restart
bash tutor/codespaces/cloudflare-tunnel.sh stop
```

## Manual stop and restart

To stop Tutor and the Cloudflare connector without deleting Tutor data, run:

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

GitHub's personal Codespaces setting allows an idle timeout up to 240 minutes (4 hours). Even at the maximum, Codespaces remains test/demo infrastructure rather than an always-on host: once GitHub suspends the Codespace, `tutor.murikah.com` will be unavailable until the Codespace is resumed.

## Persistence

Runtime state is stored at:

```text
tutor/.codespaces-data
```

This directory is under `/workspaces`, so it survives ordinary Codespace stop/start and dev-container rebuilds. It is ignored by Git and must never be committed.

The Cloudflare tunnel token file created by the launcher is kept under the ignored `.codespaces-data/.secrets/` area with restrictive permissions. The source of truth remains the GitHub Codespaces secret.

Deleting the Codespace deletes its Codespaces storage. Treat this environment as disposable test infrastructure; do not put irreplaceable production data in it.

## Included usage

Codespaces is metered in core-hours rather than ordinary clock hours. Check **GitHub Settings -> Billing and licensing -> Codespaces** for your remaining included usage before long sessions.

A two-core Codespace consumes two core-hours for every hour that it is running. Stop the Codespace after testing rather than leaving it online as a permanent service.

## Production path later

This Codespaces plus Cloudflare Tunnel path provides a stable public hostname while the Codespace is awake. It does not replace the long-term production architecture. When budget or a suitable free long-running host is available, deploy the same Murikah Tutor container with persistent `/app/data` storage and point the Cloudflare Tunnel or DNS path at that always-on origin instead.
