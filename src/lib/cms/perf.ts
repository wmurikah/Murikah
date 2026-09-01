/**
 * CMS performance tracing: where a request's time went, in named phases.
 *
 * NO PACKAGE, NO SERVICE, NO SAMPLING FRAMEWORK. `performance.now()` exists in
 * the Workers runtime and in Node, and a request needs perhaps six spans. A
 * monitoring dependency would cost more to ship than this measures.
 *
 * Two consumers:
 *
 *   Server-Timing   the standard response header, so browser DevTools shows
 *                   server phases beside the network waterfall with no
 *                   tooling installed. Durations only — the header crosses
 *                   the wire, so nothing sensitive may ride in it.
 *
 *   [cms.perf] log  one structured line for an unusually slow request, so
 *                   Workers Logs can answer "which path, which phase" in
 *                   production without anyone attaching a debugger.
 *
 * WHAT IS NEVER RECORDED: cookies, tokens, passwords, SQL text, SQL
 * parameters, user or customer identifiers, request bodies. A span is a NAME
 * and a NUMBER, and the name comes from code, not from data.
 *
 * WHAT THE NUMBERS MEAN. A phase measures until the server response object
 * exists — with a streamed body, work done while streaming is not included.
 * That is the honest boundary available without breaking streaming, and it is
 * the part of the wait the server can actually shorten.
 */

export interface CmsTrace {
  /** Start a named span; returns a function that ends it. Re-entrant safe. */
  begin(name: string): () => void;
  /** Measure one async unit of work under a name. */
  span<T>(name: string, work: () => Promise<T>): Promise<T>;
  /** Add an already-measured duration, for code that timed itself. */
  add(name: string, durationMs: number): void;
  /** Every recorded span, in recording order. */
  spans(): readonly { name: string; dur: number }[];
  /** Milliseconds since the trace began. */
  total(): number;
}

/** Slower than this, and the request earns a [cms.perf] log line. */
export const SLOW_REQUEST_MS = 750;

export function startTrace(): CmsTrace {
  const t0 = performance.now();
  const recorded: { name: string; dur: number }[] = [];

  const add = (name: string, durationMs: number): void => {
    // One entry per name: a phase that runs twice reports its sum, because
    // "db;dur=130" should mean the database cost 130ms, not "the last batch
    // cost 130ms and the reader has to know there were three".
    const existing = recorded.find((span) => span.name === name);
    if (existing) existing.dur += durationMs;
    else recorded.push({ name, dur: durationMs });
  };

  return {
    begin(name) {
      const started = performance.now();
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        add(name, performance.now() - started);
      };
    },
    async span(name, work) {
      const end = this.begin(name);
      try {
        return await work();
      } finally {
        end();
      }
    },
    add,
    spans: () => recorded,
    total: () => performance.now() - t0,
  };
}

/**
 * The Server-Timing header value: names and durations, nothing else.
 *
 * Names are constrained to the token characters the header grammar allows and
 * that this codebase uses, so a malformed name cannot smuggle a delimiter.
 */
export function serverTimingValue(trace: CmsTrace): string {
  return trace
    .spans()
    .filter((span) => /^[a-z][a-z0-9._-]*$/i.test(span.name))
    .map((span) => `${span.name};dur=${Math.round(span.dur)}`)
    .join(', ');
}

/**
 * The one line a slow request logs. Path and numbers — the path is the
 * ROUTE a person typed, which the access log already carries, and never a
 * query string, which is where identifiers live.
 */
export function slowRequestLine(path: string, trace: CmsTrace): string {
  const phases = trace
    .spans()
    .map((span) => `${span.name}=${Math.round(span.dur)}`)
    .join(' ');
  return `[cms.perf] path=${path.split('?')[0]} total=${Math.round(trace.total())} ${phases}`;
}
