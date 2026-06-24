import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import mdx from '@astrojs/mdx';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

// Single source of truth for the canonical site URL (used by sitemap + SEO).
import { SITE_URL } from './src/site.config';

// https://astro.build/config
export default defineConfig({
  // Canonical origin, drives sitemap.xml and canonical/OG URLs.
  site: SITE_URL,

  // Default output is static: marketing pages are prerendered to HTML assets,
  // and only the API endpoints opt out via `export const prerender = false`,
  // so they run on-demand in the Worker. This keeps client JS near-zero.
  adapter: cloudflare({
    // Build-time image optimisation, no runtime Images binding required for
    // an all-prerendered marketing site.
    imageService: 'compile',
    // NB: v14 of the adapter integrates the Cloudflare Vite plugin, which reads
    // wrangler.jsonc + .dev.vars and exposes KV/R2/vars on Astro.locals.runtime
    // during `astro dev` automatically, no platformProxy option needed.
  }),

  integrations: [
    // MDX powers the insights/guides content collection.
    mdx(),
    // React is wired for future interactive Labs islands (stubbed for now).
    react(),
    // Generates sitemap-index.xml + sitemap-0.xml at build, with sensible
    // priorities: home and service pages highest, guides next, legal lowest.
    sitemap({
      serialize(item) {
        // Priorities: home and service pages highest, guides next, legal lowest.
        const path = new URL(item.url).pathname.replace(/\/$/, '') || '/';
        const services = [
          '/assurance',
          '/audit-os',
          '/labs',
          '/advisory',
          '/academy',
          '/intelligence',
        ];
        if (path === '/') {
          item.priority = 1.0;
        } else if (services.includes(path)) {
          item.priority = 0.9;
        } else if (path === '/insights' || path.startsWith('/insights/')) {
          item.priority = 0.8;
        } else if (path === '/about' || path === '/contact') {
          item.priority = 0.7;
        } else if (path === '/privacy' || path === '/terms') {
          item.priority = 0.2;
        } else {
          item.priority = 0.6;
        }
        return item;
      },
    }),
  ],

  vite: {
    // Tailwind CSS v4 via the first-party Vite plugin (not @astrojs/tailwind).
    plugins: [tailwindcss()],
  },

  // Instant subsequent navigations (Doherty Threshold) with negligible JS:
  // links are prefetched on hover/touch intent only.
  prefetch: {
    prefetchAll: true,
    defaultStrategy: 'hover',
  },
});
