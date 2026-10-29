/**
 * The counting harness behind the subrequest budget test.
 *
 * WHY IT EXISTS. Cloudflare's Free plan allows 50 outbound subrequests per
 * request, and `@libsql/client/web` spends one per `execute()`. Nothing in the
 * type system, the linter or the existing tests can see that number, so a page
 * can be committed at 237 subrequests, pass every test, deploy, and fail on the
 * 51st call with a stack trace inside the client. That is exactly what happened
 * to the executive dashboard.
 *
 * The count is what the platform limits, so the count is what a test has to
 * assert. This wrapper reports it: an `execute()` is one round trip, a
 * `batch()` of any size is also one, which is precisely how Cloudflare counts.
 */
import type { TestClient } from './db.ts';

export interface CountedClient {
  /** Hand this to the code under test. */
  readonly db: TestClient;
  /** Outbound round trips: one per execute, one per batch of any size. */
  roundTrips(): number;
  /** Statements carried, so a test can report the ratio a page achieves. */
  statements(): number;
  reset(): void;
}

export function countRoundTrips(inner: TestClient): CountedClient {
  let trips = 0;
  let statements = 0;
  const db = {
    raw: inner.raw,
    close: () => inner.close(),
    async execute(stmt: Parameters<TestClient['execute']>[0]) {
      trips += 1;
      statements += 1;
      return inner.execute(stmt);
    },
    async batch(stmts: Parameters<TestClient['batch']>[0], mode?: string) {
      trips += 1;
      statements += stmts.length;
      return inner.batch(stmts, mode);
    },
  } as TestClient;
  return {
    db,
    roundTrips: () => trips,
    statements: () => statements,
    reset: () => {
      trips = 0;
      statements = 0;
    },
  };
}

/**
 * The budget every analytics page is held to.
 *
 * FIFTEEN, NOT FIFTY. The platform limit is a cliff, not a gradient: at 49 a
 * page works and at 51 it does not load at all. A page sitting just under the
 * limit is one new panel, or one new affiliate, away from an outage that will
 * look like a database fault. Fifteen leaves room for a page to grow by a
 * factor of three before anybody has to think about this again.
 */
export const SUBREQUEST_BUDGET = 15;

/** The platform's own limit, for the message when a page blows past it. */
export const CLOUDFLARE_FREE_SUBREQUEST_LIMIT = 50;
