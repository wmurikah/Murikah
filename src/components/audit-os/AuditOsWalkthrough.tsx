/**
 * Assurance OS workflow walkthrough. A self-advancing, controllable, accessible
 * walkthrough of the six workflow stages. It auto-plays (about 17s per stage,
 * roughly 1m 45s in full) and loops gently, with clickable stage tabs, a
 * play/pause control and a progress bar. Each active stage animates a small,
 * on-brand SVG (gold as the single accent).
 *
 * Accessibility: respects prefers-reduced-motion (renders static steps with no
 * auto-play or motion), full keyboard operation (buttons activate on Enter or
 * Space), visible focus, and an ARIA live region announcing the active stage.
 * Auto-play pauses when the component is off-screen or the tab is hidden.
 */
import { useEffect, useRef, useState } from 'react';
import './AuditOsWalkthrough.css';

interface Stage {
  key: string;
  label: string;
  line: string;
}

const STAGES: Stage[] = [
  { key: 'plan', label: 'Plan', line: 'Set the risk-based audit plan and scope.' },
  { key: 'fieldwork', label: 'Fieldwork', line: 'Capture work papers and evidence as you test.' },
  { key: 'review', label: 'Review', line: 'A reviewer checks the work and signs it off.' },
  {
    key: 'findings',
    label: 'Findings',
    line: 'Raise findings with risk ratings and action plans.',
  },
  {
    key: 'remediation',
    label: 'Remediation',
    line: 'Track every action to closure, with automatic follow-up and overdue escalation.',
  },
  { key: 'report', label: 'Report', line: 'Generate the board and committee pack from live data.' },
];

// About 17 seconds per stage keeps a full play through to roughly 1m 45s.
const STAGE_MS = 17000;

function Visual({ stage }: { stage: number }) {
  switch (stage) {
    case 0: // Plan: scope tag and plan rows being set.
      return (
        <svg viewBox="0 0 220 150" className="aw-svg" aria-hidden="true">
          <rect className="sheet" x="22" y="18" width="176" height="114" rx="12" />
          <rect className="accent pop d1" x="148" y="32" width="36" height="13" rx="6" />
          <rect className="row grow-x d1" x="38" y="60" width="96" height="9" rx="4" />
          <rect className="row grow-x d2" x="38" y="80" width="126" height="9" rx="4" />
          <rect className="row grow-x d3" x="38" y="100" width="74" height="9" rx="4" />
          <rect className="row grow-x d4" x="38" y="120" width="108" height="9" rx="4" />
        </svg>
      );
    case 1: // Fieldwork: work paper being ticked.
      return (
        <svg viewBox="0 0 220 150" className="aw-svg" aria-hidden="true">
          <rect className="sheet" x="22" y="18" width="176" height="114" rx="12" />
          <rect className="row grow-x d1" x="40" y="46" width="110" height="9" rx="4" />
          <rect className="row grow-x d2" x="40" y="68" width="84" height="9" rx="4" />
          <rect className="row grow-x d3" x="40" y="90" width="120" height="9" rx="4" />
          <path className="accent-stroke draw" d="M150 104 l10 12 l22 -28" />
        </svg>
      );
    case 2: // Review: a sign-off stamp.
      return (
        <svg viewBox="0 0 220 150" className="aw-svg" aria-hidden="true">
          <rect className="sheet" x="22" y="18" width="176" height="114" rx="12" />
          <rect className="row grow-x d1" x="40" y="48" width="92" height="9" rx="4" />
          <rect className="row grow-x d2" x="40" y="70" width="62" height="9" rx="4" />
          <g className="pop d2">
            <circle className="accent-stroke" cx="150" cy="94" r="22" fill="none" />
            <path className="accent-stroke" d="M139 94 l8 9 l16 -19" />
          </g>
        </svg>
      );
    case 3: // Findings: a finding card with a risk tag.
      return (
        <svg viewBox="0 0 220 150" className="aw-svg" aria-hidden="true">
          <rect className="sheet" x="22" y="18" width="176" height="114" rx="12" />
          <rect className="row" x="40" y="44" width="66" height="9" rx="4" />
          <rect className="accent pop d1" x="138" y="40" width="44" height="16" rx="8" />
          <rect className="row grow-x d2" x="40" y="74" width="142" height="9" rx="4" />
          <rect className="row grow-x d3" x="40" y="94" width="110" height="9" rx="4" />
          <rect className="row grow-x d4" x="40" y="114" width="82" height="9" rx="4" />
        </svg>
      );
    case 4: // Remediation: an action moving to closed.
      return (
        <svg viewBox="0 0 220 150" className="aw-svg" aria-hidden="true">
          <rect className="sheet" x="22" y="18" width="176" height="114" rx="12" />
          <rect className="row grow-x d1" x="40" y="46" width="96" height="9" rx="4" />
          <rect className="track" x="40" y="78" width="140" height="11" rx="5" />
          <rect className="accent grow-x d2" x="40" y="78" width="140" height="11" rx="5" />
          <path className="accent-stroke draw d4" d="M150 108 l8 9 l18 -22" />
        </svg>
      );
    default: // Report: pages assembling into a pack.
      return (
        <svg viewBox="0 0 220 150" className="aw-svg" aria-hidden="true">
          <rect className="sheet" x="22" y="18" width="176" height="114" rx="12" />
          <rect className="row grow-x d1" x="40" y="40" width="80" height="9" rx="4" />
          <rect className="navy grow-y d2" x="50" y="74" width="20" height="44" rx="4" />
          <rect className="accent grow-y d3" x="86" y="62" width="20" height="56" rx="4" />
          <rect className="navy grow-y d4" x="122" y="86" width="20" height="32" rx="4" />
          <rect className="navy grow-y d4" x="158" y="70" width="20" height="48" rx="4" />
        </svg>
      );
  }
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5 3.5v9l7-4.5z" fill="currentColor" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="4" y="3.5" width="3" height="9" rx="1" fill="currentColor" />
      <rect x="9" y="3.5" width="3" height="9" rx="1" fill="currentColor" />
    </svg>
  );
}

