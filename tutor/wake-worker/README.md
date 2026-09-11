# Murikah Tutor Wake Worker

This Worker keeps `https://tutor.murikah.com` responsive even when the GitHub Codespace hosting Tutor has been suspended.

## Runtime flow

```text
User opens tutor.murikah.com
        |
        v
Cloudflare Worker (always available)
        |
        +-- Tutor awake? --> proxy request to tutor-origin.murikah.com
        |
        +-- Tutor asleep? --> call GitHub Codespaces lifecycle API
                                |
                                v
                         start Codespace
                                |
                                v
                     show branded wake page
                                |
                                v
                 poll tutor-origin.murikah.com/health
                                |
                                v
                     open Tutor automatically
```

The existing Codespaces `autostart.sh` remains responsible for restoring the Tutor container and the named Cloudflare Tunnel once the Codespace starts.

## Public and origin hostnames

Use two hostnames:

```text
Public front door: https://tutor.murikah.com
Private-ish origin: https://tutor-origin.murikah.com
```

`tutor-origin.murikah.com` is a Cloudflare Tunnel Published application route pointing to:

```text
http://127.0.0.1:3782
```

`tutor.murikah.com` is a Cloudflare Worker Custom Domain pointing to this Worker.

Do not expose the GitHub Codespaces `app.github.dev` forwarding URL publicly. Port `3782` should stay Private in Codespaces and port `8001` must remain internal.

## Required Worker configuration

Non-secret values are in `wrangler.toml`:

- `ORIGIN_HOST=tutor-origin.murikah.com`
- `CODESPACE_NAME=glorious-yodel-x7jj5gw954h99vw`
- `WAKE_POLL_SECONDS=4`
- `ORIGIN_HEALTH_TIMEOUT_MS=2500`

The Worker requires one secret:

```text
GITHUB_CODESPACES_TOKEN
```

Never commit that token.

## GitHub token

Use a fine-grained GitHub personal access token with the minimum permission needed to read and start the target Codespace. Restrict repository access to `wmurikah/Murikah` and grant the Codespaces lifecycle permission required by GitHub for the start endpoint.

The Worker calls only:

```text
GET  https://api.github.com/user/codespaces/{codespace_name}
POST https://api.github.com/user/codespaces/{codespace_name}/start
```

The token is stored only as a Cloudflare Worker secret.

## One-time deployment

From `tutor/wake-worker`:

```bash
npm install
npx wrangler login
npx wrangler secret put GITHUB_CODESPACES_TOKEN
npm run deploy
```

The Worker deliberately does not claim `tutor.murikah.com` from `wrangler.toml`. Perform the hostname cutover in the Cloudflare dashboard after the Worker exists.

## One-time Cloudflare cutover

Do this in this order so the current Tutor path is not removed before the origin path exists.

1. In **Networking -> Tunnels -> Murikah Tutor Codespaces -> Routes**, add a new Published application route:

   ```text
   Hostname: tutor-origin.murikah.com
   Service:  http://127.0.0.1:3782
   ```

2. Confirm `https://tutor-origin.murikah.com/health` works while the Codespace is awake.
3. Remove only the old Tunnel Published application route for `tutor.murikah.com`.
4. In **Workers & Pages -> murikah-tutor-wake -> Settings -> Domains & Routes**, add `tutor.murikah.com` as a Custom Domain.
5. Add the Worker secret `GITHUB_CODESPACES_TOKEN` if it was not already set through Wrangler.
6. Test `https://tutor.murikah.com` while Tutor is awake.
7. Stop the Codespace from GitHub and test `https://tutor.murikah.com` again. The Worker should show the Murikah Tutor wake screen, start the Codespace, wait for the Tunnel and Tutor health endpoint, then open Tutor automatically.

## Wake behavior

Automatic wake is limited to real browser document navigation signals (`Sec-Fetch-Mode: navigate` or `Sec-Fetch-Dest: document`). This reduces accidental Codespaces wakeups from asset fetches, health probes and ordinary bots.

For manual diagnostics, append:

```text
?wake=1
```

to a browser GET request.

The Worker has two internal endpoints:

```text
GET  /__muri/wake-status
POST /__muri/wake
```

These expose only coarse wake state and never return the GitHub token or raw GitHub API responses.

## Streaming and authentication

When Tutor is healthy, the Worker behaves as a transparent streaming proxy. The response body is not buffered, so Tutor chat streaming remains available.

Tutor's own authentication remains enabled. The Worker does not replace the Tutor login or create a second user account system.

## Important limits

This makes the public URL continuously responsive; it does not make GitHub Codespaces itself always-on.

Tutor can still fail to wake when:

- the user's included Codespaces quota is exhausted;
- the Codespace has been deleted or archived;
- the GitHub token expires or is revoked;
- GitHub or Cloudflare has an outage; or
- the Codespace fails to restore Tutor or the Tunnel.

A fully dormant Codespace also has a startup delay. The Worker masks that delay with the wake page and automatic retry, but it cannot make cold-start compute instantaneous.

If the Codespace is recreated later, update only `CODESPACE_NAME` in the Worker configuration to the new Codespace name.

## Security notes

- Store `GITHUB_CODESPACES_TOKEN` only as a Cloudflare secret.
- Use the narrowest GitHub token scope and an expiry date.
- Keep Tutor authentication enabled.
- Keep Codespaces port `3782` Private.
- Never expose port `8001`.
- Keep `tutor-origin.murikah.com` undocumented in public product navigation; it is an origin route, not the product URL.
- Search-engine crawlers are discouraged with `noindex` and do not normally send the browser navigation headers required for automatic wake.
