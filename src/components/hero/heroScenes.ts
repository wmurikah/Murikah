/**
 * Hero motion scenes, the data behind the rotating panel on the homepage.
 *
 * Each scene stands for one part of what Murikah does, so the hero reads as a
 * whole assurance, governance, systems, analytics and AI company rather than a
 * single audit tool. Copy is short on purpose: one label, one line, one
 * supporting line. Edit here to change the rotation, order or copy.
 *
 * Media is referenced by two paths per scene:
 *   - `poster`, a lightweight on-brand still that ships in the repo and shows
 *     first (and stays put under reduced motion). These are placeholders,
 *     replace them with final art or a video frame when assets are ready.
 *   - `video`, an optional short, muted, looping clip. It is left as a local
 *     placeholder path for now; the panel plays it only once the file exists,
 *     so scenes degrade to the poster until real footage is dropped in.
 *
 * Final licensed video files should be placed at the `video` paths below
 * (short, compressed, muted, commercial-safe). Do not hotlink remote videos.
 */

export interface HeroScene {
  /** Stable id, used for keys and control labels. */
  id: string;
  /** Short overlay label, tracked uppercase. */
  label: string;
  /** One-line headline for the scene. */
  title: string;
  /** One supporting line. Keep it to a single short sentence. */
  description: string;
  /** Optional short muted clip. Local placeholder path until real footage lands. */
  video?: string;
  /** On-brand still shown first and under reduced motion. Ships in the repo. */
  poster: string;
  /** Accessible description of the visual for assistive tech. */
  alt: string;
}

export const HERO_SCENES: HeroScene[] = [
  {
    id: 'board-confidence',
    label: 'Board confidence',
    title: 'Evidence-ready decisions.',
    description: 'Clear reporting for directors, executives and committees.',
    video: '/media/hero/board-confidence.mp4',
    poster: '/media/hero/board-confidence.svg',
    alt: 'Senior leaders reviewing clear reporting in a calm boardroom.',
  },
  {
    id: 'governance-intelligence',
    label: 'Governance intelligence',
    title: 'Signals from complexity.',
    description: 'Risk, controls and performance in one operating view.',
    video: '/media/hero/governance-intelligence.mp4',
    poster: '/media/hero/governance-intelligence.svg',
    alt: 'Analysts reading risk and performance across a single operating view.',
  },
  {
    id: 'systems-assurance',
    label: 'Systems assurance',
    title: 'Controls that follow the work.',
    description: 'Assurance across platforms, processes and data flows.',
    video: '/media/hero/systems-assurance.mp4',
    poster: '/media/hero/systems-assurance.svg',
    alt: 'Connected systems and processes carrying controls through the work.',
  },
  {
    id: 'evidence-in-motion',
    label: 'Evidence in motion',
    title: 'From fieldwork to board pack.',
    description: 'One thread for work papers, findings and follow-up.',
    video: '/media/hero/evidence-in-motion.mp4',
    poster: '/media/hero/evidence-in-motion.svg',
    alt: 'A single thread carrying evidence from fieldwork to the board pack.',
  },
  {
    id: 'ai-governance',
    label: 'AI governance',
    title: 'Intelligent systems, governed.',
    description: 'Practical oversight for AI, automation and emerging risk.',
    video: '/media/hero/ai-governance.mp4',
    poster: '/media/hero/ai-governance.svg',
    alt: 'Automation and models held inside a clear field of oversight.',
  },
  {
    id: 'african-enterprise',
    label: 'African-built, global-ready',
    title: 'Designed for complex markets.',
    description: 'Assurance for growing organisations with real-world pressure.',
    video: '/media/hero/african-enterprise.mp4',
    poster: '/media/hero/african-enterprise.svg',
    alt: 'Growing enterprises across connected markets, grounded and global.',
  },
];
