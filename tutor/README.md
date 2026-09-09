# Murikah Tutor

**AI-powered personalised learning**

Murikah Tutor is a standalone Murikah product based on the open-source [HKUDS/DeepTutor](https://github.com/HKUDS/DeepTutor) project.

## Isolation rule

Murikah Tutor must remain operationally and dependency-isolated from the existing Murikah applications.

The Tutor implementation must not require changes to the existing application's:

- Astro framework or configuration
- Cloudflare Worker runtime
- root `package.json` dependency graph
- Turso/libSQL databases or database clients
- existing `src/`, `cms/`, `engr/`, or `grc/` application code
- existing deployment routes or product subdomains

Tutor-specific Python, Next.js, container, runtime, storage, environment and deployment configuration belongs inside the Tutor application boundary or its dedicated upstream fork.

## Product identity

Product name: **Murikah Tutor**

Tagline: **AI-powered personalised learning**

Public URL target: `https://tutor.murikah.com`

## Source strategy

The intended source-of-truth is a Murikah-controlled fork of `HKUDS/DeepTutor`, linked from this `tutor/` boundary without vendoring the full upstream repository into the Murikah application tree.

This keeps upstream updates manageable and prevents DeepTutor's Python/Next.js dependencies from being merged into the existing Astro stack.

## Data strategy

Murikah Tutor will use DeepTutor's own persistent application data initially. Existing Murikah Turso databases remain unchanged and are not a dependency of Tutor.

Any future migration of Tutor storage to Turso or another managed database must be treated as a separate architecture decision and must not alter the existing applications.

## Deployment strategy

Murikah Tutor will be deployed independently from the existing Cloudflare Worker applications. Cloudflare will provide DNS/custom-domain routing for `tutor.murikah.com`; the Tutor runtime will run on a managed application host with persistent storage.

See `DEPLOYMENT.md` for the deployment boundary and rollout sequence.
