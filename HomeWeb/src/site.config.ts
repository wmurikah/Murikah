/**
 * Central site configuration, the single source of truth for shared strings:
 * site metadata, navigation, the six service lines, the standards the company
 * works to, pricing anchors, audience, social links and default SEO. Pull from
 * here rather than retyping copy across files.
 *
 * Murikah speaks as a company ("we"), with company-level standards and evidence.
 *
 * Voice rules apply to every string in this file: no em dashes, plain English,
 * British and Kenyan spelling, no superlatives. Only confirmed details belong in public copy.
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
  /** Route prefixes that light this group's active state. Defaults to [href].
   *  Set explicitly so a page cross-linked from another group is owned once. */
  match?: string[];
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
  href?: string;
}

/** Canonical production URL. MUST stay in sync with `site` in astro.config.ts. */
export const SITE_URL = 'https://murikah.com';

export const SITE = {
  name: 'Murikah',
  /** {{LEGAL: confirm the registered legal entity name}} */
  legalName: 'Murikah',
  tagline: 'Assurance. Systems. Intelligence.',
  /** The one-liner. Used as the default meta description. */
  description:
    'Murikah helps organisations run, prove and continuously improve their internal audit and AI governance, with senior judgement and a working platform priced for the mid-market.',
  url: SITE_URL,
  locale: 'en',
  /** Pronunciation cue, surfaced at first prominent use and in the footer. */
  pronunciation: 'moo-REE-kah, rhymes with Eureka',
  /** Company-level positioning. Do not explain the founder or personal origin of the name. */
  meaning:
    'Murikah is an assurance and governance company. The brand stands for clarity, evidence and disciplined improvement.',
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
    slug: 'internal-audit',
    name: 'Internal audit',
    fullName: 'Internal audit',
    href: '/internal-audit',
    summary:
      'Co-sourced and outsourced internal audit, systems and IT audits, data protection reviews, and ISO 42001 and AI-governance readiness.',
    serviceType: 'Internal audit and assurance',
  },
  {
    slug: 'assurance-os',
    name: 'Assurance OS',
    fullName: 'Assurance OS',
    href: '/assurance-os',
    summary:
      'The subscription platform for work papers, approvals, findings and remediation, follow-ups, board reporting, and an AI assistant.',
    serviceType: 'Internal audit management software',
  },
  {
    slug: 'automation',
    name: 'Automation',
    fullName: 'Automation',
    href: '/automation',
    summary: 'Automation builds, CRM and CMS, workflow engineering, and custom automations.',
    serviceType: 'Automation and workflow engineering',
  },
  {
    slug: 'advisory',
    name: 'Advisory',
    fullName: 'Advisory',
    href: '/advisory',
    summary:
      'AI strategy and governance roadmaps, research and analytics, executive decks and board papers.',
    serviceType: 'Advisory and analytics',
  },
  {
    slug: 'training',
    name: 'Training',
    fullName: 'Training',
    href: '/training',
    summary:
      'Training and certification: CISA preparation, ISO 42001 awareness and lead-auditor readiness, and practical masterclasses.',
    serviceType: 'Professional training and certification',
  },
  {
    slug: 'research',
    name: 'Research',
    fullName: 'Research',
    href: '/research',
    summary: 'Anonymised cross-client benchmarking and an annual flagship report (forthcoming).',
    serviceType: 'Benchmarking and research',
  },
];

/**
 * Primary navigation follows a five-item information architecture: Solutions,
 * Platform, Pricing, Insights and About. The logo links home and the single
 * gold primary action is rendered separately. Dropdowns are intentionally
 * capped at five destinations so services, software, pricing and research do
 * not compete inside one menu. `match` lists the route prefixes that light
 * each item's active state.
 */
/** Existing applications; shared by desktop, mobile, homepage and footer. */
export const PRODUCTS = [
  {
    label: 'CMS',
    fullName: 'Customer operations',
    href: 'https://cms.murikah.com',
    description: 'Manage leads, customer accounts, orders and service requests.',
    useCase: 'Create a lead and keep the customer journey connected to fulfilment.',
    access: 'Sign-in required',
    previewLabel: 'Lead workspace',
    preview: ['Solar pump installation', 'Website enquiry', 'Owner assigned'],
  },
  {
    label: 'Assurance OS',
    fullName: 'Internal audit & risk',
    href: 'https://grc.murikah.com',
    description: 'Plan audits, review evidence and track findings and action plans.',
    useCase: 'Turn an audit observation into an owned, dated remediation action.',
    access: 'Sign-in or invitation required',
    previewLabel: 'Action plan',
    preview: ['Observation linked', 'Owner assigned', 'Due date recorded'],
  },
  {
    label: 'Tutor',
    fullName: 'AI learning',
    href: 'https://tutor.murikah.com',
    description: 'Learn, research, co-write and design diagrams with AI.',
    useCase: 'Ask a learning question, develop the answer and shape it into useful work.',
    access: 'Try as guest; sign in to save',
    previewLabel: 'Learning workspace',
    preview: ['Ask a question', 'Explore the answer', 'Create and refine'],
  },
  {
    label: 'ENGR',
    fullName: 'Maintenance',
    href: 'https://engr.murikah.com',
    description: 'Manage assets, maintenance schedules and work orders.',
    useCase: 'Assign a technician and follow a work order through its operating stages.',
    access: 'Sign-in required',
    previewLabel: 'Work order',
    preview: ['Request accepted', 'Technician assigned', 'Work tracked'],
  },
];

