/**
 * The one busy-button pattern, shared instead of hand-rolled.
 *
 * WHAT AN ACTION IN FLIGHT LOOKS LIKE: the triggering button is disabled — a
 * second click on "Save" must not become a second save — it says what it is
 * doing in words ("Saving…", never a percentage nobody measured), and it
 * carries aria-busy for anyone listening rather than looking. The returned
 * function is the ONLY way back: call it in `finally` so the button is
 * restored on failure and on stay-on-page success alike, and a handler that
 * navigates away on success simply never calls it.
 *
 * This is client-side code, imported by component <script> blocks. It touches
 * one button; it never overlays a region, never blocks the page, and never
 * invents progress. The label is passed by the caller because "Saving…",
 * "Sending…" and "Testing…" are statements about the action, not the button.
 */
export function busy(button: HTMLButtonElement | null, label: string): () => void {
  if (!button || button.disabled) return () => {};
  const original = Array.from(button.childNodes);
  const spinner = document.createElement('span');
  spinner.className =
    'h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none';
  spinner.setAttribute('aria-hidden', 'true');
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.classList.add('cursor-progress');
  button.replaceChildren(spinner, document.createTextNode(label));
  return () => {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.classList.remove('cursor-progress');
    button.replaceChildren(...original);
  };
}