export default function AuditOsWalkthrough() {
  const [reduced, setReduced] = useState(false);
  const [active, setActive] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [inView, setInView] = useState(true);
  const [docVisible, setDocVisible] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => setReduced(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => setInView(entries[0]?.isIntersecting ?? true),
      {
        threshold: 0.25,
      },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const onVisibility = () => setDocVisible(!document.hidden);
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  const current = STAGES[active];
  const announce = `Stage ${active + 1} of ${STAGES.length}. ${current.label}. ${current.line}`;

  if (reduced) {
    return (
      <div ref={rootRef} className="aw-card" role="group" aria-label="How Assurance OS works">
        <ol className="aw-static">
          {STAGES.map((s, i) => (
            <li key={s.key} className="aw-static-step">
              <span className="aw-static-num">{i + 1}</span>
              <div>
                <p className="aw-static-label">{s.label}</p>
                <p className="aw-static-line">{s.line}</p>
              </div>
              <div className="aw-static-visual">
                <Visual stage={i} />
              </div>
            </li>
          ))}
        </ol>
      </div>
    );
  }

  const running = playing && inView && docVisible;

  return (
    <div ref={rootRef} className="aw-card" role="group" aria-label="How Assurance OS works">
      <div className="aw-controls">
        <button
          type="button"
          className="aw-playpause"
          onClick={() => setPlaying((p) => !p)}
          aria-pressed={playing}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
          <span>{playing ? 'Pause' : 'Play'}</span>
        </button>
        <ol className="aw-tabs" aria-label="Workflow stages">
          {STAGES.map((s, i) => (
            <li key={s.key}>
              <button
                type="button"
                className={`aw-tab${i === active ? 'is-active' : ''}`}
                aria-current={i === active ? 'true' : undefined}
                aria-label={`Show stage ${i + 1}, ${s.label}`}
                onClick={() => setActive(i)}
              >
                <span className="aw-tab-num">{i + 1}</span>
                <span className="aw-tab-label">{s.label}</span>
              </button>
            </li>
          ))}
        </ol>
      </div>

      <div className="aw-progress">
        <div
          key={active}
          className="aw-progress-fill"
          style={{
            animationDuration: `${STAGE_MS}ms`,
            animationPlayState: running ? 'running' : 'paused',
          }}
          onAnimationEnd={() => setActive((a) => (a + 1) % STAGES.length)}
        />
      </div>

      <div className="aw-panel">
        <div className="aw-visual" key={current.key}>
          <Visual stage={active} />
        </div>
        <div>
          <p className="aw-step">
            Stage {active + 1} of {STAGES.length}
          </p>
          <h3 className="aw-label">{current.label}</h3>
          <p className="aw-line">{current.line}</p>
        </div>
      </div>

      <p className="aw-sr" aria-live="polite">
        {announce}
      </p>
    </div>
  );
}
