# Engineering Rhythm - editable region affiliates and legacy codes

## Purpose and security decision

The old region form conflated **tenant ownership** and **affiliate classification**.
In Engineering Rhythm these must be separate: an existing Hass Group region
may be classified as "Hass Kenya" while its stations, data permissions, history
and original \`regions.org_id\` stay with Hass Group. This change does not
transfer the region or its stations into another tenant.

- \`regions.org_id\` remains the immutable owning organisation.
- New \`regions.affiliate_org_id\` references a pre-existing organisation or
  affiliate within that owning group's hierarchy.
- Hass Group Owner/Administrator (with the existing \`stations.manage\`
  permission) and a system/platform owner acting under Hass Group can choose
  only active Hass Group child affiliates, not Hass Group itself.
- Other operators, including administrators acting within a child affiliate,
  can choose only their acting organisation.
- A region already owned by a child affiliate cannot be classified as a
  different child. A platform owner acting under an unrelated tenant sees
  that tenant's choices, not Hass's list.
- Existing stations continue to reference the same region ID under the same
  owning tenant. Region name/affiliate changes are captured in audit logs.
- Users with \`@hasspetroleum.com\` addresses do **not** automatically receive
  access to every Hass affiliate. Existing Hass Group permissions continue
  working on their existing Hass Group records; child affiliates have their
  own permission boundaries. The system owner may use the existing acting
  organisation switcher to access an authorised subsidiary.
- Nothing in this migration creates a new customer tenant, moves Hass setup
  data between tenants, or modifies the platform owner's global tenant
  switching policy.

## Database change - migration 010 is REQUIRED

Apply to **Engineering Turso** before deploying the revised Worker. Migration
009 must already be applied; use a recoverable database backup.

The migration:
1. Adds nullable \`regions.affiliate_org_id\` with a foreign key to
   \`organisations.id\` and an index.
2. Defaults each existing region's affiliate classification to its current
   owning organisation, preserving all previous relationships.
3. Generates permanent \`REG-000001\`-style codes only for regions whose
   current \`code\` is NULL or blank, in stable order, within each owning
   organisation. Codes already present, including older manually issued codes,
   remain unchanged.
4. Does not change \`regions.id\`, \`regions.org_id\`, \`stations.region_id\`,
   \`stations.org_id\`, assets, requests, approvals, or users.

Preferred: \`cd Engr && pnpm db:apply\` using the configured migration runner.

If administering through the Turso Web editor, use
\`Engr/docs/sql/010_region_affiliates_and_codes.sql\` sequentially. Start only
after checking migration 010 is absent and the affiliate column is absent.
**Never run the ALTER TABLE step a second time.** The source migration
safely checks the column before altering it.

Expected migration checksum:
\`48ea157ba1d3cc9e242a8c23a319a66085757bbbeb4adf89865684189b845faf\`.

## Validate before release

1. \`SELECT id, description, checksum FROM schema_migrations WHERE id='010';\`
2. \`PRAGMA table_info(regions);\` - \`affiliate_org_id\` should exist.
3. \`SELECT COUNT(*) FROM regions WHERE code IS NULL OR TRIM(code)='';\`
   - expected **0** after backfill.
4. \`SELECT COUNT(*) FROM regions WHERE affiliate_org_id IS NULL;\`
   - expected **0** after backfill.
5. Confirm Coast has a generated \`REG-\` code, then change its affiliate from
   Hass to Hass Kenya using the edit dropdown. Its station links and owner
   should remain Hass and its region code should not change.
6. Confirm the dropdown lists only Hass's existing affiliates when acting as
   Hass Group admin/owner, and no unrelated tenants are present.
7. From \`Engr/\`: \`pnpm install --frozen-lockfile\`,
   \`pnpm run build\`, \`pnpm run test\`, \`pnpm run db:schema:check\`,
   \`pnpm run lint\`, \`pnpm run format:check\`.
8. Deploy with the existing Cloudflare workflow only after migration and
   validation are successful.

Do not mistake classification for a subsidiary data migration. Moving a
fully configured station and its workflows into a different owning affiliate
would require a separate, audited multi-entity migration, not this form.
