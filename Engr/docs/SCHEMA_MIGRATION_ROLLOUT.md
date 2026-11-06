# Engineering schema migration rollout

The numbered files in `db/migrations` are the Engineering database source of truth. `db/schema.sql` is generated from those migrations for review and tooling; do not edit it directly.

## What migration 002 reconciles

- `lpo_lines` and its LPO index.
- Affiliate hierarchy through `organisations.parent_org_id`.
- Region currency.
- Platform-owner identity.
- The 15 versioned LPO approval, issue, sealing, supersession, cancellation, subtotal, and mileage fields.
- Parent-organisation, LPO-region, system-role, and global-user-email indexes.

The migration is additive and preserves existing rows. Every migration and its history record commit in one transaction. Applied checksums are verified so an old migration cannot be silently edited.

## Before production

1. Create or confirm a recent Turso backup/replica.
2. Check for identities that would prevent the two unique indexes:

   ```sql
   SELECT email, COUNT(*) AS occurrences
   FROM users
   GROUP BY email
   HAVING COUNT(*) > 1;

   SELECT code, COUNT(*) AS occurrences
   FROM roles
   WHERE org_id IS NULL
   GROUP BY code
   HAVING COUNT(*) > 1;
   ```

3. Both queries must return no rows. Resolve any duplicates before migration.
4. Test the application against a non-production branch/replica when one is available.

## Apply

From `Engr`, with `TURSO_ENGR_DATABASE_URL` and `TURSO_ENGR_AUTH_TOKEN` in `.dev.vars` or the shell environment:

```bash
pnpm db:apply
```

Expected output on the first managed run:

```text
✓ Applied migrations: 001, 002, 003, 004, 005
✓ Engineering schema contract verified at libsql://…
```

An already-expanded live database still records both migrations after checking/reconciling every object. A repeat run reports no pending migrations and verifies the contract again.

The Turso web SQL console cannot provide the conditional, checksum-verified migration behavior safely. Run the repository command rather than pasting only part of migration 002 into the console.

## Verify

```sql
SELECT id, description, checksum, applied_at
FROM schema_migrations
ORDER BY id;

SELECT COUNT(*) AS foreign_key_violations
FROM pragma_foreign_key_check;
```

The history must contain `001` through `005`, and `foreign_key_violations` must be `0`. The migration command also runs the complete table/column/index/view/trigger contract check before reporting success.

## Future schema changes

1. Add a new immutable numbered migration.
2. Add its contract requirements and blank/upgrade tests.
3. Run `pnpm db:schema:generate`.
4. Run `pnpm db:schema:check` and the test suite.
5. Commit the migration and generated `db/schema.sql` together.

Never modify an applied migration. The checksum guard intentionally blocks that history rewrite.
