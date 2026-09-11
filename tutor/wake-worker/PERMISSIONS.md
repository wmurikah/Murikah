# GitHub permissions required by the Murikah Tutor Wake Worker

The Worker uses two GitHub Codespaces REST endpoints:

```text
GET  /user/codespaces/{codespace_name}
POST /user/codespaces/{codespace_name}/start
```

For a fine-grained personal access token restricted to `wmurikah/Murikah`, grant exactly:

- **Codespaces** repository permission: **Read-only** — required for the GET status call.
- **Codespaces lifecycle admin** repository permission: **Read and write** — required for the POST start call.

No Contents, Issues, Pull Requests, Actions, Administration, Codespaces secrets, or other repository write permissions are required by the Wake Worker.

Store the token only as the Cloudflare Worker secret `GITHUB_CODESPACES_TOKEN`; never commit it to the repository.
