# Zambia Supply owner rollout

This rollout names the Loading Authority generation function **Supply** and
attributes its operational completions to the configured accountable owner.
The sales-order extract supplies the completion timestamp but does not contain
a Supply performer column.

## 1. Confirm the live records

Run this in Turso before the migration. It must return one HPZ affiliate and
one active Omar Saad user. The second match condition covers the source name
used by the purchase-order workbook.

```sql
SELECT 'affiliate' AS kind, a.affiliate_id AS id, a.affiliate_name AS value
FROM affiliates a
WHERE a.affiliate_code = 'HPZ'
UNION ALL
SELECT 'owner', u.user_id, u.display_name
FROM users u
WHERE u.status = 'ACTIVE'
  AND (
    lower(trim(u.display_name)) = 'omar saad'
    OR EXISTS (
      SELECT 1
      FROM source_identities si
      WHERE si.user_id = u.user_id AND si.active = 1
        AND lower(trim(si.external_username)) = 'mr. salim omar saad'
    )
  );
```

Do not continue if there is no owner row or if more than one person is Omar
Saad. Resolve the user record first so accountability is unambiguous.

## 2. Apply the configuration

Run [`008_zambia_supply_owner.sql`](../../db/migrations/008_zambia_supply_owner.sql)
in the Turso SQL console. It deliberately contains no `BEGIN` or `COMMIT`, so
Drizzle Studio can run the statements as its own batch. The script is
idempotent.

## 3. Validate the assignment

This must return one active row for Omar Saad at HPZ.

```sql
SELECT wr.role_code, wr.role_name, u.user_id, u.display_name,
       wra.scope_type, a.affiliate_code, wra.effective_from,
       wra.effective_to, wra.active
FROM workflow_role_assignments wra
JOIN workflow_roles wr ON wr.workflow_role_id = wra.workflow_role_id
JOIN users u ON u.user_id = wra.user_id
LEFT JOIN affiliates a ON a.affiliate_id = wra.affiliate_id
WHERE wr.role_code = 'SO_SUPPLY_OWNER';
```

## 4. Deploy and verify

Deploy the application change, then open Home for July 2026 and select HPZ.
The third function is labelled **Supply**, its child row is **Omar Saad**, and
the period includes all 31 sales orders in the uploaded Zambia file, including
the seven Loading Authority completions recorded on 31 July.

The Supply duration remains unjudged against the signed ten-minute SLA until
the source captures when funds or the LPO were received. This rollout changes
accountability and period completeness; it does not invent that missing SLA
start event.