export const NAV: NavItem[] = [
  { label: 'Assurance OS', href: '/assurance-os' },
  {
    label: 'Services',
    href: '/services',
    match: ['/services', '/internal-audit', '/automation', '/advisory', '/training'],
    children: SERVICES.filter((service) =>
      ['internal-audit', 'automation', 'advisory', 'training'].includes(service.slug),
    ).map((service) => ({ label: service.name, href: service.href, description: service.summary })),
  },
  { label: 'Pricing', href: '/pricing' },
  { label: 'Insights', href: '/insights', match: ['/insights', '/research'] },
  { label: 'About', href: '/about' },
];

/** The one gold action across the site. */
export const PRIMARY_CTA = {
  label: 'Book a 20-minute call',
  href: '/contact?intent=call',
} as const;

export const SOCIAL: SocialLink[] = [
  // {{SOCIAL: confirm the live profile URLs}}
  { label: 'LinkedIn', href: 'https://www.linkedin.com/company/murikah' },
  { label: 'X (Twitter)', href: 'https://x.com/murikah' },
];

/**
 * Footer navigation, deliberately curated rather than a full sitemap. Three
 * compact columns mirror the primary architecture (Who we are, What we do,
 * News & Insights) but each shows only a few strategic links; Legal stays in
 * the thin bottom bar. Labels are short and premium ("About", "Services",
 * "RSS"), and "Automation" aligns with the hero CTA. The full page list
 * lives in the header navigation, so the footer can stay short and scannable.
 */
export const FOOTER_GROUPS: { heading: string; links: { label: string; href: string }[] }[] = [
  {
    heading: 'Platform',
    links: [
      { label: 'Assurance OS', href: '/assurance-os' },
      { label: 'Public sandbox', href: '/assurance-os/sandbox' },
      { label: 'More from Murikah Labs', href: '/products' },
    ],
  },
  {
    heading: 'Who we are',
    links: [
      { label: 'About', href: '/about' },
      { label: 'Standards', href: '/about#standards' },
      { label: 'Contact', href: '/contact' },
    ],
  },
  {
    heading: 'What we do',
    links: [
      { label: 'Services', href: '/services' },
      { label: 'Internal audit', href: '/internal-audit' },
      { label: 'Automation', href: '/automation' },
      { label: 'Pricing', href: '/pricing' },
    ],
  },
  {
    heading: 'News & Insights',
    links: [
      { label: 'All insights', href: '/insights' },
      { label: 'AI governance', href: '/insights#ai-governance' },
      { label: 'Internal audit', href: '/insights#internal-audit' },
      { label: 'RSS', href: '/rss.xml' },
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

export interface Standard {
  /** Full name as it reads in prose. */
  name: string;
  /** Short label for compact chips. */
  short: string;
  /** One plain line on how the company uses it. */
  note: string;
}

/**
 * The standards and frameworks the work is built on. These are honest,
 * company-level trust signals, the standards Murikah works to and helps clients
 * with, not qualifications the company or any individual holds. Never present
 * them as certifications Murikah has been awarded.
 */
export const STANDARDS: Standard[] = [
  {
    name: 'IIA Global Internal Audit Standards',
    short: 'IIA Standards',
    note: 'The professional standards our internal audit work is planned and run to.',
  },
  {
    name: 'ISO/IEC 27001',
    short: 'ISO/IEC 27001',
    note: 'Information security management, which we audit against and help clients prepare for.',
  },
  {
    name: 'ISO/IEC 42001',
    short: 'ISO/IEC 42001',
    note: 'The AI management-system standard behind our AI-governance readiness work.',
  },
];

/** Topics the company works across, used for Organization.knowsAbout in JSON-LD. */
export const KNOWS_ABOUT = [
  'Internal audit',
  'IT audit',
  'Data protection',
  'AI governance',
  'ISO/IEC 42001',
  'ISO/IEC 27001',
  'Risk management',
] as const;

/**
 * Assurance OS published budget ranges. They are not fixed quotes, but buyers
 * should be able to budget from them without first speaking to sales.
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
    note: 'Regulated by SASRA, with governance, risk and internal-control expectations that need evidence at board level.',
    href: '/saccos',
  },
  {
    name: 'Banks and microfinance',
    note: 'Supervised by the Central Bank of Kenya, with demanding governance, internal-control and reporting expectations.',
    href: '/banks',
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
  defaultTitle: 'Internal audit and AI governance | Murikah',
  description: SITE.description,
  image: SITE.defaultOgImage,
} as const;
