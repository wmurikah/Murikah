-- Read-only Turso Web check. Password hashes are never selected.
-- After the Worker fix is deployed, accounts listed here must use password
-- recovery or an administrator-issued temporary password before signing in.
SELECT u.full_name,
       u.email,
       o.name AS organisation,
       CAST(substr(u.password_hash, 8, instr(substr(u.password_hash, 8), '$') - 1) AS INTEGER)
         AS pbkdf2_iterations
  FROM users AS u
  JOIN organisations AS o ON o.id = u.org_id
 WHERE u.deleted_at IS NULL
   AND u.password_hash LIKE 'pbkdf2$%'
   AND CAST(substr(u.password_hash, 8, instr(substr(u.password_hash, 8), '$') - 1) AS INTEGER) > 100000
 ORDER BY o.name, u.full_name;
