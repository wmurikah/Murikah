import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Migration } from './types.ts';

export const passwordSessionVersion: Migration = {
  id: '003',
  description: 'Add password session generation for immediate session revocation',
  checksum: createHash('sha256')
    .update(readFileSync(new URL(import.meta.url)))
    .digest('hex'),
  async up(db) {
    const result = await db.execute('PRAGMA table_info(users)');
    const exists = result.rows.some((row) => String(row.name) === 'session_version');
    if (!exists) {
      await db.execute('ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0');
    }
  },
};
