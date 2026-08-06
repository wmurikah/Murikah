# The Google Drive browse mirror

Cloudflare R2 is the system of record for evidence (the earlier file-storage
decision stands, see `evidence-storage.md`): originals are immutable,
content-hashed and tenant-scoped. The Drive mirror exists only so a human can
browse the files in a familiar folder. A background job copies each file's
optimised copy (or the original when no optimised copy exists) into the shared
folder under its distinct, deterministic name, and records the Drive file id
on the `files` row (`drive_file_id`). Nothing in the app ever reads back from
the mirror, and the user is never blocked on a Drive call: uploads queue an
attempt after the R2 write, and the cron sweep retries anything unmirrored on
every run.

Every mirrored file is named
`{affiliate}_{work_paper_ref}_{kind}_{yyyymmdd}_{seq}_{shorthash}.{ext}`
(kind is `evidence` for work paper files, `update` for action plan management
updates), so the name alone says what a file belongs to and no two files
collide. The mirror upload is idempotent by name: a retry reuses the existing
Drive file rather than duplicating it.

## One-time setup

1. **Enable the Drive API.** In the
   [Google Cloud console](https://console.cloud.google.com), pick (or create)
   a project, open APIs and Services, Library, and enable the
   **Google Drive API**.
2. **Create a service account.** APIs and Services, Credentials, Create
   credentials, Service account. No project roles are needed. Open the new
   account, Keys, Add key, Create new key, **JSON**, and download the key
   file.
3. **Share the folder.** Open the target folder in Google Drive, in this case
   `https://drive.google.com/drive/folders/1CKe4eZw-GryfFlRl8rjVBADr2T1RGlQQ`,
   choose Share, and add the service account's email address (the
   `client_email` from the key file) as an **Editor**. The service account
   can only ever see what is explicitly shared to it.
4. **Set the Worker secrets.** The key JSON goes in whole, exactly as
   downloaded:

   ```sh
   wrangler secret put GDRIVE_SERVICE_ACCOUNT_JSON   # paste the full key JSON
   wrangler secret put GDRIVE_EVIDENCE_FOLDER_ID     # 1CKe4eZw-GryfFlRl8rjVBADr2T1RGlQQ
   ```

   Locally these go in `.dev.vars`. Neither value is ever committed.

With both secrets set, the cron sweep (`runDriveMirror`, every scheduled run)
starts mirroring; without them it is a silent no-op and the product is
unaffected. Failures are logged under `[grc.evidence.mirror]` and retried on
the next run. Legacy rows that already live on Drive keep their existing
`drive_file_id` and are never re-uploaded.
