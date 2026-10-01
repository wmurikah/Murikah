import { useEffect, useRef, useState } from 'react';
import './AssuranceOsWorkflow.css';

interface Stage {
  key: string;
  label: string;
  line: string;
  bullets: [string, string, string];
  image: string;
  alt: string;
}

const STAGES: Stage[] = [
  {
    key: 'plan',
    label: 'Plan',
    line: 'Set the risk-based plan, scope and timing before fieldwork starts.',
    bullets: ['Prioritise engagements by risk', 'Assign entities and quarters', 'Approve the annual plan'],
    image: '/images/assurance-os/plan.webp',
    alt: 'Assurance OS audit plan screen using fictional Murikah Demo data.',
  },
  {
    key: 'fieldwork',
    label: 'Fieldwork',
    line: 'Capture work papers and evidence in the same record while you test.',
    bullets: ['Document procedures and results', 'Link files and evidence', 'Record exceptions as they arise'],
    image: '/images/assurance-os/fieldwork.webp',
    alt: 'Assurance OS work paper and evidence screen using fictional Murikah Demo data.',
  },
  {
    key: 'review',
    label: 'Review',
    line: 'A reviewer checks the work, returns questions and records sign-off.',
    bullets: ['Work a reviewer queue', 'Return or approve papers', 'Preserve the revision trail'],
    image: '/images/assurance-os/review.webp',
    alt: 'Assurance OS review and sign-off screen using fictional Murikah Demo data.',
  },
  {
    key: 'findings',
    label: 'Findings',
    line: 'Turn supported exceptions into rated findings with an accountable action.',
    bullets: ['Keep evidence linked', 'Assign the risk rating', 'Capture the owner and due date'],
    image: '/images/assurance-os/findings.webp',
    alt: 'Assurance OS high-risk finding with linked evidence, owner and due date using fictional data.',
  },
  {
    key: 'remediation',
    label: 'Remediation',
    line: 'Follow each owner and action through evidence-backed closure.',
    bullets: ['Send structured follow-up', 'Track due and overdue actions', 'Validate closure evidence'],
    image: '/images/assurance-os/remediation.webp',
    alt: 'Assurance OS remediation action tracker using fictional Murikah Demo data.',
  },
  {
    key: 'report',
    label: 'Report',
    line: 'Build committee and board reporting from the same reviewed records.',
    bullets: ['Filter the board pack', 'Surface high and overdue items', 'Export the report for circulation'],
    image: '/images/assurance-os/report.webp',
    alt: 'Assurance OS board and committee report screen using fictional Murikah Demo data.',
  },
];

const STAGE_MS = 6000;

export default function AssuranceOsWorkflow() {
  const [active, setActive] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [inView, setInView] = useState(false);
  const [docVisible, setDocVisible] = useState(true);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [reduced, setReduced] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => {
      setReduced(mq.matches);
      if (mq.matches) setPlaying(false);
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  useEffect(() => {
    const node = rootRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setInView((entry?.intersectionRatio ?? 0) >= 0.6),
      { threshold: [0, 0.6, 1] },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onVisibility = () => setDocVisible(!document.hidden);
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  const running = playing && inView && docVisible && !hovered && !focused && !reduced;

  useEffect(() => {
    if (!running) return;
    const timer = window.setTimeout(() => {
      setActive((value) => (value + 1) % STAGES.length);
    }, STAGE_MS);
    return () => window.clearTimeout(timer);
  }, [active, running]);

  const select = (index: number) => setActive(index);

  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % STAGES.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + STAGES.length) % STAGES.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = STAGES.length - 1;
    else return;

    event.preventDefault();
    select(next);
    tabRefs.current[next]?.focus();
  };

  const stage = STAGES[active];

  return (
    <div
      ref={rootRef}
      className="aow"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      <div className="aow__toolbar">
        <div className="aow__tabs" role="tablist" aria-label="Assurance OS workflow stages">
          {STAGES.map((item, index) => (
            <button
              key={item.key}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              id={`assurance-tab-${item.key}`}
              type="button"
              role="tab"
              aria-selected={index === active}
              aria-controls={`assurance-panel-${item.key}`}
              tabIndex={index === active ? 0 : -1}
              className={`aow__tab${index === active ? ' is-active' : ''}`}
              onClick={() => select(index)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
            >
              <span className="aow__tab-number">{index + 1}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </div>

        <button
          type="button"
          className="aow__play"
          onClick={() => setPlaying((value) => !value)}
          aria-pressed={playing}
          disabled={reduced}
        >
          {reduced ? 'Autoplay off' : playing ? 'Pause' : 'Play'}
        </button>
      </div>

      <div className="aow__progress" aria-hidden="true">
        <span
          key={active}
          className="aow__progress-fill"
          style={{
            animationDuration: `${STAGE_MS}ms`,
            animationPlayState: running ? 'running' : 'paused',
          }}
        />
      </div>

      <div
        key={stage.key}
        id={`assurance-panel-${stage.key}`}
        role="tabpanel"
        aria-labelledby={`assurance-tab-${stage.key}`}
        className="aow__panel"
      >
        <div className="aow__capture">
          <img src={stage.image} width="640" height="400" loading="lazy" decoding="async" alt={stage.alt} />
        </div>

        <div className="aow__copy">
          <p className="aow__stage">Stage {active + 1} of {STAGES.length}</p>
          <h3>{stage.label}</h3>
          <p className="aow__line">{stage.line}</p>
          <ul>
            {stage.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}
          </ul>
          <a href="/assurance-os/sandbox">Try this stage in the sandbox →</a>
        </div>
      </div>

      <p className="aow__note">Product-derived screens use fictional Murikah Demo data.</p>
    </div>
  );
}
