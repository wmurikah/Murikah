/**
 * Shared environment loader for the database scripts (apply, seed, reset).
 *
 * Resolution rule: the shell/CI environment wins. We read process.env first and
 * only fall back to a local `.dev.vars` file for any variable that is not
 * already set, so the same commands work locally (with .dev.vars) and in CI
 * (with repository secrets and no .dev.vars present). Credentials are never
 * hardcoded and never printed.
 *
 * These scripts run in Node, so they use the Node entry point of @libsql/client
 * (which supports executeMultiple). The application's Worker code continues to
 * use @libsql/client/web and is untouched.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { createClient, type Client } from '@libsql/client';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Load .dev.vars as a fallback, without overriding existing env values. */
function loadDevVars(): void {
  const path = join(ROOT, '.dev.vars');
  if (!existsSync(path)) return;
  const parsed = parse(readFileSync(path));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDevVars();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(
      `✗ ${name} is not set. Add it to .dev.vars in the project root, or export it in your shell.`,
    );
    process.exit(1);
  }
  return value;
}

export const TURSO_DATABASE_URL = required('TURSO_DATABASE_URL');
export const TURSO_AUTH_TOKEN = required('TURSO_AUTH_TOKEN');

/** A configured Node libSQL client, shared by every database script. */
export function createDbClient(): Client {
  return createClient({ url: TURSO_DATABASE_URL, authToken: TURSO_AUTH_TOKEN });
}
