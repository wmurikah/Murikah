/**
 * Shared JSON-LD builders so the founder Person and the Organization are
 * described identically wherever they appear (Organization.founder, the About
 * page, and each guide's author). No claim here goes beyond the verifiable
 * founder credentials in site.config.
 */
import { SITE, FOUNDER, SOCIAL } from '@/site.config';

export const organizationId = `${SITE.url}/#organization`;
export const founderId = `${SITE.url}/#founder`;

/** The founder as a schema.org Person, with credentials as hasCredential. */
export function buildFounderPerson() {
  return {
    '@type': 'Person',
    '@id': founderId,
    name: FOUNDER.name,
    jobTitle: 'Founder',
    description: FOUNDER.currentRole,
    worksFor: { '@id': organizationId },
    knowsAbout: [...FOUNDER.knowsAbout],
    hasCredential: FOUNDER.credentials.map((name) => ({
      '@type': 'EducationalOccupationalCredential',
      name,
    })),
  };
}

/** The Organization / ProfessionalService node for the whole site. */
export function buildOrganization() {
  return {
    '@type': ['Organization', 'ProfessionalService'],
    '@id': organizationId,
    name: SITE.name,
    legalName: SITE.legalName,
    url: SITE.url,
    description: SITE.description,
    slogan: SITE.tagline,
    logo: new URL('/favicon.svg', SITE.url).href,
    image: new URL(SITE.defaultOgImage, SITE.url).href,
    email: SITE.email,
    foundingDate: String(SITE.foundingYear),
    areaServed: SITE.areaServed,
    sameAs: SOCIAL.map((s) => s.href),
    founder: buildFounderPerson(),
  };
}
