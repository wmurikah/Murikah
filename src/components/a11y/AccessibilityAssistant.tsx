/**
 * AccessibilityAssistant, a small first-party reading-and-motion helper.
 *
 * This is a convenience layer, not a substitute for the site being accessible by
 * default. It lets a visitor nudge a few things to their comfort: text size,
 * higher contrast, reduced motion, clearer links and a stronger focus ring.
 * Choices are applied as classes and a data attribute on <html> and remembered
 * in localStorage, so they survive navigation and reloads. The same settings
 * are applied before first paint by a tiny inline script in BaseLayout, so there
 * is no flash of the default state.
 *
 * It is a non-modal disclosure (no focus trap): Escape or a click outside
 * closes it, and focus returns to the toggle. Everything is real buttons with
 * clear labels and pressed state.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import './AccessibilityAssistant.css';

const STORAGE_KEY = 'murikah-a11y';
const TEXT_STEPS = ['Default', 'Large', 'Larger', 'Largest', 'Maximum'];
const MAX_TEXT = TEXT_STEPS.length - 1;

interface A11yState {
  text: number;
  contrast: boolean;
  motion: boolean;
  links: boolean;
  focus: boolean;
}

const DEFAULTS: A11yState = { text: 0, contrast: false, motion: false, links: false, focus: false };

function readState(): A11yState {
  if (typeof window === 'undefined') return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const p = JSON.parse(raw);
    return {
      text: Math.min(MAX_TEXT, Math.max(0, Number(p.text) || 0)),
      contrast: !!p.contrast,
      motion: !!p.motion,
      links: !!p.links,
      focus: !!p.focus,
    };
  } catch {
    return DEFAULTS;
  }
}

/** Apply state to <html>. Kept in step with the inline script in BaseLayout. */
function applyState(s: A11yState) {
  const root = document.documentElement;
  if (s.text > 0) root.dataset.a11yText = String(s.text);
  else root.removeAttribute('data-a11y-text');
  root.classList.toggle('a11y-high-contrast', s.contrast);
  root.classList.toggle('a11y-reduce-motion', s.motion);
  root.classList.toggle('a11y-highlight-links', s.links);
  root.classList.toggle('a11y-strong-focus', s.focus);
}

export default function AccessibilityAssistant() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<A11yState>(DEFAULTS);

  const panelRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const firstControlRef = useRef<HTMLButtonElement>(null);

  // Reflect any stored settings in the controls once mounted (the DOM itself is
  // already set by the inline script in BaseLayout).
  useEffect(() => {
    setState(readState());
  }, []);

  const update = useCallback((patch: Partial<A11yState>) => {
    setState((prev) => {
      const next = { ...prev, ...patch };
      applyState(next);
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* storage may be unavailable; settings still apply for this session */
      }
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    applyState(DEFAULTS);
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    setState(DEFAULTS);
  }, []);

  // Escape to close, and click outside to close. Non-modal, so no focus trap.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        toggleRef.current?.focus();
      }
    };
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || toggleRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  // Move focus into the panel when it opens, for keyboard users.
  useEffect(() => {
    if (open) firstControlRef.current?.focus();
  }, [open]);

  const anyOn = state.text > 0 || state.contrast || state.motion || state.links || state.focus;

  return (
    <div className="a11y" data-open={open}>
      {open && (
        <div ref={panelRef} className="a11y__panel" role="group" aria-label="Accessibility tools">
          <div className="a11y__head">
            <p className="a11y__title">Accessibility</p>
            <button
              type="button"
              className="a11y__close"
              aria-label="Close accessibility tools"
              onClick={() => {
                setOpen(false);
                toggleRef.current?.focus();
              }}
            >
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
                <path
                  d="M4 4l8 8M12 4l-8 8"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>

          <div className="a11y__row">
            <span className="a11y__label" id="a11y-text-label">
              Text size
            </span>
            <div className="a11y__stepper" aria-labelledby="a11y-text-label">
              <button
                ref={firstControlRef}
                type="button"
                className="a11y__step"
                aria-label="Decrease text size"
                disabled={state.text <= 0}
                onClick={() => update({ text: Math.max(0, state.text - 1) })}
              >
                <span aria-hidden="true">A&minus;</span>
              </button>
              <span className="a11y__stepvalue" aria-live="polite">
                {TEXT_STEPS[state.text]}
              </span>
              <button
                type="button"
                className="a11y__step"
                aria-label="Increase text size"
                disabled={state.text >= MAX_TEXT}
                onClick={() => update({ text: Math.min(MAX_TEXT, state.text + 1) })}
              >
                <span aria-hidden="true">A+</span>
              </button>
            </div>
          </div>

          <ToggleRow
            label="High contrast"
            pressed={state.contrast}
            onToggle={() => update({ contrast: !state.contrast })}
          />
          <ToggleRow
            label="Reduce motion"
            pressed={state.motion}
            onToggle={() => update({ motion: !state.motion })}
          />
          <ToggleRow
            label="Highlight links"
            pressed={state.links}
            onToggle={() => update({ links: !state.links })}
          />
          <ToggleRow
            label="Stronger focus"
            pressed={state.focus}
            onToggle={() => update({ focus: !state.focus })}
          />

          <button type="button" className="a11y__reset" onClick={reset} disabled={!anyOn}>
            Reset all
          </button>
        </div>
      )}

      <button
        ref={toggleRef}
        type="button"
        className="a11y__toggle"
        aria-label="Accessibility tools"
        aria-expanded={open}
        aria-haspopup="true"
        data-active={anyOn}
        onClick={() => setOpen((o) => !o)}
      >
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
          <circle cx="12" cy="4" r="1.9" fill="currentColor" />
          <path
            d="M4 8.5c2.6 1 5.2 1.5 8 1.5s5.4-.5 8-1.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          <path
            d="M12 9.5V15m0 0l-2.8 5.5M12 15l2.8 5.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  );
}

function ToggleRow({
  label,
  pressed,
  onToggle,
}: {
  label: string;
  pressed: boolean;
  onToggle: () => void;
}) {
  return (
    <button type="button" className="a11y__toggleRow" aria-pressed={pressed} onClick={onToggle}>
      <span className="a11y__label">{label}</span>
      <span className="a11y__switch" aria-hidden="true">
        <span className="a11y__knob" />
      </span>
    </button>
  );
}
