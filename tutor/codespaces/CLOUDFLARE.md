# Murikah Tutor through a named Cloudflare Tunnel

Use a **remotely-managed named Cloudflare Tunnel** for public Tutor access from GitHub Codespaces. Do not rely on the Codespaces `app.github.dev` public forwarding URL for the public product path.

The intended public hostname is:

```text
https://tutor.murikah.com
```

## Why a named tunnel

A named tunnel gives Murikah Tutor a stable hostname and keeps the Codespace origin private. It also avoids the GitHub public-port forwarding path that can become unreliable after Codespace restarts.

Do not use a Cloudflare Quick Tunnel for Tutor chat. Quick Tunnels are development-only and do not support Server-Sent Events; Tutor needs a normal named tunnel for reliable streaming behavior.

## Runtime topology

```text
Internet
  -> Cloudflare
  -> named tunnel
  -> cloudflared container
  -> Docker network: murikah-tutor-net
  -> http://murikah-tutor-codespaces:3782
  -> Murikah Tutor
```

FastAPI port `8001` remains internal and is never published.

## Codespaces networking compatibility

GitHub Codespaces runs Tutor through Docker-in-Docker. On a user-defined Docker network, Docker normally exposes its embedded DNS resolver at `127.0.0.11`. In Codespaces that resolver can time out on the SRV lookups cloudflared uses to discover Cloudflare Tunnel edge endpoints.

The repository launcher therefore starts `cloudflared` with explicit public resolvers:

```text
1.1.1.1
1.0.0.1
```

It also forces the Cloudflare edge transport to **HTTP/2**. This uses TCP instead of relying on QUIC/UDP and is more predictable in a hosted development environment.

A successful launcher run does not merely check that the Docker container is alive. It waits until the logs contain a registered Cloudflare edge connection. If no edge registration occurs within the startup window, the launcher exits with diagnostics instead of reporting a false success.

## 1. Create the Cloudflare Tunnel

In the Cloudflare dashboard:

1. Open **Networking -> Tunnels**.
2. Select **Create Tunnel**.
3. Name it `Murikah Tutor Codespaces`.
4. Create the tunnel.

Use a remotely-managed tunnel. The Codespace only needs the tunnel token to run a connector.

## 2. Publish the Tutor hostname

Inside the tunnel, add a route of type **Published application**.

Configure:

```text
Hostname: tutor.murikah.com
Service type: HTTP
Service URL: http://murikah-tutor-codespaces:3782
```

The service URL deliberately uses the Tutor Docker container name. The repository scripts attach Tutor and `cloudflared` to the private Docker network `murikah-tutor-net`, so `cloudflared` can reach Tutor without using GitHub's public forwarding layer.

Cloudflare manages the DNS route for the published application. Do not point `tutor.murikah.com` at the `app.github.dev` address.

## 3. Copy the tunnel token

From the tunnel page, use **Add a replica** or the displayed connector installation command and copy only the long tunnel token value.

Treat the token as a secret. Anyone with the token can run a connector for the tunnel.

Do not commit it, paste it into issues, put it in screenshots, or store it in a tracked `.env` file.

## 4. Store the token as a GitHub Codespaces secret

In GitHub:

1. Open your profile picture -> **Settings**.
2. Under **Code, planning, and automation**, open **Codespaces**.
3. Under **Codespaces secrets**, select **New secret**.
4. Name it exactly:

```text
CLOUDFLARE_TUNNEL_TOKEN
```

5. Paste the Cloudflare tunnel token as the value.
6. Grant repository access only to `wmurikah/Murikah`.
7. Save the secret.

For an already-running Codespace, stop and start the Codespace after adding the secret so the environment receives the new secret.

## 5. Start Tutor and the tunnel

After the Codespace has the secret, run:

```bash
bash tutor/codespaces/start.sh
```

The launcher starts Tutor first, verifies `/health`, and then starts the named Cloudflare Tunnel connector.

To manage only the connector:

```bash
bash tutor/codespaces/cloudflare-tunnel.sh start
bash tutor/codespaces/cloudflare-tunnel.sh status
bash tutor/codespaces/cloudflare-tunnel.sh logs
bash tutor/codespaces/cloudflare-tunnel.sh restart
bash tutor/codespaces/cloudflare-tunnel.sh stop
```

A healthy `status` result means the process is running **and** at least one Cloudflare edge connection has been registered.

## 6. Keep the GitHub forwarded port private

Port `3782` can remain forwarded for operator testing, but its Codespaces visibility should be **Private** once the Cloudflare Tunnel is working.

Public users should use only:

```text
https://tutor.murikah.com
```

Never make port `8001` public.

## 7. Automatic resume

After first-boot setup, `tutor/codespaces/autostart.sh` runs when the Codespace starts or resumes. It restores Tutor first and then starts the Cloudflare Tunnel when `CLOUDFLARE_TUNNEL_TOKEN` is present.

This removes the need to recreate the tunnel after an ordinary Codespace resume.

It does **not** make Codespaces always-on. When GitHub suspends the entire Codespace after the configured idle timeout, `tutor.murikah.com` will be offline until the Codespace itself is resumed. Once resumed, the Tutor and tunnel connectors are designed to recover automatically.

## Troubleshooting

If logs show DNS failures such as:

```text
lookup _v2-origintunneld._tcp.argotunnel.com on 127.0.0.11:53: i/o timeout
```

confirm that the current repository version includes the explicit `1.1.1.1` and `1.0.0.1` Docker DNS overrides, then restart the connector.

If DNS succeeds but the tunnel cannot connect to the Cloudflare edge, inspect the logs for TCP connection failures to port `7844`. The Codespaces launcher deliberately uses HTTP/2, so outbound TCP `7844` must be available.

The warning that no ingress rules are defined can appear before a published-application route has been added in the Cloudflare dashboard. After the connector is healthy, create the `tutor.murikah.com` route using the service URL documented above.

## Security notes

- Keep Tutor authentication enabled.
- Keep the tunnel token only in GitHub Codespaces secrets / ignored runtime storage.
- Do not expose FastAPI port `8001`.
- Rotate the Cloudflare tunnel token if it is ever disclosed.
- The local token file written by the launcher is stored under the Git-ignored `tutor/.codespaces-data/.secrets/` directory with restrictive file permissions.
