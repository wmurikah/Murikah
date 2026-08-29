import type { Client } from '@libsql/client/web';
import { newId } from './authRecords.ts';
import { toDbTimestamp } from '../auth/session.ts';
import type { IdentityProvider, OidcPurpose } from '../auth/oidc.ts';

export async function createOidcTransaction(
  db: Client,
  input: {
    provider: IdentityProvider;
    purpose: OidcPurpose;
    stateHash: string;
    nonceHash: string;
    verifier: string;
    returnPath: string;
    now: Date;
  },
) {
  await db.execute({
    sql: `INSERT INTO auth_oidc_transactions(transaction_id,provider,purpose,state_hash,nonce_hash,pkce_verifier,return_path,created_at,expires_at,consumed_at) VALUES(?,?,?,?,?,?,?,?,?,NULL)`,
    args: [
      newId('OIDC'),
      input.provider,
      input.purpose,
      input.stateHash,
      input.nonceHash,
      input.verifier,
      input.returnPath,
      toDbTimestamp(input.now),
      toDbTimestamp(new Date(input.now.getTime() + 10 * 60_000)),
    ],
  });
}

export async function consumeOidcTransaction(db: Client, stateHash: string, now: Date) {
  const result = await db.execute({
    sql: `UPDATE auth_oidc_transactions
          SET consumed_at=?
          WHERE state_hash=? AND consumed_at IS NULL AND expires_at>?
          RETURNING provider,purpose,nonce_hash,pkce_verifier,return_path`,
    args: [toDbTimestamp(now), stateHash, toDbTimestamp(now)],
  });
  const row = result.rows[0];
  if (!row) return null;
  return {
    provider: String(row.provider) as IdentityProvider,
    purpose: String(row.purpose) as OidcPurpose,
    nonceHash: String(row.nonce_hash),
    verifier: String(row.pkce_verifier),
    returnPath: String(row.return_path),
  };
}
