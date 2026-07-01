/**
 * Hero scenes, the data behind the full-bleed rotating hero (HeroStage).
 *
 * Each scene is one facet of what Murikah does: a short label, a headline and
 * one supporting line, over a dark cinematic background. Scene one carries the
 * canonical headline and is what renders first (and under reduced motion).
 *
 * `image` is the background still. These ship as on-brand dark SVG scenes in
 * `public/media/hero/`. To use photography instead, drop wide, darkened,
 * commercial-safe images at `public/images/hero/<id>.webp` (or a single
 * `public/images/bg.png`) and point `image` at them. Keep them dark so the
 * ivory text stays readable under the overlay. Do not hotlink remote images.
 */

export interface HeroScene {
  /** Stable id, used for keys and control labels. */
  id: string;
  /** Short label, tracked uppercase (the scene name). */
  label: string;
  /** The rotating headline for the scene. */
  title: string;
  /** One supporting line. Keep it to a single short sentence. */
  description: string;
  /** Background still. Ships in the repo; swap for photography when available. */
  image: string;
  /** Optional short muted clip, for a future upgrade. Not used yet. */
  video?: string;
  /** Accessible description of the visual (the background is decorative). */
  alt: string;
}

export const HERO_SCENES: HeroScene[] = [
  {
    id: 'board-confidence',
    label: 'Board confidence',
    title: 'Make assurance feel inevitable.',
    description: 'Evidence-ready reporting for directors, executives and committees.',
    image: '/media/hero/board-confidence.svg',
    alt: 'A corporate tower at dusk.',
  },
  {
    id: 'governance-intelligence',
    label: 'Governance intelligence',
    title: 'See signals before they become surprises.',
    description: 'Risk, controls and performance in one operating view.',
    image: '/media/hero/governance-intelligence.svg',
    alt: 'Signals read across a single operating view.',
  },
  {
    id: 'systems-assurance',
    label: 'Systems assurance',
    title: 'Controls that follow the work.',
    description: 'Assurance across platforms, processes and data flows.',
    image: '/media/hero/systems-assurance.svg',
    alt: 'Connected systems carrying controls through the work.',
  },
  {
    id: 'evidence-in-motion',
    label: 'Evidence in motion',
    title: 'From fieldwork to board pack.',
    description: 'One thread for work papers, findings and follow-up.',
    image: '/media/hero/evidence-in-motion.svg',
    alt: 'A single thread from fieldwork to the board pack.',
  },
  {
    id: 'ai-governance',
    label: 'AI governance',
    title: 'Intelligent systems, governed.',
    description: 'Practical oversight for AI, automation and emerging risk.',
    image: '/media/hero/ai-governance.svg',
    alt: 'Automation held inside a clear field of oversight.',
  },
  {
    id: 'assurance-os',
    label: 'Assurance OS',
    title: 'Run assurance as an operating rhythm.',
    description: 'Plans, approvals, evidence, remediation and reporting in one platform.',
    image: '/media/hero/african-enterprise.svg',
    alt: 'A calm enterprise skyline.',
  },
];
