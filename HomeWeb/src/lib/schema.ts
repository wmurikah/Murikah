/**
 * Shared JSON-LD builders so the Organization is described identically wherever
 * it appears (the global Organization node, the About page, and each guide's
 * author and publisher). Only company-level information is included.
 */
import { SITE, SOCIAL, KNOWS_ABOUT } from '@/site.config';

export const organizationId = `${SITE.url}/#organization`;

/** A compact reference to the Organization, for author/publisher fields. */
export function organizationRef() {
  return {
    '@type': 'Organization',
    '@id': organizationId,
    name: SITE.name,
    url: SITE.url,
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
    knowsAbout: [...KNOWS_ABOUT],
    sameAs: SOCIAL.map((s) => s.href),
  };
}
