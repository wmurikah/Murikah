# Murikah Tutor deployment boundary

Murikah Tutor is deployed independently from the existing Murikah Astro/Cloudflare Worker applications.

## Target topology

```text
wmurikah/Murikah
  └── tutor/                 product boundary/reference

Murikah-controlled DeepTutor fork
  └── dedicated Tutor runtime
        ├── Next.js frontend
        ├── Python backend
        └── persistent application data

Managed application host
  └── public service on port 3782
        └── persistent volume mounted at /app/data

Cloudflare DNS
  └── tutor.murikah.com
```

## Non-negotiable constraints

1. Do not add DeepTutor Python or Next.js dependencies to the Murikah root `package.json`.
2. Do not change `astro.config.ts`, `wrangler` configuration, Turso clients, existing database schemas, or existing application routes for Tutor.
3. Do not use an existing Murikah Turso database as Tutor's initial persistence layer.
4. Persist the Tutor application's `/app/data` directory on the managed host.
5. Do not expose internal sidecars or backend-only ports directly to the public internet.
6. Keep secrets in the managed host's environment/secrets facility; never commit them.

## Rollout sequence

### Phase 1 — Repository boundary

- Establish the `tutor/` product boundary.
- Record branding and architecture constraints.
- No changes to the existing application stack.

### Phase 2 — Murikah-controlled DeepTutor source

- Create a Murikah-controlled fork of `HKUDS/DeepTutor`.
- Preserve Apache-2.0 attribution and notices.
- Establish an `upstream` relationship for future DeepTutor updates.
- Link the Tutor boundary to that source without merging its dependency graph into the existing application.

### Phase 3 — Murikah Tutor branding

Apply Tutor-only branding:

- **Murikah Tutor**
- **AI-powered personalised learning**
- Murikah logo/favicon treatment
- Murikah typography, colour and product identity where appropriate
- Remove or replace DeepTutor-facing product labels without obscuring required open-source notices

### Phase 4 — Managed-host deployment

- Deploy the Tutor source independently.
- Attach persistent storage at `/app/data`.
- Expose the application service on its expected frontend port.
- Configure production authentication and secrets.
- Verify persistence across redeploys before adding the public domain.

### Phase 5 — Cloudflare domain

After the application is healthy on the managed host:

- create `tutor.murikah.com` in Cloudflare
- point it to the managed host using the provider's verified custom-domain flow
- enable HTTPS
- verify WebSocket/API behaviour
- apply access/security controls appropriate for the public Tutor service

Cloudflare configuration is intentionally deferred until the application itself is deployed and verified.
