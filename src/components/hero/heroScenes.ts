/**
 * Hero scenes, the data behind the full-bleed rotating hero (HeroStage).
 *
 * Each scene is one facet of what Murikah does: a short label, a headline and
 * one supporting line, over a real photograph. Scene one (Assurance OS) carries
 * the canonical headline and is what renders first (and under reduced motion).
 *
 * `image` is the background photo. These are locally saved, commercial-use JPGs
 * cropped to 1920x1080 and compressed, served from `public/images/hero/`. To
 * change a photo, replace the file (keep it wide, and not too bright on the
 * left where the copy sits) and update the path here. Do not hotlink remote
 * images. Backgrounds are decorative, so the copy carries all meaning.
 */

export interface HeroScene {
  /** Stable id, used for keys and control labels. */
  id: string;
  /** Short label, tracked uppercase (the scene name / eyebrow). */
  label: string;
  /** The rotating headline for the scene. */
  title: string;
  /** One supporting line. Keep it to a single short sentence. */
  description: string;
  /** Background photo, from public/images/hero/. */
  image: string;
  /** Accessible description of the visual (the background is decorative). */
  alt: string;
}

export const HERO_SCENES: HeroScene[] = [
  {
    id: 'assurance-os',
    label: 'Assurance OS',
    title: 'Run assurance as an operating rhythm.',
    description: 'Plans, approvals, evidence, remediation and reporting in one platform.',
    image: '/images/hero/modern-glass-office-building.jpg',
    alt: 'A modern glass office building.',
  },
  {
    id: 'governance-intelligence',
    label: 'Governance intelligence',
    title: 'See signals before they become surprises.',
    description: 'Risk, controls and performance in one operating view.',
    image: '/images/hero/governance-meeting.jpg',
    alt: 'A governance meeting.',
  },
  {
    id: 'board-confidence',
    label: 'Board confidence',
    title: 'Evidence-ready decisions.',
    description: 'Clear reporting for directors, executives and committees.',
    image: '/images/hero/boardroom-meeting.jpg',
    alt: 'A boardroom meeting.',
  },
  {
    id: 'african-enterprise',
    label: 'African-built, global-ready',
    title: 'Designed for complex markets.',
    description: 'Assurance for growing organisations with real-world pressure.',
    image: '/images/hero/african-business-meeting.jpg',
    alt: 'An African business meeting.',
  },
  {
    id: 'systems-assurance',
    label: 'Systems assurance',
    title: 'Controls that follow the work.',
    description: 'Assurance across platforms, processes and data flows.',
    image: '/images/hero/african-business-meeting-1.jpg',
    alt: 'A team reviewing work together.',
  },
  {
    id: 'market-intelligence',
    label: 'Market intelligence',
    title: 'Clarity for regulated growth.',
    description: 'Governance insight for institutions operating at scale.',
    image: '/images/hero/financial-district-building.jpg',
    alt: 'A financial district at scale.',
  },
];
