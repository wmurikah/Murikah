/**
 * The AI feature gate. The whole module is available only when the acting
 * organisation's plan includes the AI feature. A platform owner is entitled to
 * everything through the hasFeature seam. Import-free.
 */

/** Whether the AI assistance module is enabled for the caller's plan. */
export function aiEnabled(hasFeature: (flag: string) => boolean): boolean {
  return hasFeature('ai') || hasFeature('ai_assistance');
}
