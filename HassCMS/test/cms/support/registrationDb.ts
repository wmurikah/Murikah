import { createTestDb, type TestClient } from './db.ts';

type Statement = Parameters<TestClient['execute']>[0];

/** Real SQLite transactions over the observed registration schema. */
export function createRegistrationDb() {
  const db = createTestDb();
  let tail = Promise.resolve();
  return {
    ...db,
    async transaction(mode: string) {
      if (mode !== 'write') throw new Error('Expected write transaction');
      const previous = tail;
      let release = () => {};
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        db.raw.exec('BEGIN IMMEDIATE');
      } catch (error) {
        release();
        throw error;
      }
      let closed = false;
      const finish = (sql: string) => {
        if (closed) return;
        db.raw.exec(sql);
        closed = true;
        release();
      };
      return {
        get closed() {
          return closed;
        },
        async execute(statement: Statement) {
          if (closed) throw new Error('Transaction is closed');
          return db.execute(statement);
        },
        async commit() {
          finish('COMMIT');
        },
        async rollback() {
          finish('ROLLBACK');
        },
        close() {
          finish('ROLLBACK');
        },
      };
    },
  };
}
