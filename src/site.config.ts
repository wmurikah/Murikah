/**
 * Central site configuration, the single source of truth for shared strings:
 * site metadata, navigation, the six service lines, founder facts, pricing
 * anchors, audience, social links and default SEO. Pull from here rather than
 * retyping copy across files.
 *
 * Voice rules apply to every string in this file: no em dashes, plain English,
 * British and Kenyan spelling, no superlatives. Unverified specifics use a
 * {{PLACEHOLDER}} token so they are obvious before launch.
 */

export interface NavChild {
  label: string;
  href: string;
  description: string;
}

export interface NavItem {
  label: string;
  href: string;
  children?: NavChild[];
}

export interface ServiceLine {
  slug: string;
  name: string;
  fullName: string;
  href: string;
  /** One-sentence description, final copy. */
  summary: string;
  /** Category for JSON-LD Service.serviceType. */
  serviceType: string;
}

export interface SocialLink {
  label: string;
  href: string;
}

export interface PricingTier {
  name: string;
  forWho: string;
  price: string;
  period: string;
}

export interface AudienceSegment {
  name: string;
  note: string;
}

/** Canonical production URL. MUST stay in sync with `site` in astro.config.ts. */
export const SITE_URL = 'https://www.murikah.com';

export const SITE = {
  name: 'Murikah',
  /** {{LEGAL: confirm the registered legal entity name}} */
  legalName: 'Murikah',
  tagline: 'Assurance. Systems. Intelligence.',
  /** The one-liner. Used as the default meta description. */
  description:
    'Murikah helps African organisations run, prove and continuously improve their internal audit and AI governance, with senior judgement and a working platform priced for the mid-market.',
  url: SITE_URL,
  locale: 'en',
  /** Pronunciation cue, surfaced at first prominent use and in the footer. */
  pronunciation: 'moo-REE-kah, rhymes with Eureka',
  /** The meaning behind the name, used on About. */
  meaning:
    'The name echoes the Swahili idea of shining a light on something and bringing it into the open, which is exactly what assurance does for an organisation.',
  defaultOgImage: '/og-default.png',
  /** {{CONTACT: confirm the final public address}} */
  email: 'hello@murikah.com',
  /** {{SOCIAL: confirm the handle}} */
  twitter: '@murikah',
  foundingYear: 2025,
  areaServed: 'Kenya and East Africa',
} as const;

/**
 * The six lines of work. Order is intentional (serial-position effect): the two
 * flagship lines bookend the list.
 */
export const SERVICES: ServiceLine[] = [
  {
    slug: 'assurance',
    name: 'Assurance',
    fullName: 'Murikah Assurance',
    href: '/assurance',
    summary:
      'Co-sourced and outsourced internal audit, systems and IT audits, data protection reviews, and ISO 42001 and AI-governance readiness.',
    serviceType: 'Internal audit and assurance',
  },
  {
    slug: 'audit-os',
    name: 'Audit OS',
    fullName: 'Murikah Audit OS',
    href: '/audit-os',
    summary:
      'The subscription platform for work papers, approvals, findings and remediation, follow-ups, board reporting, and an AI assistant.',
    serviceType: 'Internal audit management software',
  },
  {
    slug: 'labs',
    name: 'Labs',
    fullName: 'Murikah Labs',
    href: '/labs',
    summary: 'Automation builds, CRM and CMS, workflow engineering, and custom automations.',
    serviceType: 'Automation and workflow engineering',
  },
  {
    slug: 'advisory',
    name: 'Advisory',
    fullName: 'Murikah Advisory',
    href: '/advisory',
    summary:
      'AI strategy and governance roadmaps, research and analytics, executive decks and board papers.',
    serviceType: 'Advisory and analytics',
  },
  {
    slug: 'academy',
    name: 'Academy',
    fullName: 'Murikah Academy',
    href: '/academy',
    summary:
      'Training and certification: CISA preparation, ISO 42001 awareness and lead-auditor readiness, and practical masterclasses.',
    serviceType: 'Professional training and certification',
  },
  {
    slug: 'intelligence',
    name: 'Intelligence',
    fullName: 'Murikah Intelligence',
    href: '/intelligence',
    summary: 'Anonymised cross-client benchmarking and an annual flagship report (forthcoming).',
    serviceType: 'Benchmarking and research',
  },
];

/**
 * Primary navigation, deliberately small (Hick's Law). The primary CTA is
 * rendered separately as the single gold action (Von Restorff).
 */
