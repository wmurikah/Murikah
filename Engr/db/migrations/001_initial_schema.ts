import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Migration } from './types.ts';

const sql = readFileSync(new URL('./001_initial_schema.sql', import.meta.url), 'utf8');

export const initialSchema: Migration = {
  id: '001',
  description: 'Initial Engineering Rhythm schema',
  checksum: createHash('sha256').update(sql).digest('hex'),
  async up(db) {
    await db.executeMultiple(sql);
  },
};
