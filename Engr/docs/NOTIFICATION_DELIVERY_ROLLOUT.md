# Engineering notification delivery rollout

Provider credentials are platform secrets. They are configured once in Cloudflare by a platform operator and are never stored in Turso or exposed to an organisation administrator. Organisation administrators use **Setup → Notification settings** to enable channels, set quiet hours, and set an SMS cap.

## Safe deployment order

1. Deploy the code containing the fail-closed dispatcher.
2. Confirm **Setup → Notification settings** says external delivery is not enabled and that queued email/SMS remains queued.
3. Configure one provider at a time in Cloudflare **Settings → Variables and secrets → Production**.
4. Set `ENGR_ENV` to the plain-text value `production` only when at least one provider is complete.
5. Redeploy, then confirm the provider is shown as **Ready** on the settings page.
6. Enable that channel for one test organisation and generate a real workflow alert.
7. Check **Notifications** and the provider dashboard before enabling it for more organisations.

`https://engr.murikah.com/api/health` reports database/schema readiness and whether email and SMS are `ready` or safely `held`. It never returns credential values.

## Email with Resend

Add these Production runtime values to the `murikah-engr` Worker:

| Name            | Type     | Value                                                                       |
| --------------- | -------- | --------------------------------------------------------------------------- |
| `EMAIL_API_KEY` | Secret   | Resend API key                                                              |
| `EMAIL_FROM`    | Variable | Verified sender, for example `Engineering Rhythm <engineering@murikah.com>` |

The sender/domain must be verified in Resend before testing.

## SMS with Africa's Talking

Add these Production runtime values:

| Name           | Type     | Value                                 |
| -------------- | -------- | ------------------------------------- |
| `AT_USERNAME`  | Secret   | Africa's Talking application username |
| `AT_API_KEY`   | Secret   | Africa's Talking API key              |
| `AT_SENDER_ID` | Variable | Approved sender ID                    |

Use production credentials rather than the Africa's Talking sandbox when `ENGR_ENV=production`.

## Runtime and callback controls

Add:

| Name                  | Type     | Purpose                                            |
| --------------------- | -------- | -------------------------------------------------- |
| `ENGR_ENV`            | Variable | Exact value `production` enables external delivery |
| `ENGR_CRON_SECRET`    | Secret   | Protects manual cron endpoints                     |
| `ENGR_WEBHOOK_SECRET` | Secret   | Protects delivery receipt callbacks                |

Generate the two shared secrets independently with at least 32 random bytes. Provider-native webhook signatures should replace the shared callback secret in a later security change.

## Recovery behavior

On its first dispatcher run, the new code finds legacy rows marked `SENT` with the old `dry-run: non-production, not sent` marker and restores them to `QUEUED`. Unavailable external channels are excluded from dispatch, so their backlog cannot block in-app notifications. Once a provider becomes ready, its queued messages resume automatically.
