/**
 * SandboxDemo — STUBBED Labs island.
 *
 * Deliberately contains no demo logic (out of scope for the framework build).
 * Its only job is to prove the React integration + hydration boundary works on
 * /labs. Real interactive demos arrive in a later prompt. Styling uses the same
 * Tailwind tokens as the rest of the site (global stylesheet is already loaded).
 */
export default function SandboxDemo() {
  return (
    <div className="w-full max-w-md text-center">
      <p className="text-base font-medium text-navy">Labs sandbox</p>
      <p className="mt-1 text-sm text-slate">
        This React island is wired and hydrated — interactive demos will be built here next.
      </p>
      <button
        type="button"
        disabled
        aria-disabled="true"
        title="Coming soon"
        className="mt-4 inline-flex min-h-[2.75rem] cursor-not-allowed items-center justify-center rounded-btn bg-navy px-5 py-2.5 font-medium text-white opacity-60"
      >
        Run demo (coming soon)
      </button>
    </div>
  );
}
