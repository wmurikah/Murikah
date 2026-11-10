# Engineering Rhythm: controlled transfers, affiliate regions and generated codes

## Deployment order (important)

This change is **not a framework or hosting migration**. It stays inside \`Engr/\` and
uses the existing Astro, TypeScript, Cloudflare Workers, Turso/libSQL and pnpm stack.

1. Take a recoverable **backup of the Engineering Turso database**.
2. Confirm migrations 001–008 are present, and **009 is absent**:
   \`SELECT id, description FROM schema_migrations ORDER BY id;\`
3. Confirm the previous movement table is present:
   \`PRAGMA table_info(asset_movements);\`
4. Apply migration **009** **before** deploying the updated Worker. Preferred when
   local Turso credentials are configured: \`cd Engr && pnpm db:apply\`.
   Turso Web alternative: run **[docs/sql/009_controlled_asset_transfers.sql](sql/009_controlled_asset_transfers.sql)**
   in order. Skip the \`ALTER TABLE\` only when its column already exists (partial
   prior attempt), and do not insert history 009 until every earlier statement
   succeeds. Never rerun the whole SQL script after 009 is recorded.
5. Verify \`SELECT * FROM schema_migrations WHERE id = '009';\` and
   \`PRAGMA table_info(asset_movements);\`. The checksum for the committed migration
   source is \`3fc6396763ad4f4956bf3fd2e98a7f3b991cab8f989ab1d8b63396d8b4df9bcf\`.
6. From \`Engr/\`, run:
   - \`pnpm install --frozen-lockfile\`
   - \`pnpm run build\` (includes \`astro check\`)
   - \`pnpm run test\`
   - \`pnpm run lint\`
   - \`pnpm run format:check\`
   - \`pnpm run db:schema:check\`
7. Deploy the existing Cloudflare Worker workflow unchanged, then verify
   \`https://engr.murikah.com/api/health\` includes \`assetTransferSchema: "ok"\`.
8. Sign in as a station manager at source and destination, an engineer and an
   engineering manager. Execute a real test transfer including rejection,
   dispatch, serial mismatch, receipt and paused PM review.

## What changes in Turso

Migration 009 creates \`asset_transfers\` with a controlled six-state lifecycle
(REQUESTED, APPROVED, DISPATCHED, RECEIVED, REJECTED, CANCELLED), prevents two
simultaneously open transfers for one asset, and adds a nullable \`transfer_id\`
foreign key to the existing \`asset_movements\` audit history. It also adds
permission keys for requesting, approving, dispatching and receiving, with
appropriate standard-role grants.

No existing asset, station, region or affiliate ID is changed. Earlier movement
rows retain \`transfer_id = NULL\`; they are not retroactively invented.

The organisation schema already has \`organisations.parent_org_id\` and
\`regions.org_id\`. **No extra region affiliate column is required.** A platform
owner selects an affiliate, and the region is created inside that affiliate's
existing organisation ID. Staff without platform-owner authority cannot choose
another affiliate.

New region and station codes are automatically generated per affiliate as
\`REG-000001\` and \`STN-000001\` (then incremented), are never accepted from
client form/API input, and cannot be edited. Previously issued/manual codes
remain intact and read-only; older regions without a code should be reviewed
before a separate data-cleanup exercise, rather than silently renumbered.

## Deployment failure fixed from PR #445

Cloudflare's build log ended at \`EngrLayout.astro\`, with six TypeScript 6
errors (TS2677 and TS2322). Optional \`NavItem\` properties caused an invalid
type predicate on inline arrays. The new \`visibleNavItems\` helper contextually
types the candidates as \`Array<NavItem | null>\` before filtering, making the
predicate assignable.

No changes to the tech stack or any folder outside \`Engr/\` are required.

## Business safeguards

- A requested or dispatched asset stays at its originating station until the
  receiving actor confirms physical custody. A transfer's official destination
  must be a different active station of the same affiliate.
- A requester cannot approve their own request. A dispatcher cannot confirm
  their own receipt. Station-scoped users may dispatch/receive only at their
  assigned stations. Confirmation records physical condition and verifies serial
  identity when a serial number exists.
- Open repair work blocks movement. Historical work orders that did not have
  \`asset_id\` are also checked through their service request links.
- Receiving the asset updates the register and movement log atomically and
  pauses active, asset-specific preventive-maintenance schedules for review.
- Asset master editing can no longer silently change an asset's station. Region
  and station code changes are likewise rejected at the server boundary.
- The sidebar's per-user count includes pending transfer approvals, dispatches,
  and receipts under the Setup section.

## Production status

This repository change does not itself update production Turso or deploy the
Worker. Apply the migration and run validation before merging/deploying.
