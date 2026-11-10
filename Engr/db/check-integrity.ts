/** Read-only Turso integrity audit. Prints counts only, never names or secrets. */
import { createClient } from '@libsql/client';
import { auditIntegrity } from './integrity.ts';

const url = process.env.TURSO_ENGR_DATABASE_URL;
if (!url) throw new Error('Set TURSO_ENGR_DATABASE_URL before checking integrity.');
const client = createClient({ url, authToken: process.env.TURSO_ENGR_AUTH_TOKEN });
try {
  const counts = await auditIntegrity(client);
  console.log(counts);
  if (Object.values(counts).some((count) => count !== 0)) process.exitCode = 1;
} finally {
  client.close();
}
