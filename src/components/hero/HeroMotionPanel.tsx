/**
 * HeroMotionPanel, the cinematic right-hand panel on the homepage hero.
 *
 * A calm scene rotator: each scene is one part of what Murikah does, shown as an
 * on-brand still (and, once real footage lands, a short muted clip). Scenes
 * cross-fade on a slow timer with a gentle slow-zoom, so the hero feels alive
 * without becoming noisy.
 *
 * Behaviour, in line with the brief:
 *   - auto-rotates every 6 seconds, cross-fading between scenes
 *   - pauses on hover, on keyboard focus within the panel, when scrolled out of
 *     view, and when the tab is hidden (so it never animates unseen)
 *   - respects reduced motion: the OS setting AND the in-page accessibility
 *     assistant (the `a11y-reduce-motion` class on <html>). Under reduced motion
 *     it does not auto-rotate or zoom; the first scene shows and scenes can
 *     still be chosen by hand.
 *   - accessible controls: a play/pause button and one labelled button per
 *     scene, plus a polite live region announcing the current scene.
 *
 * Video is intentionally left off until real, licensed, compressed clips are
 * added at the `video` paths in heroScenes.ts. Flip ENABLE_VIDEO to true once
 * those files exist; the poster stays as the instant-on frame underneath.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { HERO_SCENES } from './heroScenes';
import './HeroMotionPanel.css';

/** Turn on once real muted clips exist at the scene `video` paths. */
const ENABLE_VIDEO = false;
/** Auto-rotate interval, within the 5 to 7 second range in the brief. */
const ROTATE_MS = 6000;

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  const os = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const inPage = document.documentElement.classList.contains('a11y-reduce-motion');
  return os || inPage;
}

export default function HeroMotionPanel() {
  const scenes = HERO_SCENES;
  const count = scenes.length;

  const [index, setIndex] = useState(0);
  const [userPlaying, setUserPlaying] = useState(true);
  const [reduced, setReduced] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [inView, setInView] = useState(true);
  const [docVisible, setDocVisible] = useState(true);

  const rootRef = useRef<HTMLDivElement>(null);

  // Reduced motion: track the OS setting and the in-page a11y toggle together.
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

  // Pause when the panel is scrolled off screen.
  useEffect(() => {
    const el = rootRef.current;
    if (!el || !('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { threshold: 0.25 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Pause when the tab is hidden.
  useEffect(() => {
    const onVis = () => setDocVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const autoRotate = userPlaying && !reduced && !hovered && !focused && inView && docVisible;

  // The rotation timer. Advances on a slow interval whenever auto-rotate is on.
  useEffect(() => {
    if (!autoRotate) return;
    const id = window.setInterval(() => setIndex((i) => (i + 1) % count), ROTATE_MS);
    return () => window.clearInterval(id);
  }, [autoRotate, count]);

  const select = useCallback((i: number) => setIndex(((i % count) + count) % count), [count]);

  const current = scenes[index];

  return (
    <div
      ref={rootRef}
      className="hero-motion"
      data-motion={reduced ? 'off' : 'on'}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    >
      <div
        className="hero-motion__stage"
        aria-roledescription="carousel"
        aria-label="Murikah at work"
      >
        {scenes.map((s, i) => {
          const active = i === index;
          return (
            <figure
              key={s.id}
              className="hero-motion__scene"
              data-active={active}
              aria-hidden={!active}
            >
              {ENABLE_VIDEO && s.video && active ? (
                <video
                  className="hero-motion__media"
                  poster={s.poster}
                  autoPlay
                  muted
                  loop
                  playsInline
                  preload="metadata"
                >
                  <source src={s.video} type="video/mp4" />
                </video>
              ) : (
                <img
                  className="hero-motion__media"
                  src={s.poster}
                  alt={s.alt}
                  loading={i === 0 ? 'eager' : 'lazy'}
                  decoding="async"
                  draggable={false}
                />
              )}
              <div className="hero-motion__scrim" aria-hidden="true" />
              <figcaption className="hero-motion__caption">
                <span className="hero-motion__label">{s.label}</span>
                <span className="hero-motion__title">{s.title}</span>
                <span className="hero-motion__desc">{s.description}</span>
              </figcaption>
            </figure>
          );
        })}
      </div>

      {/* Polite announcement of the current scene for screen readers. */}
      <p className="hero-motion__sr" aria-live="polite">
        {`Scene ${index + 1} of ${count}: ${current.label}. ${current.title}`}
      </p>

      <div className="hero-motion__controls">
        <button
          type="button"
          className="hero-motion__play"
          aria-pressed={userPlaying}
          aria-label={userPlaying ? 'Pause the scene rotation' : 'Play the scene rotation'}
          onClick={() => setUserPlaying((p) => !p)}
        >
          {userPlaying ? (
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
              <rect x="4" y="3" width="3" height="10" rx="1" fill="currentColor" />
              <rect x="9" y="3" width="3" height="10" rx="1" fill="currentColor" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
              <path d="M5 3.5v9l7-4.5-7-4.5z" fill="currentColor" />
            </svg>
          )}
        </button>

        <div className="hero-motion__dots" role="group" aria-label="Choose a scene">
          {scenes.map((s, i) => (
            <button
              key={s.id}
              type="button"
              className="hero-motion__dot"
              data-active={i === index}
              aria-label={`Show scene: ${s.label}`}
              aria-current={i === index ? 'true' : undefined}
              onClick={() => select(i)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
