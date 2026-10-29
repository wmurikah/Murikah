import { useEffect, useRef, useState } from 'react';
import './AuditOsWalkthrough.css';

const STAGES = [
  { key: 'plan', label: 'Plan', line: 'Schedule each engagement and assign audit time.' },
  { key: 'fieldwork', label: 'Fieldwork', line: 'Keep each work paper with its evidence.' },
  { key: 'review', label: 'Review', line: 'Reviewer comments stay attached to the test.' },
  { key: 'findings', label: 'Findings', line: 'Raise each finding from the evidence behind it.' },
  { key: 'remediation', label: 'Remediation', line: 'Give each action an owner and a due date.' },
  { key: 'report', label: 'Report', line: 'Build the committee pack from current audit data.' },
];
const STAGE_MS = 17000;

export default function AuditOsWalkthrough() {
  const [active, setActive] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [inView, setInView] = useState(false);
  const [visible, setVisible] = useState(true);
  const [userSelected, setUserSelected] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => {
      setReduced(mq.matches);
      setPlaying(!mq.matches);
    };
    apply();
    mq.addEventListener('change', apply);
    const visibility = () => setVisible(!document.hidden);
    visibility();
    document.addEventListener('visibilitychange', visibility);
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), {
      threshold: 0.25,
    });
    if (root.current) observer.observe(root.current);
    return () => {
      mq.removeEventListener('change', apply);
      document.removeEventListener('visibilitychange', visibility);
      observer.disconnect();
    };
  }, []);
  const running = playing && !reduced && !hovered && !focused && inView && visible;
  useEffect(() => {
    if (!running) return;
    const timer = window.setTimeout(() => {
      if (active === STAGES.length - 1) setPlaying(false);
      else setActive(active + 1);
    }, STAGE_MS);
    return () => window.clearTimeout(timer);
  }, [active, running]);
  const current = STAGES[active];
  return (
    <div
      ref={root}
      className="aw-card"
      role="group"
      aria-label="How Assurance OS works"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      <ol className="aw-tabs" aria-label="Workflow stages">
        {STAGES.map((stage, index) => (
          <li key={stage.key}>
            <button
              type="button"
              className="aw-tab"
              aria-pressed={index === active}
              aria-controls="workflow-panel"
              onClick={() => {
                setActive(index);
                setPlaying(false);
                setUserSelected(true);
              }}
            >
              {stage.label}
            </button>
          </li>
        ))}
      </ol>
      <div id="workflow-panel" className="aw-panel">
        <img
          src={`/images/assurance-os/${current.key}.webp`}
          width="1600"
          height="1000"
          loading="lazy"
          alt={`Assurance OS ${current.label.toLowerCase()} screen with fictional sandbox data`}
        />
        <div aria-live={userSelected ? 'polite' : 'off'} aria-atomic="true">
          <p className="aw-step">
            Stage {active + 1} of {STAGES.length}
          </p>
          <h3>{current.label}</h3>
          <p>{current.line}</p>
        </div>
      </div>
      <div className="aw-foot">
        <span>Sandbox screens · Fictional sample data</span>
        {!reduced && (
          <button
            type="button"
            className="aw-playpause"
            aria-pressed={playing}
            onClick={() => {
              if (!playing && active === STAGES.length - 1) setActive(0);
              setPlaying(!playing);
              setUserSelected(false);
            }}
          >
            {playing ? 'Pause' : 'Play once'}
          </button>
        )}
      </div>
    </div>
  );
}
