/** Shared integration fixture: reviewed schema only, never a live database.
 * Edit db/schema/cms.sql and regenerate the compatibility contract together. */
import { readFileSync } from 'node:fs';
export const AUTH_SCHEMA_DDL = readFileSync(
  new URL('../../../db/schema/cms.sql', import.meta.url),
  'utf8',
);
