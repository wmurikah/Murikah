/**
 * HeroStage, the full-bleed dark cinematic hero.
 *
 * A calm rotating hero: the dark enterprise background and the copy (label,
 * headline, one line) change together through the scenes in heroScenes.ts, with
 * the two calls to action fixed beneath. Scene one carries the canonical
 * headline and is what renders server-side and under reduced motion.
 *
 * Behaviour:
 *   - auto-advances every 7s, cross-fading the background and copy
 *   - pauses on hover, on keyboard focus within the hero, when scrolled out of
 *     view, and when the tab is hidden
 *   - respects reduced motion (OS setting and the in-page accessibility toggle):
 *     no auto-advance or zoom, scene one shown, scenes still selectable by hand
 *   - accessible controls: a play/pause button, one labelled button per scene,
 *     and a polite live region announcing the current scene
 *
 * The backgrounds ship as on-brand dark stills; swap them for photography in
 * heroScenes.ts when licensed images are available (they are decorative here,
 * so the copy carries all meaning and the images use empty alt text).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { HERO_SCENES } from './heroScenes';
import './HeroStage.css';

const ROTATE_MS = 7000;

interface CTA {
  label: string;
  href: string;
}
interface Props {
  primary: CTA;
  secondaryLabel: string;
  secondaryHref: string;
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  const os = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const inPage = document.documentElement.classList.contains('a11y-reduce-motion');
  return os || inPage;
}

export default function HeroStage({ primary, secondaryLabel, secondaryHref }: Props) {
  const scenes = HERO_SCENES;
  const count = scenes.length;

  const [index, setIndex] = useState(0);
  const [userPlaying, setUserPlaying] = useState(true);
  const [reduced, setReduced] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [inView, setInView] = useState(true);
  const [docVisible, setDocVisible] = useState(true);

  const rootRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduced(prefersReducedMotion());
    sync();
    mq.addEventListener('change', sync);
    const mo = new MutationObserver(sync);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => {
      mq.removeEventListener('change', sync);
      mo.disconnect();
    };
  }, []);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || !('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { threshold: 0.2 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const onVis = () => setDocVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const autoRotate = userPlaying && !reduced && !hovered && !focused && inView && docVisible;

  useEffect(() => {
    if (!autoRotate) return;
    const id = window.setInterval(() => setIndex((i) => (i + 1) % count), ROTATE_MS);
    return () => window.clearInterval(id);
  }, [autoRotate, count]);

  const select = useCallback((i: number) => setIndex(((i % count) + count) % count), [count]);
  const current = scenes[index];

  return (
    <section
      ref={rootRef}
      className="hero-stage on-dark"
      data-motion={reduced ? 'off' : 'on'}
      aria-label="Murikah"
      aria-labelledby="hero-title"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    >
      <div className="hero-stage__bg" aria-hidden="true">
        {scenes.map((s, i) => (
          <img
            key={s.id}
            className="hero-stage__img"
            data-active={i === index}
            src={s.image}
            alt=""
            loading={i === 0 ? 'eager' : 'lazy'}
            decoding="async"
            draggable={false}
          />
        ))}
        <div className="hero-stage__overlay" />
      </div>

      <div className="hero-stage__inner">
        <div className="hero-stage__copy" key={index}>
          <p className="hero-stage__label">{current.label}</p>
          <h1 id="hero-title" className="hero-stage__title">
            {current.title}
          </h1>
          <div className="hero-stage__rule" aria-hidden="true" />
          <p className="hero-stage__desc">{current.description}</p>
        </div>

        <div className="hero-stage__actions">
          <a className="hero-stage__cta" href={primary.href}>
            {primary.label}
          </a>
          <a className="hero-stage__link group" href={secondaryHref}>
            <span className="hero-stage__linktext">{secondaryLabel}</span>
            <span aria-hidden="true" className="hero-stage__arrow">
              &rarr;
            </span>
          </a>
        </div>

        <div className="hero-stage__controls">
          <button
            type="button"
            className="hero-stage__play"
            aria-pressed={userPlaying}
            aria-label={userPlaying ? 'Pause the hero' : 'Play the hero'}
            onClick={() => setUserPlaying((p) => !p)}
          >
            {userPlaying ? (
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
                <rect x="4" y="3" width="3" height="10" rx="1" fill="currentColor" />
                <rect x="9" y="3" width="3" height="10" rx="1" fill="currentColor" />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
                <path d="M5 3.5v9l7-4.5-7-4.5z" fill="currentColor" />
              </svg>
            )}
          </button>
          <div className="hero-stage__dots" role="group" aria-label="Choose a scene">
            {scenes.map((s, i) => (
              <button
                key={s.id}
                type="button"
                className="hero-stage__dot"
                data-active={i === index}
                aria-label={`Show scene: ${s.label}`}
                aria-current={i === index ? 'true' : undefined}
                onClick={() => select(i)}
              />
            ))}
          </div>
        </div>

        <p className="hero-stage__sr" aria-live="polite">
          {`Scene ${index + 1} of ${count}: ${current.label}. ${current.title}`}
        </p>
      </div>
    </section>
  );
}
