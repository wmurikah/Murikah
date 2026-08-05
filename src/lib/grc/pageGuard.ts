/**
 * The per-route error boundary for GRC pages (Build Prompt 22). A page wraps its
 * frontmatter data load in guardPageLoad so a query error becomes a logged,
 * branded inline error card inside the shell, never a blank 500: the cause is
 * written to the Worker log with a `[grc.<tag>]` tag and the stack, and the page
 * renders <GrcErrorCard /> in place of the broken section. The middleware carries
 * the last-resort boundary for anything a page does not catch.
 */

/**
 * Run a page's data load, logging any failure under `[grc.<tag>]` with its
 * stack. Returns true when the load succeeded; the page renders its error card
 * when it did not. Never swallows silently: every failure is logged.
 */
export async function guardPageLoad(tag: string, load: () => Promise<void>): Promise<boolean> {
  try {
    await load();
    return true;
  } catch (err) {
    console.error(
      `[grc.${tag}] data load failed`,
      err instanceof Error ? (err.stack ?? err.message) : String(err),
    );
    return false;
  }
}
