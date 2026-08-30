/**
 * Set the initial password for an EXISTING CMS user.
 *
 * Run:  pnpm db:cms:bootstrap-admin
 * (loads .dev.vars if present, else uses process.env), following the same shape
 * as db:engr:bootstrap.
 *
 * The seeded credentials are deliberately unusable placeholders of the form
 * `$argon2id$DEMO_DISABLED$...`, so no seeded user can sign in until this has
 * run for them. That is the intent, not a defect.
 *
 * Inputs, never on the command line:
 *   CMS_BOOTSTRAP_EMAIL     the target user's email (or pass it as argv[2])
 *   CMS_BOOTSTRAP_PASSWORD  the new password; if unset, prompted with echo off
 *   CMS_BOOTSTRAP_MUST_CHANGE  '1' (default) or '0'
 *
 * A password passed as an argument would land in shell history and in the
 * process table, so this command does not accept one there. Only the email may
 * be an argument.
 *
 * This command never creates a user and never inserts into `users`. It refuses
 * a user who is not ACTIVE or whose email is unverified. It grants nothing: it
 * writes exactly one auth_credentials row and one audit event, and it has no
 * option to alter a role.
 */
import { createClient } from '@libsql/client/web';
import { createInterface } from 'node:readline';
// Relative import: node does not resolve the tsconfig alias. The same module
// the API uses, so the bootstrap and login cannot drift apart on parameters.
import {
  hashPassword,
  PASSWORD_ALGORITHM_PBKDF2,
  PBKDF2_ITERATIONS,
} from '../../src/lib/cms/auth/password.ts';
import { upsertCredential, recordAuditEvent } from '../../src/lib/cms/repos/authRecords.ts';

const url = process.env.TURSO_CMS_DATABASE_URL;
const authToken = process.env.TURSO_CMS_AUTH_TOKEN;

if (!url) {
  console.error('✗ TURSO_CMS_DATABASE_URL is not set. Add it to .dev.vars or your environment.');
  process.exit(1);
}

const email = (process.argv[2] ?? process.env.CMS_BOOTSTRAP_EMAIL ?? '').trim().toLowerCase();
if (!email) {
  console.error(
    '✗ No target email. Pass it as an argument or set CMS_BOOTSTRAP_EMAIL.\n' +
      '  pnpm db:cms:bootstrap-admin catherine.mwangi@hasspetroleum.com',
  );
  process.exit(1);
}

/** Read a password without echoing it. Never printed, never logged. */
async function promptForPassword(): Promise<string> {
  if (process.env.CMS_BOOTSTRAP_PASSWORD) return process.env.CMS_BOOTSTRAP_PASSWORD;
  if (!process.stdin.isTTY) {
    console.error(
      '✗ No password. Set CMS_BOOTSTRAP_PASSWORD, or run this in a terminal to be prompted.',
    );
    process.exit(1);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // Suppress the echo: the output stream swallows everything written while the
  // question is open, so nothing appears on screen or in a scrollback buffer.
  const output = rl as unknown as {
    output: NodeJS.WriteStream;
    _writeToOutput: (s: string) => void;
  };
  const original = output._writeToOutput.bind(output);
  output._writeToOutput = (chunk: string) => {
    if (chunk.includes('New password')) original(chunk);
  };
  const answer = await new Promise<string>((resolve) => {
    rl.question('New password (not echoed): ', (value) => resolve(value));
  });
  output._writeToOutput = original;
  rl.close();
  process.stdout.write('\n');
  return answer;
}

const password = await promptForPassword();
if (password.length < 12) {
  // A length check, not a strength lecture, and it never repeats the input.
  console.error('✗ The password must be at least 12 characters. Nothing was written.');
  process.exit(1);
}

const mustChange = (process.env.CMS_BOOTSTRAP_MUST_CHANGE ?? '1') !== '0';

const client = createClient({ url, authToken });
await client.execute('PRAGMA foreign_keys = ON;');

// 1. The user must already exist. This command never creates one.
const found = await client.execute({
  sql: `SELECT user_id, display_name, status, email_verified_at FROM users WHERE email = ? LIMIT 1`,
  args: [email],
});
const user = found.rows[0];
if (!user) {
  console.error(`✗ No user with that email. This command never creates one.`);
  process.exit(1);
}
if (String(user.status) !== 'ACTIVE') {
  console.error(`✗ That user is ${String(user.status)}, not ACTIVE. Nothing was written.`);
  process.exit(1);
}
if (!user.email_verified_at) {
  console.error('✗ That user has no verified email. Nothing was written.');
  process.exit(1);
}

const userId = String(user.user_id);
const now = new Date();

// 2. Hash with the same module the API verifies with.
const passwordHash = await hashPassword(password);

// 3. One credential row per user (auth_credentials.user_id is UNIQUE), so this
//    updates the existing row or inserts the only one. Resets failed_attempts
//    and clears locked_until as part of the same write.
const action = await upsertCredential(client, {
  userId,
  passwordHash,
  algorithm: PASSWORD_ALGORITHM_PBKDF2,
  mustChangePassword: mustChange,
  now,
});

// 4. The audit trail records that a credential was set, never what it was.
await recordAuditEvent(client, {
  actorUserId: userId,
  eventType: 'ADMIN_CREDENTIAL_BOOTSTRAPPED',
  entityType: 'auth_credentials',
  entityId: userId,
  action: action === 'inserted' ? 'CREATE' : 'UPDATE',
  afterJson: JSON.stringify({
    password_algorithm: PASSWORD_ALGORITHM_PBKDF2,
    iterations: PBKDF2_ITERATIONS,
    must_change_password: mustChange,
  }),
  ip: null,
  userAgent: 'db:cms:bootstrap-admin',
  now,
});

console.log(`✓ Credential ${action} for ${String(user.display_name)} (${userId}).`);
console.log(`  algorithm=${PASSWORD_ALGORITHM_PBKDF2} iterations=${PBKDF2_ITERATIONS}`);
console.log(`  must_change_password=${mustChange ? 1 : 0}, failed_attempts reset, lock cleared.`);
console.log('  No role was granted or changed.');
