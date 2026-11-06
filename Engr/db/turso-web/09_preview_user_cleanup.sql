-- Preview only. This changes nothing.
-- Expected: exactly six KEEP rows for the approved accounts. Every DELETE row
-- will be physically removed by 10_delete_operational_data_and_unapproved_users.sql.
WITH approved(email) AS (
  VALUES
    ('paul.mweki@hasspetroleum.com'),
        ('scaver.rayasi@hasspetroleum.com'),
    ('wickliffe.opiyo@hasspetroleum.com'),
    ('wilberforce.murikah@hasspetroleum.com'),
    ('kennedy.masoni@hasspetroleum.com'),
    ('jeff.obuo@hasspetroleum.com')
)
SELECT
  CASE WHEN approved.email IS NULL THEN 'DELETE' ELSE 'KEEP' END AS action,
  users.full_name,
  users.email,
  users.status,
  organisations.name AS organisation
FROM users
JOIN organisations ON organisations.id = users.org_id
LEFT JOIN approved ON approved.email = lower(trim(users.email))
WHERE users.deleted_at IS NULL
ORDER BY action DESC, users.full_name;
