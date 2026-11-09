import type { Client } from '@libsql/client';

/** Read-only checks for relational integrity and canonical user identities.
 * Foreign keys alone do not prevent a row from referencing another tenant. */
export async function auditIntegrity(db: Client): Promise<Record<string, number>> {
  const foreignKeys = await db.execute('PRAGMA foreign_key_check');
  const [duplicateEmails, noncanonicalEmails, crossOrgRoles, crossOrgEngineers, crossOrgStations] =
    await db.batch(
      [
        `SELECT COUNT(*) AS n FROM (
           SELECT lower(trim(email)) FROM users
            GROUP BY lower(trim(email)) HAVING COUNT(*) > 1
         )`,
        `SELECT COUNT(*) AS n FROM users WHERE email <> lower(trim(email))`,
        `SELECT COUNT(*) AS n FROM user_roles ur
           JOIN users u ON u.id = ur.user_id JOIN roles r ON r.id = ur.role_id
          WHERE r.org_id IS NOT NULL AND r.org_id <> u.org_id`,
        `SELECT COUNT(*) AS n FROM engineer_assignments a
           JOIN users u ON u.id = a.engineer_user_id
          WHERE a.org_id <> u.org_id`,
        `SELECT COUNT(*) AS n FROM stations s
           JOIN users u ON u.id = s.station_manager_id
          WHERE s.org_id <> u.org_id`,
      ],
      'read',
    );
  return {
    foreignKeyViolations: foreignKeys.rows.length,
    duplicateCanonicalEmails: Number(duplicateEmails.rows[0]?.n ?? 0),
    noncanonicalEmails: Number(noncanonicalEmails.rows[0]?.n ?? 0),
    crossOrgRoles: Number(crossOrgRoles.rows[0]?.n ?? 0),
    crossOrgEngineers: Number(crossOrgEngineers.rows[0]?.n ?? 0),
    crossOrgStationManagers: Number(crossOrgStations.rows[0]?.n ?? 0),
  };
}
