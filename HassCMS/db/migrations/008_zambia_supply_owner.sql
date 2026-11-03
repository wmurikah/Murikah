-- Supply owns Loading Authority generation. The SALES extract records the
-- completion timestamp but has no performer column, so dashboard attribution
-- is read from this reviewed workflow-role assignment.
--
-- Drizzle Studio runs the statements as a batch. Do not add BEGIN/COMMIT.

INSERT OR IGNORE INTO workflow_roles
  (workflow_role_id, role_code, role_name, process_type, description, active, created_at)
VALUES
  ('WROLE-SO-SUP', 'SO_SUPPLY_OWNER', 'SO Supply Owner', 'SALES_ORDER',
   'Accountable owner for Supply and Loading Authority generation', 1, CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO workflow_role_assignments
  (workflow_role_assignment_id, workflow_role_id, user_id, scope_type,
   country_id, affiliate_id, business_unit_id, priority,
   effective_from, effective_to, active, created_at)
SELECT
  'WRA-SO-SUP-HPZ', 'WROLE-SO-SUP', u.user_id, 'AFFILIATE',
  NULL, a.affiliate_id, NULL, 10,
  '2026-01-01', NULL, 1, CURRENT_TIMESTAMP
FROM users u
JOIN affiliates a ON a.affiliate_code = 'HPZ'
WHERE u.status = 'ACTIVE'
  AND (
    lower(trim(u.display_name)) = 'omar saad'
    OR EXISTS (
      SELECT 1
      FROM source_identities si
      WHERE si.user_id = u.user_id AND si.active = 1
        AND lower(trim(si.external_username)) = 'mr. salim omar saad'
    )
  )
ORDER BY CASE WHEN lower(trim(u.display_name)) = 'omar saad' THEN 0 ELSE 1 END,
         u.user_id
LIMIT 1;
