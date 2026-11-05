import type { InStatement, ResultSet } from '@libsql/client';

/** The subset shared by a libSQL Client and an open Transaction. */
export interface MigrationDatabase {
  execute(statement: InStatement): Promise<ResultSet>;
  executeMultiple(sql: string): Promise<void>;
}

export interface Migration {
  id: string;
  description: string;
  checksum: string;
  up(db: MigrationDatabase): Promise<void>;
}
