# Engineering Rhythm - one parent tenant with many affiliates

## Confirmed model and intentional boundary

An Engineering tenant is the TOP-LEVEL organisation row:
\`organisations.parent_org_id IS NULL\`.

**Hass Group** is the parent tenant. Hass Kenya, Hass Uganda, Fleet Kenya,
etc. are affiliates recorded as child rows with \`parent_org_id = Hass Group.id\`.
The existing platform-owner "Acting organisation" switcher now lists only
active TOP-LEVEL tenants. It does not list the Hass subsidiaries. If the
system has only one active top-level tenant, the switcher is hidden.

The Affiliate dropdown in Regions and Stations is distinct from tenant
ownership:

- \`regions.org_id\`, \`stations.org_id\` are tenant/data-owner IDs and are not
  changed by these forms or the new migration.
- \`regions.affiliate_org_id\` (migration 010) and
  \`stations.affiliate_org_id\` (migration **011**) classify those records
  within the existing tenant.
- A region can only be assigned to the parent tenant or its active child
  affiliates, according to the acting user's existing permissions.
- A station's chosen region must have the SAME affiliate as the station.
  An affiliate change to a region synchronises linked stations in the
  SAME write transaction, with per-station audit rows.
- Reclassification is refused while a source/destination station has
  an unfinished asset transfer. Standard transfers may not silently
  cross affiliate boundaries.
- Codes for stations and regions remain server generated and immutable.
- A newly created affiliate does not receive its own subscription, and
  the parent tenant remains responsible for subscription/billing.
  Previously created affiliate subscriptions are NOT deleted, so they
  can be reviewed separately.

**Identity/access caveat:** This change does not merge accounts or silently
grant all subsidiary users group-wide access. Existing Hass Group users
retain their own role-based access to the Hass-owned dataset.
Legacy users created inside a child organisation are not automatically
moved or elevated to Hass Group. If historical operational records or
users already exist with a child \`org_id\`, review those records and
perform a separate authorised identity/data consolidation; do not
reparent their foreign keys by a blanket SQL update.

## DB deployment - required migration 011

1. Back up the Engineering Turso database.
2. Confirm migrations **009 and 010** were applied and **011 is absent**.
   If 010 is absent, apply and verify the already released migration 010
   first, using its provided Turso SQL file.
3. Use \`cd Engr && pnpm db:apply\` with the configured Engr Turso
   credentials, OR run the commands in
   \`Engr/docs/sql/011_station_affiliates.sql\` from Turso Web in order.
   The Web SQL \`ALTER TABLE\` is intentionally NOT repeatable: run it only
   if \`PRAGMA table_info(stations)\` does not already show
   \`affiliate_org_id\`.
4. Verify \`schema_migrations.id='011'\`, both affiliation checks return
   zero, and \`PRAGMA foreign_key_check\` returns no rows.

Migration 011 checksum:
\`5479ab2934d894fa4d26c0cbb35b0bb94906f94be0173afacca9c5647c08a4ed\`.

## Display name "Hass Group"

Tenant names are now refreshed from the database on each authenticated
request, rather than relying on the text originally stored in a session.
If the parent is currently named just "Hass", inspect and (optionally)
execute the guarded
\`Engr/docs/sql/011_optional_rename_hass_group.sql\`.
It changes only the NAME of the one root organisation currently
named Hass. It does not touch the ID, slug, affiliate links, users,
subscriptions or operational records. It is intentionally separate from
migration 011 because an installation with another tenant name should
not have its names overwritten.

## Check for pre-existing affiliate-owned records

Before claiming the parent has all existing data, inspect the current
ownership. The query below is READ-ONLY:

\`\`\`sql
SELECT parent.name AS tenant, child.name AS affiliate,
       (SELECT COUNT(*) FROM stations s WHERE s.org_id = child.id) AS stations_owned_by_child,
       (SELECT COUNT(*) FROM regions r WHERE r.org_id = child.id) AS regions_owned_by_child,
       (SELECT COUNT(*) FROM assets a WHERE a.org_id = child.id) AS assets_owned_by_child,
       (SELECT COUNT(*) FROM service_requests r WHERE r.org_id = child.id) AS requests_owned_by_child,
       (SELECT COUNT(*) FROM users u WHERE u.org_id = child.id) AS users_registered_in_child
  FROM organisations child
  JOIN organisations parent ON parent.id = child.parent_org_id
 WHERE child.deleted_at IS NULL
 ORDER BY parent.name, child.name;
\`\`\`

For affiliates with nonzero child-owned operational records, the
single-tenant UI does NOT by itself migrate their data into the parent.
Review with the group owner before making any separate data migration.

## Application release gates

From \`Engr/\` run:

\`\`\`sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run test
pnpm run lint
pnpm run format:check
pnpm run db:schema:check
\`\`\`

Then deploy the existing Cloudflare Worker and verify:

- Tenant switcher lists only top-level tenants, not Hass Kenya/Uganda.
- Hass Group remains visible as the single parent after the optional rename.
- Affiliate edit shows Code, Name, Country, Currency and Status across one
  desktop row, wrapping at smaller screen widths.
- Station and Region forms show affiliate choices only from Hass Group.
- Station Region choices respond to affiliate changes, and API submissions
  reject mismatched/foreign IDs.
- Changing a region affiliate updates linked stations and audit history,
  preserving their tenant org_id and codes.
- Existing Hass Group user sessions and permissions remain valid.

No other repo folders or applications are affected.
