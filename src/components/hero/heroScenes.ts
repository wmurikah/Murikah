/**
 * Hero scenes, the data behind the full-bleed rotating hero (HeroStage).
 *
 * Each scene is one facet of what Murikah does: a short label, a headline and
 * one supporting line, over a real photograph. Scene one (Assurance OS) carries
 * the canonical headline and is what renders first (and under reduced motion).
 *
 * `image` is the background photo (locally saved, commercial-use JPGs cropped to
 * 1920x1080 and compressed, served from `public/images/hero/`). Each scene may
 * also set:
 *   - `position`: object-position for the photo, so faces and architecture are
 *     not buried behind the left-hand copy.
 *   - `overlay`: the left-edge alpha of the translucent navy overlay (0 to 1).
 *     Building shots can stay lighter; people shots take a touch more so the
 *     copy stays readable.
 * CTA fields are optional and fall back to the component's defaults.
 *
 * Do not hotlink remote images. Backgrounds are decorative, so the copy carries
 * all meaning.
 */

export interface HeroScene {
  id: string;
  /** Short label, tracked uppercase (the eyebrow). */
  label: string;
  /** The rotating headline for the scene. */
  title: string;
  /** One supporting line. Keep it to a single short sentence. */
  description: string;
  /** Background photo, from public/images/hero/. */
  image: string;
  /** object-position for the photo. Defaults to '62% 50%'. */
  position?: string;
  /** Left-edge overlay alpha, 0 to 1. Defaults to 0.56. */
  overlay?: number;
  /** Accessible description of the visual (the background is decorative). */
  alt: string;
  /** Optional per-scene call to action, otherwise the component defaults. */
  ctaLabel?: string;
  ctaHref?: string;
  secondaryLabel?: string;
  secondaryHref?: string;
}

/** Carousel interval: a brisk, confident 3 seconds. */
export const HERO_ROTATION_INTERVAL = 3000;

export const HERO_SCENES: HeroScene[] = [
  {
    id: 'assurance-os',
    label: 'Assurance OS',
    title: 'Run assurance as an operating rhythm.',
    description: 'Plans, approvals, evidence, remediation and reporting in one platform.',
    image: '/images/hero/modern-glass-office-building.jpg',
    position: '70% 50%',
    overlay: 0.52,
    alt: 'A modern glass office building.',
  },
  {
    id: 'governance-intelligence',
    label: 'Governance intelligence',
    title: 'See signals before they become surprises.',
    description: 'Risk, controls and performance in one operating view.',
    image: '/images/hero/governance-meeting.jpg',
    position: 'center',
    overlay: 0.6,
    alt: 'A governance meeting.',
  },
  {
    id: 'board-confidence',
    label: 'Board confidence',
    title: 'Evidence-ready decisions.',
    description: 'Clear reporting for directors, executives and committees.',
    image: '/images/hero/boardroom-meeting.jpg',
    position: 'center',
    overlay: 0.58,
    alt: 'A boardroom meeting.',
  },
  {
    id: 'systems-assurance',
    label: 'Systems assurance',
    title: 'Controls that follow the work.',
    description: 'Assurance across platforms, processes and data flows.',
    image: '/images/hero/financial-district-building.jpg',
    position: '68% 50%',
    overlay: 0.54,
    alt: 'A financial district at scale.',
  },
  {
    id: 'ai-governance',
    label: 'AI governance',
    title: 'Intelligent systems, governed.',
    description: 'Practical oversight for AI, automation and emerging risk.',
    image: '/images/hero/african-business-meeting-1.jpg',
    position: '60% 45%',
    overlay: 0.62,
    alt: 'A team overseeing systems together.',
  },
  {
    id: 'african-enterprise',
    label: 'African-built, global-ready',
    title: 'Designed for complex markets.',
    description: 'Assurance for growing organisations with real-world pressure.',
    image: '/images/hero/african-business-meeting.jpg',
    position: '66% 45%',
    overlay: 0.62,
    alt: 'An African business meeting.',
  },
];
