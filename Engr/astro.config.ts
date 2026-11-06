import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({
  site: 'https://engr.murikah.com',
  // The Worker checks form origins against the public URL before it rewrites
  // paths for Astro. Astro's post-rewrite check can reject valid browser forms.
  security: { checkOrigin: false },
  adapter: cloudflare({ imageService: 'compile' }),
  session: { driver: 'memory' },
  vite: {
    plugins: [tailwindcss()],
    build: {
      assetsInlineLimit: (filePath: string) => (/\.m?js$/.test(filePath) ? false : undefined),
    },
  },
});
