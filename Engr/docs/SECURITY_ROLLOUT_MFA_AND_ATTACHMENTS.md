# MFA and attachment security rollout

This change uses the existing MFA and user-role tables. **No Turso schema change or SQL script is required.**

## Before deploying

In **Cloudflare → Workers & Pages → murikah-engr → Settings → Variables and Secrets → Production**, confirm `ENGR_MFA_ENCRYPTION_KEY` is present. Existing OWNER and ADMIN accounts already need it. Engineering Managers, Financial Controllers, and anyone else granted an approval, award, payment, or role-management permission will now also have to enroll an authenticator before using the application. Keep their existing recovery codes secure. A successful challenge is valid for ten minutes for sensitive actions; after it expires, the browser returns to the form page and the user submits the action again. JSON clients receive `403` with `mfa_required` or `mfa_enrollment_required`.

If staff paste file links into service requests, add a **plain text variable** `ENGR_ATTACHMENT_ALLOWED_HOSTS` with the exact trusted file-host names, separated by commas, for example `files.example.com,tenant.sharepoint.com`. Do not include `https://`, wildcards, paths, or a trailing slash. Confirm each host is under your organisation's control or is an approved file provider. When the variable is absent, requests without links still work, but new attachment links are rejected. Older links on unapproved hosts appear as non-clickable text.

## After deploying

1. Have one Engineering Manager and one Financial Controller sign in. Users who have not enrolled MFA should be guided through authenticator setup and should save their one-time recovery codes.
2. Submit an approval or payment after a fresh challenge. Leave the session open for more than ten minutes, then retry: the action should wait for another challenge and must not be written before it.
3. Try an approved HTTPS attachment link on a new request. A different host, a lookalike hostname, `http:`, `javascript:`, and redirect-style links should be rejected without creating the request.
4. Open an older request with an unapproved stored URL. Its filename should be visible but not clickable.
5. Complete an MFA challenge with a normal in-app `next` destination. Crafted external destinations must return to the dashboard instead.

The allow-list checks the URL recorded and displayed by the application. A trusted file provider may redirect a browser after it leaves Engineering Rhythm, so use only providers your organisation trusts and audit their sharing settings.
