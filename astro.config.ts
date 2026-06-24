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
  // Canonical origin — drives sitemap.xml and canonical/OG URLs.
  site: SITE_URL,

  // Default output is static: marketing pages are prerendered to HTML assets,
  // and only the API endpoints opt out via `export const prerender = false`,
  // so they run on-demand in the Worker. This keeps client JS near-zero.
  adapter: cloudflare({
    // Build-time image optimisation — no runtime Images binding required for
    // an all-prerendered marketing site.
    imageService: 'compile',
    // NB: v14 of the adapter integrates the Cloudflare Vite plugin, which reads
    // wrangler.jsonc + .dev.vars and exposes KV/R2/vars on Astro.locals.runtime
    // during `astro dev` automatically — no platformProxy option needed.
  }),

  integrations: [
    // MDX powers the insights/guides content collection.
    mdx(),
    // React is wired for future interactive Labs islands (stubbed for now).
    react(),
    // Generates sitemap-index.xml + sitemap-0.xml at build.
    sitemap(),
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
