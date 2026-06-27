/**
 * Content collections. `insights` powers the guides/articles index, individual
 * pages, and the RSS feed. Uses the Astro content layer `glob()` loader.
 */
import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

export const GUIDE_CATEGORIES = [
  'Internal audit',
  'AI governance',
  'Data protection',
  'Audit software',
  'Sector guides',
] as const;

const insights = defineCollection({
  loader: glob({ base: './src/content/insights', pattern: '**/*.{md,mdx}' }),
  schema: z.object({
    title: z.string(),
    /** Meta description and list/RSS summary. */
    description: z.string(),
    /** The single core question this guide answers (used in the intro/SEO). */
    question: z.string().optional(),
    /** The answer-first opener; if omitted, the body's first block is used. */
    summary: z.string().optional(),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    /** Author name; guides are authored by the company. */
    author: z.string().default('Murikah'),
    category: z.enum(GUIDE_CATEGORIES).optional(),
    tags: z.array(z.string()).default([]),
    /** Parent service slug for the up-link and CTA, e.g. "assurance". */
    service: z.string().optional(),
    /** Sibling guide slugs for the related block. */
    related: z.array(z.string()).default([]),
    /** Optional per-guide social share image. */
    ogImage: z.string().optional(),
    /** Optional FAQ block; renders the accordion and emits FAQPage JSON-LD. */
    faqs: z.array(z.object({ question: z.string(), answer: z.string() })).optional(),
    draft: z.boolean().default(false),
  }),
});

export const collections = { insights };
