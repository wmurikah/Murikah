/**
 * Content collections. `insights` powers the guides/articles index, individual
 * pages, and the RSS feed. Uses the Astro content layer `glob()` loader.
 */
import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const insights = defineCollection({
  loader: glob({ base: './src/content/insights', pattern: '**/*.{md,mdx}' }),
  schema: z.object({
    title: z.string(),
    /** Used for the meta description and the list/RSS summary. */
    description: z.string(),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    author: z.string().default('Murikah'),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
    /** Optional FAQ block → rendered accordion + FAQPage JSON-LD. */
    faqs: z.array(z.object({ question: z.string(), answer: z.string() })).optional(),
  }),
});

export const collections = { insights };
