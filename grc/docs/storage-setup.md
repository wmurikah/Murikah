# Evidence storage: registering the providers

Evidence is stored per organisation. A customer chooses Cloudflare R2, Google
Drive, SharePoint/OneDrive or Dropbox on `/settings/storage`, and their evidence
goes to that account and nowhere else. One organisation can never read another's
evidence: every stored object is keyed under `org/{organization_id}/...`, and
every connection row, credential included, is scoped by `organization_id`.

Two kinds of registration are involved, and it matters which is which:

- **The platform's application registration.** Google, Microsoft and Dropbox
  require an OAuth application to identify this product to them. There is one of
  each for the whole deployment and it holds no customer data. These are Worker
  secrets, listed in `grc/docs/deploy.md`, and are registered once by the
  operator using this page.
- **The customer's own account.** The refresh token, or the R2 keys, naming the
  customer's own Drive, SharePoint, Dropbox or bucket. These are never in the
  repo and never in a Worker secret: they are sealed with AES-GCM against that
  organisation's row in `storage_connections`, and the settings screen only ever
  renders them masked.

Cloudflare R2 needs no platform registration at all. Everything it needs is
supplied by the customer on the settings screen, so it works on a deployment
with none of the secrets below set.

## The redirect URI

Every OAuth provider must be told exactly where to send the administrator back
to. The pattern is the same for all three:

```
https://grc.murikah.com/api/admin/storage/<provider>/callback
```

with `<provider>` one of `google_drive`, `sharepoint`, `dropbox`. Register the
production URI, and add `http://grc.localhost:4321/api/admin/storage/<provider>/callback`
as a second redirect URI if you connect providers in local development. The
application derives the URI from the request origin, so a preview deployment on
a different hostname needs that hostname registered too, or the consent step
will be refused by the provider before it ever reaches this app.

## Cloudflare R2

Nothing to register. The customer's administrator supplies, on
`/settings/storage`:

| Field             | Where it comes from                                   |
| ----------------- | ----------------------------------------------------- |
| Account ID        | Cloudflare dashboard, R2 overview                     |
| Bucket            | the bucket evidence should go to; create it first     |
| Access key ID     | R2 → Manage R2 API Tokens → Create API token          |
| Secret access key | shown once when the token is created                  |
| Endpoint          | optional; derived from the account id when left blank |

Give the API token **Object Read & Write** on that one bucket, not account-wide
access. The key prefix on the settings screen is optional and sits in front of
the tenant-scoped key, which is useful when one bucket serves more than one
environment.

R2 is the only provider that can sign a URL, so its evidence bytes move directly
between the browser and the bucket and never pass through this application. On
the other three the bytes stream through the Worker, because their APIs
authenticate with a bearer token that must never reach a browser.

## Google Drive

1. In the Google Cloud console, create (or pick) a project.
2. **APIs & Services → Library**: enable the **Google Drive API**.
3. **APIs & Services → OAuth consent screen**: configure it. If the customers
   are outside your own Workspace, the app must be published rather than left in
   testing, or refresh tokens expire after seven days.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**,
   type **Web application**. Add the redirect URI
   `https://grc.murikah.com/api/admin/storage/google_drive/callback`.
5. Set the client id and secret as Worker secrets:

   ```sh
   wrangler secret put GDRIVE_CLIENT_ID
   wrangler secret put GDRIVE_CLIENT_SECRET
   ```

The connector requests the `https://www.googleapis.com/auth/drive` scope, with
`access_type=offline` and `prompt=consent` so Google issues a refresh token.
Without both, the connection dies about an hour after it is made.

`GDRIVE_CLIENT_ID` and `GDRIVE_CLIENT_SECRET` are the same pair the legacy
read-only Drive read-through uses; sharing them is intended, and the legacy
`GDRIVE_REFRESH_TOKEN` is unrelated to the per-organisation connectors.

## SharePoint / OneDrive

1. In the Microsoft Entra admin centre, **App registrations → New registration**.
   Choose the account types the customers use; "Accounts in any organizational
   directory and personal Microsoft accounts" covers both SharePoint and
   consumer OneDrive.
2. Under **Authentication**, add a **Web** platform with the redirect URI
   `https://grc.murikah.com/api/admin/storage/sharepoint/callback`.
3. Under **API permissions**, add the delegated Microsoft Graph permissions
   `Files.ReadWrite.All`, `Sites.Read.All`, `User.Read` and `offline_access`.
   Grant admin consent if the tenant requires it.
4. Under **Certificates & secrets**, create a client secret and note its value;
   it is shown once. Note its expiry and diarise the rotation, because the
   connector stops working the day it lapses.
5. Set them as Worker secrets:

   ```sh
   wrangler secret put SHAREPOINT_CLIENT_ID
   wrangler secret put SHAREPOINT_CLIENT_SECRET
   ```

If the deployment already has an Entra app registered for the Outlook mailbox
(`GRAPH_CLIENT_ID` / `GRAPH_CLIENT_SECRET`), the Files scopes can be added to
that one instead and the SharePoint secrets left unset: the connector falls back
to the Graph pair. Whichever you use, its redirect URI list must include the
SharePoint callback above.

The stored folder is a drive and item pair (`driveId/itemId`), because a folder
id alone is ambiguous across drives. The folder picker on the settings screen
records both.

## Dropbox

1. At the Dropbox App Console, **Create app**: Scoped access, and either **App
   folder** (evidence is confined to one folder Dropbox creates) or **Full
   Dropbox**. App folder is the tighter choice and is recommended.
2. On the **Permissions** tab, tick `files.content.write`,
   `files.content.read`, `files.metadata.read` and `account_info.read`, then
   submit.
3. On the **Settings** tab, add the redirect URI
   `https://grc.murikah.com/api/admin/storage/dropbox/callback`.
4. Set the app key and secret as Worker secrets:

   ```sh
   wrangler secret put DROPBOX_CLIENT_ID
   wrangler secret put DROPBOX_CLIENT_SECRET
   ```

The connector requests `token_access_type=offline`, so Dropbox issues a refresh
token rather than an access token that dies in four hours.

## What an administrator then does

On `/settings/storage`, in this order:

1. **Configure.** Fill in the R2 fields, or press Connect and complete the
   provider's consent screen.
2. **Test connection.** The test writes a probe object and removes it again. A
   credential that can read but not write is a connection that fails on the
   first real upload, so a read-only check would report a false green.
3. **Choose the folder.** "List folders" asks the provider what it has; picking
   one records where evidence lands.
4. **Store evidence here.** Only offered once a test has passed, and refused
   otherwise: evidence should not start depending on a connection nobody has
   proved reachable.

Rotating a credential is the same journey: paste the new key, or press
Reconnect, then test. A blank secret field on save keeps the stored one, so the
bucket can be changed without retyping a key that is only ever shown masked.
Disconnecting removes the row and its sealed credentials outright; evidence
already stored is unaffected and stays downloadable, because a stored object
records which provider holds it and is resolved by that, not by whichever
provider is active now.