export const NAV: NavItem[] = [
  {
    label: 'Services',
    href: '/assurance',
    children: SERVICES.map((s) => ({
      label: s.fullName,
      href: s.href,
      description: s.summary,
    })),
  },
  { label: 'Insights', href: '/insights' },
  { label: 'About', href: '/about' },
];

/** The one gold action across the site. */
export const PRIMARY_CTA = {
  label: 'Book a demo',
  href: '/contact',
} as const;

export const SOCIAL: SocialLink[] = [
  // {{SOCIAL: confirm the live profile URLs}}
  { label: 'LinkedIn', href: 'https://www.linkedin.com/company/murikah' },
  { label: 'X (Twitter)', href: 'https://x.com/murikah' },
];

/** Compact footer sitemap, grouped (Miller's Law). */
export const FOOTER_GROUPS: { heading: string; links: { label: string; href: string }[] }[] = [
  {
    heading: 'Services',
    links: SERVICES.map((s) => ({ label: s.fullName, href: s.href })),
  },
  {
    heading: 'Company',
    links: [
      { label: 'About', href: '/about' },
      { label: 'Insights', href: '/insights' },
      { label: 'Contact', href: '/contact' },
    ],
  },
  {
    heading: 'Legal',
    links: [
      { label: 'Privacy', href: '/privacy' },
      { label: 'Terms', href: '/terms' },
    ],
  },
];

/**
 * Founder facts, the E-E-A-T spine. These are verifiable and stated plainly.
 */
export const FOUNDER = {
  name: 'Wilberforce Murikah',
  role: 'Founder',
  /** Current day role, stated plainly. */
  currentRole:
    'Group Head of Internal Audit at a multi-country petroleum group operating across nine African countries and Dubai, reporting to the Board Audit and Risk Committee.',
  /** Short credential line for bylines and trust strips. */
  credentialLine: 'CISA, ISO 27001 and ISO 42001 Lead Auditor',
  /** Full credential list for schema and the about page. */
  credentials: [
    'CISA (Certified Information Systems Auditor)',
    'ISO/IEC 27001:2022 Lead Auditor',
    'ISO/IEC 42001:2023 Lead Auditor',
    'MSc, Information Systems and Technology',
    'AI-policy fellow, with three peer-reviewed publications',
  ],
  /** Short chips for compact trust strips. */
  credentialChips: ['CISA', 'ISO 27001 Lead Auditor', 'ISO 42001 Lead Auditor', 'MSc'],
  /** One-line bio for the guide byline. */
  bioByline:
    'Founder of Murikah and a practising Group Head of Internal Audit. He built the Audit OS platform himself.',
  /** Topics for Person.knowsAbout in JSON-LD. */
  knowsAbout: [
    'Internal audit',
    'IT audit',
    'Data protection',
    'AI governance',
    'ISO/IEC 42001',
    'ISO/IEC 27001',
    'Risk management',
  ],
} as const;

/**
 * Audit OS indicative pricing, positioning anchors only. Always label as
 * indicative and validated on enquiry. Never present as a fixed quote.
 */
export const PRICING: PricingTier[] = [
  {
    name: 'Starter',
    forWho: 'A single small team, one entity.',
    price: 'KES 15,000 to 35,000',
    period: 'per month',
  },
  {
    name: 'Growth',
    forWho: 'Multiple entities, or an active board.',
    price: 'KES 45,000 to 120,000',
    period: 'per month',
  },
  {
    name: 'Enterprise',
    forWho: 'Groups and regulator-facing organisations.',
    price: 'From KES 150,000',
    period: 'per month',
  },
];

/** Who Murikah is for, with one plain line on why each needs assurance. */
export const AUDIENCE: AudienceSegment[] = [
  {
    name: 'SACCOs',
    note: 'Regulated by SASRA, the SACCO Societies Regulatory Authority, which expects a board-level internal audit function.',
  },
  {
    name: 'Banks and microfinance',
    note: 'Supervised by the Central Bank of Kenya, with demanding control and reporting expectations.',
  },
  {
    name: 'Fintechs',
    note: 'Fast-moving and data-heavy, and increasingly answerable to regulators and partners.',
  },
  {
    name: 'Donor-funded NGOs',
    note: 'Grant agreements that require independent assurance over how funds and data are handled.',
  },
  {
    name: 'Family businesses with boards',
    note: 'Active boards that want independent eyes on controls and risk.',
  },
];

/** Default SEO values, overridable per page via the Seo component. */
export const DEFAULT_SEO = {
  /** Home and fallback title. */
  defaultTitle: 'Internal audit and AI governance, built in Africa | Murikah',
  description: SITE.description,
  image: SITE.defaultOgImage,
} as const;
