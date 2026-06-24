/**
 * The grounding brief injected into the assistant's system prompt. It is built
 * from Murikah's own site config, so it never drifts from the site, plus a
 * short, curated list of the cornerstone guides. No vector database is used;
 * this curated brief is cheaper and more predictable.
 */
import { SITE, SERVICES, PRICING, FOUNDER } from '@/site.config';

const GUIDES = [
  {
    title: 'ISO 42001 readiness: what African organisations actually need to do',
    url: '/insights/iso-42001-readiness',
    note: 'What ISO 42001 is, who needs it, and the practical steps to get ready.',
  },
  {
    title: 'Internal audit for SACCOs: what SASRA expects and how to deliver it',
    url: '/insights/sacco-internal-audit-sasra',
    note: 'What SASRA requires of a SACCO internal audit function, and how to deliver it.',
  },
  {
    title: 'The Kenya Data Protection Act: what controllers and processors must do',
    url: '/insights/kenya-data-protection-act',
    note: 'Core obligations under the Act and the role of the ODPC, in plain English.',
  },
  {
    title: 'How much does internal audit software cost in Kenya?',
    url: '/insights/internal-audit-software-cost-kenya',
    note: 'Honest, indicative pricing and what drives the cost.',
  },
  {
    title: 'Co-sourced or outsourced internal audit: which does your organisation need?',
    url: '/insights/co-sourced-vs-outsourced-internal-audit',
    note: 'Both models defined, with a clear decision rule.',
  },
];

export function buildKnowledge(): string {
  const lines = SERVICES.map((s) => `- ${s.fullName}: ${s.summary}`).join('\n');
  const pricing = PRICING.map((t) => `- ${t.name}, ${t.forWho} ${t.price} ${t.period}`).join('\n');
  const guides = GUIDES.map((g) => `- ${g.title} (${g.url}): ${g.note}`).join('\n');

  return `ABOUT MURIKAH
${SITE.name} is an AI-native assurance and governance company, built in Africa. ${SITE.description}
Pronounce the name ${SITE.pronunciation}. Tagline: ${SITE.tagline}. Area served: ${SITE.areaServed}.

THE SIX LINES OF WORK
${lines}

WHO IT IS FOR
Heads of internal audit, audit committee and board chairs, CFOs, CEOs, and heads of risk and compliance at regulated mid-market organisations: SACCOs (regulated by SASRA), banks, microfinance institutions and fintechs (supervised by the Central Bank of Kenya), and donor-funded NGOs.

AUDIT OS INDICATIVE PRICING (always describe as indicative, validated on enquiry; never quote a fixed price)
${pricing}

FOUNDER
${FOUNDER.name}, founder. ${FOUNDER.credentialLine}. He built the Audit OS platform.

KEY PAGES
- Home: /
- Assurance: /assurance
- Audit OS: /audit-os
- Labs: /labs
- Advisory: /advisory
- Academy: /academy
- Intelligence: /intelligence (benchmarking and the annual report are forthcoming)
- About: /about
- Contact and book a demo: /contact

CORNERSTONE GUIDES
${guides}`;
}
