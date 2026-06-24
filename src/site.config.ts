/**
 * Central site configuration — the single source of truth for site metadata,
 * navigation, the six service lines, social links, and default SEO/Organization
 * schema data. Nothing in this file should be hardcoded elsewhere.
 *
 * NOTE: Marketing copy here is PLACEHOLDER pending Build Prompt 2. Strings that
 * are intentionally provisional are marked with `[placeholder]`.
 */

export interface NavChild {
  label: string;
  href: string;
  /** Short, plain-language descriptor (recognition over recall). */
  description: string;
}

export interface NavItem {
  label: string;
  href: string;
  children?: NavChild[];
}

export interface ServiceLine {
  slug: string;
  /** Short product name, e.g. "Assurance". */
  name: string;
  /** Full nav/label name, e.g. "Murikah Assurance". */
  fullName: string;
  href: string;
  /** One-line value statement [placeholder]. */
  summary: string;
  /** Category for JSON-LD Service.serviceType. */
  serviceType: string;
}

export interface SocialLink {
  label: string;
  href: string;
}

/** Canonical production URL. MUST stay in sync with `site` in astro.config.ts. */
export const SITE_URL = 'https://www.murikah.com';

export const SITE = {
  name: 'Murikah',
  /** Used in legal copy and the Organization schema [placeholder legal entity]. */
  legalName: 'Murikah Ltd',
  tagline: 'Assurance. Systems. Intelligence.',
  /** Default meta description [placeholder]. */
  description:
    'Murikah is an AI-native assurance and governance company helping African organisations run, prove, and continuously improve their internal audit and AI and system governance.',
  url: SITE_URL,
  locale: 'en',
  /** Pronunciation cue surfaced in the footer (recognition aid). */
  pronunciation: 'moo-REE-kah — rhymes with Eureka',
  /** Default social share image (lives in /public; PNG for broad crawler support). */
  defaultOgImage: '/og-default.png',
  /** Contact details [placeholder]. */
  email: 'hello@murikah.com',
  twitter: '@murikah',
  foundingYear: 2025,
  /** Service area for the Organization schema (no location pages — country-level only). */
  areaServed: 'Africa',
} as const;

/**
 * The six lines of work. Order is intentional (serial-position effect): the two
 * flagship lines bookend the list so they land in the primary/recency slots.
 */
export const SERVICES: ServiceLine[] = [
  {
    slug: 'assurance',
    name: 'Assurance',
    fullName: 'Murikah Assurance',
    href: '/assurance',
    summary:
      'Co-sourced internal audit, systems and IT audits, data-protection reviews, and ISO 42001 and AI-governance readiness. [placeholder]',
    serviceType: 'Internal audit and assurance',
  },
  {
    slug: 'audit-os',
    name: 'Audit OS',
    fullName: 'Murikah Audit OS',
    href: '/audit-os',
    summary:
      'A subscription platform for work papers, approvals, remediation, follow-ups, board reporting, and an AI assistant. [placeholder]',
    serviceType: 'Audit management software',
  },
  {
    slug: 'labs',
    name: 'Labs',
    fullName: 'Murikah Labs',
    href: '/labs',
    summary:
      'Automation builds, CRM and CMS, workflow engineering, and custom automations. [placeholder]',
    serviceType: 'Automation and workflow engineering',
  },
  {
    slug: 'advisory',
    name: 'Advisory',
    fullName: 'Murikah Advisory',
    href: '/advisory',
    summary:
      'AI strategy, research and analytics, executive decks, and board packs. [placeholder]',
    serviceType: 'Advisory and analytics',
  },
  {
    slug: 'academy',
    name: 'Academy',
    fullName: 'Murikah Academy',
    href: '/academy',
    summary:
      'Training and certification — CISA prep, ISO 42001 awareness, and AI and automation masterclasses. [placeholder]',
    serviceType: 'Professional training and certification',
  },
  {
    slug: 'intelligence',
    name: 'Intelligence',
    fullName: 'Murikah Intelligence',
    href: '/intelligence',
    summary:
      'Anonymised cross-client benchmarking and an annual flagship report. [placeholder]',
    serviceType: 'Benchmarking and research',
  },
];

/**
 * Primary navigation — deliberately small (Hick's Law). The primary call to
 * action ("Book a demo") is rendered separately as the single gold action
 * (Von Restorff) and is not part of this list.
 */
export const NAV: NavItem[] = [
  {
    label: 'Services',
    href: '/assurance',
    children: SERVICES.map((s) => ({
      label: s.fullName,
      href: s.href,
      description: s.summary.replace(' [placeholder]', ''),
    })),
  },
  { label: 'Insights', href: '/insights' },
  { label: 'About', href: '/about' },
];

/** Primary CTA — the one gold action across the site. */
export const PRIMARY_CTA = {
  label: 'Book a demo',
  href: '/contact',
} as const;

export const SOCIAL: SocialLink[] = [
  { label: 'LinkedIn', href: 'https://www.linkedin.com/company/murikah' },
  { label: 'X (Twitter)', href: 'https://x.com/murikah' },
];

/** Compact footer sitemap, grouped (Miller's Law — small, labelled chunks). */
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
 * Founder credentials — E-E-A-T trust signals surfaced on /about and the home
 * trust strip. These are treated as the company's expertise foundation.
 */
export const FOUNDER = {
  name: 'Wilberforce Murikah',
  role: 'Founder',
  credentials: [
    'CISA',
    'ISO/IEC 27001 Lead Auditor',
    'ISO/IEC 42001 Lead Auditor',
    'MSc',
    'AI-policy fellow',
  ],
} as const;

/** Default SEO values, overridable per page via the Seo component. */
export const DEFAULT_SEO = {
  titleTemplate: '%s · Murikah',
  defaultTitle: 'Murikah · Assurance. Systems. Intelligence.',
  description: SITE.description,
  image: SITE.defaultOgImage,
} as const;
